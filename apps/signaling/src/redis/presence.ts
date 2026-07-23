import { Redis } from "ioredis";
import type { Logger } from "../observability/logger.js";

/**
 * Ephemeral room presence mirror. The in-process RoomService remains
 * authoritative for a room's connections (a room's sockets live on one
 * instance); Redis keeps presence observable across instances and lets the
 * Socket.IO Redis adapter fan out events when scaled horizontally.
 */
export interface PresenceService {
  addParticipant(roomCode: string, participantId: string, ttlSeconds: number): Promise<void>;
  removeParticipant(roomCode: string, participantId: string): Promise<void>;
  removeRoom(roomCode: string): Promise<void>;
  countParticipants(roomCode: string): Promise<number>;
  close(): Promise<void>;
}

export const inMemoryPresence = (): PresenceService => {
  const rooms = new Map<string, Set<string>>();
  return {
    async addParticipant(roomCode, participantId) {
      let set = rooms.get(roomCode);
      if (!set) {
        set = new Set();
        rooms.set(roomCode, set);
      }
      set.add(participantId);
    },
    async removeParticipant(roomCode, participantId) {
      rooms.get(roomCode)?.delete(participantId);
    },
    async removeRoom(roomCode) {
      rooms.delete(roomCode);
    },
    async countParticipants(roomCode) {
      return rooms.get(roomCode)?.size ?? 0;
    },
    async close() {
      rooms.clear();
    }
  };
};

export function createRedisPresence(redisUrl: string, logger: Logger): PresenceService {
  const redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
  redis.on("error", (err) => logger.warn({ err }, "redis presence error"));
  const key = (roomCode: string): string => `watchshare:presence:${roomCode}`;

  const guard = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      logger.warn({ err }, "redis presence operation failed");
    }
  };

  return {
    addParticipant: (roomCode, participantId, ttlSeconds) =>
      guard(async () => {
        await redis.sadd(key(roomCode), participantId);
        await redis.expire(key(roomCode), ttlSeconds);
      }),
    removeParticipant: (roomCode, participantId) =>
      guard(() => redis.srem(key(roomCode), participantId)),
    removeRoom: (roomCode) => guard(() => redis.del(key(roomCode))),
    async countParticipants(roomCode) {
      try {
        return await redis.scard(key(roomCode));
      } catch {
        return 0;
      }
    },
    async close() {
      await redis.quit().catch(() => redis.disconnect());
    }
  };
}
