import type {
  Participant,
  ParticipantRole,
  ParticipantStatus,
  RoomSettings,
  RoomState,
  SharingState
} from "@watchshare/shared";

export interface ParticipantRecord {
  participantId: string;
  displayName: string;
  role: ParticipantRole;
  status: ParticipantStatus;
  micEnabled: boolean;
  micAllowed: boolean;
  joinedAt: number;
  leftAt: number | null;
  kickedAt: number | null;
  reconnectTokenHash: string;
  /** Current socket id, null while disconnected. */
  socketId: string | null;
}

export interface RoomRecord {
  roomCode: string;
  createdAt: number;
  expiresAt: number;
  closedAt: number | null;
  closeReason: "host-closed" | "expired" | "host-timeout" | null;
  hostTokenHash: string;
  passwordHash: string | null;
  settings: {
    maxParticipants: number;
    waitingRoomEnabled: boolean;
    allowMicrophones: boolean;
    allowChat: boolean;
  };
  participants: Map<string, ParticipantRecord>;
  hostParticipantId: string | null;
  hostConnected: boolean;
  sharing: SharingState;
  /** Recent message fingerprints per participant for duplicate suppression. */
  recentChatFingerprints: Map<string, { fingerprint: string; at: number }>;
}

export function toPublicParticipant(record: ParticipantRecord): Participant {
  return {
    participantId: record.participantId,
    displayName: record.displayName,
    role: record.role,
    status: record.status,
    micEnabled: record.micEnabled,
    joinedAt: record.joinedAt
  };
}

export function toPublicRoomState(room: RoomRecord): RoomState {
  const settings: RoomSettings = {
    maxParticipants: room.settings.maxParticipants,
    hasPassword: room.passwordHash !== null,
    waitingRoomEnabled: room.settings.waitingRoomEnabled,
    allowMicrophones: room.settings.allowMicrophones,
    allowChat: room.settings.allowChat,
    expiresAt: room.expiresAt
  };
  return {
    roomCode: room.roomCode,
    createdAt: room.createdAt,
    settings,
    participants: [...room.participants.values()]
      .filter((p): boolean => p.status === "joined" || p.status === "waiting")
      .map(toPublicParticipant),
    hostParticipantId: room.hostParticipantId,
    hostConnected: room.hostConnected,
    sharing: room.sharing,
    closed: room.closedAt !== null
  };
}

export function activeParticipantCount(room: RoomRecord): number {
  let count = 0;
  for (const p of room.participants.values()) {
    if (p.status === "joined") count += 1;
  }
  return count;
}

export type JoinOutcome =
  | { kind: "joined"; participant: ParticipantRecord; reconnectToken: string; isHost: boolean }
  | { kind: "waiting"; participant: ParticipantRecord; reconnectToken: string }
  | { kind: "rejoined"; participant: ParticipantRecord; reconnectToken: string; isHost: boolean };

export type ParticipantStatusUpdate = ParticipantStatus;
