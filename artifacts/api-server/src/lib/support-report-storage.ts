import { Storage } from "@google-cloud/storage";
import type { ExternalAccountClientOptions } from "google-auth-library";

const sidecar: ExternalAccountClientOptions = {
  audience: "replit", subject_token_type: "access_token",
  token_url: "http://127.0.0.1:1106/token", type: "external_account",
  credential_source: { url: "http://127.0.0.1:1106/credential", format: { type: "json", subject_token_field_name: "access_token" } },
  universe_domain: "googleapis.com",
};
const client = process.env.GOOGLE_APPLICATION_CREDENTIALS ? new Storage() : new Storage({ credentials: sidecar, projectId: "" });

function file(key: string) {
  const root = process.env.PRIVATE_OBJECT_DIR;
  if (!root) return null;
  const clean = root.replace(/\/$/, "");
  const slash = clean.replace(/^\//, "").indexOf("/");
  if (slash < 0) throw new Error("Invalid private object directory");
  return client.bucket(clean.replace(/^\//, "").slice(0, slash)).file(`${clean.replace(/^\//, "").slice(slash + 1)}/support-reports/${key}`);
}

export async function writeSupportReportAttachment(key: string, data: Buffer, contentType: string): Promise<boolean> {
  const target = file(key);
  if (!target) return false;
  await target.save(data, { resumable: false, contentType, metadata: { contentDisposition: `attachment; filename="${key}"` } });
  return true;
}
export async function deleteSupportReportAttachment(key: string): Promise<void> {
  const target = file(key);
  if (!target) throw new Error("Support report storage is unavailable");
  await target.delete({ ignoreNotFound: true });
}
export async function readSupportReportAttachment(key: string): Promise<Buffer | null> {
  const target = file(key);
  if (!target) return null;
  const [exists] = await target.exists();
  return exists ? (await target.download())[0] : null;
}