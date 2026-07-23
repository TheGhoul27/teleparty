import { appError, type AppError } from "@watchshare/shared";

export class MicrophoneError extends Error {
  readonly appError: AppError;
  constructor(error: AppError) {
    super(error.message);
    this.appError = error;
  }
}

export interface MicrophoneService {
  isSupported(): boolean;
  listInputDevices(): Promise<MediaDeviceInfo[]>;
  /**
   * Requests the microphone. Only ever call from an explicit user gesture
   * ("Enable microphone" button). Echo cancellation and noise suppression
   * are enabled - these are mic constraints and are never applied to tab audio.
   */
  request(deviceId?: string): Promise<MediaStreamTrack>;
}

export function createMicrophoneService(): MicrophoneService {
  return {
    isSupported(): boolean {
      return (
        typeof navigator !== "undefined" &&
        Boolean(navigator.mediaDevices) &&
        typeof navigator.mediaDevices.getUserMedia === "function"
      );
    },

    async listInputDevices(): Promise<MediaDeviceInfo[]> {
      if (!this.isSupported() || typeof navigator.mediaDevices.enumerateDevices !== "function") {
        return [];
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter((d) => d.kind === "audioinput");
      } catch {
        return [];
      }
    },

    async request(deviceId?: string): Promise<MediaStreamTrack> {
      if (!this.isSupported()) {
        throw new MicrophoneError(
          appError("CAPTURE_UNSUPPORTED", "This browser does not support microphone capture.")
        );
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        const track = stream.getAudioTracks()[0];
        if (!track) {
          throw new MicrophoneError(
            appError("UNKNOWN", "The microphone did not provide an audio track.")
          );
        }
        return track;
      } catch (err) {
        if (err instanceof MicrophoneError) throw err;
        if (err instanceof DOMException && err.name === "NotAllowedError") {
          throw new MicrophoneError(
            appError("CAPTURE_DENIED", "Microphone permission was denied.")
          );
        }
        if (err instanceof DOMException && err.name === "NotFoundError") {
          throw new MicrophoneError(appError("UNKNOWN", "No microphone was found."));
        }
        throw new MicrophoneError(appError("UNKNOWN", "Could not start the microphone."));
      }
    }
  };
}

/**
 * Lightweight speaking detector using the Web Audio API. Returns a stop
 * function; invokes the callback with true/false as speech starts/stops.
 */
export function createSpeakingDetector(
  track: MediaStreamTrack,
  onChange: (speaking: boolean) => void
): () => void {
  if (typeof AudioContext === "undefined") return () => undefined;

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  let speaking = false;
  let quietFrames = 0;
  const interval = setInterval(() => {
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (const value of data) sum += value;
    const level = sum / data.length;
    if (level > 12) {
      quietFrames = 0;
      if (!speaking) {
        speaking = true;
        onChange(true);
      }
    } else if (speaking) {
      quietFrames += 1;
      if (quietFrames > 4) {
        speaking = false;
        onChange(false);
      }
    }
  }, 150);

  return () => {
    clearInterval(interval);
    source.disconnect();
    void ctx.close().catch(() => undefined);
  };
}
