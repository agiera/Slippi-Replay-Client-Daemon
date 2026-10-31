const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { createUploader, buildUploadUrl, buildReplayListUrl, sha256File, waitForStableSize } = require("../src/uploader");
const { makeTempDir, startServer, waitFor, completeSlpBytes, partialSlpBytes, finishSlp } = require("./helpers");

test("buildUploadUrl joins server and path", () => {
  assert.equal(buildUploadUrl("http://h/", "/api/up"), "http://h/api/up");
  assert.equal(buildUploadUrl("http://h", "api/up"), "http://h/api/up");
});

test("buildReplayListUrl derives the replay list endpoint", () => {
  assert.equal(buildReplayListUrl("http://h", "/api/v1/uploads/files"), "http://h/api/v1/replays/files");
  assert.equal(buildReplayListUrl("http://h", "prefix/api/v2/uploads/files"), "http://h/prefix/api/v2/replays/files");
  assert.equal(buildReplayListUrl("http://h", "/custom"), "http://h/api/v1/replays/files");
});

test("sha256File hashes file contents", async (t) => {
  const file = path.join(makeTempDir(t), "a.bin");
  fs.writeFileSync(file, "hello");
  assert.equal(await sha256File(file), crypto.createHash("sha256").update("hello").digest("hex"));
});

function makeUploader({ config, state = { uploaded: {} } }) {
  const events = { statuses: [], logs: [], errors: [], persists: 0 };
  const uploader = createUploader({
    getConfig: () => config,
    getState: () => state,
    persistState: () => {
      events.persists += 1;
    },
    onStatus: (s) => events.statuses.push(s),
    onLog: (l) => events.logs.push(l),
    onError: (e) => events.errors.push(e),
  });
  return { uploader, events, state };
}

test("enqueue uploads a complete replay as multipart and records it", async (t) => {
  const dir = makeTempDir(t);
  const file = path.join(dir, "Game_1.slp");
  const contents = completeSlpBytes();
  fs.writeFileSync(file, contents);

  const server = await startServer(t, () => ({ json: { name: "Game_1.slp", folder: "2026" } }));
  const config = { serverUrl: server.url, uploadPath: "/api/v1/uploads/files", apiToken: "tok", pollIntervalMs: 100 };
  const { uploader, events, state } = makeUploader({ config });

  uploader.enqueue(file);
  await waitFor(() => events.statuses.includes("Uploaded: Game_1.slp"));

  assert.equal(server.requests.length, 1);
  const req = server.requests[0];
  assert.equal(req.url, "/api/v1/uploads/files");
  assert.match(req.headers["content-type"], /^multipart\/form-data/);
  assert.equal(req.headers["x-api-token"], "tok");
  assert.ok(req.body.includes(contents));
  assert.ok(req.body.toString("latin1").includes('filename="Game_1.slp"'));

  const hash = crypto.createHash("sha256").update(contents).digest("hex");
  assert.equal(state.uploaded[hash].remoteName, "Game_1.slp");
  assert.equal(state.uploaded[hash].remoteFolder, "2026");
  assert.equal(state.uploaded[hash].sizeBytes, contents.length);
  assert.equal(events.persists, 1);
});

test("enqueue skips files whose hash was already uploaded", async (t) => {
  const file = path.join(makeTempDir(t), "dup.slp");
  const contents = completeSlpBytes();
  fs.writeFileSync(file, contents);
  const hash = crypto.createHash("sha256").update(contents).digest("hex");

  const server = await startServer(t);
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok" };
  const { uploader, events } = makeUploader({ config, state: { uploaded: { [hash]: {} } } });

  uploader.enqueue(file);
  await waitFor(() => events.statuses.includes("Already uploaded: dup.slp"));
  assert.equal(server.requests.length, 0);
});

test("enqueue reports missing configuration without uploading", async (t) => {
  const file = path.join(makeTempDir(t), "x.slp");
  fs.writeFileSync(file, completeSlpBytes());

  const noToken = makeUploader({ config: { serverUrl: "http://127.0.0.1:1", uploadPath: "/up", apiToken: "" } });
  noToken.uploader.enqueue(file);
  await waitFor(() => noToken.events.errors.length > 0);
  assert.deepEqual(noToken.events.statuses, ["Upload skipped: API token missing"]);

  const noServer = makeUploader({ config: { serverUrl: "", uploadPath: "/up", apiToken: "tok" } });
  noServer.uploader.enqueue(file);
  await waitFor(() => noServer.events.errors.length > 0);
  assert.deepEqual(noServer.events.statuses, ["Upload skipped: server URL missing"]);
});

test("enqueue skips files that no longer exist", async (t) => {
  const file = path.join(makeTempDir(t), "gone.slp");
  const { uploader, events } = makeUploader({
    config: { serverUrl: "http://127.0.0.1:1", uploadPath: "/up", apiToken: "tok" },
  });
  uploader.enqueue(file);
  await waitFor(() => events.statuses.length > 0);
  assert.deepEqual(events.statuses, ["Skipped missing file: gone.slp"]);
});

test("enqueue live-streams an incomplete .slp and dedupes repeated enqueues", async (t) => {
  const file = path.join(makeTempDir(t), "Live.slp");
  fs.writeFileSync(file, partialSlpBytes());

  const server = await startServer(t, () => ({ json: { name: "Live.slp", folder: "live" } }));
  const config = { serverUrl: server.url, uploadPath: "/api/v1/uploads/files", apiToken: "tok", pollIntervalMs: 100 };
  const { uploader, events, state } = makeUploader({ config });

  uploader.enqueue(file);
  // Simulates the watcher's repeated `change` events during a live game.
  uploader.enqueue(file);
  await new Promise((r) => setTimeout(r, 300));
  uploader.enqueue(file);
  finishSlp(file);

  await waitFor(() => events.statuses.includes("Uploaded (live): Live.slp"));

  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].url, "/api/v1/uploads/files/stream");
  const final = fs.readFileSync(file);
  assert.deepEqual(server.requests[0].body.subarray(15), final.subarray(15));

  // The finished file's hash is recorded so later scans dedupe it.
  const hash = crypto.createHash("sha256").update(final).digest("hex");
  assert.equal(state.uploaded[hash].remoteFolder, "live");
  assert.equal(state.uploaded[hash].sizeBytes, final.length);
  assert.equal(state.files[file].hash, hash);

  // The game-end `change` event must not trigger a second upload.
  uploader.enqueue(file);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(server.requests.length, 1);
});

test("a live stream does not block uploads of other files", async (t) => {
  const dir = makeTempDir(t);
  const live = path.join(dir, "Live.slp");
  const done = path.join(dir, "Done.slp");
  fs.writeFileSync(live, partialSlpBytes());
  fs.writeFileSync(done, completeSlpBytes());

  const server = await startServer(t, (req) => ({ json: { name: req.url.endsWith("/stream") ? "Live.slp" : "Done.slp" } }));
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok", pollIntervalMs: 100 };
  const { uploader, events } = makeUploader({ config });

  uploader.enqueue(live);
  await new Promise((r) => setTimeout(r, 100));
  uploader.enqueue(done);

  await waitFor(() => events.statuses.includes("Uploaded: Done.slp"));
  assert.ok(!events.statuses.includes("Uploaded (live): Live.slp"), "live stream should still be running");

  finishSlp(live);
  await waitFor(() => events.statuses.includes("Uploaded (live): Live.slp"));
});

test("unchanged files are skipped without re-reading; modified files are re-uploaded", async (t) => {
  const file = path.join(makeTempDir(t), "Game.slp");
  fs.writeFileSync(file, completeSlpBytes());

  const server = await startServer(t, () => ({ json: { name: "Game.slp" } }));
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok" };
  const { uploader, events } = makeUploader({ config });

  uploader.enqueue(file);
  await waitFor(() => events.statuses.includes("Uploaded: Game.slp"));
  assert.equal(server.requests[0].headers["x-content-sha256"], crypto.createHash("sha256").update(completeSlpBytes()).digest("hex"));

  const statusCount = events.statuses.length;
  uploader.enqueue(file);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(server.requests.length, 1);
  assert.equal(events.statuses.length, statusCount, "index hit should not hash or report");

  fs.appendFileSync(file, "x");
  uploader.enqueue(file);
  await waitFor(() => server.requests.length === 2);
});

test("a 409 from the server is recorded as already uploaded", async (t) => {
  const file = path.join(makeTempDir(t), "Dup.slp");
  fs.writeFileSync(file, completeSlpBytes());

  const server = await startServer(t, () => ({ status: 409, json: { detail: "exists", name: "Dup.slp", folder: "x" } }));
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok" };
  const { uploader, events, state } = makeUploader({ config });

  uploader.enqueue(file);
  await waitFor(() => events.statuses.includes("Uploaded: Dup.slp"));
  assert.equal(server.requests.length, 1);
  const hash = crypto.createHash("sha256").update(completeSlpBytes()).digest("hex");
  assert.equal(state.uploaded[hash].remoteFolder, "x");
  assert.equal(events.errors.length, 0);
});

test("waitForStableSize returns immediately for settled files", async (t) => {
  const file = path.join(makeTempDir(t), "old.slp");
  fs.writeFileSync(file, "x");
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(file, old, old);

  const started = Date.now();
  const stat = await waitForStableSize(file);
  assert.ok(Date.now() - started < 100);
  assert.equal(stat.size, 1);
  assert.equal(await waitForStableSize(path.join(path.dirname(file), "missing")), null);
});

test("reconcileWithServer removes entries missing on the server across pages", async (t) => {
  const server = await startServer(t, (req) => {
    const url = new URL(req.url, "http://x");
    if (!url.searchParams.get("cursor")) {
      return { json: { items: [{ name: "a.slp", folder: "f1" }], next_cursor: "page2" } };
    }
    return { json: { items: [{ name: "b.slp" }], next_cursor: null } };
  });

  const state = {
    uploaded: {
      h1: { remoteName: "a.slp", remoteFolder: "f1" },
      h2: { fileName: "b.slp" },
      h3: { remoteName: "c.slp", remoteFolder: "f1" },
      h4: { remoteName: "a.slp", remoteFolder: "other" },
    },
  };
  const config = { serverUrl: server.url, uploadPath: "/api/v1/uploads/files", apiToken: "tok" };
  const { uploader, events } = makeUploader({ config, state });

  await uploader.reconcileWithServer();

  assert.deepEqual(Object.keys(state.uploaded).sort(), ["h1", "h2"]);
  assert.equal(events.persists, 1);
  assert.deepEqual(events.statuses, ["Re-sync needed for 2 files"]);
  assert.equal(server.requests.length, 2);
  assert.ok(server.requests.every((r) => r.url.startsWith("/api/v1/replays/files?")));
  assert.match(server.requests[0].url, /limit=200/);
  assert.match(server.requests[1].url, /cursor=page2/);
});

test("reconcileWithServer keeps state intact when the server errors", async (t) => {
  const server = await startServer(t, () => ({ status: 500, json: { detail: "db down" } }));
  const state = { uploaded: { h1: { remoteName: "a.slp" } } };
  const config = { serverUrl: server.url, uploadPath: "/api/v1/uploads/files", apiToken: "tok" };
  const { uploader, events } = makeUploader({ config, state });

  await uploader.reconcileWithServer();

  assert.deepEqual(Object.keys(state.uploaded), ["h1"]);
  assert.equal(events.persists, 0);
  assert.deepEqual(events.errors, ["State reconciliation skipped: db down"]);
});

test("reconcileWithServer keeps entries recorded during the fetch and prunes the file index", async (t) => {
  const server = await startServer(t, () => ({ json: { items: [], next_cursor: null } }));
  const state = {
    uploaded: {
      old: { remoteName: "old.slp", uploadedAt: new Date(Date.now() - 60000).toISOString() },
      fresh: { remoteName: "fresh.slp", uploadedAt: new Date(Date.now() + 60000).toISOString() },
    },
    files: {
      "/r/old.slp": { size: 1, mtimeMs: 1, hash: "old" },
      "/r/fresh.slp": { size: 1, mtimeMs: 1, hash: "fresh" },
    },
  };
  const config = { serverUrl: server.url, uploadPath: "/api/v1/uploads/files", apiToken: "tok" };
  const { uploader } = makeUploader({ config, state });

  await uploader.reconcileWithServer();

  assert.deepEqual(Object.keys(state.uploaded), ["fresh"]);
  assert.deepEqual(Object.keys(state.files), ["/r/fresh.slp"]);
});

test("reconcileWithServer does nothing without credentials", async () => {
  const state = { uploaded: { h1: {} } };
  const { uploader, events } = makeUploader({ config: { serverUrl: "", apiToken: "" }, state });
  await uploader.reconcileWithServer();
  assert.deepEqual(Object.keys(state.uploaded), ["h1"]);
  assert.equal(events.errors.length, 0);
});

test("failed uploads are retried", async (t) => {
  const file = path.join(makeTempDir(t), "retry.slp");
  fs.writeFileSync(file, completeSlpBytes());

  let calls = 0;
  const server = await startServer(t, () => {
    calls += 1;
    return calls === 1 ? { status: 503, json: { detail: "busy" } } : { json: { name: "retry.slp" } };
  });
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok" };
  const { uploader, events } = makeUploader({ config });

  uploader.enqueue(file);
  await waitFor(() => events.statuses.includes("Uploaded: retry.slp"));

  assert.equal(server.requests.length, 2);
  assert.ok(events.statuses.includes("Upload failed (1/3): busy"));
  assert.match(events.errors[0], /Upload failed for .*retry\.slp \(1\/3\): busy/);
});
