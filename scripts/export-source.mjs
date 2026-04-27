import archiver from "archiver";
import { createWriteStream, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const outDir = resolve(root, "exports");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, "labtrax-source.zip");

const output = createWriteStream(outPath);
const archive = archiver("zip", { zlib: { level: 9 } });

output.on("close", () => {
  console.log(`OK ${outPath} ${archive.pointer()} bytes`);
});
archive.on("warning", (err) => { if (err.code !== "ENOENT") throw err; });
archive.on("error", (err) => { throw err; });
archive.pipe(output);

const ignore = [
  "node_modules/**",
  ".git/**",
  "backups/**",
  ".expo/**",
  "dist/**",
  "build/**",
  ".cache/**",
  ".upm/**",
  ".pythonlibs/**",
  "exports/**",
  "tmp/**",
  "*.zip",
  "*.zip.part",
  "*.tar.gz",
  ".local/**",
  ".agents/**",
  ".config/**",
  "attached_assets/**",
  "static-build/**",
];

archive.glob("**/*", { cwd: root, dot: true, ignore });
await archive.finalize();
