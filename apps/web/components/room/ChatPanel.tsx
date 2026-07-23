"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { LIMITS } from "@watchshare/shared";
import { Button } from "@/components/ui/Button";
import { useRoomStore } from "@/stores/roomStore";

/**
 * Room chat. Message bodies are always rendered as React text nodes (plain
 * text), never as HTML, so user content cannot inject markup.
 */
export function ChatPanel() {
  const messages = useRoomStore((s) => s.messages);
  const sendChat = useRoomStore((s) => s.sendChat);
  const deleteChat = useRoomStore((s) => s.deleteChat);
  const isHost = useRoomStore((s) => s.isHost);
  const allowChat = useRoomStore((s) => s.room?.settings.allowChat ?? true);
  const selfId = useRoomStore((s) => s.selfParticipantId);

  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const list = listRef.current;
    if (list && stickToBottom.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages]);

  const handleScroll = (): void => {
    const list = listRef.current;
    if (!list) return;
    stickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  };

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setSendError(null);
    setDraft("");
    const error = await sendChat(body);
    if (error) {
      setSendError(error.message);
      setDraft(body);
    }
  };

  if (!allowChat) {
    return (
      <p className="p-4 text-sm text-gray-400">Chat is disabled for this room.</p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ol
        ref={listRef}
        onScroll={handleScroll}
        aria-label="Chat messages"
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3"
      >
        {messages.map((message) => (
          <li
            key={message.messageId}
            className={`group rounded-lg px-3 py-1.5 text-sm ${
              message.kind === "system"
                ? "text-gray-500 italic"
                : "bg-surface-800 text-gray-200"
            }`}
          >
            {message.kind === "user" ? (
              <div className="flex items-baseline gap-2">
                <span
                  className={`font-semibold ${
                    message.participantId === selfId ? "text-accent-300" : "text-gray-100"
                  }`}
                >
                  {message.displayName}
                </span>
                <time
                  dateTime={new Date(message.sentAt).toISOString()}
                  className="text-[10px] text-gray-500"
                >
                  {new Date(message.sentAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit"
                  })}
                </time>
                {isHost ? (
                  <button
                    type="button"
                    onClick={() => deleteChat(message.messageId)}
                    aria-label={`Delete message from ${message.displayName}`}
                    className="ml-auto hidden text-xs text-red-400 hover:text-red-300 group-hover:block"
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            ) : null}
            <p className="whitespace-pre-wrap break-words">{message.body}</p>
          </li>
        ))}
        {messages.length === 0 ? (
          <li className="text-sm text-gray-500">No messages yet. Say hi!</li>
        ) : null}
      </ol>

      {sendError ? (
        <p role="alert" className="px-3 pb-1 text-xs text-red-400">
          {sendError}
        </p>
      ) : null}

      <form onSubmit={handleSubmit} className="flex gap-2 border-t border-surface-700 p-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={LIMITS.chatMessageMax}
          placeholder="Send a message"
          aria-label="Chat message"
          className="min-w-0 flex-1 rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-500"
        />
        <Button type="submit" size="sm" disabled={!draft.trim()}>
          Send
        </Button>
      </form>
    </div>
  );
}
