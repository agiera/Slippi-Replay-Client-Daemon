const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./fsUtil");

// uploaded: content hash -> upload record
// files: local path -> { size, mtimeMs, hash }, used to skip unchanged files
// without re-reading them on every scan.
function initialState() {
  return { uploaded: {}, files: {} };
}

function getStatePath(app) {
  return path.join(app.getPath("userData"), "state.json");
}

function loadState(app) {
  const statePath = getStatePath(app);
  if (!fs.existsSync(statePath)) {
    return initialState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    return {
      ...initialState(),
      ...parsed,
      uploaded: parsed?.uploaded && typeof parsed.uploaded === "object" ? parsed.uploaded : {},
      files: parsed?.files && typeof parsed.files === "object" ? parsed.files : {},
    };
  } catch {
    return initialState();
  }
}

function saveState(app, state) {
  writeFileAtomic(getStatePath(app), JSON.stringify(state, null, 2));
}

module.exports = {
  loadState,
  saveState,
};
