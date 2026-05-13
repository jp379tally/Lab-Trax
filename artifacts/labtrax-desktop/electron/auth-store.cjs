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

/**
 * Returns the saved tokens together with a status that distinguishes the
 * three "no tokens" outcomes the renderer cares about:
 *   - "empty"                — no blob has ever been written
 *   - "keychain-unavailable" — a blob exists but the OS keychain can't decrypt
 *                              it on this machine (e.g. fresh Linux session
 *                              with no gnome-keyring/kwallet)
 *   - "decrypt-failed"       — the blob is corrupt / unreadable; we delete
 *                              it so a fresh sign-in starts clean
 *   - "ok"                   — `tokens` populated
 */
function getTokensWithStatus() {
  ensurePaths();
  // Check keychain availability first so the renderer can warn the user
  // ("we won't be able to remember your sign-in on this machine") even
  // before they've ever signed in. Past behaviour only surfaced the
  // problem after the first successful sign-in had created a blob, which
  // meant fresh Linux sessions with no gnome-keyring had no warning at
  // all.
  if (!safeStorage.isEncryptionAvailable()) {
    return { status: "keychain-unavailable" };
  }
  if (!fs.existsSync(tokensPath)) {
    return { status: "empty" };
  }
  let blob;
  try {
    blob = fs.readFileSync(tokensPath);
  } catch {
    return { status: "decrypt-failed" };
  }
  let json;
  try {
    json = safeStorage.decryptString(blob);
  } catch {
    // Corrupt or wrong-key blob — wipe it so the user gets a clean slate
    // on next sign-in instead of a permanently-stuck app.
    try {
      fs.unlinkSync(tokensPath);
    } catch {
      /* ignore */
    }
    return { status: "decrypt-failed" };
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    try {
      fs.unlinkSync(tokensPath);
    } catch {
      /* ignore */
    }
    return { status: "decrypt-failed" };
  }
  if (
    parsed &&
    typeof parsed.accessToken === "string" &&
    typeof parsed.refreshToken === "string" &&
    parsed.accessToken &&
    parsed.refreshToken
  ) {
    return {
      status: "ok",
      tokens: {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
      },
    };
  }
  // JSON decoded but didn't carry the expected fields — treat as corrupt.
  try {
    fs.unlinkSync(tokensPath);
  } catch {
    /* ignore */
  }
  return { status: "decrypt-failed" };
}

function getTokens() {
  const { tokens } = getTokensWithStatus();
  return tokens ?? null;
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
  getTokensWithStatus,
  setTokens,
  clearTokens,
  isAvailable,
};
