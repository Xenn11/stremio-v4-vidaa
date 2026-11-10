# Stremio v4.4 for VIDAA

Stremio's **v4.4 web shell** with the VIDAA adaptations from
[NoobyGains/stremio-vidaa-tv](https://github.com/NoobyGains/stremio-vidaa-tv)
ported onto it.

**Why v4:** Stremio v5 (including web.strem.io and the NoobyGains build) runs its
engine as WebAssembly that needs `externref`. The VIDAA browser (an old Chromium)
doesn't support it and crashes with
`WebAssembly.instantiateStreaming(): invalid value type 'externref'`.
v4.4 is plain JavaScript, so it runs.

## Remote

| Key | Where | Action |
|---|---|---|
| Back | anywhere | back (closes the picker first) |
| Back ×2 | home | exit the app |
| Red / Subtitle | player | embedded subtitle picker (+ delay with ← →) |
| Green / Audio | player | embedded audio track picker |
| Yellow | player | subtitles off |
| Blue / Info | anywhere | stream info (resolution, buffer, tracks) |
| Play / Pause / Stop | player | play, pause, stop and go back |
| FF / RW | player | +30 s / −30 s |
| CH+ / CH− | player | +60 s / −60 s |

## What the VIDAA layer (`src/vidaa-v4.js`) does

Ported from NoobyGains:
- **Search fix:** the VIDAA on-screen keyboard writes text without firing events,
  so search never ran. The layer emits the events and submits the search once
  typing settles.
- **Key dispatcher:** one capture-phase, priority-based handler for remote keys.
- **F/F11 suppressed:** fullscreen requests crash the VIDAA browser.
- **Embedded subtitles/audio:** reads the tracks inside MKV/MP4 straight from
  the TV's native player (no streaming server), including the VIDAA
  "show-then-disable" quirk that makes cues load. Positions cues inside the
  safe area, remembers your language, and has a delay control.
- **Device:** registers this host as a trusted VIDAA domain; logs model/firmware.
- **Exit** through `Hisense_Exit`; volume persists between videos.

v4-specific:
- VIDAA Back (461/10009) is translated to the Escape that v4's shortcut table expects.
- Desktop-only "update/download the app" modals are hidden.
- Upstream's offline service worker is replaced with one that clears its cache
  and unregisters, so a stale copy can never pin old code on the TV.

**Not ported:** the v5-only patches (Theater DOM tweaks, WebTorrent in-browser,
server URL manager, diagnostics panel, …). With TorBox/debrid, streams are
direct HTTPS links, and v4 plays those directly without a streaming server.

## Build

```bash
python build.py              # -> docs/ (served by GitHub Pages)
python build.py --refresh    # re-download Stremio's shell-v4.4
python build.py --serve      # build + serve docs/ on :8044
```

`docs/` is static and every path in it is relative. GitHub Pages serves it from
`main` → `/docs`; then point the VIDAA tile at the Pages URL.
