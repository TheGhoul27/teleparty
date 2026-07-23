import { beforeEach, describe, expect, it } from "vitest";
import { PeerConnectionManager } from "@/services/webrtc/peerConnectionManager";
import {
  FakeRTCPeerConnection,
  flushMicrotasks,
  makeSignalingSpy
} from "./fakeRtc";
import { FakeMediaStreamTrack } from "./setup";

const track = (kind: string): MediaStreamTrack =>
  new FakeMediaStreamTrack(kind) as unknown as MediaStreamTrack;

function makeManager(role: "host" | "viewer") {
  const signaling = makeSignalingSpy();
  const manager = new PeerConnectionManager({
    role,
    iceServers: [],
    signaling,
    createPeerConnection: (config) =>
      new FakeRTCPeerConnection(config) as unknown as RTCPeerConnection,
    statsIntervalMs: 60_000
  });
  return { manager, signaling };
}

beforeEach(() => {
  FakeRTCPeerConnection.instances = [];
});

describe("host sharing flows", () => {
  it("sends an offer to each viewer when sharing starts after viewers joined", async () => {
    const { manager, signaling } = makeManager("host");
    manager.addPeer("viewer-1");
    manager.addPeer("viewer-2");
    await flushMicrotasks();
    expect(signaling.offers).toHaveLength(0); // no tracks yet

    await manager.setDisplayTracks(track("video"), track("audio"));
    await flushMicrotasks();

    // Adding video + audio can fire negotiationneeded more than once; what
    // matters is that every viewer received at least one offer.
    const targets = [...new Set(signaling.offers.map((o) => o.target))].sort();
    expect(targets).toEqual(["viewer-1", "viewer-2"]);
  });

  it("attaches current tracks and offers when a viewer joins mid-share", async () => {
    const { manager, signaling } = makeManager("host");
    await manager.setDisplayTracks(track("video"), track("audio"));
    manager.addPeer("late-viewer");
    await flushMicrotasks();

    expect(signaling.offers.some((o) => o.target === "late-viewer")).toBe(true);
    const pc = FakeRTCPeerConnection.instances[0]!;
    expect(pc.senders).toHaveLength(2);
  });

  it("replaces tracks without renegotiating when switching the shared tab", async () => {
    const { manager, signaling } = makeManager("host");
    await manager.setDisplayTracks(track("video"), track("audio"));
    manager.addPeer("viewer-1");
    await flushMicrotasks();
    const offersBefore = signaling.offers.length;

    await manager.setDisplayTracks(track("video"), track("audio"));
    await flushMicrotasks();

    expect(signaling.offers.length).toBe(offersBefore);
    const pc = FakeRTCPeerConnection.instances[0]!;
    expect(pc.senders[0]!.replaceTrack).toHaveBeenCalled();
  });

  it("keeps transceivers but sends nothing when sharing stops", async () => {
    const { manager } = makeManager("host");
    await manager.setDisplayTracks(track("video"), track("audio"));
    manager.addPeer("viewer-1");
    await flushMicrotasks();

    await manager.clearDisplayTracks();
    const pc = FakeRTCPeerConnection.instances[0]!;
    expect(pc.senders[0]!.track).toBeNull();
    expect(pc.senders[1]!.track).toBeNull();
  });

  it("answers incoming offers as the impolite peer when not making one", async () => {
    const { manager, signaling } = makeManager("host");
    manager.addPeer("viewer-1");
    await manager.handleOffer("viewer-1", { type: "offer", sdp: "v=0 from-viewer" });
    expect(signaling.answers).toHaveLength(1);
    expect(signaling.answers[0]!.target).toBe("viewer-1");
  });
});

describe("viewer flows", () => {
  it("answers the host's offer", async () => {
    const { manager, signaling } = makeManager("viewer");
    manager.addPeer("host-1");
    await manager.handleOffer("host-1", { type: "offer", sdp: "v=0 host-offer" });
    expect(signaling.answers).toHaveLength(1);
    const pc = FakeRTCPeerConnection.instances[0]!;
    expect(pc.remoteDescription?.sdp).toBe("v=0 host-offer");
  });

  it("queues ICE candidates that arrive before the remote description", async () => {
    const { manager } = makeManager("viewer");
    manager.addPeer("host-1");
    await manager.handleIceCandidate("host-1", { candidate: "candidate:1", sdpMid: "0" });
    const pc = FakeRTCPeerConnection.instances[0]!;
    expect(pc.addedIceCandidates).toHaveLength(0);

    await manager.handleOffer("host-1", { type: "offer", sdp: "v=0" });
    expect(pc.addedIceCandidates.length).toBeGreaterThan(0);
  });

  it("as the polite peer, accepts a colliding offer instead of ignoring it", async () => {
    const { manager, signaling } = makeManager("viewer");
    manager.addPeer("host-1");
    const pc = FakeRTCPeerConnection.instances[0]!;
    // Simulate glare: viewer already sent its own offer.
    pc.signalingState = "have-local-offer";
    await manager.handleOffer("host-1", { type: "offer", sdp: "v=0 glare" });
    expect(signaling.answers).toHaveLength(1);
  });

  it("asks the host for an ICE restart after a failure", async () => {
    const { manager, signaling } = makeManager("viewer");
    const managerWithFastRestart = manager;
    managerWithFastRestart.addPeer("host-1");
    const pc = FakeRTCPeerConnection.instances[0]!;
    pc.setConnectionState("failed");
    // First backoff step is 1s.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(signaling.restarts).toContain("host-1");
  });
});

describe("cleanup", () => {
  it("closes connections on removePeer and dispose", async () => {
    const { manager } = makeManager("host");
    manager.addPeer("viewer-1");
    manager.addPeer("viewer-2");
    manager.removePeer("viewer-1");
    expect(FakeRTCPeerConnection.instances[0]!.closed).toBe(true);
    manager.dispose();
    expect(FakeRTCPeerConnection.instances[1]!.closed).toBe(true);
    expect(manager.peerIds()).toHaveLength(0);
  });

  it("host performs the ICE restart itself", async () => {
    const { manager } = makeManager("host");
    manager.addPeer("viewer-1");
    const pc = FakeRTCPeerConnection.instances[0]!;
    pc.setConnectionState("failed");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(pc.restartIceCalls).toBeGreaterThan(0);
  });
});
