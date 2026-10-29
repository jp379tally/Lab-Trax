// Loaded only by the disposable backup workflow test server, never the app entry.
import React from "react";
import { createRoot } from "react-dom/client";
import SettingsPage from "@/pages/settings";
import { makeAuthWrapper } from "./test-utils";

const fixtureUrl = new URL(location.href);
fixtureUrl.searchParams.set("tab", "backup");
window.history.replaceState(null, "", fixtureUrl);
const localFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
  if (url.origin !== location.origin) throw Error("Synthetic backup fixture refuses non-local requests");
  return localFetch(input, init);
};
(window as any).showSaveFilePicker = async () => ({
  createWritable: async () => {
    const chunks: Uint8Array[] = [];
    return new WritableStream<Uint8Array>({
      write(chunk) { chunks.push(new Uint8Array(chunk)); },
      async close() {
        const response = await fetch("/__fixture/save", {
          method: "POST", headers: { "Content-Type": "application/octet-stream" },
          body: new Blob(chunks.map(chunk => new Uint8Array(chunk).buffer)),
        });
        if (!response.ok) throw Error("Synthetic browser file save failed.");
      },
    });
  },
});
if (new URL(location.href).searchParams.get("desktop") === "1") {
  (window as any).electronAPI = {
    showFolderDialog: async () => (await (await fetch("/__fixture/local-folder")).json()).path,
    downloadBackupToFolder: async (request: unknown) => {
      const response = await fetch("/__fixture/desktop-download", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
      });
      return response.json();
    },
  };
}
const Wrapper = makeAuthWrapper("/settings?tab=backup", {
  user: { id: "synthetic-backup-admin", username: "synthetic-admin",
    firstName: "Synthetic", lastName: "Admin", role: "admin" } as any,
  status: "authed", restoreStatus: "ok", restoreNoticeDismissed: true,
});
createRoot(document.getElementById("root")!).render(<Wrapper><SettingsPage /></Wrapper>);
