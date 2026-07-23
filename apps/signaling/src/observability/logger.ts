import { pino, type Logger } from "pino";

export type { Logger };

/**
 * Structured logger. Redacts every field that could carry secrets or media
 * negotiation payloads: passwords, tokens, SDP bodies and chat contents must
 * never reach the log stream.
 */
export function createLogger(nodeEnv: string): Logger {
  return pino({
    level: nodeEnv === "test" ? "silent" : nodeEnv === "production" ? "info" : "debug",
    redact: {
      paths: [
        "password",
        "*.password",
        "hostToken",
        "*.hostToken",
        "reconnectToken",
        "*.reconnectToken",
        "sdp",
        "*.sdp",
        "description",
        "*.description",
        "candidate",
        "*.candidate",
        "body",
        "*.body",
        "credential",
        "*.credential"
      ],
      censor: "[redacted]"
    },
    transport:
      nodeEnv === "development"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined
  });
}
