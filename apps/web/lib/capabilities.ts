/**
 * Feature-detection for everything WatchShare needs. Never sniffs the
 * user-agent string for support decisions; UA is only used to phrase
 * browser-specific *guidance* text.
 */
export interface BrowserCapabilities {
  /**
   * Chrome (and others) expose navigator.mediaDevices only on secure
   * contexts (https:// or http://localhost). Over plain HTTP on a LAN IP the
   * capture APIs are simply absent, which is a configuration issue rather
   * than a real browser limitation - so it gets its own flag and guidance.
   */
  isSecureContext: boolean;
  hasMediaDevices: boolean;
  hasGetDisplayMedia: boolean;
  hasGetUserMedia: boolean;
  hasRTCPeerConnection: boolean;
  hasReplaceTrack: boolean;
  hasPictureInPicture: boolean;
  hasFullscreen: boolean;
  hasAudioOutputSelection: boolean;
  hasCaptureController: boolean;
  supportedDisplayConstraints: {
    displaySurface: boolean;
    surfaceSwitching: boolean;
    selfBrowserSurface: boolean;
    systemAudio: boolean;
  };
  /** Can this browser act as a viewer? */
  canView: boolean;
  /** Can this browser act as a sharing host? */
  canHost: boolean;
}

export function detectCapabilities(): BrowserCapabilities {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return emptyCapabilities();
  }

  const isSecureContext =
    typeof window.isSecureContext === "boolean" ? window.isSecureContext : true;
  const mediaDevices: MediaDevices | undefined = navigator.mediaDevices;
  const hasMediaDevices = Boolean(mediaDevices);
  const hasGetDisplayMedia =
    hasMediaDevices && typeof mediaDevices.getDisplayMedia === "function";
  const hasGetUserMedia = hasMediaDevices && typeof mediaDevices.getUserMedia === "function";
  const hasRTCPeerConnection = typeof window.RTCPeerConnection === "function";
  const hasReplaceTrack =
    typeof window.RTCRtpSender === "function" &&
    typeof window.RTCRtpSender.prototype.replaceTrack === "function";

  const supported: MediaTrackSupportedConstraints & {
    displaySurface?: boolean;
    surfaceSwitching?: boolean;
    selfBrowserSurface?: boolean;
    systemAudio?: boolean;
  } = hasMediaDevices && typeof mediaDevices.getSupportedConstraints === "function"
    ? mediaDevices.getSupportedConstraints()
    : {};

  return {
    isSecureContext,
    hasMediaDevices,
    hasGetDisplayMedia,
    hasGetUserMedia,
    hasRTCPeerConnection,
    hasReplaceTrack,
    hasPictureInPicture:
      typeof document !== "undefined" && "pictureInPictureEnabled" in document
        ? document.pictureInPictureEnabled
        : false,
    hasFullscreen:
      typeof document !== "undefined" &&
      (document.fullscreenEnabled ??
        (document as Document & { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled ??
        false),
    hasAudioOutputSelection:
      typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype,
    hasCaptureController: typeof (window as { CaptureController?: unknown }).CaptureController === "function",
    supportedDisplayConstraints: {
      displaySurface: Boolean(supported.displaySurface),
      surfaceSwitching: Boolean(supported.surfaceSwitching),
      selfBrowserSurface: Boolean(supported.selfBrowserSurface),
      systemAudio: Boolean(supported.systemAudio)
    },
    canView: hasRTCPeerConnection,
    canHost: hasRTCPeerConnection && hasGetDisplayMedia && hasReplaceTrack
  };
}

function emptyCapabilities(): BrowserCapabilities {
  return {
    isSecureContext: false,
    hasMediaDevices: false,
    hasGetDisplayMedia: false,
    hasGetUserMedia: false,
    hasRTCPeerConnection: false,
    hasReplaceTrack: false,
    hasPictureInPicture: false,
    hasFullscreen: false,
    hasAudioOutputSelection: false,
    hasCaptureController: false,
    supportedDisplayConstraints: {
      displaySurface: false,
      surfaceSwitching: false,
      selfBrowserSurface: false,
      systemAudio: false
    },
    canView: false,
    canHost: false
  };
}

/**
 * Guidance text only - not used for support decisions.
 */
export function browserGuidance(caps: BrowserCapabilities): string | null {
  if (caps.canHost && caps.supportedDisplayConstraints.systemAudio) return null;
  if (!caps.isSecureContext && !caps.hasMediaDevices) {
    return "This page is not served over HTTPS, so the browser hides its screen-capture APIs. Open the app via https:// or http://localhost to share a tab; viewing may still work.";
  }
  if (!caps.canView) {
    return "This browser does not support WebRTC. Try a current desktop Chromium browser such as Chrome or Edge.";
  }
  if (!caps.hasGetDisplayMedia) {
    return "This browser cannot share a tab, but you can still join rooms as a viewer. To host, try a Chromium-based desktop browser.";
  }
  if (!caps.supportedDisplayConstraints.systemAudio) {
    return "This browser may capture video without tab audio. For the best audio experience, host from desktop Chrome or Edge and enable \u201cShare tab audio\u201d in the sharing dialog.";
  }
  return null;
}
