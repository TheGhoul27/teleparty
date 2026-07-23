export type ParticipantRole = "host" | "viewer";

export type ParticipantStatus = "waiting" | "joined" | "left" | "kicked";

export interface Participant {
  /** Server-assigned pseudonymous id. Never chosen by the client. */
  participantId: string;
  displayName: string;
  role: ParticipantRole;
  status: ParticipantStatus;
  micEnabled: boolean;
  joinedAt: number;
}

export interface RoomSettings {
  maxParticipants: number;
  hasPassword: boolean;
  waitingRoomEnabled: boolean;
  allowMicrophones: boolean;
  allowChat: boolean;
  /** Epoch ms after which the room is expired. */
  expiresAt: number;
}

export type SharingMode = "none" | "video-only" | "video-and-audio";

export interface SharingState {
  mode: SharingMode;
  /** True when the shared surface looked like a browser tab. */
  surfaceIsBrowserTab: boolean | null;
  startedAt: number | null;
}

export interface RoomState {
  roomCode: string;
  createdAt: number;
  settings: RoomSettings;
  participants: Participant[];
  /** participantId of the current host, null while host is disconnected. */
  hostParticipantId: string | null;
  hostConnected: boolean;
  sharing: SharingState;
  closed: boolean;
}

export interface ChatMessage {
  messageId: string;
  roomCode: string;
  participantId: string;
  displayName: string;
  /** Plain text only; clients must never render as HTML. */
  body: string;
  sentAt: number;
  kind: "user" | "system";
}

export type CaptureState =
  | "idle"
  | "requesting"
  | "active-with-audio"
  | "active-video-only"
  | "stopped"
  | "denied"
  | "unsupported"
  | "error";

export type ConnectionQuality = "excellent" | "good" | "unstable" | "poor" | "unknown";

export type PeerConnectionStatus =
  | "new"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "relayed"
  | "failed"
  | "disconnected"
  | "closed";

export interface ConnectionStatsSnapshot {
  timestamp: number;
  roundTripTimeMs: number | null;
  packetLossPercent: number | null;
  availableOutgoingBitrateKbps: number | null;
  framesPerSecond: number | null;
  frameWidth: number | null;
  frameHeight: number | null;
  framesDropped: number | null;
  audioJitterMs: number | null;
  usingTurnRelay: boolean;
  quality: ConnectionQuality;
}

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface TurnCredentials {
  iceServers: IceServerConfig[];
  /** Epoch ms when the credentials stop working, null for static credentials. */
  expiresAt: number | null;
}

export const LIMITS = {
  displayNameMax: 32,
  roomCodeMin: 4,
  roomCodeMax: 16,
  passwordMax: 128,
  chatMessageMax: 500,
  sdpMaxBytes: 128 * 1024,
  iceCandidateMaxBytes: 2048,
  maxParticipantsCeiling: 16
} as const;
