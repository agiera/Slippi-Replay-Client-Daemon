const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { buildStreamUrl, readSlpRawLength, isSlpFileComplete, streamSlpUpload } = require("../src/streamUpload");
const { makeTempDir, startServer, completeSlpBytes, partialSlpBytes, finishSlp } = require("./helpers");

test("buildStreamUrl normalizes slashes", () => {
  assert.equal(buildStreamUrl("http://h/", "/api/up/"), "http://h/api/up/stream");
  assert.equal(buildStreamUrl("http://h", "api/up"), "http://h/api/up/stream");
});

test("isSlpFileComplete reads the header raw length", async (t) => {
  const dir = makeTempDir(t);
  const complete = path.join(dir, "done.slp");
  const partial = path.join(dir, "live.slp");
  fs.writeFileSync(complete, completeSlpBytes());
  fs.writeFileSync(partial, partialSlpBytes());

  assert.equal(await isSlpFileComplete(complete), true);
  assert.equal(await isSlpFileComplete(partial), false);
  await assert.rejects(isSlpFileComplete(path.join(dir, "missing.slp")));
});

test("readSlpRawLength handles truncated and foreign files", async (t) => {
  const dir = makeTempDir(t);
  const truncated = path.join(dir, "start.slp");
  const empty = path.join(dir, "empty.slp");
  const foreign = path.join(dir, "other.slp");
  fs.writeFileSync(truncated, Buffer.from("{U\x03ra", "latin1"));
  fs.writeFileSync(empty, "");
  fs.writeFileSync(foreign, "not a replay file at all");

  assert.equal(await readSlpRawLength(truncated), 0);
  assert.equal(await readSlpRawLength(empty), 0);
  assert.equal(await readSlpRawLength(foreign), null);
  assert.equal(await isSlpFileComplete(foreign), true);
});

test("a metadata-like byte sequence inside a live game does not mark it complete", async (t) => {
  const file = path.join(makeTempDir(t), "tricky.slp");
  fs.writeFileSync(file, Buffer.concat([partialSlpBytes(), Buffer.from([0x55, 0x08]), Buffer.from("metadata")]));
  assert.equal(await isSlpFileComplete(file), false);
});

test("streamSlpUpload tails a growing file until the game ends", async (t) => {
  const file = path.join(makeTempDir(t), "Game_live.slp");
  const server = await startServer(t, () => ({ json: { name: "remote.slp", folder: "f" } }));

  const part1 = partialSlpBytes();
  const part2 = Buffer.from("more-frames", "latin1");
  fs.writeFileSync(file, part1);

  const growth = (async () => {
    await new Promise((r) => setTimeout(r, 300));
    fs.appendFileSync(file, part2);
    await new Promise((r) => setTimeout(r, 300));
    finishSlp(file);
  })();

  const result = await streamSlpUpload({
    filePath: file,
    config: { serverUrl: server.url, uploadPath: "/api/v1/uploads/files", apiToken: "tok", pollIntervalMs: 100 },
    onLog: () => {},
  });
  await growth;

  assert.equal(server.requests.length, 1);
  const req = server.requests[0];
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/api/v1/uploads/files/stream");
  assert.equal(req.headers["x-api-token"], "tok");
  assert.equal(req.headers.authorization, "Bearer tok");
  assert.equal(req.headers["x-filename"], "Game_live.slp");

  // Everything after the header is streamed exactly as written.
  const final = fs.readFileSync(file);
  assert.equal(req.body.length, final.length);
  assert.deepEqual(req.body.subarray(15), final.subarray(15));

  assert.equal(result.sizeBytes, final.length);
  assert.equal(result.hash, crypto.createHash("sha256").update(req.body).digest("hex"));
  assert.equal(result.remoteName, "remote.slp");
  assert.equal(result.remoteFolder, "f");
});

test("streamSlpUpload finalizes with what it has when the file disappears", async (t) => {
  const file = path.join(makeTempDir(t), "vanish.slp");
  const server = await startServer(t);
  const data = partialSlpBytes();
  fs.writeFileSync(file, data);

  setTimeout(() => fs.rmSync(file), 400);
  const result = await streamSlpUpload({
    filePath: file,
    config: { serverUrl: server.url, uploadPath: "/up", apiToken: "tok", pollIntervalMs: 100 },
  });

  assert.deepEqual(server.requests[0].body, data);
  assert.equal(result.sizeBytes, data.length);
  assert.equal(result.remoteName, "vanish.slp");
  assert.equal(result.remoteFolder, null);
});

test("streamSlpUpload treats a 409 as a duplicate and returns the server's hash", async (t) => {
  const file = path.join(makeTempDir(t), "dup.slp");
  fs.writeFileSync(file, completeSlpBytes());
  const serverHash = "a".repeat(64);
  const server = await startServer(t, () => ({ status: 409, json: { detail: "exists", name: "kept.slp", folder: "x", sha256: serverHash } }));

  const result = await streamSlpUpload({
    filePath: file,
    config: { serverUrl: server.url, uploadPath: "/up", apiToken: "tok", pollIntervalMs: 100 },
  });

  assert.equal(result.duplicate, true);
  assert.equal(result.serverHash, serverHash);
  assert.equal(result.remoteName, "kept.slp");
  assert.equal(result.remoteFolder, "x");
});

test("streamSlpUpload ignores a non-string server hash", async (t) => {
  const file = path.join(makeTempDir(t), "odd.slp");
  fs.writeFileSync(file, completeSlpBytes());
  const server = await startServer(t, () => ({ json: { sha256: 123 } }));

  const result = await streamSlpUpload({
    filePath: file,
    config: { serverUrl: server.url, uploadPath: "/up", apiToken: "tok", pollIntervalMs: 100 },
  });

  assert.equal(result.serverHash, null);
  assert.equal(result.duplicate, false);
  assert.equal(result.remoteName, "odd.slp");
});

test("streamSlpUpload ends promptly for an already finished file", async (t) => {
  const file = path.join(makeTempDir(t), "done.slp");
  fs.writeFileSync(file, completeSlpBytes());
  const server = await startServer(t);

  const started = Date.now();
  const result = await streamSlpUpload({
    filePath: file,
    config: { serverUrl: server.url, uploadPath: "/up", apiToken: "tok", pollIntervalMs: 100 },
  });

  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(server.requests[0].body, completeSlpBytes());
  assert.equal(result.hash, crypto.createHash("sha256").update(completeSlpBytes()).digest("hex"));
});

test("streamSlpUpload rethrows server errors other than 409", async (t) => {
  const file = path.join(makeTempDir(t), "err.slp");
  fs.writeFileSync(file, completeSlpBytes());
  const server = await startServer(t, () => ({ status: 401, json: { detail: "bad token" } }));

  await assert.rejects(
    streamSlpUpload({ filePath: file, config: { serverUrl: server.url, uploadPath: "/up", apiToken: "nope", pollIntervalMs: 100 } }),
    (error) => error.response.status === 401 && error.response.data.detail === "bad token",
  );
});

test("streamSlpUpload finalizes an abandoned game and logs the idle timeout", async (t) => {
  const file = path.join(makeTempDir(t), "stale.slp");
  fs.writeFileSync(file, partialSlpBytes());
  const longAgo = new Date(Date.now() - 24 * 3600 * 1000);
  fs.utimesSync(file, longAgo, longAgo);
  const server = await startServer(t);
  const logs = [];

  await streamSlpUpload({
    filePath: file,
    config: { serverUrl: server.url, uploadPath: "/up", apiToken: "tok", pollIntervalMs: 100 },
    onLog: (l) => logs.push(l),
  });

  assert.deepEqual(server.requests[0].body, partialSlpBytes());
  assert.ok(logs.some((l) => /idle timeout reached for .*stale\.slp/.test(l)));
});

test("streamSlpUpload streams large files intact under backpressure", async (t) => {
  const file = path.join(makeTempDir(t), "big.slp");
  const payload = crypto.randomBytes(4 * 1024 * 1024);
  const contents = Buffer.concat([completeSlpBytes().subarray(0, 15), payload, Buffer.from("metadata{}}", "latin1")]);
  fs.writeFileSync(file, contents);
  const server = await startServer(t);

  const result = await streamSlpUpload({
    filePath: file,
    config: { serverUrl: server.url, uploadPath: "/up", apiToken: "tok", pollIntervalMs: 100 },
  });

  assert.equal(result.sizeBytes, contents.length);
  assert.ok(server.requests[0].body.equals(contents));
});
