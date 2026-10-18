import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const executableNames =
  process.platform === "win32"
    ? ["chromium.exe", "chrome.exe"]
    : ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];

const commonPaths = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];

export function findChromium() {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH does not exist: ${configured}`);
    }
    return configured;
  }

  // Nix exposes the selected Chromium through PATH; avoid scanning all of /nix/store.
  const pathDirectories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const directory of pathDirectories) {
    for (const name of executableNames) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  return commonPaths.find((candidate) => existsSync(candidate)) ?? "";
}
