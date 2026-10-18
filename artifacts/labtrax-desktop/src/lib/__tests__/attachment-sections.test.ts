import { describe, expect, it } from "vitest";
import {
  buildAttachmentSectionPreference,
  getAttachmentSection,
  groupCaseAttachments,
  parseAttachmentSectionPreference,
} from "@/lib/attachment-sections";
import type { CaseAttachment } from "@/lib/types";

function attachment(
  fileName: string,
  fileType: string,
  category?: CaseAttachment["category"],
): CaseAttachment {
  return {
    id: fileName,
    caseId: "case-1",
    uploadedByUserId: "user-1",
    uploadedByOrganizationId: "org-1",
    storageKey: fileName,
    fileName,
    fileType,
    category,
  };
}

describe("desktop case attachment sections", () => {
  it("classifies prescription images as documents and ordinary media as media", () => {
    expect(
      getAttachmentSection(attachment("rx.jpg", "image/jpeg", "prescription")),
    ).toBe("documents");
    expect(getAttachmentSection(attachment("photo.jpg", "image/jpeg"))).toBe("media");
    expect(getAttachmentSection(attachment("clip.MOV", ""))).toBe("media");
    expect(
      getAttachmentSection(attachment("outgoing.bin", "", "outgoing")),
    ).toBe("media");
  });

  it("classifies supported 3D formats before document fallbacks", () => {
    expect(getAttachmentSection(attachment("scan.PLY", ""))).toBe("files");
    expect(getAttachmentSection(attachment("scan.stl", "application/octet-stream"))).toBe(
      "files",
    );
    expect(getAttachmentSection(attachment("scan", "model/obj"))).toBe("files");
    expect(getAttachmentSection(attachment("instructions.pdf", "application/pdf"))).toBe(
      "documents",
    );
    expect(getAttachmentSection(attachment("archive.zip", "application/zip"))).toBe("files");
    expect(
      getAttachmentSection(attachment("unknown.bin", "application/octet-stream")),
    ).toBe("files");
  });

  it("keeps source ordering within each group", () => {
    const first = attachment("first.jpg", "image/jpeg");
    const document = attachment("rx.pdf", "application/pdf");
    const second = attachment("second.mp4", "video/mp4");
    expect(groupCaseAttachments([first, document, second])).toEqual({
      media: [first, second],
      documents: [document],
      files: [],
    });
  });

  it("rejects malformed and unsupported stored preferences", () => {
    expect(parseAttachmentSectionPreference("{bad")).toBeNull();
    expect(parseAttachmentSectionPreference(JSON.stringify({ version: 2 }))).toBeNull();
    expect(
      parseAttachmentSectionPreference(
        JSON.stringify({
          version: 1,
          expanded: { media: true, documents: false, files: false },
          save: { media: true, documents: false, files: false },
        }),
      ),
    ).toBeNull();
  });

  it("stores and restores only opted-in section states", () => {
    const preference = buildAttachmentSectionPreference(
      { media: true, documents: true, files: true },
      { all: false, media: true, documents: false, files: false },
    );
    expect(preference.expanded).toEqual({
      media: true,
      documents: false,
      files: false,
    });
    expect(
      parseAttachmentSectionPreference(JSON.stringify(preference))?.expanded,
    ).toEqual(preference.expanded);
  });
});