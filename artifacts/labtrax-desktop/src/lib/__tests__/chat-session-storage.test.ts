import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  sanitizeMessagesForStorage,
  readStoredSessions,
  writeStoredSessions,
  STORAGE_KEY,
  SESSION_TTL_MS,
  type ChatMsg,
  type StoredSession,
} from "../chat-session-storage";

// ─── sanitizeMessagesForStorage ──────────────────────────────────────────────

describe("sanitizeMessagesForStorage", () => {
  it("strips the synthetic welcome message", () => {
    const msgs: ChatMsg[] = [
      { id: "welcome", role: "assistant", content: "Hi! I'm Maynard." },
      { id: "m1", role: "user", content: "Hello" },
    ];
    const result = sanitizeMessagesForStorage(msgs);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("m1");
  });

  it("returns an empty array when the only message is the welcome message", () => {
    const msgs: ChatMsg[] = [
      { id: "welcome", role: "assistant", content: "Hi!" },
    ];
    expect(sanitizeMessagesForStorage(msgs)).toEqual([]);
  });

  it("passes through a normal user message unchanged", () => {
    const msgs: ChatMsg[] = [
      { id: "u1", role: "user", content: "What cases are due today?" },
    ];
    const result = sanitizeMessagesForStorage(msgs);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(msgs[0]);
  });

  it("passes through a completed (done) proposedAction message unchanged", () => {
    const msg: ChatMsg = {
      id: "a1",
      role: "assistant",
      content: "Done",
      proposedAction: {
        actionId: "act-1",
        toolName: "markInvoicePaid",
        summary: "Mark invoice INV-001 as paid",
        state: "done",
        resultText: "Invoice marked paid.",
      },
    };
    const result = sanitizeMessagesForStorage([msg]);
    expect(result).toHaveLength(1);
    expect(result[0]!.proposedAction?.state).toBe("done");
  });

  it("passes through a rejected proposedAction message unchanged", () => {
    const msg: ChatMsg = {
      id: "a2",
      role: "assistant",
      proposedAction: {
        actionId: "act-2",
        toolName: "updateCaseStatus",
        summary: "Set case to shipped",
        state: "rejected",
      },
    };
    const result = sanitizeMessagesForStorage([msg]);
    expect(result[0]!.proposedAction?.state).toBe("rejected");
  });

  it("collapses a pending proposedAction to 'rejected'", () => {
    const msg: ChatMsg = {
      id: "a3",
      role: "assistant",
      proposedAction: {
        actionId: "act-3",
        toolName: "markInvoicePaid",
        summary: "Mark invoice INV-100 as paid",
        state: "pending",
        expiresAt: Date.now() + 60_000,
      },
    };
    const result = sanitizeMessagesForStorage([msg]);
    expect(result).toHaveLength(1);
    expect(result[0]!.proposedAction?.state).toBe("rejected");
  });

  it("sets expiresAt to a past timestamp when collapsing a pending action", () => {
    const before = Date.now();
    const msg: ChatMsg = {
      id: "a4",
      role: "assistant",
      proposedAction: {
        actionId: "act-4",
        toolName: "markInvoicePaid",
        summary: "Pay invoice",
        state: "pending",
        expiresAt: Date.now() + 60_000,
      },
    };
    const result = sanitizeMessagesForStorage([msg]);
    const expiresAt = result[0]!.proposedAction!.expiresAt!;
    expect(expiresAt).toBeLessThan(before + 1);
  });

  it("preserves all other fields on a collapsed pending message", () => {
    const msg: ChatMsg = {
      id: "a5",
      role: "assistant",
      content: "Proposed action",
      proposedAction: {
        actionId: "act-5",
        toolName: "doSomething",
        summary: "Do something important",
        state: "pending",
        expiresAt: Date.now() + 60_000,
      },
    };
    const result = sanitizeMessagesForStorage([msg]);
    const out = result[0]!;
    expect(out.id).toBe("a5");
    expect(out.content).toBe("Proposed action");
    expect(out.proposedAction!.actionId).toBe("act-5");
    expect(out.proposedAction!.toolName).toBe("doSomething");
    expect(out.proposedAction!.summary).toBe("Do something important");
    expect(out.proposedAction!.state).toBe("rejected");
  });

  it("collapses every pending message when there are multiple", () => {
    const msgs: ChatMsg[] = [
      {
        id: "p1",
        role: "assistant",
        proposedAction: {
          actionId: "a1",
          toolName: "t1",
          summary: "s1",
          state: "pending",
        },
      },
      {
        id: "p2",
        role: "assistant",
        proposedAction: {
          actionId: "a2",
          toolName: "t2",
          summary: "s2",
          state: "pending",
        },
      },
      { id: "u1", role: "user", content: "hello" },
    ];
    const result = sanitizeMessagesForStorage(msgs);
    const pendingStates = result
      .filter((m) => m.proposedAction)
      .map((m) => m.proposedAction!.state);
    expect(pendingStates).not.toContain("pending");
    expect(pendingStates.every((s) => s === "rejected")).toBe(true);
  });

  it("never writes a pending state — confirmed and done are passed through as-is", () => {
    const msgs: ChatMsg[] = [
      {
        id: "c1",
        role: "assistant",
        proposedAction: { actionId: "a", toolName: "t", summary: "s", state: "confirmed" },
      },
      {
        id: "d1",
        role: "assistant",
        proposedAction: {
          actionId: "b",
          toolName: "t",
          summary: "s",
          state: "done",
          resultText: "ok",
        },
      },
    ];
    const result = sanitizeMessagesForStorage(msgs);
    expect(result[0]!.proposedAction!.state).toBe("confirmed");
    expect(result[1]!.proposedAction!.state).toBe("done");
  });

  it("trims a large tool result down to label-only metadata", () => {
    const msg: ChatMsg = {
      id: "t1",
      role: "assistant",
      content: "Here is case 1234.",
      toolOutputs: [
        {
          name: "lookup_case",
          result: {
            found: true,
            case: {
              id: "abc",
              caseNumber: "1234",
              patientName: "Jane Doe",
              doctorName: "Dr. Smith",
              notes: "x".repeat(5000),
            },
          },
        },
      ],
    };
    const result = sanitizeMessagesForStorage([msg]);
    const out = result[0]!.toolOutputs![0]!;
    expect(out.name).toBe("lookup_case");
    expect(out.trimmed).toBe(true);
    expect(out.result).toEqual({ found: true, case: { caseNumber: "1234" } });
  });

  it("keeps invoiceNumber for a lookup_invoice tool output", () => {
    const msg: ChatMsg = {
      id: "t2",
      role: "assistant",
      toolOutputs: [
        {
          name: "lookup_invoice",
          result: {
            found: true,
            invoice: { id: "i1", invoiceNumber: "INV-9", lineItems: [1, 2, 3], total: 999 },
          },
        },
      ],
    };
    const out = sanitizeMessagesForStorage([msg])[0]!.toolOutputs![0]!;
    expect(out.trimmed).toBe(true);
    expect(out.result).toEqual({ found: true, invoice: { invoiceNumber: "INV-9" } });
  });

  it("trims a tool output with no recognizable identifiers to an empty result", () => {
    const msg: ChatMsg = {
      id: "t3",
      role: "assistant",
      toolOutputs: [
        { name: "monthly_sales_snapshot", result: { rows: [{ a: 1 }], totalCents: 12345 } },
      ],
    };
    const out = sanitizeMessagesForStorage([msg])[0]!.toolOutputs![0]!;
    expect(out.name).toBe("monthly_sales_snapshot");
    expect(out.trimmed).toBe(true);
    expect(out.result).toEqual({});
  });

  it("trims every tool output when a message has several", () => {
    const msg: ChatMsg = {
      id: "t4",
      role: "assistant",
      toolOutputs: [
        { name: "lookup_case", result: { found: true, case: { caseNumber: "1", extra: "drop" } } },
        { name: "lookup_invoice", result: { found: true, invoice: { invoiceNumber: "INV-2", extra: "drop" } } },
      ],
    };
    const outs = sanitizeMessagesForStorage([msg])[0]!.toolOutputs!;
    expect(outs.every((o) => o.trimmed)).toBe(true);
    expect(outs[0]!.result).toEqual({ found: true, case: { caseNumber: "1" } });
    expect(outs[1]!.result).toEqual({ found: true, invoice: { invoiceNumber: "INV-2" } });
  });

  it("is idempotent — re-sanitizing an already-trimmed message keeps the metadata", () => {
    const msg: ChatMsg = {
      id: "t5",
      role: "assistant",
      toolOutputs: [
        { name: "lookup_case", result: { found: true, case: { caseNumber: "1234", notes: "big" } } },
      ],
    };
    const once = sanitizeMessagesForStorage([msg]);
    const twice = sanitizeMessagesForStorage(once);
    expect(twice[0]!.toolOutputs![0]!.trimmed).toBe(true);
    expect(twice[0]!.toolOutputs![0]!.result).toEqual({ found: true, case: { caseNumber: "1234" } });
  });

  it("does not mutate the original toolOutputs results", () => {
    const originalResult = { found: true, case: { caseNumber: "1234", notes: "keep" } };
    const msg: ChatMsg = {
      id: "t6",
      role: "assistant",
      toolOutputs: [{ name: "lookup_case", result: originalResult }],
    };
    sanitizeMessagesForStorage([msg]);
    expect(originalResult.case.notes).toBe("keep");
    expect(msg.toolOutputs![0]!.trimmed).toBeUndefined();
  });

  it("does not mutate the original messages array", () => {
    const original: ChatMsg = {
      id: "x1",
      role: "assistant",
      proposedAction: {
        actionId: "ax",
        toolName: "tx",
        summary: "sx",
        state: "pending",
      },
    };
    const msgs = [original];
    sanitizeMessagesForStorage(msgs);
    expect(original.proposedAction!.state).toBe("pending");
  });
});

// ─── readStoredSessions / writeStoredSessions ────────────────────────────────

describe("readStoredSessions / writeStoredSessions round-trip", () => {
  const _origLocalStorage = global.localStorage;

  let store: Record<string, string> = {};
  const mockLocalStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };

  beforeEach(() => {
    store = {};
    Object.defineProperty(global, "localStorage", {
      value: mockLocalStorage,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(global, "localStorage", {
      value: _origLocalStorage,
      configurable: true,
      writable: true,
    });
  });

  it("returns an empty array when localStorage has no entry", () => {
    expect(readStoredSessions()).toEqual([]);
  });

  it("returns an empty array when the stored JSON is malformed", () => {
    store[STORAGE_KEY] = "not-valid-json{{";
    expect(readStoredSessions()).toEqual([]);
  });

  it("round-trips a session correctly", () => {
    const session: StoredSession = {
      id: "sess-1",
      key: "general",
      pinnedCases: [],
      messages: [{ id: "u1", role: "user", content: "Hello" }],
      createdAt: Date.now(),
      lastActive: Date.now(),
    };
    writeStoredSessions([session]);
    const restored = readStoredSessions();
    expect(restored).toHaveLength(1);
    expect(restored[0]!.id).toBe("sess-1");
    expect(restored[0]!.messages).toHaveLength(1);
    expect(restored[0]!.messages[0]!.content).toBe("Hello");
  });

  it("filters out sessions whose lastActive exceeds the TTL", () => {
    const old = Date.now() - SESSION_TTL_MS - 1000;
    const sessions: StoredSession[] = [
      {
        id: "old",
        key: "general",
        pinnedCases: [],
        messages: [{ id: "m1", role: "user", content: "old" }],
        createdAt: old,
        lastActive: old,
      },
      {
        id: "fresh",
        key: "general",
        pinnedCases: [],
        messages: [{ id: "m2", role: "user", content: "fresh" }],
        createdAt: Date.now(),
        lastActive: Date.now(),
      },
    ];
    writeStoredSessions(sessions);
    const restored = readStoredSessions();
    expect(restored).toHaveLength(1);
    expect(restored[0]!.id).toBe("fresh");
  });

  it("stores the sessions under the canonical STORAGE_KEY", () => {
    const session: StoredSession = {
      id: "s1",
      key: "k",
      pinnedCases: [],
      messages: [],
      createdAt: Date.now(),
      lastActive: Date.now(),
    };
    writeStoredSessions([session]);
    expect(store[STORAGE_KEY]).toBeDefined();
    const parsed = JSON.parse(store[STORAGE_KEY]!);
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(parsed.sessions[0].id).toBe("s1");
  });
});
