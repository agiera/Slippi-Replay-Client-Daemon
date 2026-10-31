const { app } = require("electron");
const dotenv = require("dotenv");
const path = require("path");

const { loadConfig, saveConfig, mergeEnvOverrides } = require("./src/config");
const { loadState, saveState } = require("./src/state");
const { createUploader } = require("./src/uploader");
const { createWatcher } = require("./src/watcher");
const { createTrayController } = require("./src/tray");
const { createLogger } = require("./src/logger");

dotenv.config({ path: path.join(__dirname, ".env") });

let trayController = null;
let watcher = null;
let uploader = null;
let config = null;
let state = null;
let logger = null;

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
    onCandidate: (filePath) => uploader.enqueue(filePath),
    onStatus: (message) => trayController.setStatus(message),
    onLog: (message) => logger.info(message),
  });

  watcher.start();
}

async function syncNow() {
  if (!watcher) {
    return;
  }
  if (uploader?.reconcileWithServer) {
    await uploader.reconcileWithServer();
  }
  watcher.scanNow();
}

app.whenReady().then(() => {
  config = mergeEnvOverrides(loadConfig(app));
  state = loadState(app);
  logger = createLogger(app);
  logger.info("Application starting");

  app.setLoginItemSettings({
    openAtLogin: Boolean(config.autoStart),
    openAsHidden: true,
    name: "Slippi Replay Sync",
  });

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
      config.watchDir = nextWatchDir;
      saveConfig(app, config);
      logger.info(`Watch directory updated to ${nextWatchDir}`);
      startWatcher();
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
      config.serverUrl = nextUrl.trim();
      saveConfig(app, config);
      logger.info(`Server URL updated to ${config.serverUrl}`);
      trayController.setStatus("Server URL updated");
      trayController.refreshMenu();
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
      config.apiToken = nextToken.trim();
      saveConfig(app, config);
      logger.info("API token updated");
      trayController.setStatus("API token updated");
      trayController.refreshMenu();
    },
    onSyncNow: () => {
      void syncNow();
    },
    onToggleAutostart: (enabled) => {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: true,
        name: "Slippi Replay Sync",
      });
      config.autoStart = enabled;
      saveConfig(app, config);
      logger.info(`Open at login set to ${enabled}`);
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

  trayController.refreshMenu();
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("before-quit", () => {
  stopWatcher();
});
