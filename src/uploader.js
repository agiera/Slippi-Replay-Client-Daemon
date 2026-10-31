const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const FormData = require("form-data");
const { isSlpFileComplete, streamSlpUpload } = require("./streamUpload");

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// Wait until a file's size stops changing so a full (non-streaming) upload never
// reads a file that is still being copied/written. Bounded to ~10s.
async function waitForStableSize(filePath) {
  let lastSize = -1;
  for (let i = 0; i < 20; i += 1) {
    let size;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return;
    }
    if (size === lastSize) {
      return;
    }
    lastSize = size;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function buildUploadUrl(serverUrl, uploadPath) {  const safeServerUrl = serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl;
  const safePath = uploadPath.startsWith("/") ? uploadPath : `/${uploadPath}`;
  return `${safeServerUrl}${safePath}`;
}

function buildReplayListUrl(serverUrl, uploadPath) {
  const normalizedUploadPath = uploadPath.startsWith("/") ? uploadPath : `/${uploadPath}`;
  const replayPath = normalizedUploadPath.endsWith("/uploads/files")
    ? normalizedUploadPath.replace(/\/uploads\/files$/, "/replays/files")
    : "/api/v1/replays/files";
  return buildUploadUrl(serverUrl, replayPath);
}

function createUploader({ getConfig, getState, persistState, onStatus, onLog, onError }) {
  const queue = [];
  const queued = new Set();
  // Files currently queued or being uploaded/streamed; prevents the watcher's
  // repeated `change` events during a live game from re-enqueuing the same file.
  const active = new Set();
  let processing = false;

  async function uploadOne(filePath) {
    const config = getConfig();
    const state = getState();

    if (!config.apiToken) {
      onStatus("Upload skipped: API token missing");
      onError("Upload skipped because API token is not configured");
      return;
    }

    if (!config.serverUrl) {
      onStatus("Upload skipped: server URL missing");
      onError("Upload skipped because server URL is not configured");
      return;
    }

    if (!fs.existsSync(filePath)) {
      onStatus(`Skipped missing file: ${path.basename(filePath)}`);
      return;
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return;
    }

    await waitForStableSize(filePath);

    const hash = await sha256File(filePath);
    if (state.uploaded[hash]) {
      onStatus(`Already uploaded: ${path.basename(filePath)}`);
      return;
    }

    const form = new FormData();
    form.append("file", fs.createReadStream(filePath), path.basename(filePath));

    const uploadUrl = buildUploadUrl(config.serverUrl, config.uploadPath);
    onLog(`Uploading ${filePath} to ${uploadUrl}`);
    onStatus(`Uploading: ${path.basename(filePath)}`);

    const response = await axios.post(uploadUrl, form, {
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${config.apiToken}`,
        "X-API-Token": config.apiToken,
      },
      timeout: 120000,
    });

    const remoteName = response?.data?.name || path.basename(filePath);
    const remoteFolder = response?.data?.folder || null;

    state.uploaded[hash] = {
      fileName: path.basename(filePath),
      filePath,
      remoteName,
      remoteFolder,
      uploadedAt: new Date().toISOString(),
      sizeBytes: stat.size,
    };
    persistState();

    onStatus(`Uploaded: ${path.basename(filePath)}`);
    onLog(`Upload successful for ${filePath}`);
  }

  async function streamOne(filePath) {
    const config = getConfig();
    const state = getState();

    if (!config.apiToken) {
      onStatus("Upload skipped: API token missing");
      onError("Upload skipped because API token is not configured");
      return;
    }

    if (!config.serverUrl) {
      onStatus("Upload skipped: server URL missing");
      onError("Upload skipped because server URL is not configured");
      return;
    }

    if (!fs.existsSync(filePath)) {
      onStatus(`Skipped missing file: ${path.basename(filePath)}`);
      return;
    }

    onStatus(`Streaming live: ${path.basename(filePath)}`);
    onLog(`Live-streaming ${filePath} to server as it is written`);

    const result = await streamSlpUpload({ filePath, config, onLog });

    // The content hash is only known once the live stream ends; record it so a
    // later scan of the now-complete file is deduped instead of re-uploaded.
    state.uploaded[result.hash] = {
      fileName: path.basename(filePath),
      filePath,
      remoteName: result.remoteName,
      remoteFolder: result.remoteFolder,
      uploadedAt: new Date().toISOString(),
      sizeBytes: result.sizeBytes,
    };
    persistState();

    onStatus(`Uploaded (live): ${path.basename(filePath)}`);
    onLog(`Live upload complete for ${filePath} (${result.sizeBytes} bytes)`);
  }

  async function processOne(filePath) {
    if (filePath.toLowerCase().endsWith(".slp")) {
      let complete = true;
      try {
        complete = await isSlpFileComplete(filePath);
      } catch {
        complete = true;
      }
      if (!complete) {
        await streamOne(filePath);
        return;
      }
    }
    await uploadOne(filePath);
  }

  async function reconcileWithServer() {
    const config = getConfig();
    const state = getState();

    if (!config.apiToken || !config.serverUrl) {
      return;
    }

    const listUrl = buildReplayListUrl(config.serverUrl, config.uploadPath);
    const remoteKeys = new Set();
    let cursor = null;

    try {
      do {
        const response = await axios.get(listUrl, {
          params: {
            limit: 200,
            ...(cursor ? { cursor } : {}),
          },
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            "X-API-Token": config.apiToken,
          },
          timeout: 30000,
        });

        const items = Array.isArray(response?.data?.items) ? response.data.items : [];
        for (const item of items) {
          const name = item?.name;
          const folder = item?.folder || "";
          if (name) {
            remoteKeys.add(`${folder}/${name}`);
          }
        }

        cursor = response?.data?.next_cursor || null;
      } while (cursor);
    } catch (error) {
      const message = error?.response?.data?.detail || error?.message || "failed to fetch replay list";
      onError(`State reconciliation skipped: ${message}`);
      return;
    }

    let removed = 0;
    for (const [hash, uploadedInfo] of Object.entries(state.uploaded)) {
      const remoteName = uploadedInfo?.remoteName || uploadedInfo?.fileName;
      const remoteFolder = uploadedInfo?.remoteFolder || "";
      const key = `${remoteFolder}/${remoteName}`;
      if (!remoteName || !remoteKeys.has(key)) {
        delete state.uploaded[hash];
        removed += 1;
      }
    }

    if (removed > 0) {
      persistState();
      onLog(`State reconciliation removed ${removed} stale uploaded entries`);
      onStatus(`Re-sync needed for ${removed} files`);
    }
  }

  async function processQueue() {
    if (processing) {
      return;
    }

    processing = true;
    while (queue.length > 0) {
      const filePath = queue.shift();
      queued.delete(filePath);

      let attempts = 0;
      let uploaded = false;

      while (attempts < 3 && !uploaded) {
        try {
          attempts += 1;
          await processOne(filePath);
          uploaded = true;
        } catch (error) {
          const message = error?.response?.data?.detail || error?.message || "upload failed";
          onStatus(`Upload failed (${attempts}/3): ${message}`);
          onError(`Upload failed for ${filePath} (${attempts}/3): ${message}`);
          if (attempts < 3) {
            await new Promise((resolve) => setTimeout(resolve, attempts * 2000));
          }
        }
      }

      active.delete(filePath);
    }
    processing = false;
  }

  function enqueue(filePath) {
    if (queued.has(filePath) || active.has(filePath)) {
      return;
    }
    queued.add(filePath);
    active.add(filePath);
    queue.push(filePath);
    processQueue();
  }

  return {
    enqueue,
    reconcileWithServer,
  };
}

module.exports = {
  createUploader,
  buildUploadUrl,
  buildReplayListUrl,
  sha256File,
};
