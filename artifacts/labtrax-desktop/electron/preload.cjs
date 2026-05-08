const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  onUpdateDownloadProgress: (callback) => {
    const listener = (_event, percent) => callback(percent);
    ipcRenderer.on("update-download-progress", listener);
    return () => ipcRenderer.removeListener("update-download-progress", listener);
  },
  onUpdateDownloaded: (callback) => {
    const listener = (_event, version) => callback(version);
    ipcRenderer.on("update-downloaded", listener);
    return () => ipcRenderer.removeListener("update-downloaded", listener);
  },
  installUpdate: () => ipcRenderer.invoke("install-update"),
});
