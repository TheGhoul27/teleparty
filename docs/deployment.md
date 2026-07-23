# Deployment

## Components

1. **Web frontend** (`apps/web`) — Next.js; any Node host or static-friendly
   platform that runs `next start` (Vercel, Fly.io, a VM).
2. **Signaling server** (`apps/signaling`) — a **persistent** Node process
   holding long-lived WebSocket connections.
3. **Redis** — optional; required only for multi-instance signaling.
4. **coturn** — TURN relay; see `infrastructure/coturn/README.md`.

There is no database. Rooms, presence, and chat are deliberately ephemeral:
they live in the signaling server's memory and disappear when the room closes
or expires.

> **Platform warning:** do not deploy the signaling service to platforms that
> terminate long-lived connections or freeze processes (classic serverless
> functions, free-tier dynos that sleep, proxies with short idle timeouts).
> Room state lives in process memory and every disconnect degrades the user
> experience. Use a VM, container service, Fly.io, Railway, or similar with
> WebSocket support and idle timeouts of at least a few minutes. If a proxy
> (nginx/ALB) sits in front, raise `proxy_read_timeout`/idle timeout above
> the Socket.IO ping interval (default 25 s), e.g. 120 s.

## Environment variables

| Variable                       | Used by   | Description |
| ------------------------------ | --------- | ----------- |
| `NEXT_PUBLIC_SIGNALING_URL`    | web       | Public URL of the signaling server (baked at build time). |
| `PORT` / `HOST`                | signaling | Listen address (default 4000 / 0.0.0.0). |
| `ALLOWED_ORIGINS`              | signaling | Comma-separated browser origins allowed for HTTP + WebSocket. |
| `ROOM_TOKEN_SECRET`            | signaling | ≥16 chars. HMAC key for host/reconnect token hashing. Required in production; auto-generated per process in development. Rotating it invalidates live tokens. |
| `REDIS_URL`                    | signaling | Optional. Enables presence mirror + Socket.IO redis adapter. |
| `ROOM_CODE_LENGTH`             | signaling | Default 8. |
| `MAX_ROOM_PARTICIPANTS`        | signaling | Server-wide cap (default 5). |
| `DEFAULT_ROOM_TTL_MINUTES`     | signaling | Default room expiration (default 240). |
| `HOST_RECONNECT_GRACE_SECONDS` | signaling | How long a room survives host disconnect (default 90). |
| `STUN_URLS`                    | signaling | Comma-separated STUN URLs. |
| `TURN_URL`                     | signaling | Comma-separated TURN URLs (`turn:` UDP/TCP and `turns:` TLS). |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | signaling | Static TURN credentials (MVP fallback only). |
| `TURN_STATIC_AUTH_SECRET`      | signaling | Enables short-lived HMAC TURN credentials (coturn `use-auth-secret`). Preferred in production. |
| `TURN_CREDENTIAL_TTL_SECONDS`  | signaling | Lifetime of minted TURN credentials (default 3600). |

## Local development

```bash
cp .env.example .env       # adjust as needed
npm install
npm run dev                # web on :3000, signaling on :4000
```

The signaling server automatically loads a `.env` file from the repo root or
its own directory (existing environment variables win).

Or the full container stack (web, signaling, redis):

```bash
docker compose up --build
# with TURN:
docker compose --profile turn up --build
```

## Health and readiness

- `GET /health` — liveness (process is up).
- `GET /ready` — readiness (returns 503 until listening; wire to your
  orchestrator's readiness probe).

## HTTPS

Production must be HTTPS-only: `getDisplayMedia` and `getUserMedia` require a
secure context, and the CSP assumes it. Terminate TLS at your load balancer
or reverse proxy for both the web app and the signaling server (wss://).

Example nginx location for the signaling server:

```nginx
location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Origin $http_origin;
    proxy_read_timeout 120s;
}
```

## Production security checklist

- [ ] HTTPS on the web origin; WSS to the signaling server.
- [ ] `ALLOWED_ORIGINS` lists only your real web origins.
- [ ] `ROOM_TOKEN_SECRET` is long, random, and not in source control.
- [ ] TURN uses `TURN_STATIC_AUTH_SECRET` (short-lived credentials), not
      static username/password.
- [ ] coturn denies private peer ranges (see shipped `turnserver.conf`).
- [ ] Redis (if used) is not exposed publicly; use private networking.
- [ ] Logs verified free of tokens, passwords, SDP, chat bodies (pino
      redaction is configured, spot-check anyway).
- [ ] Rate limits reviewed for your audience size.
- [ ] `docs/manual-qa.md` executed on Chrome + Edge + Firefox before release.
- [ ] Reverse-proxy idle timeouts > Socket.IO ping interval.
- [ ] Content-Security-Policy headers verified on the deployed web origin.
