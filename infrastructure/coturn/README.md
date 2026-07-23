# Deploying coturn for WatchShare

TURN relays WebRTC media when a direct peer-to-peer connection cannot be
established (symmetric NATs, restrictive corporate networks). Roughly 10-20%
of connections need it.

## Quick start (Docker)

```bash
docker run -d --name coturn --network host \
  -v $(pwd)/turnserver.conf:/etc/coturn/turnserver.conf:ro \
  coturn/coturn:4.6
```

`--network host` matters: TURN allocates relay ports dynamically
(49152-65535/UDP by default) and NATed port mapping breaks that.

## Configuration steps

1. Copy `turnserver.conf` and replace every `<PLACEHOLDER>`:
   - `realm` / `server-name`: your domain (e.g. `turn.example.com`).
   - `static-auth-secret`: a long random string. Generate with
     `openssl rand -hex 32`.
   - `external-ip`: required when the machine is behind NAT (cloud VMs).
2. Set the same secret as `TURN_STATIC_AUTH_SECRET` in the signaling server's
   environment, and set `TURN_URL` to a comma separated list, e.g.:

   ```env
   TURN_URL=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp
   TURN_STATIC_AUTH_SECRET=<the same secret>
   ```

   The signaling server then mints short-lived HMAC credentials per client
   via `POST /api/turn-credentials` and in room join responses - static TURN
   passwords never reach the browser.

3. Firewall openings:

   | Port        | Protocol | Purpose            |
   | ----------- | -------- | ------------------ |
   | 3478        | UDP+TCP  | TURN               |
   | 5349        | TCP      | TURN over TLS      |
   | 49152-65535 | UDP      | Relay allocations  |

4. TLS (`turns:`) needs certificates; uncomment `cert`/`pkey` in the config
   and provision with certbot.

## Static-credential fallback (MVP only)

Without `TURN_STATIC_AUTH_SECRET`, the signaling server falls back to the
static `TURN_USERNAME` / `TURN_CREDENTIAL` pair. This is acceptable for
development but not recommended in production because the credential is
long-lived and shared by all users.

## Verifying

Use https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
with your TURN URL and generated credentials; you should see `relay`
candidates.
