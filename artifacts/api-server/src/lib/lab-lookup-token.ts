import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";

const TOKEN_PREFIX = "v1.";
const TOKEN_AAD = Buffer.from("lab-lookup-token-v1");
const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Stable opaque identity for duplicate prevention across randomized lookup tokens.
 * This is a display key, never an authorization or registration reference. */
export function labLookupSelectionKey(organizationId: string): string {
  return createHmac("sha256", getEncryptionKey())
    .update("lab-selection\0")
    .update(organizationId)
    .digest("base64url");
}

function getEncryptionKey(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET must be configured to issue lab lookup tokens.");
  }
  return createHash("sha256")
    .update(secret)
    .update("\0lab-lookup-token-v1")
    .digest();
}

/**
 * Encrypt an organization ID for the public signup search result. The token
 * lets registration resolve the selected lab without exposing the database ID.
 */
export function createLabLookupToken(organizationId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  cipher.setAAD(TOKEN_AAD);
  const plaintext = Buffer.from(
    JSON.stringify({
      organizationId,
      expiresAt: Date.now() + TOKEN_LIFETIME_MS,
    }),
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return (
    TOKEN_PREFIX +
    Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")
  );
}

/** Return the original ID only for a valid, unexpired signup lookup token. */
export function resolveLabLookupToken(token: unknown): string | null {
  if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) return null;
  const encoded = token.slice(TOKEN_PREFIX.length);
  if (encoded.length > 1024) return null;

  try {
    const packed = Buffer.from(encoded, "base64url");
    if (packed.toString("base64url") !== encoded || packed.length <= 28) {
      return null;
    }

    const iv = packed.subarray(0, 12);
    const authTag = packed.subarray(12, 28);
    const ciphertext = packed.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
    decipher.setAAD(TOKEN_AAD);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    const payload: unknown = JSON.parse(plaintext.toString("utf8"));
    if (
      !payload ||
      typeof payload !== "object" ||
      !("organizationId" in payload) ||
      typeof payload.organizationId !== "string" ||
      !payload.organizationId ||
      !("expiresAt" in payload) ||
      typeof payload.expiresAt !== "number" ||
      payload.expiresAt <= Date.now()
    ) {
      return null;
    }
    return payload.organizationId;
  } catch {
    return null;
  }
}