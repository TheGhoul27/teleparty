import { afterEach, describe, expect, it, vi } from "vitest";
import { browserGuidance, detectCapabilities } from "@/lib/capabilities";

afterEach(() => {
  vi.unstubAllGlobals();
  // Restore jsdom defaults touched via defineProperty.
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

describe("insecure context detection", () => {
  it("explains the HTTPS requirement when mediaDevices is hidden on an insecure origin", () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    vi.stubGlobal("RTCPeerConnection", class {});
    vi.stubGlobal(
      "RTCRtpSender",
      class {
        replaceTrack() {}
      }
    );

    const caps = detectCapabilities();
    expect(caps.isSecureContext).toBe(false);
    expect(caps.canHost).toBe(false);
    expect(caps.canView).toBe(true);
    expect(browserGuidance(caps)).toMatch(/HTTPS|https:\/\//);

    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  });
});
