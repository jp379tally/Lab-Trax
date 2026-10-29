import path from "node:path";
import { build } from "esbuild";

export async function buildBackupSmokeHelper({ desktopRoot, apiOrigin, outfile }) {
  const url = new URL(apiOrigin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.origin !== apiOrigin) {
    throw new Error("Backup verification requires an explicit local synthetic API origin.");
  }
  await build({
    entryPoints: [path.join(desktopRoot, "src", "lib", "local-backup-execution.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    // The imported API client normally receives these values from Vite.
    // Plain esbuild must supply them when building the Node/Electron helper.
    define: { "import.meta.env": JSON.stringify({ VITE_API_BASE_URL: apiOrigin, DEV: false }) },
    outfile,
  });
}
