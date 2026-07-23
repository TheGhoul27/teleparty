import type { Clock, IdGenerator } from "../src/security/ids.js";
import { createIdGenerator } from "../src/security/ids.js";
import { createTokenService } from "../src/security/tokens.js";
import { RoomService } from "../src/rooms/roomService.js";
import { createLogger } from "../src/observability/logger.js";

export class FakeClock implements Clock {
  private current: number;
  constructor(start = 1_700_000_000_000) {
    this.current = start;
  }
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export const testLogger = createLogger("test");

export function makeRoomService(overrides?: {
  clock?: Clock;
  ids?: IdGenerator;
  maxRoomParticipants?: number;
  defaultRoomTtlMinutes?: number;
}): RoomService {
  return new RoomService({
    clock: overrides?.clock ?? new FakeClock(),
    ids: overrides?.ids ?? createIdGenerator(),
    tokens: createTokenService("test-secret-at-least-16-chars"),
    logger: testLogger,
    config: {
      roomCodeLength: 8,
      maxRoomParticipants: overrides?.maxRoomParticipants ?? 5,
      defaultRoomTtlMinutes: overrides?.defaultRoomTtlMinutes ?? 240
    }
  });
}
