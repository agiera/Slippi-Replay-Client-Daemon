const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const FormData = require("form-data");
const { isSlpFileComplete, streamSlpUpload } = require("./streamUpload");

const UPLOAD_CONCURRENCY = 2;
const MAX_ATTEMPTS = 3;
// Files untouched for this long are assumed fully written and skip the size poll.
const SETTLED_AGE_MS = 2000;

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
// reads a file that is still being copied/written. Bounded to ~10s. Returns the
// final stat, or null if the file disappeared.
async function waitForStableSize(filePath) {
  let last = null;
  for (let i = 0; i < 20; i += 1) {
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return null;
    }
    if (Date.now() - stat.mtimeMs > SETTLED_AGE_MS) {
      return stat;
    }
    if (last && stat.size === last.size) {
      return stat;
    }
    last = stat;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return last;
}

function buildUploadUrl(serverUrl, uploadPath) {
  const safeServerUrl = serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl;
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

function authHeaders(config) {
  return {
    Authorization: `Bearer ${config.apiToken}`,
    "X-API-Token": config.apiToken,
  };
}

function createUploader({ getConfig, getState, persistState, onStatus, onLog, onError }) {
  const queue = [];
  // Files currently queued, uploading, or live-streaming; prevents the watcher's
  // repeated `change` events (and periodic rescans) from re-enqueuing them.
  const active = new Set();
  const streaming = new Set();
  let running = 0;

  function filesIndex(state) {
    if (!state.files || typeof state.files !== "object") {
      state.files = {};
    }
    return state.files;
  }

  function isUnchangedSinceUpload(state, filePath, stat) {
    const entry = filesIndex(state)[filePath];
    return Boolean(
      entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs && entry.hash && state.uploaded[entry.hash],
    );
  }

  function recordUpload(state, { filePath, hash, stat, remoteName, remoteFolder }) {
    state.uploaded[hash] = {
      fileName: path.basename(filePath),
      filePath,
      remoteName,
      remoteFolder,
      uploadedAt: new Date().toISOString(),
      sizeBytes: stat.size,
    };
    filesIndex(state)[filePath] = { size: stat.size, mtimeMs: stat.mtimeMs, hash };
    persistState();
  }

  function checkConfig(config) {
    if (!config.apiToken) {
      onStatus("Upload skipped: API token missing");
      onError("Upload skipped because API token is not configured");
      return false;
    }
    if (!config.serverUrl) {
      onStatus("Upload skipped: server URL missing");
      onError("Upload skipped because server URL is not configured");
      return false;
    }
    return true;
  }

  async function uploadOne(filePath) {
    const config = getConfig();
    const state = getState();

    if (!checkConfig(config)) {
      return;
    }

    const stat = await waitForStableSize(filePath);
    if (!stat) {
      onStatus(`Skipped missing file: ${path.basename(filePath)}`);
      return;
    }
    if (!stat.isFile()) {
      return;
    }

    const hash = await sha256File(filePath);
    if (state.uploaded[hash]) {
      filesIndex(state)[filePath] = { size: stat.size, mtimeMs: stat.mtimeMs, hash };
      persistState();
      onStatus(`Already uploaded: ${path.basename(filePath)}`);
      return;
    }

    const form = new FormData();
    form.append("file", fs.createReadStream(filePath), path.basename(filePath));

    const uploadUrl = buildUploadUrl(config.serverUrl, config.uploadPath);
    onLog(`Uploading ${filePath} to ${uploadUrl}`);
    onStatus(`Uploading: ${path.basename(filePath)}`);

    let data;
    try {
      const response = await axios.post(uploadUrl, form, {
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        headers: {
          ...form.getHeaders(),
          ...authHeaders(config),
          "X-Content-SHA256": hash,
        },
        timeout: 120000,
      });
      data = response?.data;
    } catch (error) {
      if (error?.response?.status !== 409) {
        throw error;
      }
      // Server already has this content; treat it as uploaded.
      data = error.response.data;
      onLog(`Server already has ${filePath}`);
    }

    recordUpload(state, {
      filePath,
      hash,
      stat,
      remoteName: data?.name || path.basename(filePath),
      remoteFolder: data?.folder || null,
    });

    onStatus(`Uploaded: ${path.basename(filePath)}`);
    onLog(`Upload successful for ${filePath}`);
  }

  async function streamOne(filePath) {
    const config = getConfig();
    const state = getState();

    if (!checkConfig(config)) {
      return;
    }

    if (!fs.existsSync(filePath)) {
      onStatus(`Skipped missing file: ${path.basename(filePath)}`);
      return;
    }

    onStatus(`Streaming live: ${path.basename(filePath)}`);
    onLog(`Live-streaming ${filePath} to server as it is written`);

    const result = await streamSlpUpload({ filePath, config, onLog });

    // The game-end header patch means the file on disk no longer matches the bytes
    // streamed, so record the final file's hash too; later scans then dedupe it.
    let stat = null;
    let fileHash = null;
    try {
      stat = await fs.promises.stat(filePath);
      fileHash = await sha256File(filePath);
    } catch {
      // File vanished after streaming; only the streamed hash can be recorded.
    }

    const remote = { remoteName: result.remoteName, remoteFolder: result.remoteFolder };
    recordUpload(state, {
      filePath,
      hash: fileHash || result.hash,
      stat: stat || { size: result.sizeBytes, mtimeMs: null },
      ...remote,
    });
    if (fileHash && fileHash !== result.hash) {
      state.uploaded[result.hash] = { ...state.uploaded[fileHash], sizeBytes: result.sizeBytes };
      persistState();
    }

    onStatus(`Uploaded (live): ${path.basename(filePath)}`);
    onLog(`Live upload complete for ${filePath} (${result.sizeBytes} bytes)`);
  }

  async function isLiveSlp(filePath) {
    if (!filePath.toLowerCase().endsWith(".slp")) {
      return false;
    }
    try {
      return !(await isSlpFileComplete(filePath));
    } catch {
      return false;
    }
  }

  async function processOne(filePath) {
    if (await isLiveSlp(filePath)) {
      await streamOne(filePath);
      return;
    }
    await uploadOne(filePath);
  }

  async function withRetries(filePath) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        await processOne(filePath);
        return;
      } catch (error) {
        const message = error?.response?.data?.detail || error?.message || "upload failed";
        onStatus(`Upload failed (${attempt}/${MAX_ATTEMPTS}): ${message}`);
        onError(`Upload failed for ${filePath} (${attempt}/${MAX_ATTEMPTS}): ${message}`);
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
        }
      }
    }
    // Not recorded in state, so the next periodic rescan will pick it up again.
    onLog(`Giving up on ${filePath} until the next rescan`);
  }

  async function handle(filePath) {
    const state = getState();
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      onStatus(`Skipped missing file: ${path.basename(filePath)}`);
      return;
    }

    if (isUnchangedSinceUpload(state, filePath, stat)) {
      return;
    }

    if (await isLiveSlp(filePath)) {
      // Live games can last many minutes; stream them outside the worker pool so
      // they never hold up other uploads.
      streaming.add(filePath);
      withRetries(filePath).finally(() => {
        streaming.delete(filePath);
        active.delete(filePath);
      });
      return;
    }

    await withRetries(filePath);
  }

  function pump() {
    while (running < UPLOAD_CONCURRENCY && queue.length > 0) {
      const filePath = queue.shift();
      running += 1;
      handle(filePath)
        .catch((error) => onError(`Unexpected error for ${filePath}: ${error?.message || error}`))
        .finally(() => {
          // Live streams stay active until their own stream task finishes.
          if (!streaming.has(filePath)) {
            active.delete(filePath);
          }
          running -= 1;
          pump();
        });
    }
  }

  function enqueue(filePath) {
    if (active.has(filePath)) {
      return;
    }
    active.add(filePath);
    queue.push(filePath);
    pump();
  }

  async function reconcileWithServer() {
    const config = getConfig();
    const state = getState();

    if (!config.apiToken || !config.serverUrl) {
      return;
    }

    // Entries recorded after this point may be missing from the list we are about
    // to fetch, so they must not be treated as stale.
    const startedAt = Date.now();
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
          headers: authHeaders(config),
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
      const uploadedAt = Date.parse(uploadedInfo?.uploadedAt || "");
      if (Number.isFinite(uploadedAt) && uploadedAt >= startedAt) {
        continue;
      }
      const remoteName = uploadedInfo?.remoteName || uploadedInfo?.fileName;
      const remoteFolder = uploadedInfo?.remoteFolder || "";
      const key = `${remoteFolder}/${remoteName}`;
      if (!remoteName || !remoteKeys.has(key)) {
        delete state.uploaded[hash];
        removed += 1;
      }
    }

    if (removed > 0) {
      const files = filesIndex(state);
      for (const [filePath, entry] of Object.entries(files)) {
        if (!state.uploaded[entry?.hash]) {
          delete files[filePath];
        }
      }
      persistState();
      onLog(`State reconciliation removed ${removed} stale uploaded entries`);
      onStatus(`Re-sync needed for ${removed} files`);
    }
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
  waitForStableSize,
};
