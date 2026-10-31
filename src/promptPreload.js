const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("promptApi", {
  submit: (value) => ipcRenderer.send("prompt:submit", String(value ?? "")),
  cancel: () => ipcRenderer.send("prompt:cancel"),
});
