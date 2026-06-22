/**
 * Speech-to-text transcription route.
 *
 * POST /ai-stt  — Transcribe audio to text via OpenAI Whisper.
 *
 * Authentication: bearer token or session cookie (requireAuth).
 * Rate limit:     10 requests per minute per authenticated user. Requests over
 *                 the limit receive 429 Too Many Requests.
 * Body:          multipart/form-data with `audio` file field (max 25 MB).
 * Returns:       { transcript: string }
 */

import { type IRouter, type RequestHandler } from "express";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import multer from "multer";
import { requireAuth } from "../middlewares/auth";
import { createUserRateLimit } from "../lib/rate-limit";

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

export function registerAiSttRoutes(
  router: IRouter,
  options?: { rateLimiter?: RequestHandler },
): void {
  const rateLimiter = options?.rateLimiter ?? defaultSttRateLimit;

  router.post("/ai-stt", requireAuth, rateLimiter, sttUpload.single("audio"), async (req, res) => {
    const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    if (!apiKey) {
      res.status(503).json({ ok: false, error: "AI not configured" });
      return;
    }

    if (!req.file) {
      req.log.warn("[AI STT] No audio file provided in request");
      res.status(400).json({ ok: false, error: "No audio file provided" });
      return;
    }

    // Must include baseURL when using Replit AI Integrations proxy — the key is
    // a proxy credential that only works against AI_INTEGRATIONS_OPENAI_BASE_URL,
    // not directly against api.openai.com.
    const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    const openai = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    try {
      // Strip codec params (e.g. "audio/webm;codecs=opus" → "audio/webm").
      // OpenAI Whisper only recognises base MIME types; sending codec params causes
      // it to reject the file with an unsupported format error.
      const baseType = (req.file.mimetype || "audio/webm").split(";")[0]!.trim() || "audio/webm";
      const file = await toFile(
        req.file.buffer,
        req.file.originalname || "audio.webm",
        { type: baseType },
      );

      const transcription = await openai.audio.transcriptions.create({
        model: "whisper-1",
        file,
      });

      if (!transcription.text.trim()) {
        req.log.warn({ mimetype: req.file.mimetype, size: req.file.size }, "[AI STT] Whisper returned empty transcript");
        res.json({ ok: true, transcript: "" });
        return;
      }

      res.json({ ok: true, transcript: transcription.text });
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : "Unknown error";
      const isUnsupportedFormat = errMessage.toLowerCase().includes("unsupported audio format") || errMessage.toLowerCase().includes("invalid file format") || errMessage.toLowerCase().includes("audio format");
      req.log.error({ err, mimetype: req.file.mimetype, size: req.file.size }, "[AI STT] Whisper transcription error");
      res.status(500).json({
        ok: false,
        error: isUnsupportedFormat ? "Audio format not supported. Please try again or type your message." : "Speech transcription failed. Please try again.",
      });
    }
  });
}
