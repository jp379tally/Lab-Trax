/**
 * Tests for the text-to-speech synthesis endpoint.
 *
 * Synthesis runs through the `gpt-audio` chat-completions audio modality (the
 * `audio/speech` REST endpoint is unsupported by the Replit AI Integrations
 * proxy), so the OpenAI mock stubs `chat.completions.create`.
 *
 * Coverage:
 * - POST /api/ai-tts returns 401 when not authenticated
 * - POST /api/ai-tts returns 400 when text is missing or invalid
 * - POST /api/ai-tts returns audio/mpeg on a happy path (OpenAI mocked)
 * - POST /api/ai-tts forwards an optional voice parameter
 * - POST /api/ai-tts falls back to the next model when the first fails
 * - POST /api/ai-tts returns 500 when every model throws
 * - POST /api/ai-tts returns 503 when the AI key is absent
 * - POST /api/ai-tts returns 500 when the provider returns empty audio
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import { registerAiTtsRoutes } from "./ai-tts";

// ─── OpenAI mock (hoisted so the module-level import is covered) ─────────────
// Mocks chat.completions.create so the route exercises the Zod validation +
// gpt-audio synthesis path without touching any real OpenAI service.

const { mockChatCompletionsCreate, sampleAudioB64 } = vi.hoisted(() => {
  const sampleAudioB64 = Buffer.from("fake-mp3-audio-data").toString("base64");
  const mockChatCompletionsCreate = vi.fn().mockResolvedValue({
    choices: [{ message: { audio: { data: sampleAudioB64 } } }],
  });
  return { mockChatCompletionsCreate, sampleAudioB64 };
});

vi.mock("openai", () => {
  const create = mockChatCompletionsCreate;
  function OpenAI(this: any) {
    this.chat = { completions: { create } };
  }
  return { default: OpenAI };
});

// ─── Auth middleware stub ────────────────────────────────────────────────────

vi.mock("../middlewares/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    next();
  },
}));

// ─── Minimal Express app helper ──────────────────────────────────────────────
// req.log must be stubbed so the route's req.log calls don't throw when
// pino-http isn't wired in the test app.

function makeApp(userId?: string) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    if (userId) req.user = { id: userId, userType: "lab" };
    next();
  });
  const router = express.Router();
  registerAiTtsRoutes(router);
  app.use("/api", router);
  return app;
}

function audioResponse(b64: string) {
  return { choices: [{ message: { audio: { data: b64 } } }] };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("POST /api/ai-tts", () => {
  const savedKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

  beforeAll(() => {
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "test-key-for-tts";
  });

  afterAll(() => {
    if (savedKey === undefined) {
      delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    } else {
      process.env.AI_INTEGRATIONS_OPENAI_API_KEY = savedKey;
    }
  });

  it("returns 401 when not authenticated", async () => {
    const app = makeApp(undefined);
    const res = await request(app)
      .post("/api/ai-tts")
      .send({ text: "Hello world" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when text is missing", async () => {
    const app = makeApp("user-123");
    const res = await request(app).post("/api/ai-tts").send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 400 when text is an empty string", async () => {
    const app = makeApp("user-123");
    const res = await request(app).post("/api/ai-tts").send({ text: "" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns audio/mpeg binary on the happy path", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(audioResponse(sampleAudioB64));

    const app = makeApp("user-123");
    const res = await request(app)
      .post("/api/ai-tts")
      .send({ text: "Crown prep for upper right first molar." });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(res.body).toBeInstanceOf(Buffer);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("requests the gpt-audio model with the audio modality", async () => {
    mockChatCompletionsCreate.mockClear();
    mockChatCompletionsCreate.mockResolvedValueOnce(audioResponse(sampleAudioB64));

    const app = makeApp("user-123");
    const res = await request(app)
      .post("/api/ai-tts")
      .send({ text: "Default voice synthesis." });

    expect(res.status).toBe(200);
    const callArg = mockChatCompletionsCreate.mock.calls[0]![0];
    expect(callArg.model).toBe("gpt-audio");
    expect(callArg.modalities).toEqual(["text", "audio"]);
    expect(callArg.audio).toMatchObject({ format: "mp3", voice: "onyx" });
  });

  it("accepts an optional voice parameter and forwards it", async () => {
    mockChatCompletionsCreate.mockClear();
    mockChatCompletionsCreate.mockResolvedValueOnce(audioResponse(sampleAudioB64));

    const app = makeApp("user-123");
    const res = await request(app)
      .post("/api/ai-tts")
      .send({ text: "Shade A2, full contour zirconia.", voice: "nova" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(mockChatCompletionsCreate.mock.calls[0]![0].audio).toMatchObject({
      voice: "nova",
    });
  });

  it("falls back to the next model when the first model fails", async () => {
    mockChatCompletionsCreate.mockClear();
    mockChatCompletionsCreate
      .mockRejectedValueOnce(new Error("Model 'gpt-audio' is not supported."))
      .mockResolvedValueOnce(audioResponse(sampleAudioB64));

    const app = makeApp("user-123");
    const res = await request(app)
      .post("/api/ai-tts")
      .send({ text: "Fallback path synthesis." });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(mockChatCompletionsCreate.mock.calls[0]![0].model).toBe("gpt-audio");
    expect(mockChatCompletionsCreate.mock.calls[1]![0].model).toBe("gpt-audio-mini");
  });

  it("returns a structured, user-safe 500 when every model throws", async () => {
    mockChatCompletionsCreate.mockClear();
    mockChatCompletionsCreate
      .mockRejectedValueOnce(new Error("gpt-audio provider error"))
      .mockRejectedValueOnce(new Error("gpt-audio-mini provider error"));

    const app = makeApp("user-123");
    const res = await request(app)
      .post("/api/ai-tts")
      .send({ text: "This will trigger an API error." });

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/temporarily unavailable/i);
    // Never leak raw provider payloads or stack traces to the client.
    expect(JSON.stringify(res.body)).not.toMatch(/provider error|at Object|Error:/);
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(2);
  });

  it("returns 500 when the provider returns an empty audio buffer", async () => {
    mockChatCompletionsCreate.mockClear();
    mockChatCompletionsCreate
      .mockResolvedValueOnce(audioResponse(""))
      .mockResolvedValueOnce(audioResponse(""));

    const app = makeApp("user-123");
    const res = await request(app)
      .post("/api/ai-tts")
      .send({ text: "Silence is golden." });

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/no audio/i);
  });

  it("returns 503 when the AI key is absent", async () => {
    const key = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

    const app = makeApp("user-123");
    const res = await request(app)
      .post("/api/ai-tts")
      .send({ text: "Should be rejected at config check." });

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/not configured/i);

    process.env.AI_INTEGRATIONS_OPENAI_API_KEY = key;
  });
});
