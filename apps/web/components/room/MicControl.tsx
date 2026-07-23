"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  createMicrophoneService,
  createSpeakingDetector,
  MicrophoneError
} from "@/services/microphone";
import { useRoomStore } from "@/stores/roomStore";

const micService = createMicrophoneService();

interface MicControlProps {
  onSpeakingChange: (participantId: string, speaking: boolean) => void;
}

/**
 * Microphone voice chat, fully separate from tab audio. Access is only
 * requested after the user clicks "Enable microphone".
 */
export function MicControl({ onSpeakingChange }: MicControlProps) {
  const micEnabled = useRoomStore((s) => s.micEnabled);
  const micAllowed = useRoomStore((s) => s.micAllowed);
  const allowMicrophones = useRoomStore((s) => s.room?.settings.allowMicrophones ?? true);
  const setMicrophoneTrack = useRoomStore((s) => s.setMicrophoneTrack);
  const selfId = useRoomStore((s) => s.selfParticipantId);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopDetectorRef = useRef<(() => void) | null>(null);

  const stopDetector = useCallback(() => {
    stopDetectorRef.current?.();
    stopDetectorRef.current = null;
    if (selfId) onSpeakingChange(selfId, false);
  }, [onSpeakingChange, selfId]);

  useEffect(() => () => stopDetector(), [stopDetector]);

  const enable = async (nextDeviceId?: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const track = await micService.request(nextDeviceId || deviceId || undefined);
      stopDetector();
      await setMicrophoneTrack(track);
      if (selfId) {
        stopDetectorRef.current = createSpeakingDetector(track, (speaking) =>
          onSpeakingChange(selfId, speaking)
        );
      }
      // Device labels only populate after permission is granted.
      setDevices(await micService.listInputDevices());
    } catch (err) {
      setError(err instanceof MicrophoneError ? err.appError.message : "Could not start the microphone.");
    } finally {
      setBusy(false);
    }
  };

  const disable = async (): Promise<void> => {
    stopDetector();
    await setMicrophoneTrack(null);
  };

  if (!allowMicrophones) {
    return <p className="text-xs text-gray-500">Microphones are disabled in this room.</p>;
  }
  if (!micAllowed) {
    return <p className="text-xs text-amber-300">The host has disabled your microphone.</p>;
  }
  if (!micService.isSupported()) {
    return <p className="text-xs text-gray-500">This browser does not support microphones.</p>;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {micEnabled ? (
        <Button size="sm" variant="secondary" onClick={disable} aria-pressed="true">
          <span aria-hidden="true">{"\uD83C\uDF99"}</span> Mic on
        </Button>
      ) : (
        <Button size="sm" variant="secondary" onClick={() => enable()} disabled={busy} aria-pressed="false">
          {busy ? "Starting\u2026" : "Enable microphone"}
        </Button>
      )}

      {devices.length > 0 ? (
        <label className="flex items-center gap-1 text-xs text-gray-400">
          <span className="sr-only">Microphone input device</span>
          <select
            value={deviceId}
            onChange={(e) => {
              setDeviceId(e.target.value);
              if (micEnabled) void enable(e.target.value);
            }}
            aria-label="Microphone input device"
            className="max-w-40 rounded border border-surface-700 bg-surface-900 px-2 py-1 text-xs text-gray-200"
          >
            <option value="">Default device</option>
            {devices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || "Microphone"}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {micEnabled ? (
        <span className="text-[11px] text-gray-500">Headphones recommended to avoid echo.</span>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
