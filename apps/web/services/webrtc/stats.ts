import type { ConnectionQuality, ConnectionStatsSnapshot } from "@watchshare/shared";

/**
 * Reduces a getStats() report to the snapshot the UI consumes. Works for both
 * sending (host) and receiving (viewer) connections.
 */
export function summarizeStats(
  report: RTCStatsReport,
  timestamp: number
): ConnectionStatsSnapshot {
  let roundTripTimeMs: number | null = null;
  let packetLossPercent: number | null = null;
  let availableOutgoingBitrateKbps: number | null = null;
  let framesPerSecond: number | null = null;
  let frameWidth: number | null = null;
  let frameHeight: number | null = null;
  let framesDropped: number | null = null;
  let audioJitterMs: number | null = null;
  let usingTurnRelay = false;

  let packetsLost = 0;
  let packetsTotal = 0;
  let selectedPairId: string | null = null;
  const candidatePairs = new Map<string, Record<string, unknown>>();
  const localCandidates = new Map<string, Record<string, unknown>>();

  report.forEach((stats) => {
    const s = stats as Record<string, unknown>;
    switch (stats.type) {
      case "transport": {
        if (typeof s.selectedCandidatePairId === "string") {
          selectedPairId = s.selectedCandidatePairId;
        }
        break;
      }
      case "candidate-pair": {
        candidatePairs.set(stats.id, s);
        break;
      }
      case "local-candidate": {
        localCandidates.set(stats.id, s);
        break;
      }
      case "outbound-rtp": {
        if (s.kind === "video") {
          if (typeof s.framesPerSecond === "number") framesPerSecond = s.framesPerSecond;
          if (typeof s.frameWidth === "number") frameWidth = s.frameWidth;
          if (typeof s.frameHeight === "number") frameHeight = s.frameHeight;
        }
        break;
      }
      case "inbound-rtp": {
        if (s.kind === "video") {
          if (typeof s.framesPerSecond === "number") framesPerSecond = s.framesPerSecond;
          if (typeof s.frameWidth === "number") frameWidth = s.frameWidth;
          if (typeof s.frameHeight === "number") frameHeight = s.frameHeight;
          if (typeof s.framesDropped === "number") framesDropped = s.framesDropped;
        }
        if (s.kind === "audio" && typeof s.jitter === "number") {
          audioJitterMs = Math.round(s.jitter * 1000);
        }
        if (typeof s.packetsLost === "number" && typeof s.packetsReceived === "number") {
          packetsLost += s.packetsLost;
          packetsTotal += s.packetsLost + s.packetsReceived;
        }
        break;
      }
      case "remote-inbound-rtp": {
        if (typeof s.roundTripTime === "number") {
          roundTripTimeMs = Math.round(s.roundTripTime * 1000);
        }
        if (typeof s.fractionLost === "number") {
          packetLossPercent = Math.min(100, Math.round(s.fractionLost * 100 * 10) / 10);
        }
        break;
      }
      default:
        break;
    }
  });

  // Selected candidate pair: RTT, bitrate, relay detection.
  let pair: Record<string, unknown> | undefined = selectedPairId
    ? candidatePairs.get(selectedPairId)
    : undefined;
  if (!pair) {
    for (const candidate of candidatePairs.values()) {
      if (candidate.nominated === true && candidate.state === "succeeded") {
        pair = candidate;
        break;
      }
    }
  }
  if (pair) {
    if (roundTripTimeMs === null && typeof pair.currentRoundTripTime === "number") {
      roundTripTimeMs = Math.round(pair.currentRoundTripTime * 1000);
    }
    if (typeof pair.availableOutgoingBitrate === "number") {
      availableOutgoingBitrateKbps = Math.round(pair.availableOutgoingBitrate / 1000);
    }
    const localId = typeof pair.localCandidateId === "string" ? pair.localCandidateId : null;
    const local = localId ? localCandidates.get(localId) : undefined;
    if (local && local.candidateType === "relay") usingTurnRelay = true;
  }

  if (packetLossPercent === null && packetsTotal > 0) {
    packetLossPercent = Math.round((packetsLost / packetsTotal) * 100 * 10) / 10;
  }

  return {
    timestamp,
    roundTripTimeMs,
    packetLossPercent,
    availableOutgoingBitrateKbps,
    framesPerSecond,
    frameWidth,
    frameHeight,
    framesDropped,
    audioJitterMs,
    usingTurnRelay,
    quality: classifyQuality({ roundTripTimeMs, packetLossPercent, framesPerSecond })
  };
}

export function classifyQuality(input: {
  roundTripTimeMs: number | null;
  packetLossPercent: number | null;
  framesPerSecond: number | null;
}): ConnectionQuality {
  const { roundTripTimeMs: rtt, packetLossPercent: loss, framesPerSecond: fps } = input;
  if (rtt === null && loss === null && fps === null) return "unknown";

  let score = 0;
  if (loss !== null) {
    if (loss > 8) score += 3;
    else if (loss > 3) score += 2;
    else if (loss > 1) score += 1;
  }
  if (rtt !== null) {
    if (rtt > 500) score += 3;
    else if (rtt > 250) score += 2;
    else if (rtt > 120) score += 1;
  }
  if (fps !== null && fps > 0 && fps < 10) score += 1;

  if (score >= 4) return "poor";
  if (score >= 2) return "unstable";
  if (score >= 1) return "good";
  return "excellent";
}
