"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppError, CaptureState } from "@watchshare/shared";
import { appError } from "@watchshare/shared";
import {
  CaptureError,
  startBlackFrameDetector,
  type CaptureResult,
  type DisplayCaptureService
} from "@/services/displayCapture";

export interface DisplayCaptureHandle {
  state: CaptureState;
  stream: MediaStream | null;
  videoTrack: MediaStreamTrack | null;
  audioTrack: MediaStreamTrack | null;
  surfaceIsBrowserTab: boolean | null;
  capturedSelf: boolean;
  /** Non-fatal advisory (e.g. missing audio track, protected content). */
  warning: AppError | null;
  error: AppError | null;
  /** Must be invoked from a click handler. */
  start: () => Promise<CaptureResult | null>;
  stop: () => void;
  clearWarning: () => void;
}

interface UseDisplayCaptureOptions {
  service: DisplayCaptureService;
  /** Called when the capture ends for any reason (toolbar stop, track end). */
  onEnded?: () => void;
  /** Called when the capture starts or the surface changes. */
  onStarted?: (result: CaptureResult) => void;
}

export function useDisplayCapture(options: UseDisplayCaptureOptions): DisplayCaptureHandle {
  const { service, onEnded, onStarted } = options;
  const [state, setState] = useState<CaptureState>("idle");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [surfaceIsBrowserTab, setSurfaceIsBrowserTab] = useState<boolean | null>(null);
  const [capturedSelf, setCapturedSelf] = useState(false);
  const [warning, setWarning] = useState<AppError | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  const cleanupRef = useRef<(() => void) | null>(null);
  const requestingRef = useRef(false);
  const onEndedRef = useRef(onEnded);
  const onStartedRef = useRef(onStarted);
  onEndedRef.current = onEnded;
  onStartedRef.current = onStarted;

  const teardown = useCallback((nextState: CaptureState) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setStream((current) => {
      if (current) for (const track of current.getTracks()) track.stop();
      return null;
    });
    setSurfaceIsBrowserTab(null);
    setCapturedSelf(false);
    setState(nextState);
  }, []);

  const start = useCallback(async (): Promise<CaptureResult | null> => {
    // Guard against double-clicks re-triggering the permission prompt.
    if (requestingRef.current) return null;
    if (!service.isSupported()) {
      setState("unsupported");
      setError(appError("CAPTURE_UNSUPPORTED"));
      return null;
    }

    requestingRef.current = true;
    setState("requesting");
    setError(null);
    setWarning(null);

    try {
      const result = await service.requestCapture();

      // Stop any previous capture before adopting the new one.
      cleanupRef.current?.();
      cleanupRef.current = null;

      const { videoTrack, audioTrack } = result;

      const handleEnded = (): void => {
        // Fired when the host uses the browser's native "Stop sharing"
        // toolbar; room state must follow automatically.
        teardown("stopped");
        onEndedRef.current?.();
      };
      videoTrack.addEventListener("ended", handleEnded);

      // Chromium fires configurationchange / mute cycles when the user
      // switches the shared surface via "Share this tab instead".
      const handleConfigChange = (): void => {
        const settings = videoTrack.getSettings() as { displaySurface?: string };
        if (typeof settings.displaySurface === "string") {
          setSurfaceIsBrowserTab(settings.displaySurface === "browser");
        }
      };
      videoTrack.addEventListener("configurationchange", handleConfigChange);

      const stopBlackFrameDetector = startBlackFrameDetector(videoTrack, () => {
        setWarning(appError("PROTECTED_CONTENT_SUSPECTED"));
      });

      let audioEndedCleanup: (() => void) | null = null;
      if (audioTrack) {
        const handleAudioEnded = (): void => {
          setWarning(appError("CAPTURE_NO_AUDIO", "Tab audio ended. Viewers can still see the video."));
          setState("active-video-only");
        };
        audioTrack.addEventListener("ended", handleAudioEnded);
        if (audioTrack.muted) {
          setWarning(
            appError(
              "CAPTURE_NO_AUDIO",
              "The shared tab appears to be muted. Unmute the tab so viewers can hear it."
            )
          );
        }
        audioEndedCleanup = () => audioTrack.removeEventListener("ended", handleAudioEnded);
      }

      cleanupRef.current = () => {
        videoTrack.removeEventListener("ended", handleEnded);
        videoTrack.removeEventListener("configurationchange", handleConfigChange);
        audioEndedCleanup?.();
        stopBlackFrameDetector();
      };

      setStream(result.stream);
      setSurfaceIsBrowserTab(result.surfaceIsBrowserTab);
      setCapturedSelf(result.capturedSelf);

      if (!audioTrack) {
        setWarning(appError("CAPTURE_NO_AUDIO"));
        setState("active-video-only");
      } else {
        setState("active-with-audio");
      }
      if (result.capturedSelf) {
        setWarning(
          appError(
            "UNKNOWN",
            "It looks like you shared the WatchShare tab itself. Stop sharing and pick the tab you want friends to watch."
          )
        );
      }

      onStartedRef.current?.(result);
      return result;
    } catch (err) {
      if (err instanceof CaptureError) {
        switch (err.appError.code) {
          case "CAPTURE_CANCELLED":
            // A normal cancellation is not an error state.
            setState("idle");
            setWarning(err.appError);
            break;
          case "CAPTURE_DENIED":
            setState("denied");
            setError(err.appError);
            break;
          case "CAPTURE_UNSUPPORTED":
            setState("unsupported");
            setError(err.appError);
            break;
          default:
            setState("error");
            setError(err.appError);
        }
      } else {
        setState("error");
        setError(appError("UNKNOWN"));
      }
      return null;
    } finally {
      requestingRef.current = false;
    }
  }, [service, teardown]);

  const stop = useCallback(() => {
    teardown("stopped");
    onEndedRef.current?.();
  }, [teardown]);

  // Release tracks on unmount.
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      setStream((current) => {
        if (current) for (const track of current.getTracks()) track.stop();
        return null;
      });
    };
  }, []);

  return {
    state,
    stream,
    videoTrack: stream?.getVideoTracks()[0] ?? null,
    audioTrack: stream?.getAudioTracks()[0] ?? null,
    surfaceIsBrowserTab,
    capturedSelf,
    warning,
    error,
    start,
    stop,
    clearWarning: useCallback(() => setWarning(null), [])
  };
}
