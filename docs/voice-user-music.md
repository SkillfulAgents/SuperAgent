# Voice mode and the person's own music

Voice mode fills the agent's working silences with a hold sound. When the
desktop app finds a music player already playing as voice mode comes on, it
uses that player instead: paused while anyone speaks, playing while the agent
works, given back when voice mode ends. This covers Spotify, Apple Music and
anything playing in a browser, because it goes through the OS "now playing"
layer rather than any one player's API.

## Behaviour

- Voice mode comes on → the host is asked what is audibly playing. If nothing
  is, the built-in loop plays as before and the player is never touched again
  for that session.
- If something is, it is paused at once (the person's turn comes first) and
  voice mode holds it. The mic-row hold-sound control shows a music icon and
  names the player.
- The hold hook (`use-hold-sound.ts`) then drives the player with exactly the
  timing it uses for the loop: it lets the music play once the agent has been
  silent for the hold delay, and pauses it the moment either participant
  speaks or standalone read-aloud is audible. A request card pauses the hold,
  so the music waits with it.
- Voice mode goes off → the player is started again, but only if voice mode is
  the one that paused it.
- Every pause asks the host what is playing first. A player the person paused
  themselves is never started again against their wish; a player they started
  in place of the first one is followed.
- No fades yet: no platform exposes per-player volume through its now-playing
  layer. Fading would need AppleScript into Spotify or Music.app (an Apple
  Events entitlement plus a one-time Automation prompt), Core Audio sessions
  on Windows and PulseAudio sink inputs on Linux.

The takeover lasts the whole voice session. Muting the hold sound (the
mic-row control or the voice settings switch) keeps the music paused rather
than letting it play over the conversation; only leaving voice mode gives it
back. The "Use my music as the hold sound" switch under it turns the takeover
off altogether, so voice mode never touches the player. Both are the person's
own settings (`voice.holdSound`, `voice.userMusic`, default on).

## Where it lives

| Layer | File | Role |
| --- | --- | --- |
| Renderer | `src/renderer/lib/speech/user-music.ts` | `UserMusic`, a `HoldSource` like `HoldSound`, owns the session: which player, whether voice mode holds it, serialized intents |
| Renderer | `src/renderer/hooks/use-user-music.ts` | `useUserMusicSession(enabled)` begins/ends the takeover; `userMusicSupported()` is the gate |
| Renderer | `src/renderer/components/messages/message-input.tsx` | picks the hold source per session |
| Preload | `src/preload/index.ts` | `musicProbe`, `musicPause`, `musicResume` |
| Main | `src/main/music-control/index.ts` | stateless service over one backend per platform |
| Main | `src/main/music-control/darwin-mediaremote.ts` | macOS: the MediaRemote adapter |
| Main | `src/main/music-control/linux-mpris.ts` | Linux: MPRIS over `dbus-send` |

The gate is `isElectron()` plus platform, not `canUseHostFeatures()`: the
player runs on the computer the window runs on and is heard there, whichever
Superagent the window drives (see `docs/cloud-workspace.md` § Capability
gating).

Windows has no backend yet; the service reports `supported: false` and the
setting is hidden. The path is WinRT's
`GlobalSystemMediaTransportControlsSessionManager`, through a long-lived
PowerShell 5.1 helper or a small .NET executable, since the NodeRT bindings
have been unmaintained since 2022.

## macOS: the MediaRemote adapter

Since macOS 15.4 the private MediaRemote framework refuses any process that
Apple did not sign, which killed every third-party "now playing" library.
Apple's own `/usr/bin/perl` is still allowed, so the app ships
[ungive/mediaremote-adapter](https://github.com/ungive/mediaremote-adapter)
(BSD-3-Clause): a perl script plus a small framework it loads, which prints
now-playing JSON and sends play/pause. No Automation prompt is involved.

`scripts/build-mediaremote-adapter.sh` fetches the pinned ref, builds the
framework with cmake (universal x86_64 + arm64) and leaves everything in
`build/mediaremote-adapter/`, which the mac `extraResources` config copies into
the app bundle. `npm run dist:mac` runs it; for local development on a Mac run
`npm run build:mediaremote-adapter` once (needs cmake). Without it the main
process logs one warning and reports the feature unsupported.

Risks: Apple could remove perl from macOS (announced in 2019, not done as of
macOS 26) or gate it too. The adapter is actively maintained and the app
degrades to the built-in loop when it fails.

## Linux: MPRIS

Every desktop player, browsers included, registers on the session bus under
`org.mpris.MediaPlayer2.*`. The backend lists those names, reads each one's
`PlaybackStatus` and `Identity`, and calls `Pause` / `Play` on the first that
is playing. It shells out to `dbus-send`, which comes with D-Bus itself.

To try it without a real player, the scratch script used during development
registers a fake MPRIS player with python-dbus and answers those calls; any
real player (`spotify`, `mpv`, a Chromium tab with audio) works the same way.
