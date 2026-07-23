/**
 * Per-tab credential storage. Session storage (not local storage) so tokens
 * die with the tab and are never shared across origins or sessions.
 */
export interface RoomCredentials {
  roomCode: string;
  participantId: string;
  reconnectToken: string;
  hostToken?: string;
  displayName: string;
}

const key = (roomCode: string): string => `watchshare:room:${roomCode.toUpperCase()}`;

export function saveRoomCredentials(creds: RoomCredentials): void {
  try {
    sessionStorage.setItem(key(creds.roomCode), JSON.stringify(creds));
  } catch {
    // Storage unavailable (private mode quota etc.); reconnect will re-prompt.
  }
}

export function loadRoomCredentials(roomCode: string): RoomCredentials | null {
  try {
    const raw = sessionStorage.getItem(key(roomCode));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as RoomCredentials).roomCode === "string" &&
      typeof (parsed as RoomCredentials).reconnectToken === "string"
    ) {
      return parsed as RoomCredentials;
    }
    return null;
  } catch {
    return null;
  }
}

export function updateRoomCredentials(
  roomCode: string,
  patch: Partial<RoomCredentials>
): void {
  const existing = loadRoomCredentials(roomCode);
  if (!existing) return;
  saveRoomCredentials({ ...existing, ...patch });
}

export function clearRoomCredentials(roomCode: string): void {
  try {
    sessionStorage.removeItem(key(roomCode));
  } catch {
    // ignore
  }
}
