import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const csv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * Loads a .env file into process.env without overriding variables that are
 * already set. Checks the app directory first, then the repo root (npm
 * workspace scripts run with cwd = apps/signaling).
 */
export function loadDotEnv(env: NodeJS.ProcessEnv = process.env): void {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", "..", ".env")
  ];
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) return;

  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default("0.0.0.0"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
  REDIS_URL: z.string().optional().default(""),
  ROOM_TOKEN_SECRET: z
    .string()
    .min(16, "ROOM_TOKEN_SECRET must be at least 16 characters")
    .optional(),
  ROOM_CODE_LENGTH: z.coerce.number().int().min(4).max(16).default(8),
  MAX_ROOM_PARTICIPANTS: z.coerce.number().int().min(2).max(16).default(5),
  DEFAULT_ROOM_TTL_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(240),
  HOST_RECONNECT_GRACE_SECONDS: z.coerce.number().int().min(5).max(600).default(90),
  STUN_URLS: z.string().default("stun:stun.l.google.com:19302"),
  TURN_URL: z.string().optional().default(""),
  TURN_USERNAME: z.string().optional().default(""),
  TURN_CREDENTIAL: z.string().optional().default(""),
  TURN_STATIC_AUTH_SECRET: z.string().optional().default(""),
  TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(60).max(24 * 3600).default(3600),
  // Optional TLS so browsers on other devices can reach the signaling server
  // from an https:// page (mixed content rules block http/ws from https pages).
  TLS_CERT_FILE: z.string().optional().default(""),
  TLS_KEY_FILE: z.string().optional().default("")
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  host: string;
  allowedOrigins: string[];
  redisUrl: string | null;
  roomTokenSecret: string;
  roomCodeLength: number;
  maxRoomParticipants: number;
  defaultRoomTtlMinutes: number;
  hostReconnectGraceSeconds: number;
  stunUrls: string[];
  turn: {
    url: string | null;
    username: string;
    credential: string;
    staticAuthSecret: string | null;
    credentialTtlSeconds: number;
  };
  tls: { certFile: string; keyFile: string } | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const raw = parsed.data;

  let roomTokenSecret = raw.ROOM_TOKEN_SECRET;
  if (!roomTokenSecret) {
    if (raw.NODE_ENV === "production") {
      throw new Error(
        "Invalid environment configuration: ROOM_TOKEN_SECRET is required in production. " +
          "Set it in the environment or a .env file (see .env.example)."
      );
    }
    // Development convenience: generate a per-process secret. Host/reconnect
    // tokens become invalid across restarts, which is fine for local work.
    roomTokenSecret = randomBytes(32).toString("hex");
    console.warn(
      "[watchshare] ROOM_TOKEN_SECRET is not set; generated a temporary secret for this " +
        "process. Reconnect/host tokens will not survive a server restart. " +
        "Copy .env.example to .env to silence this warning."
    );
  }

  return {
    nodeEnv: raw.NODE_ENV,
    port: raw.PORT,
    host: raw.HOST,
    allowedOrigins: csv(raw.ALLOWED_ORIGINS),
    redisUrl: raw.REDIS_URL || null,
    roomTokenSecret,
    roomCodeLength: raw.ROOM_CODE_LENGTH,
    maxRoomParticipants: raw.MAX_ROOM_PARTICIPANTS,
    defaultRoomTtlMinutes: raw.DEFAULT_ROOM_TTL_MINUTES,
    hostReconnectGraceSeconds: raw.HOST_RECONNECT_GRACE_SECONDS,
    stunUrls: csv(raw.STUN_URLS),
    turn: {
      url: raw.TURN_URL || null,
      username: raw.TURN_USERNAME,
      credential: raw.TURN_CREDENTIAL,
      staticAuthSecret: raw.TURN_STATIC_AUTH_SECRET || null,
      credentialTtlSeconds: raw.TURN_CREDENTIAL_TTL_SECONDS
    },
    tls: resolveTls(raw.TLS_CERT_FILE, raw.TLS_KEY_FILE, raw.NODE_ENV)
  };
}

/**
 * Explicit TLS_CERT_FILE/TLS_KEY_FILE always win. In development, when they
 * are unset, fall back to the self-signed pair that `next dev
 * --experimental-https` writes to apps/web/certificates, so `npm run
 * dev:https` gets a TLS signaling server without any configuration.
 */
function resolveTls(
  certFile: string,
  keyFile: string,
  nodeEnv: "development" | "test" | "production"
): { certFile: string; keyFile: string } | null {
  if (certFile && keyFile) return { certFile, keyFile };
  // Auto-detect only in development; tests must stay on plain HTTP regardless
  // of whether a dev certificate happens to exist on the machine.
  if (nodeEnv !== "development") return null;

  // Workspace scripts run with cwd = apps/signaling; also handle repo root.
  const candidates = [
    path.resolve(process.cwd(), "..", "web", "certificates"),
    path.resolve(process.cwd(), "apps", "web", "certificates")
  ];
  for (const dir of candidates) {
    const cert = path.join(dir, "localhost.pem");
    const key = path.join(dir, "localhost-key.pem");
    if (existsSync(cert) && existsSync(key)) {
      console.warn(
        `[watchshare] using the Next.js dev certificate at ${dir} to serve signaling over ` +
          "HTTPS. Set TLS_CERT_FILE/TLS_KEY_FILE to override, or delete the certificates " +
          "folder to serve plain HTTP."
      );
      return { certFile: cert, keyFile: key };
    }
  }
  return null;
}

/**
 * Hostnames that identify devices on the developer's own machine or private
 * network: localhost, loopback, RFC 1918 ranges, and the CGNAT range
 * 100.64.0.0/10 used by VPN meshes such as Tailscale.
 */
const PRIVATE_HOSTNAME_PATTERN =
  /^(localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}|\[::1\])$/;

/**
 * Origin allow-list check for HTTP CORS and WebSocket upgrades.
 *
 * In development, private-network origins (any port, http or https) are
 * accepted in addition to the configured list, so phones and other devices on
 * the same LAN can join rooms without editing ALLOWED_ORIGINS. Production only
 * accepts the explicit list.
 */
export function isOriginAllowed(config: AppConfig, origin: string | undefined): boolean {
  // Non-browser clients (curl, health probes) send no Origin header.
  if (!origin) return true;
  if (config.allowedOrigins.includes(origin)) return true;
  if (config.nodeEnv === "production") return false;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      PRIVATE_HOSTNAME_PATTERN.test(url.hostname)
    );
  } catch {
    return false;
  }
}
