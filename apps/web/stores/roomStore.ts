"use client";

import { create } from "zustand";
import type {
  AppError,
  ChatMessage,
  ConnectionStatsSnapshot,
  CreateRoomResult,
  JoinRoomResult,
  Participant,
  PeerConnectionStatus,
  RoomState,
  SharingState
} from "@watchshare/shared";
import { appError } from "@watchshare/shared";
import {
  clearRoomCredentials,
  loadRoomCredentials,
  saveRoomCredentials,
  updateRoomCredentials
} from "@/lib/session";
import { emitWithAck, getSocket } from "@/services/signalingClient";
import {
  PeerConnectionManager,
  type SignalingAdapter
} from "@/services/webrtc/peerConnectionManager";

export type JoinStatus =
  | "idle"
  | "joining"
  | "waiting"
  | "joined"
  | "rejected"
  | "kicked"
  | "closed"
  | "error";

export type SignalingStatus = "connecting" | "connected" | "disconnected";

interface RemoteAudio {
  participantId: string;
  stream: MediaStream;
}

export interface RoomStoreState {
  signalingStatus: SignalingStatus;
  joinStatus: JoinStatus;
  joinError: AppError | null;
  closeReason: "host-closed" | "expired" | "host-timeout" | null;

  roomCode: string | null;
  selfParticipantId: string | null;
  isHost: boolean;
  room: RoomState | null;
  hostDisconnected: boolean;
  hostGraceSeconds: number;

  messages: ChatMessage[];
  waitingParticipants: Participant[];

  /** Viewer: the host's shared tab (video + tab audio). */
  remoteDisplayStream: MediaStream | null;
  /** Voice chat streams keyed by the speaking participant's id. */
  remoteMicStreams: RemoteAudio[];
  peerStatuses: Record<string, PeerConnectionStatus>;
  peerStats: Record<string, ConnectionStatsSnapshot>;
  fatalPeerFailure: boolean;

  micEnabled: boolean;
  micAllowed: boolean;
  micError: AppError | null;

  localSharing: SharingState;

  // Actions
  connect: () => void;
  createRoom: (
    displayName: string,
    settings?: {
      maxParticipants?: number;
      password?: string;
      waitingRoomEnabled?: boolean;
      allowMicrophones?: boolean;
      allowChat?: boolean;
      ttlMinutes?: number;
    }
  ) => Promise<{ ok: true; roomCode: string } | { ok: false; error: AppError }>;
  joinRoom: (
    roomCode: string,
    displayName: string,
    password?: string
  ) => Promise<{ ok: boolean; error?: AppError }>;
  leaveRoom: () => void;
  closeRoom: () => void;
  approveParticipant: (participantId: string) => void;
  rejectParticipant: (participantId: string) => void;
  kickParticipant: (participantId: string) => void;
  setMicPermission: (participantId: string, allowed: boolean) => void;
  sendChat: (body: string) => Promise<AppError | null>;
  deleteChat: (messageId: string) => void;
  startSharing: (
    videoTrack: MediaStreamTrack,
    audioTrack: MediaStreamTrack | null,
    surfaceIsBrowserTab: boolean | null
  ) => Promise<void>;
  stopSharing: () => Promise<void>;
  setMicrophoneTrack: (track: MediaStreamTrack | null) => Promise<void>;
  reconnectPeers: () => void;
  reset: () => void;
}

const MAX_CHAT_MESSAGES = 200;

/** Module-scoped mutable refs that must not trigger React renders. */
const refs: {
  pcm: PeerConnectionManager | null;
  iceServers: RTCIceServer[];
  listenersBound: boolean;
  micTrack: MediaStreamTrack | null;
} = {
  pcm: null,
  iceServers: [],
  listenersBound: false,
  micTrack: null
};

function toRtcIceServers(config: { iceServers: { urls: string[]; username?: string; credential?: string }[] }): RTCIceServer[] {
  return config.iceServers.map((server) => ({
    urls: server.urls,
    ...(server.username ? { username: server.username } : {}),
    ...(server.credential ? { credential: server.credential } : {})
  }));
}

function createSignalingAdapter(roomCode: string): SignalingAdapter {
  const socket = getSocket();
  return {
    sendOffer(targetParticipantId, description) {
      socket.emit("webrtc:offer", {
        roomCode,
        targetParticipantId,
        description: { type: "offer", sdp: description.sdp ?? "" }
      });
    },
    sendAnswer(targetParticipantId, description) {
      socket.emit("webrtc:answer", {
        roomCode,
        targetParticipantId,
        description: { type: "answer", sdp: description.sdp ?? "" }
      });
    },
    sendIceCandidate(targetParticipantId, candidate) {
      socket.emit("webrtc:ice-candidate", {
        roomCode,
        targetParticipantId,
        candidate: candidate
          ? {
              candidate: candidate.candidate ?? "",
              sdpMid: candidate.sdpMid ?? null,
              sdpMLineIndex: candidate.sdpMLineIndex ?? null,
              usernameFragment: candidate.usernameFragment ?? null
            }
          : null
      });
    },
    sendRestartRequest(targetParticipantId) {
      socket.emit("webrtc:restart-request", { roomCode, targetParticipantId });
    }
  };
}

export const useRoomStore = create<RoomStoreState>((set, get) => {
  function buildPeerManager(roomCode: string, role: "host" | "viewer"): PeerConnectionManager {
    refs.pcm?.dispose();
    const pcm = new PeerConnectionManager({
      role,
      iceServers: refs.iceServers,
      signaling: createSignalingAdapter(roomCode),
      onRemoteTrack: ({ participantId, track, stream, source }) => {
        if (source === "display") {
          set((state) => {
            const existing = state.remoteDisplayStream;
            if (existing && existing.id === stream.id) {
              // Track added to the stream object we already hold; re-set to
              // trigger subscribers.
              return { remoteDisplayStream: existing };
            }
            return { remoteDisplayStream: stream };
          });
        } else {
          // Microphone audio. Forwarded streams carry ids like
          // "watchshare-mic:<participantId>"; direct ones use the sender's id.
          const separatorIndex = stream.id.indexOf(":");
          const speakerId =
            separatorIndex >= 0 ? stream.id.slice(separatorIndex + 1) : participantId;
          set((state) => {
            const others = state.remoteMicStreams.filter((r) => r.participantId !== speakerId);
            return { remoteMicStreams: [...others, { participantId: speakerId, stream }] };
          });
          track.addEventListener("ended", () => {
            set((state) => ({
              remoteMicStreams: state.remoteMicStreams.filter(
                (r) => r.participantId !== speakerId
              )
            }));
          });
        }
      },
      onStatus: (participantId, status) => {
        set((state) => ({
          peerStatuses: { ...state.peerStatuses, [participantId]: status }
        }));
      },
      onStats: (participantId, snapshot) => {
        set((state) => ({
          peerStats: { ...state.peerStats, [participantId]: snapshot },
          peerStatuses:
            snapshot.usingTurnRelay && state.peerStatuses[participantId] === "connected"
              ? { ...state.peerStatuses, [participantId]: "relayed" }
              : state.peerStatuses
        }));
      },
      onFatalFailure: () => {
        set({ fatalPeerFailure: true });
      }
    });
    refs.pcm = pcm;
    return pcm;
  }

  function bindSocketListeners(): void {
    if (refs.listenersBound) return;
    refs.listenersBound = true;
    const socket = getSocket();

    socket.on("connect", () => set({ signalingStatus: "connected" }));
    socket.on("disconnect", () => set({ signalingStatus: "disconnected" }));
    socket.io.on("reconnect_attempt", () => set({ signalingStatus: "connecting" }));

    // Re-join transparently after a signaling reconnect.
    socket.io.on("reconnect", () => {
      const { roomCode, joinStatus } = get();
      if (!roomCode || (joinStatus !== "joined" && joinStatus !== "waiting")) return;
      const creds = loadRoomCredentials(roomCode);
      if (!creds) return;
      void emitWithAck<JoinRoomResult>("room:join", {
        roomCode,
        displayName: creds.displayName,
        reconnectToken: creds.reconnectToken,
        ...(creds.hostToken ? { hostToken: creds.hostToken } : {})
      }).then((result) => {
        if (result.ok && result.data.status === "joined") {
          updateRoomCredentials(roomCode, {
            reconnectToken: result.data.reconnectToken,
            participantId: result.data.participantId
          });
          set({
            joinStatus: "joined",
            room: result.data.room,
            selfParticipantId: result.data.participantId
          });
        }
      });
    });

    socket.on("room:state", (room) => {
      const { roomCode, selfParticipantId, isHost } = get();
      if (!roomCode || room.roomCode !== roomCode) return;
      set({
        room,
        waitingParticipants: room.participants.filter((p) => p.status === "waiting")
      });
      // Host: ensure a peer connection exists for every joined viewer.
      if (isHost && refs.pcm) {
        for (const participant of room.participants) {
          if (
            participant.participantId !== selfParticipantId &&
            participant.status === "joined" &&
            !refs.pcm.hasPeer(participant.participantId)
          ) {
            refs.pcm.addPeer(participant.participantId);
          }
        }
        for (const peerId of refs.pcm.peerIds()) {
          const still = room.participants.some(
            (p) => p.participantId === peerId && p.status === "joined"
          );
          if (!still) refs.pcm.removePeer(peerId);
        }
      }
    });

    socket.on("room:participant-waiting", (participant) => {
      set((state) => ({
        waitingParticipants: [
          ...state.waitingParticipants.filter(
            (p) => p.participantId !== participant.participantId
          ),
          participant
        ]
      }));
    });

    socket.on("room:participant-left", ({ participantId }) => {
      refs.pcm?.removePeer(participantId);
      set((state) => {
        const statuses = { ...state.peerStatuses };
        delete statuses[participantId];
        return {
          peerStatuses: statuses,
          remoteMicStreams: state.remoteMicStreams.filter(
            (r) => r.participantId !== participantId
          )
        };
      });
    });

    socket.on("room:participant-kicked", ({ participantId }) => {
      refs.pcm?.removePeer(participantId);
    });

    socket.on("room:you-were-approved", (result) => {
      const { roomCode } = get();
      if (!roomCode) return;
      set({
        joinStatus: "joined",
        room: result.room,
        selfParticipantId: result.participantId,
        isHost: false
      });
      refs.iceServers = toRtcIceServers(result.iceConfig);
      const pcm = buildPeerManager(roomCode, "viewer");
      if (result.room.hostParticipantId) {
        pcm.addPeer(result.room.hostParticipantId);
      }
    });

    socket.on("room:you-were-rejected", () => {
      set({ joinStatus: "rejected", joinError: appError("WAITING_REJECTED") });
    });

    socket.on("room:you-were-kicked", (error) => {
      refs.pcm?.dispose();
      refs.pcm = null;
      const { roomCode } = get();
      if (roomCode) clearRoomCredentials(roomCode);
      set({ joinStatus: "kicked", joinError: error, remoteDisplayStream: null });
    });

    socket.on("room:host-disconnected", ({ graceSeconds }) => {
      set({ hostDisconnected: true, hostGraceSeconds: graceSeconds });
    });

    socket.on("room:host-reconnected", () => {
      set({ hostDisconnected: false });
      // If the media path died with the host's old session, rebuild it.
      const { room, isHost } = get();
      if (isHost || !room?.hostParticipantId || !refs.pcm) return;
      const status = get().peerStatuses[room.hostParticipantId];
      if (status !== "connected" && status !== "relayed") {
        refs.pcm.removePeer(room.hostParticipantId);
        refs.pcm.addPeer(room.hostParticipantId);
      }
    });

    socket.on("room:closed", ({ reason }) => {
      refs.pcm?.dispose();
      refs.pcm = null;
      const { roomCode } = get();
      if (roomCode) clearRoomCredentials(roomCode);
      set({
        joinStatus: "closed",
        closeReason: reason,
        remoteDisplayStream: null,
        remoteMicStreams: []
      });
    });

    socket.on("media:share-state", (sharing) => {
      set((state) => ({
        room: state.room ? { ...state.room, sharing } : state.room,
        remoteDisplayStream: sharing.mode === "none" ? null : state.remoteDisplayStream
      }));
    });

    socket.on("media:microphone-state", ({ participantId, enabled }) => {
      set((state) => ({
        room: state.room
          ? {
              ...state.room,
              participants: state.room.participants.map((p) =>
                p.participantId === participantId ? { ...p, micEnabled: enabled } : p
              )
            }
          : state.room,
        remoteMicStreams: enabled
          ? state.remoteMicStreams
          : state.remoteMicStreams.filter((r) => r.participantId !== participantId)
      }));
    });

    socket.on("media:mic-permission", ({ allowed }) => {
      set({ micAllowed: allowed });
      if (!allowed) {
        refs.micTrack?.stop();
        refs.micTrack = null;
        void refs.pcm?.setMicrophoneTrack(null);
        set({ micEnabled: false });
      }
    });

    socket.on("webrtc:offer", ({ fromParticipantId, description }) => {
      if (refs.pcm && !refs.pcm.hasPeer(fromParticipantId)) {
        // Offer from a peer we have not registered yet (late joiner race).
        refs.pcm.addPeer(fromParticipantId);
      }
      void refs.pcm?.handleOffer(fromParticipantId, description);
    });

    socket.on("webrtc:answer", ({ fromParticipantId, description }) => {
      void refs.pcm?.handleAnswer(fromParticipantId, description);
    });

    socket.on("webrtc:ice-candidate", ({ fromParticipantId, candidate }) => {
      void refs.pcm?.handleIceCandidate(fromParticipantId, candidate);
    });

    socket.on("webrtc:restart-request", ({ fromParticipantId }) => {
      refs.pcm?.handleRestartRequest(fromParticipantId);
    });

    socket.on("chat:message", (message) => {
      set((state) => ({
        messages: [...state.messages, message].slice(-MAX_CHAT_MESSAGES)
      }));
    });

    socket.on("chat:deleted", ({ messageId }) => {
      set((state) => ({
        messages: state.messages.filter((m) => m.messageId !== messageId)
      }));
    });

    socket.on("system:rate-limit-warning", () => {
      // Non-fatal; surfaced through chat UI as needed.
    });
  }

  return {
    signalingStatus: "connecting",
    joinStatus: "idle",
    joinError: null,
    closeReason: null,
    roomCode: null,
    selfParticipantId: null,
    isHost: false,
    room: null,
    hostDisconnected: false,
    hostGraceSeconds: 0,
    messages: [],
    waitingParticipants: [],
    remoteDisplayStream: null,
    remoteMicStreams: [],
    peerStatuses: {},
    peerStats: {},
    fatalPeerFailure: false,
    micEnabled: false,
    micAllowed: true,
    micError: null,
    localSharing: { mode: "none", surfaceIsBrowserTab: null, startedAt: null },

    connect() {
      bindSocketListeners();
      const socket = getSocket();
      if (socket.connected) set({ signalingStatus: "connected" });
    },

    async createRoom(displayName, settings) {
      bindSocketListeners();
      const result = await emitWithAck<CreateRoomResult>("room:create", {
        displayName,
        ...(settings ? { settings } : {})
      });
      if (!result.ok) return { ok: false, error: result.error };

      const data = result.data;
      refs.iceServers = toRtcIceServers(data.iceConfig);
      saveRoomCredentials({
        roomCode: data.roomCode,
        participantId: data.participantId,
        reconnectToken: data.reconnectToken,
        hostToken: data.hostToken,
        displayName
      });
      set({
        roomCode: data.roomCode,
        selfParticipantId: data.participantId,
        isHost: true,
        room: data.room,
        joinStatus: "joined",
        joinError: null,
        closeReason: null,
        messages: [],
        fatalPeerFailure: false
      });
      buildPeerManager(data.roomCode, "host");
      return { ok: true, roomCode: data.roomCode };
    },

    async joinRoom(roomCode, displayName, password) {
      bindSocketListeners();
      set({ joinStatus: "joining", joinError: null, roomCode, closeReason: null });

      const creds = loadRoomCredentials(roomCode);
      const result = await emitWithAck<JoinRoomResult>("room:join", {
        roomCode,
        displayName,
        ...(password ? { password } : {}),
        ...(creds?.reconnectToken ? { reconnectToken: creds.reconnectToken } : {}),
        ...(creds?.hostToken ? { hostToken: creds.hostToken } : {})
      });

      if (!result.ok) {
        set({ joinStatus: "error", joinError: result.error });
        return { ok: false, error: result.error };
      }

      const data = result.data;
      if (data.status === "waiting") {
        saveRoomCredentials({
          roomCode,
          participantId: data.participantId,
          reconnectToken: data.reconnectToken,
          ...(creds?.hostToken ? { hostToken: creds.hostToken } : {}),
          displayName
        });
        set({ joinStatus: "waiting", selfParticipantId: data.participantId });
        return { ok: true };
      }

      refs.iceServers = toRtcIceServers(data.iceConfig);
      saveRoomCredentials({
        roomCode,
        participantId: data.participantId,
        reconnectToken: data.reconnectToken,
        ...(creds?.hostToken ? { hostToken: creds.hostToken } : {}),
        displayName
      });
      set({
        joinStatus: "joined",
        selfParticipantId: data.participantId,
        isHost: data.isHost,
        room: data.room,
        messages: [],
        fatalPeerFailure: false,
        waitingParticipants: data.room.participants.filter((p) => p.status === "waiting")
      });

      const pcm = buildPeerManager(roomCode, data.isHost ? "host" : "viewer");
      if (data.isHost) {
        for (const participant of data.room.participants) {
          if (
            participant.participantId !== data.participantId &&
            participant.status === "joined"
          ) {
            pcm.addPeer(participant.participantId);
          }
        }
      } else if (data.room.hostParticipantId) {
        pcm.addPeer(data.room.hostParticipantId);
      }
      return { ok: true };
    },

    leaveRoom() {
      const { roomCode } = get();
      if (roomCode) {
        getSocket().emit("room:leave", { roomCode });
        clearRoomCredentials(roomCode);
      }
      get().reset();
    },

    closeRoom() {
      const { roomCode, isHost } = get();
      if (roomCode && isHost) {
        getSocket().emit("host:close-room", { roomCode });
      }
    },

    approveParticipant(participantId) {
      const { roomCode } = get();
      if (!roomCode) return;
      getSocket().emit("room:approve-participant", { roomCode, participantId });
      set((state) => ({
        waitingParticipants: state.waitingParticipants.filter(
          (p) => p.participantId !== participantId
        )
      }));
    },

    rejectParticipant(participantId) {
      const { roomCode } = get();
      if (!roomCode) return;
      getSocket().emit("room:reject-participant", { roomCode, participantId });
      set((state) => ({
        waitingParticipants: state.waitingParticipants.filter(
          (p) => p.participantId !== participantId
        )
      }));
    },

    kickParticipant(participantId) {
      const { roomCode } = get();
      if (!roomCode) return;
      getSocket().emit("host:kick-participant", { roomCode, participantId });
    },

    setMicPermission(participantId, allowed) {
      const { roomCode } = get();
      if (!roomCode) return;
      getSocket().emit("host:set-mic-permission", { roomCode, participantId, allowed });
    },

    async sendChat(body) {
      const { roomCode } = get();
      if (!roomCode) return appError("UNKNOWN");
      const result = await emitWithAck<ChatMessage>("chat:send", { roomCode, body });
      return result.ok ? null : result.error;
    },

    deleteChat(messageId) {
      const { roomCode } = get();
      if (!roomCode) return;
      getSocket().emit("chat:delete", { roomCode, messageId });
    },

    async startSharing(videoTrack, audioTrack, surfaceIsBrowserTab) {
      const { roomCode } = get();
      if (!roomCode || !refs.pcm) return;
      await refs.pcm.setDisplayTracks(videoTrack, audioTrack);
      getSocket().emit("media:sharing-started", {
        roomCode,
        hasAudio: audioTrack !== null,
        surfaceIsBrowserTab
      });
      set({
        localSharing: {
          mode: audioTrack ? "video-and-audio" : "video-only",
          surfaceIsBrowserTab,
          startedAt: Date.now()
        }
      });
    },

    async stopSharing() {
      const { roomCode, localSharing } = get();
      if (!roomCode) return;
      if (refs.pcm) await refs.pcm.clearDisplayTracks();
      if (localSharing.mode !== "none") {
        getSocket().emit("media:sharing-stopped", { roomCode });
      }
      set({ localSharing: { mode: "none", surfaceIsBrowserTab: null, startedAt: null } });
    },

    async setMicrophoneTrack(track) {
      const { roomCode } = get();
      refs.micTrack?.stop();
      refs.micTrack = track;
      if (refs.pcm) await refs.pcm.setMicrophoneTrack(track);
      if (roomCode) {
        getSocket().emit("media:microphone-state", { roomCode, enabled: track !== null });
      }
      set({ micEnabled: track !== null, micError: null });
    },

    reconnectPeers() {
      const { room, isHost, selfParticipantId } = get();
      if (!refs.pcm || !room) return;
      set({ fatalPeerFailure: false });
      if (isHost) {
        for (const participant of room.participants) {
          if (participant.participantId !== selfParticipantId && participant.status === "joined") {
            refs.pcm.requestManualRestart(participant.participantId);
          }
        }
      } else if (room.hostParticipantId) {
        refs.pcm.requestManualRestart(room.hostParticipantId);
      }
    },

    reset() {
      refs.pcm?.dispose();
      refs.pcm = null;
      refs.micTrack?.stop();
      refs.micTrack = null;
      set({
        joinStatus: "idle",
        joinError: null,
        closeReason: null,
        roomCode: null,
        selfParticipantId: null,
        isHost: false,
        room: null,
        hostDisconnected: false,
        messages: [],
        waitingParticipants: [],
        remoteDisplayStream: null,
        remoteMicStreams: [],
        peerStatuses: {},
        peerStats: {},
        fatalPeerFailure: false,
        micEnabled: false,
        micAllowed: true,
        micError: null,
        localSharing: { mode: "none", surfaceIsBrowserTab: null, startedAt: null }
      });
    }
  };
});
