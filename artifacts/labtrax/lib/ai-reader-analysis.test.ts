import { describe, expect, it, vi } from "vitest";
import type { CapturedPage } from "./ai-reader-store";

vi.mock("expo-image-manipulator", () => ({
  SaveFormat: { JPEG: "jpeg" },
  manipulateAsync: vi.fn(),
}));
vi.mock("expo-file-system/legacy", () => ({ readAsStringAsync: vi.fn() }));

import {
  createAiReaderSubmissionGuard,
  prepareAiReaderPayload,
  requestAiReaderAnalysis,
  AI_READER_TIMEOUT_MESSAGE,
} from "./ai-reader-analysis";

const pages: CapturedPage[] = [
  { uri: "file://one.jpg", base64: "original-one" },
  { uri: "file://two.jpg", base64: "original-two" },
];

describe("AI Reader analysis request", () => {
  it("rejects repeated taps until the first submission settles, then allows a retry", () => {
    const submission = createAiReaderSubmissionGuard();
    expect(submission.tryStart()).toBe(true);
    expect(submission.tryStart()).toBe(false);
    submission.finish();
    expect(submission.tryStart()).toBe(true);
    submission.finish();
  });
  it("compresses a single page without changing the PDF/review original", async () => {
    const original = { ...pages[0] };
    const manipulate = vi.fn().mockResolvedValue({ uri: "file://temporary.jpg" });
    const readBase64 = vi.fn().mockResolvedValue("small");
    expect(await prepareAiReaderPayload([pages[0]], { manipulate, readBase64 }))
      .toEqual({ imageBase64: "small", fast: true });
    expect(manipulate).toHaveBeenCalledWith(
      original.uri, [{ resize: { width: 1600 } }], { format: "jpeg", compress: 0.72 },
    );
    expect(readBase64).toHaveBeenCalledWith("file://temporary.jpg");
    expect(pages[0]).toEqual(original);
  });

  it("retains page order, falling back only for an unsuccessful transform", async () => {
    const manipulate = vi.fn(async (uri: string) => {
      if (uri === pages[1].uri) throw new Error("unavailable");
      return { uri: "file://small.jpg", base64: null };
    });
    const readBase64 = vi.fn().mockResolvedValue("small-one");
    const reordered = [pages[1], pages[0]];
    expect(await prepareAiReaderPayload(reordered, { manipulate: manipulate as any, readBase64 }))
      .toEqual({ imageBase64: "original-two", additionalImages: ["small-one"], fast: true });
    expect(reordered).toEqual([pages[1], pages[0]]);
  });

  it("bounds the longest side for portrait captures", async () => {
    const manipulate = vi.fn().mockResolvedValue({ uri: "file://portrait-small.jpg" });
    await prepareAiReaderPayload([pages[0]], {
      manipulate,
      readBase64: vi.fn().mockResolvedValue("small"),
      getDimensions: vi.fn().mockResolvedValue({ width: 2000, height: 3000 }),
    });
    expect(manipulate).toHaveBeenCalledWith(
      pages[0].uri, [{ resize: { height: 1600 } }], expect.anything(),
    );
  });

  it("sends a single fast-mode request and clears the timer on success", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn().mockResolvedValue({ status: 200 });
      const prepare = vi.fn().mockResolvedValue({ imageBase64: "small", fast: true });
      await requestAiReaderAnalysis([pages[0]], fetcher, prepare);
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [path, options] = fetcher.mock.calls[0];
      expect(path).toBe("/api/analyze-prescription");
      expect(JSON.parse(options.body)).toEqual({ imageBase64: "small", fast: true });
      expect(options.signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends ordered multi-page derivatives in one fast-mode request", async () => {
    const manipulate = vi.fn(async (uri: string) => ({ uri: `${uri}-small` }));
    const readBase64 = vi.fn(async (uri: string) => uri.includes("two") ? "small-two" : "small-one");
    const fetcher = vi.fn().mockResolvedValue({ status: 200 });
    await requestAiReaderAnalysis(
      [pages[1], pages[0]],
      fetcher,
      (ordered) => prepareAiReaderPayload(ordered, { manipulate: manipulate as any, readBase64 }),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1].body))
      .toEqual({ imageBase64: "small-two", additionalImages: ["small-one"], fast: true });
    expect(pages.map((p) => p.base64)).toEqual(["original-one", "original-two"]);
  });

  it("aborts on timeout, cleans up, then permits a retry", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn()
        .mockImplementationOnce((_path, options: RequestInit) => new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }))
        .mockResolvedValueOnce({ status: 200 });
      const prepare = vi.fn().mockResolvedValue({ imageBase64: "small", fast: true });
      const first = requestAiReaderAnalysis([pages[0]], fetcher, prepare, 100);
      const rejection = expect(first).rejects.toThrow(AI_READER_TIMEOUT_MESSAGE);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await expect(requestAiReaderAnalysis([pages[0]], fetcher, prepare, 100))
        .resolves.toEqual({ status: 200 });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the wait even if fetch ignores abort, but fences a duplicate request", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (result: Response) => void;
      const fetcher = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
      const prepare = vi.fn().mockResolvedValue({ imageBase64: "small", fast: true });
      const first = requestAiReaderAnalysis([pages[0]], fetcher, prepare, 100);
      const rejection = expect(first).rejects.toThrow(AI_READER_TIMEOUT_MESSAGE);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      await expect(requestAiReaderAnalysis([pages[0]], fetcher, prepare, 100))
        .rejects.toThrow("still stopping");
      expect(fetcher).toHaveBeenCalledTimes(1);
      finish({ status: 200 } as Response);
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});