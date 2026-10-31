const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { createWatcher, isReplayFile, walkDir } = require("../src/watcher");
const { makeTempDir, waitFor } = require("./helpers");

test("isReplayFile matches extensions case-insensitively", () => {
  assert.equal(isReplayFile("/a/Game.SLP", [".slp"]), true);
  assert.equal(isReplayFile("/a/game.zlp", [".slp", ".zlp"]), true);
  assert.equal(isReplayFile("/a/game.txt", [".slp"]), false);
  assert.equal(isReplayFile("/a/slp", [".slp"]), false);
});

test("walkDir visits files recursively and tolerates missing dirs", async (t) => {
  const dir = makeTempDir(t);
  fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
  fs.writeFileSync(path.join(dir, "root.slp"), "");
  fs.writeFileSync(path.join(dir, "a", "b", "deep.slp"), "");

  const seen = [];
  await walkDir(dir, (file) => seen.push(path.relative(dir, file)));
  assert.deepEqual(seen.sort(), [path.join("a", "b", "deep.slp"), "root.slp"].sort());

  await walkDir(path.join(dir, "missing"), () => assert.fail());
});

function makeWatcher(overrides) {
  const events = { candidates: [], statuses: [], logs: [] };
  const watcher = createWatcher({
    includeExtensions: [".slp"],
    pollIntervalMs: 100,
    onCandidate: (f) => events.candidates.push(f),
    onStatus: (s) => events.statuses.push(s),
    onLog: (l) => events.logs.push(l),
    ...overrides,
  });
  return { watcher, events };
}

test("scanNow enqueues only replay files", async (t) => {
  const dir = makeTempDir(t);
  fs.writeFileSync(path.join(dir, "one.slp"), "");
  fs.writeFileSync(path.join(dir, "notes.txt"), "");
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "two.SLP"), "");

  const { watcher, events } = makeWatcher({ watchDir: dir });
  await watcher.scanNow();
  assert.deepEqual(events.candidates.map((f) => path.basename(f)).sort(), ["one.slp", "two.SLP"].sort());
});

test("scanNow and start report missing directories", async (t) => {
  const missing = path.join(makeTempDir(t), "nope");

  const { watcher, events } = makeWatcher({ watchDir: missing });
  await watcher.scanNow();
  watcher.start();
  assert.deepEqual(events.statuses, ["Watch directory not found", "Watch directory does not exist"]);

  const empty = makeWatcher({ watchDir: "" });
  empty.watcher.start();
  assert.deepEqual(empty.events.statuses, ["No watch directory set"]);
});

test("start detects newly added replay files", async (t) => {
  const dir = makeTempDir(t);
  const { watcher, events } = makeWatcher({ watchDir: dir });
  watcher.start();
  t.after(() => watcher.stop());
  assert.equal(events.statuses.at(-1), `Watching: ${dir}`);

  // Let chokidar finish its initial (ignored) scan.
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.writeFileSync(path.join(dir, "ignored.txt"), "x");
  const replay = path.join(dir, "new.slp");
  fs.writeFileSync(replay, "x");

  await waitFor(() => events.candidates.includes(replay));
  assert.ok(events.candidates.every((f) => f.endsWith(".slp")));
});

test("start can use polling for network filesystems", async (t) => {
  const dir = makeTempDir(t);
  const { watcher, events } = makeWatcher({ watchDir: dir, usePolling: true });
  watcher.start();
  t.after(() => watcher.stop());
  assert.match(events.logs.at(-1), /\(polling\)$/);

  await new Promise((resolve) => setTimeout(resolve, 300));
  const replay = path.join(dir, "polled.slp");
  fs.writeFileSync(replay, "x");
  await waitFor(() => events.candidates.includes(replay));
});
