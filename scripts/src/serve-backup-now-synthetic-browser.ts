import express, { type Express } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { createServer as createNetServer } from "node:net";

/** Real UI/HTTP/disk fixture. Callable only from the disposable restore harness. */
export async function serveSyntheticBackupBrowser(
  app: Express, secret: string, decrypt: (bytes: Buffer) => Buffer,
  providerEvidence?: () => unknown,
): Promise<void> {
  const isolated = process.env.LABTRAX_ISOLATED_RESTORE_ROOT;
  const evidencePath = process.env.LABTRAX_BACKUP_BROWSER_EVIDENCE;
  if (!isolated || !evidencePath || !process.cwd().startsWith(path.resolve(isolated) + path.sep) ||
      new URL(process.env.DATABASE_URL!).hostname !== "127.0.0.1") throw Error("Disposable local browser fixture required");
  const sourceRoot = path.dirname(await fs.realpath(path.resolve("../../lib")));
  const frontend = path.join(sourceRoot, "artifacts/labtrax-desktop");
  const require = createRequire(path.join(frontend, "package.json"));
  const apiRequire = createRequire(path.join(sourceRoot, "artifacts/api-server/package.json"));
  const AdmZip = apiRequire("adm-zip");
  const { downloadBackupToFolder } = require("./electron/backup-download.cjs");
  const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
  const calls: Array<Record<string, unknown>> = [];
  const writes: Array<Record<string, unknown>> = [];
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const service = express();
  service.use(express.raw({ type: "application/octet-stream", limit: "128mb" }));
  service.use("/__fixture", express.json());
  service.post("/__fixture/source/:source", (req, res) => {
    if (!["development", "production"].includes(req.params.source)) { res.sendStatus(400); return; }
    if (req.params.source === "production") {
      process.env.REPLIT_DEPLOYMENT = "1";
      process.env.PRIVATE_OBJECT_DIR = "/synthetic-private/no-network";
    } else {
      delete process.env.REPLIT_DEPLOYMENT;
      delete process.env.PRIVATE_OBJECT_DIR;
    }
    res.json({ ok: true });
  });
  service.post("/__fixture/missing", async (_req, res) => {
    await fs.rm(path.resolve("uploads/case-media/synthetic-missing-original.pdf"), { force: true });
    res.json({ ok: true });
  });
  service.post("/__fixture/save", async (req, res) => {
    const bytes = req.body as Buffer;
    const manifest = JSON.parse(new AdmZip(decrypt(bytes)).readAsText("manifest.json"));
    const file = path.join(isolated, `synthetic-usb-${randomUUID()}.zip.enc`);
    await fs.writeFile(file, bytes, { mode: 0o600, flag: "wx" });
    if (!(await fs.readFile(file)).equals(bytes)) throw Error("Synthetic disk read-back mismatch");
    writes.push({ mode: "browser", archiveKind: manifest.archiveKind, includesMedia: manifest.includesMedia,
      missingFileCount: manifest.missingFileCount ?? 0, recoveryCoverage: manifest.recoveryCoverage,
      sourceEnvironment: manifest.sourceEnvironment, bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), readBack: true });
    res.json({ ok: true, path: file });
  });
  const localFolder = path.join(isolated, "synthetic-desktop-usb");
  service.get("/__fixture/local-folder", (_req, res) => res.json({ path: localFolder }));
  service.post("/__fixture/desktop-download", async (req, res) => {
    const target = new URL(String(req.body.url), `http://127.0.0.1:${apiPort}`);
    if (target.hostname !== "127.0.0.1" || target.pathname !== "/api/admin/backup/generate" ||
        req.body.folderPath !== localFolder) {
      res.status(400).json({ ok: false, error: "Only the isolated synthetic download is allowed." });
      return;
    }
    const apiOrigin = `http://127.0.0.1:${apiPort}`;
    const result = await downloadBackupToFolder({
      url: apiOrigin + target.pathname + target.search, folderPath: localFolder,
      headers: { ...req.body.headers, "X-Platform-Admin-Secret": secret },
    }, { fetch, isAllowedUrl: (url: string) => new URL(url).origin === apiOrigin });
    if (result.ok) {
      const bytes = await fs.readFile(result.path);
      const manifest = JSON.parse(new AdmZip(decrypt(bytes)).readAsText("manifest.json"));
      writes.push({ mode: "desktop", archiveKind: manifest.archiveKind,
        missingFileCount: manifest.missingFileCount ?? 0, recoveryCoverage: manifest.recoveryCoverage,
        sourceEnvironment: manifest.sourceEnvironment, bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"), readBack: true });
    }
    res.json(result);
  });
  service.get("/__fixture/evidence", (_req, res) => res.json({ calls, writes, providers: providerEvidence?.() ?? [] }));
  service.post("/__fixture/finish", (_req, res) => { res.json({ ok: true }); finish(); });
  service.use((req, res, next) => {
    if (!req.path.startsWith("/api/")) { next(); return; }
    // Identity/provider scaffolding is synthetic. Backup generation, source
    // guards, history, status and desktop proof use the real Express routes.
    if (req.path === "/api/admin/backup/schedule") {
      res.json({ ok: true, interval: 1, unit: "hours", enabled: true, destination: "google-drive",
        sourceEnvironment: process.env.REPLIT_DEPLOYMENT === "1" ? "production" : "development" });
      return;
    }
    if (/\/(onedrive-status|google-drive-status)$/.test(req.path)) {
      res.json({ ok: true, connected: !!providerEvidence, folder: "/synthetic-private" }); return;
    }
    if (req.path.startsWith("/api/admin/backup/")) {
      req.headers["x-platform-admin-secret"] = secret;
      res.on("finish", () => {
        if (req.method === "POST") calls.push({ route: req.originalUrl, status: res.statusCode,
          requestedSource: req.headers["x-labtrax-backup-source"] ?? null,
          selectedDestination: req.body?.destination ?? null,
          archiveKind: res.getHeader("x-backup-archive-kind") ?? null });
      });
      app(req, res, next);
      return;
    }
    res.json({ ok: true, items: [], data: [], runs: [] });
  });
  const listener = service.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const apiPort = (listener.address() as import("node:net").AddressInfo).port;
  const probe = createNetServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const uiPort = (probe.address() as import("node:net").AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const vite = await createServer({
    configFile: false, root: frontend,
    cacheDir: path.join(isolated, "browser-vite-cache"),
    optimizeDeps: { entries: ["src/__tests__/backup-now-browser-fixture.tsx"] },
    define: { "import.meta.env.VITE_API_BASE_URL": JSON.stringify(`http://127.0.0.1:${uiPort}`) },
    esbuild: { jsx: "automatic" },
    resolve: { alias: { "@": path.join(frontend, "src"), "@assets": path.join(sourceRoot, "attached_assets") },
      dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: uiPort, strictPort: true, allowedHosts: true, fs: { allow: [sourceRoot] },
      proxy: { "/api": `http://127.0.0.1:${apiPort}`, "/__fixture": `http://127.0.0.1:${apiPort}` } },
    plugins: [{
      name: "synthetic-backup-browser-only",
      configureServer(server: any) {
        server.middlewares.use((req: any, res: any, next: any) => {
          if (req.url?.split("?")[0] !== "/backup-now-fixture") return next();
          res.setHeader("Content-Type", "text/html");
          res.end('<html><body><div id="root"></div><script type="module" src="/src/__tests__/backup-now-browser-fixture.tsx"></script></body></html>');
        });
      },
    }],
  });
  try {
    await vite.listen();
    const port = (vite.httpServer!.address() as import("node:net").AddressInfo).port;
    await fs.writeFile(evidencePath + ".ready.json", JSON.stringify({
      url: `http://127.0.0.1:${port}/backup-now-fixture`, apiPort, syntheticOnly: true,
    }));
    console.log(`SYNTHETIC_BACKUP_BROWSER_READY http://127.0.0.1:${port}/backup-now-fixture`);
    await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(Error("Owned browser verification timed out")), 840000).unref())]);
    await fs.writeFile(evidencePath, JSON.stringify({ calls, writes, syntheticOnly: true }, null, 2));
  } finally {
    await vite.close();
    await new Promise<void>(resolve => listener.close(() => resolve()));
  }
}
