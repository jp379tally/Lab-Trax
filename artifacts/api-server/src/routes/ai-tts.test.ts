/**
 * Tests for POST /ai-tts — voice-picker validation gate.
 *
 * Coverage:
 *  - 400 when an unrecognised voice ID is supplied (gate fires before OpenAI)
 *  - 400 when the text body is missing
 *  - 200 (synthesis path reached) when a valid voice ID is supplied ("coral")
 *  - 200 (synthesis path reached) when no voice is supplied (uses default)
 *  - every voice ID in the catalogue is accepted
 *
 * The OpenAI SDK is fully mocked so no live network call is made.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import bodyParser from "body-parser";
import { registerAiTtsRoutes } from "./ai-tts";
import { TTS_VOICE_IDS, TTS_VOICES } from "./ai-tts-voices";

// ── Auth middleware stub ──────────────────────────────────────────────────────

vi.mock("../middlewares/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    next();
  },
}));

// ── OpenAI client mock ────────────────────────────────────────────────────────

const mockCompletionsCreate = vi.hoisted(() => vi.fn());

vi.mock("../lib/ai-openai-client", () => ({
  createOpenAIClient: () => ({
    chat: {
      completions: {
        create: (...args: any[]) => mockCompletionsCreate(...args),
      },
    },
  }),
}));

// ── Minimal Express app ───────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(bodyParser.json());

  // Always supply a user so requireAuth passes.
  app.use((req: any, _res: any, next: any) => {
    req.user = { id: "user-tts-test", userType: "lab" };
    req.log = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    next();
  });

  const router = express.Router();
  registerAiTtsRoutes(router);
  app.use("/api", router);
  return app;
}

// Minimal successful audio completion payload.
function audioSuccess() {
  return {
    choices: [
      {
        message: {
          audio: {
            data: Buffer.from("fake-audio-bytes").toString("base64"),
          },
        },
      },
    ],
  };
}

describe("POST /api/ai-tts — voice validation", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = makeApp();
  });

  // ── Invalid voice IDs must be rejected before OpenAI is called ──────────────

  it("returns 400 for an unrecognised voice ID without calling OpenAI", async () => {
    const res = await request(app)
      .post("/api/ai-tts")
      .send({ text: "Hello world", voice: "hal-9000" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false });
    // Synthesis path must never have been reached.
    expect(mockCompletionsCreate).not.toHaveBeenCalled();
  });

  it("returns 400 for another unrecognised voice ID without calling OpenAI", async () => {
    const res = await request(app)
      .post("/api/ai-tts")
      .send({ text: "Hello world", voice: "invalid_voice_xyz" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false });
    expect(mockCompletionsCreate).not.toHaveBeenCalled();
  });

  // ── Missing / empty text is also rejected before OpenAI is called ───────────

  it("returns 400 when the text field is missing", async () => {
    const res = await request(app)
      .post("/api/ai-tts")
      .send({ voice: "coral" });

    expect(res.status).toBe(400);
    expect(mockCompletionsCreate).not.toHaveBeenCalled();
  });

  // ── Valid voice IDs pass through to the synthesis path ───────────────────────

  it("accepts voice='coral' and reaches the synthesis path", async () => {
    mockCompletionsCreate.mockResolvedValueOnce(audioSuccess());

    const res = await request(app)
      .post("/api/ai-tts")
      .send({ text: "Hello world", voice: "coral" });

    // OpenAI must have been called with the correct voice.
    expect(mockCompletionsCreate).toHaveBeenCalledOnce();
    const callArgs = mockCompletionsCreate.mock.calls[0][0] as any;
    expect(callArgs.audio.voice).toBe("coral");

    // Response is synthesised audio.
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/mpeg/);
  });

  it("accepts a request with no voice (uses default) and reaches the synthesis path", async () => {
    mockCompletionsCreate.mockResolvedValueOnce(audioSuccess());

    const res = await request(app)
      .post("/api/ai-tts")
      .send({ text: "Default voice test" });

    expect(mockCompletionsCreate).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/mpeg/);
  });

  it("accepts every voice ID in the catalogue", async () => {
    for (const voice of TTS_VOICE_IDS) {
      mockCompletionsCreate.mockResolvedValueOnce(audioSuccess());

      const res = await request(app)
        .post("/api/ai-tts")
        .send({ text: "Testing", voice });

      expect(res.status).toBe(200);
    }
    // All voices reached OpenAI.
    expect(mockCompletionsCreate).toHaveBeenCalledTimes(TTS_VOICE_IDS.length);
  });
});

// ── TTS_VOICE_IDS / TTS_VOICES parity ────────────────────────────────────────

describe("TTS_VOICE_IDS and TTS_VOICES parity", () => {
  it("TTS_VOICES has an entry for every ID in TTS_VOICE_IDS", () => {
    const voiceEntryIds = TTS_VOICES.map((v) => v.value);
    for (const id of TTS_VOICE_IDS) {
      expect(voiceEntryIds, `TTS_VOICES is missing an entry for "${id}"`).toContain(id);
    }
  });

  it("TTS_VOICE_IDS contains the value of every entry in TTS_VOICES", () => {
    for (const entry of TTS_VOICES) {
      expect(
        TTS_VOICE_IDS as readonly string[],
        `TTS_VOICE_IDS is missing "${entry.value}" which appears in TTS_VOICES`,
      ).toContain(entry.value);
    }
  });

  it("TTS_VOICES and TTS_VOICE_IDS have the same length (no duplicates or extras)", () => {
    expect(TTS_VOICES).toHaveLength(TTS_VOICE_IDS.length);
  });
});
