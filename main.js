const { app, safeStorage } = require("electron");
const dotenv = require("dotenv");
const path = require("path");

const { loadConfig, saveConfig, getEnvOverrides, normalizeConfig, isInsecureRemoteUrl } = require("./src/config");
const { loadState, saveState } = require("./src/state");
const { createUploader } = require("./src/uploader");
const { createWatcher } = require("./src/watcher");
const { createTrayController } = require("./src/tray");
const { createLogger } = require("./src/logger");
const { setAutoStart } = require("./src/autostart");

// The user data .env works for packaged builds; the project .env is for development.
// dotenv never overrides variables that are already set, so the first file wins.
dotenv.config({ path: path.join(app.getPath("userData"), ".env"), quiet: true });
dotenv.config({ path: path.join(__dirname, ".env"), quiet: true });

let trayController = null;
let watcher = null;
let uploader = null;
// Settings as persisted to config.json; never contains environment overrides.
let fileConfig = null;
// Effective runtime settings: fileConfig with environment overrides applied.
let config = null;
let state = null;
let logger = null;
let rescanTimer = null;
let syncInFlight = null;

function getSecretStore() {
  if (!safeStorage.isEncryptionAvailable()) {
    return null;
  }
  return {
    encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
  };
}

function recomputeConfig() {
  config = normalizeConfig({ ...fileConfig, ...getEnvOverrides() });
}

function updateConfig(patch) {
  fileConfig = { ...fileConfig, ...patch };
  saveConfig(app, fileConfig, getSecretStore());
  // Settings changed from the tray take effect even if an env var set them at startup.
  config = normalizeConfig({ ...config, ...patch });
}

function warnIfInsecure() {
  if (isInsecureRemoteUrl(config.serverUrl)) {
    logger.warn(`Server URL ${config.serverUrl} uses plain HTTP; the API token is sent unencrypted. Use https://.`);
  }
}

function stopWatcher() {
  if (watcher) {
    watcher.stop();
    watcher = null;
  }
}

function startWatcher() {
  stopWatcher();

  watcher = createWatcher({
    watchDir: config.watchDir,
    includeExtensions: config.includeExtensions,
    pollIntervalMs: config.pollIntervalMs,
    usePolling: config.usePolling,
    onCandidate: (filePath) => uploader.enqueue(filePath),
    onStatus: (message) => trayController.setStatus(message),
    onLog: (message) => logger.info(message),
  });

  watcher.start();
}

function syncNow() {
  if (!watcher || !config.watchDir) {
    return Promise.resolve();
  }
  if (!syncInFlight) {
    syncInFlight = (async () => {
      try {
        await uploader.reconcileWithServer();
        await watcher?.scanNow();
      } catch (error) {
        logger.error(`Sync failed: ${error?.message || error}`);
      } finally {
        syncInFlight = null;
      }
    })();
  }
  return syncInFlight;
}

function startRescanTimer() {
  if (rescanTimer) {
    clearInterval(rescanTimer);
    rescanTimer = null;
  }
  if (config.rescanIntervalMs > 0) {
    // Retries files whose uploads failed; unchanged files are skipped cheaply.
    rescanTimer = setInterval(() => {
      if (watcher && !syncInFlight) {
        void watcher.scanNow();
      }
    }, config.rescanIntervalMs);
  }
}

app.whenReady().then(() => {
  logger = createLogger(app);
  logger.info("Application starting");

  fileConfig = loadConfig(app, getSecretStore());
  if (fileConfig.apiTokenUnreadable) {
    logger.warn("Stored API token could not be decrypted; please set it again from the tray menu");
  } else if (fileConfig.apiToken && getSecretStore()) {
    // Re-save so tokens stored in plain text by older versions get encrypted.
    saveConfig(app, fileConfig, getSecretStore());
  }
  recomputeConfig();
  state = loadState(app);
  warnIfInsecure();

  // Only manage login items for packaged builds so `npm start` doesn't register
  // a development Electron binary to launch at login.
  if (app.isPackaged) {
    try {
      setAutoStart(app, Boolean(config.autoStart));
    } catch (error) {
      logger.error(`Failed to update open-at-login: ${error.message}`);
    }
  }

  uploader = createUploader({
    getConfig: () => config,
    getState: () => state,
    persistState: () => saveState(app, state),
    onStatus: (message) => trayController.setStatus(message),
    onLog: (message) => logger.info(message),
    onError: (message) => logger.error(message),
  });

  trayController = createTrayController({
    app,
    iconPath: path.join(__dirname, "resources", "slippi-sync-logo.png"),
    getLogPath: () => logger.logPath,
    getConfig: () => config,
    onOpenWatchDirPicker: async () => {
      const nextWatchDir = await trayController.pickWatchDirectory(config.watchDir);
      if (!nextWatchDir) {
        return;
      }
      updateConfig({ watchDir: nextWatchDir });
      logger.info(`Watch directory updated to ${nextWatchDir}`);
      startWatcher();
      // The watcher ignores files that already exist, so upload them now.
      void syncNow();
      trayController.refreshMenu();
    },
    onSetServerUrl: async () => {
      const nextUrl = await trayController.promptForText({
        title: "Server URL",
        label: "Set Slippi replay server URL",
        defaultValue: config.serverUrl,
      });
      if (!nextUrl) {
        return;
      }
      updateConfig({ serverUrl: nextUrl.trim() });
      logger.info(`Server URL updated to ${config.serverUrl}`);
      warnIfInsecure();
      trayController.setStatus("Server URL updated");
      trayController.refreshMenu();
      void syncNow();
    },
    onSetApiToken: async () => {
      const nextToken = await trayController.promptForText({
        title: "API Token",
        label: "Set replay upload API token",
        defaultValue: config.apiToken,
        isSecret: true,
      });
      if (!nextToken) {
        return;
      }
      updateConfig({ apiToken: nextToken.trim() });
      logger.info("API token updated");
      trayController.setStatus("API token updated");
      trayController.refreshMenu();
      // Files skipped while the token was missing are uploaded now.
      void syncNow();
    },
    onSyncNow: () => {
      void syncNow();
    },
    onToggleAutostart: (enabled) => {
      try {
        setAutoStart(app, enabled);
      } catch (error) {
        logger.error(`Failed to update open-at-login: ${error.message}`);
      }
      updateConfig({ autoStart: enabled });
      logger.info(`Open at login set to ${enabled}`);
      trayController.refreshMenu();
    },
  });

  trayController.setStatus("Starting...");

  if (!config.watchDir) {
    trayController.setStatus("No watch directory set");
    logger.warn("No watch directory set; uploads disabled until one is configured");
  } else {
    startWatcher();
    void syncNow();
  }
  startRescanTimer();

  trayController.refreshMenu();
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

let quitting = false;
app.on("before-quit", (event) => {
  stopWatcher();
  if (rescanTimer) {
    clearInterval(rescanTimer);
    rescanTimer = null;
  }
  if (logger && !quitting) {
    // Flush buffered log lines before exiting.
    quitting = true;
    event.preventDefault();
    logger.info("Application quitting");
    logger.close().finally(() => app.quit());
  }
});
