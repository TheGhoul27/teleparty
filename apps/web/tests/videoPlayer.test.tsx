import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VideoPlayer } from "@/components/room/VideoPlayer";
import { FakeMediaStream, FakeMediaStreamTrack } from "./setup";

const makeStream = (): MediaStream =>
  new FakeMediaStream([new FakeMediaStreamTrack("video"), new FakeMediaStreamTrack("audio")]) as unknown as MediaStream;

describe("VideoPlayer", () => {
  it("shows the waiting state when no stream is attached", () => {
    render(<VideoPlayer stream={null} waitingMessage="Waiting for the host to share." />);
    expect(screen.getByText("Waiting for the host to share.")).toBeTruthy();
  });

  it("attaches the remote stream to the video element", async () => {
    const stream = makeStream();
    render(<VideoPlayer stream={stream} waitingMessage="waiting" />);
    const video = screen.getByLabelText("Shared video stream") as HTMLVideoElement;
    await waitFor(() => expect(video.srcObject).toBe(stream));
  });

  it("offers 'Click to hear audio' when autoplay with sound is blocked, then unmutes on click", async () => {
    // First play() call (unmuted) rejects like a blocking autoplay policy;
    // subsequent (muted) calls succeed.
    let calls = 0;
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      writable: true,
      value: vi.fn(function (this: HTMLVideoElement) {
        calls += 1;
        if (calls === 1) return Promise.reject(new DOMException("blocked", "NotAllowedError"));
        return Promise.resolve();
      })
    });

    render(<VideoPlayer stream={makeStream()} waitingMessage="waiting" />);
    const button = await screen.findByRole("button", { name: "Click to hear audio" });
    const video = screen.getByLabelText("Shared video stream") as HTMLVideoElement;
    expect(video.muted).toBe(true);

    await userEvent.click(button);
    expect(video.muted).toBe(false);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Click to hear audio" })).toBeNull()
    );
  });

  it("shows the reconnecting overlay while the peer connection is interrupted", () => {
    render(
      <VideoPlayer
        stream={makeStream()}
        waitingMessage="waiting"
        connectionStatus="reconnecting"
      />
    );
    expect(screen.getByText(/Reconnecting/)).toBeTruthy();
  });

  it("offers a reconnect button when the connection failed", async () => {
    const onReconnect = vi.fn();
    render(
      <VideoPlayer
        stream={makeStream()}
        waitingMessage="waiting"
        connectionStatus="failed"
        onReconnect={onReconnect}
        showReconnect
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(onReconnect).toHaveBeenCalled();
  });

  it("keeps the host preview muted", () => {
    render(<VideoPlayer stream={makeStream()} isLocalPreview waitingMessage="waiting" />);
    const video = screen.getByLabelText(
      "Your shared tab preview (muted)"
    ) as HTMLVideoElement;
    expect(video.muted).toBe(true);
  });
});
