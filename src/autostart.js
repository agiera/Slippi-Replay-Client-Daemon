const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_NAME = "Slippi Replay Sync";
const DESKTOP_FILE_NAME = "slippi-replay-sync.desktop";

function linuxAutostartPath() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "autostart", DESKTOP_FILE_NAME);
}

// Quote an argument per the Desktop Entry spec's Exec key rules.
function quoteExecArg(arg) {
  return `"${String(arg).replace(/(["`$\\])/g, "\\$1")}"`;
}

function linuxExecCommand(app) {
  // Inside an AppImage, execPath points at a temporary mount; APPIMAGE is the real file.
  const executable = process.env.APPIMAGE || process.execPath;
  const args = [executable];
  if (!app.isPackaged) {
    args.push(app.getAppPath());
  }
  return args.map(quoteExecArg).join(" ");
}

function buildDesktopEntry(app) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${APP_NAME}`,
    `Exec=${linuxExecCommand(app)}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

// Electron's setLoginItemSettings only works on macOS and Windows, so Linux uses
// an XDG autostart entry instead.
function setAutoStart(app, enabled) {
  if (process.platform === "linux") {
    const desktopPath = linuxAutostartPath();
    if (enabled) {
      fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
      fs.writeFileSync(desktopPath, buildDesktopEntry(app));
    } else {
      fs.rmSync(desktopPath, { force: true });
    }
    return;
  }

  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    name: APP_NAME,
  });
}

function isAutoStartEnabled(app) {
  if (process.platform === "linux") {
    return fs.existsSync(linuxAutostartPath());
  }
  return app.getLoginItemSettings().openAtLogin;
}

module.exports = {
  setAutoStart,
  isAutoStartEnabled,
  buildDesktopEntry,
  linuxAutostartPath,
  quoteExecArg,
};
