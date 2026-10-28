"use strict";

function shouldUseAutoUpdater({ isDev, isWindowsStore, skipAutoUpdater, updateChannel }) {
  const supportsInPlaceUpdates = updateChannel !== "portable" && updateChannel !== "manual";
  return !isDev && !isWindowsStore && !skipAutoUpdater && supportsInPlaceUpdates;
}

function normalizeUpdateFeedUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.search = "";
    url.hash = "";
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.toString();
  } catch {
    return null;
  }
}

function resolveUpdateFeedUrl({ runtimeOverride, packagedFeed, fallback }) {
  return (
    normalizeUpdateFeedUrl(runtimeOverride) ||
    normalizeUpdateFeedUrl(packagedFeed) ||
    normalizeUpdateFeedUrl(fallback)
  );
}

function manualInstallerDetails({ isWindowsStore, platform, feedUrl }) {
  if (isWindowsStore) return { url: null, platform: null };
  const installerPlatform =
    platform === "win32" ? "windows" : platform === "darwin" ? "macos" : null;
  const normalizedFeedUrl = normalizeUpdateFeedUrl(feedUrl);
  if (!installerPlatform || !normalizedFeedUrl) {
    return { url: null, platform: installerPlatform };
  }
  const filename = installerPlatform === "windows" ? "LabTrax-Setup.exe" : "LabTrax.dmg";
  return {
    url: new URL(filename, normalizedFeedUrl).toString(),
    platform: installerPlatform,
  };
}

module.exports = {
  shouldUseAutoUpdater,
  resolveUpdateFeedUrl,
  manualInstallerDetails,
};
