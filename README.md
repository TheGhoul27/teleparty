# WatchShare

Create a private room, manually share a browser tab (with tab audio where the
browser supports it), and watch together with friends in real time. A
lightweight watch-party app in the spirit of screen-sharing rooms — built on
open browser APIs, with no accounts and no media ever touching the server.

WatchShare is intended only for content the host owns, has permission to
share, or is legally permitted to display privately. It never bypasses DRM,
HDCP, paywalls, or any other protection; protected content that captures as a
black screen is reported as such and left alone. See `docs/privacy.md`.

## How it works

- The host clicks **Share a tab**; the browser's own picker chooses what is
  captured (WatchShare cannot see anything before that).
- Media streams peer-to-peer over WebRTC in a star topology (host → each
  viewer), relayed through TURN only when a direct path is impossible.
- A persistent Node signaling server coordinates rooms, presence, chat, and
  SDP/ICE exchange over Socket.IO. Nothing is recorded.
- Designed for small rooms (2-4 viewers): the host uploads one stream copy
  per viewer.

## Repository layout

```text
watchshare/
  apps/
    web/            Next.js frontend (capture, WebRTC, player, chat)
    signaling/      Fastify + Socket.IO signaling server
  packages/
    shared/         Zod schemas, typed socket events, shared types/errors
  infrastructure/
    coturn/         TURN server config + deployment guide
    docker/         Dockerfiles
  docs/             architecture, browser support, deployment, privacy, manual QA
  docker-compose.yml
```

## Quick start

Requirements: Node.js ≥ 20.

```bash
cp .env.example .env        # defaults work for local development
npm install
npm run dev                 # web http://localhost:3000, signaling :4000
```

Open http://localhost:3000, create a room, and open the invite link in a
second browser window to watch. Hosting with tab audio works best in desktop
Chrome or Edge (pick a **browser tab** and check **Share tab audio**).

There is no database: rooms, presence, and chat live in memory and disappear
when the room closes. Redis is optional and only needed for multi-instance
scaling. For the full container stack:

```bash
docker compose up --build
```

### Testing from a phone or another device on your LAN

The web app listens on all interfaces, so other devices can open
`http://<your-pc-ip>:3000`. In development the signaling server automatically
accepts private-network origins, and the frontend connects to signaling on the
same host it loaded the page from — so **viewing and chat work over plain HTTP
with no extra setup**.

Browsers only expose the screen-capture APIs on secure origins, so *hosting*
from a non-localhost address requires HTTPS:

```bash
npm run dev:https           # web on https://localhost:3000 (self-signed cert)
```

Next generates a certificate in `apps/web/certificates/` on the first run. In
development the signaling server picks up that same certificate automatically
and serves HTTPS/WSS too (its startup log shows `https: true`). If signaling
started before the certificate existed — only possible on the very first
`dev:https` run — restart once. `TLS_CERT_FILE`/`TLS_KEY_FILE` in `.env`
override the auto-detected pair.

On the other device, open `https://<your-pc-ip>:3000`, accept the self-signed
certificate warning, then visit `https://<your-pc-ip>:4000/health` once and
accept that warning too (otherwise the browser silently blocks the WebSocket).
For a smoother experience, use a tunnel (ngrok, cloudflared) that gives you a
trusted HTTPS URL.

## Scripts

| Command                    | Effect                                   |
| -------------------------- | ---------------------------------------- |
| `npm run dev`              | Web + signaling servers with reload      |
| `npm run dev:https`        | Same, web served over self-signed HTTPS  |
| `npm run typecheck`        | Strict TypeScript across all workspaces  |
| `npm run lint`             | ESLint across the monorepo               |
| `npm test`                 | Vitest unit + integration suites         |
| `npm run test:e2e`         | Playwright browser tests (`apps/web`)    |
| `npm run build`            | Production builds                        |

## Configuration

All settings come from environment variables — see `.env.example` for the
full annotated list (STUN/TURN, room TTL, participant caps, secrets) and
`docs/deployment.md` for production guidance including the TURN setup and a
security checklist.

## Documentation

- `docs/architecture.md` — topology, negotiation, state, failure recovery
- `docs/browser-support.md` — capability matrix and user guidance
- `docs/deployment.md` — hosting, env vars, HTTPS, security checklist
- `docs/privacy.md` — data handling and consent model
- `docs/manual-qa.md` — real-browser capture test checklist
