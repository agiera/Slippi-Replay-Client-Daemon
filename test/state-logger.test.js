const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { loadState, saveState } = require("../src/state");
const { createLogger } = require("../src/logger");
const { makeTempDir, fakeApp } = require("./helpers");

test("loadState returns a fresh initial state when missing or corrupt", (t) => {
  const dir = makeTempDir(t);
  const app = fakeApp(dir);

  const a = loadState(app);
  const b = loadState(app);
  assert.deepEqual(a, { uploaded: {}, files: {} });
  a.uploaded.x = 1;
  assert.deepEqual(b.uploaded, {}, "initial state must not be shared");

  fs.writeFileSync(path.join(dir, "state.json"), "garbage");
  assert.deepEqual(loadState(app), { uploaded: {}, files: {} });
});

test("saveState and loadState round-trip", (t) => {
  const app = fakeApp(path.join(makeTempDir(t), "sub"));
  saveState(app, { uploaded: { abc: { fileName: "a.slp" } } });
  assert.deepEqual(loadState(app).uploaded, { abc: { fileName: "a.slp" } });
  assert.deepEqual(loadState(app).files, {}, "older state files gain an empty index");
  assert.deepEqual(fs.readdirSync(path.dirname(path.join(app.getPath("userData"), "state.json"))), ["state.json"], "no temp files left behind");
});

test("logger appends leveled lines to daemon.log", async (t) => {
  const dir = makeTempDir(t);
  t.mock.method(console, "log", () => {});

  const logger = createLogger(fakeApp(dir));
  logger.info("hello");
  logger.warn("careful");
  logger.error("boom");
  await logger.close();

  assert.equal(logger.logPath, path.join(dir, "daemon.log"));
  const lines = fs.readFileSync(logger.logPath, "utf-8").trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T.* \[INFO\] hello$/);
  assert.match(lines[1], /\[WARN\] careful$/);
  assert.match(lines[2], /\[ERROR\] boom$/);
});

test("logger rotates daemon.log once it exceeds the size limit", async (t) => {
  const dir = makeTempDir(t);
  t.mock.method(console, "log", () => {});

  const logger = createLogger(fakeApp(dir), { maxBytes: 200 });
  for (let i = 0; i < 20; i += 1) {
    logger.info(`line ${i} ${"x".repeat(20)}`);
  }
  await logger.close();

  const current = fs.readFileSync(logger.logPath, "utf-8");
  const rotated = fs.readFileSync(`${logger.logPath}.1`, "utf-8");
  assert.ok(Buffer.byteLength(current) <= 200);
  assert.ok(rotated.length > 0);
  assert.match(current + rotated, /line 19 /, "newest line is kept");
  assert.doesNotMatch(current + rotated, /line 0 /, "oldest lines are dropped");
  assert.equal(fs.readdirSync(dir).sort().join(","), "daemon.log,daemon.log.1");
});

test("loadState repairs malformed fields and keeps unknown keys", (t) => {
  const dir = makeTempDir(t);
  const app = fakeApp(dir);
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ uploaded: null, files: 5, version: 2 }));
  assert.deepEqual(loadState(app), { uploaded: {}, files: {}, version: 2 });

  fs.writeFileSync(path.join(dir, "state.json"), "null");
  assert.deepEqual(loadState(app), { uploaded: {}, files: {} });
});

test("saveState overwrites previous state", (t) => {
  const app = fakeApp(makeTempDir(t));
  saveState(app, { uploaded: { a: {} }, files: {} });
  saveState(app, { uploaded: { b: {} }, files: {} });
  assert.deepEqual(Object.keys(loadState(app).uploaded), ["b"]);
});

test("logger appends to an existing log across restarts", async (t) => {
  const dir = makeTempDir(t);
  t.mock.method(console, "log", () => {});

  const first = createLogger(fakeApp(dir));
  first.info("one");
  await first.close();
  const second = createLogger(fakeApp(dir));
  second.info("two");
  await second.close();

  const lines = fs.readFileSync(second.logPath, "utf-8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /one$/);
  assert.match(lines[1], /two$/);
});

test("logger rotates an oversized log left from a previous run on startup", async (t) => {
  const dir = makeTempDir(t);
  t.mock.method(console, "log", () => {});
  fs.writeFileSync(path.join(dir, "daemon.log"), "old\n".repeat(100));

  const logger = createLogger(fakeApp(dir), { maxBytes: 100 });
  logger.info("fresh");
  await logger.close();

  assert.match(fs.readFileSync(logger.logPath, "utf-8"), /^\S+ \[INFO\] fresh\n$/);
  assert.equal(fs.readFileSync(`${logger.logPath}.1`, "utf-8"), "old\n".repeat(100));
});

test("logger echoes lines to the console", async (t) => {
  const dir = makeTempDir(t);
  const consoleLog = t.mock.method(console, "log", () => {});
  const logger = createLogger(fakeApp(dir));
  logger.warn("visible");
  await logger.close();
  assert.equal(consoleLog.mock.callCount(), 1);
  assert.match(consoleLog.mock.calls[0].arguments[0], /\[WARN\] visible$/);
});
