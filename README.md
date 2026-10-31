# Slippi Replay Client Daemon

Cross-platform Electron tray app that watches a local replay directory and uploads new files to the Slippi replay hosting server.

## Features

- Runs as a tray app on Linux, macOS, and Windows
- Watches a folder recursively for new or changed replay files
- Live-streams games while they are being recorded; uploads finished replays two at a time
- Upload retries, plus a periodic rescan that picks up anything that still failed
- Deduplicates uploads by SHA-256 hash; unchanged files are skipped by size/mtime without being re-read
- Saves config and upload state under Electron user data (written atomically)
- Stores the API token encrypted with the OS keychain when available

## Configuration

Settings can be changed from the tray menu, or overridden with environment
variables. Environment variables are read from a `.env` file in the Electron
user data directory (see [Logs](#logs) for its location per platform), then
from a `.env` next to `main.js` for development:

```bash
cp .env.example .env
```

Environment overrides apply at runtime only and are never written to
`config.json`. Set at minimum:

- `SLIPPI_REPLAY_SERVER_URL` (for example `http://localhost:8000`)
- `SLIPPI_REPLAY_UPLOAD_PATH` (for example `/api/v1/uploads/files`)
- `SLIPPI_REPLAY_SERVER_API_TOKEN`
- `SLIPPI_REPLAY_WATCH_DIR`

Optional:

- `SLIPPI_REPLAY_USE_POLLING` (default `false`): poll the watch folder instead of
  using native filesystem events. Only needed for network/remote filesystems;
  polling checks every file in the folder each interval.
- `SLIPPI_REPLAY_POLL_INTERVAL_MS` (default `2000`): polling interval, also used
  to tail live games.
- `SLIPPI_REPLAY_RESCAN_INTERVAL_MS` (default `300000`, `0` disables): how often
  the whole folder is rescanned to retry failed uploads.

Use an `https://` server URL for anything other than a local server; the
daemon logs a warning when the API token would be sent over plain HTTP.

## Development

```bash
npm install
npm start
npm test   # runs the node:test suite in test/
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
- Choose watch folder (existing replays in it are uploaded immediately)
- Sync immediately
- Open app config directory
- Open daemon log file
- Toggle open-at-login (Linux uses an XDG autostart entry in
  `~/.config/autostart/slippi-replay-sync.desktop`)

## Live Games

A `.slp` header stores the length of the game data, which Dolphin/Slippi
Launcher leave at `0` while a game is being recorded and fill in when it ends.
Files with a `0` length are streamed to `<upload path>/stream` as they grow;
the stream ends once the header is filled in and the file stops growing, or
after 10 minutes without new data. Idle time counts from the file's last write,
so a game that was abandoned long ago (for example, Dolphin crashed) is sent
straight away. If a stream is cut short, the server keeps what it received and
replaces it once the complete file is uploaded. Live streams run independently of the
upload queue, so they never delay other uploads.

## Logs

The daemon writes logs to `daemon.log` in the Electron user data directory.
When it passes 5 MB it is rotated to `daemon.log.1` (one previous file is kept).

- Linux: `~/.config/Slippi Replay Sync/daemon.log`
- macOS: `~/Library/Application Support/Slippi Replay Sync/daemon.log`
- Windows: `%APPDATA%/Slippi Replay Sync/daemon.log`

## Expected Server Upload Contract

The daemon sends `multipart/form-data` with field name `file` and includes both headers:

- `Authorization: Bearer <token>`
- `X-API-Token: <token>`

Your server upload endpoint should accept one of these auth methods and a replay file payload.
Full uploads also send `X-Content-SHA256: <hex digest>`; a `409` response is
treated as "already uploaded" and recorded like a success.

Before uploading a file, and at startup to verify its local "already uploaded"
records, the daemon calls `POST <upload path>/check` with
`{"hashes": ["<sha256>", ...]}` (up to 1000 per request). The server replies
`{"existing": {"<sha256>": {"folder": ..., "name": ...}}}` for hashes it
already stores. Files the server already has are never re-sent, and records the
server no longer has are dropped so those files upload again. Servers without
this endpoint (`404`) are still supported: uploads proceed and the startup check
is skipped.
