/**
 * Text-to-speech synthesis route.
 *
 * POST /ai-tts  — Convert text to MP3 audio via OpenAI TTS.
 *
 * Authentication: bearer token or session cookie (requireAuth).
 * Body:          { text: string, voice?: "alloy"|"echo"|"fable"|"onyx"|"nova"|"shimmer" }
 * Returns:       audio/mpeg binary (Content-Type: audio/mpeg).
 */

import { type IRouter } from "express";
import OpenAI from "openai";
import { requireAuth } from "../middlewares/auth";
import { z } from "zod/v4";

const TtsBodySchema = z.object({
  text: z.string().min(1).max(4096),
  voice: z.enum(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]).optional(),
});

export function registerAiTtsRoutes(router: IRouter): void {
  router.post("/ai-tts", requireAuth, async (req, res) => {
    const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    if (!apiKey) {
      res.status(503).json({ ok: false, error: "AI not configured" });
      return;
    }

    const parsed = TtsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "Invalid request" });
      return;
    }

    const openai = new OpenAI({ apiKey });
    try {
      const speech = await openai.audio.speech.create({
        model: "tts-1",
        voice: parsed.data.voice ?? "onyx",
        input: parsed.data.text,
        response_format: "mp3",
      });

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-cache");
      const buffer = Buffer.from(await speech.arrayBuffer());
      res.send(buffer);
    } catch (err: unknown) {
      req.log.error({ err }, "[AI TTS] OpenAI error");
      res.status(500).json({ ok: false, error: "TTS synthesis failed" });
    }
  });
}
