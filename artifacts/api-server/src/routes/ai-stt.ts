/**
 * Speech-to-text transcription route.
 *
 * POST /ai-stt  — Transcribe audio to text via OpenAI Whisper.
 *
 * Authentication: bearer token or session cookie (requireAuth).
 * Body:          multipart/form-data with `audio` file field (max 25 MB).
 * Returns:       { transcript: string }
 */

import { type IRouter } from "express";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import multer from "multer";
import { requireAuth } from "../middlewares/auth";

const sttUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

export function registerAiSttRoutes(router: IRouter): void {
  router.post("/ai-stt", requireAuth, sttUpload.single("audio"), async (req, res) => {
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

    const openai = new OpenAI({ apiKey });
    try {
      const file = await toFile(
        req.file.buffer,
        req.file.originalname || "audio.webm",
        { type: req.file.mimetype || "audio/webm" },
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
      req.log.error({ err, mimetype: req.file.mimetype, size: req.file.size }, "[AI STT] Whisper transcription error");
      res.status(500).json({ ok: false, error: "Speech transcription failed" });
    }
  });
}
