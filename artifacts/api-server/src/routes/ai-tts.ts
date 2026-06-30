/**
 * Text-to-speech synthesis route.
 *
 * POST /ai-tts  — Convert text to MP3 audio via the Replit AI Integrations
 *                 OpenAI proxy.
 *
 * Authentication: bearer token or session cookie (requireAuth).
 * Body:          { text: string, voice?: "alloy"|"echo"|"fable"|"onyx"|"nova"|"shimmer" }
 * Returns:       audio/mpeg binary (Content-Type: audio/mpeg).
 *
 * Synthesis goes through the `gpt-audio` chat-completions audio modality rather
 * than the `audio/speech` REST endpoint: the Replit AI Integrations proxy
 * returns `INVALID_ENDPOINT` for `audio/speech` with every model (tts-1,
 * gpt-4o-mini-tts), which is what broke spoken replies. Model selection is an
 * env-configurable fallback chain (see ttsModelChain).
 */

import { type IRouter } from "express";
import { createOpenAIClient } from "../lib/ai-openai-client";
import { requireAuth } from "../middlewares/auth";
import { z } from "zod/v4";

const TtsBodySchema = z.object({
  text: z.string().min(1).max(4096),
  voice: z.enum(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]).optional(),
});

/**
 * Ordered TTS-model fallback chain.
 *
 * Prefers `AI_TTS_MODEL` when set, then the proxy-supported audio chat models.
 * `tts-1` (and any other `audio/speech` model) is intentionally omitted: the
 * Replit AI Integrations proxy does not expose the speech REST endpoint, so no
 * model works there. Set `AI_TTS_MODEL` only to another chat-completions audio
 * model.
 */
function ttsModelChain(): string[] {
  const chain: string[] = [];
  const override = process.env.AI_TTS_MODEL?.trim();
  if (override) chain.push(override);
  for (const model of ["gpt-audio", "gpt-audio-mini"]) {
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
  if (msg.includes("rate limit") || msg.includes("429")) return "rate_limited";
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("etimedout")) return "timeout";
  return "provider_error";
}

export function registerAiTtsRoutes(router: IRouter): void {
  router.post("/ai-tts", requireAuth, async (req, res) => {
    const parsed = TtsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "Invalid request" });
      return;
    }

    const openai = createOpenAIClient();
    if (!openai) {
      res.status(503).json({ ok: false, error: "AI not configured" });
      return;
    }

    const text = parsed.data.text;
    const voice = parsed.data.voice ?? "onyx";
    const models = ttsModelChain();
    let lastCategory = "provider_error";

    for (const model of models) {
      try {
        const completion = await openai.chat.completions.create({
          model,
          modalities: ["text", "audio"],
          audio: { voice, format: "mp3" },
          messages: [
            {
              role: "system",
              content:
                "You are a text-to-speech engine. Speak the user's message back verbatim. Do not add, omit, translate, or change any words.",
            },
            { role: "user", content: text },
          ],
        });

        const audioData = completion.choices[0]?.message?.audio?.data ?? "";
        const buffer = Buffer.from(audioData, "base64");
        if (!buffer.length) {
          lastCategory = "empty_audio";
          req.log.error(
            { model, voice, textLength: text.length, errorCategory: lastCategory },
            "[AI TTS] provider returned empty audio buffer",
          );
          continue;
        }

        req.log.info(
          { model, voice, textLength: text.length, audioBytes: buffer.length },
          "[AI TTS] synthesis succeeded",
        );
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Cache-Control", "no-cache");
        res.send(buffer);
        return;
      } catch (err: unknown) {
        lastCategory = categorizeAudioError(err);
        req.log.error(
          { model, voice, textLength: text.length, errorCategory: lastCategory },
          "[AI TTS] synthesis attempt failed",
        );
        // Fall through to the next model in the chain.
      }
    }

    res.status(500).json({
      ok: false,
      error:
        lastCategory === "empty_audio"
          ? "TTS synthesis returned no audio"
          : "Voice playback is temporarily unavailable.",
    });
  });
}
