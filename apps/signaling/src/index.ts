import { loadConfig, loadDotEnv } from "./config.js";
import { buildHttpApp } from "./httpApp.js";
import { createLogger } from "./observability/logger.js";
import { createRedisPresence, inMemoryPresence } from "./redis/presence.js";
import { RoomService } from "./rooms/roomService.js";
import { createIdGenerator, systemClock } from "./security/ids.js";
import { createRateLimiter } from "./security/rateLimiter.js";
import { createTokenService } from "./security/tokens.js";
import { createTurnCredentialProvider } from "./security/turn.js";
import { createGateway } from "./signaling/gateway.js";

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const logger = createLogger(config.nodeEnv);

  const clock = systemClock;
  const ids = createIdGenerator();
  const tokens = createTokenService(config.roomTokenSecret);
  const rateLimiter = createRateLimiter(clock);
  const turn = createTurnCredentialProvider(config, clock);
  const presence = config.redisUrl
    ? createRedisPresence(config.redisUrl, logger)
    : inMemoryPresence();

  const rooms = new RoomService({
    clock,
    ids,
    tokens,
    logger,
    config: {
      roomCodeLength: config.roomCodeLength,
      maxRoomParticipants: config.maxRoomParticipants,
      defaultRoomTtlMinutes: config.defaultRoomTtlMinutes
    }
  });

  let ready = false;
  const app = await buildHttpApp({
    config,
    logger,
    rooms,
    rateLimiter,
    tokens,
    turn,
    isReady: () => ready
  });

  const io = createGateway(app.server, {
    config,
    logger,
    rooms,
    presence,
    rateLimiter,
    turn,
    clock,
    ids
  });

  if (config.redisUrl) {
    // Socket.IO Redis adapter for horizontal fan-out.
    const { createAdapter } = await import("@socket.io/redis-adapter");
    const { Redis } = await import("ioredis");
    const pub = new Redis(config.redisUrl);
    const sub = pub.duplicate();
    pub.on("error", (err) => logger.warn({ err }, "redis pub error"));
    sub.on("error", (err) => logger.warn({ err }, "redis sub error"));
    io.adapter(createAdapter(pub, sub));
  }

  await app.listen({ port: config.port, host: config.host });
  ready = true;
  logger.info(
    {
      port: config.port,
      https: Boolean(config.tls),
      origins: config.allowedOrigins,
      turnConfigured: Boolean(config.turn.url)
    },
    "signaling server listening"
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    ready = false;
    io.close();
    await app.close();
    await presence.close();
    rateLimiter.dispose();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("fatal startup error", err);
  process.exit(1);
});
