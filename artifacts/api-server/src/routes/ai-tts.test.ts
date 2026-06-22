/**
 * Tests for the text-to-speech synthesis endpoint.
 *
 * Coverage:
 * - POST /api/ai-tts returns 401 when not authenticated
 * - POST /api/ai-tts returns 400 when text is missing or invalid
 * - POST /api/ai-tts returns audio/mpeg on a happy path (OpenAI mocked)
 * - POST /api/ai-tts returns 500 when the OpenAI TTS API throws
 * - POST /api/ai-tts returns 503 when the AI key is absent
 * - POST /api/ai-tts returns 500 when OpenAI returns an empty audio buffer
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import { registerAiTtsRoutes } from "./ai-tts";

// ─── OpenAI mock (hoisted so the module-level import is covered) ─────────────
// Mocks audio.speech.create so the route exercises the Zod validation + TTS
// code path without touching any real OpenAI service.

const { mockSpeechCreate } = vi.hoisted(() => {
  const fakeAudioBuffer = Buffer.from("fake-mp3-audio-data");
  const mockSpeechCreate = vi.fn().mockResolvedValue({
    arrayBuffer: async () => fakeAudioBuffer.buffer,
  });
  return { mockSpeechCreate };
});

vi.mock("openai", () => {
  const create = mockSpeechCreate;
  function OpenAI(this: any) {
    this.audio = { speech: { create } };
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
// req.log must be stubbed so the route's req.log.error calls don't throw when
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
    const fakeBuffer = Buffer.from("mp3-audio-bytes");
    mockSpeechCreate.mockResolvedValueOnce({
      arrayBuffer: async () => fakeBuffer.buffer,
    });

    const app = makeApp("user-123");
    const res = await request(app)
      .post("/api/ai-tts")
      .send({ text: "Crown prep for upper right first molar." });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(res.body).toBeInstanceOf(Buffer);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("accepts an optional voice parameter and still returns audio", async () => {
    const fakeBuffer = Buffer.from("mp3-with-voice");
    mockSpeechCreate.mockResolvedValueOnce({
      arrayBuffer: async () => fakeBuffer.buffer,
    });

    const app = makeApp("user-123");
    const res = await request(app)
      .post("/api/ai-tts")
      .send({ text: "Shade A2, full contour zirconia.", voice: "nova" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(mockSpeechCreate).toHaveBeenCalledWith(
      expect.objectContaining({ voice: "nova" }),
    );
  });

  it("returns 500 with a structured error when the OpenAI TTS API throws", async () => {
    mockSpeechCreate.mockRejectedValueOnce(new Error("TTS service unavailable"));

    const app = makeApp("user-123");
    const res = await request(app)
      .post("/api/ai-tts")
      .send({ text: "This will trigger an API error." });

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/tts synthesis failed/i);
  });

  it("returns 500 when OpenAI returns an empty audio buffer", async () => {
    mockSpeechCreate.mockResolvedValueOnce({
      arrayBuffer: async () => new ArrayBuffer(0),
    });

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
