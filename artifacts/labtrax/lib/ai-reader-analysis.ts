import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";
import { Image } from "react-native";
import type { CapturedPage } from "./ai-reader-store";

export const AI_READER_WAIT_MS = 70_000;
export const AI_READER_TIMEOUT_MESSAGE =
  "Analysis took too long. Please retry or continue by entering the details manually.";
const STILL_STOPPING_MESSAGE =
  "The previous analysis is still stopping. Please wait before retrying, or continue manually.";
let pendingAnalysis: Promise<Response> | null = null;

export function createAiReaderSubmissionGuard() {
  let inFlight = false;
  return {
    tryStart() {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    finish() { inFlight = false; },
    get active() { return inFlight; },
  };
}

type ImageTools = {
  manipulate: typeof ImageManipulator.manipulateAsync;
  readBase64: (uri: string) => Promise<string>;
  getDimensions?: (uri: string) => Promise<{ width: number; height: number }>;
};

const imageTools: ImageTools = {
  manipulate: ImageManipulator.manipulateAsync,
  readBase64: (uri) => FileSystem.readAsStringAsync(uri, { encoding: "base64" }),
  getDimensions: (uri) => new Promise((resolve, reject) => Image.getSize(
    uri,
    (width, height) => resolve({ width, height }),
    reject,
  )),
};

// Only the AI request uses these temporary derivatives. The session's original
// URIs and base64 remain unchanged for retakes, review, PDF and attachments.
export async function prepareAiReaderPayload(
  pages: readonly CapturedPage[],
  tools: ImageTools = imageTools,
): Promise<{ imageBase64: string; additionalImages?: string[]; fast: true }> {
  if (!pages.length) throw new Error("No pages captured.");
  const images = await Promise.all(pages.map(async (page) => {
    try {
      // The scanner can provide a bare file path on some native versions.
      // If metadata lookup fails, still try a width-bounded transform rather
      // than sending the full-resolution original immediately.
      const dimensions = await tools.getDimensions?.(page.uri).catch(() => undefined);
      const resize = dimensions?.height && dimensions.height > dimensions.width
        ? { height: 1600 }
        : { width: 1600 };
      const result = await tools.manipulate(
        page.uri,
        [{ resize }],
        { format: ImageManipulator.SaveFormat.JPEG, compress: 0.72 },
      );
      // Some platforms provide base64 from the manipulator; otherwise read its
      // temporary file. Never read or overwrite the captured original here.
      const encoded = result.base64 || await tools.readBase64(result.uri);
      if (!encoded) throw new Error("Empty analysis image");
      return encoded;
    } catch {
      // A failed transform must not block intake. The original is still valid.
      return page.base64;
    }
  }));
  const [imageBase64, ...additionalImages] = images;
  return {
    imageBase64,
    ...(additionalImages.length ? { additionalImages } : {}),
    fast: true,
  };
}

export async function requestAiReaderAnalysis(
  pages: readonly CapturedPage[],
  fetcher: (path: string, options: RequestInit) => Promise<Response>,
  prepare: typeof prepareAiReaderPayload = prepareAiReaderPayload,
  waitMs = AI_READER_WAIT_MS,
  report: (stage: "preparation" | "request", milliseconds: number, payloadChars?: number) => void = (stage, durationMs, payloadChars) => {
    if (typeof __DEV__ !== "undefined" && __DEV__) console.debug("AI Reader stage", { stage, durationMs, payloadChars });
  },
): Promise<Response> {
  if (pages.length > 10) throw new Error("AI analysis accepts at most 10 pages. Use smaller batches or enter details manually; keep the original pages as attachments.");
  if (pendingAnalysis) throw new Error(STILL_STOPPING_MESSAGE);
  const controller = new AbortController();
  const startedAt = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, waitMs);
  try {
    // A hung native transform must also release the review screen. Its eventual
    // completion cannot send a request because the signal has been aborted.
    const body = await Promise.race([
      prepare(pages),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error(AI_READER_TIMEOUT_MESSAGE)), { once: true });
      }),
    ]);
    if (controller.signal.aborted) throw new Error(AI_READER_TIMEOUT_MESSAGE);
    report("preparation", Date.now() - startedAt);
    const serialized = JSON.stringify(body);
    if (serialized.length > 11.5 * 1024 * 1024) {
      throw new Error("This prescription is too large for AI analysis. Use fewer pages per analysis or enter the details manually. Keep the original pages as attachments.");
    }
    const requestStartedAt = Date.now();
    const operation = fetcher("/api/analyze-prescription", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serialized,
      signal: controller.signal,
    });
    pendingAnalysis = operation;
    void operation.then(
      () => { if (pendingAnalysis === operation) pendingAnalysis = null; },
      () => { if (pendingAnalysis === operation) pendingAnalysis = null; },
    );
    // Some transport adapters can fail to reject promptly on abort. Release
    // the UI at the deadline, but keep retry fenced until that request settles.
    const response = await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => controller.signal.addEventListener(
        "abort", () => reject(new Error(AI_READER_TIMEOUT_MESSAGE)), { once: true },
      )),
    ]);
    report("request", Date.now() - requestStartedAt, serialized.length);
    if (typeof __DEV__ !== "undefined" && __DEV__) console.debug("AI Reader server stages", { serverTiming: response.headers.get("Server-Timing") });
    if (controller.signal.aborted) throw new Error(AI_READER_TIMEOUT_MESSAGE);
    return response;
  } catch (error) {
    if (timedOut) throw new Error(AI_READER_TIMEOUT_MESSAGE);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}