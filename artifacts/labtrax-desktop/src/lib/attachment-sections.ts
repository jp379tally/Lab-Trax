import type { CaseAttachment } from "@/lib/types";

export type AttachmentSectionId = "media" | "documents" | "files";

export type AttachmentSectionExpansion = Record<AttachmentSectionId, boolean>;

export type AttachmentSectionPreference = {
  version: 1;
  expanded: AttachmentSectionExpansion;
  save: AttachmentSectionExpansion & { all: boolean };
};

export const COLLAPSED_ATTACHMENT_SECTIONS: AttachmentSectionExpansion = {
  media: false,
  documents: false,
  files: false,
};

const THREE_D_MIME_TYPES = new Set([
  "model/stl",
  "model/obj",
  "model/ply",
  "application/sla",
]);
const THREE_D_EXTENSIONS = new Set(["stl", "obj", "ply", "dcm", "3ds", "dae"]);
const MEDIA_EXTENSIONS = new Set([
  "apng", "avif", "bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "svg",
  "tif", "tiff", "webp", "m4v", "mov", "mp4", "ogg", "ogv", "webm",
]);
const DOCUMENT_EXTENSIONS = new Set([
  "csv", "doc", "docx", "html", "htm", "md", "odt", "pdf", "rtf", "txt",
  "xls", "xlsx", "xml",
]);

function extension(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  return index >= 0 ? fileName.slice(index + 1).toLowerCase() : "";
}

export function getAttachmentSection(
  attachment: Pick<CaseAttachment, "category" | "fileName" | "fileType">,
): AttachmentSectionId {
  if (attachment.category === "prescription") return "documents";

  const mimeType = (attachment.fileType || "").toLowerCase();
  const ext = extension(attachment.fileName || "");
  if (THREE_D_MIME_TYPES.has(mimeType) || THREE_D_EXTENSIONS.has(ext)) return "files";

  // Outgoing photos retain their established media semantics even if an older
  // row has an incomplete MIME type.
  if (
    attachment.category === "outgoing" ||
    mimeType.startsWith("image/") ||
    mimeType.startsWith("video/") ||
    MEDIA_EXTENSIONS.has(ext)
  ) {
    return "media";
  }
  if (
    mimeType === "application/pdf" ||
    mimeType.startsWith("text/") ||
    mimeType.includes("document") ||
    mimeType.includes("spreadsheet") ||
    mimeType.includes("msword") ||
    DOCUMENT_EXTENSIONS.has(ext)
  ) {
    return "documents";
  }
  return "files";
}

export function groupCaseAttachments(attachments: CaseAttachment[]) {
  const grouped: Record<AttachmentSectionId, CaseAttachment[]> = {
    media: [],
    documents: [],
    files: [],
  };
  for (const attachment of attachments) {
    grouped[getAttachmentSection(attachment)].push(attachment);
  }
  return grouped;
}

export function attachmentSectionPreferenceKey(userId?: string | null): string {
  return `labtrax.desktop.case-files.sections.v1:${userId || "anonymous"}`;
}

export function parseAttachmentSectionPreference(
  raw: string | null,
): AttachmentSectionPreference | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<AttachmentSectionPreference>;
    const expanded = value.expanded;
    const save = value.save;
    if (
      value.version !== 1 ||
      !expanded ||
      !save ||
      typeof expanded.media !== "boolean" ||
      typeof expanded.documents !== "boolean" ||
      typeof expanded.files !== "boolean" ||
      typeof save.media !== "boolean" ||
      typeof save.documents !== "boolean" ||
      typeof save.files !== "boolean" ||
      typeof save.all !== "boolean"
    ) {
      return null;
    }
    return {
      version: 1,
      expanded: {
        media: save.all || save.media ? expanded.media : false,
        documents: save.all || save.documents ? expanded.documents : false,
        files: save.all || save.files ? expanded.files : false,
      },
      save: { ...save },
    };
  } catch {
    return null;
  }
}

export function buildAttachmentSectionPreference(
  expanded: AttachmentSectionExpansion,
  save: AttachmentSectionPreference["save"],
): AttachmentSectionPreference {
  return {
    version: 1,
    expanded: {
      media: save.all || save.media ? expanded.media : false,
      documents: save.all || save.documents ? expanded.documents : false,
      files: save.all || save.files ? expanded.files : false,
    },
    save,
  };
}