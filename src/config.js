const fs = require("fs");
const os = require("os");
const path = require("path");

function defaultDolphinPath() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "SlippiPlayback", "Slippi Dolphin.exe");
  }
  return path.join(os.homedir(), ".config", "Slippi Launcher", "playback", "Slippi_Playback-x86_64.AppImage");
}

const MAX_RENDER_CONCURRENCY = 64;

function clampConcurrency(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 5;
  }
  const rounded = Math.floor(parsed);
  if (rounded < 1) {
    return 1;
  }
  if (rounded > MAX_RENDER_CONCURRENCY) {
    return MAX_RENDER_CONCURRENCY;
  }
  return rounded;
}

const DEFAULTS = {
  serverUrl: "http://localhost:8000",
  uploadPath: "/api/v1/uploads/files",
  apiToken: "",
  watchDir: "",
  includeExtensions: [".slp", ".zlp"],
  autoStart: true,
  pollIntervalMs: 2000,
  renderEnabled: false,
  renderConcurrency: 5,
  dolphinPath: defaultDolphinPath(),
  meleeIsoPath: "",
  ffmpegPath: "ffmpeg",
  // Run Dolphin on an isolated Xvfb display so the desktop compositor cannot
  // suspend its GL rendering (and starve the frame dump) when it is on an
  // inactive workspace. Requires xvfb-run (Fedora: xorg-x11-server-Xvfb).
  headless: process.platform === "linux",
  xvfbRunPath: "xvfb-run",
  xvfbScreen: "1920x1080x24",
};

function getConfigPath(app) {
  return path.join(app.getPath("userData"), "config.json");
}

function normalizeConfig(config) {
  return {
    ...DEFAULTS,
    ...config,
    includeExtensions: Array.isArray(config?.includeExtensions)
      ? config.includeExtensions.map((ext) => ext.toLowerCase())
      : DEFAULTS.includeExtensions,
    pollIntervalMs: Number(config?.pollIntervalMs || DEFAULTS.pollIntervalMs),
    renderEnabled: Boolean(config?.renderEnabled),
    renderConcurrency: clampConcurrency(config?.renderConcurrency),
    headless: config?.headless === undefined ? DEFAULTS.headless : Boolean(config.headless),
  };
}

function loadConfig(app) {
  const configPath = getConfigPath(app);
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULTS };
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(app, config) {
  const configPath = getConfigPath(app);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(normalizeConfig(config), null, 2));
}

function parseExtensionsFromEnv(raw) {
  if (!raw) {
    return undefined;
  }
  const values = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) => (value.startsWith(".") ? value : `.${value}`));

  return values.length > 0 ? values : undefined;
}

function mergeEnvOverrides(config) {
  const merged = {
    ...config,
  };

  if (process.env.SLIPPI_REPLAY_SERVER_URL) {
    merged.serverUrl = process.env.SLIPPI_REPLAY_SERVER_URL;
  }
  if (process.env.SLIPPI_REPLAY_UPLOAD_PATH) {
    merged.uploadPath = process.env.SLIPPI_REPLAY_UPLOAD_PATH;
  }
  if (process.env.SLIPPI_REPLAY_SERVER_API_TOKEN) {
    merged.apiToken = process.env.SLIPPI_REPLAY_SERVER_API_TOKEN;
  }
  if (process.env.SLIPPI_REPLAY_WATCH_DIR) {
    merged.watchDir = process.env.SLIPPI_REPLAY_WATCH_DIR;
  }

  const envExtensions = parseExtensionsFromEnv(process.env.SLIPPI_REPLAY_INCLUDE_EXTENSIONS);
  if (envExtensions) {
    merged.includeExtensions = envExtensions;
  }

  if (process.env.SLIPPI_REPLAY_POLL_INTERVAL_MS) {
    merged.pollIntervalMs = Number(process.env.SLIPPI_REPLAY_POLL_INTERVAL_MS);
  }

  if (process.env.SLIPPI_REPLAY_AUTO_START) {
    merged.autoStart = process.env.SLIPPI_REPLAY_AUTO_START.toLowerCase() === "true";
  }

  if (process.env.SLIPPI_REPLAY_RENDER_ENABLED) {
    merged.renderEnabled = process.env.SLIPPI_REPLAY_RENDER_ENABLED.toLowerCase() === "true";
  }
  if (process.env.SLIPPI_REPLAY_RENDER_CONCURRENCY) {
    merged.renderConcurrency = Number(process.env.SLIPPI_REPLAY_RENDER_CONCURRENCY);
  }
  if (process.env.SLIPPI_REPLAY_DOLPHIN_PATH) {
    merged.dolphinPath = process.env.SLIPPI_REPLAY_DOLPHIN_PATH;
  }
  if (process.env.SLIPPI_REPLAY_MELEE_ISO_PATH) {
    merged.meleeIsoPath = process.env.SLIPPI_REPLAY_MELEE_ISO_PATH;
  }
  if (process.env.SLIPPI_REPLAY_FFMPEG_PATH) {
    merged.ffmpegPath = process.env.SLIPPI_REPLAY_FFMPEG_PATH;
  }
  if (process.env.SLIPPI_REPLAY_HEADLESS) {
    merged.headless = process.env.SLIPPI_REPLAY_HEADLESS.toLowerCase() === "true";
  }
  if (process.env.SLIPPI_REPLAY_XVFB_RUN_PATH) {
    merged.xvfbRunPath = process.env.SLIPPI_REPLAY_XVFB_RUN_PATH;
  }
  if (process.env.SLIPPI_REPLAY_XVFB_SCREEN) {
    merged.xvfbScreen = process.env.SLIPPI_REPLAY_XVFB_SCREEN;
  }

  return normalizeConfig(merged);
}

module.exports = {
  loadConfig,
  saveConfig,
  mergeEnvOverrides,
  clampConcurrency,
  MAX_RENDER_CONCURRENCY,
};
