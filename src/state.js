const fs = require("fs");
const path = require("path");

const INITIAL_STATE = {
  uploaded: {},
};

function getStatePath(app) {
  return path.join(app.getPath("userData"), "state.json");
}

function loadState(app) {
  const statePath = getStatePath(app);
  if (!fs.existsSync(statePath)) {
    return structuredClone(INITIAL_STATE);
  }

  try {
    return {
      ...INITIAL_STATE,
      ...JSON.parse(fs.readFileSync(statePath, "utf-8")),
    };
  } catch {
    return structuredClone(INITIAL_STATE);
  }
}

function saveState(app, state) {
  const statePath = getStatePath(app);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

module.exports = {
  loadState,
  saveState,
};
