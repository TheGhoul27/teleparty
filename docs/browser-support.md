# Browser support

WatchShare feature-detects everything (`apps/web/lib/capabilities.ts`); the
user-agent string is never used for support decisions.

## Summary

| Browser              | Watch | Host (video) | Host (tab audio) | Notes |
| -------------------- | ----- | ------------ | ---------------- | ----- |
| Chrome (Win/macOS)   | Yes   | Yes          | Yes              | Best experience. "Share tab audio" checkbox appears when a tab is selected. |
| Edge (Win)           | Yes   | Yes          | Yes              | Same Chromium capture stack as Chrome. |
| Firefox              | Yes   | Yes          | No (tab audio)   | Window/screen capture works; tab audio capture is not provided. Viewers unaffected. |
| Safari (macOS)       | Yes   | Partial      | No               | `getDisplayMedia` exists but offers limited surface choice and no tab audio. |
| Mobile (iOS/Android) | Yes   | No           | No               | Viewer-only. Hosting a tab share from mobile is not promised. |

## What we detect

- `navigator.mediaDevices` and `getDisplayMedia` (hosting)
- `RTCPeerConnection` (everything)
- `RTCRtpSender.prototype.replaceTrack` (tab switching without renegotiation)
- `document.pictureInPictureEnabled`, `fullscreenEnabled`
- `HTMLMediaElement.setSinkId` (audio output selection)
- `CaptureController` (focus behaviour, Chromium only)
- `getSupportedConstraints()`: `displaySurface`, `surfaceSwitching`,
  `selfBrowserSurface`, `systemAudio`

Missing WebRTC redirects to `/unsupported`. Missing capture keeps the user as
a viewer with guidance. Missing optional constraints simply degrade: the
sharing dialog may show more surface types or lack audio.

## Browser-specific guidance shown to users

- "Your browser returned video without an audio track." — after capture with
  no audio track (any browser).
- "In the sharing dialog, select a browser tab and enable Share tab audio."
  — Chromium hosts who picked a window/screen or unchecked audio.
- "Try using a Chromium-based desktop browser." — Firefox/Safari users who
  attempt to host with audio.
- "System audio may not be available for the selected source." — screen or
  window capture on platforms without system audio loopback (notably macOS).
- "This protected video may not be capturable." — sustained black frames
  suggest DRM/HDCP-protected content. WatchShare does not bypass protection.

## Autoplay

Viewers' streams start muted when the browser blocks autoplay with sound; a
prominent "Click to hear audio" button unmutes on gesture. This is expected
on every browser until the user has interacted with the page.
