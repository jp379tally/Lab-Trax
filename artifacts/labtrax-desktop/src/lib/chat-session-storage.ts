import type { AiCaseContext } from "@/lib/ai-panel-context";

// ─── Message types (shared with AiChatPanel) ────────────────────────────────

export interface ToolOutput {
  name: string;
  result: unknown;
  /**
   * Set on persisted messages whose result was reduced to label-only metadata
   * (see `trimToolOutputForStorage`). Trimmed outputs still render the
   * "Looked up: …" label but have no expandable raw-JSON detail on restore.
   */
  trimmed?: boolean;
}

export interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content?: string;
  toolOutputs?: ToolOutput[];
  /** IDs of the curated knowledge sections included in the prompt for this reply. Admin-only audit field. */
  knowledgeSectionIds?: string[];
  /** Whether the retention legal disclaimer was injected into the prompt. Admin-only audit field. */
  retentionDisclaimer?: boolean;
  /** Whether the HIPAA/compliance disclaimer was injected into the prompt. Admin-only audit field. */
  privacyDisclaimer?: boolean;
  /** Structured disclaimer text returned by the API for retention-related queries.
   *  Rendered as an amber callout independent of whether the model echoes it. */
  disclaimer?: string;
  proposedAction?: {
    actionId: string;
    toolName: string;
    summary: string;
    state: "pending" | "confirmed" | "done" | "rejected";
    resultText?: string;
    error?: string;
    expiresAt?: number;
  };
}

export interface StoredSession {
  id: string;
  key: string;
  pinnedCases: AiCaseContext[];
  messages: ChatMsg[];
  createdAt: number;
  lastActive: number;
}

// ─── Storage constants ───────────────────────────────────────────────────────

export const STORAGE_KEY = "labtrax_chat_sessions_v1";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_SESSIONS_PER_KEY = 10;

// ─── Storage helpers ─────────────────────────────────────────────────────────

export function readStoredSessions(): StoredSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const now = Date.now();
    return (parsed.sessions ?? []).filter(
      (s: StoredSession) => now - s.lastActive < SESSION_TTL_MS,
    );
  } catch {
    return [];
  }
}

export function writeStoredSessions(sessions: StoredSession[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessions }));
  } catch {
    // ignore
  }
}

// ─── Message sanitization ────────────────────────────────────────────────────

/**
 * Reduce a tool output to the minimal metadata needed to render its
 * "Looked up: …" label (see `extractToolLabel` in AiChatPanel).
 *
 * Tool result payloads can be large (entire case/invoice objects with full
 * timelines). Persisting them verbatim bloats stored sessions, slows
 * localStorage reads, and can hit the storage quota. We only keep the few
 * identifier fields the label needs (`found`, `case.caseNumber`,
 * `invoice.invoiceNumber`) and drop the rest, flagging the output as `trimmed`
 * so the UI knows there is no raw-JSON detail to expand on restore.
 */
function trimToolOutputForStorage(output: ToolOutput): ToolOutput {
  if (output.trimmed) return output;
  const r = (output.result ?? {}) as Record<string, unknown>;
  const minimal: Record<string, unknown> = {};
  if (typeof r.found === "boolean") minimal.found = r.found;
  if (r.case && typeof r.case === "object") {
    const caseNumber = (r.case as Record<string, unknown>).caseNumber;
    if (typeof caseNumber === "string") minimal.case = { caseNumber };
  }
  if (r.invoice && typeof r.invoice === "object") {
    const invoiceNumber = (r.invoice as Record<string, unknown>).invoiceNumber;
    if (typeof invoiceNumber === "string") minimal.invoice = { invoiceNumber };
  }
  return { name: output.name, result: minimal, trimmed: true };
}

/**
 * Prepare messages for localStorage persistence.
 *
 * - Strips the synthetic "welcome" message (it is rebuilt on restore).
 * - Trims tool outputs to label-only metadata so the full result JSON does not
 *   bloat stored sessions (see `trimToolOutputForStorage`).
 * - Collapses any proposedAction whose state is still "pending" to "rejected"
 *   so that restored sessions never show an interactive confirmation card for
 *   an action whose server-side TTL has already expired.
 */
export function sanitizeMessagesForStorage(msgs: ChatMsg[]): ChatMsg[] {
  return msgs
    .filter((m) => m.id !== "welcome")
    .map((m) => {
      let next = m;
      if (m.toolOutputs && m.toolOutputs.length > 0) {
        next = { ...next, toolOutputs: m.toolOutputs.map(trimToolOutputForStorage) };
      }
      if (next.proposedAction?.state === "pending") {
        const now = Date.now();
        next = {
          ...next,
          proposedAction: {
            ...next.proposedAction,
            state: "rejected" as const,
            expiresAt: now - 1,
          },
        };
      }
      return next;
    });
}
