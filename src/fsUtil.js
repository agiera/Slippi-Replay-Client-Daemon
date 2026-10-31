const fs = require("fs");
const path = require("path");

// Write to a sibling temp file then rename over the target, so a crash mid-write
// can never leave a truncated/corrupt file behind.
function writeFileAtomic(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, contents);
  fs.renameSync(tmpPath, filePath);
}

module.exports = {
  writeFileAtomic,
};
