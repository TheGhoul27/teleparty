"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { displayNameSchema, roomCodeSchema } from "@watchshare/shared";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { SignalingTrustHint } from "@/components/SignalingTrustHint";
import { browserGuidance, detectCapabilities, type BrowserCapabilities } from "@/lib/capabilities";
import { useRoomStore } from "@/stores/roomStore";

export default function LandingPage() {
  const router = useRouter();
  const createRoom = useRoomStore((s) => s.createRoom);
  const connect = useRoomStore((s) => s.connect);
  const signalingStatus = useRoomStore((s) => s.signalingStatus);

  const [caps, setCaps] = useState<BrowserCapabilities | null>(null);
  const [mode, setMode] = useState<"none" | "create" | "join">("none");
  const [displayName, setDisplayName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [password, setPassword] = useState("");
  const [waitingRoom, setWaitingRoom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const detected = detectCapabilities();
    setCaps(detected);
    if (!detected.canView) {
      router.replace("/unsupported");
      return;
    }
    connect();
  }, [router, connect]);

  const guidance = useMemo(() => (caps ? browserGuidance(caps) : null), [caps]);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const name = displayNameSchema.safeParse(displayName);
    if (!name.success) {
      setError("Enter a display name (up to 32 characters).");
      return;
    }
    setBusy(true);
    const result = await createRoom(name.data, {
      ...(password ? { password } : {}),
      waitingRoomEnabled: waitingRoom
    });
    setBusy(false);
    if (result.ok) {
      router.push(`/room/${result.roomCode}`);
    } else {
      setError(result.error.message);
    }
  };

  const handleJoin = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const parsed = roomCodeSchema.safeParse(roomCode);
    if (!parsed.success) {
      setError("Enter a valid room code (letters and numbers).");
      return;
    }
    router.push(`/room/${parsed.data}`);
  };

  return (
    // data-hydrated lets tests (and tooling) wait until the page is interactive.
    <main
      data-hydrated={caps !== null ? "true" : undefined}
      className="mx-auto flex min-h-full max-w-3xl flex-col gap-10 px-6 py-16"
    >
      <header className="flex flex-col gap-3">
        <h1 className="text-4xl font-bold tracking-tight text-white">
          Watch<span className="text-accent-400">Share</span>
        </h1>
        <p className="max-w-xl text-lg text-gray-300">
          Create a private room, share a browser tab with its audio, and watch together with
          friends in real time. No accounts, no uploads &mdash; media flows directly between
          browsers over WebRTC.
        </p>
      </header>

      <section aria-label="Get started" className="flex flex-col gap-6">
        {mode === "none" ? (
          <div className="flex flex-col gap-4 sm:flex-row">
            <Button size="lg" onClick={() => setMode("create")}>
              Create a room
            </Button>
            <Button size="lg" variant="secondary" onClick={() => setMode("join")}>
              Join a room
            </Button>
          </div>
        ) : null}

        {mode === "create" ? (
          <form
            onSubmit={handleCreate}
            className="flex max-w-md flex-col gap-4 rounded-xl border border-surface-700 bg-surface-900 p-6"
          >
            <h2 className="text-lg font-semibold text-white">Create a room</h2>
            <Field
              label="Your display name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={32}
              autoFocus
              required
            />
            <Field
              label="Room password (optional)"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              hint="Friends will need this to join."
              autoComplete="new-password"
            />
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input
                type="checkbox"
                checked={waitingRoom}
                onChange={(e) => setWaitingRoom(e.target.checked)}
                className="h-4 w-4 accent-indigo-500"
              />
              Approve each participant before they join (waiting room)
            </label>
            {error ? (
              <p role="alert" className="text-sm text-red-400">
                {error}
              </p>
            ) : null}
            <div className="flex gap-3">
              <Button type="submit" disabled={busy}>
                {busy ? "Creating\u2026" : "Create room"}
              </Button>
              <Button variant="ghost" onClick={() => setMode("none")}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}

        {mode === "join" ? (
          <form
            onSubmit={handleJoin}
            className="flex max-w-md flex-col gap-4 rounded-xl border border-surface-700 bg-surface-900 p-6"
          >
            <h2 className="text-lg font-semibold text-white">Join a room</h2>
            <Field
              label="Room code"
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
              placeholder="e.g. Q7RTX2WM"
              maxLength={16}
              autoFocus
              required
            />
            {error ? (
              <p role="alert" className="text-sm text-red-400">
                {error}
              </p>
            ) : null}
            <div className="flex gap-3">
              <Button type="submit">Join room</Button>
              <Button variant="ghost" onClick={() => setMode("none")}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </section>

      <section aria-label="Notices" className="flex flex-col gap-4 text-sm text-gray-400">
        <SignalingTrustHint status={signalingStatus} />
        {guidance ? (
          <p className="rounded-lg border border-amber-700/50 bg-amber-950/40 p-3 text-amber-200">
            {guidance}
          </p>
        ) : null}
        <div className="rounded-lg border border-surface-700 bg-surface-900 p-4">
          <h2 className="mb-2 font-semibold text-gray-200">Browser compatibility</h2>
          <p>
            Hosting with tab audio works best in current desktop Chromium browsers (Chrome, Edge).
            Firefox and Safari can join as viewers; their tab-audio capture support is limited.
            Mobile browsers can watch, but cannot reliably host a tab share.
          </p>
        </div>
        <div className="rounded-lg border border-surface-700 bg-surface-900 p-4">
          <h2 className="mb-2 font-semibold text-gray-200">Privacy</h2>
          <p>
            Tab capture always requires your explicit permission &mdash; WatchShare can never see
            your screen until you click share and pick a source in your browser&rsquo;s own dialog.
            Video and audio travel over direct WebRTC peer connections; when a direct connection is
            impossible they may be relayed (encrypted) through a TURN server. Nothing is recorded
            or stored on our servers. Only share content you own or are permitted to share.
          </p>
        </div>
      </section>
    </main>
  );
}
