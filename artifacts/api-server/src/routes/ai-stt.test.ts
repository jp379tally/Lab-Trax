/**
 * End-to-end tests for the Whisper STT endpoint.
 *
 * Coverage:
 * - POST /api/ai-stt rejects unauthenticated requests (401)
 * - POST /api/ai-stt rejects requests with no audio file (400)
 * - POST /api/ai-stt returns { ok: true, transcript } on a happy-path multipart POST
 * - POST /api/ai-stt returns a structured 500 when the Whisper API fails
 * - POST /api/ai-stt returns 503 when AI is not configured
 * - POST /api/ai-stt returns { ok: true, transcript: '' } when Whisper returns empty text
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import { registerAiSttRoutes } from "./ai-stt";

// ─── OpenAI mock (hoisted so the module-level singleton is initialised with it)
// Mocks audio.transcriptions.create so the route exercises the multer + Whisper
// code path without touching any real OpenAI service.

const { mockTranscriptionsCreate, mockToFile } = vi.hoisted(() => {
  const mockTranscriptionsCreate = vi.fn().mockResolvedValue({
    text: "Hello, this is a test transcript.",
  });
  const mockToFile = vi.fn().mockImplementation(
    async (buf: Buffer, name: string, opts: unknown) => ({ buf, name, opts }),
  );
  return { mockTranscriptionsCreate, mockToFile };
});

vi.mock("openai", () => {
  const create = mockTranscriptionsCreate;
  function OpenAI(this: any) {
    this.audio = { transcriptions: { create } };
  }
  return { default: OpenAI };
});

vi.mock("openai/uploads", () => ({
  toFile: mockToFile,
}));

// ─── Auth middleware stub ────────────────────────────────────────────────────

vi.mock("../middlewares/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    next();
  },
}));

// ─── Minimal Express app helper ──────────────────────────────────────────────
// req.log must be stubbed so the route's req.log.warn / req.log.error calls
// don't throw when pino-http isn't wired in the test app.

function makeApp(userId?: string) {
  const app = express();
  app.use((req: any, _res, next) => {
    req.log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    if (userId) req.user = { id: userId, userType: "lab" };
    next();
  });
  const router = express.Router();
  registerAiSttRoutes(router);
  app.use("/api", router);
  return app;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("POST /api/ai-stt", () => {
  const savedKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

  beforeAll(() => {
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "test-key-for-stt";
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
      .post("/api/ai-stt")
      .attach("audio", Buffer.from("fake audio data"), {
        filename: "audio.webm",
        contentType: "audio/webm",
      });
    expect(res.status).toBe(401);
  });

  it("returns 400 when no audio file is provided", async () => {
    const app = makeApp("user-123");
    // Plain POST without any multipart body — multer skips processing and
    // req.file stays undefined, triggering the 400 guard in the route.
    const res = await request(app).post("/api/ai-stt");
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/no audio file/i);
  });

  it("returns { ok: true, transcript } on a happy-path multipart POST", async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({
      text: "Incisor crown, porcelain fused to metal.",
    });

    const app = makeApp("user-123");
    const res = await request(app)
      .post("/api/ai-stt")
      .attach("audio", Buffer.from("fake audio content"), {
        filename: "recording.webm",
        contentType: "audio/webm",
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.transcript).toBe("Incisor crown, porcelain fused to metal.");
  });

  it("returns 500 with structured error when the Whisper API fails", async () => {
    mockTranscriptionsCreate.mockRejectedValueOnce(
      new Error("Whisper service unavailable"),
    );

    const app = makeApp("user-123");
    const res = await request(app)
      .post("/api/ai-stt")
      .attach("audio", Buffer.from("bad audio data"), {
        filename: "broken.webm",
        contentType: "audio/webm",
      });

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/transcription failed/i);
  });

  it("returns 503 when AI is not configured", async () => {
    const key = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

    vi.resetModules();
    const { registerAiSttRoutes: freshRegister } = await import("./ai-stt");
    const app = express();
    app.use((req: any, _res, next) => {
      req.log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      req.user = { id: "user-123", userType: "lab" };
      next();
    });
    const router = express.Router();
    freshRegister(router);
    app.use("/api", router);

    const res = await request(app)
      .post("/api/ai-stt")
      .attach("audio", Buffer.from("audio"), {
        filename: "audio.webm",
        contentType: "audio/webm",
      });

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);

    process.env.AI_INTEGRATIONS_OPENAI_API_KEY = key;
  });

  it("returns { ok: true, transcript: '' } when Whisper returns empty text", async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: "   " });

    const app = makeApp("user-123");
    const res = await request(app)
      .post("/api/ai-stt")
      .attach("audio", Buffer.from("silence"), {
        filename: "silence.webm",
        contentType: "audio/webm",
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.transcript).toBe("");
  });
});
