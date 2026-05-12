"use strict";

/**
 * Desktop sign-in token store for the LabTrax Desktop app.
 *
 * Persists the renderer's access + refresh tokens encrypted at rest via
 * Electron `safeStorage` (OS keychain — Keychain on macOS, DPAPI on Windows,
 * libsecret/kwallet on Linux). The encrypted blob lives at
 * `userData/auth-tokens.bin`. Mirrors the layout of `platform-admin.cjs` and
 * `itero-poller.cjs` so anyone with filesystem access to the laptop cannot
 * read the tokens and impersonate the user against the API.
 */

const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");

let tokensPath = null;

function ensurePaths() {
  if (tokensPath) return;
  const dir = app.getPath("userData");
  tokensPath = path.join(dir, "auth-tokens.bin");
}

function getTokens() {
  ensurePaths();
  if (!fs.existsSync(tokensPath)) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const blob = fs.readFileSync(tokensPath);
    const json = safeStorage.decryptString(blob);
    const parsed = JSON.parse(json);
    if (
      parsed &&
      typeof parsed.accessToken === "string" &&
      typeof parsed.refreshToken === "string"
    ) {
      return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
    }
  } catch {
    /* ignore — corrupt or unreadable blob */
  }
  return null;
}

function setTokens(value) {
  ensurePaths();
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "OS keychain is unavailable — cannot safely store sign-in tokens. " +
        "On Linux this requires a desktop session (gnome-keyring/kwallet).",
    );
  }
  if (
    !value ||
    typeof value.accessToken !== "string" ||
    typeof value.refreshToken !== "string" ||
    !value.accessToken ||
    !value.refreshToken
  ) {
    throw new Error("Both accessToken and refreshToken are required.");
  }
  const json = JSON.stringify({
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
  });
  const blob = safeStorage.encryptString(json);
  fs.writeFileSync(tokensPath, blob);
}

function clearTokens() {
  ensurePaths();
  try {
    if (fs.existsSync(tokensPath)) fs.unlinkSync(tokensPath);
  } catch {
    /* ignore */
  }
}

function isAvailable() {
  return safeStorage.isEncryptionAvailable();
}

module.exports = {
  getTokens,
  setTokens,
  clearTokens,
  isAvailable,
};
