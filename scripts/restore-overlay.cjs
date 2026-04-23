const fs = require('fs');
const path = require('path');

const SRC = path.resolve('restore-staging/labtrax-full-source');
const DST = path.resolve('.');

const EXCLUDE_TOP = new Set([
  'node_modules', '.git', '.local', '.cache', '.upm', '.config',
  '.replit_integration_files', 'backups', '.expo', 'restore-staging',
  '.replit', 'replit.nix', '.env',
]);

let copied = 0;
let dirs = 0;

function copyRecursive(srcDir, dstDir, isTop = false) {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const e of entries) {
    if (isTop && EXCLUDE_TOP.has(e.name)) {
      console.log(`SKIP: ${e.name}`);
      continue;
    }
    const sp = path.join(srcDir, e.name);
    const dp = path.join(dstDir, e.name);
    if (e.isDirectory()) {
      if (!fs.existsSync(dp)) {
        fs.mkdirSync(dp, { recursive: true });
        dirs++;
      }
      copyRecursive(sp, dp, false);
    } else if (e.isFile()) {
      fs.copyFileSync(sp, dp);
      copied++;
      if (copied % 50 === 0) console.log(`  copied ${copied} files...`);
    }
  }
}

console.log(`Overlaying ${SRC} -> ${DST}`);
copyRecursive(SRC, DST, true);
console.log(`\nDone. ${copied} files copied, ${dirs} new dirs created.`);
