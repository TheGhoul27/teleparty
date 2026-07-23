import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import type { ZodType } from "zod";
import {
  appError,
  approveParticipantPayloadSchema,
  answerPayloadSchema,
  closeRoomPayloadSchema,
  createRoomPayloadSchema,
  deleteChatMessagePayloadSchema,
  iceCandidatePayloadSchema,
  joinRoomPayloadSchema,
  kickParticipantPayloadSchema,
  leaveRoomPayloadSchema,
  microphoneStatePayloadSchema,
  offerPayloadSchema,
  rejectParticipantPayloadSchema,
  restartRequestPayloadSchema,
  sendChatPayloadSchema,
  setMicPermissionPayloadSchema,
  sharingStartedPayloadSchema,
  sharingStoppedPayloadSchema,
  type Ack,
  type AppError,
  type ChatMessage,
  type ClientToServerEvents,
  type JoinRoomResult,
  type ServerToClientEvents
} from "@watchshare/shared";
import { isOriginAllowed, type AppConfig } from "../config.js";
import type { Logger } from "../observability/logger.js";
import type { PresenceService } from "../redis/presence.js";
import { AppErrorException, type RoomService } from "../rooms/roomService.js";
import { toPublicParticipant, toPublicRoomState, type RoomRecord } from "../rooms/roomTypes.js";
import { filterChatBody, normalizeChatBody } from "../security/chatFilter.js";
import type { Clock, IdGenerator } from "../security/ids.js";
import { RATE_LIMIT_RULES, type RateLimiter, type RateLimitRule } from "../security/rateLimiter.js";
import type { TurnCredentialProvider } from "../security/turn.js";

interface SocketData {
  roomCode?: string;
  participantId?: string;
}

type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
export type AppServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface GatewayDeps {
  config: AppConfig;
  logger: Logger;
  rooms: RoomService;
  presence: PresenceService;
  rateLimiter: RateLimiter;
  turn: TurnCredentialProvider;
  clock: Clock;
  ids: IdGenerator;
  /** Override for tests; defaults to production limits. */
  rateLimitRules?: Partial<Record<keyof typeof RATE_LIMIT_RULES, RateLimitRule>>;
}

const roomChannel = (roomCode: string): string => `room:${roomCode}`;

export function createGateway(httpServer: HttpServer, deps: GatewayDeps): AppServer {
  const { config, logger, rooms, presence, rateLimiter, turn, clock, ids } = deps;
  const rules = { ...RATE_LIMIT_RULES, ...deps.rateLimitRules };

  const io: AppServer = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => callback(null, isOriginAllowed(config, origin)),
      credentials: false
    },
    // Reject WebSocket upgrades from unknown origins even without CORS preflight.
    allowRequest: (req, callback) => {
      if (isOriginAllowed(config, req.headers.origin)) {
        callback(null, true);
      } else {
        callback("origin not allowed", false);
      }
    },
    maxHttpBufferSize: 256 * 1024
  });

  const hostGraceTimers = new Map<string, NodeJS.Timeout>();

  const emitSystemChat = (room: RoomRecord, body: string): void => {
    const message: ChatMessage = {
      messageId: ids.messageId(),
      roomCode: room.roomCode,
      participantId: "system",
      displayName: "System",
      body,
      sentAt: clock.now(),
      kind: "system"
    };
    io.to(roomChannel(room.roomCode)).emit("chat:message", message);
  };

  const broadcastRoomState = (room: RoomRecord): void => {
    io.to(roomChannel(room.roomCode)).emit("room:state", toPublicRoomState(room));
  };

  const closeRoomAndNotify = (
    room: RoomRecord,
    reason: "host-closed" | "expired" | "host-timeout"
  ): void => {
    rooms.closeRoom(room, reason);
    const timer = hostGraceTimers.get(room.roomCode);
    if (timer) {
      clearTimeout(timer);
      hostGraceTimers.delete(room.roomCode);
    }
    io.to(roomChannel(room.roomCode)).emit("room:closed", { reason });
    io.in(roomChannel(room.roomCode)).socketsLeave(roomChannel(room.roomCode));
    void presence.removeRoom(room.roomCode);
  };

  // Expire rooms even when idle.
  const sweeper = setInterval(() => {
    for (const room of rooms.sweepExpiredRooms()) {
      io.to(roomChannel(room.roomCode)).emit("room:closed", { reason: "expired" });
      io.in(roomChannel(room.roomCode)).socketsLeave(roomChannel(room.roomCode));
      void presence.removeRoom(room.roomCode);
    }
  }, 30 * 1000);
  sweeper.unref?.();

  io.on("connection", (socket: AppSocket) => {
    const clientIp = socket.handshake.address;

    /** Resolves the caller's membership; throws AppErrorException when invalid. */
    const requireMembership = (roomCode: string) => {
      const room = rooms.getOpenRoom(roomCode);
      const participantId = socket.data.participantId;
      if (
        !participantId ||
        socket.data.roomCode !== roomCode ||
        !room.participants.has(participantId)
      ) {
        throw new AppErrorException(appError("NOT_AUTHORIZED"));
      }
      const participant = room.participants.get(participantId)!;
      if (participant.status !== "joined") {
        throw new AppErrorException(appError("NOT_AUTHORIZED"));
      }
      return { room, participant };
    };

    const requireHost = (roomCode: string) => {
      const ctx = requireMembership(roomCode);
      if (ctx.participant.role !== "host") {
        throw new AppErrorException(appError("NOT_AUTHORIZED"));
      }
      return ctx;
    };

    const toAppError = (err: unknown): AppError => {
      if (err instanceof AppErrorException) return err.appError;
      logger.error({ err, socketId: socket.id }, "unexpected gateway error");
      return appError("UNKNOWN");
    };

    /** Wraps ack-style handlers with validation + generic error mapping. */
    function ackHandler<S extends ZodType, R>(
      schema: S,
      handler: (payload: S["_output"], ack: Ack<R>) => Promise<void> | void
    ) {
      return async (rawPayload: unknown, ack?: Ack<R>): Promise<void> => {
        const respond: Ack<R> = typeof ack === "function" ? ack : () => undefined;
        const parsed = schema.safeParse(rawPayload);
        if (!parsed.success) {
          respond({ ok: false, error: appError("VALIDATION_FAILED") });
          return;
        }
        try {
          await handler(parsed.data, respond);
        } catch (err) {
          respond({ ok: false, error: toAppError(err) });
        }
      };
    }

    /** Wraps fire-and-forget handlers with validation + rate limiting. */
    function eventHandler<S extends ZodType>(
      schema: S,
      handler: (payload: S["_output"]) => void
    ) {
      return (rawPayload: unknown): void => {
        if (!rateLimiter.consume(`sig:${socket.id}`, rules.signalingPerParticipant)) {
          socket.emit("system:rate-limit-warning", {
            message: "Too many messages; slowing down."
          });
          return;
        }
        const parsed = schema.safeParse(rawPayload);
        if (!parsed.success) {
          socket.emit("system:error", appError("VALIDATION_FAILED"));
          return;
        }
        try {
          handler(parsed.data);
        } catch (err) {
          socket.emit("system:error", toAppError(err));
        }
      };
    }

    // ---- Room lifecycle ----

    socket.on(
      "room:create",
      ackHandler(createRoomPayloadSchema, async (payload, ack) => {
        if (!rateLimiter.consume(`create:${clientIp}`, rules.roomCreatePerIp)) {
          ack({ ok: false, error: appError("RATE_LIMITED") });
          return;
        }
        const outcome = await rooms.createRoom(payload, socket.id);
        socket.data.roomCode = outcome.room.roomCode;
        socket.data.participantId = outcome.host.participantId;
        await socket.join(roomChannel(outcome.room.roomCode));
        void presence.addParticipant(
          outcome.room.roomCode,
          outcome.host.participantId,
          Math.ceil((outcome.room.expiresAt - clock.now()) / 1000)
        );
        ack({
          ok: true,
          data: {
            roomCode: outcome.room.roomCode,
            hostToken: outcome.hostToken,
            reconnectToken: outcome.reconnectToken,
            participantId: outcome.host.participantId,
            room: toPublicRoomState(outcome.room),
            iceConfig: turn.getCredentials()
          }
        });
      })
    );

    socket.on(
      "room:join",
      ackHandler(joinRoomPayloadSchema, async (payload, ack) => {
        if (!rateLimiter.consume(`join:${clientIp}`, rules.joinAttemptPerIp)) {
          ack({ ok: false, error: appError("RATE_LIMITED") });
          return;
        }
        if (payload.password !== undefined) {
          const key = `pw:${payload.roomCode}`;
          if (!rateLimiter.consume(key, rules.passwordAttemptPerRoom)) {
            ack({ ok: false, error: appError("RATE_LIMITED") });
            return;
          }
        }

        const outcome = await rooms.join(payload, socket.id);
        const room = rooms.getOpenRoom(payload.roomCode);
        socket.data.roomCode = room.roomCode;
        socket.data.participantId = outcome.participant.participantId;

        if (outcome.kind === "waiting") {
          // Waiting participants get a private channel so approval can reach them.
          await socket.join(`waiting:${outcome.participant.participantId}`);
          const hostSocketId = room.hostParticipantId
            ? room.participants.get(room.hostParticipantId)?.socketId
            : null;
          if (hostSocketId) {
            io.to(hostSocketId).emit(
              "room:participant-waiting",
              toPublicParticipant(outcome.participant)
            );
          }
          ack({
            ok: true,
            data: {
              status: "waiting",
              participantId: outcome.participant.participantId,
              reconnectToken: outcome.reconnectToken
            }
          });
          return;
        }

        await socket.join(roomChannel(room.roomCode));
        void presence.addParticipant(
          room.roomCode,
          outcome.participant.participantId,
          Math.ceil((room.expiresAt - clock.now()) / 1000)
        );

        const wasHostReconnect = outcome.kind === "rejoined" && outcome.isHost;
        if (wasHostReconnect) {
          const timer = hostGraceTimers.get(room.roomCode);
          if (timer) {
            clearTimeout(timer);
            hostGraceTimers.delete(room.roomCode);
          }
          socket.to(roomChannel(room.roomCode)).emit("room:host-reconnected");
          emitSystemChat(room, `${outcome.participant.displayName} (host) reconnected.`);
        } else {
          socket
            .to(roomChannel(room.roomCode))
            .emit("room:participant-joined", toPublicParticipant(outcome.participant));
          emitSystemChat(room, `${outcome.participant.displayName} joined the room.`);
        }
        broadcastRoomState(room);

        const result: JoinRoomResult = {
          status: "joined",
          participantId: outcome.participant.participantId,
          reconnectToken: outcome.reconnectToken,
          room: toPublicRoomState(room),
          iceConfig: turn.getCredentials(),
          isHost: outcome.isHost
        };
        ack({ ok: true, data: result });
      })
    );

    socket.on(
      "room:leave",
      eventHandler(leaveRoomPayloadSchema, (payload) => {
        const { room, participant } = requireMembership(payload.roomCode);
        rooms.markLeft(room, participant.participantId);
        socket.leave(roomChannel(room.roomCode));
        socket.data.roomCode = undefined;
        socket.data.participantId = undefined;
        void presence.removeParticipant(room.roomCode, participant.participantId);
        io.to(roomChannel(room.roomCode)).emit("room:participant-left", {
          participantId: participant.participantId
        });
        emitSystemChat(room, `${participant.displayName} left the room.`);
        broadcastRoomState(room);
      })
    );

    socket.on(
      "room:approve-participant",
      eventHandler(approveParticipantPayloadSchema, (payload) => {
        const { room } = requireHost(payload.roomCode);
        const participant = rooms.approveParticipant(room, payload.participantId);
        const waitingSocketId = participant.socketId;
        if (waitingSocketId) {
          const waitingSocket = io.sockets.sockets.get(waitingSocketId);
          void waitingSocket?.join(roomChannel(room.roomCode));
          void waitingSocket?.leave(`waiting:${participant.participantId}`);
          io.to(waitingSocketId).emit("room:you-were-approved", {
            status: "joined",
            participantId: participant.participantId,
            // Reconnect token was already delivered at join time; do not reissue.
            reconnectToken: "",
            room: toPublicRoomState(room),
            iceConfig: turn.getCredentials(),
            isHost: false
          });
        }
        void presence.addParticipant(
          room.roomCode,
          participant.participantId,
          Math.ceil((room.expiresAt - clock.now()) / 1000)
        );
        io.to(roomChannel(room.roomCode)).emit("room:participant-approved", {
          participantId: participant.participantId
        });
        emitSystemChat(room, `${participant.displayName} joined the room.`);
        broadcastRoomState(room);
      })
    );

    socket.on(
      "room:reject-participant",
      eventHandler(rejectParticipantPayloadSchema, (payload) => {
        const { room } = requireHost(payload.roomCode);
        const participant = rooms.rejectParticipant(room, payload.participantId);
        if (participant.socketId) {
          io.to(participant.socketId).emit("room:you-were-rejected", appError("WAITING_REJECTED"));
        }
        io.to(roomChannel(room.roomCode)).emit("room:participant-rejected", {
          participantId: participant.participantId
        });
      })
    );

    // ---- WebRTC relay ----

    /**
     * Relays a signaling payload to a target participant after verifying both
     * sender membership and that the target belongs to the same room. SDP and
     * candidates are forwarded, never stored.
     */
    const relayToTarget = (
      roomCode: string,
      targetParticipantId: string,
      emit: (targetSocketId: string, fromParticipantId: string) => void
    ): void => {
      const { room, participant } = requireMembership(roomCode);
      const target = room.participants.get(targetParticipantId);
      if (!target || target.status !== "joined" || !target.socketId) {
        throw new AppErrorException(appError("NOT_AUTHORIZED"));
      }
      // Star topology: media signaling only flows between host and viewer.
      const hostId = room.hostParticipantId;
      const senderIsHost = participant.participantId === hostId;
      const targetIsHost = targetParticipantId === hostId;
      if (!senderIsHost && !targetIsHost) {
        throw new AppErrorException(appError("NOT_AUTHORIZED"));
      }
      emit(target.socketId, participant.participantId);
    };

    socket.on(
      "webrtc:offer",
      eventHandler(offerPayloadSchema, (payload) => {
        relayToTarget(payload.roomCode, payload.targetParticipantId, (sid, from) => {
          io.to(sid).emit("webrtc:offer", {
            fromParticipantId: from,
            description: payload.description
          });
        });
      })
    );

    socket.on(
      "webrtc:answer",
      eventHandler(answerPayloadSchema, (payload) => {
        relayToTarget(payload.roomCode, payload.targetParticipantId, (sid, from) => {
          io.to(sid).emit("webrtc:answer", {
            fromParticipantId: from,
            description: payload.description
          });
        });
      })
    );

    socket.on(
      "webrtc:ice-candidate",
      eventHandler(iceCandidatePayloadSchema, (payload) => {
        relayToTarget(payload.roomCode, payload.targetParticipantId, (sid, from) => {
          io.to(sid).emit("webrtc:ice-candidate", {
            fromParticipantId: from,
            candidate: payload.candidate
          });
        });
      })
    );

    socket.on(
      "webrtc:restart-request",
      eventHandler(restartRequestPayloadSchema, (payload) => {
        relayToTarget(payload.roomCode, payload.targetParticipantId, (sid, from) => {
          io.to(sid).emit("webrtc:restart-request", { fromParticipantId: from });
        });
      })
    );

    // ---- Media state ----

    socket.on(
      "media:sharing-started",
      eventHandler(sharingStartedPayloadSchema, (payload) => {
        const { room } = requireHost(payload.roomCode);
        room.sharing = {
          mode: payload.hasAudio ? "video-and-audio" : "video-only",
          surfaceIsBrowserTab: payload.surfaceIsBrowserTab,
          startedAt: clock.now()
        };
        io.to(roomChannel(room.roomCode)).emit("media:share-state", room.sharing);
        emitSystemChat(
          room,
          payload.hasAudio ? "Host started sharing with audio." : "Host started sharing (video only)."
        );
      })
    );

    socket.on(
      "media:sharing-stopped",
      eventHandler(sharingStoppedPayloadSchema, (payload) => {
        const { room } = requireHost(payload.roomCode);
        room.sharing = { mode: "none", surfaceIsBrowserTab: null, startedAt: null };
        io.to(roomChannel(room.roomCode)).emit("media:share-state", room.sharing);
        emitSystemChat(room, "Host stopped sharing.");
      })
    );

    socket.on(
      "media:microphone-state",
      eventHandler(microphoneStatePayloadSchema, (payload) => {
        const { room, participant } = requireMembership(payload.roomCode);
        if (payload.enabled && !participant.micAllowed) {
          throw new AppErrorException(appError("NOT_AUTHORIZED"));
        }
        participant.micEnabled = payload.enabled;
        io.to(roomChannel(room.roomCode)).emit("media:microphone-state", {
          participantId: participant.participantId,
          enabled: payload.enabled
        });
      })
    );

    // ---- Chat ----

    socket.on(
      "chat:send",
      ackHandler(sendChatPayloadSchema, (payload, ack) => {
        const { room, participant } = requireMembership(payload.roomCode);
        if (!room.settings.allowChat) {
          ack({ ok: false, error: appError("NOT_AUTHORIZED") });
          return;
        }
        if (!rateLimiter.consume(`chat:${socket.id}`, rules.chatPerParticipant)) {
          ack({ ok: false, error: appError("RATE_LIMITED") });
          return;
        }
        const normalized = normalizeChatBody(payload.body);
        if (!normalized) {
          ack({ ok: false, error: appError("VALIDATION_FAILED") });
          return;
        }
        // Duplicate suppression: same participant, same body within 5 seconds.
        const fingerprint = normalized.toLowerCase();
        const last = room.recentChatFingerprints.get(participant.participantId);
        const now = clock.now();
        if (last && last.fingerprint === fingerprint && now - last.at < 5000) {
          ack({ ok: false, error: appError("RATE_LIMITED") });
          return;
        }
        room.recentChatFingerprints.set(participant.participantId, { fingerprint, at: now });

        const message: ChatMessage = {
          messageId: ids.messageId(),
          roomCode: room.roomCode,
          participantId: participant.participantId,
          displayName: participant.displayName,
          body: filterChatBody(normalized),
          sentAt: now,
          kind: "user"
        };
        io.to(roomChannel(room.roomCode)).emit("chat:message", message);
        ack({ ok: true, data: message });
      })
    );

    socket.on(
      "chat:delete",
      eventHandler(deleteChatMessagePayloadSchema, (payload) => {
        requireHost(payload.roomCode);
        io.to(roomChannel(payload.roomCode)).emit("chat:deleted", {
          messageId: payload.messageId
        });
      })
    );

    // ---- Host moderation ----

    socket.on(
      "host:kick-participant",
      eventHandler(kickParticipantPayloadSchema, (payload) => {
        const { room } = requireHost(payload.roomCode);
        const kicked = rooms.kickParticipant(room, payload.participantId);
        if (kicked.socketId) {
          io.to(kicked.socketId).emit("room:you-were-kicked", appError("NOT_AUTHORIZED", "You were removed from the room by the host."));
          const kickedSocket = io.sockets.sockets.get(kicked.socketId);
          void kickedSocket?.leave(roomChannel(room.roomCode));
          if (kickedSocket) {
            kickedSocket.data.roomCode = undefined;
            kickedSocket.data.participantId = undefined;
          }
        }
        void presence.removeParticipant(room.roomCode, kicked.participantId);
        io.to(roomChannel(room.roomCode)).emit("room:participant-kicked", {
          participantId: kicked.participantId
        });
        emitSystemChat(room, `${kicked.displayName} was removed from the room.`);
        broadcastRoomState(room);
      })
    );

    socket.on(
      "host:set-mic-permission",
      eventHandler(setMicPermissionPayloadSchema, (payload) => {
        const { room } = requireHost(payload.roomCode);
        const target = room.participants.get(payload.participantId);
        if (!target || target.role === "host") {
          throw new AppErrorException(appError("NOT_AUTHORIZED"));
        }
        target.micAllowed = payload.allowed;
        if (!payload.allowed) target.micEnabled = false;
        if (target.socketId) {
          io.to(target.socketId).emit("media:mic-permission", { allowed: payload.allowed });
        }
        if (!payload.allowed) {
          io.to(roomChannel(room.roomCode)).emit("media:microphone-state", {
            participantId: target.participantId,
            enabled: false
          });
        }
      })
    );

    socket.on(
      "host:close-room",
      eventHandler(closeRoomPayloadSchema, (payload) => {
        const { room } = requireHost(payload.roomCode);
        closeRoomAndNotify(room, "host-closed");
      })
    );

    // ---- Disconnect ----

    socket.on("disconnect", () => {
      const { roomCode, participantId } = socket.data;
      if (!roomCode || !participantId) return;
      const room = rooms.peekRoom(roomCode);
      if (!room || room.closedAt !== null) return;

      const participant = rooms.markDisconnected(room, participantId);
      if (!participant) return;

      if (participant.role === "host") {
        const graceSeconds = config.hostReconnectGraceSeconds;
        io.to(roomChannel(roomCode)).emit("room:host-disconnected", { graceSeconds });
        emitSystemChat(room, "Host disconnected. Waiting for them to reconnect\u2026");
        const timer = setTimeout(() => {
          hostGraceTimers.delete(roomCode);
          const current = rooms.peekRoom(roomCode);
          if (current && current.closedAt === null && !current.hostConnected) {
            closeRoomAndNotify(current, "host-timeout");
          }
        }, graceSeconds * 1000);
        timer.unref?.();
        hostGraceTimers.set(roomCode, timer);
      } else {
        void presence.removeParticipant(roomCode, participantId);
        io.to(roomChannel(roomCode)).emit("room:participant-left", {
          participantId
        });
        emitSystemChat(room, `${participant.displayName} left the room.`);
        broadcastRoomState(room);
      }
    });
  });

  io.on("close", () => {
    clearInterval(sweeper);
    for (const timer of hostGraceTimers.values()) clearTimeout(timer);
    hostGraceTimers.clear();
  });

  return io;
}
