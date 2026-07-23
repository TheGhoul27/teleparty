"use client";

import { useState } from "react";
import type { Participant } from "@watchshare/shared";
import { Button } from "@/components/ui/Button";
import { useRoomStore } from "@/stores/roomStore";

interface ParticipantVolume {
  volume: number;
  locallyMuted: boolean;
}

interface ParticipantListProps {
  /** Per-participant local audio controls, owned by RoomView. */
  volumes: Record<string, ParticipantVolume>;
  onVolumeChange: (participantId: string, patch: Partial<ParticipantVolume>) => void;
  speakingIds: Set<string>;
}

export function ParticipantList({ volumes, onVolumeChange, speakingIds }: ParticipantListProps) {
  const room = useRoomStore((s) => s.room);
  const selfId = useRoomStore((s) => s.selfParticipantId);
  const isHost = useRoomStore((s) => s.isHost);
  const waiting = useRoomStore((s) => s.waitingParticipants);
  const approve = useRoomStore((s) => s.approveParticipant);
  const reject = useRoomStore((s) => s.rejectParticipant);
  const kick = useRoomStore((s) => s.kickParticipant);
  const setMicPermission = useRoomStore((s) => s.setMicPermission);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (!room) return null;
  const joined = room.participants.filter((p) => p.status === "joined");

  const renderParticipant = (participant: Participant) => {
    const isSelf = participant.participantId === selfId;
    const speaking = speakingIds.has(participant.participantId);
    const vol = volumes[participant.participantId] ?? { volume: 1, locallyMuted: false };
    const expanded = expandedId === participant.participantId;

    return (
      <li
        key={participant.participantId}
        className="rounded-lg border border-surface-700 bg-surface-800 px-3 py-2"
      >
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${
              speaking ? "bg-emerald-400" : participant.micEnabled ? "bg-emerald-800" : "bg-surface-700"
            }`}
          />
          <span className="truncate text-sm text-gray-100">
            {participant.displayName}
            {isSelf ? <span className="text-gray-400"> (you)</span> : null}
          </span>
          {participant.role === "host" ? (
            <span className="rounded bg-accent-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-300">
              Host
            </span>
          ) : null}
          {participant.micEnabled ? (
            <span className="text-xs" title="Microphone on" aria-label="Microphone on">
              <span aria-hidden="true">{"\uD83C\uDF99"}</span>
            </span>
          ) : null}
          {speaking ? <span className="sr-only">speaking</span> : null}
          {!isSelf ? (
            <button
              type="button"
              onClick={() => setExpandedId(expanded ? null : participant.participantId)}
              aria-expanded={expanded}
              aria-label={`Options for ${participant.displayName}`}
              className="ml-auto rounded px-1.5 text-gray-400 hover:bg-surface-700"
            >
              <span aria-hidden="true">{"\u22EF"}</span>
            </button>
          ) : null}
        </div>

        {expanded && !isSelf ? (
          <div className="mt-2 flex flex-col gap-2 border-t border-surface-700 pt-2">
            <label className="flex items-center gap-2 text-xs text-gray-300">
              Volume
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={vol.volume}
                onChange={(e) =>
                  onVolumeChange(participant.participantId, { volume: Number(e.target.value) })
                }
                aria-label={`Volume for ${participant.displayName}`}
                className="flex-1 accent-indigo-400"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  onVolumeChange(participant.participantId, { locallyMuted: !vol.locallyMuted })
                }
              >
                {vol.locallyMuted ? "Unmute for me" : "Mute for me"}
              </Button>
              {isHost && participant.role !== "host" ? (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setMicPermission(participant.participantId, !participant.micEnabled)}
                    title="Toggle whether this participant may use their microphone"
                  >
                    {participant.micEnabled ? "Disable their mic" : "Allow their mic"}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => kick(participant.participantId)}
                  >
                    Remove
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      {isHost && waiting.length > 0 ? (
        <section aria-label="Waiting for approval" className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-300">
            Waiting for approval
          </h3>
          <ul className="flex flex-col gap-2">
            {waiting.map((participant) => (
              <li
                key={participant.participantId}
                className="flex items-center gap-2 rounded-lg border border-amber-700/40 bg-amber-950/30 px-3 py-2"
              >
                <span className="truncate text-sm text-gray-100">{participant.displayName}</span>
                <div className="ml-auto flex gap-2">
                  <Button size="sm" onClick={() => approve(participant.participantId)}>
                    Admit
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => reject(participant.participantId)}
                  >
                    Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Participants">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
          Participants ({joined.length}/{room.settings.maxParticipants})
        </h3>
        <ul className="flex flex-col gap-2">{joined.map(renderParticipant)}</ul>
      </section>
    </div>
  );
}
