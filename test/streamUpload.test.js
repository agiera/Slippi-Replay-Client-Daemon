const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  SLP_METADATA_MARKER,
  buildStreamUrl,
  isSlpFileComplete,
  streamSlpUpload,
} = require("../src/streamUpload");
const { makeTempDir, startServer, completeSlpBytes, partialSlpBytes } = require("./helpers");

test("buildStreamUrl normalizes slashes", () => {
  assert.equal(buildStreamUrl("http://h/", "/api/up/"), "http://h/api/up/stream");
  assert.equal(buildStreamUrl("http://h", "api/up"), "http://h/api/up/stream");
});

test("isSlpFileComplete detects the metadata marker", async (t) => {
  const dir = makeTempDir(t);
  const complete = path.join(dir, "done.slp");
  const partial = path.join(dir, "live.slp");
  fs.writeFileSync(complete, completeSlpBytes());
  fs.writeFileSync(partial, partialSlpBytes());

  assert.equal(await isSlpFileComplete(complete), true);
  assert.equal(await isSlpFileComplete(partial), false);
  await assert.rejects(isSlpFileComplete(path.join(dir, "missing.slp")));
});

test("isSlpFileComplete finds a marker split across read chunks", async (t) => {
  const file = path.join(makeTempDir(t), "big.slp");
  // Reads are 1 MiB; place the marker straddling that boundary.
  const filler = Buffer.alloc((1 << 20) - 4, 0x41);
  fs.writeFileSync(file, Buffer.concat([filler, SLP_METADATA_MARKER, Buffer.from("}")]));
  assert.equal(await isSlpFileComplete(file), true);
});

test("streamSlpUpload tails a growing file until the game ends", async (t) => {
  const file = path.join(makeTempDir(t), "Game_live.slp");
  const server = await startServer(t, () => ({ json: { name: "remote.slp", folder: "f" } }));

  const part1 = partialSlpBytes();
  const part2 = Buffer.from("more-frames", "latin1");
  const part3 = completeSlpBytes();
  fs.writeFileSync(file, part1);

  const growth = (async () => {
    await new Promise((r) => setTimeout(r, 300));
    fs.appendFileSync(file, part2);
    await new Promise((r) => setTimeout(r, 300));
    fs.appendFileSync(file, part3);
  })();

  const result = await streamSlpUpload({
    filePath: file,
    config: { serverUrl: server.url, uploadPath: "/api/v1/uploads/files", apiToken: "tok", pollIntervalMs: 100 },
    onLog: () => {},
  });
  await growth;

  const expected = Buffer.concat([part1, part2, part3]);
  assert.equal(server.requests.length, 1);
  const req = server.requests[0];
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/api/v1/uploads/files/stream");
  assert.equal(req.headers["x-api-token"], "tok");
  assert.equal(req.headers.authorization, "Bearer tok");
  assert.equal(req.headers["x-filename"], "Game_live.slp");
  assert.deepEqual(req.body, expected);

  assert.equal(result.sizeBytes, expected.length);
  assert.equal(result.hash, crypto.createHash("sha256").update(expected).digest("hex"));
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
