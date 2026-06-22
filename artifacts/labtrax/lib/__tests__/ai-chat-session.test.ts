import { describe, it, expect, beforeEach, vi } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  SESSION_TTL_MS,
  MAX_SESSIONS,
  sanitizeMessagesForStorage,
  loadChatSessions,
  saveChatSession,
  deleteChatSession,
  clearChatSessions,
  generateSessionId,
  type PersistableMessage,
} from "@/lib/ai-chat-session";

interface Msg extends PersistableMessage {
  role: "user" | "assistant";
  content: string;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  vi.restoreAllMocks();
});

describe("sanitizeMessagesForStorage", () => {
  it("strips the welcome message", () => {
    const msgs: Msg[] = [
      { id: "welcome", role: "assistant", content: "Hi!" },
      { id: "m1", role: "user", content: "Cases due today" },
    ];
    const out = sanitizeMessagesForStorage(msgs);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("m1");
  });

  it("collapses a pending proposed action to rejected", () => {
    const msgs: Msg[] = [
      {
        id: "m1",
        role: "assistant",
        content: "",
        proposedAction: { state: "pending", expiresAt: Date.now() + 10000 },
      },
    ];
    const out = sanitizeMessagesForStorage(msgs);
    expect(out[0]!.proposedAction!.state).toBe("rejected");
    expect(out[0]!.proposedAction!.expiresAt).toBeLessThan(Date.now());
  });

  it("leaves resolved proposed actions untouched", () => {
    const msgs: Msg[] = [
      { id: "m1", role: "assistant", content: "", proposedAction: { state: "done" } },
    ];
    const out = sanitizeMessagesForStorage(msgs);
    expect(out[0]!.proposedAction!.state).toBe("done");
  });
});

describe("generateSessionId", () => {
  it("produces distinct ids", () => {
    expect(generateSessionId()).not.toBe(generateSessionId());
  });
});

describe("saveChatSession / loadChatSessions", () => {
  it("round-trips persisted messages (without the welcome)", async () => {
    const msgs: Msg[] = [
      { id: "welcome", role: "assistant", content: "Hi!" },
      { id: "m1", role: "user", content: "Cases due today" },
      { id: "m2", role: "assistant", content: "Here they are." },
    ];
    await saveChatSession(msgs, "s1");
    const sessions = await loadChatSessions<Msg>();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("does not persist a welcome-only conversation", async () => {
    await saveChatSession<Msg>([{ id: "welcome", role: "assistant", content: "Hi!" }], "s1");
    expect(await AsyncStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(await loadChatSessions<Msg>()).toEqual([]);
  });

  it("returns [] when nothing is stored", async () => {
    expect(await loadChatSessions<Msg>()).toEqual([]);
  });

  it("keeps multiple sessions and orders them newest-first", async () => {
    await saveChatSession<Msg>([{ id: "a1", role: "user", content: "first chat" }], "s1");
    await new Promise((r) => setTimeout(r, 5));
    await saveChatSession<Msg>([{ id: "b1", role: "user", content: "second chat" }], "s2");
    const sessions = await loadChatSessions<Msg>();
    expect(sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("updates an existing session in place rather than duplicating it", async () => {
    await saveChatSession<Msg>([{ id: "a1", role: "user", content: "hi" }], "s1");
    await saveChatSession<Msg>(
      [
        { id: "a1", role: "user", content: "hi" },
        { id: "a2", role: "assistant", content: "hello" },
      ],
      "s1",
    );
    const sessions = await loadChatSessions<Msg>();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.messages).toHaveLength(2);
  });

  it(`caps stored sessions at MAX_SESSIONS (${MAX_SESSIONS}) dropping the oldest`, async () => {
    for (let i = 0; i < MAX_SESSIONS + 3; i++) {
      await saveChatSession<Msg>([{ id: `m${i}`, role: "user", content: `chat ${i}` }], `s${i}`);
      await new Promise((r) => setTimeout(r, 2));
    }
    const sessions = await loadChatSessions<Msg>();
    expect(sessions).toHaveLength(MAX_SESSIONS);
    // Newest (highest index) should be present; the oldest should be gone.
    expect(sessions[0]!.id).toBe(`s${MAX_SESSIONS + 2}`);
    expect(sessions.some((s) => s.id === "s0")).toBe(false);
  });

  it("drops and removes expired sessions on read", async () => {
    const stale = {
      sessions: [
        {
          id: "old",
          messages: [{ id: "m1", role: "user", content: "old" }],
          createdAt: Date.now() - SESSION_TTL_MS * 2,
          lastActive: Date.now() - SESSION_TTL_MS - 1000,
        },
      ],
    };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(stale));
    expect(await loadChatSessions<Msg>()).toEqual([]);
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    expect(JSON.parse(raw!).sessions).toEqual([]);
  });

  it("preserves createdAt across updates but refreshes lastActive", async () => {
    await saveChatSession<Msg>([{ id: "m1", role: "user", content: "first" }], "s1");
    const first = (await loadChatSessions<Msg>())[0]!;
    await new Promise((r) => setTimeout(r, 5));
    await saveChatSession<Msg>(
      [
        { id: "m1", role: "user", content: "first" },
        { id: "m2", role: "assistant", content: "second" },
      ],
      "s1",
    );
    const second = (await loadChatSessions<Msg>())[0]!;
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.lastActive).toBeGreaterThanOrEqual(first.lastActive);
    expect(second.messages).toHaveLength(2);
  });

  it("returns [] and recovers when stored JSON is corrupt", async () => {
    await AsyncStorage.setItem(STORAGE_KEY, "{not json");
    expect(await loadChatSessions<Msg>()).toEqual([]);
  });

  it("keys sessions per user so accounts on one device don't mix", async () => {
    await saveChatSession<Msg>([{ id: "a1", role: "user", content: "alice" }], "s1", "alice");
    await saveChatSession<Msg>([{ id: "b1", role: "user", content: "bob" }], "s1", "bob");

    const alice = await loadChatSessions<Msg>("alice");
    const bob = await loadChatSessions<Msg>("bob");
    expect(alice.flatMap((s) => s.messages.map((m) => m.id))).toEqual(["a1"]);
    expect(bob.flatMap((s) => s.messages.map((m) => m.id))).toEqual(["b1"]);
    expect(await AsyncStorage.getItem(`${STORAGE_KEY}_alice`)).not.toBeNull();
  });

  it("migrates a legacy single session into the list and removes the legacy key", async () => {
    const legacy = {
      messages: [{ id: "old1", role: "user", content: "legacy chat" }],
      createdAt: Date.now() - 1000,
      lastActive: Date.now() - 500,
    };
    await AsyncStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(legacy));
    const sessions = await loadChatSessions<Msg>();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.messages.map((m) => m.id)).toEqual(["old1"]);
    expect(await AsyncStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });
});

describe("deleteChatSession", () => {
  it("removes only the targeted session", async () => {
    await saveChatSession<Msg>([{ id: "a1", role: "user", content: "a" }], "s1");
    await saveChatSession<Msg>([{ id: "b1", role: "user", content: "b" }], "s2");
    const remaining = await deleteChatSession<Msg>("s1");
    expect(remaining.map((s) => s.id)).toEqual(["s2"]);
    expect((await loadChatSessions<Msg>()).map((s) => s.id)).toEqual(["s2"]);
  });
});

describe("clearChatSessions", () => {
  it("removes all sessions and any legacy entry for the user", async () => {
    await saveChatSession<Msg>([{ id: "a1", role: "user", content: "a" }], "s1", "alice");
    await AsyncStorage.setItem(`${LEGACY_STORAGE_KEY}_alice`, JSON.stringify({ messages: [] }));
    await clearChatSessions("alice");
    expect(await loadChatSessions<Msg>("alice")).toEqual([]);
    expect(await AsyncStorage.getItem(`${LEGACY_STORAGE_KEY}_alice`)).toBeNull();
  });
});
