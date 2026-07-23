import type {
  ConnectionStatsSnapshot,
  PeerConnectionStatus
} from "@watchshare/shared";
import { summarizeStats } from "./stats";

/**
 * Transport used to exchange SDP/candidates. Abstracted from Socket.IO so
 * the manager is unit-testable and could later signal through an SFU.
 */
export interface SignalingAdapter {
  sendOffer(targetParticipantId: string, description: RTCSessionDescriptionInit): void;
  sendAnswer(targetParticipantId: string, description: RTCSessionDescriptionInit): void;
  sendIceCandidate(targetParticipantId: string, candidate: RTCIceCandidateInit | null): void;
  sendRestartRequest(targetParticipantId: string): void;
}

export interface RemoteTrackEvent {
  participantId: string;
  track: MediaStreamTrack;
  stream: MediaStream;
  /** Heuristic: audio arriving in the same stream as video is tab audio. */
  source: "display" | "microphone";
}

export interface PeerConnectionManagerOptions {
  role: "host" | "viewer";
  iceServers: RTCIceServer[];
  signaling: SignalingAdapter;
  onRemoteTrack?: (event: RemoteTrackEvent) => void;
  onRemoteTrackEnded?: (participantId: string, trackId: string) => void;
  onStatus?: (participantId: string, status: PeerConnectionStatus) => void;
  onStats?: (participantId: string, snapshot: ConnectionStatsSnapshot) => void;
  onFatalFailure?: (participantId: string) => void;
  statsIntervalMs?: number;
  maxIceRestarts?: number;
  /** Injectable for tests. */
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
}

interface PeerEntry {
  pc: RTCPeerConnection;
  participantId: string;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  statsTimer: ReturnType<typeof setInterval> | null;
  restartAttempts: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  displayVideoSender: RTCRtpSender | null;
  displayAudioSender: RTCRtpSender | null;
  micSender: RTCRtpSender | null;
  /** Remote viewer mic tracks forwarded by the host (star topology). */
  forwardedSenders: Map<string, RTCRtpSender>;
  lastQualityAdaptAt: number;
  closed: boolean;
}

const DISPLAY_STREAM_ID = "watchshare-display";
const MIC_STREAM_ID = "watchshare-mic";

/**
 * Owns every RTCPeerConnection in the room.
 *
 * - Host: one connection per viewer (star topology).
 * - Viewer: one connection to the host.
 *
 * Negotiation follows the perfect-negotiation pattern: the host is the
 * impolite peer, viewers are polite, so glare (simultaneous offers) resolves
 * deterministically without rebuilding connections.
 */
export class PeerConnectionManager {
  private readonly peers = new Map<string, PeerEntry>();
  private readonly options: PeerConnectionManagerOptions;

  private displayVideoTrack: MediaStreamTrack | null = null;
  private displayAudioTrack: MediaStreamTrack | null = null;
  private micTrack: MediaStreamTrack | null = null;
  /** Host-side registry of viewer mic tracks for forwarding to other viewers. */
  private readonly remoteMicTracks = new Map<string, MediaStreamTrack>();
  private disposed = false;

  constructor(options: PeerConnectionManagerOptions) {
    this.options = options;
  }

  // ---- Peer lifecycle ----

  /** Host: register a viewer. Viewer: register the host. */
  addPeer(participantId: string): void {
    if (this.disposed || this.peers.has(participantId)) return;

    const config: RTCConfiguration = { iceServers: this.options.iceServers };
    const pc = this.options.createPeerConnection
      ? this.options.createPeerConnection(config)
      : new RTCPeerConnection(config);

    const entry: PeerEntry = {
      pc,
      participantId,
      polite: this.options.role === "viewer",
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      pendingCandidates: [],
      statsTimer: null,
      restartAttempts: 0,
      restartTimer: null,
      displayVideoSender: null,
      displayAudioSender: null,
      micSender: null,
      forwardedSenders: new Map(),
      lastQualityAdaptAt: 0,
      closed: false
    };
    this.peers.set(participantId, entry);

    pc.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) {
          this.options.signaling.sendOffer(participantId, {
            type: pc.localDescription.type,
            sdp: pc.localDescription.sdp
          });
        }
      } catch {
        // A failed negotiation attempt will be retried on the next
        // negotiationneeded event; nothing to clean up here.
      } finally {
        entry.makingOffer = false;
      }
    };

    pc.onicecandidate = (event) => {
      this.options.signaling.sendIceCandidate(
        participantId,
        event.candidate ? event.candidate.toJSON() : null
      );
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      const source = this.classifyRemoteTrack(event);
      if (source === "microphone" && this.options.role === "host") {
        this.registerRemoteMicTrack(participantId, event.track);
      }
      this.options.onRemoteTrack?.({
        participantId,
        track: event.track,
        stream,
        source
      });
      event.track.addEventListener("ended", () => {
        this.options.onRemoteTrackEnded?.(participantId, event.track.id);
      });
    };

    pc.onconnectionstatechange = () => {
      this.publishStatus(entry);
      if (pc.connectionState === "failed") {
        this.scheduleIceRestart(entry);
      } else if (pc.connectionState === "connected") {
        entry.restartAttempts = 0;
      }
    };
    pc.oniceconnectionstatechange = () => this.publishStatus(entry);

    // Attach whatever local media we currently have.
    this.attachLocalTracks(entry);
    if (this.options.role === "host") {
      this.forwardExistingMicsTo(entry);
    }

    this.startStats(entry);
  }

  removePeer(participantId: string): void {
    const entry = this.peers.get(participantId);
    if (!entry) return;
    this.closeEntry(entry);
    this.peers.delete(participantId);
    const mic = this.remoteMicTracks.get(participantId);
    if (mic) {
      this.remoteMicTracks.delete(participantId);
      // Stop forwarding this viewer's mic to everyone else.
      for (const other of this.peers.values()) {
        const sender = other.forwardedSenders.get(participantId);
        if (sender) {
          try {
            other.pc.removeTrack(sender);
          } catch {
            // Connection may already be closed.
          }
          other.forwardedSenders.delete(participantId);
        }
      }
    }
  }

  hasPeer(participantId: string): boolean {
    return this.peers.has(participantId);
  }

  peerIds(): string[] {
    return [...this.peers.keys()];
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.peers.values()) this.closeEntry(entry);
    this.peers.clear();
    this.remoteMicTracks.clear();
  }

  // ---- Local media ----

  /**
   * Sets (or replaces) the shared display tracks on every connection.
   * Prefers replaceTrack to avoid renegotiation; falls back to addTrack,
   * which triggers negotiationneeded automatically.
   */
  async setDisplayTracks(
    videoTrack: MediaStreamTrack | null,
    audioTrack: MediaStreamTrack | null
  ): Promise<void> {
    this.displayVideoTrack = videoTrack;
    this.displayAudioTrack = audioTrack;
    for (const entry of this.peers.values()) {
      await this.syncSender(entry, "displayVideoSender", videoTrack, DISPLAY_STREAM_ID);
      await this.syncSender(entry, "displayAudioSender", audioTrack, DISPLAY_STREAM_ID);
    }
  }

  async clearDisplayTracks(): Promise<void> {
    await this.setDisplayTracks(null, null);
  }

  async setMicrophoneTrack(track: MediaStreamTrack | null): Promise<void> {
    this.micTrack = track;
    for (const entry of this.peers.values()) {
      await this.syncSender(entry, "micSender", track, MIC_STREAM_ID);
    }
  }

  private attachLocalTracks(entry: PeerEntry): void {
    if (this.displayVideoTrack) {
      const stream = new MediaStream();
      Object.defineProperty(stream, "id", { value: DISPLAY_STREAM_ID });
      entry.displayVideoSender = entry.pc.addTrack(this.displayVideoTrack, stream);
      if (this.displayAudioTrack) {
        entry.displayAudioSender = entry.pc.addTrack(this.displayAudioTrack, stream);
      }
    }
    if (this.micTrack) {
      const micStream = new MediaStream();
      Object.defineProperty(micStream, "id", { value: MIC_STREAM_ID });
      entry.micSender = entry.pc.addTrack(this.micTrack, micStream);
    }
  }

  private async syncSender(
    entry: PeerEntry,
    senderKey: "displayVideoSender" | "displayAudioSender" | "micSender",
    track: MediaStreamTrack | null,
    streamId: string
  ): Promise<void> {
    const sender = entry[senderKey];
    try {
      if (sender && track) {
        await sender.replaceTrack(track);
      } else if (sender && !track) {
        // Keep the transceiver but send nothing; avoids renegotiation and
        // lets a later share resume via replaceTrack.
        await sender.replaceTrack(null);
      } else if (!sender && track) {
        const stream = new MediaStream();
        Object.defineProperty(stream, "id", { value: streamId });
        entry[senderKey] = entry.pc.addTrack(track, stream);
      }
    } catch {
      // replaceTrack can fail if the connection is closing; the peer will be
      // rebuilt by reconnection logic if it matters.
    }
  }

  // ---- Host: viewer-mic forwarding (star topology voice chat) ----

  private registerRemoteMicTrack(fromParticipantId: string, track: MediaStreamTrack): void {
    this.remoteMicTracks.set(fromParticipantId, track);
    for (const entry of this.peers.values()) {
      if (entry.participantId === fromParticipantId) continue;
      this.forwardMicTrack(entry, fromParticipantId, track);
    }
    track.addEventListener("ended", () => {
      this.remoteMicTracks.delete(fromParticipantId);
    });
  }

  private forwardExistingMicsTo(entry: PeerEntry): void {
    for (const [fromId, track] of this.remoteMicTracks) {
      if (fromId === entry.participantId) continue;
      this.forwardMicTrack(entry, fromId, track);
    }
  }

  private forwardMicTrack(
    entry: PeerEntry,
    fromParticipantId: string,
    track: MediaStreamTrack
  ): void {
    if (entry.forwardedSenders.has(fromParticipantId) || track.readyState !== "live") return;
    try {
      const stream = new MediaStream();
      // Encode the origin participant in the stream id so viewers can
      // attribute the voice to the right person.
      Object.defineProperty(stream, "id", { value: `${MIC_STREAM_ID}:${fromParticipantId}` });
      const sender = entry.pc.addTrack(track, stream);
      entry.forwardedSenders.set(fromParticipantId, sender);
    } catch {
      // Best-effort; voice forwarding failures must not break video.
    }
  }

  private classifyRemoteTrack(event: RTCTrackEvent): "display" | "microphone" {
    const stream = event.streams[0];
    if (!stream) return event.track.kind === "video" ? "display" : "microphone";
    if (stream.id.startsWith(MIC_STREAM_ID)) return "microphone";
    if (stream.id === DISPLAY_STREAM_ID) return "display";
    // Fallback heuristic: audio sharing a stream with video is tab audio.
    if (event.track.kind === "audio" && stream.getVideoTracks().length === 0) {
      return "microphone";
    }
    return "display";
  }

  // ---- Inbound signaling ----

  async handleOffer(
    fromParticipantId: string,
    description: RTCSessionDescriptionInit
  ): Promise<void> {
    const entry = this.peers.get(fromParticipantId);
    if (!entry || entry.closed) return;
    const { pc } = entry;

    const readyForOffer =
      !entry.makingOffer &&
      (pc.signalingState === "stable" || entry.isSettingRemoteAnswerPending);
    const offerCollision = !readyForOffer;

    entry.ignoreOffer = !entry.polite && offerCollision;
    if (entry.ignoreOffer) return;

    try {
      await pc.setRemoteDescription(description);
      await this.drainPendingCandidates(entry);
      await pc.setLocalDescription();
      if (pc.localDescription) {
        this.options.signaling.sendAnswer(fromParticipantId, {
          type: pc.localDescription.type,
          sdp: pc.localDescription.sdp
        });
      }
    } catch {
      // Negotiation failure; connection state handlers drive recovery.
    }
  }

  async handleAnswer(
    fromParticipantId: string,
    description: RTCSessionDescriptionInit
  ): Promise<void> {
    const entry = this.peers.get(fromParticipantId);
    if (!entry || entry.closed) return;
    try {
      entry.isSettingRemoteAnswerPending = true;
      await entry.pc.setRemoteDescription(description);
      await this.drainPendingCandidates(entry);
    } catch {
      // Stale answer (e.g. after glare rollback); safe to drop.
    } finally {
      entry.isSettingRemoteAnswerPending = false;
    }
  }

  async handleIceCandidate(
    fromParticipantId: string,
    candidate: RTCIceCandidateInit | null
  ): Promise<void> {
    const entry = this.peers.get(fromParticipantId);
    if (!entry || entry.closed) return;
    if (!entry.pc.remoteDescription) {
      if (candidate) entry.pendingCandidates.push(candidate);
      return;
    }
    try {
      await entry.pc.addIceCandidate(candidate ?? undefined);
    } catch {
      if (!entry.ignoreOffer) {
        // Unexpected candidate failure outside of glare; ignore, trickle ICE
        // will supply more candidates.
      }
    }
  }

  /** Viewer asked the host to restart ICE (host owns offer generation). */
  handleRestartRequest(fromParticipantId: string): void {
    const entry = this.peers.get(fromParticipantId);
    if (!entry || entry.closed) return;
    this.restartIceNow(entry);
  }

  private async drainPendingCandidates(entry: PeerEntry): Promise<void> {
    const pending = entry.pendingCandidates.splice(0);
    for (const candidate of pending) {
      try {
        await entry.pc.addIceCandidate(candidate);
      } catch {
        // Ignore stale candidates.
      }
    }
  }

  // ---- ICE restart with bounded exponential backoff ----

  private scheduleIceRestart(entry: PeerEntry): void {
    const maxRestarts = this.options.maxIceRestarts ?? 3;
    if (entry.closed || entry.restartTimer) return;
    if (entry.restartAttempts >= maxRestarts) {
      this.options.onFatalFailure?.(entry.participantId);
      return;
    }
    const delay = Math.min(1000 * 2 ** entry.restartAttempts, 8000);
    entry.restartAttempts += 1;
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null;
      if (entry.closed || entry.pc.connectionState === "connected") return;
      if (this.options.role === "host") {
        this.restartIceNow(entry);
      } else {
        // Viewers ask the host to produce a restart offer.
        this.options.signaling.sendRestartRequest(entry.participantId);
      }
    }, delay);
  }

  private restartIceNow(entry: PeerEntry): void {
    try {
      entry.pc.restartIce();
    } catch {
      // Older implementations: fall back to createOffer({ iceRestart: true }).
      void (async () => {
        try {
          entry.makingOffer = true;
          const offer = await entry.pc.createOffer({ iceRestart: true });
          await entry.pc.setLocalDescription(offer);
          if (entry.pc.localDescription) {
            this.options.signaling.sendOffer(entry.participantId, {
              type: entry.pc.localDescription.type,
              sdp: entry.pc.localDescription.sdp
            });
          }
        } catch {
          // Recovery failed; fatal-failure path will fire via state handlers.
        } finally {
          entry.makingOffer = false;
        }
      })();
    }
  }

  /** Manual reconnect from the UI's "Reconnect" button. */
  requestManualRestart(participantId: string): void {
    const entry = this.peers.get(participantId);
    if (!entry || entry.closed) return;
    entry.restartAttempts = 0;
    if (this.options.role === "host") {
      this.restartIceNow(entry);
    } else {
      this.options.signaling.sendRestartRequest(participantId);
    }
  }

  // ---- Status + stats ----

  private publishStatus(entry: PeerEntry): void {
    this.options.onStatus?.(entry.participantId, mapConnectionStatus(entry.pc));
  }

  private startStats(entry: PeerEntry): void {
    const interval = this.options.statsIntervalMs ?? 3000;
    if (!this.options.onStats) return;
    entry.statsTimer = setInterval(async () => {
      if (entry.closed || entry.pc.connectionState !== "connected") return;
      try {
        const report = await entry.pc.getStats();
        const snapshot = summarizeStats(report, Date.now());
        this.options.onStats?.(entry.participantId, snapshot);
        this.maybeAdaptQuality(entry, snapshot);
      } catch {
        // getStats can reject during teardown.
      }
    }, interval);
  }

  /**
   * Conservative sender adaptation: on sustained poor quality, cap the video
   * bitrate; restore gradually when quality recovers. Parameter changes only,
   * never renegotiation.
   */
  private maybeAdaptQuality(entry: PeerEntry, snapshot: ConnectionStatsSnapshot): void {
    if (this.options.role !== "host" || !entry.displayVideoSender) return;
    const now = snapshot.timestamp;
    if (now - entry.lastQualityAdaptAt < 15_000) return;

    const sender = entry.displayVideoSender;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) return;
    const encoding = params.encodings[0]!;
    const current = encoding.maxBitrate ?? 2_500_000;

    let next: number | null = null;
    if (snapshot.quality === "poor") next = Math.max(300_000, Math.floor(current * 0.6));
    else if (snapshot.quality === "excellent" && current < 2_500_000) {
      next = Math.min(2_500_000, Math.floor(current * 1.25));
    }
    if (next === null || next === current) return;

    entry.lastQualityAdaptAt = now;
    encoding.maxBitrate = next;
    void sender.setParameters(params).catch(() => undefined);
  }

  private closeEntry(entry: PeerEntry): void {
    entry.closed = true;
    if (entry.statsTimer) clearInterval(entry.statsTimer);
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    entry.pc.onnegotiationneeded = null;
    entry.pc.onicecandidate = null;
    entry.pc.ontrack = null;
    entry.pc.onconnectionstatechange = null;
    entry.pc.oniceconnectionstatechange = null;
    try {
      entry.pc.close();
    } catch {
      // Already closed.
    }
  }
}

export function mapConnectionStatus(pc: RTCPeerConnection): PeerConnectionStatus {
  switch (pc.connectionState) {
    case "new":
      return "new";
    case "connecting":
      return "connecting";
    case "connected":
      return "connected";
    case "disconnected":
      return "reconnecting";
    case "failed":
      return "failed";
    case "closed":
      return "closed";
    default:
      return "new";
  }
}
