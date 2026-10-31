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
  getEnvOverrides,
  isInsecureRemoteUrl,
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
  assert.equal(defaults.usePolling, false);
  assert.equal(defaults.rescanIntervalMs, 300000);
  assert.equal(normalizeConfig({ rescanIntervalMs: "abc" }).rescanIntervalMs, 300000);
  assert.equal(normalizeConfig({ rescanIntervalMs: 0 }).rescanIntervalMs, 0);
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

test("getEnvOverrides returns only values set in the environment", (t) => {
  withEnv(t, { SLIPPI_REPLAY_SERVER_API_TOKEN: "env-only", SLIPPI_REPLAY_USE_POLLING: "true", SLIPPI_REPLAY_RESCAN_INTERVAL_MS: "1000" });
  for (const key of ["SLIPPI_REPLAY_SERVER_URL", "SLIPPI_REPLAY_WATCH_DIR", "SLIPPI_REPLAY_UPLOAD_PATH"]) {
    withEnv(t, { [key]: "" });
  }
  assert.deepEqual(getEnvOverrides(), { apiToken: "env-only", usePolling: true, rescanIntervalMs: 1000 });
});

const fakeSecretStore = {
  encrypt: (value) => Buffer.from(`enc:${value}`).toString("base64"),
  decrypt: (value) => {
    const decoded = Buffer.from(value, "base64").toString();
    if (!decoded.startsWith("enc:")) throw new Error("bad");
    return decoded.slice(4);
  },
};

test("saveConfig encrypts the API token when a secret store is available", (t) => {
  const app = fakeApp(makeTempDir(t));
  saveConfig(app, { apiToken: "secret-token" }, fakeSecretStore);

  const raw = fs.readFileSync(path.join(app.getPath("userData"), "config.json"), "utf-8");
  assert.ok(!raw.includes("secret-token"));
  assert.equal(JSON.parse(raw).apiToken, "");
  assert.equal(loadConfig(app, fakeSecretStore).apiToken, "secret-token");
  assert.equal(loadConfig(app, fakeSecretStore).apiTokenEncrypted, undefined);
});

test("loadConfig flags a token that can no longer be decrypted", (t) => {
  const dir = makeTempDir(t);
  const app = fakeApp(dir);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ apiTokenEncrypted: "garbage" }));
  const config = loadConfig(app, fakeSecretStore);
  assert.equal(config.apiToken, "");
  assert.equal(config.apiTokenUnreadable, true);

  saveConfig(app, config, fakeSecretStore);
  assert.ok(!fs.readFileSync(path.join(dir, "config.json"), "utf-8").includes("apiTokenUnreadable"));
});

test("isInsecureRemoteUrl only flags plain HTTP to remote hosts", () => {
  assert.equal(isInsecureRemoteUrl("http://replays.example.com"), true);
  assert.equal(isInsecureRemoteUrl("http://192.168.1.5:8000"), true);
  assert.equal(isInsecureRemoteUrl("https://replays.example.com"), false);
  assert.equal(isInsecureRemoteUrl("http://localhost:8000"), false);
  assert.equal(isInsecureRemoteUrl("http://127.0.0.1:8000"), false);
  assert.equal(isInsecureRemoteUrl("http://[::1]:8000"), false);
  assert.equal(isInsecureRemoteUrl("not a url"), false);
});

test("normalizeConfig drops encrypted token fields and rejects bad intervals", () => {
  const config = normalizeConfig({ apiTokenEncrypted: "blob", rescanIntervalMs: -5, pollIntervalMs: 0 });
  assert.equal("apiTokenEncrypted" in config, false);
  assert.equal(config.rescanIntervalMs, 300000);
  assert.equal(config.pollIntervalMs, 2000);
  assert.equal(normalizeConfig({ usePolling: "yes" }).usePolling, true);
  assert.deepEqual(normalizeConfig({ includeExtensions: ".slp" }).includeExtensions, [".slp", ".zlp"]);
  assert.deepEqual(normalizeConfig(null).serverUrl, "http://localhost:8000");
});

test("saveConfig keeps the token in plain text without a secret store", (t) => {
  const app = fakeApp(makeTempDir(t));
  saveConfig(app, { apiToken: "plain" });
  const raw = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "config.json"), "utf-8"));
  assert.equal(raw.apiToken, "plain");
  assert.equal(raw.apiTokenEncrypted, undefined);
});

test("saveConfig does not encrypt an empty token", (t) => {
  const app = fakeApp(makeTempDir(t));
  saveConfig(app, { apiToken: "" }, fakeSecretStore);
  const raw = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "config.json"), "utf-8"));
  assert.equal(raw.apiTokenEncrypted, undefined);
});

test("loadConfig ignores an encrypted token when no secret store is available", (t) => {
  const dir = makeTempDir(t);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ apiToken: "", apiTokenEncrypted: "blob" }));
  const config = loadConfig(fakeApp(dir));
  assert.equal(config.apiToken, "");
  assert.equal(config.apiTokenUnreadable, undefined);
});

test("loadConfig tolerates a JSON null config file", (t) => {
  const dir = makeTempDir(t);
  fs.writeFileSync(path.join(dir, "config.json"), "null");
  assert.equal(loadConfig(fakeApp(dir)).uploadPath, "/api/v1/uploads/files");
});

test("environment booleans only enable on 'true'", (t) => {
  withEnv(t, { SLIPPI_REPLAY_USE_POLLING: "1", SLIPPI_REPLAY_AUTO_START: "True" });
  const overrides = getEnvOverrides();
  assert.equal(overrides.usePolling, false);
  assert.equal(overrides.autoStart, true);
});

test("mergeEnvOverrides keeps file values when the environment is empty", (t) => {
  const keys = [
    "SLIPPI_REPLAY_SERVER_URL",
    "SLIPPI_REPLAY_UPLOAD_PATH",
    "SLIPPI_REPLAY_SERVER_API_TOKEN",
    "SLIPPI_REPLAY_WATCH_DIR",
    "SLIPPI_REPLAY_INCLUDE_EXTENSIONS",
    "SLIPPI_REPLAY_POLL_INTERVAL_MS",
    "SLIPPI_REPLAY_AUTO_START",
    "SLIPPI_REPLAY_USE_POLLING",
    "SLIPPI_REPLAY_RESCAN_INTERVAL_MS",
  ];
  withEnv(t, Object.fromEntries(keys.map((k) => [k, ""])));
  const merged = mergeEnvOverrides({ serverUrl: "https://file", watchDir: "/r", usePolling: true });
  assert.equal(merged.serverUrl, "https://file");
  assert.equal(merged.watchDir, "/r");
  assert.equal(merged.usePolling, true);
});

test("isInsecureRemoteUrl handles other loopback addresses and protocols", () => {
  assert.equal(isInsecureRemoteUrl("http://127.1.2.3"), false);
  assert.equal(isInsecureRemoteUrl("http://LOCALHOST:8000"), false);
  assert.equal(isInsecureRemoteUrl("http://[::2]:8000"), true);
  assert.equal(isInsecureRemoteUrl("ftp://replays.example.com"), false);
  assert.equal(isInsecureRemoteUrl(""), false);
});
