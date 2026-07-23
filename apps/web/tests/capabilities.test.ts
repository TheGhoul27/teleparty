import { afterEach, describe, expect, it, vi } from "vitest";
import { browserGuidance, detectCapabilities } from "@/lib/capabilities";

function mockMediaDevices(overrides: Partial<MediaDevices> | undefined): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: overrides
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("detectCapabilities", () => {
  it("detects a full Chromium-like environment", () => {
    mockMediaDevices({
      getDisplayMedia: () => Promise.resolve(new MediaStream() as unknown as MediaStream),
      getUserMedia: () => Promise.resolve(new MediaStream() as unknown as MediaStream),
      getSupportedConstraints: () =>
        ({
          displaySurface: true,
          surfaceSwitching: true,
          selfBrowserSurface: true,
          systemAudio: true
        }) as MediaTrackSupportedConstraints
    } as unknown as MediaDevices);
    vi.stubGlobal("RTCPeerConnection", class {});
    vi.stubGlobal(
      "RTCRtpSender",
      class {
        replaceTrack() {}
      }
    );

    const caps = detectCapabilities();
    expect(caps.hasGetDisplayMedia).toBe(true);
    expect(caps.hasRTCPeerConnection).toBe(true);
    expect(caps.hasReplaceTrack).toBe(true);
    expect(caps.supportedDisplayConstraints.systemAudio).toBe(true);
    expect(caps.canHost).toBe(true);
    expect(caps.canView).toBe(true);
    expect(browserGuidance(caps)).toBeNull();
  });

  it("flags viewers without display capture as view-only", () => {
    mockMediaDevices({
      getUserMedia: () => Promise.resolve(new MediaStream() as unknown as MediaStream),
      getSupportedConstraints: () => ({}) as MediaTrackSupportedConstraints
    } as unknown as MediaDevices);
    vi.stubGlobal("RTCPeerConnection", class {});
    vi.stubGlobal(
      "RTCRtpSender",
      class {
        replaceTrack() {}
      }
    );

    const caps = detectCapabilities();
    expect(caps.canView).toBe(true);
    expect(caps.canHost).toBe(false);
    expect(browserGuidance(caps)).toMatch(/viewer/i);
  });

  it("reports unsupported when WebRTC is missing", () => {
    mockMediaDevices(undefined);
    vi.stubGlobal("RTCPeerConnection", undefined);
    const caps = detectCapabilities();
    expect(caps.canView).toBe(false);
    expect(caps.canHost).toBe(false);
    expect(browserGuidance(caps)).toMatch(/does not support WebRTC/);
  });

  it("suggests tab-audio guidance when systemAudio is unsupported", () => {
    mockMediaDevices({
      getDisplayMedia: () => Promise.resolve(new MediaStream() as unknown as MediaStream),
      getUserMedia: () => Promise.resolve(new MediaStream() as unknown as MediaStream),
      getSupportedConstraints: () => ({}) as MediaTrackSupportedConstraints
    } as unknown as MediaDevices);
    vi.stubGlobal("RTCPeerConnection", class {});
    vi.stubGlobal(
      "RTCRtpSender",
      class {
        replaceTrack() {}
      }
    );
    const caps = detectCapabilities();
    expect(caps.canHost).toBe(true);
    expect(browserGuidance(caps)).toMatch(/Share tab audio/);
  });
});
