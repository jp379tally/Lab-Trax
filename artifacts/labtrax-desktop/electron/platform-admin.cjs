"use strict";

/**
 * Platform admin secret store for the LabTrax Desktop app.
 *
 * Encrypts the deployment's PLATFORM_ADMIN_SECRET via Electron safeStorage
 * (OS keychain) and persists the blob at userData/platform-admin-secret.bin.
 * The renderer obtains the secret via IPC and attaches it as the
 * X-Platform-Admin-Secret header on /admin/* API requests so admin
 * maintenance panels (Media Cleanup, Backup, etc.) work end-to-end.
 *
 * Mirrors the layout of itero-poller.cjs.
 */

const fs = require("fs");
const path = require("path");
const { app, safeStorage, net } = require("electron");

let secretPath = null;
let savedAtPath = null;
let onChange = () => {};

function ensurePaths() {
  if (secretPath) return;
  const dir = app.getPath("userData");
  secretPath = path.join(dir, "platform-admin-secret.bin");
  savedAtPath = path.join(dir, "platform-admin-secret.meta.json");
}

function readSavedAt() {
  ensurePaths();
  try {
    if (fs.existsSync(savedAtPath)) {
      const json = JSON.parse(fs.readFileSync(savedAtPath, "utf8"));
      const n = Number(json?.savedAt);
      if (Number.isFinite(n)) return n;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function writeSavedAt(n) {
  ensurePaths();
  try {
    fs.writeFileSync(savedAtPath, JSON.stringify({ savedAt: n }), "utf8");
  } catch {
    /* ignore */
  }
}

function isConfigured() {
  ensurePaths();
  return fs.existsSync(secretPath);
}

function getStatus() {
  return {
    available: safeStorage.isEncryptionAvailable(),
    configured: isConfigured(),
    savedAt: readSavedAt(),
  };
}

function getSecret() {
  ensurePaths();
  if (!fs.existsSync(secretPath)) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const blob = fs.readFileSync(secretPath);
    return safeStorage.decryptString(blob);
  } catch {
    return null;
  }
}

function setSecret(value) {
  ensurePaths();
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "OS keychain is unavailable — cannot safely store the platform admin secret. " +
        "On Linux this requires a desktop session (gnome-keyring/kwallet).",
    );
  }
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new Error("Secret must not be empty.");
  const blob = safeStorage.encryptString(trimmed);
  fs.writeFileSync(secretPath, blob);
  writeSavedAt(Date.now());
  emit();
}

function clearSecret() {
  ensurePaths();
  try {
    if (fs.existsSync(secretPath)) fs.unlinkSync(secretPath);
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(savedAtPath)) fs.unlinkSync(savedAtPath);
  } catch {
    /* ignore */
  }
  emit();
}

function emit() {
  try {
    onChange(getStatus());
  } catch {
    /* ignore */
  }
}

async function testSecret(apiBaseUrl) {
  const secret = getSecret();
  if (!secret) {
    return { ok: false, status: 0, message: "No secret is saved on this machine." };
  }
  const base = String(apiBaseUrl || "").replace(/\/$/, "");
  const url = `${base}/admin/cleanup/orphaned-media/runs?limit=1`;
  try {
    const res = await net.fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Platform-Admin-Secret": secret,
      },
      useSessionCookies: true,
    });
    if (res.ok) return { ok: true, status: res.status };
    if (res.status === 401) {
      return {
        ok: false,
        status: res.status,
        message: "Sign in to LabTrax first — the test request was not authenticated.",
      };
    }
    if (res.status === 403) {
      return {
        ok: false,
        status: res.status,
        message: "Server rejected the secret. Make sure it matches PLATFORM_ADMIN_SECRET on the server.",
      };
    }
    return { ok: false, status: res.status, message: `Server responded with HTTP ${res.status}.` };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: `Server unreachable: ${err?.message || String(err)}`,
    };
  }
}

function init({ onStatus } = {}) {
  if (typeof onStatus === "function") onChange = onStatus;
  ensurePaths();
  emit();
}

module.exports = {
  init,
  getStatus,
  getSecret,
  setSecret,
  clearSecret,
  testSecret,
};
