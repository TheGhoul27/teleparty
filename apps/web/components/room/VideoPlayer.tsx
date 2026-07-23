"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ConnectionQuality, PeerConnectionStatus } from "@watchshare/shared";
import { Button } from "@/components/ui/Button";
import { detectCapabilities } from "@/lib/capabilities";

interface VideoPlayerProps {
  stream: MediaStream | null;
  /** Host preview must stay muted to avoid audio feedback. */
  isLocalPreview?: boolean;
  waitingMessage: string;
  connectionStatus?: PeerConnectionStatus;
  quality?: ConnectionQuality;
  onReconnect?: () => void;
  showReconnect?: boolean;
  /**
   * Rendered inside the fullscreen container so overlays (e.g. chat) can appear
   * on top of the video while fullscreen. Receives the current fullscreen state
   * so it can show itself only when relevant.
   */
  renderOverlay?: (state: { isFullscreen: boolean }) => ReactNode;
}

const qualityLabel: Record<ConnectionQuality, { text: string; className: string; icon: string }> = {
  excellent: { text: "Excellent", className: "text-emerald-300", icon: "\u25CF\u25CF\u25CF\u25CF" },
  good: { text: "Good", className: "text-emerald-200", icon: "\u25CF\u25CF\u25CF\u25CB" },
  unstable: { text: "Unstable", className: "text-amber-300", icon: "\u25CF\u25CF\u25CB\u25CB" },
  poor: { text: "Poor", className: "text-red-300", icon: "\u25CF\u25CB\u25CB\u25CB" },
  unknown: { text: "Measuring", className: "text-gray-400", icon: "\u25CB\u25CB\u25CB\u25CB" }
};

export function VideoPlayer({
  stream,
  isLocalPreview = false,
  waitingMessage,
  connectionStatus,
  quality = "unknown",
  onReconnect,
  showReconnect = false,
  renderOverlay
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(isLocalPreview);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const caps = detectCapabilities();

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    if (!stream) return;

    // Autoplay policy: try with sound first (viewers), fall back to muted
    // playback plus an explicit "Click to hear audio" affordance.
    video.muted = isLocalPreview || muted;
    const attempt = video.play();
    if (attempt) {
      attempt.catch(() => {
        video.muted = true;
        setAutoplayBlocked(!isLocalPreview);
        video.play().catch(() => {
          // Still blocked; the user gesture button below will retry.
        });
      });
    }
    // `muted` intentionally omitted: re-running play() on mute toggle restarts video.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, isLocalPreview]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.volume = volume;
  }, [volume]);

  const enableAudio = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    setMuted(false);
    setAutoplayBlocked(false);
    video.play().catch(() => setAutoplayBlocked(true));
  }, []);

  useEffect(() => {
    const onChange = (): void => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void container.requestFullscreen().catch(() => undefined);
    }
  }, []);

  const togglePictureInPicture = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (document.pictureInPictureElement) {
      void document.exitPictureInPicture().catch(() => undefined);
    } else {
      void video.requestPictureInPicture().catch(() => undefined);
    }
  }, []);

  const reconnecting = connectionStatus === "reconnecting" || connectionStatus === "connecting";
  const failed = connectionStatus === "failed" || connectionStatus === "disconnected";
  const q = qualityLabel[quality];

  return (
    <div
      ref={containerRef}
      className="relative flex aspect-video w-full flex-row overflow-hidden rounded-xl border border-surface-700 bg-black"
    >
      {/* Video stage: shrinks when a side panel (e.g. fullscreen chat) opens. */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocalPreview || muted}
        className="h-full w-full object-contain"
        aria-label={isLocalPreview ? "Your shared tab preview (muted)" : "Shared video stream"}
      />

      {!stream ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-950/95 text-center">
          <div className="text-5xl" aria-hidden="true">
            {"\uD83C\uDFAC"}
          </div>
          <p className="max-w-sm px-4 text-gray-300">{waitingMessage}</p>
        </div>
      ) : null}

      {stream && reconnecting ? (
        <div
          role="status"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface-950/80"
        >
          <div
            className="h-8 w-8 animate-spin rounded-full border-2 border-accent-400 border-t-transparent"
            aria-hidden="true"
          />
          <p className="text-gray-200">Reconnecting&hellip;</p>
        </div>
      ) : null}

      {failed && showReconnect ? (
        <div
          role="alert"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface-950/90"
        >
          <p className="text-gray-200">The media connection was lost.</p>
          {onReconnect ? <Button onClick={onReconnect}>Reconnect</Button> : null}
        </div>
      ) : null}

      {autoplayBlocked && stream ? (
        <div className="absolute inset-x-0 bottom-16 flex justify-center">
          <Button size="lg" onClick={enableAudio} aria-label="Click to hear audio">
            {"\uD83D\uDD0A"} Click to hear audio
          </Button>
        </div>
      ) : null}

      <div className="absolute inset-x-0 bottom-0 z-20 flex items-center gap-3 bg-gradient-to-t from-black/80 to-transparent px-4 py-3">
        {!isLocalPreview ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMuted((m) => !m)}
              aria-label={muted ? "Unmute" : "Mute"}
              title={muted ? "Unmute" : "Mute"}
            >
              <span aria-hidden="true">{muted ? "\uD83D\uDD07" : "\uD83D\uDD0A"}</span>
            </Button>
            <label className="flex items-center gap-2 text-xs text-gray-300">
              <span className="sr-only">Volume</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                aria-label="Volume"
                className="w-24 accent-indigo-400"
              />
            </label>
          </>
        ) : (
          <span className="rounded bg-surface-800/80 px-2 py-0.5 text-xs text-gray-300">
            Preview (muted to prevent echo)
          </span>
        )}

        <span className={`ml-auto text-xs ${q.className}`} title={`Connection: ${q.text}`}>
          <span aria-hidden="true">{q.icon}</span>
          <span className="sr-only">Connection quality: {q.text}</span>
        </span>

        {caps.hasPictureInPicture && !isLocalPreview ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={togglePictureInPicture}
            aria-label="Toggle picture in picture"
            title="Picture in picture"
          >
            <span aria-hidden="true">{"\u29C9"}</span>
          </Button>
        ) : null}
        {caps.hasFullscreen ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={toggleFullscreen}
            aria-label="Toggle fullscreen"
            title="Fullscreen"
          >
            <span aria-hidden="true">{"\u26F6"}</span>
          </Button>
        ) : null}
      </div>
      </div>

      {renderOverlay?.({ isFullscreen })}
    </div>
  );
}
