import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { appError } from "@watchshare/shared";
import { useDisplayCapture } from "@/hooks/useDisplayCapture";
import {
  CaptureError,
  type CaptureResult,
  type DisplayCaptureService
} from "@/services/displayCapture";
import { FakeMediaStream, FakeMediaStreamTrack } from "./setup";

function makeResult(withAudio: boolean): CaptureResult {
  const video = new FakeMediaStreamTrack("video", {
    settings: { displaySurface: "browser" }
  });
  const audio = withAudio ? new FakeMediaStreamTrack("audio") : null;
  const stream = new FakeMediaStream(audio ? [video, audio] : [video]);
  return {
    stream: stream as unknown as MediaStream,
    videoTrack: video as unknown as MediaStreamTrack,
    audioTrack: audio as unknown as MediaStreamTrack | null,
    surfaceIsBrowserTab: true,
    capturedSelf: false
  };
}

function makeService(
  behavior: () => Promise<CaptureResult>
): DisplayCaptureService {
  return {
    isSupported: () => true,
    requestCapture: behavior
  };
}

describe("useDisplayCapture", () => {
  it("reaches active-with-audio when capture includes audio", async () => {
    const service = makeService(async () => makeResult(true));
    const { result } = renderHook(() => useDisplayCapture({ service }));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toBe("active-with-audio");
    expect(result.current.warning).toBeNull();
    expect(result.current.audioTrack).not.toBeNull();
  });

  it("warns but stays active when there is no audio track", async () => {
    const service = makeService(async () => makeResult(false));
    const { result } = renderHook(() => useDisplayCapture({ service }));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toBe("active-video-only");
    expect(result.current.warning?.code).toBe("CAPTURE_NO_AUDIO");
    expect(result.current.stream).not.toBeNull();
  });

  it("treats picker cancellation as a non-fatal return to idle", async () => {
    const service = makeService(async () => {
      throw new CaptureError(appError("CAPTURE_CANCELLED"));
    });
    const { result } = renderHook(() => useDisplayCapture({ service }));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toBe("idle");
    expect(result.current.error).toBeNull();
  });

  it("marks permission denial as the denied state", async () => {
    const service = makeService(async () => {
      throw new CaptureError(appError("CAPTURE_DENIED"));
    });
    const { result } = renderHook(() => useDisplayCapture({ service }));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toBe("denied");
    expect(result.current.error?.code).toBe("CAPTURE_DENIED");
  });

  it("reports unsupported browsers without calling capture", async () => {
    const requestCapture = vi.fn();
    const service: DisplayCaptureService = {
      isSupported: () => false,
      requestCapture
    };
    const { result } = renderHook(() => useDisplayCapture({ service }));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toBe("unsupported");
    expect(requestCapture).not.toHaveBeenCalled();
  });

  it("moves to stopped and fires onEnded when the browser toolbar stops the track", async () => {
    const captureResult = makeResult(true);
    const onEnded = vi.fn();
    const service = makeService(async () => captureResult);
    const { result } = renderHook(() => useDisplayCapture({ service, onEnded }));

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      (captureResult.videoTrack as unknown as FakeMediaStreamTrack).endFromBrowser();
    });

    await waitFor(() => expect(result.current.state).toBe("stopped"));
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(result.current.stream).toBeNull();
  });

  it("supports stop then restart", async () => {
    let call = 0;
    const service = makeService(async () => {
      call += 1;
      return makeResult(call % 2 === 1);
    });
    const onEnded = vi.fn();
    const onStarted = vi.fn();
    const { result } = renderHook(() => useDisplayCapture({ service, onEnded, onStarted }));

    await act(async () => {
      await result.current.start();
    });
    act(() => result.current.stop());
    expect(result.current.state).toBe("stopped");
    expect(onEnded).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("active-video-only");
    expect(onStarted).toHaveBeenCalledTimes(2);
  });

  it("ignores double-clicks while a request is in flight", async () => {
    let resolveCapture: ((r: CaptureResult) => void) | null = null;
    const requestCapture = vi.fn(
      () =>
        new Promise<CaptureResult>((resolve) => {
          resolveCapture = resolve;
        })
    );
    const service: DisplayCaptureService = { isSupported: () => true, requestCapture };
    const { result } = renderHook(() => useDisplayCapture({ service }));

    let first: Promise<unknown>;
    act(() => {
      first = result.current.start();
      void result.current.start();
    });
    expect(requestCapture).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCapture!(makeResult(true));
      await first;
    });
    expect(result.current.state).toBe("active-with-audio");
  });
});
