# Slippi Replay Client Daemon

Cross-platform Electron tray app that watches a local replay directory and uploads new files to the Slippi replay hosting server.

## Features

- Runs as a tray app on Linux, macOS, and Windows
- Watches a folder recursively for new or changed replay files
- Upload queue with retries
- Deduplicates uploads by SHA-256 hash
- Saves config and upload state under Electron user data

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
- Choose watch folder
- Sync immediately
- Open app config directory
- Open daemon log file
- Toggle open-at-login

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
