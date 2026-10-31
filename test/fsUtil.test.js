const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { writeFileAtomic } = require("../src/fsUtil");
const { makeTempDir } = require("./helpers");

test("writeFileAtomic creates missing parent directories", (t) => {
  const file = path.join(makeTempDir(t), "a", "b", "out.json");
  writeFileAtomic(file, "{}");
  assert.equal(fs.readFileSync(file, "utf-8"), "{}");
});

test("writeFileAtomic replaces existing contents and leaves no temp file", (t) => {
  const dir = makeTempDir(t);
  const file = path.join(dir, "out.txt");
  fs.writeFileSync(file, "old contents that are longer");
  writeFileAtomic(file, "new");
  assert.equal(fs.readFileSync(file, "utf-8"), "new");
  assert.deepEqual(fs.readdirSync(dir), ["out.txt"]);
});

test("writeFileAtomic accepts buffers", (t) => {
  const file = path.join(makeTempDir(t), "bin");
  writeFileAtomic(file, Buffer.from([0, 1, 2]));
  assert.deepEqual(fs.readFileSync(file), Buffer.from([0, 1, 2]));
});
