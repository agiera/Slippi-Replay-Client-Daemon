const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./fsUtil");

const DEFAULTS = {
  serverUrl: "http://localhost:8000",
  uploadPath: "/api/v1/uploads/files",
  apiToken: "",
  watchDir: "",
  includeExtensions: [".slp", ".zlp"],
  autoStart: true,
  pollIntervalMs: 2000,
  // Polling stats every file in the tree each interval; only enable it for
  // network/remote filesystems where native file events are unreliable.
  usePolling: false,
  // Periodic rescan that retries files whose uploads failed. Unchanged files are
  // skipped by size/mtime, so this is cheap.
  rescanIntervalMs: 5 * 60 * 1000,
};

function getConfigPath(app) {
  return path.join(app.getPath("userData"), "config.json");
}

function normalizeConfig(config) {
  const { apiTokenEncrypted, ...rest } = config || {};
  const rescanIntervalMs = Number(rest.rescanIntervalMs);
  return {
    ...DEFAULTS,
    ...rest,
    includeExtensions: Array.isArray(rest.includeExtensions)
      ? rest.includeExtensions.map((ext) => ext.toLowerCase())
      : DEFAULTS.includeExtensions,
    pollIntervalMs: Number(rest.pollIntervalMs || DEFAULTS.pollIntervalMs),
    usePolling: Boolean(rest.usePolling),
    rescanIntervalMs: Number.isFinite(rescanIntervalMs) && rescanIntervalMs >= 0 ? rescanIntervalMs : DEFAULTS.rescanIntervalMs,
  };
}

// `secretStore` ({ encrypt(string) -> string, decrypt(string) -> string }) is
// optional; when provided the API token is stored encrypted instead of in plain text.
function loadConfig(app, secretStore = null) {
  const configPath = getConfigPath(app);
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULTS };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return { ...DEFAULTS };
  }

  const config = normalizeConfig(raw);
  if (raw?.apiTokenEncrypted && secretStore) {
    try {
      config.apiToken = secretStore.decrypt(raw.apiTokenEncrypted);
    } catch {
      config.apiToken = "";
      config.apiTokenUnreadable = true;
    }
  }
  return config;
}

function saveConfig(app, config, secretStore = null) {
  const { apiTokenUnreadable, ...toSave } = normalizeConfig(config);
  if (secretStore && toSave.apiToken) {
    toSave.apiTokenEncrypted = secretStore.encrypt(toSave.apiToken);
    toSave.apiToken = "";
  }
  writeFileAtomic(getConfigPath(app), JSON.stringify(toSave, null, 2));
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

// Returns only the settings provided via environment variables, so callers can
// apply them at runtime without persisting them to config.json.
function getEnvOverrides() {
  const overrides = {};

  if (process.env.SLIPPI_REPLAY_SERVER_URL) {
    overrides.serverUrl = process.env.SLIPPI_REPLAY_SERVER_URL;
  }
  if (process.env.SLIPPI_REPLAY_UPLOAD_PATH) {
    overrides.uploadPath = process.env.SLIPPI_REPLAY_UPLOAD_PATH;
  }
  if (process.env.SLIPPI_REPLAY_SERVER_API_TOKEN) {
    overrides.apiToken = process.env.SLIPPI_REPLAY_SERVER_API_TOKEN;
  }
  if (process.env.SLIPPI_REPLAY_WATCH_DIR) {
    overrides.watchDir = process.env.SLIPPI_REPLAY_WATCH_DIR;
  }

  const envExtensions = parseExtensionsFromEnv(process.env.SLIPPI_REPLAY_INCLUDE_EXTENSIONS);
  if (envExtensions) {
    overrides.includeExtensions = envExtensions;
  }

  if (process.env.SLIPPI_REPLAY_POLL_INTERVAL_MS) {
    overrides.pollIntervalMs = Number(process.env.SLIPPI_REPLAY_POLL_INTERVAL_MS);
  }
  if (process.env.SLIPPI_REPLAY_AUTO_START) {
    overrides.autoStart = process.env.SLIPPI_REPLAY_AUTO_START.toLowerCase() === "true";
  }
  if (process.env.SLIPPI_REPLAY_USE_POLLING) {
    overrides.usePolling = process.env.SLIPPI_REPLAY_USE_POLLING.toLowerCase() === "true";
  }
  if (process.env.SLIPPI_REPLAY_RESCAN_INTERVAL_MS) {
    overrides.rescanIntervalMs = Number(process.env.SLIPPI_REPLAY_RESCAN_INTERVAL_MS);
  }

  return overrides;
}

function mergeEnvOverrides(config) {
  return normalizeConfig({ ...config, ...getEnvOverrides() });
}

// True when credentials would be sent unencrypted to a non-local host.
function isInsecureRemoteUrl(serverUrl) {
  let url;
  try {
    url = new URL(serverUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return !(host === "localhost" || host === "::1" || host.startsWith("127."));
}

module.exports = {
  loadConfig,
  saveConfig,
  mergeEnvOverrides,
  getEnvOverrides,
  normalizeConfig,
  parseExtensionsFromEnv,
  isInsecureRemoteUrl,
};
