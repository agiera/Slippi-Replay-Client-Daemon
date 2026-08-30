const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");

function isReplayFile(filePath, includeExtensions) {
  return includeExtensions.includes(path.extname(filePath).toLowerCase());
}

function walkDir(rootDir, onFile) {
  if (!fs.existsSync(rootDir)) {
    return;
  }

  const items = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(rootDir, item.name);
    if (item.isDirectory()) {
      walkDir(fullPath, onFile);
    } else if (item.isFile()) {
      onFile(fullPath);
    }
  }
}

function createWatcher({ watchDir, includeExtensions, pollIntervalMs, onCandidate, onStatus, onLog }) {
  let watcher = null;

  function enqueueIfReplay(filePath) {
    if (isReplayFile(filePath, includeExtensions)) {
      onLog(`Replay candidate detected: ${filePath}`);
      onCandidate(filePath);
    }
  }

  function scanNow() {
    if (!watchDir || !fs.existsSync(watchDir)) {
      onStatus("Watch directory not found");
      return;
    }

    walkDir(watchDir, (filePath) => enqueueIfReplay(filePath));
    onLog(`Completed scan for ${watchDir}`);
  }

  function start() {
    if (!watchDir) {
      onStatus("No watch directory set");
      onLog("Watcher start skipped: no watch directory set");
      return;
    }

    if (!fs.existsSync(watchDir)) {
      onStatus("Watch directory does not exist");
      onLog(`Watcher start skipped: directory does not exist (${watchDir})`);
      return;
    }

    watcher = chokidar.watch(watchDir, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: Math.max(200, pollIntervalMs),
      },
    });

    watcher.on("add", enqueueIfReplay);
    watcher.on("change", enqueueIfReplay);
    watcher.on("error", (error) => onStatus(`Watcher error: ${error.message}`));

    onStatus(`Watching: ${watchDir}`);
    onLog(`Watcher started for ${watchDir}`);
  }

  function stop() {
    if (watcher) {
      watcher.close();
      watcher = null;
      onLog("Watcher stopped");
    }
  }

  return {
    start,
    stop,
    scanNow,
  };
}

module.exports = {
  createWatcher,
};
