const { Tray, Menu, dialog, nativeImage, shell, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const { isAutoStartEnabled } = require("./autostart");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createDotIcon() {
  const dataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABM0lEQVR4nM2TsUoDQRRGv7kQjJ2NhY2VvY2dhY2FhYVFrY2Nha2NhfY2NhY2VjY2FhYf8EXsFJY2tiYbQxMLMy5j2WQJjEwuefM+fNw5QfQJ2m3jWzH1A4xY6q6QF4A+oKQzgA8A6Zp3m3QjA0xj5nq3yJ4A7Yxk4xQxQ5gA2Jx2NQnA4h2xwQ8hEwQX8eXx8d0P0VQm0QvY4fZVYw2u5I3mJk2mT2mQn3l3P8v2a0h0kzW6Kc0qfI8m8qE2rY2qYvM0i7I3qNQ4sQhJx5fLxW8sD7Y9Qz9h2B8J0fJ6q0GkT2vQjzQm9oWf7i1m9p6d0gWg7Qf8+VQ2Xv2uB3K9wK0A4Zx2m4j0Y8Dk8fE3Gf6w0kQxwH3n7rXqQAAAABJRU5ErkJggg==";
  return nativeImage.createFromDataURL(dataUrl);
}

function createTrayController({
  app,
  iconPath,
  getConfig,
  getLogPath,
  onOpenWatchDirPicker,
  onSetServerUrl,
  onSetApiToken,
  onSyncNow,
  onToggleAutostart,
}) {
  const trayIcon = iconPath && fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : createDotIcon();
  const tray = new Tray(trayIcon);
  let status = "Idle";

  tray.setToolTip("Slippi Replay Sync");

  function setStatus(nextStatus) {
    status = nextStatus;
    tray.setToolTip(`Slippi Replay Sync - ${status}`);
    refreshMenu();
  }

  async function pickWatchDirectory(defaultPath) {
    const result = await dialog.showOpenDialog({
      title: "Choose replay folder",
      defaultPath: defaultPath || undefined,
      properties: ["openDirectory", "createDirectory"],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  }

  async function promptForText({ title, label, defaultValue = "", isSecret = false }) {
    return new Promise((resolve) => {
      const promptWindow = new BrowserWindow({
        width: 420,
        height: 200,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        autoHideMenuBar: true,
        alwaysOnTop: true,
        webPreferences: {
          preload: path.join(__dirname, "promptPreload.js"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      const { webContents } = promptWindow;

      const html = `<!DOCTYPE html>
<html>
  <head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" />
  </head>
  <body style="font-family: Arial, sans-serif; padding: 14px; background: #12101d; color: #f5f4ff;">
    <h3 style="margin: 0 0 10px 0;">${escapeHtml(title)}</h3>
    <label style="display:block; margin-bottom: 8px;">${escapeHtml(label)}</label>
    <input id="value" type="${isSecret ? "password" : "text"}" value="${escapeHtml(defaultValue)}" style="width:100%; padding:8px; box-sizing:border-box; margin-bottom:10px;" />
    <div style="display:flex; justify-content:flex-end; gap:8px;">
      <button id="cancel">Cancel</button>
      <button id="ok">Save</button>
    </div>
    <script>
      const input = document.getElementById('value');
      input.focus();
      input.select();
      document.getElementById('ok').addEventListener('click', () => window.promptApi.submit(input.value));
      document.getElementById('cancel').addEventListener('click', () => window.promptApi.cancel());
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') window.promptApi.submit(input.value);
        if (event.key === 'Escape') window.promptApi.cancel();
      });
    </script>
  </body>
</html>`;

      let settled = false;
      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        ipcMain.removeListener("prompt:submit", onSubmit);
        ipcMain.removeListener("prompt:cancel", onCancel);
        if (!promptWindow.isDestroyed()) {
          promptWindow.close();
        }
        resolve(value);
      };
      // Channels are shared, so only accept messages from this prompt's window.
      const onSubmit = (event, value) => {
        if (event.sender === webContents) {
          finish(String(value || "").trim());
        }
      };
      const onCancel = (event) => {
        if (event.sender === webContents) {
          finish(null);
        }
      };

      ipcMain.on("prompt:submit", onSubmit);
      ipcMain.on("prompt:cancel", onCancel);
      promptWindow.on("closed", () => finish(null));

      promptWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    });
  }

  function refreshMenu() {
    const config = getConfig();

    const menu = Menu.buildFromTemplate([
      { label: `Status: ${status}`, enabled: false },
      { type: "separator" },
      { label: `Server: ${config.serverUrl}${config.uploadPath}`, enabled: false },
      {
        label: "Set Server URL...",
        click: () => onSetServerUrl(),
      },
      {
        label: "Set API Token...",
        click: () => onSetApiToken(),
      },
      { label: `Watch: ${config.watchDir || "(not set)"}`, enabled: false },
      {
        label: "Choose Watch Folder...",
        click: () => onOpenWatchDirPicker(),
      },
      {
        label: "Sync Now",
        click: () => onSyncNow(),
      },
      { type: "separator" },
      {
        label: "Open Config Directory",
        click: () => {
          shell.openPath(app.getPath("userData"));
        },
      },
      {
        label: "Open Log File",
        click: () => {
          shell.openPath(getLogPath());
        },
      },
      {
        label: "Open At Login",
        type: "checkbox",
        checked: isAutoStartEnabled(app),
        click: (item) => onToggleAutostart(item.checked),
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => app.quit(),
      },
    ]);

    tray.setContextMenu(menu);
  }

  refreshMenu();

  return {
    setStatus,
    refreshMenu,
    pickWatchDirectory,
    promptForText,
  };
}

module.exports = {
  createTrayController,
  escapeHtml,
};
