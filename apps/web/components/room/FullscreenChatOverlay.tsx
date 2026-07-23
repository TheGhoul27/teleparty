"use client";

import { useEffect, useRef, useState } from "react";
import { ChatPanel } from "@/components/room/ChatPanel";
import { useRoomStore } from "@/stores/roomStore";

interface FullscreenChatOverlayProps {
  isFullscreen: boolean;
}

/**
 * Chat for fullscreen viewing, rendered inside the video's fullscreen
 * container (the normal sidebar is outside the fullscreen element and therefore
 * hidden by the browser).
 *
 * Rather than overlaying the video, the open panel sits beside it as a flex
 * sibling so the video stage shrinks to make room - nothing is covered, and
 * the chat input stays fully usable. While closed, only a floating toggle
 * button shows; while open, the toggle hides and the panel takes over.
 *
 * While the panel is closed in fullscreen, incoming messages from other people
 * accumulate into an unread badge on the toggle button. Chat is considered
 * "read" whenever it is visible: either the panel is open, or we are not
 * fullscreen at all (the sidebar/mobile panel is showing it elsewhere).
 *
 * The component stays mounted regardless of fullscreen state so the unread
 * bookkeeping keeps up with the message list; it renders no UI unless we are
 * fullscreen.
 */
export function FullscreenChatOverlay({ isFullscreen }: FullscreenChatOverlayProps) {
  const messages = useRoomStore((s) => s.messages);
  const selfId = useRoomStore((s) => s.selfParticipantId);
  const allowChat = useRoomStore((s) => s.room?.settings.allowChat ?? true);

  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const prevCount = useRef(messages.length);

  const chatVisible = !isFullscreen || open;

  // Reset when chat is visible; otherwise count new messages from other people.
  useEffect(() => {
    const prev = prevCount.current;
    prevCount.current = messages.length;
    if (chatVisible) {
      setUnread(0);
      return;
    }
    if (messages.length <= prev) return; // deletion or no change
    const added = messages.slice(prev).filter(
      (m) => m.kind === "user" && m.participantId !== selfId
    ).length;
    if (added > 0) setUnread((u) => u + added);
  }, [messages, chatVisible, selfId]);

  // Collapse the panel whenever we leave fullscreen.
  useEffect(() => {
    if (!isFullscreen) setOpen(false);
  }, [isFullscreen]);

  if (!isFullscreen || !allowChat) return null;

  // Closed: a floating toggle button over the video, with an unread badge.
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open chat"
        aria-expanded={false}
        title="Open chat"
        className="absolute right-4 top-4 z-30 flex h-11 w-11 items-center justify-center rounded-full border border-surface-700 bg-surface-900/90 text-lg text-gray-100 shadow-lg backdrop-blur transition hover:bg-surface-800"
      >
        <span aria-hidden="true">{"\uD83D\uDCAC"}</span>
        {unread > 0 ? (
          <span
            className="absolute -right-1 -top-1 flex min-w-5 items-center justify-center rounded-full bg-accent-500 px-1.5 text-xs font-semibold text-white"
            aria-hidden="true"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
        <span className="sr-only">{unread > 0 ? `${unread} unread messages` : ""}</span>
      </button>
    );
  }

  // Open: an in-flow panel beside the video stage, so the video shrinks to
  // make room instead of being covered.
  return (
    <aside
      aria-label="Chat"
      className="relative z-10 flex h-full w-80 max-w-[40%] shrink-0 flex-col border-l border-surface-700 bg-surface-900"
    >
      <header className="flex items-center justify-between border-b border-surface-700 px-3 py-2">
        <span className="text-sm font-semibold text-gray-100">Chat</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close chat"
          title="Close chat"
          className="rounded px-2 py-1 text-sm text-gray-400 hover:text-gray-100"
        >
          <span aria-hidden="true">{"\u2715"}</span>
        </button>
      </header>
      <div className="min-h-0 flex-1">
        <ChatPanel />
      </div>
    </aside>
  );
}
