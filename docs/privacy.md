# Privacy

## What WatchShare is for

WatchShare is for sharing content you own, have permission to share, or are
legally permitted to display privately. It does not and will not bypass DRM,
HDCP, paywalls, or any other technical protection. If a protected page
captures as a black screen or silent audio, WatchShare tells you it is likely
protected and stops there.

## How media travels

- Video and audio flow directly between the host's browser and each viewer's
  browser over WebRTC peer connections, encrypted in transit with DTLS-SRTP.
- When a direct connection is impossible (restrictive NATs or firewalls),
  media is relayed through a TURN server. The relay forwards encrypted
  packets; it does not decrypt media. This is transport encryption between
  peers, **not** an end-to-end-encryption guarantee beyond what WebRTC's
  DTLS-SRTP provides.
- Media never passes through the WatchShare application servers and is never
  recorded or stored.

## What the server stores

There is no database. Everything below lives in the signaling server's
memory and is erased when the room closes, expires, or the server restarts.

| Data                            | Where        | Lifetime                    |
| ------------------------------- | ------------ | --------------------------- |
| Room code, settings, timestamps | Memory       | Room lifetime               |
| Hashed host token, hashed password | Memory    | Room lifetime               |
| Display names, pseudonymous ids | Memory       | Room lifetime               |
| Presence                        | Memory/Redis | Room lifetime               |
| Chat messages                   | Relayed only | Never stored on the server; cleared from clients when they leave |
| SDP / ICE candidates            | Not stored   | Relayed and discarded       |
| Video / audio / captures        | Never        | Never                       |

Logs redact passwords, tokens, SDP, candidates, and chat bodies.

## Consent and indicators

- Tab capture always requires the host's explicit click plus the browser's
  own picker dialog. WatchShare cannot see any screen content before that.
- A permanent indicator inside the room shows whether the screen is being
  shared, whether tab audio is live, whether the microphone is on, and how
  many viewers are connected.
- Microphone access is only requested after an explicit "Enable microphone"
  click and can be revoked at any time.

## Accounts

None. Guests join with a display name. Tokens live in session storage and die
with the tab.
