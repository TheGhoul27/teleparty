import "@testing-library/dom";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// RTL auto-cleanup only hooks in with vitest globals enabled; do it manually.
afterEach(() => cleanup());

// jsdom has no MediaStream/MediaStreamTrack; provide minimal fakes that the
// capture/webrtc units rely on.

export class FakeMediaStreamTrack extends EventTarget {
  kind: string;
  id: string;
  label: string;
  readyState: "live" | "ended" = "live";
  contentHint = "";
  muted = false;
  private settings: Record<string, unknown>;

  constructor(kind: string, options?: { label?: string; settings?: Record<string, unknown> }) {
    super();
    this.kind = kind;
    this.id = `${kind}-${Math.random().toString(36).slice(2)}`;
    this.label = options?.label ?? `${kind} track`;
    this.settings = options?.settings ?? {};
  }

  getSettings(): Record<string, unknown> {
    return this.settings;
  }

  stop(): void {
    this.readyState = "ended";
  }

  /** Simulates the browser's native "Stop sharing" toolbar. */
  endFromBrowser(): void {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

export class FakeMediaStream {
  id = `stream-${Math.random().toString(36).slice(2)}`;
  private tracks: FakeMediaStreamTrack[];

  constructor(tracks: FakeMediaStreamTrack[] = []) {
    this.tracks = [...tracks];
  }

  getTracks(): FakeMediaStreamTrack[] {
    return [...this.tracks];
  }
  getVideoTracks(): FakeMediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === "video");
  }
  getAudioTracks(): FakeMediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  addTrack(track: FakeMediaStreamTrack): void {
    this.tracks.push(track);
  }
}

Object.assign(globalThis, {
  MediaStream: FakeMediaStream,
  MediaStreamTrack: FakeMediaStreamTrack
});

// jsdom's HTMLMediaElement.play is unimplemented; default to resolving.
Object.defineProperty(HTMLMediaElement.prototype, "play", {
  configurable: true,
  writable: true,
  value: () => Promise.resolve()
});
Object.defineProperty(HTMLMediaElement.prototype, "pause", {
  configurable: true,
  writable: true,
  value: () => undefined
});
