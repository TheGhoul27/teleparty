"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { useRoomStore } from "@/stores/roomStore";

/**
 * Detailed connection statistics, hidden behind a toggle so raw networking
 * details are never forced on ordinary users. Shows aggregate figures only -
 * no IP addresses or candidate contents.
 */
export function DiagnosticsPanel() {
  const [open, setOpen] = useState(false);
  const peerStats = useRoomStore((s) => s.peerStats);
  const peerStatuses = useRoomStore((s) => s.peerStatuses);
  const room = useRoomStore((s) => s.room);

  const nameFor = (participantId: string): string =>
    room?.participants.find((p) => p.participantId === participantId)?.displayName ??
    "Participant";

  return (
    <div className="flex flex-col gap-2">
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? "Hide diagnostics" : "Diagnostics"}
      </Button>
      {open ? (
        <div className="max-h-64 overflow-y-auto rounded-lg border border-surface-700 bg-surface-900 p-3 text-xs text-gray-300">
          {Object.keys(peerStats).length === 0 ? (
            <p>No active peer connections.</p>
          ) : (
            Object.entries(peerStats).map(([participantId, stats]) => (
              <dl key={participantId} className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1">
                <dt className="col-span-2 font-semibold text-gray-100">
                  {nameFor(participantId)}{" "}
                  <span className="font-normal text-gray-400">
                    ({peerStatuses[participantId] ?? "unknown"}
                    {stats.usingTurnRelay ? ", TURN relay" : ", direct"})
                  </span>
                </dt>
                <dt>Round-trip time</dt>
                <dd>{stats.roundTripTimeMs !== null ? `${stats.roundTripTimeMs} ms` : "-"}</dd>
                <dt>Packet loss</dt>
                <dd>{stats.packetLossPercent !== null ? `${stats.packetLossPercent}%` : "-"}</dd>
                <dt>Outgoing bitrate</dt>
                <dd>
                  {stats.availableOutgoingBitrateKbps !== null
                    ? `${stats.availableOutgoingBitrateKbps} kbps`
                    : "-"}
                </dd>
                <dt>Frame rate</dt>
                <dd>{stats.framesPerSecond !== null ? `${stats.framesPerSecond} fps` : "-"}</dd>
                <dt>Resolution</dt>
                <dd>
                  {stats.frameWidth && stats.frameHeight
                    ? `${stats.frameWidth}\u00D7${stats.frameHeight}`
                    : "-"}
                </dd>
                <dt>Frames dropped</dt>
                <dd>{stats.framesDropped ?? "-"}</dd>
                <dt>Audio jitter</dt>
                <dd>{stats.audioJitterMs !== null ? `${stats.audioJitterMs} ms` : "-"}</dd>
                <dt>Quality</dt>
                <dd className="capitalize">{stats.quality}</dd>
              </dl>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
