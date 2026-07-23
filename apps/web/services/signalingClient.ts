import { io, type Socket } from "socket.io-client";
import type {
  AckResult,
  ClientToServerEvents,
  ServerToClientEvents
} from "@watchshare/shared";
import { appError } from "@watchshare/shared";

export type SignalingSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: SignalingSocket | null = null;

export function getSignalingUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SIGNALING_URL;
  if (explicit) return explicit;
  // Default: signaling lives on the same host as the page, port 4000. This
  // makes LAN testing (phone -> http://<pc-ip>:3000) work without env vars.
  if (typeof window !== "undefined") {
    const { protocol, hostname } = window.location;
    return `${protocol}//${hostname}:4000`;
  }
  return "http://localhost:4000";
}

/** Singleton socket, created lazily on the client. */
export function getSocket(): SignalingSocket {
  if (!socket) {
    socket = io(getSignalingUrl(), {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 8000,
      autoConnect: true
    });
  }
  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}

const ACK_TIMEOUT_MS = 10_000;

/**
 * Emits an event that expects an acknowledgement, with a timeout so UI code
 * never hangs on a dead connection.
 */
export function emitWithAck<T>(
  event: "room:create" | "room:join" | "chat:send",
  payload: unknown
): Promise<AckResult<T>> {
  const sock = getSocket();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ ok: false, error: appError("SIGNALING_DISCONNECTED") });
    }, ACK_TIMEOUT_MS);
    // Socket.IO's typed emit does not compose well with a generic event name;
    // payload validity is enforced by the server with zod regardless.
    (sock as Socket).emit(event, payload, (result: AckResult<T>) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}
