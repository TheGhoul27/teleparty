# Manual QA checklist

Automated tests mock capture and WebRTC where browsers cannot be driven
headlessly. Run this checklist on real browsers before a release.
Primary matrix: Chrome (Windows), Chrome (macOS), Edge (Windows), Firefox,
Safari (macOS). Use one host machine and at least one separate viewer device.

## Capture (host, Chromium)

- [ ] "Share a tab" opens the native picker; nothing is captured before the click.
- [ ] Picking a **browser tab** with "Share tab audio" checked → room shows
      "Sharing with tab audio"; viewer hears audio.
- [ ] Picking a tab with audio **unchecked** → warning banner explains how to
      enable tab audio; video still streams.
- [ ] Picking a **window** or **screen** → video streams; audio warning
      appears when no audio track was provided.
- [ ] Cancelling the picker → returns to idle, no error banner, "Share a tab"
      clickable again (no repeated permission prompts without a click).
- [ ] Browser-level screen-capture block (site settings) → "denied" state
      with instructions.
- [ ] Browser's own "Stop sharing" toolbar button → host UI returns to
      not-sharing, viewers see waiting state, system chat message appears.
- [ ] "Switch tab" (or Chromium's "Share this tab instead") → viewer stream
      switches without reconnect/black flash.
- [ ] Sharing the WatchShare tab itself → self-capture warning appears.
- [ ] Sharing a DRM page (e.g. a paid streaming service) → black video and a
      "may be protected" notice; no attempt to work around it. Not a bug.
- [ ] Muting the shared tab (browser tab mute) → warning that the tab
      appears muted.

## Viewer

- [ ] Viewer joining **before** sharing sees waiting state, then the stream
      appears automatically when sharing starts.
- [ ] Viewer joining **after** sharing started receives the stream within a
      few seconds.
- [ ] Autoplay-blocked browsers show "Click to hear audio"; clicking unmutes.
- [ ] Volume slider, fullscreen, picture-in-picture (Chromium) work.
- [ ] Aspect ratio preserved for portrait and widescreen tabs (letterboxed,
      not cropped).
- [ ] Kill the viewer's network for ~10 s → reconnecting overlay, then
      automatic recovery. Longer outage → Reconnect button appears and works.

## Audio / voice chat

- [ ] "Enable microphone" prompts only after click; mic + tab audio arrive
      as separate tracks (check `chrome://webrtc-internals`).
- [ ] Speaking indicator lights for the active speaker.
- [ ] Per-participant volume and "mute for me" work locally only.
- [ ] Host "Disable their mic" silences that participant for everyone and
      blocks re-enable until allowed again.
- [ ] Host preview stays muted (no echo/feedback loop on the host machine).

## Rooms and moderation

- [ ] Invite link joins the correct room; room code shown in header.
- [ ] Password room: wrong password → generic error; correct password joins.
- [ ] Waiting room: guest waits; host Admit/Reject both behave; rejected
      guest sees a clear message.
- [ ] Full room rejects the next joiner with a clear message.
- [ ] Kicked viewer is disconnected and cannot rejoin silently with the same
      session.
- [ ] Host reload/rejoin within the grace period restores the room
      (management token in session storage); viewers see "host reconnecting"
      then recovery.
- [ ] Host absent past the grace period → room closes for everyone.
- [ ] "Close room" ends the room for all participants immediately.
- [ ] Expired room (set a short TTL) rejects joins with the expiration
      message.

## Cross-browser

- [ ] Firefox host: window capture works, tab audio degrades gracefully with
      guidance; Firefox viewer plays Chromium host's stream with audio.
- [ ] Safari viewer: video + audio play after the audio-unlock click.
- [ ] Mobile viewer (iOS Safari, Android Chrome): can join, watch, chat;
      layout collapses to video-first with working panels.

## TURN

- [ ] With `TURN_URL` configured, force relay (block UDP or use
      `chrome://webrtc-internals` to confirm `relay` candidate) → stream
      works; diagnostics panel shows "TURN relay".

## Accessibility

- [ ] Full keyboard walk-through: create, join, share, chat, leave.
- [ ] Screen reader announces joins/leaves/share changes (ARIA live region).
- [ ] Focus rings visible on all interactive controls.
