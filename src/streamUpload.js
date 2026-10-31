const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const axios = require("axios");

// Every .slp starts with the UBJSON prefix `{U\x03raw[$U#l` followed by a
// big-endian uint32 length of the raw event payload. Dolphin/Launcher write 0
// there while the game is in progress and patch in the real length when the
// game ends, so the first 15 bytes are enough to tell a live file from a done one.
const SLP_RAW_HEADER = Buffer.from("{U\x03raw[$U#l", "latin1");
const SLP_HEADER_LENGTH = SLP_RAW_HEADER.length + 4;

// A live game with no new bytes for this long is treated as abandoned; whatever
// has been streamed so far is finalized by the server ("upload what we have").
const STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

function buildStreamUrl(serverUrl, uploadPath) {
  const safeServerUrl = serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl;
  const base = uploadPath.startsWith("/") ? uploadPath : `/${uploadPath}`;
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${safeServerUrl}${trimmed}/stream`;
}

// Returns the raw payload length from the header: 0 while the game is still being
// written, >0 once finished, or null if the file is not a recognizable .slp.
async function readSlpRawLength(filePath) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const header = Buffer.alloc(SLP_HEADER_LENGTH);
    const { bytesRead } = await handle.read(header, 0, SLP_HEADER_LENGTH, 0);
    const prefixLength = Math.min(bytesRead, SLP_RAW_HEADER.length);
    if (!header.subarray(0, prefixLength).equals(SLP_RAW_HEADER.subarray(0, prefixLength))) {
      return null;
    }
    if (bytesRead < SLP_HEADER_LENGTH) {
      // Header not fully written yet: the game has only just started.
      return 0;
    }
    return header.readUInt32BE(SLP_RAW_HEADER.length);
  } finally {
    await handle.close();
  }
}

// Unrecognized files are reported as complete so they take the normal upload path.
async function isSlpFileComplete(filePath) {
  const rawLength = await readSlpRawLength(filePath);
  return rawLength !== 0;
}

// A Readable that tails a growing .slp: it emits newly written bytes as they
// appear and ends once the header reports the game finished and the file stops
// growing, the idle timeout elapses, or the file disappears.
class SlpTailStream extends Readable {
  constructor({ filePath, pollIntervalMs, idleTimeoutMs, onLog }) {
    super();
    this.filePath = filePath;
    this.pollIntervalMs = Math.max(200, pollIntervalMs || 500);
    this.idleTimeoutMs = idleTimeoutMs || STREAM_IDLE_TIMEOUT_MS;
    this.onLog = onLog || (() => {});
    this.offset = 0;
    this.lastProgress = Date.now();
    this.lastSize = -1;
    this.timer = null;
    this.reading = false;
    this.finished = false;
    this.hash = crypto.createHash("sha256");
    this.bytesStreamed = 0;
  }

  _read() {
    if (this.finished || this.reading || this.timer !== null) {
      return;
    }
    this._scheduleTick(0);
  }

  _destroy(err, callback) {
    this.finished = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    callback(err);
  }

  _scheduleTick(delay) {
    if (this.finished) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this._tick().catch((err) => this._finish(err));
    }, delay);
  }

  async _tick() {
    if (this.finished) {
      return;
    }
    this.reading = true;

    let stat;
    let rawLength;
    try {
      stat = await fs.promises.stat(this.filePath);
      rawLength = await readSlpRawLength(this.filePath);
    } catch {
      this.reading = false;
      this._finish(null);
      return;
    }

    const size = stat.size;
    let backpressured = false;

    if (size > this.offset) {
      const chunk = await this._readRange(this.offset, size);
      this.offset += chunk.length;
      this.lastProgress = Date.now();
      this.hash.update(chunk);
      this.bytesStreamed += chunk.length;
      backpressured = !this.push(chunk);
    }

    if (rawLength !== 0 && size === this.offset && size === this.lastSize) {
      // Game finished: header length patched in and the file stopped growing.
      this.reading = false;
      this._finish(null);
      return;
    }
    if (Date.now() - this.lastProgress > this.idleTimeoutMs) {
      this.onLog(`Live upload idle timeout reached for ${this.filePath}; finalizing`);
      this.reading = false;
      this._finish(null);
      return;
    }

    this.lastSize = size;
    this.reading = false;

    if (this.finished || backpressured) {
      // When backpressured, a later _read() resumes ticking.
      return;
    }
    this._scheduleTick(this.pollIntervalMs);
  }

  _readRange(start, end) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const rs = fs.createReadStream(this.filePath, { start, end: end - 1 });
      rs.on("data", (chunk) => chunks.push(chunk));
      rs.on("error", reject);
      rs.on("end", () => resolve(Buffer.concat(chunks)));
    });
  }

  _finish(err) {
    if (this.finished) {
      return;
    }
    this.finished = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (err) {
      this.destroy(err);
      return;
    }
    this.push(null);
  }
}

// Live-stream a growing .slp to the server, returning the hash and size of the
// bytes streamed once the transfer completes.
async function streamSlpUpload({ filePath, config, onLog }) {
  const tail = new SlpTailStream({
    filePath,
    pollIntervalMs: config.pollIntervalMs,
    idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    onLog,
  });

  const uploadUrl = buildStreamUrl(config.serverUrl, config.uploadPath);
  let response;
  try {
    response = await axios.post(uploadUrl, tail, {
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "X-API-Token": config.apiToken,
        "X-Filename": path.basename(filePath),
        "Content-Type": "application/octet-stream",
      },
      timeout: 0,
    });
  } finally {
    tail.destroy();
  }

  return {
    hash: tail.hash.digest("hex"),
    sizeBytes: tail.bytesStreamed,
    remoteName: response?.data?.name || path.basename(filePath),
    remoteFolder: response?.data?.folder || null,
  };
}

module.exports = {
  SLP_RAW_HEADER,
  STREAM_IDLE_TIMEOUT_MS,
  buildStreamUrl,
  readSlpRawLength,
  isSlpFileComplete,
  streamSlpUpload,
};
