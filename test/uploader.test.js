const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { createUploader, buildUploadUrl, buildCheckUrl, sha256File, waitForStableSize } = require("../src/uploader");
const { makeTempDir, startServer, waitFor, completeSlpBytes, partialSlpBytes, finishSlp } = require("./helpers");

test("buildUploadUrl joins server and path", () => {
  assert.equal(buildUploadUrl("http://h/", "/api/up"), "http://h/api/up");
  assert.equal(buildUploadUrl("http://h", "api/up"), "http://h/api/up");
});

test("buildCheckUrl derives the hash check endpoint", () => {
  assert.equal(buildCheckUrl("http://h", "/api/v1/uploads/files"), "http://h/api/v1/uploads/files/check");
  assert.equal(buildCheckUrl("http://h/", "api/up/"), "http://h/api/up/check");
});

// A replay server whose /check endpoint reports hashes from `existing`; every
// other request goes to `handler`. `uploads` excludes the check requests.
async function startReplayServer(t, handler, { existing = {}, checkStatus = 200 } = {}) {
  const server = await startServer(t, (req) => {
    if (req.url.endsWith("/check")) {
      if (checkStatus !== 200) return { status: checkStatus, json: { detail: "check unavailable" } };
      const { hashes } = JSON.parse(req.body.toString());
      return { json: { existing: Object.fromEntries(hashes.filter((h) => existing[h]).map((h) => [h, existing[h]])) } };
    }
    return handler ? handler(req) : undefined;
  });
  return {
    url: server.url,
    get uploads() {
      return server.requests.filter((r) => !r.url.endsWith("/check"));
    },
    get checks() {
      return server.requests.filter((r) => r.url.endsWith("/check")).map((r) => ({ ...r, json: JSON.parse(r.body.toString()) }));
    },
  };
}

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

  const server = await startReplayServer(t, () => ({ json: { name: "Game_1.slp", folder: "2026" } }));
  const config = { serverUrl: server.url, uploadPath: "/api/v1/uploads/files", apiToken: "tok", pollIntervalMs: 100 };
  const { uploader, events, state } = makeUploader({ config });

  uploader.enqueue(file);
  await waitFor(() => events.statuses.includes("Uploaded: Game_1.slp"));

  assert.equal(server.uploads.length, 1);
  const req = server.uploads[0];
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

  const server = await startReplayServer(t);
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok" };
  const { uploader, events } = makeUploader({ config, state: { uploaded: { [hash]: {} } } });

  uploader.enqueue(file);
  await waitFor(() => events.statuses.includes("Already uploaded: dup.slp"));
  assert.equal(server.uploads.length, 0);
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

  const server = await startReplayServer(t, () => ({ json: { name: "Live.slp", folder: "live" } }));
  const config = { serverUrl: server.url, uploadPath: "/api/v1/uploads/files", apiToken: "tok", pollIntervalMs: 100 };
  const { uploader, events, state } = makeUploader({ config });

  uploader.enqueue(file);
  // Simulates the watcher's repeated `change` events during a live game.
  uploader.enqueue(file);
  await new Promise((r) => setTimeout(r, 300));
  uploader.enqueue(file);
  finishSlp(file);

  await waitFor(() => events.statuses.includes("Uploaded (live): Live.slp"));

  assert.equal(server.uploads.length, 1);
  assert.equal(server.uploads[0].url, "/api/v1/uploads/files/stream");
  const final = fs.readFileSync(file);
  assert.deepEqual(server.uploads[0].body.subarray(15), final.subarray(15));

  // The finished file's hash is recorded so later scans dedupe it.
  const hash = crypto.createHash("sha256").update(final).digest("hex");
  assert.equal(state.uploaded[hash].remoteFolder, "live");
  assert.equal(state.uploaded[hash].sizeBytes, final.length);
  assert.equal(state.files[file].hash, hash);

  // The game-end `change` event must not trigger a second upload.
  uploader.enqueue(file);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(server.uploads.length, 1);
});

test("a live stream does not block uploads of other files", async (t) => {
  const dir = makeTempDir(t);
  const live = path.join(dir, "Live.slp");
  const done = path.join(dir, "Done.slp");
  fs.writeFileSync(live, partialSlpBytes());
  fs.writeFileSync(done, completeSlpBytes());

  const server = await startReplayServer(t, (req) => ({ json: { name: req.url.endsWith("/stream") ? "Live.slp" : "Done.slp" } }));
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

  const server = await startReplayServer(t, () => ({ json: { name: "Game.slp" } }));
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok" };
  const { uploader, events } = makeUploader({ config });

  uploader.enqueue(file);
  await waitFor(() => events.statuses.includes("Uploaded: Game.slp"));
  assert.equal(server.uploads[0].headers["x-content-sha256"], crypto.createHash("sha256").update(completeSlpBytes()).digest("hex"));

  const statusCount = events.statuses.length;
  uploader.enqueue(file);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(server.uploads.length, 1);
  assert.equal(events.statuses.length, statusCount, "index hit should not hash or report");

  fs.appendFileSync(file, "x");
  uploader.enqueue(file);
  await waitFor(() => server.uploads.length === 2);
});

test("a 409 from the server is recorded as already uploaded", async (t) => {
  const file = path.join(makeTempDir(t), "Dup.slp");
  fs.writeFileSync(file, completeSlpBytes());

  const server = await startReplayServer(t, () => ({ status: 409, json: { detail: "exists", name: "Dup.slp", folder: "x" } }));
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok" };
  const { uploader, events, state } = makeUploader({ config });

  uploader.enqueue(file);
  await waitFor(() => events.statuses.includes("Uploaded: Dup.slp"));
  assert.equal(server.uploads.length, 1);
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

const H = (n) => String(n).repeat(64).slice(0, 64);

test("reconcileWithServer drops entries the server no longer has, in batches", async (t) => {
  const uploaded = {};
  for (let i = 0; i < 1001; i += 1) {
    uploaded[crypto.createHash("sha256").update(String(i)).digest("hex")] = { remoteName: `${i}.slp` };
  }
  const hashes = Object.keys(uploaded);
  const kept = new Set(hashes.slice(0, 1000));
  const existing = Object.fromEntries([...kept].map((h) => [h, { name: "x.slp", folder: "f" }]));
  const server = await startReplayServer(t, null, { existing });

  const state = { uploaded, files: { "/r/gone.slp": { hash: hashes[1000] }, "/r/kept.slp": { hash: hashes[0] } } };
  const config = { serverUrl: server.url, uploadPath: "/api/v1/uploads/files", apiToken: "tok" };
  const { uploader, events } = makeUploader({ config, state });

  await uploader.reconcileWithServer();

  assert.deepEqual(new Set(Object.keys(state.uploaded)), kept);
  assert.deepEqual(Object.keys(state.files), ["/r/kept.slp"]);
  assert.equal(events.persists, 1);
  assert.deepEqual(events.statuses, ["Re-sync needed for 1 files"]);
  assert.deepEqual(server.checks.map((c) => c.json.hashes.length), [1000, 1]);
  assert.equal(server.checks[0].url, "/api/v1/uploads/files/check");
  assert.equal(server.checks[0].headers["x-api-token"], "tok");
});

test("reconcileWithServer keeps state intact when the server errors", async (t) => {
  const server = await startReplayServer(t, null, { checkStatus: 500 });
  const state = { uploaded: { [H(1)]: { remoteName: "a.slp" } } };
  const config = { serverUrl: server.url, uploadPath: "/api/v1/uploads/files", apiToken: "tok" };
  const { uploader, events } = makeUploader({ config, state });

  await uploader.reconcileWithServer();

  assert.deepEqual(Object.keys(state.uploaded), [H(1)]);
  assert.equal(events.persists, 0);
  assert.deepEqual(events.errors, ["State reconciliation skipped: check unavailable"]);
});

test("reconcileWithServer skips quietly on servers without the check endpoint", async (t) => {
  const server = await startReplayServer(t, null, { checkStatus: 404 });
  const state = { uploaded: { [H(1)]: { remoteName: "a.slp" } } };
  const config = { serverUrl: server.url, uploadPath: "/api/v1/uploads/files", apiToken: "tok" };
  const { uploader, events } = makeUploader({ config, state });

  await uploader.reconcileWithServer();

  assert.deepEqual(Object.keys(state.uploaded), [H(1)]);
  assert.equal(events.errors.length, 0);
  assert.ok(events.logs.some((l) => /does not support hash checks/.test(l)));
});

test("reconcileWithServer keeps entries recorded during the check", async (t) => {
  const server = await startReplayServer(t);
  const state = {
    uploaded: {
      [H(1)]: { remoteName: "old.slp", uploadedAt: new Date(Date.now() - 60000).toISOString() },
      [H(2)]: { remoteName: "fresh.slp", uploadedAt: new Date(Date.now() + 60000).toISOString() },
    },
  };
  const config = { serverUrl: server.url, uploadPath: "/api/v1/uploads/files", apiToken: "tok" };
  const { uploader } = makeUploader({ config, state });

  await uploader.reconcileWithServer();

  assert.deepEqual(Object.keys(state.uploaded), [H(2)]);
  assert.deepEqual(server.checks[0].json.hashes, [H(1)]);
});

test("files the server already has are recorded without uploading", async (t) => {
  const file = path.join(makeTempDir(t), "Known.slp");
  fs.writeFileSync(file, completeSlpBytes());
  const hash = crypto.createHash("sha256").update(completeSlpBytes()).digest("hex");

  const server = await startReplayServer(t, () => assert.fail("must not upload"), {
    existing: { [hash]: { id: 7, name: "stored.slp", folder: "uploads/public" } },
  });
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok" };
  const { uploader, events, state } = makeUploader({ config });

  uploader.enqueue(file);
  await waitFor(() => events.statuses.includes("Already on server: Known.slp"));

  assert.equal(server.uploads.length, 0);
  assert.deepEqual(server.checks[0].json, { hashes: [hash] });
  assert.equal(state.uploaded[hash].remoteName, "stored.slp");
  assert.equal(state.files[file].hash, hash);
});

test("an unavailable hash check falls back to uploading", async (t) => {
  const file = path.join(makeTempDir(t), "Fallback.slp");
  fs.writeFileSync(file, completeSlpBytes());
  const server = await startReplayServer(t, () => ({ json: { name: "Fallback.slp" } }), { checkStatus: 404 });
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok" };
  const { uploader, events } = makeUploader({ config });

  uploader.enqueue(file);
  await waitFor(() => events.statuses.includes("Uploaded: Fallback.slp"));
  assert.equal(server.uploads.length, 1);
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
  const server = await startReplayServer(t, () => {
    calls += 1;
    return calls === 1 ? { status: 503, json: { detail: "busy" } } : { json: { name: "retry.slp" } };
  });
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok" };
  const { uploader, events } = makeUploader({ config });

  uploader.enqueue(file);
  await waitFor(() => events.statuses.includes("Uploaded: retry.slp"));

  assert.equal(server.uploads.length, 2);
  assert.ok(events.statuses.includes("Upload failed (1/3): busy"));
  assert.match(events.errors[0], /Upload failed for .*retry\.slp \(1\/3\): busy/);
});

test("a live stream answered with 409 is recorded under the server's hash, not retried", async (t) => {
  const file = path.join(makeTempDir(t), "Live409.slp");
  fs.writeFileSync(file, partialSlpBytes());
  const server = await startReplayServer(t, () => ({ status: 409, json: { detail: "Replay already uploaded", name: "kept.slp", sha256: H(9) } }));
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok", pollIntervalMs: 100 };
  const { uploader, events, state } = makeUploader({ config });

  uploader.enqueue(file);
  setTimeout(() => finishSlp(file), 200);
  await waitFor(() => events.statuses.includes("Already on server: Live409.slp"));

  assert.equal(server.uploads.length, 1);
  assert.equal(events.errors.length, 0);
  assert.equal(state.uploaded[H(9)].remoteName, "kept.slp");
  assert.equal(state.files[file].hash, H(9));
});

test("an abandoned game is streamed and finalized without waiting for the idle timeout", async (t) => {
  const file = path.join(makeTempDir(t), "Crashed.slp");
  fs.writeFileSync(file, partialSlpBytes());
  const longAgo = new Date(Date.now() - 24 * 3600 * 1000);
  fs.utimesSync(file, longAgo, longAgo);

  const server = await startReplayServer(t, () => ({ json: { name: "Crashed.slp", sha256: H(4) } }));
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok", pollIntervalMs: 100 };
  const { uploader, events, state } = makeUploader({ config });

  const started = Date.now();
  uploader.enqueue(file);
  await waitFor(() => events.statuses.includes("Uploaded (live): Crashed.slp"), { timeoutMs: 3000 });
  assert.ok(Date.now() - started < 2000);

  assert.deepEqual(server.uploads[0].body, partialSlpBytes());
  // The server patches the header before storing, so only its hash will match
  // later startup checks; the unfinished file on disk hashes differently.
  assert.equal(state.files[file].hash, H(4));
  assert.ok(state.uploaded[H(4)]);
});

// Shortens the uploader's retry backoff (attempt * 2000ms) so retry tests run fast.
// Writes a file with an old mtime so the uploader skips its stable-size wait.
function writeSettled(file, contents) {
  fs.writeFileSync(file, contents);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(file, old, old);
}

function fastRetries(t) {
  const realSetTimeout = global.setTimeout;
  t.mock.method(global, "setTimeout", (fn, ms, ...args) => realSetTimeout(fn, ms === 2000 || ms === 4000 ? 1 : ms, ...args));
}

test("uploads send bearer and token headers and fall back to the local name", async (t) => {
  const file = path.join(makeTempDir(t), "Plain.slp");
  writeSettled(file, completeSlpBytes());
  const server = await startReplayServer(t, () => ({ json: {} }));
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok" };
  const { uploader, events, state } = makeUploader({ config });

  uploader.enqueue(file);
  await waitFor(() => events.statuses.includes("Uploaded: Plain.slp"));

  assert.equal(server.uploads[0].headers.authorization, "Bearer tok");
  assert.equal(server.checks[0].headers.authorization, "Bearer tok");
  const record = Object.values(state.uploaded)[0];
  assert.equal(record.remoteName, "Plain.slp");
  assert.equal(record.remoteFolder, null);
  assert.equal(record.fileName, "Plain.slp");
  assert.equal(record.filePath, file);
  assert.ok(!Number.isNaN(Date.parse(record.uploadedAt)));
});

test("uploads give up after three failed attempts without recording state", async (t) => {
  fastRetries(t);
  const file = path.join(makeTempDir(t), "Broken.slp");
  writeSettled(file, completeSlpBytes());
  const server = await startReplayServer(t, () => ({ status: 500, json: { detail: "kaput" } }));
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok" };
  const { uploader, events, state } = makeUploader({ config });

  uploader.enqueue(file);
  await waitFor(() => events.logs.some((l) => l.startsWith("Giving up on")));

  assert.equal(server.uploads.length, 3);
  assert.deepEqual(
    events.statuses.filter((s) => s.startsWith("Upload failed")),
    ["Upload failed (1/3): kaput", "Upload failed (2/3): kaput", "Upload failed (3/3): kaput"],
  );
  assert.deepEqual(state.uploaded, {});
  assert.equal(events.persists, 0);

  // Once given up, the file is no longer active and can be enqueued again.
  uploader.enqueue(file);
  await waitFor(() => events.logs.filter((l) => l.startsWith("Giving up on")).length === 2);
  assert.equal(server.uploads.length, 6);
});

test("connection errors are reported with the transport message", async (t) => {
  fastRetries(t);
  const file = path.join(makeTempDir(t), "Offline.slp");
  writeSettled(file, completeSlpBytes());
  const config = { serverUrl: "http://127.0.0.1:1", uploadPath: "/up", apiToken: "tok" };
  const { uploader, events } = makeUploader({ config });

  uploader.enqueue(file);
  await waitFor(() => events.logs.some((l) => l.startsWith("Giving up on")));

  assert.ok(events.logs.some((l) => /^Hash check failed for .*Offline\.slp: /.test(l)));
  assert.equal(events.errors.length, 3);
  assert.match(events.errors[0], /ECONNREFUSED/);
});

test("a failing hash check is logged and the upload still happens", async (t) => {
  const file = path.join(makeTempDir(t), "CheckDown.slp");
  writeSettled(file, completeSlpBytes());
  const server = await startReplayServer(t, () => ({ json: { name: "CheckDown.slp" } }), { checkStatus: 500 });
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok" };
  const { uploader, events } = makeUploader({ config });

  uploader.enqueue(file);
  await waitFor(() => events.statuses.includes("Uploaded: CheckDown.slp"));

  assert.equal(server.uploads.length, 1);
  assert.ok(events.logs.some((l) => /^Hash check failed for .*CheckDown\.slp/.test(l)));
  assert.equal(events.errors.length, 0);
});

test("identical content at a second path is indexed without re-uploading", async (t) => {
  const dir = makeTempDir(t);
  const first = path.join(dir, "a.slp");
  const copy = path.join(dir, "copy.slp");
  writeSettled(first, completeSlpBytes());
  writeSettled(copy, completeSlpBytes());

  const server = await startReplayServer(t, () => ({ json: { name: "a.slp" } }));
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok" };
  const { uploader, events, state } = makeUploader({ config });

  uploader.enqueue(first);
  await waitFor(() => events.statuses.includes("Uploaded: a.slp"));
  uploader.enqueue(copy);
  await waitFor(() => events.statuses.includes("Already uploaded: copy.slp"));

  assert.equal(server.uploads.length, 1);
  assert.equal(state.files[copy].hash, state.files[first].hash);
  assert.equal(Object.keys(state.uploaded).length, 1);
});

test("state from older versions without a files index is upgraded in place", async (t) => {
  const file = path.join(makeTempDir(t), "Legacy.slp");
  writeSettled(file, completeSlpBytes());
  const server = await startReplayServer(t, () => ({ json: { name: "Legacy.slp" } }));
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok" };
  const { uploader, events, state } = makeUploader({ config, state: { uploaded: {} } });

  uploader.enqueue(file);
  await waitFor(() => events.statuses.includes("Uploaded: Legacy.slp"));
  assert.equal(typeof state.files[file].hash, "string");
  assert.equal(state.files[file].size, completeSlpBytes().length);
});

test("non-.slp files are fully uploaded even if they look like live replays", async (t) => {
  const file = path.join(makeTempDir(t), "Odd.zlp");
  writeSettled(file, partialSlpBytes());
  const server = await startReplayServer(t, () => ({ json: { name: "Odd.zlp" } }));
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok", pollIntervalMs: 100 };
  const { uploader, events } = makeUploader({ config });

  uploader.enqueue(file);
  await waitFor(() => events.statuses.includes("Uploaded: Odd.zlp"));
  assert.equal(server.uploads[0].url, "/up");
  assert.match(server.uploads[0].headers["content-type"], /^multipart\/form-data/);
});

test("directories are ignored without uploading or reporting", async (t) => {
  const dir = path.join(makeTempDir(t), "folder.slp");
  fs.mkdirSync(dir);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(dir, old, old);
  const server = await startReplayServer(t);
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok" };
  const { uploader, events } = makeUploader({ config });

  uploader.enqueue(dir);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(server.uploads.length + server.checks.length, 0);
  assert.deepEqual(events.statuses, []);
  assert.deepEqual(events.errors, []);
});

test("a failed live stream is retried", async (t) => {
  fastRetries(t);
  const file = path.join(makeTempDir(t), "Flaky.slp");
  fs.writeFileSync(file, partialSlpBytes());
  // An abandoned game finalizes after one quiet poll instead of the idle timeout.
  const longAgo = new Date(Date.now() - 24 * 3600 * 1000);
  fs.utimesSync(file, longAgo, longAgo);

  let calls = 0;
  const server = await startReplayServer(t, () => {
    calls += 1;
    return calls === 1 ? { status: 502, json: { detail: "bad gateway" } } : { json: { name: "Flaky.slp", sha256: H(5) } };
  });
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok", pollIntervalMs: 100 };
  const { uploader, events, state } = makeUploader({ config });

  uploader.enqueue(file);
  await waitFor(() => events.statuses.includes("Uploaded (live): Flaky.slp"));

  assert.equal(server.uploads.length, 2);
  assert.ok(server.uploads.every((r) => r.url === "/up/stream"));
  assert.ok(events.statuses.includes("Upload failed (1/3): bad gateway"));
  assert.ok(state.uploaded[H(5)]);
});

test("many queued files are all uploaded", async (t) => {
  const dir = makeTempDir(t);
  const files = [];
  for (let i = 0; i < 6; i += 1) {
    const file = path.join(dir, `G${i}.slp`);
    writeSettled(file, Buffer.concat([completeSlpBytes(), Buffer.from(String(i))]));
    files.push(file);
  }
  const server = await startReplayServer(t, () => ({ json: {} }));
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok" };
  const { uploader, events, state } = makeUploader({ config });

  files.forEach((f) => uploader.enqueue(f));
  await waitFor(() => events.statuses.filter((s) => s.startsWith("Uploaded: ")).length === 6);

  assert.equal(server.uploads.length, 6);
  assert.equal(Object.keys(state.uploaded).length, 6);
  assert.deepEqual(Object.keys(state.files).sort(), files.sort());
});

test("reconcileWithServer makes no request when nothing has been uploaded", async (t) => {
  const server = await startReplayServer(t);
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok" };
  const { uploader, events } = makeUploader({ config });
  await uploader.reconcileWithServer();
  assert.equal(server.checks.length, 0);
  assert.equal(events.persists, 0);
});

test("reconcileWithServer does not persist when every entry still exists", async (t) => {
  const server = await startReplayServer(t, null, { existing: { [H(1)]: { name: "a.slp" } } });
  const state = { uploaded: { [H(1)]: {} }, files: { "/r/a.slp": { hash: H(1) } } };
  const config = { serverUrl: server.url, uploadPath: "/up", apiToken: "tok" };
  const { uploader, events } = makeUploader({ config, state });

  await uploader.reconcileWithServer();
  assert.equal(server.checks.length, 1);
  assert.equal(events.persists, 0);
  assert.deepEqual(events.statuses, []);
  assert.deepEqual(Object.keys(state.files), ["/r/a.slp"]);
});

test("waitForStableSize waits for a file that is still growing", async (t) => {
  const file = path.join(makeTempDir(t), "growing.slp");
  fs.writeFileSync(file, "a");
  const grow = setTimeout(() => fs.appendFileSync(file, "bcd"), 200);
  t.after(() => clearTimeout(grow));

  const stat = await waitForStableSize(file);
  assert.equal(stat.size, 4);
});
