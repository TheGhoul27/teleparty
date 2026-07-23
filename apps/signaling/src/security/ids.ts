import { randomBytes, randomUUID } from "node:crypto";

export interface IdGenerator {
  roomCode(length: number): string;
  participantId(): string;
  messageId(): string;
  token(): string;
}

/** Unambiguous alphabet (no 0/O, 1/I/L) for human-typed room codes. */
const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function createIdGenerator(): IdGenerator {
  return {
    roomCode(length: number): string {
      // Rejection sampling keeps the distribution uniform.
      const out: string[] = [];
      while (out.length < length) {
        const bytes = randomBytes(length * 2);
        for (const byte of bytes) {
          if (out.length >= length) break;
          if (byte < ROOM_CODE_ALPHABET.length * Math.floor(256 / ROOM_CODE_ALPHABET.length)) {
            out.push(ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]!);
          }
        }
      }
      return out.join("");
    },
    participantId: () => `p_${randomUUID()}`,
    messageId: () => `m_${randomUUID()}`,
    token: () => randomBytes(32).toString("base64url")
  };
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
