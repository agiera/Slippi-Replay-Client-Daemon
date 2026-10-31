const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { setAutoStart, isAutoStartEnabled, buildDesktopEntry, linuxAutostartPath, quoteExecArg } = require("../src/autostart");
const { escapeHtml } = require("../src/tray");
const { makeTempDir } = require("./helpers");

test("quoteExecArg escapes Desktop Entry special characters", () => {
  assert.equal(quoteExecArg("/opt/My App/app"), '"/opt/My App/app"');
  assert.equal(quoteExecArg('a"b$c`d\\e'), '"a\\"b\\$c\\`d\\\\e"');
});

test("buildDesktopEntry launches the AppImage when packaged and the app path in dev", (t) => {
  const previous = process.env.APPIMAGE;
  t.after(() => {
    if (previous === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = previous;
  });

  process.env.APPIMAGE = "/home/u/Slippi Replay Sync.AppImage";
  const packaged = buildDesktopEntry({ isPackaged: true, getAppPath: () => "/unused" });
  assert.match(packaged, /^Exec="\/home\/u\/Slippi Replay Sync\.AppImage"$/m);

  delete process.env.APPIMAGE;
  const dev = buildDesktopEntry({ isPackaged: false, getAppPath: () => "/src/app" });
  assert.match(dev, new RegExp(`^Exec=${quoteExecArg(process.execPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} "/src/app"$`, "m"));
});

test("setAutoStart writes and removes an XDG autostart entry on Linux", { skip: process.platform !== "linux" }, (t) => {
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = makeTempDir(t);
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  });
  const app = { isPackaged: true, getAppPath: () => "/unused" };

  assert.equal(isAutoStartEnabled(app), false);
  setAutoStart(app, true);
  assert.equal(linuxAutostartPath(), path.join(process.env.XDG_CONFIG_HOME, "autostart", "slippi-replay-sync.desktop"));
  assert.match(fs.readFileSync(linuxAutostartPath(), "utf-8"), /^\[Desktop Entry\]/);
  assert.equal(isAutoStartEnabled(app), true);
  setAutoStart(app, false);
  assert.equal(isAutoStartEnabled(app), false);
  assert.doesNotThrow(() => setAutoStart(app, false));
});

test("escapeHtml neutralizes markup", () => {
  assert.equal(escapeHtml(`<img src=x onerror="a('b')">&`), "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;");
  assert.equal(escapeHtml(undefined), "");
});
