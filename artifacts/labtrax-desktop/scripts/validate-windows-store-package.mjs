import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseStoreVersion,
  validateMsixBuffer,
  validateStoreIdentity,
} from "./lib/msix-validation.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = resolve(desktopRoot, "electron-dist", "LabTrax-Store.msix");

async function main() {
  const identity = validateStoreIdentity({
    identityName: process.env.STORE_PACKAGE_IDENTITY_NAME,
    publisher: process.env.STORE_PACKAGE_PUBLISHER,
    publisherDisplayName: process.env.STORE_PACKAGE_PUBLISHER_DISPLAY_NAME,
  });
  const packageJson = JSON.parse(readFileSync(resolve(desktopRoot, "package.json"), "utf8"));
  const buildNumber = JSON.parse(
    readFileSync(resolve(desktopRoot, "build-number.json"), "utf8"),
  ).buildNumber;
  const version = parseStoreVersion(packageJson.version, buildNumber);
  const report = await validateMsixBuffer(readFileSync(packagePath), {
    ...identity,
    version,
  });
  console.log(
    `Store package validation passed: ${report.identityName} ${report.version}, ` +
      `${report.architecture}, capabilities: ${report.capabilities.join(", ")}, ` +
      `signature: ${report.signature}.`,
  );
}

main().catch((error) => {
  console.error(`\nMicrosoft Store package validation failed: ${error.message}`);
  process.exitCode = 1;
});
