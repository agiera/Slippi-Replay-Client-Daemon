const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const axios = require("axios");

const { renderReplayToMp4Stream, createFollowingReadStream } = require("./renderer");

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

function buildWebSocketUrl(serverUrl, token, maxConcurrent) {
  const trimmed = serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl;
  const wsBase = trimmed.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  const params = new URLSearchParams({ token, max_concurrent: String(maxConcurrent) });
  return `${wsBase}/api/v1/renders/ws?${params.toString()}`;
}

function buildAbsoluteUrl(serverUrl, relativePath) {
  const trimmed = serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl;
  const suffix = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
  return `${trimmed}${suffix}`;
}

function createRenderWorker({ getConfig, onStatus, onLog, onError }) {
  let socket = null;
  let running = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  const activeJobs = new Map();

  function maxConcurrent() {
    const value = Number(getConfig().renderConcurrency);
    if (!Number.isFinite(value) || value < 1) {
      return 1;
    }
    return Math.floor(value);
  }

  function scheduleReconnect() {
    if (!running || reconnectTimer) {
      return;
    }
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function send(payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }

  async function downloadReplay(config, downloadPath, replayName) {
    const url = buildAbsoluteUrl(config.serverUrl, downloadPath);
    const stem = path.basename(replayName, path.extname(replayName)) || "replay";
    const unique = crypto.randomBytes(6).toString("hex");
    const tempPath = path.join(os.tmpdir(), `slippi-source-${stem}-${unique}.slp`);

    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 120000,
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "X-API-Token": config.apiToken,
      },
    });
    fs.writeFileSync(tempPath, Buffer.from(response.data));
    return tempPath;
  }

  // Uploads the finished mp4 file to the server. The file is complete on disk,
  // Streams the encoded mp4 body straight to the server as ffmpeg produces it,
  // so the UI can progressively play the fragmented mp4 while it is still being
  // written. The POST resolves once the server has consumed the whole stream.
  async function uploadResultStream(config, resultPath, stream, signal) {
    const url = buildAbsoluteUrl(config.serverUrl, resultPath);
    await axios.post(url, stream, {
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 0,
      signal,
      headers: {
        "Content-Type": "video/mp4",
        Authorization: `Bearer ${config.apiToken}`,
        "X-API-Token": config.apiToken,
      },
    });
  }

  async function handleRenderJob(message) {
    const jobId = message.job_id;
    if (activeJobs.has(jobId)) {
      return;
    }
    if (activeJobs.size >= maxConcurrent()) {
      // The server should respect our advertised capacity, but guard anyway.
      send({ type: "job_failed", job_id: jobId, error: "worker at capacity" });
      return;
    }
    const abortController = new AbortController();
    activeJobs.set(jobId, abortController);

    const replayName = message.replay_name || `file-${message.file_id}.slp`;
    let replayPath = null;
    let render = null;
    let uploadStream = null;

    try {
      const config = getConfig();
      onStatus(`Rendering ${activeJobs.size} job(s)`);
      onLog(`Received render job ${jobId} for ${replayName}`);
      send({ type: "job_progress", job_id: jobId });

      replayPath = await downloadReplay(config, message.download_path, replayName);

      render = await renderReplayToMp4Stream({
        replayPath,
        config,
        onLog,
        signal: abortController.signal,
      });

      // ffmpeg writes the mp4 to a file; stream that growing file to the server so
      // the upload (and UI playback) can progress while the encode is still
      // running. On success the follower drains to EOF; if the render fails we
      // abort the upload so the server marks the job failed instead of completing
      // a truncated file.
      let renderDone = false;
      const uploadAbort = new AbortController();
      render.done.then(
        () => {
          renderDone = true;
        },
        () => uploadAbort.abort()
      );
      uploadStream = createFollowingReadStream(render.outputPath, () => renderDone);
      const uploadPromise = uploadResultStream(config, message.result_path, uploadStream, uploadAbort.signal);

      const results = await Promise.allSettled([render.done, uploadPromise]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;

      send({ type: "job_completed", job_id: jobId });
      onLog(`Render job ${jobId} completed and streamed`);
    } catch (error) {
      render?.kill?.();
      const detail = error?.response?.data?.detail || error?.message || "render failed";
      send({ type: "job_failed", job_id: jobId, error: String(detail) });
      onError(`Render job ${jobId} failed: ${detail}`);
    } finally {
      try {
        uploadStream?.destroy?.();
      } catch {}
      render?.cleanup?.();
      if (replayPath) {
        fs.rm(replayPath, { force: true }, () => {});
      }
      activeJobs.delete(jobId);
      onStatus(activeJobs.size > 0 ? `Rendering ${activeJobs.size} job(s)` : "Render worker connected");
    }
  }

  function handleMessage(raw) {
    let message = null;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message?.type === "render_job") {
      void handleRenderJob(message);
    }
  }

  function connect() {
    const config = getConfig();
    if (!config.serverUrl || !config.apiToken) {
      onStatus("Render worker idle: server URL or API token missing");
      onError("Render worker cannot connect without server URL and API token");
      return;
    }

    const url = buildWebSocketUrl(config.serverUrl, config.apiToken, maxConcurrent());
    onLog(`Connecting render worker to ${config.serverUrl}`);

    socket = new WebSocket(url);

    socket.on("open", () => {
      reconnectAttempts = 0;
      send({ type: "worker_config", max_concurrent: maxConcurrent() });
      onStatus("Render worker connected");
      onLog(`Render worker WebSocket connected (max ${maxConcurrent()} concurrent)`);
    });

    socket.on("message", handleMessage);

    socket.on("close", () => {
      onLog("Render worker WebSocket closed");
      socket = null;
      if (running) {
        onStatus("Render worker reconnecting...");
        scheduleReconnect();
      }
    });

    socket.on("error", (error) => {
      onError(`Render worker socket error: ${error.message}`);
    });
  }

  function start() {
    if (running) {
      return;
    }
    running = true;
    reconnectAttempts = 0;
    connect();
  }

  function stop() {
    running = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    for (const controller of activeJobs.values()) {
      controller.abort();
    }
    activeJobs.clear();
    if (socket) {
      const active = socket;
      socket = null;
      try {
        active.removeAllListeners();
        active.close();
      } catch {
        // ignore
      }
    }
    onStatus("Render worker stopped");
  }

  function isRunning() {
    return running;
  }

  function notifyConfigChanged() {
    if (socket && socket.readyState === WebSocket.OPEN) {
      send({ type: "worker_config", max_concurrent: maxConcurrent() });
    }
  }

  return {
    start,
    stop,
    isRunning,
    notifyConfigChanged,
  };
}

module.exports = {
  createRenderWorker,
};
