const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const axios = require("axios");

// A finished Slippi game always contains the UBJSON `metadata` key ("U\x08metadata"),
// written only once the game ends and the root object is closed.
const SLP_METADATA_MARKER = Buffer.concat([Buffer.from([0x55, 0x08]), Buffer.from("metadata", "ascii")]);

// A live game with no new bytes for this long is treated as abandoned; whatever
// has been streamed so far is finalized by the server ("upload what we have").
const STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

function buildStreamUrl(serverUrl, uploadPath) {
  const safeServerUrl = serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl;
  const base = uploadPath.startsWith("/") ? uploadPath : `/${uploadPath}`;
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${safeServerUrl}${trimmed}/stream`;
}

// Resolve once we can tell whether a .slp already holds its end-of-game footer.
function isSlpFileComplete(filePath) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { highWaterMark: 1 << 20 });
    let carry = Buffer.alloc(0);
    let found = false;

    stream.on("data", (chunk) => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      if (buf.includes(SLP_METADATA_MARKER)) {
        found = true;
        stream.destroy();
        return;
      }
      carry = buf.subarray(Math.max(0, buf.length - (SLP_METADATA_MARKER.length - 1)));
    });
    stream.on("error", (err) => (found ? resolve(true) : reject(err)));
    stream.on("close", () => resolve(found));
    stream.on("end", () => resolve(found));
  });
}

// A Readable that tails a growing .slp: it emits newly written bytes as they
// appear and ends the stream once the UBJSON container closes (metadata written
// and file no longer growing), the idle timeout elapses, or the file disappears.
class SlpTailStream extends Readable {
  constructor({ filePath, pollIntervalMs, idleTimeoutMs, onLog }) {
    super();
    this.filePath = filePath;
    this.pollIntervalMs = Math.max(200, pollIntervalMs || 500);
    this.idleTimeoutMs = idleTimeoutMs || STREAM_IDLE_TIMEOUT_MS;
    this.onLog = onLog || (() => {});
    this.offset = 0;
    this.carry = Buffer.alloc(0);
    this.metadataSeen = false;
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
    try {
      stat = await fs.promises.stat(this.filePath);
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

      const scan = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
      if (!this.metadataSeen && scan.includes(SLP_METADATA_MARKER)) {
        this.metadataSeen = true;
      }
      this.carry = scan.subarray(Math.max(0, scan.length - (SLP_METADATA_MARKER.length - 1)));

      backpressured = !this.push(chunk);
    }

    if (this.metadataSeen && size === this.offset && size === this.lastSize) {
      // Game finished: footer written and the file stopped growing.
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

// Live-stream a growing .slp to the server, returning the final content hash and
// size once the transfer completes.
async function streamSlpUpload({ filePath, config, onLog }) {
  const tail = new SlpTailStream({
    filePath,
    pollIntervalMs: config.pollIntervalMs,
    idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    onLog,
  });

  const uploadUrl = buildStreamUrl(config.serverUrl, config.uploadPath);
  const response = await axios.post(uploadUrl, tail, {
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

  return {
    hash: tail.hash.digest("hex"),
    sizeBytes: tail.bytesStreamed,
    remoteName: response?.data?.name || path.basename(filePath),
    remoteFolder: response?.data?.folder || null,
  };
}

module.exports = {
  SLP_METADATA_MARKER,
  STREAM_IDLE_TIMEOUT_MS,
  buildStreamUrl,
  isSlpFileComplete,
  streamSlpUpload,
};
