import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appJsonPath = resolve(__dirname, "../../artifacts/labtrax/app.json");

const raw = readFileSync(appJsonPath, "utf8");
const appJson = JSON.parse(raw);

// Both platforms share a counter. Never lower Android's existing versionCode
// or silently turn a malformed iOS value (e.g. "341oops") into a valid number.
const ios = appJson.expo?.ios?.buildNumber ?? "0";
const android = appJson.expo?.android?.versionCode ?? 0;
if (typeof ios !== "string" || !/^\d+$/.test(ios) ||
    !Number.isSafeInteger(Number(ios)) ||
    !Number.isSafeInteger(android) || android < 0) {
  throw new Error("Invalid mobile build counter; app.json was not changed.");
}
const current = Math.max(Number(ios), android);
const next = current + 1;
if (next > 2_100_000_000) {
  throw new Error("Mobile build counter exceeds Android's versionCode limit; app.json was not changed.");
}

appJson.expo.ios.buildNumber = String(next);
appJson.expo.android = {
  ...appJson.expo.android,
  versionCode: next,
};

writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + "\n", "utf8");

console.log(`Build number bumped: ${current} → ${next}`);
console.log(`  ios.buildNumber    = "${next}"`);
console.log(`  android.versionCode = ${next}`);
