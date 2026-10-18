/** Identify the prescription bytes, not browser/ZIP-generated file timestamps. */
export async function prescriptionSourceIdentity(dataUrl: string): Promise<string> {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Could not identify the prescription source.");
  const payload = dataUrl.slice(comma + 1);
  if (globalThis.crypto?.subtle && typeof TextEncoder !== "undefined") {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  // Older preview/test environments still compare exact contents, never a
  // collision-prone filename/size or an unstable lastModified timestamp.
  return `payload:${payload}`;
}
