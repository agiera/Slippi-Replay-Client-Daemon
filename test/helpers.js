const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slippi-daemon-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeApp(userDataDir) {
  return { getPath: (name) => (name === "userData" ? userDataDir : os.tmpdir()) };
}

// Starts an HTTP server that records every request (including its full body)
// and replies via `handler(record)` -> { status, json }.
async function startServer(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const record = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(record);
      const { status = 200, json = {} } = (handler && handler(record)) || {};
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, requests };
}

function waitFor(predicate, { timeoutMs = 10000, intervalMs = 25 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

// Bytes that look like a finished .slp: they contain the UBJSON metadata key.
function completeSlpBytes() {
  return Buffer.concat([
    Buffer.from("{U\x03raw[$U#l", "latin1"),
    Buffer.from([0, 0, 0, 4, 1, 2, 3, 4]),
    Buffer.from([0x55, 0x08]),
    Buffer.from("metadata{}}", "latin1"),
  ]);
}

function partialSlpBytes() {
  return Buffer.from("{U\x03raw[$U#l\0\0\0\0frames", "latin1");
}

module.exports = { makeTempDir, fakeApp, startServer, waitFor, completeSlpBytes, partialSlpBytes };
