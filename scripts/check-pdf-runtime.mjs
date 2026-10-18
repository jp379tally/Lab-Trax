import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

// No patient contents; a self-contained PDF with an explicit colored rectangle.
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>",
  "<< /Length 26 >>\nstream\n1 0 0 rg 20 20 160 160 re f\nendstream",
];
let pdf = "%PDF-1.4\n";
const offsets = [0];
for (const [i, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
}
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

const dir = await mkdtemp(path.join(os.tmpdir(), "pdf-runtime-check-"));
try {
  const input = path.join(dir, "fixture.pdf");
  const output = path.join(dir, "page");
  await writeFile(input, pdf);
  if (process.argv[3]) {
    const metadata = spawnSync(path.resolve(process.argv[3]), [input], { env: { PATH: "/usr/bin:/bin" }, timeout: 5_000 });
    if (metadata.error || metadata.status !== 0 || !/^Pages:\s+1\s*$/m.test(metadata.stdout.toString("utf8"))) throw new Error("Packaged PDF page-count preflight failed.");
  }
  const result = spawnSync(path.resolve(process.argv[2]), [
    "-jpeg", "-scale-to", "3000", "-f", "1", "-l", "1", input, output,
  ], { env: { PATH: "/usr/bin:/bin" }, timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error("Packaged PDF rendering failed.");
  const jpeg = await readFile(`${output}-1.jpg`);
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg.length < 1000) throw new Error("PDF rendered no usable JPEG.");
  console.log("Packaged PDF converter rendered an isolated fixture with minimal PATH.");
} finally {
  await rm(dir, { recursive: true, force: true });
}
