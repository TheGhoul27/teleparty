import { createHmac } from "node:crypto";
import type { TurnCredentials, IceServerConfig } from "@watchshare/shared";
import type { AppConfig } from "../config.js";
import type { Clock } from "./ids.js";

export interface TurnCredentialProvider {
  getCredentials(): TurnCredentials;
}

/**
 * Issues ICE configuration for clients.
 *
 * - Always includes configured STUN servers.
 * - When TURN_STATIC_AUTH_SECRET is set, mints short-lived credentials that
 *   coturn validates in `use-auth-secret` mode (username = expiry timestamp,
 *   credential = HMAC-SHA1 of the username with the shared secret).
 * - Otherwise falls back to static TURN credentials from the environment.
 */
export function createTurnCredentialProvider(
  config: AppConfig,
  clock: Clock
): TurnCredentialProvider {
  return {
    getCredentials(): TurnCredentials {
      const iceServers: IceServerConfig[] = [];
      if (config.stunUrls.length > 0) {
        iceServers.push({ urls: config.stunUrls });
      }

      if (config.turn.url) {
        const turnUrls = config.turn.url.split(",").map((u) => u.trim()).filter(Boolean);
        if (config.turn.staticAuthSecret) {
          const expiresAtSeconds =
            Math.floor(clock.now() / 1000) + config.turn.credentialTtlSeconds;
          const username = `${expiresAtSeconds}:watchshare`;
          const credential = createHmac("sha1", config.turn.staticAuthSecret)
            .update(username)
            .digest("base64");
          iceServers.push({ urls: turnUrls, username, credential });
          return { iceServers, expiresAt: expiresAtSeconds * 1000 };
        }
        if (config.turn.username && config.turn.credential) {
          iceServers.push({
            urls: turnUrls,
            username: config.turn.username,
            credential: config.turn.credential
          });
        }
      }

      return { iceServers, expiresAt: null };
    }
  };
}
