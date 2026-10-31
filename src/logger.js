const fs = require("fs");
const path = require("path");

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

// Appends to daemon.log through a non-blocking write stream and rotates it to
// daemon.log.1 once it exceeds `maxBytes`, so the log can never grow unbounded.
function createLogger(app, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const logPath = path.join(app.getPath("userData"), "daemon.log");
  const rotatedPath = `${logPath}.1`;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  let size = 0;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    size = 0;
  }

  function rotateFiles() {
    try {
      fs.rmSync(rotatedPath, { force: true });
      fs.renameSync(logPath, rotatedPath);
    } catch (error) {
      console.error(`Log rotation failed: ${error.message}`);
    }
    size = 0;
  }

  function openStream() {
    const next = fs.createWriteStream(logPath, { flags: "a" });
    next.on("error", (error) => console.error(`Log write failed: ${error.message}`));
    return next;
  }

  if (size > maxBytes) {
    rotateFiles();
  }

  let stream = openStream();
  // While a rotation is in flight, lines are buffered and flushed afterwards.
  let rotation = null;
  const pending = [];

  function rotate() {
    const old = stream;
    rotation = new Promise((resolve) => {
      // The old stream must be closed before renaming (required on Windows).
      old.end(() => {
        rotateFiles();
        stream = openStream();
        rotation = null;
        for (const line of pending.splice(0)) {
          write(line);
        }
        resolve();
      });
    });
  }

  function write(line) {
    if (rotation) {
      pending.push(line);
      return;
    }
    stream.write(line);
    size += Buffer.byteLength(line);
    if (size > maxBytes) {
      rotate();
    }
  }

  function log(level, message) {
    const line = `${new Date().toISOString()} [${level}] ${message}`;
    console.log(line);
    write(`${line}\n`);
  }

  async function close() {
    while (rotation) {
      await rotation;
    }
    await new Promise((resolve) => stream.end(resolve));
  }

  return {
    info: (message) => log("INFO", message),
    warn: (message) => log("WARN", message),
    error: (message) => log("ERROR", message),
    close,
    logPath,
  };
}

module.exports = {
  createLogger,
};
