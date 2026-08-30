const { Tray, Menu, dialog, nativeImage, shell, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");

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
  onToggleRender,
  onSetDolphinPath,
  onSetMeleeIsoPath,
  onSetFfmpegPath,
  onSetRenderConcurrency,
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

  async function pickFile({ title, defaultPath }) {
    const result = await dialog.showOpenDialog({
      title: title || "Choose file",
      defaultPath: defaultPath || undefined,
      properties: ["openFile"],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  }

  async function promptForText({ title, label, defaultValue = "", isSecret = false }) {
    const channelBase = `prompt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const submitChannel = `${channelBase}-submit`;
    const cancelChannel = `${channelBase}-cancel`;

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
          nodeIntegration: true,
          contextIsolation: false,
        },
      });

      const escapedTitle = title.replace(/"/g, "&quot;");
      const escapedLabel = label.replace(/"/g, "&quot;");
      const escapedDefaultValue = defaultValue.replace(/"/g, "&quot;");

      const html = `<!DOCTYPE html>
<html>
  <body style="font-family: Arial, sans-serif; padding: 14px; background: #12101d; color: #f5f4ff;">
    <h3 style="margin: 0 0 10px 0;">${escapedTitle}</h3>
    <label style="display:block; margin-bottom: 8px;">${escapedLabel}</label>
    <input id="value" type="${isSecret ? "password" : "text"}" value="${escapedDefaultValue}" style="width:100%; padding:8px; box-sizing:border-box; margin-bottom:10px;" />
    <div style="display:flex; justify-content:flex-end; gap:8px;">
      <button id="cancel">Cancel</button>
      <button id="ok">Save</button>
    </div>
    <script>
      const { ipcRenderer } = require('electron');
      const input = document.getElementById('value');
      input.focus();
      input.select();
      document.getElementById('ok').addEventListener('click', () => ipcRenderer.send('${submitChannel}', input.value));
      document.getElementById('cancel').addEventListener('click', () => ipcRenderer.send('${cancelChannel}'));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') ipcRenderer.send('${submitChannel}', input.value);
        if (event.key === 'Escape') ipcRenderer.send('${cancelChannel}');
      });
    </script>
  </body>
</html>`;

      const cleanup = () => {
        ipcMain.removeAllListeners(submitChannel);
        ipcMain.removeAllListeners(cancelChannel);
      };

      ipcMain.once(submitChannel, (_event, value) => {
        cleanup();
        if (!promptWindow.isDestroyed()) {
          promptWindow.close();
        }
        resolve((value || "").trim());
      });

      ipcMain.once(cancelChannel, () => {
        cleanup();
        if (!promptWindow.isDestroyed()) {
          promptWindow.close();
        }
        resolve(null);
      });

      promptWindow.on("closed", () => {
        cleanup();
        resolve(null);
      });

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
        label: "Render Videos For Server",
        type: "checkbox",
        checked: Boolean(config.renderEnabled),
        click: (item) => onToggleRender(item.checked),
      },
      {
        label: `Max Simultaneous Renders: ${config.renderConcurrency}`,
        submenu: [1, 2, 3, 4, 5, 6, 8, 10].map((value) => ({
          label: String(value),
          type: "radio",
          checked: Number(config.renderConcurrency) === value,
          click: () => onSetRenderConcurrency(value),
        })),
      },
      { label: `Dolphin: ${config.dolphinPath || "(not set)"}`, enabled: false },
      {
        label: "Set Playback Dolphin...",
        click: () => onSetDolphinPath(),
      },
      { label: `Melee ISO: ${config.meleeIsoPath || "(not set)"}`, enabled: false },
      {
        label: "Set Melee ISO...",
        click: () => onSetMeleeIsoPath(),
      },
      { label: `ffmpeg: ${config.ffmpegPath || "(not set)"}`, enabled: false },
      {
        label: "Set ffmpeg Path...",
        click: () => onSetFfmpegPath(),
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
        checked: app.getLoginItemSettings().openAtLogin,
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
    pickFile,
    promptForText,
  };
}

module.exports = {
  createTrayController,
};
