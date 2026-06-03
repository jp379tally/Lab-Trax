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
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  getUpdateState: () => ipcRenderer.invoke("get-update-state"),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("update-state", listener);
    return () => ipcRenderer.removeListener("update-state", listener);
  },
  platformAdmin: {
    getStatus: () => ipcRenderer.invoke("platformAdmin:get-status"),
    getSecret: () => ipcRenderer.invoke("platformAdmin:get-secret"),
    setSecret: (payload) => ipcRenderer.invoke("platformAdmin:set-secret", payload),
    clearSecret: () => ipcRenderer.invoke("platformAdmin:clear-secret"),
    testSecret: (payload) => ipcRenderer.invoke("platformAdmin:test-secret", payload),
    onChanged: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on("platformAdmin:changed", listener);
      return () => ipcRenderer.removeListener("platformAdmin:changed", listener);
    },
  },
  auth: {
    getTokens: () => ipcRenderer.invoke("auth:get-tokens"),
    getTokensStatus: () => ipcRenderer.invoke("auth:get-tokens-status"),
    setTokens: (payload) => ipcRenderer.invoke("auth:set-tokens", payload),
    clearTokens: () => ipcRenderer.invoke("auth:clear-tokens"),
    isAvailable: () => ipcRenderer.invoke("auth:is-available"),
  },
  previewFile: (buffer, mimeType, fileKey, filename) =>
    ipcRenderer.invoke("preview:open-file", buffer, mimeType, fileKey, filename),
  relaunch: () => ipcRenderer.send("app:relaunch"),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  showFolderDialog: () => ipcRenderer.invoke("dialog:show-folder"),
  saveBackupToFolder: (buffer, fileName, folderPath) =>
    ipcRenderer.invoke("backup:save-to-folder", { buffer, fileName, folderPath }),
  showOpenDialog: (opts) => ipcRenderer.invoke("dialog:showOpenDialog", opts),
  readFile: (filePath) => ipcRenderer.invoke("dialog:read-file", filePath),
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
  messenger: {
    notify: (payload) => ipcRenderer.invoke("messenger:notify", payload),
    onOpenConversation: (callback) => {
      const listener = (_event, conversationId) => callback(conversationId);
      ipcRenderer.on("messenger:open-conversation", listener);
      return () => ipcRenderer.removeListener("messenger:open-conversation", listener);
    },
  },
});
