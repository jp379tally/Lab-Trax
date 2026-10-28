#!/usr/bin/env node
// Called only while the shared release lock is held. Independent receipts
// survive a failure to update the human-readable release summary.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, openSync, closeSync, fsyncSync } from "node:fs";
import { resolve, dirname } from "node:path";
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const pending = resolve(root, ".local/.eas-upload-attempt.json");
const remote = resolve(root, ".local/.eas-remote-build-started");
const valid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function save(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
const [command, id, number] = process.argv.slice(2);
try {
  if (command === "reserve-build") {
    if (existsSync(remote) || existsSync(pending)) throw Error("Unreconciled remote operation; no new build permitted.");
    if (!/^\d+$/.test(number ?? "")) throw Error("Invalid reserved build number.");
    save(remote, { version: id, buildNumber: number, startedAt: new Date().toISOString() });
  } else if (command === "built") {
    // Retry ID must already be durable before clearing an ambiguous build.
    if (!valid.test(id ?? "") || readFileSync(resolve(root, ".local/.eas-submit-build-id"), "utf8").trim() !== id)
      throw Error("Exact completed build is not durably pinned.");
    if (existsSync(remote)) unlinkSync(remote);
  } else if (command === "prepare-upload") {
    if (!valid.test(id ?? "")) throw Error("Invalid approved build ID.");
    if (existsSync(pending)) throw Error("Prior upload outcome requires reconciliation; refusing duplicate upload.");
    save(pending, { buildId: id, status: "ready", preparedAt: new Date().toISOString() });
  } else if (command === "start-upload" || command === "check-ready") {
    if (!existsSync(pending)) throw Error("Legacy pending upload has no durable pre-attempt proof; reconcile authoritative Expo/Apple history before retrying.");
    const receipt = JSON.parse(readFileSync(pending, "utf8"));
    if (!valid.test(id ?? "") || receipt.buildId !== id || receipt.status !== "ready")
      throw Error("Prior upload outcome requires reconciliation; refusing duplicate upload.");
    if (command === "check-ready") process.exit(0);
    save(pending, { buildId: id, status: "started", startedAt: new Date().toISOString() });
  } else if (command === "accepted" || command === "check-accepted") {
    const receipt = JSON.parse(readFileSync(pending, "utf8"));
    if (receipt.buildId !== id || !valid.test(id ?? "")) throw Error("Receipt belongs to a different build.");
    if (command === "accepted") {
      if (receipt.status !== "started") throw Error("Unexpected upload transition.");
      save(pending, { ...receipt, status: "accepted", acceptedAt: new Date().toISOString() });
    } else if (receipt.status !== "accepted") {
      throw Error("Remote upload outcome is ambiguous. Obtain authoritative Expo/Apple evidence before any retry.");
    }
  } else if (command === "finish") {
    const receipt = JSON.parse(readFileSync(pending, "utf8"));
    if (receipt.buildId !== id || receipt.status !== "accepted") throw Error("No accepted exact-build receipt.");
    unlinkSync(pending);
  } else throw Error("Unknown operation-state command.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
