import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io as ioc, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AckResult,
  CreateRoomResult,
  JoinRoomResult,
  ChatMessage
} from "@watchshare/shared";
import { loadConfig } from "../src/config.js";
import { inMemoryPresence } from "../src/redis/presence.js";
import { RoomService } from "../src/rooms/roomService.js";
import { createIdGenerator, systemClock } from "../src/security/ids.js";
import { createRateLimiter } from "../src/security/rateLimiter.js";
import { createTokenService } from "../src/security/tokens.js";
import { createTurnCredentialProvider } from "../src/security/turn.js";
import { createGateway, type AppServer } from "../src/signaling/gateway.js";
import { testLogger } from "./helpers.js";

const ALLOWED_ORIGIN = "http://localhost:3000";

let httpServer: HttpServer;
let gateway: AppServer;
let baseUrl: string;
const clients: ClientSocket[] = [];

beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    ROOM_TOKEN_SECRET: "test-secret-at-least-16-chars",
    ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    HOST_RECONNECT_GRACE_SECONDS: "5"
  } as NodeJS.ProcessEnv);

  const rooms = new RoomService({
    clock: systemClock,
    ids: createIdGenerator(),
    tokens: createTokenService(config.roomTokenSecret),
    logger: testLogger,
    config: {
      roomCodeLength: config.roomCodeLength,
      maxRoomParticipants: config.maxRoomParticipants,
      defaultRoomTtlMinutes: config.defaultRoomTtlMinutes
    }
  });

  httpServer = createServer();
  gateway = createGateway(httpServer, {
    config,
    logger: testLogger,
    rooms,
    presence: inMemoryPresence(),
    rateLimiter: createRateLimiter(systemClock),
    turn: createTurnCredentialProvider(config, systemClock),
    clock: systemClock,
    ids: createIdGenerator(),
    // Tests create many rooms from one IP; keep chat limits realistic so the
    // flood test still exercises rate limiting.
    rateLimitRules: {
      roomCreatePerIp: { windowMs: 60_000, max: 1000 },
      joinAttemptPerIp: { windowMs: 60_000, max: 1000 },
      signalingPerParticipant: { windowMs: 10_000, max: 1000 }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  for (const client of clients) client.disconnect();
  gateway.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function connect(origin: string = ALLOWED_ORIGIN): ClientSocket {
  const client = ioc(baseUrl, {
    transports: ["websocket"],
    extraHeaders: { origin },
    reconnection: false,
    forceNew: true
  });
  clients.push(client);
  return client;
}

function emitAck<T>(client: ClientSocket, event: string, payload: unknown): Promise<AckResult<T>> {
  return new Promise((resolve) => {
    client.emit(event, payload, (result: AckResult<T>) => resolve(result));
  });
}

function waitFor<T>(client: ClientSocket, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    client.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function createRoomWithHost(): Promise<{ host: ClientSocket; created: CreateRoomResult }> {
  const host = connect();
  await waitFor(host, "connect");
  const result = await emitAck<CreateRoomResult>(host, "room:create", { displayName: "Host" });
  if (!result.ok) throw new Error("room creation failed");
  return { host, created: result.data };
}

async function joinAsViewer(
  roomCode: string,
  displayName = "Viewer"
): Promise<{ viewer: ClientSocket; joined: Extract<JoinRoomResult, { status: "joined" }> }> {
  const viewer = connect();
  await waitFor(viewer, "connect");
  const result = await emitAck<JoinRoomResult>(viewer, "room:join", { roomCode, displayName });
  if (!result.ok || result.data.status !== "joined") throw new Error("join failed");
  return { viewer, joined: result.data };
}

describe("room lifecycle over sockets", () => {
  it("creates a room and returns host credentials", async () => {
    const { created } = await createRoomWithHost();
    expect(created.roomCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(created.hostToken.length).toBeGreaterThan(20);
    expect(created.room.participants).toHaveLength(1);
    expect(created.iceConfig.iceServers.length).toBeGreaterThan(0);
  });

  it("lets a viewer join and notifies the host", async () => {
    const { host, created } = await createRoomWithHost();
    const joinedNotice = waitFor<{ displayName: string }>(host, "room:participant-joined");
    const { joined } = await joinAsViewer(created.roomCode);
    expect(joined.room.participants).toHaveLength(2);
    expect((await joinedNotice).displayName).toBe("Viewer");
  });

  it("returns ROOM_NOT_FOUND for unknown rooms", async () => {
    const client = connect();
    await waitFor(client, "connect");
    const result = await emitAck<JoinRoomResult>(client, "room:join", {
      roomCode: "ZZZZ9999",
      displayName: "X"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ROOM_NOT_FOUND");
  });

  it("rejects malformed payloads with VALIDATION_FAILED", async () => {
    const client = connect();
    await waitFor(client, "connect");
    const result = await emitAck<JoinRoomResult>(client, "room:join", {
      roomCode: { $ne: null },
      displayName: 42
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("host can kick a viewer, who is notified", async () => {
    const { host, created } = await createRoomWithHost();
    const { viewer, joined } = await joinAsViewer(created.roomCode);
    const kickedNotice = waitFor(viewer, "room:you-were-kicked");
    host.emit("host:kick-participant", {
      roomCode: created.roomCode,
      participantId: joined.participantId
    });
    await kickedNotice;
  });

  it("viewer cannot kick (non-host moderation rejected)", async () => {
    const { created } = await createRoomWithHost();
    const { viewer } = await joinAsViewer(created.roomCode);
    const errorNotice = waitFor<{ code: string }>(viewer, "system:error");
    viewer.emit("host:kick-participant", {
      roomCode: created.roomCode,
      participantId: created.participantId
    });
    expect((await errorNotice).code).toBe("NOT_AUTHORIZED");
  });

  it("host can close the room and everyone is notified", async () => {
    const { host, created } = await createRoomWithHost();
    const { viewer } = await joinAsViewer(created.roomCode);
    const closedNotice = waitFor<{ reason: string }>(viewer, "room:closed");
    host.emit("host:close-room", { roomCode: created.roomCode });
    expect((await closedNotice).reason).toBe("host-closed");
  });

  it("supports the waiting room approve flow", async () => {
    const host = connect();
    await waitFor(host, "connect");
    const createResult = await emitAck<CreateRoomResult>(host, "room:create", {
      displayName: "Host",
      settings: { waitingRoomEnabled: true }
    });
    if (!createResult.ok) throw new Error("create failed");

    const viewer = connect();
    await waitFor(viewer, "connect");
    const waitingNotice = waitFor<{ participantId: string }>(host, "room:participant-waiting");
    const joinResult = await emitAck<JoinRoomResult>(viewer, "room:join", {
      roomCode: createResult.data.roomCode,
      displayName: "Guest"
    });
    expect(joinResult.ok && joinResult.data.status).toBe("waiting");
    const waiting = await waitingNotice;

    const approvedNotice = waitFor<JoinRoomResult>(viewer, "room:you-were-approved");
    host.emit("room:approve-participant", {
      roomCode: createResult.data.roomCode,
      participantId: waiting.participantId
    });
    const approved = await approvedNotice;
    expect(approved.status).toBe("joined");
  });
});

describe("webrtc signaling relay", () => {
  it("routes offers, answers, and ICE candidates between host and viewer", async () => {
    const { host, created } = await createRoomWithHost();
    const { viewer, joined } = await joinAsViewer(created.roomCode);

    const offerAtViewer = waitFor<{ fromParticipantId: string; description: { sdp: string } }>(
      viewer,
      "webrtc:offer"
    );
    host.emit("webrtc:offer", {
      roomCode: created.roomCode,
      targetParticipantId: joined.participantId,
      description: { type: "offer", sdp: "v=0 test-offer" }
    });
    const offer = await offerAtViewer;
    expect(offer.fromParticipantId).toBe(created.participantId);
    expect(offer.description.sdp).toBe("v=0 test-offer");

    const answerAtHost = waitFor<{ description: { sdp: string } }>(host, "webrtc:answer");
    viewer.emit("webrtc:answer", {
      roomCode: created.roomCode,
      targetParticipantId: created.participantId,
      description: { type: "answer", sdp: "v=0 test-answer" }
    });
    expect((await answerAtHost).description.sdp).toBe("v=0 test-answer");

    const candidateAtViewer = waitFor<{ candidate: { candidate: string } | null }>(
      viewer,
      "webrtc:ice-candidate"
    );
    host.emit("webrtc:ice-candidate", {
      roomCode: created.roomCode,
      targetParticipantId: joined.participantId,
      candidate: { candidate: "candidate:1 1 udp 1 10.0.0.1 1 typ host", sdpMid: "0", sdpMLineIndex: 0 }
    });
    expect((await candidateAtViewer).candidate?.candidate).toContain("candidate:1");
  });

  it("rejects cross-room signaling", async () => {
    const roomA = await createRoomWithHost();
    const roomB = await createRoomWithHost();
    const viewerB = await joinAsViewer(roomB.created.roomCode, "OtherRoomViewer");

    // Host A tries to signal a participant of room B.
    const errorNotice = waitFor<{ code: string }>(roomA.host, "system:error");
    roomA.host.emit("webrtc:offer", {
      roomCode: roomA.created.roomCode,
      targetParticipantId: viewerB.joined.participantId,
      description: { type: "offer", sdp: "v=0" }
    });
    expect((await errorNotice).code).toBe("NOT_AUTHORIZED");
  });

  it("rejects signaling with a forged sender room claim", async () => {
    const roomA = await createRoomWithHost();
    const roomB = await createRoomWithHost();

    // Host A claims to be in room B.
    const errorNotice = waitFor<{ code: string }>(roomA.host, "system:error");
    roomA.host.emit("webrtc:offer", {
      roomCode: roomB.created.roomCode,
      targetParticipantId: roomB.created.participantId,
      description: { type: "offer", sdp: "v=0" }
    });
    expect((await errorNotice).code).toBe("NOT_AUTHORIZED");
  });

  it("rejects oversized SDP payloads", async () => {
    const { host, created } = await createRoomWithHost();
    const { joined } = await joinAsViewer(created.roomCode);
    const errorNotice = waitFor<{ code: string }>(host, "system:error");
    host.emit("webrtc:offer", {
      roomCode: created.roomCode,
      targetParticipantId: joined.participantId,
      description: { type: "offer", sdp: "a".repeat(130 * 1024) }
    });
    expect((await errorNotice).code).toBe("VALIDATION_FAILED");
  });
});

describe("chat", () => {
  it("broadcasts chat messages and acks the sender", async () => {
    const { host, created } = await createRoomWithHost();
    const { viewer } = await joinAsViewer(created.roomCode);
    const messageAtViewer = waitFor<ChatMessage>(viewer, "chat:message");
    const ack = await emitAck<ChatMessage>(host, "chat:send", {
      roomCode: created.roomCode,
      body: "hello there"
    });
    expect(ack.ok).toBe(true);
    const received = await messageAtViewer;
    expect(received.body).toBe("hello there");
    expect(received.kind).toBe("user");
  });

  it("keeps XSS payloads as inert plain text", async () => {
    const { host, created } = await createRoomWithHost();
    const ack = await emitAck<ChatMessage>(host, "chat:send", {
      roomCode: created.roomCode,
      body: "<img src=x onerror=alert(1)>"
    });
    expect(ack.ok).toBe(true);
    if (ack.ok) expect(ack.data.body).toBe("<img src=x onerror=alert(1)>");
  });

  it("suppresses duplicate messages sent rapidly", async () => {
    const { host, created } = await createRoomWithHost();
    const first = await emitAck<ChatMessage>(host, "chat:send", {
      roomCode: created.roomCode,
      body: "dup"
    });
    const second = await emitAck<ChatMessage>(host, "chat:send", {
      roomCode: created.roomCode,
      body: "dup"
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("RATE_LIMITED");
  });

  it("rate limits chat floods", async () => {
    const { host, created } = await createRoomWithHost();
    const results: AckResult<ChatMessage>[] = [];
    for (let i = 0; i < 12; i += 1) {
      results.push(
        await emitAck<ChatMessage>(host, "chat:send", {
          roomCode: created.roomCode,
          body: `message number ${i}`
        })
      );
    }
    expect(results.some((r) => !r.ok && r.error.code === "RATE_LIMITED")).toBe(true);
  });
});

describe("origin validation", () => {
  it("rejects websocket connections from disallowed origins", async () => {
    const rogue = connect("https://evil.example.com");
    const outcome = await new Promise<string>((resolve) => {
      rogue.once("connect", () => resolve("connected"));
      rogue.once("connect_error", () => resolve("rejected"));
      setTimeout(() => resolve("timeout"), 3000);
    });
    expect(outcome).toBe("rejected");
  });
});
