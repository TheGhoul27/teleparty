export const APP_ERROR_CODES = [
  "ROOM_NOT_FOUND",
  "ROOM_EXPIRED",
  "ROOM_FULL",
  "ROOM_CLOSED",
  "INVALID_PASSWORD",
  "HOST_AUTH_FAILED",
  "NOT_AUTHORIZED",
  "WAITING_REJECTED",
  "RATE_LIMITED",
  "VALIDATION_FAILED",
  "CAPTURE_UNSUPPORTED",
  "CAPTURE_CANCELLED",
  "CAPTURE_DENIED",
  "CAPTURE_NO_VIDEO",
  "CAPTURE_NO_AUDIO",
  "WEBRTC_NEGOTIATION_FAILED",
  "ICE_FAILED",
  "TURN_UNAVAILABLE",
  "SIGNALING_DISCONNECTED",
  "AUTOPLAY_BLOCKED",
  "PROTECTED_CONTENT_SUSPECTED",
  "UNKNOWN"
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export interface AppError {
  code: AppErrorCode;
  /** Safe, human readable message. Never contains secrets or internals. */
  message: string;
}

/**
 * User-facing copy for every error code. Kept in the shared package so the
 * frontend and backend show consistent wording.
 */
export const ERROR_MESSAGES: Record<AppErrorCode, string> = {
  ROOM_NOT_FOUND: "That room could not be found. Check the code and try again.",
  ROOM_EXPIRED: "This room has expired.",
  ROOM_FULL: "This room is full.",
  ROOM_CLOSED: "This room has been closed by the host.",
  INVALID_PASSWORD: "Unable to join the room. Check your details and try again.",
  HOST_AUTH_FAILED: "Unable to verify host permissions for this room.",
  NOT_AUTHORIZED: "You are not allowed to perform that action.",
  WAITING_REJECTED: "The host did not admit you to this room.",
  RATE_LIMITED: "You are doing that too often. Please wait a moment.",
  VALIDATION_FAILED: "The request was not valid.",
  CAPTURE_UNSUPPORTED:
    "This browser does not support tab capture. Try a current desktop Chromium browser.",
  CAPTURE_CANCELLED: "Sharing was cancelled.",
  CAPTURE_DENIED:
    "Screen sharing permission was denied. Allow screen sharing in your browser settings and try again.",
  CAPTURE_NO_VIDEO: "The browser did not provide a video track for the selected source.",
  CAPTURE_NO_AUDIO:
    "No audio track was captured. Stop sharing, pick a browser tab, and enable \u201cShare tab audio\u201d.",
  WEBRTC_NEGOTIATION_FAILED: "Media connection setup failed. Try reconnecting.",
  ICE_FAILED: "The media connection failed. Check your network and try reconnecting.",
  TURN_UNAVAILABLE: "No relay server is available; the connection may fail on restrictive networks.",
  SIGNALING_DISCONNECTED: "Lost connection to the room server. Reconnecting\u2026",
  AUTOPLAY_BLOCKED: "Your browser blocked automatic audio. Click to hear audio.",
  PROTECTED_CONTENT_SUSPECTED:
    "This content may be protected and might not support browser capture. WatchShare does not bypass content protection.",
  UNKNOWN: "Something went wrong. Please try again."
};

export function appError(code: AppErrorCode, message?: string): AppError {
  return { code, message: message ?? ERROR_MESSAGES[code] };
}

/** Discriminated acknowledgement result used by socket callbacks. */
export type AckResult<T> = { ok: true; data: T } | { ok: false; error: AppError };

export type Ack<T> = (result: AckResult<T>) => void;
