const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  onUpdateDownloadProgress: (callback) => {
    const listener = (_event, percent) => callback(percent);
    ipcRenderer.on("update-download-progress", listener);
    return () => ipcRenderer.removeListener("update-download-progress", listener);
  },
  onUpdateDownloaded: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on("update-downloaded", listener);
    return () => ipcRenderer.removeListener("update-downloaded", listener);
  },
  installUpdate: () => ipcRenderer.invoke("install-update"),
  itero: {
    getStatus: () => ipcRenderer.invoke("itero:get-status"),
    setCredentials: (payload) => ipcRenderer.invoke("itero:set-credentials", payload),
    clearCredentials: () => ipcRenderer.invoke("itero:clear-credentials"),
    setApiConfig: (payload) => ipcRenderer.invoke("itero:set-api-config", payload),
    setEnabled: (payload) => ipcRenderer.invoke("itero:set-enabled", payload),
    testLogin: () => ipcRenderer.invoke("itero:test-login"),
    pollNow: () => ipcRenderer.invoke("itero:poll-now"),
    setAuthState: (payload) => ipcRenderer.invoke("itero:set-auth-state", payload),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on("itero:status", listener);
      return () => ipcRenderer.removeListener("itero:status", listener);
    },
  },
});
