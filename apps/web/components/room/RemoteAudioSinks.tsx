"use client";

import { useEffect, useRef } from "react";
import { createSpeakingDetector } from "@/services/microphone";
import { useRoomStore } from "@/stores/roomStore";

interface RemoteAudioSinksProps {
  volumes: Record<string, { volume: number; locallyMuted: boolean }>;
  onSpeakingChange: (participantId: string, speaking: boolean) => void;
}

/**
 * Invisible audio elements playing each remote participant's microphone,
 * with per-participant volume/mute and speaking detection. Tab audio plays
 * through the main video element instead.
 */
export function RemoteAudioSinks({ volumes, onSpeakingChange }: RemoteAudioSinksProps) {
  const remoteMicStreams = useRoomStore((s) => s.remoteMicStreams);
  return (
    <>
      {remoteMicStreams.map(({ participantId, stream }) => (
        <AudioSink
          key={`${participantId}:${stream.id}`}
          participantId={participantId}
          stream={stream}
          volume={volumes[participantId]?.volume ?? 1}
          muted={volumes[participantId]?.locallyMuted ?? false}
          onSpeakingChange={onSpeakingChange}
        />
      ))}
    </>
  );
}

function AudioSink({
  participantId,
  stream,
  volume,
  muted,
  onSpeakingChange
}: {
  participantId: string;
  stream: MediaStream;
  volume: number;
  muted: boolean;
  onSpeakingChange: (participantId: string, speaking: boolean) => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.srcObject = stream;
    void audio.play().catch(() => {
      // Autoplay-blocked audio will start after the user's first gesture
      // (the room UI always involves one before voice chat matters).
    });
    return () => {
      audio.srcObject = null;
    };
  }, [stream]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.volume = volume;
      audio.muted = muted;
    }
  }, [volume, muted]);

  useEffect(() => {
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    const stop = createSpeakingDetector(track, (speaking) =>
      onSpeakingChange(participantId, speaking)
    );
    return () => {
      stop();
      onSpeakingChange(participantId, false);
    };
  }, [stream, participantId, onSpeakingChange]);

  return <audio ref={audioRef} autoPlay className="hidden" aria-hidden="true" />;
}
