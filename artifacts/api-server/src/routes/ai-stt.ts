/**
 * Speech-to-text transcription route.
 *
 * POST /ai-stt  — Transcribe audio to text via the Replit AI Integrations
 *                 OpenAI proxy.
 *
 * Authentication: bearer token or session cookie (requireAuth).
 * Rate limit:     10 requests per minute per authenticated user. Requests over
 *                 the limit receive 429 Too Many Requests.
 * Body:          multipart/form-data with `audio` file field (max 25 MB).
 * Returns:       { ok: true, transcript: string }
 *
 * Model selection is an env-configurable fallback chain (see sttModelChain).
 * On a model failure the route tries the next model before surfacing an error,
 * so a single model going unsupported through the proxy no longer breaks voice
 * input.
 */

import { type IRouter, type RequestHandler } from "express";
import { toFile } from "openai/uploads";
import multer from "multer";
import { requireAuth } from "../middlewares/auth";
import { createUserRateLimit } from "../lib/rate-limit";
import { createOpenAIClient } from "../lib/ai-openai-client";

const sttUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/** Default: 10 transcription requests per user per minute. */
const defaultSttRateLimit = createUserRateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: "Too many transcription requests. Please wait a moment and try again.",
});

/**
 * Ordered transcription-model fallback chain.
 *
 * Prefers `AI_STT_MODEL` when set, then the proxy-supported gpt-4o transcribe
 * models. `whisper-1` is intentionally omitted from the defaults: the Replit AI
 * Integrations proxy rejects it with `UNSUPPORTED_MODEL` (verified against the
 * live proxy), which is exactly what broke voice input. Set
 * `AI_STT_MODEL=whisper-1` only if a future proxy re-adds support for it.
 */
function sttModelChain(): string[] {
  const chain: string[] = [];
  const override = process.env.AI_STT_MODEL?.trim();
  if (override) chain.push(override);
  for (const model of ["gpt-4o-mini-transcribe", "gpt-4o-transcribe"]) {
    if (!chain.includes(model)) chain.push(model);
  }
  return chain;
}

/**
 * Map a provider error to a safe, low-cardinality category for structured
 * logging. Never log or return raw provider payloads, secrets, or stack traces.
 */
function categorizeAudioError(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (
    msg.includes("unsupported_model") ||
    msg.includes("not supported") ||
    msg.includes("invalid_endpoint") ||
    msg.includes("does not exist")
  ) {
    return "unsupported_model";
  }
  if (
    msg.includes("unsupported audio format") ||
    msg.includes("invalid file format") ||
    msg.includes("audio format") ||
    msg.includes("could not be decoded")
  ) {
    return "unsupported_format";
  }
  if (msg.includes("rate limit") || msg.includes("429")) return "rate_limited";
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("etimedout")) return "timeout";
  return "provider_error";
}

export function registerAiSttRoutes(
  router: IRouter,
  options?: { rateLimiter?: RequestHandler },
): void {
  const rateLimiter = options?.rateLimiter ?? defaultSttRateLimit;

  router.post("/ai-stt", requireAuth, rateLimiter, sttUpload.single("audio"), async (req, res) => {
    const openai = createOpenAIClient();
    if (!openai) {
      res.status(503).json({ ok: false, error: "AI not configured" });
      return;
    }

    if (!req.file) {
      req.log.warn("[AI STT] No audio file provided in request");
      res.status(400).json({ ok: false, error: "No audio file provided" });
      return;
    }

    // Strip codec params (e.g. "audio/webm;codecs=opus" → "audio/webm"). The
    // transcription models only recognise base MIME types; codec params cause an
    // unsupported-format rejection.
    const baseType = (req.file.mimetype || "audio/webm").split(";")[0]!.trim() || "audio/webm";
    const filename = req.file.originalname || "audio.webm";
    const sizeBytes = req.file.size;
    const buffer = req.file.buffer;

    const models = sttModelChain();
    let lastCategory = "provider_error";

    for (const model of models) {
      try {
        // Recreate the upload per attempt — the SDK consumes the file stream, so
        // a previous failed attempt may have already read it.
        const file = await toFile(buffer, filename, { type: baseType });
        const transcription = await openai.audio.transcriptions.create({ model, file });
        const text = (transcription.text ?? "").trim();
        req.log.info(
          { model, mimetype: baseType, sizeBytes, transcriptChars: text.length },
          "[AI STT] transcription succeeded",
        );
        res.json({ ok: true, transcript: text });
        return;
      } catch (err: unknown) {
        lastCategory = categorizeAudioError(err);
        req.log.error(
          { model, mimetype: baseType, sizeBytes, errorCategory: lastCategory },
          "[AI STT] transcription attempt failed",
        );
        // Fall through to the next model in the chain.
      }
    }

    res.status(500).json({
      ok: false,
      error:
        lastCategory === "unsupported_format"
          ? "That audio format isn't supported. You can still type your message."
          : "Voice transcription is temporarily unavailable. You can still type your message.",
    });
  });
}
