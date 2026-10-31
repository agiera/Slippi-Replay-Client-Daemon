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

test("scanNow reports a missing directory when none is configured", async () => {
  const { watcher, events } = makeWatcher({ watchDir: "" });
  await watcher.scanNow();
  assert.deepEqual(events.statuses, ["Watch directory not found"]);
  assert.deepEqual(events.candidates, []);
});

test("scanNow honors every configured extension and logs completion", async (t) => {
  const dir = makeTempDir(t);
  for (const name of ["a.slp", "b.zlp", "c.mp4"]) fs.writeFileSync(path.join(dir, name), "");
  const { watcher, events } = makeWatcher({ watchDir: dir, includeExtensions: [".slp", ".zlp"] });
  await watcher.scanNow();
  assert.deepEqual(events.candidates.map((f) => path.basename(f)).sort(), ["a.slp", "b.zlp"]);
  assert.deepEqual(events.logs, [`Completed scan for ${dir}`]);
});

test("start ignores files that existed before watching", async (t) => {
  const dir = makeTempDir(t);
  fs.writeFileSync(path.join(dir, "existing.slp"), "x");
  const { watcher, events } = makeWatcher({ watchDir: dir });
  watcher.start();
  t.after(() => watcher.stop());

  await new Promise((resolve) => setTimeout(resolve, 300));
  const fresh = path.join(dir, "fresh.slp");
  fs.writeFileSync(fresh, "x");
  await waitFor(() => events.candidates.includes(fresh));
  assert.ok(!events.candidates.some((f) => f.endsWith("existing.slp")));
});

test("start reports changes to replay files being written", async (t) => {
  const dir = makeTempDir(t);
  const replay = path.join(dir, "live.slp");
  fs.writeFileSync(replay, "x");
  const { watcher, events } = makeWatcher({ watchDir: dir });
  watcher.start();
  t.after(() => watcher.stop());

  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.appendFileSync(replay, "more");
  await waitFor(() => events.candidates.includes(replay));
});

test("start detects replays in subdirectories", async (t) => {
  const dir = makeTempDir(t);
  fs.mkdirSync(path.join(dir, "2026-10"));
  const { watcher, events } = makeWatcher({ watchDir: dir });
  watcher.start();
  t.after(() => watcher.stop());

  await new Promise((resolve) => setTimeout(resolve, 300));
  const nested = path.join(dir, "2026-10", "Game.slp");
  fs.writeFileSync(nested, "x");
  await waitFor(() => events.candidates.includes(nested));
});

test("stop halts events and is safe to call repeatedly", async (t) => {
  const dir = makeTempDir(t);
  const { watcher, events } = makeWatcher({ watchDir: dir });
  watcher.stop();
  assert.deepEqual(events.logs, [], "stopping an unstarted watcher logs nothing");

  watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  watcher.stop();
  watcher.stop();
  assert.equal(events.logs.filter((l) => l === "Watcher stopped").length, 1);

  fs.writeFileSync(path.join(dir, "after.slp"), "x");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(events.candidates, []);
});
