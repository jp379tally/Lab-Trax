// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { imageToAnalysisDataUrl } from "../DashboardDropZone";

describe("desktop prescription analysis image", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("bounds the analysis JPEG while retaining the original File", async () => {
    const original = new File(["original-image"], "rx.jpg", { type: "image/jpeg" });
    const close = vi.fn();
    const drawImage = vi.fn();
    const bitmap = { width: 2400, height: 3600, close } as unknown as ImageBitmap;
    const create = vi.fn().mockResolvedValue(bitmap);
    vi.stubGlobal("createImageBitmap", create);
    const canvas = document.createElement("canvas");
    const toDataURL = vi.spyOn(canvas, "toDataURL").mockReturnValue("data:image/jpeg;base64,small");
    vi.spyOn(canvas, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const createElement = document.createElement.bind(document);
    const elementSpy = vi.spyOn(document, "createElement").mockImplementation((tag, options) =>
      tag === "canvas" ? canvas : createElement(tag, options));
    try {
      expect(await imageToAnalysisDataUrl(original)).toBe("data:image/jpeg;base64,small");
      expect(create).toHaveBeenCalledWith(original, { imageOrientation: "from-image" });
      expect(canvas.width).toBe(1067);
      expect(canvas.height).toBe(1600);
      expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1067, 1600);
      expect(toDataURL).toHaveBeenCalledWith("image/jpeg", 0.78);
      expect(original.size).toBe("original-image".length);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      elementSpy.mockRestore();
    }
  });
});