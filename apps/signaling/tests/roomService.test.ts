import { describe, expect, it } from "vitest";
import { AppErrorException } from "../src/rooms/roomService.js";
import { FakeClock, makeRoomService } from "./helpers.js";

const expectCode = async (fn: () => Promise<unknown> | unknown, code: string): Promise<void> => {
  try {
    await fn();
    expect.fail(`expected AppErrorException ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(AppErrorException);
    expect((err as AppErrorException).appError.code).toBe(code);
  }
};

describe("RoomService.createRoom", () => {
  it("creates a room with a random code and returns tokens once", async () => {
    const service = makeRoomService();
    const outcome = await service.createRoom({ displayName: "Host" }, "sock-1");
    expect(outcome.room.roomCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(outcome.hostToken).toHaveLength(43); // 32 bytes base64url
    expect(outcome.room.hostTokenHash).not.toContain(outcome.hostToken);
    expect(outcome.host.role).toBe("host");
  });

  it("hashes passwords with argon2", async () => {
    const service = makeRoomService();
    const outcome = await service.createRoom(
      { displayName: "Host", settings: { password: "hunter22" } },
      "sock-1"
    );
    expect(outcome.room.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("caps maxParticipants at the server limit", async () => {
    const service = makeRoomService({ maxRoomParticipants: 5 });
    const outcome = await service.createRoom(
      { displayName: "Host", settings: { maxParticipants: 16 } },
      "s"
    );
    expect(outcome.room.settings.maxParticipants).toBe(5);
  });
});

describe("RoomService.join", () => {
  it("joins an open room", async () => {
    const service = makeRoomService();
    const { room } = await service.createRoom({ displayName: "Host" }, "s1");
    const joined = await service.join(
      { roomCode: room.roomCode, displayName: "Viewer" },
      "s2"
    );
    expect(joined.kind).toBe("joined");
    expect(joined.participant.role).toBe("viewer");
  });

  it("rejects a nonexistent room", async () => {
    const service = makeRoomService();
    await expectCode(
      () => service.join({ roomCode: "NOPE9999", displayName: "V" }, "s"),
      "ROOM_NOT_FOUND"
    );
  });

  it("rejects a wrong password with a generic INVALID_PASSWORD error", async () => {
    const service = makeRoomService();
    const { room } = await service.createRoom(
      { displayName: "Host", settings: { password: "correct" } },
      "s1"
    );
    await expectCode(
      () => service.join({ roomCode: room.roomCode, displayName: "V", password: "wrong" }, "s2"),
      "INVALID_PASSWORD"
    );
    await expectCode(
      () => service.join({ roomCode: room.roomCode, displayName: "V" }, "s2"),
      "INVALID_PASSWORD"
    );
  });

  it("accepts the correct password", async () => {
    const service = makeRoomService();
    const { room } = await service.createRoom(
      { displayName: "Host", settings: { password: "correct" } },
      "s1"
    );
    const joined = await service.join(
      { roomCode: room.roomCode, displayName: "V", password: "correct" },
      "s2"
    );
    expect(joined.kind).toBe("joined");
  });

  it("rejects joins beyond capacity", async () => {
    const service = makeRoomService();
    const { room } = await service.createRoom(
      { displayName: "Host", settings: { maxParticipants: 2 } },
      "s1"
    );
    await service.join({ roomCode: room.roomCode, displayName: "V1" }, "s2");
    await expectCode(
      () => service.join({ roomCode: room.roomCode, displayName: "V2" }, "s3"),
      "ROOM_FULL"
    );
  });

  it("places joiners into the waiting room when enabled and admits on approval", async () => {
    const service = makeRoomService();
    const { room } = await service.createRoom(
      { displayName: "Host", settings: { waitingRoomEnabled: true } },
      "s1"
    );
    const outcome = await service.join({ roomCode: room.roomCode, displayName: "V" }, "s2");
    expect(outcome.kind).toBe("waiting");
    const approved = service.approveParticipant(room, outcome.participant.participantId);
    expect(approved.status).toBe("joined");
  });

  it("rejects waiting participants", async () => {
    const service = makeRoomService();
    const { room } = await service.createRoom(
      { displayName: "Host", settings: { waitingRoomEnabled: true } },
      "s1"
    );
    const outcome = await service.join({ roomCode: room.roomCode, displayName: "V" }, "s2");
    const rejected = service.rejectParticipant(room, outcome.participant.participantId);
    expect(rejected.status).toBe("left");
  });

  it("lets the host rejoin with the management token and keeps ownership", async () => {
    const service = makeRoomService();
    const created = await service.createRoom({ displayName: "Host" }, "s1");
    service.markDisconnected(created.room, created.host.participantId);
    expect(created.room.hostConnected).toBe(false);

    const rejoin = await service.join(
      { roomCode: created.room.roomCode, displayName: "Host", hostToken: created.hostToken },
      "s9"
    );
    expect(rejoin.kind).toBe("rejoined");
    expect("isHost" in rejoin && rejoin.isHost).toBe(true);
    expect(created.room.hostConnected).toBe(true);
  });

  it("rejects a forged host token", async () => {
    const service = makeRoomService();
    const created = await service.createRoom({ displayName: "Host" }, "s1");
    await expectCode(
      () =>
        service.join(
          { roomCode: created.room.roomCode, displayName: "X", hostToken: "forged-token" },
          "s2"
        ),
      "HOST_AUTH_FAILED"
    );
  });

  it("restores a viewer session via reconnect token and rotates it", async () => {
    const service = makeRoomService();
    const { room } = await service.createRoom({ displayName: "Host" }, "s1");
    const first = await service.join({ roomCode: room.roomCode, displayName: "V" }, "s2");
    service.markDisconnected(room, first.participant.participantId);

    const second = await service.join(
      { roomCode: room.roomCode, displayName: "V", reconnectToken: first.reconnectToken },
      "s3"
    );
    expect(second.kind).toBe("rejoined");
    expect(second.participant.participantId).toBe(first.participant.participantId);
    expect(second.reconnectToken).not.toBe(first.reconnectToken);
  });
});

describe("room lifecycle", () => {
  it("expires rooms after the TTL", async () => {
    const clock = new FakeClock();
    const service = makeRoomService({ clock, defaultRoomTtlMinutes: 10 });
    const { room } = await service.createRoom({ displayName: "Host" }, "s1");
    clock.advance(11 * 60 * 1000);
    await expectCode(() => service.getOpenRoom(room.roomCode), "ROOM_EXPIRED");
    expect(room.closeReason).toBe("expired");
  });

  it("sweeps expired rooms and reports them once", async () => {
    const clock = new FakeClock();
    const service = makeRoomService({ clock, defaultRoomTtlMinutes: 10 });
    await service.createRoom({ displayName: "Host" }, "s1");
    clock.advance(11 * 60 * 1000);
    expect(service.sweepExpiredRooms()).toHaveLength(1);
    expect(service.sweepExpiredRooms()).toHaveLength(0);
  });

  it("closed rooms reject joins", async () => {
    const service = makeRoomService();
    const { room } = await service.createRoom({ displayName: "Host" }, "s1");
    service.closeRoom(room, "host-closed");
    await expectCode(
      () => service.join({ roomCode: room.roomCode, displayName: "V" }, "s2"),
      "ROOM_CLOSED"
    );
  });

  it("kicks a viewer and refuses to kick the host", async () => {
    const service = makeRoomService();
    const { room, host } = await service.createRoom({ displayName: "Host" }, "s1");
    const viewer = await service.join({ roomCode: room.roomCode, displayName: "V" }, "s2");
    const kicked = service.kickParticipant(room, viewer.participant.participantId);
    expect(kicked.status).toBe("kicked");
    await expectCode(() => service.kickParticipant(room, host.participantId), "NOT_AUTHORIZED");
  });

  it("participant leaving frees a capacity slot", async () => {
    const service = makeRoomService();
    const { room } = await service.createRoom(
      { displayName: "Host", settings: { maxParticipants: 2 } },
      "s1"
    );
    const viewer = await service.join({ roomCode: room.roomCode, displayName: "V1" }, "s2");
    service.markLeft(room, viewer.participant.participantId);
    const next = await service.join({ roomCode: room.roomCode, displayName: "V2" }, "s3");
    expect(next.kind).toBe("joined");
  });
});
