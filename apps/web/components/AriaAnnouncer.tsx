"use client";

import { useEffect, useRef, useState } from "react";
import { useRoomStore } from "@/stores/roomStore";

/**
 * Polite ARIA live region announcing room events (joins, leaves, share and
 * connection state changes) so screen-reader users are not left out.
 */
export function AriaAnnouncer() {
  const room = useRoomStore((s) => s.room);
  const hostDisconnected = useRoomStore((s) => s.hostDisconnected);
  const signalingStatus = useRoomStore((s) => s.signalingStatus);
  const [announcement, setAnnouncement] = useState("");

  const prevParticipants = useRef<Set<string>>(new Set());
  const prevNames = useRef<Map<string, string>>(new Map());
  const prevSharingMode = useRef<string>("none");
  const prevSignaling = useRef<string>("connected");
  const prevHostDisconnected = useRef(false);

  useEffect(() => {
    if (!room) return;
    const current = new Set(
      room.participants.filter((p) => p.status === "joined").map((p) => p.participantId)
    );
    const names = new Map(room.participants.map((p) => [p.participantId, p.displayName]));

    for (const id of current) {
      if (!prevParticipants.current.has(id) && prevParticipants.current.size > 0) {
        setAnnouncement(`${names.get(id) ?? "A participant"} joined the room.`);
      }
    }
    for (const id of prevParticipants.current) {
      if (!current.has(id)) {
        setAnnouncement(`${prevNames.current.get(id) ?? "A participant"} left the room.`);
      }
    }
    prevParticipants.current = current;
    prevNames.current = names;

    if (room.sharing.mode !== prevSharingMode.current) {
      if (room.sharing.mode === "none") setAnnouncement("Sharing stopped.");
      else if (room.sharing.mode === "video-only") setAnnouncement("Sharing started without audio.");
      else setAnnouncement("Sharing started with audio.");
      prevSharingMode.current = room.sharing.mode;
    }
  }, [room]);

  useEffect(() => {
    if (signalingStatus !== prevSignaling.current) {
      if (signalingStatus === "disconnected") setAnnouncement("Connection lost. Reconnecting.");
      else if (signalingStatus === "connected" && prevSignaling.current === "disconnected") {
        setAnnouncement("Connection restored.");
      }
      prevSignaling.current = signalingStatus;
    }
  }, [signalingStatus]);

  useEffect(() => {
    if (hostDisconnected !== prevHostDisconnected.current) {
      setAnnouncement(hostDisconnected ? "The host disconnected." : "The host reconnected.");
      prevHostDisconnected.current = hostDisconnected;
    }
  }, [hostDisconnected]);

  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      {announcement}
    </div>
  );
}
