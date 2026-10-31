const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const FormData = require("form-data");
const { isSlpFileComplete, streamSlpUpload } = require("./streamUpload");

const UPLOAD_CONCURRENCY = 2;
// Server-side limit on hashes per /check request.
const CHECK_BATCH_SIZE = 1000;
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

function buildCheckUrl(serverUrl, uploadPath) {
  const base = buildUploadUrl(serverUrl, uploadPath);
  return `${base.endsWith("/") ? base.slice(0, -1) : base}/check`;
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

  // Ask the server which content hashes it already stores for this token's
  // repository. Returns a Map of hash -> { folder, name }, or null when the
  // server predates the check endpoint.
  async function checkHashes(config, hashes) {
    const existing = new Map();
    for (let i = 0; i < hashes.length; i += CHECK_BATCH_SIZE) {
      let response;
      try {
        response = await axios.post(
          buildCheckUrl(config.serverUrl, config.uploadPath),
          { hashes: hashes.slice(i, i + CHECK_BATCH_SIZE) },
          { headers: authHeaders(config), timeout: 30000 },
        );
      } catch (error) {
        if ([404, 405].includes(error?.response?.status)) {
          return null;
        }
        throw error;
      }
      for (const [hash, info] of Object.entries(response?.data?.existing || {})) {
        existing.set(hash, info);
      }
    }
    return existing;
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

    let onServer = null;
    try {
      onServer = (await checkHashes(config, [hash]))?.get(hash) || null;
    } catch (error) {
      // Not fatal: the upload itself still deduplicates via a 409.
      onLog(`Hash check failed for ${filePath}: ${error?.message || error}`);
    }
    if (onServer) {
      recordUpload(state, {
        filePath,
        hash,
        stat,
        remoteName: onServer.name || path.basename(filePath),
        remoteFolder: onServer.folder || null,
      });
      onStatus(`Already on server: ${path.basename(filePath)}`);
      onLog(`Server already has ${filePath}; skipped upload`);
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
    // streamed; the server finalizes the stream the same way, so record the final
    // file's hash so later scans and server checks match it.
    let stat = null;
    let fileHash = null;
    try {
      stat = await fs.promises.stat(filePath);
      fileHash = await sha256File(filePath);
    } catch {
      // File vanished after streaming; only the streamed hash can be recorded.
    }

    recordUpload(state, {
      filePath,
      hash: fileHash || result.hash,
      stat: stat || { size: result.sizeBytes, mtimeMs: null },
      remoteName: result.remoteName,
      remoteFolder: result.remoteFolder,
    });

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

  // Drops local "uploaded" records the server no longer has (e.g. deleted
  // replays) so the next scan uploads those files again.
  async function reconcileWithServer() {
    const config = getConfig();
    const state = getState();

    if (!config.apiToken || !config.serverUrl) {
      return;
    }

    // Entries recorded after this point may not be visible to the check yet, so
    // they must not be treated as stale.
    const startedAt = Date.now();
    const candidates = Object.entries(state.uploaded)
      .filter(([, info]) => {
        const uploadedAt = Date.parse(info?.uploadedAt || "");
        return !(Number.isFinite(uploadedAt) && uploadedAt >= startedAt);
      })
      .map(([hash]) => hash);
    if (candidates.length === 0) {
      return;
    }

    let existing;
    try {
      existing = await checkHashes(config, candidates);
    } catch (error) {
      const message = error?.response?.data?.detail || error?.message || "hash check failed";
      onError(`State reconciliation skipped: ${message}`);
      return;
    }
    if (existing === null) {
      onLog("State reconciliation skipped: server does not support hash checks");
      return;
    }

    let removed = 0;
    for (const hash of candidates) {
      if (!existing.has(hash)) {
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
  buildCheckUrl,
  sha256File,
  waitForStableSize,
};
