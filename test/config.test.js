const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  loadConfig,
  saveConfig,
  mergeEnvOverrides,
  normalizeConfig,
  parseExtensionsFromEnv,
} = require("../src/config");
const { makeTempDir, fakeApp } = require("./helpers");

function withEnv(t, vars) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("parseExtensionsFromEnv normalizes values", () => {
  assert.equal(parseExtensionsFromEnv(undefined), undefined);
  assert.equal(parseExtensionsFromEnv(""), undefined);
  assert.equal(parseExtensionsFromEnv(" , ,"), undefined);
  assert.deepEqual(parseExtensionsFromEnv(".SLP, zlp ,,mp4"), [".slp", ".zlp", ".mp4"]);
});

test("normalizeConfig fills defaults and coerces types", () => {
  const config = normalizeConfig({ includeExtensions: [".SLP"], pollIntervalMs: "500" });
  assert.deepEqual(config.includeExtensions, [".slp"]);
  assert.equal(config.pollIntervalMs, 500);
  assert.equal(config.serverUrl, "http://localhost:8000");
  assert.equal(config.uploadPath, "/api/v1/uploads/files");

  const defaults = normalizeConfig({});
  assert.deepEqual(defaults.includeExtensions, [".slp", ".zlp"]);
  assert.equal(defaults.pollIntervalMs, 2000);
  assert.equal(defaults.autoStart, true);
});

test("loadConfig returns defaults when file is missing or corrupt", (t) => {
  const dir = makeTempDir(t);
  const app = fakeApp(dir);
  assert.equal(loadConfig(app).serverUrl, "http://localhost:8000");

  fs.writeFileSync(path.join(dir, "config.json"), "{not json");
  assert.equal(loadConfig(app).serverUrl, "http://localhost:8000");
});

test("saveConfig and loadConfig round-trip", (t) => {
  const app = fakeApp(path.join(makeTempDir(t), "nested", "userData"));
  saveConfig(app, { serverUrl: "https://example.com", apiToken: "tok", includeExtensions: [".ZLP"] });

  const loaded = loadConfig(app);
  assert.equal(loaded.serverUrl, "https://example.com");
  assert.equal(loaded.apiToken, "tok");
  assert.deepEqual(loaded.includeExtensions, [".zlp"]);
});

test("mergeEnvOverrides applies environment variables", (t) => {
  withEnv(t, {
    SLIPPI_REPLAY_SERVER_URL: "https://env.example",
    SLIPPI_REPLAY_UPLOAD_PATH: "/custom/upload",
    SLIPPI_REPLAY_SERVER_API_TOKEN: "env-token",
    SLIPPI_REPLAY_WATCH_DIR: "/replays",
    SLIPPI_REPLAY_INCLUDE_EXTENSIONS: "slp",
    SLIPPI_REPLAY_POLL_INTERVAL_MS: "750",
    SLIPPI_REPLAY_AUTO_START: "FALSE",
  });

  const merged = mergeEnvOverrides({ serverUrl: "http://file", apiToken: "file-token" });
  assert.equal(merged.serverUrl, "https://env.example");
  assert.equal(merged.uploadPath, "/custom/upload");
  assert.equal(merged.apiToken, "env-token");
  assert.equal(merged.watchDir, "/replays");
  assert.deepEqual(merged.includeExtensions, [".slp"]);
  assert.equal(merged.pollIntervalMs, 750);
  assert.equal(merged.autoStart, false);
});
