import { vi } from "vitest";
import type { SignalingAdapter } from "@/services/webrtc/peerConnectionManager";

export class FakeRtpSender {
  track: MediaStreamTrack | null;
  replaceTrack = vi.fn(async (track: MediaStreamTrack | null) => {
    this.track = track;
  });
  getParameters = vi.fn(() => ({ encodings: [{}] }));
  setParameters = vi.fn(async () => undefined);

  constructor(track: MediaStreamTrack | null) {
    this.track = track;
  }
}

export class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];

  signalingState = "stable";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  senders: FakeRtpSender[] = [];
  addedIceCandidates: Array<RTCIceCandidateInit | undefined> = [];
  closed = false;
  restartIceCalls = 0;

  onnegotiationneeded: (() => void | Promise<void>) | null = null;
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  ontrack: ((event: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  constructor(public config: RTCConfiguration) {
    FakeRTCPeerConnection.instances.push(this);
  }

  private negotiationQueued = false;

  addTrack(track: MediaStreamTrack, _stream?: MediaStream): FakeRtpSender {
    const sender = new FakeRtpSender(track);
    this.senders.push(sender);
    // Browsers coalesce negotiationneeded events fired in the same task.
    if (!this.negotiationQueued) {
      this.negotiationQueued = true;
      queueMicrotask(() => {
        this.negotiationQueued = false;
        void this.onnegotiationneeded?.();
      });
    }
    return sender;
  }

  removeTrack(sender: FakeRtpSender): void {
    this.senders = this.senders.filter((s) => s !== sender);
  }

  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    const isAnswer = this.signalingState === "have-remote-offer";
    this.localDescription =
      description ?? ({ type: isAnswer ? "answer" : "offer", sdp: "v=0 fake" } as const);
    this.signalingState = isAnswer ? "stable" : "have-local-offer";
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
    this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
  }

  async createOffer(_options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0 fake-offer" };
  }

  async addIceCandidate(candidate?: RTCIceCandidateInit): Promise<void> {
    this.addedIceCandidates.push(candidate);
  }

  restartIce(): void {
    this.restartIceCalls += 1;
  }

  async getStats(): Promise<RTCStatsReport> {
    return new Map() as unknown as RTCStatsReport;
  }

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }

  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

export function makeSignalingSpy(): SignalingAdapter & {
  offers: Array<{ target: string; description: RTCSessionDescriptionInit }>;
  answers: Array<{ target: string; description: RTCSessionDescriptionInit }>;
  candidates: Array<{ target: string; candidate: RTCIceCandidateInit | null }>;
  restarts: string[];
} {
  const offers: Array<{ target: string; description: RTCSessionDescriptionInit }> = [];
  const answers: Array<{ target: string; description: RTCSessionDescriptionInit }> = [];
  const candidates: Array<{ target: string; candidate: RTCIceCandidateInit | null }> = [];
  const restarts: string[] = [];
  return {
    offers,
    answers,
    candidates,
    restarts,
    sendOffer: (target, description) => offers.push({ target, description }),
    sendAnswer: (target, description) => answers.push({ target, description }),
    sendIceCandidate: (target, candidate) => candidates.push({ target, candidate }),
    sendRestartRequest: (target) => restarts.push(target)
  };
}

export const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));
