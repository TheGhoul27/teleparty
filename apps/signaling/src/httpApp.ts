import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import {
  appError,
  createRoomPayloadSchema,
  roomCodeSchema,
  roomPasswordSchema
} from "@watchshare/shared";
import { readFileSync } from "node:fs";
import { isOriginAllowed, type AppConfig } from "./config.js";
import type { Logger } from "./observability/logger.js";
import { AppErrorException, type RoomService } from "./rooms/roomService.js";
import { activeParticipantCount } from "./rooms/roomTypes.js";
import { RATE_LIMIT_RULES, type RateLimiter } from "./security/rateLimiter.js";
import type { TokenService } from "./security/tokens.js";
import type { TurnCredentialProvider } from "./security/turn.js";

export interface HttpAppDeps {
  config: AppConfig;
  logger: Logger;
  rooms: RoomService;
  rateLimiter: RateLimiter;
  tokens: TokenService;
  turn: TurnCredentialProvider;
  isReady: () => boolean;
}

export async function buildHttpApp(deps: HttpAppDeps): Promise<FastifyInstance> {
  const { config, rooms, rateLimiter, tokens, turn, isReady } = deps;

  const app = Fastify({
    // Fastify's own logger is disabled; we log through the shared pino logger.
    logger: false,
    bodyLimit: 32 * 1024,
    ...(config.tls
      ? {
          https: {
            cert: readFileSync(config.tls.certFile),
            key: readFileSync(config.tls.keyFile)
          }
        }
      : {})
  });

  await app.register(cors, {
    origin: (origin, callback) => callback(null, isOriginAllowed(config, origin)),
    methods: ["GET", "POST"],
    credentials: false
  });

  const sendAppError = (reply: { code: (c: number) => { send: (b: unknown) => unknown } }, err: unknown): void => {
    if (err instanceof AppErrorException) {
      const status =
        err.appError.code === "ROOM_NOT_FOUND"
          ? 404
          : err.appError.code === "RATE_LIMITED"
            ? 429
            : err.appError.code === "VALIDATION_FAILED"
              ? 400
              : 403;
      reply.code(status).send({ ok: false, error: err.appError });
      return;
    }
    deps.logger.error({ err }, "unexpected http error");
    reply.code(500).send({ ok: false, error: appError("UNKNOWN") });
  };

  app.get("/health", async () => ({ status: "ok", uptimeSeconds: Math.floor(process.uptime()) }));

  app.get("/ready", async (_req, reply) => {
    if (isReady()) return { status: "ready" };
    return reply.code(503).send({ status: "not-ready" });
  });

  app.get("/api/rooms/:roomCode/status", async (req, reply) => {
    try {
      const params = z.object({ roomCode: roomCodeSchema }).parse(req.params);
      const room = rooms.getOpenRoom(params.roomCode);
      return {
        ok: true,
        data: {
          roomCode: room.roomCode,
          open: true,
          hasPassword: room.passwordHash !== null,
          waitingRoomEnabled: room.settings.waitingRoomEnabled,
          participantCount: activeParticipantCount(room),
          maxParticipants: room.settings.maxParticipants,
          sharingMode: room.sharing.mode,
          hostConnected: room.hostConnected,
          expiresAt: room.expiresAt
        }
      };
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ ok: false, error: appError("VALIDATION_FAILED") });
      }
      return sendAppError(reply, err);
    }
  });

  app.post("/api/rooms", async (req, reply) => {
    if (!rateLimiter.consume(`create:${req.ip}`, RATE_LIMIT_RULES.roomCreatePerIp)) {
      return reply.code(429).send({ ok: false, error: appError("RATE_LIMITED") });
    }
    const parsed = createRoomPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: appError("VALIDATION_FAILED") });
    }
    try {
      // Room created without a live socket; the host claims it over the
      // WebSocket connection using the returned management token.
      const outcome = await rooms.createRoom(parsed.data, null);
      return {
        ok: true,
        data: {
          roomCode: outcome.room.roomCode,
          hostToken: outcome.hostToken,
          expiresAt: outcome.room.expiresAt
        }
      };
    } catch (err) {
      return sendAppError(reply, err);
    }
  });

  app.post("/api/rooms/:roomCode/join", async (req, reply) => {
    if (!rateLimiter.consume(`join:${req.ip}`, RATE_LIMIT_RULES.joinAttemptPerIp)) {
      return reply.code(429).send({ ok: false, error: appError("RATE_LIMITED") });
    }
    try {
      const params = z.object({ roomCode: roomCodeSchema }).parse(req.params);
      const body = z
        .object({ password: roomPasswordSchema.optional() })
        .parse(req.body ?? {});
      const room = rooms.getOpenRoom(params.roomCode);

      if (room.passwordHash) {
        if (!rateLimiter.consume(`pw:${room.roomCode}`, RATE_LIMIT_RULES.passwordAttemptPerRoom)) {
          return reply.code(429).send({ ok: false, error: appError("RATE_LIMITED") });
        }
        // Preflight check only; the socket join re-verifies.
        const ok = body.password
          ? await tokens.verifyPassword(body.password, room.passwordHash)
          : false;
        if (!ok) {
          return reply.code(403).send({ ok: false, error: appError("INVALID_PASSWORD") });
        }
      }
      if (activeParticipantCount(room) >= room.settings.maxParticipants) {
        return reply.code(403).send({ ok: false, error: appError("ROOM_FULL") });
      }
      return { ok: true, data: { roomCode: room.roomCode, canJoin: true } };
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ ok: false, error: appError("VALIDATION_FAILED") });
      }
      return sendAppError(reply, err);
    }
  });

  app.post("/api/rooms/:roomCode/close", async (req, reply) => {
    try {
      const params = z.object({ roomCode: roomCodeSchema }).parse(req.params);
      const body = z.object({ hostToken: z.string().min(1).max(512) }).parse(req.body ?? {});
      const room = rooms.getOpenRoom(params.roomCode);
      if (!rooms.verifyHostToken(room, body.hostToken)) {
        return reply.code(403).send({ ok: false, error: appError("HOST_AUTH_FAILED") });
      }
      rooms.closeRoom(room, "host-closed");
      return { ok: true, data: { closed: true } };
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ ok: false, error: appError("VALIDATION_FAILED") });
      }
      return sendAppError(reply, err);
    }
  });

  app.post("/api/turn-credentials", async (req, reply) => {
    if (!rateLimiter.consume(`turn:${req.ip}`, RATE_LIMIT_RULES.joinAttemptPerIp)) {
      return reply.code(429).send({ ok: false, error: appError("RATE_LIMITED") });
    }
    const credentials = turn.getCredentials();
    if (credentials.iceServers.length === 0) {
      return reply.code(503).send({ ok: false, error: appError("TURN_UNAVAILABLE") });
    }
    return { ok: true, data: credentials };
  });

  return app;
}
