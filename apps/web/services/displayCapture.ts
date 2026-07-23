import { appError, type AppError } from "@watchshare/shared";
import { detectCapabilities } from "@/lib/capabilities";

export class CaptureError extends Error {
  readonly appError: AppError;
  constructor(error: AppError) {
    super(error.message);
    this.appError = error;
  }
}

export interface CaptureResult {
  stream: MediaStream;
  videoTrack: MediaStreamTrack;
  audioTrack: MediaStreamTrack | null;
  /** null when the browser does not report displaySurface. */
  surfaceIsBrowserTab: boolean | null;
  /** True when the host appears to have picked the WatchShare tab itself. */
  capturedSelf: boolean;
}

export interface DisplayCaptureService {
  isSupported(): boolean;
  /**
   * Opens the browser's native picker. Must only ever be called from a user
   * gesture (the "Share a tab" button click).
   */
  requestCapture(signal?: AbortSignal): Promise<CaptureResult>;
}

/**
 * Extended constraints that are progressive enhancements; unsupported
 * browsers ignore unknown members of getDisplayMedia options.
 */
interface ExtendedDisplayMediaOptions extends DisplayMediaStreamOptions {
  preferCurrentTab?: boolean;
  selfBrowserSurface?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
  systemAudio?: "include" | "exclude";
  monitorTypeSurfaces?: "include" | "exclude";
}

export function createDisplayCaptureService(): DisplayCaptureService {
  return {
    isSupported(): boolean {
      return detectCapabilities().hasGetDisplayMedia;
    },

    async requestCapture(signal?: AbortSignal): Promise<CaptureResult> {
      if (!this.isSupported()) {
        throw new CaptureError(appError("CAPTURE_UNSUPPORTED"));
      }

      const caps = detectCapabilities();
      const options: ExtendedDisplayMediaOptions = {
        video: {
          // Hint that a browser tab is the preferred surface (Chromium).
          ...(caps.supportedDisplayConstraints.displaySurface
            ? { displaySurface: "browser" as const }
            : {}),
          frameRate: { ideal: 30 },
          width: { max: 1920 },
          height: { max: 1080 }
        },
        // Request audio, but never assume we get an audio track back.
        // No echoCancellation/noiseSuppression here: those are microphone
        // constraints and must not be applied to tab audio.
        audio: true
      };
      if (caps.supportedDisplayConstraints.surfaceSwitching) {
        options.surfaceSwitching = "include";
      }
      if (caps.supportedDisplayConstraints.selfBrowserSurface) {
        // Reduce accidental recursive capture of the WatchShare tab.
        options.selfBrowserSurface = "exclude";
      }
      if (caps.supportedDisplayConstraints.systemAudio) {
        options.systemAudio = "include";
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia(options);
      } catch (err) {
        throw mapGetDisplayMediaError(err);
      }

      if (signal?.aborted) {
        for (const track of stream.getTracks()) track.stop();
        throw new CaptureError(appError("CAPTURE_CANCELLED"));
      }

      const videoTrack = stream.getVideoTracks()[0] ?? null;
      if (!videoTrack) {
        for (const track of stream.getTracks()) track.stop();
        throw new CaptureError(appError("CAPTURE_NO_VIDEO"));
      }

      const audioTrack = stream.getAudioTracks()[0] ?? null;

      // Tab content is usually text/UI; "detail" prioritises resolution over
      // frame rate, which matches watching a video page or document.
      try {
        videoTrack.contentHint = "detail";
      } catch {
        // contentHint is best-effort.
      }

      let surfaceIsBrowserTab: boolean | null = null;
      const settings = safeGetSettings(videoTrack);
      const displaySurface = (settings as { displaySurface?: string }).displaySurface;
      if (typeof displaySurface === "string") {
        surfaceIsBrowserTab = displaySurface === "browser";
      }

      return {
        stream,
        videoTrack,
        audioTrack,
        surfaceIsBrowserTab,
        capturedSelf: detectSelfCapture(videoTrack)
      };
    }
  };
}

function safeGetSettings(track: MediaStreamTrack): MediaTrackSettings {
  try {
    return track.getSettings();
  } catch {
    return {};
  }
}

function mapGetDisplayMediaError(err: unknown): CaptureError {
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError": {
        // Chromium raises NotAllowedError both for picker dismissal and for
        // policy denial. Dismissal is the common case and is not a fatal
        // error; only OS/policy-level blocks are treated as "denied".
        const message = err.message.toLowerCase();
        if (message.includes("system") || message.includes("policy") || message.includes("disallowed")) {
          return new CaptureError(appError("CAPTURE_DENIED"));
        }
        return new CaptureError(appError("CAPTURE_CANCELLED"));
      }
      case "NotFoundError":
      case "NotReadableError":
      case "AbortError":
        return new CaptureError(
          appError("UNKNOWN", "The selected source could not be captured. It may have closed or become unavailable.")
        );
      case "NotSupportedError":
      case "TypeError":
        return new CaptureError(appError("CAPTURE_UNSUPPORTED"));
      default:
        break;
    }
  }
  return new CaptureError(appError("UNKNOWN"));
}

/**
 * Best-effort detection of the host sharing the WatchShare tab itself, which
 * produces the recursive "hall of mirrors" effect.
 */
function detectSelfCapture(videoTrack: MediaStreamTrack): boolean {
  try {
    const label = videoTrack.label.toLowerCase();
    const title = typeof document !== "undefined" ? document.title.toLowerCase() : "";
    return title.length > 0 && label.includes(title);
  } catch {
    return false;
  }
}

/**
 * Samples video frames and reports when the captured content stays fully
 * black, which usually means the page is protected (DRM/HDCP). WatchShare
 * only informs the host; it never attempts to work around the protection.
 */
export function startBlackFrameDetector(
  videoTrack: MediaStreamTrack,
  onSuspected: () => void
): () => void {
  if (typeof document === "undefined") return () => undefined;

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([videoTrack]);
  void video.play().catch(() => undefined);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let consecutiveBlack = 0;
  let stopped = false;

  const interval = setInterval(() => {
    if (stopped || !ctx || videoTrack.readyState !== "live") return;
    if (video.videoWidth === 0 || video.videoHeight === 0) return;
    canvas.width = 32;
    canvas.height = 18;
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let total = 0;
      for (let i = 0; i < data.length; i += 4) {
        total += data[i]! + data[i + 1]! + data[i + 2]!;
      }
      const average = total / (data.length / 4) / 3;
      if (average < 4) {
        consecutiveBlack += 1;
        if (consecutiveBlack === 4) onSuspected();
      } else {
        consecutiveBlack = 0;
      }
    } catch {
      // Canvas readback can fail; skip this sample.
    }
  }, 2000);

  return () => {
    stopped = true;
    clearInterval(interval);
    video.srcObject = null;
    video.remove();
    canvas.remove();
  };
}
