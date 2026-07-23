# WatchShare architecture

WatchShare lets a host create a private room, manually share a browser tab
(with tab audio where the browser supports it), and stream it to a small
group of viewers over WebRTC. Chat and optional microphone voice chat ride
alongside.

## System overview

```text
┌───────────────┐        WebSocket (Socket.IO)        ┌──────────────────┐
│  Next.js web  │ ◄─────────────────────────────────► │ Signaling server │
│  (apps/web)   │   rooms, presence, chat, SDP/ICE    │ (apps/signaling) │
└──────┬────────┘                                     └────────┬─────────┘
       │                                                       │
       │  WebRTC media (SRTP), peer-to-peer                    │ Redis
       │  host ──► viewer (star topology)                      │ (optional,
       ▼                                                       ▼  scaling)
┌───────────────┐     TURN relay when direct fails        ┌─────────┐
│ Other browsers│ ◄─────────────────────────────────────► │ coturn  │
└───────────────┘                                         └─────────┘
```

All room state is ephemeral by design: rooms, participants, and chat live in
the signaling server's memory and vanish when the room closes, expires, or
the process restarts. There is no database.

Three workspaces:

| Package             | Role                                                          |
| ------------------- | ------------------------------------------------------------- |
| `packages/shared`   | Zod schemas, typed Socket.IO events, error codes, domain types |
| `apps/signaling`    | Fastify + Socket.IO server: rooms, auth, relay, rate limiting  |
| `apps/web`          | Next.js App Router UI: capture, WebRTC, player, chat           |

The shared package is the contract: both sides import the same event maps
(`ClientToServerEvents`, `ServerToClientEvents`) and zod schemas, so the
protocol cannot drift.

## Media topology

The MVP uses a **star of native RTCPeerConnections**: the host maintains one
outbound connection per viewer (`Map<participantId, RTCPeerConnection>`),
each viewer maintains exactly one connection to the host. This is simple and
serverless for media, but the host uploads one copy of the stream per viewer
— rooms are deliberately capped (default 5 participants) and the product
makes no claim of supporting large rooms.

`PeerConnectionManager` (apps/web/services/webrtc) hides the topology behind
an interface: it accepts local tracks (`setDisplayTracks`,
`setMicrophoneTrack`), emits remote tracks, and talks to signaling through a
`SignalingAdapter`. Migrating to an SFU (LiveKit, mediasoup, Janus) later
means swapping this class without touching the room UI.

### Negotiation

Perfect negotiation: the host is the impolite peer, viewers are polite. Glare
(simultaneous offers) resolves deterministically; duplicate/stale answers are
dropped. ICE candidates arriving before the remote description are queued.

Track lifecycle rules:

- Start sharing → `replaceTrack` onto existing senders when possible,
  otherwise `addTrack` (triggers renegotiation automatically).
- Switch tab → `replaceTrack` only; no renegotiation, no rebuild.
- Stop sharing → `replaceTrack(null)`; transceivers stay warm for restart.
- Late viewer → new connection gets current tracks + a fresh offer for that
  viewer only.

### Voice chat

Microphone audio is always a separate track (never mixed into tab audio) and
travels in a stream whose id marks it as mic audio. Because viewers only
connect to the host, the host forwards each viewer's mic track to the other
viewers (`watchshare-mic:<participantId>` stream ids preserve attribution).

### Failure recovery

`connectionState === "failed"` triggers one ICE restart, then bounded
exponential backoff (max 3 attempts). Viewers ask the host to restart (the
host owns offers); the host calls `restartIce()`. After the limit, the UI
shows a Reconnect button — no infinite loops.

## Signaling server

- **Fastify** serves `/health`, `/ready`, and the REST endpoints
  (`/api/rooms`, `/api/rooms/:code/status|join|close`,
  `/api/turn-credentials`).
- **Socket.IO** carries live events. Origin is validated on both the CORS
  layer and the raw upgrade (`allowRequest`).
- Every message is zod-validated. The server never trusts client-sent
  identity: participant ids are assigned server-side and resolved from
  `socket.data`, host-only actions check the sender's role in the room
  record, and signaling relay verifies both peers are joined members of the
  same room and that one of them is the host (star topology enforcement).
- Rate limiting: room creation and join per IP, password attempts per room,
  chat and signaling frequency per connection. SDP is capped at 128 KiB,
  candidates at 2 KiB.
- SDP/ICE bodies are relayed and immediately discarded — never stored or
  logged (pino redaction enforces this).

### State layers

| Layer     | Contents                                        | Lifetime            |
| --------- | ----------------------------------------------- | ------------------- |
| In-memory | Authoritative room + participant records        | Room TTL            |
| Redis     | Presence mirror + Socket.IO adapter (optional)  | Room TTL            |

Redis is optional: without it the server runs fully in-memory (single
instance). With Redis, Socket.IO uses the redis adapter for horizontal
fan-out. A room's sockets are sticky to one instance. Chat messages are
relayed and never stored anywhere.

### Tokens

- **Host management token**: returned once at creation; only an HMAC-SHA256
  hash is stored. Rejoining with it restores host ownership.
- **Reconnect token**: per participant, rotated on every use, HMAC-hashed at
  rest, stored client-side in session storage (dies with the tab).
- **Room password**: Argon2id hash; join failures return the same generic
  error whether the room requires a password or the password was wrong.

### Host disconnection

When the host's socket drops, the room stays open for
`HOST_RECONNECT_GRACE_SECONDS` (default 90). Viewers see a "host is
reconnecting" notice; media keeps flowing if the WebRTC path survived. If the
host returns (management or reconnect token) the grace timer is cancelled;
otherwise the room closes with `host-timeout`. Host privileges are never
transferred automatically.

## Capture pipeline (host)

`useDisplayCapture` + `DisplayCaptureService` wrap `getDisplayMedia`:

1. Capture starts only from the explicit "Share a tab" click.
2. Optional constraints (`displaySurface: "browser"`, `surfaceSwitching`,
   `selfBrowserSurface: "exclude"`, `systemAudio`) are feature-detected and
   applied only where supported.
3. After capture: video/audio tracks inspected, `displaySurface` read from
   settings, `contentHint = "detail"` set, `ended` listener wired so the
   browser's native "Stop sharing" toolbar updates room state automatically.
4. Missing audio → non-blocking warning with instructions (pick a browser
   tab, enable "Share tab audio"); video-only sharing continues.
5. A black-frame sampler flags likely protected (DRM) content and shows an
   informational notice. WatchShare never attempts to bypass protection.

Capture states: `idle | requesting | active-with-audio | active-video-only |
stopped | denied | unsupported | error`. Picker cancellation returns to
`idle` and is never treated as an error.

## Data model

Everything is in-memory: `RoomRecord` (code, hashed tokens, settings,
timestamps, sharing state) holds `ParticipantRecord`s (pseudonymous id,
display name, role, status, joined/left/kicked timestamps). No SDP, no
candidates, no media, no chat bodies, no IP histories are ever persisted.
Chat dies with the room; tokens die with the browser tab (session storage).

## Scaling notes and limits

- Host upload bandwidth is the ceiling: ~2.5 Mbps per viewer at 1080p. Four
  viewers ≈ 10 Mbps upstream. This is why rooms are small.
- The signaling server is stateful per room; scale-out requires sticky
  sessions per room plus the Redis adapter (already wired).
- Media never touches the application servers; only TURN sees (encrypted)
  packets when relaying.
