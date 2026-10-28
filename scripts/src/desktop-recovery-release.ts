import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fullSourceRevision,
  prepareDesktopReleaseIdentity,
  verifyDesktopRecoveryRelease,
} from "./lib/desktop-recovery-release.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const help = `Desktop recovery release files (no network or production writes)

prepare <installer-path>
  Used by desktop-build-publish.sh --prepare-only AFTER signature/stamp checks.
  Requires GIT_COMMIT_SHA (or GITHUB_SHA) matching the checked-out full revision
  and LABTRAX_DESKTOP_SIGNATURE_VERIFICATION=verified-installer.
  Writes release-identity.json beside the installer. It does not code-sign it.

verify --api-build-identity <build-identity.json>
       --release-identity <release-identity.json>
       --installer <LabTrax-Setup.exe|LabTrax.dmg>
  Read-only: compares the supplied API identity, signature-verification status,
  filename, exact byte count and SHA-256. It does not certify a live release or
  validate an encrypted recovery archive. Obtain the API identity from the
  actual deployment, not by copying the Desktop sidecar's revision.
`;

export async function runDesktopRecoveryRelease(args: string[]): Promise<void> {
  const [command, ...rest] = args.filter(arg => arg !== "--");
  if (command === "--help" || rest.includes("--help")) {
    console.log(help);
    return;
  }
  if (command === "prepare") {
    if (rest.length !== 1 || rest[0]!.startsWith("--")) throw new Error(help);
    const sourceRevision = fullSourceRevision(process.env.GIT_COMMIT_SHA || process.env.GITHUB_SHA);
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (sourceRevision !== fullSourceRevision(head)) {
      throw new Error("The requested Desktop source revision is not the checked-out commit.");
    }
    const pkg = JSON.parse(await readFile(resolve(root, "artifacts/labtrax-desktop/package.json"), "utf8"));
    const prepared = await prepareDesktopReleaseIdentity(resolve(rest[0]!), {
      version: process.env.DESKTOP_INSTALLER_VERSION || pkg.version,
      sourceRevision,
      signatureVerification: process.env.LABTRAX_DESKTOP_SIGNATURE_VERIFICATION,
    });
    console.log(JSON.stringify({ status: "prepared-local-files-only", ...prepared }, null, 2));
    return;
  }
  if (command !== "verify") throw new Error(help);
  const allowed = ["--api-build-identity", "--release-identity", "--installer"];
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]!;
    const value = rest[index + 1];
    if (!allowed.includes(key) || options.has(key) || !value || value.startsWith("--")) {
      throw new Error(`Invalid, duplicated or missing verification option: ${key}\n${help}`);
    }
    options.set(key, resolve(value));
  }
  if (options.size !== allowed.length) throw new Error(help);
  const result = await verifyDesktopRecoveryRelease({
    apiBuildIdentityPath: options.get("--api-build-identity")!,
    releaseIdentityPath: options.get("--release-identity")!,
    installerPath: options.get("--installer")!,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDesktopRecoveryRelease(process.argv.slice(2)).catch(error => {
    console.error(`Desktop recovery release check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
