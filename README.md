# Slippi Replay Client Daemon

Cross-platform Electron tray app that watches a local replay directory and uploads new files to the Slippi replay hosting server.

## Features

- Runs as a tray app on Linux, macOS, and Windows
- Watches a folder recursively for new or changed replay files
- Upload queue with retries
- Deduplicates uploads by SHA-256 hash
- Saves config and upload state under Electron user data
- Opt-in video rendering: render server replays to mp4 locally and upload them back

## Configuration

Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

Set at minimum:

- `SLIPPI_REPLAY_SERVER_URL` (for example `http://localhost:8000`)
- `SLIPPI_REPLAY_UPLOAD_PATH` (for example `/api/v1/uploads/files`)
- `SLIPPI_REPLAY_SERVER_API_TOKEN`
- `SLIPPI_REPLAY_WATCH_DIR`

## Development

```bash
npm install
npm start
```

## Build Packages

```bash
npm run build:linux
npm run build:windows
npm run build:mac
```

## Tray Menu

- Shows current status
- Shows active server endpoint and watch folder
- Set server URL from a popup input
- Set API token from a popup input
- Choose watch folder
- Sync immediately
- Toggle "Render Videos For Server" (opt-in rendering)
- Set Slippi Playback Dolphin, Melee ISO, and ffmpeg paths
- Open app config directory
- Open daemon log file
- Toggle open-at-login

## Video Rendering (Opt-In)

When enabled, the daemon opens a WebSocket to the server
(`/api/v1/renders/ws`) and waits for render jobs. For each job it:

1. Downloads the replay the server points to.
2. Renders it to mp4 locally with Slippi Playback Dolphin + ffmpeg.
3. Uploads the mp4 back to `/api/v1/renders/jobs/{id}/result`.

Requirements on the machine running the daemon:

- A Slippi Playback build of Dolphin (`SLIPPI_REPLAY_DOLPHIN_PATH`)
- A Melee 1.02 NTSC ISO (`SLIPPI_REPLAY_MELEE_ISO_PATH`)
- `ffmpeg` on PATH or an explicit path (`SLIPPI_REPLAY_FFMPEG_PATH`)
- On Linux, `xvfb-run` (Fedora: `xorg-x11-server-Xvfb`, Debian/Ubuntu:
  `xvfb`) so Dolphin renders on an isolated virtual display. Desktop
  compositors suspend a window's GL rendering when it's on an inactive
  workspace, which starves the frame dump and stalls the render. If
  `xvfb-run` is not found the daemon falls back to a normal windowed launch.

Headless rendering is enabled by default on Linux. Toggle it with
`SLIPPI_REPLAY_HEADLESS` (`true`/`false`); tune the virtual display with
`SLIPPI_REPLAY_XVFB_SCREEN` (default `1920x1080x24`) or point at a specific
wrapper with `SLIPPI_REPLAY_XVFB_RUN_PATH`.

Enable it from the tray ("Render Videos For Server") or by setting
`SLIPPI_REPLAY_RENDER_ENABLED=true`. The same API token used for uploads is
used to authenticate the render WebSocket, so the token's user must have the
`uploader` or `superuser` role.

## Logs

The daemon writes logs to `daemon.log` in the Electron user data directory.

- Linux: `~/.config/Slippi Replay Sync/daemon.log`
- macOS: `~/Library/Application Support/Slippi Replay Sync/daemon.log`
- Windows: `%APPDATA%/Slippi Replay Sync/daemon.log`

## Expected Server Upload Contract

The daemon sends `multipart/form-data` with field name `file` and includes both headers:

- `Authorization: Bearer <token>`
- `X-API-Token: <token>`

Your server upload endpoint should accept one of these auth methods and a replay file payload.
