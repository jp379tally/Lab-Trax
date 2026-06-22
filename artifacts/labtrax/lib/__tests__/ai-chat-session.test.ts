import { describe, it, expect, beforeEach, vi } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  STORAGE_KEY,
  SESSION_TTL_MS,
  sanitizeMessagesForStorage,
  loadChatSession,
  saveChatSession,
  clearChatSession,
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

describe("saveChatSession / loadChatSession", () => {
  it("round-trips persisted messages (without the welcome)", async () => {
    const msgs: Msg[] = [
      { id: "welcome", role: "assistant", content: "Hi!" },
      { id: "m1", role: "user", content: "Cases due today" },
      { id: "m2", role: "assistant", content: "Here they are." },
    ];
    await saveChatSession(msgs);
    const restored = await loadChatSession<Msg>();
    expect(restored).toHaveLength(2);
    expect(restored!.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("does not persist a welcome-only conversation", async () => {
    await saveChatSession<Msg>([{ id: "welcome", role: "assistant", content: "Hi!" }]);
    expect(await AsyncStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(await loadChatSession<Msg>()).toBeNull();
  });

  it("returns null when nothing is stored", async () => {
    expect(await loadChatSession<Msg>()).toBeNull();
  });

  it("drops and removes an expired session", async () => {
    const stale = {
      messages: [{ id: "m1", role: "user", content: "old" }],
      createdAt: Date.now() - SESSION_TTL_MS * 2,
      lastActive: Date.now() - SESSION_TTL_MS - 1000,
    };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(stale));
    expect(await loadChatSession<Msg>()).toBeNull();
    expect(await AsyncStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("preserves createdAt across updates but refreshes lastActive", async () => {
    await saveChatSession<Msg>([{ id: "m1", role: "user", content: "first" }]);
    const firstRaw = JSON.parse((await AsyncStorage.getItem(STORAGE_KEY))!);
    await new Promise((r) => setTimeout(r, 5));
    await saveChatSession<Msg>([
      { id: "m1", role: "user", content: "first" },
      { id: "m2", role: "assistant", content: "second" },
    ]);
    const secondRaw = JSON.parse((await AsyncStorage.getItem(STORAGE_KEY))!);
    expect(secondRaw.createdAt).toBe(firstRaw.createdAt);
    expect(secondRaw.lastActive).toBeGreaterThanOrEqual(firstRaw.lastActive);
    expect(secondRaw.messages).toHaveLength(2);
  });

  it("returns null and recovers when stored JSON is corrupt", async () => {
    await AsyncStorage.setItem(STORAGE_KEY, "{not json");
    expect(await loadChatSession<Msg>()).toBeNull();
  });

  it("keys sessions per user so accounts on one device don't mix", async () => {
    await saveChatSession<Msg>([{ id: "a1", role: "user", content: "alice" }], "alice");
    await saveChatSession<Msg>([{ id: "b1", role: "user", content: "bob" }], "bob");

    expect((await loadChatSession<Msg>("alice"))!.map((m) => m.id)).toEqual(["a1"]);
    expect((await loadChatSession<Msg>("bob"))!.map((m) => m.id)).toEqual(["b1"]);
    expect(await loadChatSession<Msg>("alice")).not.toBeNull();
    expect(await AsyncStorage.getItem(`${STORAGE_KEY}_alice`)).not.toBeNull();
  });

  it("clears only the targeted user's session", async () => {
    await saveChatSession<Msg>([{ id: "a1", role: "user", content: "alice" }], "alice");
    await saveChatSession<Msg>([{ id: "b1", role: "user", content: "bob" }], "bob");
    await clearChatSession("alice");
    expect(await loadChatSession<Msg>("alice")).toBeNull();
    expect(await loadChatSession<Msg>("bob")).not.toBeNull();
  });
});

describe("clearChatSession", () => {
  it("removes the stored session", async () => {
    await saveChatSession<Msg>([{ id: "m1", role: "user", content: "hi" }]);
    expect(await AsyncStorage.getItem(STORAGE_KEY)).not.toBeNull();
    await clearChatSession();
    expect(await AsyncStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
