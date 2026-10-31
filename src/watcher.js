const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");

function isReplayFile(filePath, includeExtensions) {
  return includeExtensions.includes(path.extname(filePath).toLowerCase());
}

// Asynchronous recursive walk so large replay archives never block the Electron
// main process. Unreadable directories are skipped.
async function walkDir(rootDir, onFile) {
  let dir;
  try {
    dir = await fs.promises.opendir(rootDir);
  } catch {
    return;
  }

  for await (const item of dir) {
    const fullPath = path.join(rootDir, item.name);
    if (item.isDirectory()) {
      await walkDir(fullPath, onFile);
    } else if (item.isFile()) {
      onFile(fullPath);
    }
  }
}

function createWatcher({ watchDir, includeExtensions, pollIntervalMs, usePolling = false, onCandidate, onStatus, onLog }) {
  let watcher = null;

  function enqueueIfReplay(filePath) {
    if (isReplayFile(filePath, includeExtensions)) {
      onCandidate(filePath);
    }
  }

  async function scanNow() {
    if (!watchDir || !fs.existsSync(watchDir)) {
      onStatus("Watch directory not found");
      return;
    }

    await walkDir(watchDir, (filePath) => enqueueIfReplay(filePath));
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

    // No awaitWriteFinish: live console-mirrored .slp files are picked up as soon
    // as they appear so they can be streamed while still being written. The
    // uploader routes incomplete .slp files to live streaming and waits for a
    // stable size before fully uploading complete files, so early events are safe.
    // Native filesystem events are used by default; polling stats every file in
    // the tree each interval and is only needed for network/remote filesystems.
    watcher = chokidar.watch(watchDir, {
      persistent: true,
      ignoreInitial: true,
      usePolling: Boolean(usePolling),
      interval: Math.max(200, pollIntervalMs),
    });

    watcher.on("add", enqueueIfReplay);
    watcher.on("change", enqueueIfReplay);
    watcher.on("error", (error) => onStatus(`Watcher error: ${error.message}`));

    onStatus(`Watching: ${watchDir}`);
    onLog(`Watcher started for ${watchDir}${usePolling ? " (polling)" : ""}`);
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
  isReplayFile,
  walkDir,
};
