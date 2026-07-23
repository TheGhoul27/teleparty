import { createHmac, timingSafeEqual } from "node:crypto";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

export interface TokenService {
  /** Deterministic keyed hash for management/reconnect tokens (high entropy inputs). */
  hashToken(token: string): string;
  verifyToken(token: string, storedHash: string): boolean;
  /** Argon2id for low-entropy user passwords. */
  hashPassword(password: string): Promise<string>;
  verifyPassword(password: string, storedHash: string): Promise<boolean>;
}

export function createTokenService(secret: string): TokenService {
  const hashToken = (token: string): string =>
    createHmac("sha256", secret).update(token).digest("hex");

  return {
    hashToken,
    verifyToken(token: string, storedHash: string): boolean {
      const computed = Buffer.from(hashToken(token), "hex");
      const stored = Buffer.from(storedHash, "hex");
      if (computed.length !== stored.length) return false;
      return timingSafeEqual(computed, stored);
    },
    async hashPassword(password: string): Promise<string> {
      return argon2Hash(password, {
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1
      });
    },
    async verifyPassword(password: string, storedHash: string): Promise<boolean> {
      try {
        return await argon2Verify(storedHash, password);
      } catch {
        return false;
      }
    }
  };
}
