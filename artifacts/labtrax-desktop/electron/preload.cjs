const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  onUpdateDownloadProgress: (callback) => {
    ipcRenderer.on("update-download-progress", (_event, percent) => callback(percent));
    return () => ipcRenderer.removeAllListeners("update-download-progress");
  },
});
