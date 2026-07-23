import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, RoomState } from "@watchshare/shared";
import { ChatPanel } from "@/components/room/ChatPanel";
import { useRoomStore } from "@/stores/roomStore";

const baseRoom: RoomState = {
  roomCode: "ABCD1234",
  createdAt: 0,
  settings: {
    maxParticipants: 5,
    hasPassword: false,
    waitingRoomEnabled: false,
    allowMicrophones: true,
    allowChat: true,
    expiresAt: Date.now() + 60_000
  },
  participants: [],
  hostParticipantId: "p_host",
  hostConnected: true,
  sharing: { mode: "none", surfaceIsBrowserTab: null, startedAt: null },
  closed: false
};

const message = (body: string, displayName = "Mallory"): ChatMessage => ({
  messageId: `m_${Math.random().toString(36).slice(2)}`,
  roomCode: "ABCD1234",
  participantId: "p_1",
  displayName,
  body,
  sentAt: Date.now(),
  kind: "user"
});

beforeEach(() => {
  useRoomStore.setState({ room: baseRoom, messages: [], isHost: false });
});

describe("ChatPanel", () => {
  it("renders message bodies as inert plain text, never HTML", () => {
    const xss = '<img src=x onerror="window.__pwned = true"><script>window.__pwned = true</script>';
    useRoomStore.setState({ messages: [message(xss)] });
    const { container } = render(<ChatPanel />);

    expect(screen.getByText(xss)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it("renders XSS attempts in display names as text", () => {
    const evilName = "<svg onload=alert(1)>";
    useRoomStore.setState({ messages: [message("hi", evilName)] });
    const { container } = render(<ChatPanel />);
    expect(screen.getByText(evilName)).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("shows system messages styled differently", () => {
    useRoomStore.setState({
      messages: [{ ...message("Viewer joined the room."), kind: "system" }]
    });
    render(<ChatPanel />);
    expect(screen.getByText("Viewer joined the room.")).toBeTruthy();
  });

  it("shows a notice when chat is disabled", () => {
    useRoomStore.setState({
      room: { ...baseRoom, settings: { ...baseRoom.settings, allowChat: false } }
    });
    render(<ChatPanel />);
    expect(screen.getByText("Chat is disabled for this room.")).toBeTruthy();
  });
});
