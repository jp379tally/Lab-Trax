import { describe, it, expect } from "vitest";
import {
  isVideoAsset,
  resolveVideoMime,
  fileExtension,
  VIDEO_EXTENSION_MIME,
  isInlinePlayableVideo,
} from "@/lib/video-asset";

describe("fileExtension", () => {
  it("returns the lowercased extension", async () => {
    expect(fileExtension("video.MP4")).toBe("mp4");
    expect(fileExtension("clip.mov")).toBe("mov");
    expect(fileExtension("photo.JPEG")).toBe("jpeg");
  });

  it("returns empty string when no extension is present", async () => {
    expect(fileExtension("noext")).toBe("");
    expect(fileExtension("")).toBe("");
  });

  it("handles multiple dots by returning only the last segment", async () => {
    expect(fileExtension("my.video.clip.mp4")).toBe("mp4");
    expect(fileExtension(" IMG_0042.MOV ")).toBe("mov");
  });
});

describe("isVideoAsset", () => {
  describe("tier 1: picker type field", () => {
    it("returns true when type is 'video', even with null mimeType and no fileName", async () => {
      expect(isVideoAsset({ type: "video", mimeType: null, fileName: null })).toBe(true);
    });

    it("returns false when type is 'image'", async () => {
      expect(isVideoAsset({ type: "image", mimeType: null, fileName: null })).toBe(false);
    });
  });

  describe("tier 2: mimeType prefix", () => {
    it("returns true when mimeType starts with 'video/' and type is null", async () => {
      expect(isVideoAsset({ type: null, mimeType: "video/mp4", fileName: null })).toBe(true);
      expect(isVideoAsset({ type: null, mimeType: "video/quicktime", fileName: null })).toBe(true);
    });

    it("returns false for image/* mimeType with null type", async () => {
      expect(isVideoAsset({ type: null, mimeType: "image/jpeg", fileName: null })).toBe(false);
    });

    it("does not let a video-looking filename override a specific non-video MIME", async () => {
      expect(
        isVideoAsset({
          type: null,
          mimeType: "application/pdf",
          fileName: "misnamed.mp4",
        }),
      ).toBe(false);
    });

    it("uses the filename when the server MIME is generic", async () => {
      expect(
        isVideoAsset({
          type: null,
          mimeType: "application/octet-stream",
          fileName: "legacy.mp4",
        }),
      ).toBe(true);
    });
  });

  describe("tier 3: file extension (null type AND null mimeType)", () => {
    it("returns true for .mp4 filename when both type and mimeType are null", async () => {
      expect(isVideoAsset({ type: null, mimeType: null, fileName: "clip.mp4" })).toBe(true);
    });

    it("returns true for .mov filename when both type and mimeType are null", async () => {
      expect(isVideoAsset({ type: null, mimeType: null, fileName: "video.mov" })).toBe(true);
    });

    it("returns true for .avi, .mkv, .webm filenames", async () => {
      expect(isVideoAsset({ type: null, mimeType: null, fileName: "film.avi" })).toBe(true);
      expect(isVideoAsset({ type: null, mimeType: null, fileName: "film.mkv" })).toBe(true);
      expect(isVideoAsset({ type: null, mimeType: null, fileName: "film.webm" })).toBe(true);
    });

    it("returns true for uppercase extension", async () => {
      expect(isVideoAsset({ type: null, mimeType: null, fileName: "CLIP.MOV" })).toBe(true);
    });

    it("returns false for .jpg filename when type and mimeType are null", async () => {
      expect(isVideoAsset({ type: null, mimeType: null, fileName: "photo.jpg" })).toBe(false);
    });

    it("returns false when all fields are null/undefined", async () => {
      expect(isVideoAsset({ type: null, mimeType: null, fileName: null })).toBe(false);
      expect(isVideoAsset({})).toBe(false);
    });
  });
});

describe("resolveVideoMime", () => {
  it("returns the existing mimeType when it starts with 'video/'", async () => {
    expect(resolveVideoMime({ mimeType: "video/mp4", fileName: null })).toBe("video/mp4");
    expect(resolveVideoMime({ mimeType: "video/quicktime", fileName: "clip.mp4" })).toBe(
      "video/quicktime",
    );
  });

  it("looks up the extension table when mimeType is null", async () => {
    expect(resolveVideoMime({ mimeType: null, fileName: "clip.mp4" })).toBe("video/mp4");
    expect(resolveVideoMime({ mimeType: null, fileName: "video.mov" })).toBe("video/quicktime");
    expect(resolveVideoMime({ mimeType: null, fileName: "film.avi" })).toBe("video/x-msvideo");
    expect(resolveVideoMime({ mimeType: null, fileName: "clip.webm" })).toBe("video/webm");
  });

  it("returns 'video/mp4' as the final fallback when mimeType and fileName are null", async () => {
    expect(resolveVideoMime({ mimeType: null, fileName: null })).toBe("video/mp4");
    expect(resolveVideoMime({})).toBe("video/mp4");
  });

  it("returns 'video/mp4' fallback for an unrecognized extension", async () => {
    expect(resolveVideoMime({ mimeType: null, fileName: "clip.xyz" })).toBe("video/mp4");
  });

  it("handles uppercase extensions correctly", async () => {
    expect(resolveVideoMime({ mimeType: null, fileName: "VIDEO.MOV" })).toBe("video/quicktime");
  });

  it("does not return a video/ mime for a non-video mimeType", async () => {
    // A non-video mimeType is not prefixed video/, so falls through to extension lookup
    expect(resolveVideoMime({ mimeType: "image/jpeg", fileName: "clip.mp4" })).toBe("video/mp4");
  });

  it("covers every entry in VIDEO_EXTENSION_MIME", async () => {
    for (const [ext, expectedMime] of Object.entries(VIDEO_EXTENSION_MIME)) {
      expect(resolveVideoMime({ mimeType: null, fileName: `file.${ext}` })).toBe(expectedMime);
    }
  });
});

describe("isInlinePlayableVideo", () => {
  it("accepts common camera MIME types and generic MIME with a playable filename", () => {
    expect(isInlinePlayableVideo({ mimeType: "video/mp4", fileName: "clip.bin" })).toBe(true);
    expect(isInlinePlayableVideo({ mimeType: "video/quicktime", fileName: "clip.bin" })).toBe(true);
    expect(
      isInlinePlayableVideo({
        mimeType: "application/octet-stream",
        fileName: "camera.MOV",
      }),
    ).toBe(true);
    expect(isInlinePlayableVideo({ mimeType: " VIDEO/QUICKTIME ", fileName: null })).toBe(true);
  });

  it("leaves recognized but unreliable native codecs to the OS fallback", () => {
    expect(isInlinePlayableVideo({ mimeType: "video/x-matroska", fileName: "clip.mkv" })).toBe(
      false,
    );
    expect(isInlinePlayableVideo({ mimeType: "video/webm", fileName: "clip.webm" })).toBe(false);
  });
});
