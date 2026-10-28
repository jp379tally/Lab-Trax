import { z } from "zod";

// This is continuity evidence, NOT a replacement for initial SHA-256 +
// authenticated byte read-back, and NOT a fresh physical-byte scrub.
export const objectVersionSchema = z.object({
  provider: z.enum(["onedrive-content-v1", "google-drive-content-v1"]),
  driveId: z.string().min(1).max(1024),
  itemId: z.string().min(1).max(1024),
  contentTag: z.string().min(1).max(2048),
  bytes: z.number().int().positive(),
}).strict();
export type ObjectVersion = z.infer<typeof objectVersionSchema>;
export function sameObjectVersion(a: ObjectVersion | null, b: ObjectVersion | null): boolean {
  return Boolean(a && b && a.provider === b.provider && a.driveId === b.driveId &&
    a.itemId === b.itemId && a.contentTag === b.contentTag && a.bytes === b.bytes);
}
