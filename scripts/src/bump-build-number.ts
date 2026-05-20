import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appJsonPath = resolve(__dirname, "../../artifacts/labtrax/app.json");

const raw = readFileSync(appJsonPath, "utf8");
const appJson = JSON.parse(raw);

const current = parseInt(appJson.expo.ios.buildNumber ?? "0", 10);
const next = current + 1;

appJson.expo.ios.buildNumber = String(next);
appJson.expo.android = {
  ...appJson.expo.android,
  versionCode: next,
};

writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + "\n", "utf8");

console.log(`Build number bumped: ${current} → ${next}`);
console.log(`  ios.buildNumber    = "${next}"`);
console.log(`  android.versionCode = ${next}`);
