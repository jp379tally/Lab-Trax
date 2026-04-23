const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

const zips = [
  'attached_assets/labtrax-full-source-part1-core-2026-04-22_1776949329615.zip',
  'attached_assets/labtrax-full-source-part2-attached-assets-2026-04-22_1776949343692.zip',
  'attached_assets/labtrax-full-source-part3-attached-assets-2026-04-22_1776949343691.zip',
  'attached_assets/labtrax-full-source-part4-attached-assets-2026-04-22_1776949384446.zip',
];

const outRoot = path.resolve('restore-staging');
fs.mkdirSync(outRoot, { recursive: true });

let totalFiles = 0;
let totalBytes = 0;

for (const zp of zips) {
  console.log(`\n=== ${zp} ===`);
  const zip = new AdmZip(zp);
  const entries = zip.getEntries();
  console.log(`  entries: ${entries.length}`);
  let n = 0;
  for (const e of entries) {
    const norm = e.entryName.replace(/\\/g, '/');
    const dest = path.join(outRoot, norm);
    if (e.isDirectory || norm.endsWith('/')) {
      fs.mkdirSync(dest, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const data = e.getData();
    fs.writeFileSync(dest, data);
    totalBytes += data.length;
    n++;
  }
  totalFiles += n;
  console.log(`  wrote: ${n} files`);
}

console.log(`\nTotal: ${totalFiles} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
