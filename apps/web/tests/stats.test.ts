import { describe, expect, it } from "vitest";
import { classifyQuality, summarizeStats } from "@/services/webrtc/stats";

function makeReport(entries: Array<Record<string, unknown> & { type: string; id: string }>): RTCStatsReport {
  const map = new Map(entries.map((entry) => [entry.id, entry]));
  return map as unknown as RTCStatsReport;
}

describe("classifyQuality", () => {
  it("returns unknown with no data", () => {
    expect(
      classifyQuality({ roundTripTimeMs: null, packetLossPercent: null, framesPerSecond: null })
    ).toBe("unknown");
  });

  it("classifies a clean connection as excellent", () => {
    expect(
      classifyQuality({ roundTripTimeMs: 40, packetLossPercent: 0, framesPerSecond: 30 })
    ).toBe("excellent");
  });

  it("classifies moderate loss and rtt as unstable", () => {
    expect(
      classifyQuality({ roundTripTimeMs: 300, packetLossPercent: 0.5, framesPerSecond: 30 })
    ).toBe("unstable");
  });

  it("classifies heavy loss as poor", () => {
    expect(
      classifyQuality({ roundTripTimeMs: 600, packetLossPercent: 10, framesPerSecond: 5 })
    ).toBe("poor");
  });
});

describe("summarizeStats", () => {
  it("extracts rtt, fps, resolution, and relay usage", () => {
    const report = makeReport([
      {
        type: "transport",
        id: "T1",
        selectedCandidatePairId: "CP1"
      },
      {
        type: "candidate-pair",
        id: "CP1",
        nominated: true,
        state: "succeeded",
        currentRoundTripTime: 0.08,
        availableOutgoingBitrate: 1_500_000,
        localCandidateId: "LC1"
      },
      { type: "local-candidate", id: "LC1", candidateType: "relay" },
      {
        type: "inbound-rtp",
        id: "IR1",
        kind: "video",
        framesPerSecond: 29,
        frameWidth: 1280,
        frameHeight: 720,
        framesDropped: 3,
        packetsLost: 1,
        packetsReceived: 999
      },
      { type: "inbound-rtp", id: "IR2", kind: "audio", jitter: 0.012, packetsLost: 0, packetsReceived: 500 }
    ]);

    const snapshot = summarizeStats(report, 123);
    expect(snapshot.roundTripTimeMs).toBe(80);
    expect(snapshot.availableOutgoingBitrateKbps).toBe(1500);
    expect(snapshot.framesPerSecond).toBe(29);
    expect(snapshot.frameWidth).toBe(1280);
    expect(snapshot.frameHeight).toBe(720);
    expect(snapshot.framesDropped).toBe(3);
    expect(snapshot.audioJitterMs).toBe(12);
    expect(snapshot.usingTurnRelay).toBe(true);
    expect(snapshot.quality).toBe("excellent");
  });

  it("uses remote-inbound-rtp rtt and fraction lost for senders", () => {
    const report = makeReport([
      { type: "remote-inbound-rtp", id: "RI1", roundTripTime: 0.3, fractionLost: 0.05 },
      { type: "outbound-rtp", id: "OR1", kind: "video", framesPerSecond: 24, frameWidth: 1920, frameHeight: 1080 }
    ]);
    const snapshot = summarizeStats(report, 1);
    expect(snapshot.roundTripTimeMs).toBe(300);
    expect(snapshot.packetLossPercent).toBe(5);
    expect(snapshot.usingTurnRelay).toBe(false);
  });
});
