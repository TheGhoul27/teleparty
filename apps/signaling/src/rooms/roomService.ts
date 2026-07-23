import type { AppError, CreateRoomPayload, JoinRoomPayload } from "@watchshare/shared";
import { appError } from "@watchshare/shared";
import type { Clock, IdGenerator } from "../security/ids.js";
import type { TokenService } from "../security/tokens.js";
import type { Logger } from "../observability/logger.js";
import type { JoinOutcome, ParticipantRecord, RoomRecord } from "./roomTypes.js";
import { activeParticipantCount } from "./roomTypes.js";

export class AppErrorException extends Error {
  readonly appError: AppError;
  constructor(error: AppError) {
    super(error.message);
    this.appError = error;
  }
}

const fail = (code: AppError["code"]): never => {
  throw new AppErrorException(appError(code));
};

export interface RoomServiceDeps {
  clock: Clock;
  ids: IdGenerator;
  tokens: TokenService;
  logger: Logger;
  config: {
    roomCodeLength: number;
    maxRoomParticipants: number;
    defaultRoomTtlMinutes: number;
  };
}

export interface CreateRoomOutcome {
  room: RoomRecord;
  host: ParticipantRecord;
  hostToken: string;
  reconnectToken: string;
}

/**
 * Authoritative in-process room state machine. Everything is deliberately
 * ephemeral: rooms, participants, and chat vanish when the room closes or the
 * process restarts. Redis (when configured) only mirrors presence for
 * observability/scaling and is never consulted on the hot path.
 */
export class RoomService {
  private readonly rooms = new Map<string, RoomRecord>();

  constructor(private readonly deps: RoomServiceDeps) {}

  async createRoom(payload: CreateRoomPayload, socketId: string | null): Promise<CreateRoomOutcome> {
    const { clock, ids, tokens, config } = this.deps;

    let roomCode = ids.roomCode(config.roomCodeLength);
    // Regenerate on the (astronomically unlikely) collision.
    while (this.rooms.has(roomCode)) roomCode = ids.roomCode(config.roomCodeLength);

    const hostToken = ids.token();
    const reconnectToken = ids.token();
    const now = clock.now();
    const ttlMinutes = payload.settings?.ttlMinutes ?? config.defaultRoomTtlMinutes;

    const passwordHash = payload.settings?.password
      ? await tokens.hashPassword(payload.settings.password)
      : null;

    const host: ParticipantRecord = {
      participantId: ids.participantId(),
      displayName: payload.displayName,
      role: "host",
      status: "joined",
      micEnabled: false,
      micAllowed: true,
      joinedAt: now,
      leftAt: null,
      kickedAt: null,
      reconnectTokenHash: tokens.hashToken(reconnectToken),
      socketId
    };

    const room: RoomRecord = {
      roomCode,
      createdAt: now,
      expiresAt: now + ttlMinutes * 60 * 1000,
      closedAt: null,
      closeReason: null,
      hostTokenHash: tokens.hashToken(hostToken),
      passwordHash,
      settings: {
        maxParticipants: Math.min(
          payload.settings?.maxParticipants ?? config.maxRoomParticipants,
          config.maxRoomParticipants
        ),
        waitingRoomEnabled: payload.settings?.waitingRoomEnabled ?? false,
        allowMicrophones: payload.settings?.allowMicrophones ?? true,
        allowChat: payload.settings?.allowChat ?? true
      },
      participants: new Map([[host.participantId, host]]),
      hostParticipantId: host.participantId,
      hostConnected: socketId !== null,
      sharing: { mode: "none", surfaceIsBrowserTab: null, startedAt: null },
      recentChatFingerprints: new Map()
    };

    this.rooms.set(roomCode, room);
    this.deps.logger.info({ roomCode, participantId: host.participantId }, "room created");

    return { room, host, hostToken, reconnectToken };
  }

  /** Returns the room when it exists and is neither closed nor expired. */
  getOpenRoom(roomCode: string): RoomRecord {
    const room = this.rooms.get(roomCode);
    if (!room) fail("ROOM_NOT_FOUND");
    if (room!.closedAt !== null) {
      fail(room!.closeReason === "expired" ? "ROOM_EXPIRED" : "ROOM_CLOSED");
    }
    if (this.deps.clock.now() >= room!.expiresAt) {
      // Lazily expire.
      this.closeRoom(room!, "expired");
      fail("ROOM_EXPIRED");
    }
    return room!;
  }

  peekRoom(roomCode: string): RoomRecord | undefined {
    return this.rooms.get(roomCode);
  }

  async join(payload: JoinRoomPayload, socketId: string): Promise<JoinOutcome> {
    const { tokens, ids, clock } = this.deps;
    const room = this.getOpenRoom(payload.roomCode);

    // Host rejoin via management token wins over everything else.
    if (payload.hostToken) {
      if (!tokens.verifyToken(payload.hostToken, room.hostTokenHash)) {
        fail("HOST_AUTH_FAILED");
      }
      return this.rejoinAsHost(room, payload, socketId);
    }

    // Reconnect token: restore an existing participant record.
    if (payload.reconnectToken) {
      const existing = [...room.participants.values()].find(
        (p) =>
          p.status !== "kicked" && tokens.verifyToken(payload.reconnectToken!, p.reconnectTokenHash)
      );
      if (existing) {
        existing.socketId = socketId;
        existing.displayName = payload.displayName;
        if (existing.status === "left") existing.status = "joined";
        const reconnectToken = ids.token();
        existing.reconnectTokenHash = tokens.hashToken(reconnectToken);
        return {
          kind: "rejoined",
          participant: existing,
          reconnectToken,
          isHost: existing.role === "host"
        };
      }
      // Fall through to a normal join with a generic path (no info leak).
    }

    if (room.passwordHash) {
      const ok = payload.password
        ? await tokens.verifyPassword(payload.password, room.passwordHash)
        : false;
      if (!ok) fail("INVALID_PASSWORD");
    }

    if (activeParticipantCount(room) >= room.settings.maxParticipants) fail("ROOM_FULL");

    const reconnectToken = ids.token();
    const participant: ParticipantRecord = {
      participantId: ids.participantId(),
      displayName: payload.displayName,
      role: "viewer",
      status: room.settings.waitingRoomEnabled ? "waiting" : "joined",
      micEnabled: false,
      micAllowed: room.settings.allowMicrophones,
      joinedAt: clock.now(),
      leftAt: null,
      kickedAt: null,
      reconnectTokenHash: tokens.hashToken(reconnectToken),
      socketId
    };
    room.participants.set(participant.participantId, participant);

    if (participant.status === "waiting") {
      return { kind: "waiting", participant, reconnectToken };
    }
    return { kind: "joined", participant, reconnectToken, isHost: false };
  }

  private rejoinAsHost(
    room: RoomRecord,
    payload: JoinRoomPayload,
    socketId: string
  ): JoinOutcome {
    const { ids, tokens } = this.deps;
    const hostId = room.hostParticipantId;
    const host = hostId ? room.participants.get(hostId) : undefined;
    const reconnectToken = ids.token();

    if (host) {
      host.socketId = socketId;
      host.status = "joined";
      host.displayName = payload.displayName;
      host.reconnectTokenHash = tokens.hashToken(reconnectToken);
      room.hostConnected = true;
      return { kind: "rejoined", participant: host, reconnectToken, isHost: true };
    }

    const newHost: ParticipantRecord = {
      participantId: ids.participantId(),
      displayName: payload.displayName,
      role: "host",
      status: "joined",
      micEnabled: false,
      micAllowed: true,
      joinedAt: this.deps.clock.now(),
      leftAt: null,
      kickedAt: null,
      reconnectTokenHash: tokens.hashToken(reconnectToken),
      socketId
    };
    room.participants.set(newHost.participantId, newHost);
    room.hostParticipantId = newHost.participantId;
    room.hostConnected = true;
    return { kind: "joined", participant: newHost, reconnectToken, isHost: true };
  }

  approveParticipant(room: RoomRecord, participantId: string): ParticipantRecord {
    const participant = room.participants.get(participantId);
    if (!participant || participant.status !== "waiting") fail("ROOM_NOT_FOUND");
    if (activeParticipantCount(room) >= room.settings.maxParticipants) fail("ROOM_FULL");
    participant!.status = "joined";
    return participant!;
  }

  rejectParticipant(room: RoomRecord, participantId: string): ParticipantRecord {
    const participant = room.participants.get(participantId);
    if (!participant || participant.status !== "waiting") fail("ROOM_NOT_FOUND");
    participant!.status = "left";
    participant!.leftAt = this.deps.clock.now();
    return participant!;
  }

  kickParticipant(room: RoomRecord, participantId: string): ParticipantRecord {
    const participant = room.participants.get(participantId);
    if (!participant || participant.role === "host") fail("NOT_AUTHORIZED");
    participant!.status = "kicked";
    participant!.kickedAt = this.deps.clock.now();
    participant!.leftAt = participant!.kickedAt;
    return participant!;
  }

  markLeft(room: RoomRecord, participantId: string): void {
    const participant = room.participants.get(participantId);
    if (!participant) return;
    participant.status = "left";
    participant.leftAt = this.deps.clock.now();
    participant.socketId = null;
    participant.micEnabled = false;
  }

  markDisconnected(room: RoomRecord, participantId: string): ParticipantRecord | undefined {
    const participant = room.participants.get(participantId);
    if (!participant) return undefined;
    participant.socketId = null;
    if (participant.role === "host") {
      room.hostConnected = false;
    } else if (participant.status === "joined" || participant.status === "waiting") {
      participant.status = "left";
      participant.leftAt = this.deps.clock.now();
    }
    return participant;
  }

  closeRoom(room: RoomRecord, reason: "host-closed" | "expired" | "host-timeout"): void {
    if (room.closedAt !== null) return;
    room.closedAt = this.deps.clock.now();
    room.closeReason = reason;
    room.sharing = { mode: "none", surfaceIsBrowserTab: null, startedAt: null };
    this.deps.logger.info({ roomCode: room.roomCode, reason }, "room closed");
  }

  /** Removes closed/expired rooms from memory after a retention delay. */
  sweepExpiredRooms(retentionMs = 5 * 60 * 1000): RoomRecord[] {
    const now = this.deps.clock.now();
    const newlyExpired: RoomRecord[] = [];
    for (const room of this.rooms.values()) {
      if (room.closedAt === null && now >= room.expiresAt) {
        this.closeRoom(room, "expired");
        newlyExpired.push(room);
      }
      if (room.closedAt !== null && now - room.closedAt > retentionMs) {
        this.rooms.delete(room.roomCode);
      }
    }
    return newlyExpired;
  }

  verifyHostToken(room: RoomRecord, hostToken: string): boolean {
    return this.deps.tokens.verifyToken(hostToken, room.hostTokenHash);
  }

  allRooms(): IterableIterator<RoomRecord> {
    return this.rooms.values();
  }
}
