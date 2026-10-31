const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  serverUrl: "http://localhost:8000",
  uploadPath: "/api/v1/uploads/files",
  apiToken: "",
  watchDir: "",
  includeExtensions: [".slp", ".zlp"],
  autoStart: true,
  pollIntervalMs: 2000,
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

  return normalizeConfig(merged);
}

module.exports = {
  loadConfig,
  saveConfig,
  mergeEnvOverrides,
  normalizeConfig,
  parseExtensionsFromEnv,
};
