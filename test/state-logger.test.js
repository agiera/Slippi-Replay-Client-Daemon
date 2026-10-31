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
  assert.deepEqual(a, { uploaded: {} });
  a.uploaded.x = 1;
  assert.deepEqual(b.uploaded, {}, "initial state must not be shared");

  fs.writeFileSync(path.join(dir, "state.json"), "garbage");
  assert.deepEqual(loadState(app), { uploaded: {} });
});

test("saveState and loadState round-trip", (t) => {
  const app = fakeApp(path.join(makeTempDir(t), "sub"));
  saveState(app, { uploaded: { abc: { fileName: "a.slp" } } });
  assert.deepEqual(loadState(app).uploaded, { abc: { fileName: "a.slp" } });
});

test("logger appends leveled lines to daemon.log", (t) => {
  const dir = makeTempDir(t);
  t.mock.method(console, "log", () => {});

  const logger = createLogger(fakeApp(dir));
  logger.info("hello");
  logger.warn("careful");
  logger.error("boom");

  assert.equal(logger.logPath, path.join(dir, "daemon.log"));
  const lines = fs.readFileSync(logger.logPath, "utf-8").trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T.* \[INFO\] hello$/);
  assert.match(lines[1], /\[WARN\] careful$/);
  assert.match(lines[2], /\[ERROR\] boom$/);
});
