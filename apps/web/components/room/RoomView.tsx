"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { displayNameSchema } from "@watchshare/shared";
import { AriaAnnouncer } from "@/components/AriaAnnouncer";
import { SignalingTrustHint } from "@/components/SignalingTrustHint";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { ChatPanel } from "@/components/room/ChatPanel";
import { DiagnosticsPanel } from "@/components/room/DiagnosticsPanel";
import { FullscreenChatOverlay } from "@/components/room/FullscreenChatOverlay";
import { MicControl } from "@/components/room/MicControl";
import { ParticipantList } from "@/components/room/ParticipantList";
import { RemoteAudioSinks } from "@/components/room/RemoteAudioSinks";
import { VideoPlayer } from "@/components/room/VideoPlayer";
import { useDisplayCapture } from "@/hooks/useDisplayCapture";
import { detectCapabilities } from "@/lib/capabilities";
import { loadRoomCredentials } from "@/lib/session";
import { createDisplayCaptureService } from "@/services/displayCapture";
import { getSignalingUrl } from "@/services/signalingClient";
import { useRoomStore } from "@/stores/roomStore";

const captureService = createDisplayCaptureService();

interface RoomViewProps {
  roomCode: string;
}

export function RoomView({ roomCode }: RoomViewProps) {
  const router = useRouter();
  const store = useRoomStore();
  const {
    joinStatus,
    joinError,
    closeReason,
    room,
    isHost,
    selfParticipantId,
    signalingStatus,
    hostDisconnected,
    hostGraceSeconds,
    remoteDisplayStream,
    peerStatuses,
    peerStats,
    fatalPeerFailure,
    localSharing
  } = store;

  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"none" | "participants" | "chat">("none");
  const [volumes, setVolumes] = useState<Record<string, { volume: number; locallyMuted: boolean }>>({});
  const [speakingIds, setSpeakingIds] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);

  // Marks the client as interactive; tests wait for this before clicking.
  useEffect(() => setHydrated(true), []);

  // ---- Capture (host) ----
  const capture = useDisplayCapture({
    service: captureService,
    onStarted: (result) => {
      void useRoomStore
        .getState()
        .startSharing(result.videoTrack, result.audioTrack, result.surfaceIsBrowserTab);
    },
    onEnded: () => {
      void useRoomStore.getState().stopSharing();
    }
  });

  // ---- Lifecycle ----
  useEffect(() => {
    const caps = detectCapabilities();
    if (!caps.canView) {
      router.replace("/unsupported");
      return;
    }
    useRoomStore.getState().connect();
  }, [router]);

  // Ask the status endpoint whether a password is needed, before joining.
  useEffect(() => {
    if (joinStatus !== "idle") return;
    const creds = loadRoomCredentials(roomCode);
    if (creds?.displayName) setDisplayName(creds.displayName);
    const controller = new AbortController();
    fetch(`${getSignalingUrl()}/api/rooms/${roomCode}/status`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { data?: { hasPassword?: boolean } };
        if (body.data?.hasPassword && !creds?.reconnectToken && !creds?.hostToken) {
          setNeedsPassword(true);
        }
      })
      .catch(() => {
        // Status preflight is best-effort; join will surface real errors.
      });
    return () => controller.abort();
  }, [roomCode, joinStatus]);

  const handleSpeakingChange = useCallback((participantId: string, speaking: boolean) => {
    setSpeakingIds((prev) => {
      if (prev.has(participantId) === speaking) return prev;
      const next = new Set(prev);
      if (speaking) next.add(participantId);
      else next.delete(participantId);
      return next;
    });
  }, []);

  const handleVolumeChange = useCallback(
    (participantId: string, patch: Partial<{ volume: number; locallyMuted: boolean }>) => {
      setVolumes((prev) => ({
        ...prev,
        [participantId]: { volume: 1, locallyMuted: false, ...prev[participantId], ...patch }
      }));
    },
    []
  );

  const handleJoin = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setFormError(null);
    const parsed = displayNameSchema.safeParse(displayName);
    if (!parsed.success) {
      setFormError("Enter a display name (up to 32 characters).");
      return;
    }
    setJoining(true);
    const result = await useRoomStore
      .getState()
      .joinRoom(roomCode, parsed.data, password || undefined);
    setJoining(false);
    if (!result.ok && result.error) {
      if (result.error.code === "INVALID_PASSWORD") setNeedsPassword(true);
      setFormError(result.error.message);
    }
  };

  const copyInvite = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/room/${roomCode}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFormError("Could not copy the link. Copy the address bar URL instead.");
    }
  };

  const leave = (): void => {
    capture.stop();
    useRoomStore.getState().leaveRoom();
    router.push("/");
  };

  const closeRoom = (): void => {
    if (window.confirm("Close the room for everyone?")) {
      capture.stop();
      useRoomStore.getState().closeRoom();
    }
  };

  const hostPeerStatus = room?.hostParticipantId
    ? peerStatuses[room.hostParticipantId]
    : undefined;
  const hostPeerStats = room?.hostParticipantId ? peerStats[room.hostParticipantId] : undefined;
  const viewerCount = useMemo(
    () =>
      room
        ? room.participants.filter((p) => p.status === "joined" && p.role !== "host").length
        : 0,
    [room]
  );

  // ---- Pre-join and terminal states ----

  if (joinStatus === "closed") {
    return (
      <CenteredNotice title="Room closed">
        <p className="text-gray-300">
          {closeReason === "expired"
            ? "This room has expired."
            : closeReason === "host-timeout"
              ? "The room closed because the host did not return."
              : "The host closed this room."}
        </p>
        <Link href="/" className="text-accent-300 underline underline-offset-4">
          Back to home
        </Link>
      </CenteredNotice>
    );
  }

  if (joinStatus === "kicked" || joinStatus === "rejected") {
    return (
      <CenteredNotice title={joinStatus === "kicked" ? "Removed from room" : "Not admitted"}>
        <p className="text-gray-300">{joinError?.message}</p>
        <Link href="/" className="text-accent-300 underline underline-offset-4">
          Back to home
        </Link>
      </CenteredNotice>
    );
  }

  if (joinStatus === "waiting") {
    return (
      <CenteredNotice title="Waiting for the host">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-accent-400 border-t-transparent"
          aria-hidden="true"
        />
        <p role="status" className="text-gray-300">
          The host has been asked to admit you. Hang tight&hellip;
        </p>
        <Button variant="ghost" onClick={leave}>
          Cancel
        </Button>
      </CenteredNotice>
    );
  }

  if (joinStatus !== "joined") {
    return (
      <main
        data-hydrated={hydrated ? "true" : undefined}
        className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-6 px-6 py-16"
      >
        <h1 className="text-2xl font-bold text-white">
          Join room <span className="font-mono text-accent-300">{roomCode}</span>
        </h1>
        <form
          onSubmit={handleJoin}
          className="flex flex-col gap-4 rounded-xl border border-surface-700 bg-surface-900 p-6"
        >
          <Field
            label="Your display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={32}
            autoFocus
            required
          />
          {needsPassword ? (
            <Field
              label="Room password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
            />
          ) : null}
          {formError && joinStatus === "error" ? (
            <p role="alert" className="text-sm text-red-400">
              {joinError?.message ?? formError}
            </p>
          ) : formError ? (
            <p role="alert" className="text-sm text-red-400">
              {formError}
            </p>
          ) : null}
          <Button type="submit" disabled={joining || signalingStatus === "disconnected"}>
            {joining ? "Joining\u2026" : "Join room"}
          </Button>
          {signalingStatus !== "connected" ? (
            <p role="status" className="text-xs text-amber-300">
              Connecting to the room server&hellip;
            </p>
          ) : null}
        </form>
        <SignalingTrustHint status={signalingStatus} />
        <Link href="/" className="text-sm text-gray-400 underline underline-offset-4">
          Back to home
        </Link>
      </main>
    );
  }

  // ---- Joined room UI ----

  const sharingActive = isHost
    ? localSharing.mode !== "none" && capture.stream !== null
    : (room?.sharing.mode ?? "none") !== "none";

  return (
    <div className="flex h-full flex-col">
      <AriaAnnouncer />
      <RemoteAudioSinks volumes={volumes} onSpeakingChange={handleSpeakingChange} />

      {/* Top bar */}
      <header className="flex flex-wrap items-center gap-3 border-b border-surface-700 bg-surface-900 px-4 py-2">
        <span className="font-bold text-white">
          Watch<span className="text-accent-400">Share</span>
        </span>
        <span className="rounded bg-surface-800 px-2 py-1 font-mono text-sm text-gray-200">
          {roomCode}
        </span>
        <Button size="sm" variant="secondary" onClick={copyInvite}>
          {copied ? "Copied!" : "Copy invite link"}
        </Button>

        <ConnectionBadge status={signalingStatus} />

        {/* Permanent sharing indicator: the host must always know what is live. */}
        {isHost ? (
          <span
            role="status"
            className={`ml-auto flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${
              sharingActive
                ? "bg-red-600/20 text-red-300"
                : "bg-surface-800 text-gray-400"
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-full ${sharingActive ? "animate-pulse bg-red-400" : "bg-gray-600"}`}
            />
            {sharingActive
              ? `Sharing ${localSharing.mode === "video-and-audio" ? "with tab audio" : "(video only)"}${
                  store.micEnabled ? " + mic" : ""
                } to ${viewerCount} viewer${viewerCount === 1 ? "" : "s"}`
              : store.micEnabled
                ? "Not sharing your screen (mic is on)"
                : "Not sharing"}
          </span>
        ) : (
          <span className="ml-auto text-xs text-gray-400">
            {viewerCount + 1} in room
          </span>
        )}
      </header>

      {/* Banners */}
      {hostDisconnected && !isHost ? (
        <Banner tone="warn" role="status">
          The host lost their connection. The room stays open for about {hostGraceSeconds} seconds
          while they reconnect.
        </Banner>
      ) : null}
      {capture.warning ? (
        <Banner tone="warn" role="status" onDismiss={capture.clearWarning}>
          {capture.warning.message}
          {capture.warning.code === "CAPTURE_NO_AUDIO" ? (
            <span className="block text-xs opacity-80">
              To share sound: stop sharing, click &ldquo;Share a tab&rdquo; again, pick a{" "}
              <strong>browser tab</strong> in the dialog, and enable{" "}
              <strong>Share tab audio</strong>. Video-only sharing still works.
            </span>
          ) : null}
        </Banner>
      ) : null}
      {capture.error ? (
        <Banner tone="error" role="alert">
          {capture.error.message}
        </Banner>
      ) : null}
      {fatalPeerFailure ? (
        <Banner tone="error" role="alert">
          The media connection failed and automatic recovery gave up.{" "}
          <Button size="sm" onClick={() => useRoomStore.getState().reconnectPeers()}>
            Reconnect
          </Button>
        </Banner>
      ) : null}

      {/* Main layout */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          {isHost ? (
            <VideoPlayer
              stream={capture.stream}
              isLocalPreview
              waitingMessage={
                capture.state === "requesting"
                  ? "Waiting for you to pick a tab in the browser dialog\u2026"
                  : 'Click "Share a tab" below, choose a browser tab, and enable "Share tab audio".'
              }
              renderOverlay={({ isFullscreen }) => (
                <FullscreenChatOverlay isFullscreen={isFullscreen} />
              )}
            />
          ) : (
            <VideoPlayer
              stream={remoteDisplayStream}
              waitingMessage={
                (room?.sharing.mode ?? "none") !== "none"
                  ? "Connecting to the host\u2019s stream\u2026"
                  : "The host is not sharing yet. The stream will appear here automatically."
              }
              connectionStatus={hostPeerStatus}
              quality={hostPeerStats?.quality ?? "unknown"}
              onReconnect={() => useRoomStore.getState().reconnectPeers()}
              showReconnect
              renderOverlay={({ isFullscreen }) => (
                <FullscreenChatOverlay isFullscreen={isFullscreen} />
              )}
            />
          )}

          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2">
            {isHost ? (
              <>
                {sharingActive ? (
                  <>
                    <Button variant="danger" onClick={() => capture.stop()}>
                      Stop sharing
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => void capture.start()}
                      title="Pick a different tab; the stream switches for everyone"
                    >
                      Switch tab
                    </Button>
                  </>
                ) : (
                  <Button
                    size="lg"
                    onClick={() => void capture.start()}
                    disabled={capture.state === "requesting" || !captureService.isSupported()}
                  >
                    {capture.state === "requesting" ? "Opening picker\u2026" : "Share a tab"}
                  </Button>
                )}
              </>
            ) : null}

            <MicControl onSpeakingChange={handleSpeakingChange} />

            <div className="ml-auto flex items-center gap-2">
              <DiagnosticsPanel />
              {isHost ? (
                <Button variant="danger" onClick={closeRoom}>
                  Close room
                </Button>
              ) : null}
              <Button variant="ghost" onClick={leave}>
                Leave room
              </Button>
            </div>
          </div>

          {/* Mobile panel toggles */}
          <div className="flex gap-2 lg:hidden">
            <Button
              variant="secondary"
              className="flex-1"
              aria-expanded={mobilePanel === "participants"}
              onClick={() =>
                setMobilePanel((p) => (p === "participants" ? "none" : "participants"))
              }
            >
              Participants
            </Button>
            <Button
              variant="secondary"
              className="flex-1"
              aria-expanded={mobilePanel === "chat"}
              onClick={() => setMobilePanel((p) => (p === "chat" ? "none" : "chat"))}
            >
              Chat
            </Button>
          </div>

          {/* Mobile panels */}
          {mobilePanel !== "none" ? (
            <div className="max-h-80 overflow-hidden rounded-xl border border-surface-700 bg-surface-900 lg:hidden">
              {mobilePanel === "participants" ? (
                <ParticipantList
                  volumes={volumes}
                  onVolumeChange={handleVolumeChange}
                  speakingIds={speakingIds}
                />
              ) : (
                <div className="h-80">
                  <ChatPanel />
                </div>
              )}
            </div>
          ) : null}
        </main>

        {/* Desktop sidebar */}
        <aside className="hidden w-80 shrink-0 flex-col border-l border-surface-700 bg-surface-900 lg:flex">
          <div className="max-h-[45%] overflow-y-auto border-b border-surface-700">
            <ParticipantList
              volumes={volumes}
              onVolumeChange={handleVolumeChange}
              speakingIds={speakingIds}
            />
          </div>
          <div className="min-h-0 flex-1">
            <ChatPanel />
          </div>
        </aside>
      </div>

      <p className="hidden" data-testid="self-id">
        {selfParticipantId}
      </p>
    </div>
  );
}

function CenteredNotice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <h1 className="text-2xl font-bold text-white">{title}</h1>
      {children}
    </main>
  );
}

function ConnectionBadge({ status }: { status: "connecting" | "connected" | "disconnected" }) {
  const map = {
    connected: { text: "Connected", className: "bg-emerald-600/20 text-emerald-300", dot: "bg-emerald-400" },
    connecting: { text: "Connecting", className: "bg-amber-600/20 text-amber-300", dot: "bg-amber-400" },
    disconnected: { text: "Reconnecting", className: "bg-red-600/20 text-red-300", dot: "bg-red-400" }
  }[status];
  return (
    <span
      role="status"
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${map.className}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${map.dot}`} />
      {map.text}
    </span>
  );
}

function Banner({
  tone,
  role,
  children,
  onDismiss
}: {
  tone: "warn" | "error";
  role: "status" | "alert";
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div
      role={role}
      className={`flex items-start gap-3 border-b px-4 py-2 text-sm ${
        tone === "warn"
          ? "border-amber-800/50 bg-amber-950/40 text-amber-200"
          : "border-red-800/50 bg-red-950/40 text-red-200"
      }`}
    >
      <div className="flex-1">{children}</div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notice"
          className="rounded px-1.5 text-lg leading-none opacity-70 hover:opacity-100"
        >
          {"\u00D7"}
        </button>
      ) : null}
    </div>
  );
}
