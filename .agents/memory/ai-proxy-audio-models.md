---
name: Replit AI proxy audio model support (STT/TTS)
description: Which audio models/endpoints the Replit AI Integrations OpenAI proxy actually supports for Maynard voice — verified against the live proxy.
---

# Replit AI Integrations proxy — audio model support

Verified empirically against the live proxy (`AI_INTEGRATIONS_OPENAI_BASE_URL`,
the `…/modelfarm/openai` base) via curl. The proxy's audio support diverges from
api.openai.com, and the divergence is invisible until you probe it.

## STT (transcription) — `audio/transcriptions`
- `gpt-4o-mini-transcribe` ✅ works
- `gpt-4o-transcribe` ✅ works
- `whisper-1` ❌ `UNSUPPORTED_MODEL` — pinning a route to whisper-1 is exactly
  what silently broke mic/voice input.
- These models only accept `response_format: json` (the default); don't pass
  `verbose_json`/`text`.

## TTS — the `audio/speech` REST endpoint is fully unsupported
- `audio/speech` returns `INVALID_ENDPOINT` for **every** model (tts-1,
  gpt-4o-mini-tts, …). `openai.audio.speech.create()` cannot work through the
  proxy at all.
- Working TTS path: `chat.completions.create({ model, modalities:["text","audio"],
  audio:{ voice, format:"mp3" }, messages:[…] })` with `model` =
  `gpt-audio` (or `gpt-audio-mini`). The base64 mp3 comes back at
  `choices[0].message.audio.data`; decode and send as `audio/mpeg`.
- Voice `onyx` (and the standard alloy/echo/fable/nova/shimmer set) works with
  gpt-audio.
- SDK `openai@^6.x` types `modalities` + `audio` params and `message.audio.data`
  natively — no `as any` cast needed.

**Why:** a future "swap the model" task will assume `audio.speech.create()` just
needs a different model string; it does not — the endpoint itself is absent, so
TTS must be built on the gpt-audio chat-completions modality.

**How to apply:** for any Maynard/voice route, default STT to
gpt-4o-mini-transcribe→gpt-4o-transcribe and TTS to gpt-audio→gpt-audio-mini,
both env-overridable (`AI_STT_MODEL` / `AI_TTS_MODEL`). Never reintroduce
whisper-1 or `audio/speech` as a default fallback.
