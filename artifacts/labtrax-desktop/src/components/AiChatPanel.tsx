import { useEffect, useRef, useState, useCallback } from "react";
import { getToolCallLabel } from "@workspace/api-client-react";
import { apiFetch, getAccessToken, apiUrl } from "@/lib/api";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Loader2,
  Mic,
  MicOff,
  PenSquare,
  Plus,
  Printer,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import type { AiCaseContext } from "@/lib/ai-panel-context";
import {
  type ChatMsg,
  type StoredSession,
  STORAGE_KEY,
  SESSION_TTL_MS,
  MAX_SESSIONS_PER_KEY,
  readStoredSessions,
  writeStoredSessions,
  sanitizeMessagesForStorage,
} from "@/lib/chat-session-storage";

// ─── Waveform animation ──────────────────────────────────────────────────────

if (typeof document !== "undefined") {
  const WAVEFORM_STYLE_ID = "labtrax-waveform-anim";
  if (!document.getElementById(WAVEFORM_STYLE_ID)) {
    const s = document.createElement("style");
    s.id = WAVEFORM_STYLE_ID;
    s.textContent = `
      @keyframes wf-bar {
        0%, 100% { transform: scaleY(0.25); }
        50%       { transform: scaleY(1);    }
      }
    `;
    document.head.appendChild(s);
  }
}

/**
 * Animated 4-bar waveform using CSS keyframes + scaleY. Inherits `currentColor`
 * from the parent so it adapts to any button colour scheme.
 */
function VoiceWaveform() {
  const delays = ["0s", "0.15s", "0.075s", "0.225s"];
  return (
    <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden="true">
      {delays.map((delay, i) => (
        <rect
          key={i}
          x={i * 5}
          y={0}
          width={3}
          height={14}
          rx={1.5}
          fill="currentColor"
          style={{
            transformBox: "fill-box" as React.CSSProperties["transformBox"],
            transformOrigin: "center",
            animation: `wf-bar 0.8s ease-in-out ${delay} infinite`,
          }}
        />
      ))}
    </svg>
  );
}

// ─── Case history ────────────────────────────────────────────────────────────

interface CaseHistoryData {
  found: boolean;
  case?: {
    id: string;
    caseNumber: string;
    patientName: string;
    doctorName: string;
    status: string;
    priority: string;
    dueDate: string | null;
    receivedAt: string | null;
    createdAt: string | null;
    remakeOf: string | null;
    remakeReason: string | null;
    remakeCharged: boolean | null;
  };
  timeline?: Array<{
    timestamp: string;
    kind: "event" | "note";
    eventType?: string;
    actor: string;
    summary: string;
  }>;
}

// ─── Case history print helper ───────────────────────────────────────────────

function printCaseHistory(data: CaseHistoryData): void {
  if (!data.found || !data.case) return;
  const c = data.case;
  const timeline = data.timeline ?? [];

  const formatDate = (iso: string | null | undefined): string => {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  const rows = timeline
    .map(
      (t) => `
      <tr>
        <td>${formatDate(t.timestamp)}</td>
        <td>${t.actor}</td>
        <td>${t.kind === "note" ? "Note" : t.eventType?.replace(/_/g, " ") ?? "Event"}</td>
        <td>${t.summary.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</td>
      </tr>`,
    )
    .join("");

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>Case History — ${c.caseNumber}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 12px; margin: 24px; color: #111; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  .meta { font-size: 11px; color: #555; margin-bottom: 16px; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; margin-bottom: 20px; border: 1px solid #ddd; padding: 12px; border-radius: 4px; background: #fafafa; }
  .info-item { display: flex; flex-direction: column; }
  .info-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #888; }
  .info-value { font-size: 12px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { background: #f0f0f0; text-align: left; padding: 6px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; border: 1px solid #ddd; }
  td { padding: 5px 8px; border: 1px solid #ddd; vertical-align: top; font-size: 11px; }
  tr:nth-child(even) td { background: #fafafa; }
  .remake-banner { background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; padding: 8px 12px; margin-bottom: 16px; font-size: 11px; }
  @media print { body { margin: 8px; } }
</style>
</head>
<body>
<h1>Case History Report</h1>
<div class="meta">Printed ${new Date().toLocaleString()}</div>
${c.remakeOf ? `<div class="remake-banner">⚠ This case is a remake of case <strong>${c.remakeOf}</strong>${c.remakeReason ? ` — Reason: ${c.remakeReason}` : ""}${c.remakeCharged != null ? ` · Charged: ${c.remakeCharged ? "Yes" : "No"}` : ""}</div>` : ""}
<div class="info-grid">
  <div class="info-item"><span class="info-label">Case #</span><span class="info-value">${c.caseNumber}</span></div>
  <div class="info-item"><span class="info-label">Status</span><span class="info-value">${c.status}</span></div>
  <div class="info-item"><span class="info-label">Patient</span><span class="info-value">${c.patientName}</span></div>
  <div class="info-item"><span class="info-label">Doctor</span><span class="info-value">${c.doctorName}</span></div>
  <div class="info-item"><span class="info-label">Due Date</span><span class="info-value">${formatDate(c.dueDate)}</span></div>
  <div class="info-item"><span class="info-label">Received</span><span class="info-value">${formatDate(c.receivedAt ?? c.createdAt)}</span></div>
</div>
<h2 style="font-size:14px; margin-bottom:6px;">Timeline (${timeline.length} entries)</h2>
<table>
  <thead><tr><th>Date/Time</th><th>Actor</th><th>Type</th><th>Details</th></tr></thead>
  <tbody>${rows || "<tr><td colspan='4' style='text-align:center;color:#888'>No events recorded</td></tr>"}</tbody>
</table>
</body>
</html>`;

  const win = window.open("", "_blank", "width=900,height=700");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 400);
}

interface CaseSearchResult {
  id: string;
  caseNumber: string;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  doctorName?: string | null;
  status?: string | null;
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function getSessionPreview(session: StoredSession): string {
  const first = session.messages.find((m) => m.role === "user");
  if (!first) {
    if (session.pinnedCases.length > 0) {
      return `Cases: ${session.pinnedCases.map((c) => c.caseNumber).join(", ")}`;
    }
    return "Empty session";
  }
  const text = first.content ?? "";
  return text.length > 60 ? text.slice(0, 57) + "…" : text;
}

/**
 * Splits a message into disclaimer callouts and the remaining prose.
 * Detects two independent markers:
 *   - "NOT LEGAL ADVICE" → retention legal disclaimer callout
 *   - "NOT COMPLIANCE ADVICE" → HIPAA/privacy disclaimer callout
 * Returns `null` for each callout when no matching marker is present.
 *
 * @deprecated Prefer the structured `disclaimer` field on ChatMsg for the
 *   retention disclaimer. This fallback handles messages stored before the
 *   structured field was added and remains the only path for the privacy disclaimer.
 */
function parseDisclaimerContent(content: string): {
  retentionCallout: string | null;
  privacyCallout: string | null;
  rest: string;
} {
  let paragraphs = content.split(/\n\n+/);
  let retentionCallout: string | null = null;
  let privacyCallout: string | null = null;

  const retentionIdx = paragraphs.findIndex((p) => p.includes("NOT LEGAL ADVICE"));
  if (retentionIdx !== -1) {
    retentionCallout = paragraphs[retentionIdx].trim();
    paragraphs = [
      ...paragraphs.slice(0, retentionIdx),
      ...paragraphs.slice(retentionIdx + 1),
    ];
  }

  const privacyIdx = paragraphs.findIndex((p) => p.includes("NOT COMPLIANCE ADVICE"));
  if (privacyIdx !== -1) {
    privacyCallout = paragraphs[privacyIdx].trim();
    paragraphs = [
      ...paragraphs.slice(0, privacyIdx),
      ...paragraphs.slice(privacyIdx + 1),
    ];
  }

  const rest = paragraphs.join("\n\n").trim();
  return { retentionCallout, privacyCallout, rest };
}

// ─── Suggested prompts ──────────────────────────────────────────────────────

const DEFAULT_SUGGESTED_PROMPTS = [
  "What cases are due this week?",
  "Mark invoice INV-2025-042 as paid",
  "Show me all rush cases",
  "Set Dr. Smith to the Premium pricing tier",
];

function buildCasePrompts(pinnedCases: AiCaseContext[]): string[] {
  if (pinnedCases.length === 0) return DEFAULT_SUGGESTED_PROMPTS;
  if (pinnedCases.length === 1) {
    const c = pinnedCases[0]!;
    return [
      `Summarize case ${c.caseNumber}`,
      `Update case ${c.caseNumber} status to in_progress`,
      `When is case ${c.caseNumber} due?`,
      `What materials are on case ${c.caseNumber}?`,
    ];
  }
  const nums = pinnedCases.map((c) => c.caseNumber).join(", ");
  return [
    `Compare the status of these cases: ${nums}`,
    `Which of these cases is most urgent?`,
    `Summarize all pinned cases`,
    `What are the due dates for these cases?`,
  ];
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

const WELCOME_MSG: ChatMsg = {
  id: "welcome",
  role: "assistant",
  content:
    "Hi! I'm Maynard. I can answer questions and take actions — like marking invoices paid, updating case status, merging doctors, and sending statements. How can I help?",
};

function buildWelcome(cases: AiCaseContext[]): ChatMsg {
  if (cases.length === 0) return WELCOME_MSG;
  if (cases.length === 1) {
    const c = cases[0]!;
    return {
      id: "welcome",
      role: "assistant",
      content: `Hi! I'm Maynard, ready to help with case ${c.caseNumber}${c.patientName ? ` (${c.patientName})` : ""}. I can answer questions or take actions. What would you like to do?`,
    };
  }
  const nums = cases.map((c) => c.caseNumber).join(", ");
  return {
    id: "welcome",
    role: "assistant",
    content: `Hi! I'm Maynard. I have ${cases.length} cases pinned: ${nums}. Ask me anything or tell me what action to take.`,
  };
}

// ─── Confirmation card ──────────────────────────────────────────────────────

const PENDING_TTL_MS = 5 * 60 * 1000;

function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface ConfirmCardProps {
  actionId: string;
  summary: string;
  state: "pending" | "confirmed" | "done" | "rejected";
  resultText?: string;
  error?: string;
  expiresAt?: number;
  onConfirm: (actionId: string) => void;
  onReject: (actionId: string) => void;
  sending?: boolean;
  onTryAgain?: () => void;
}

function ConfirmCard({ actionId, summary, state, resultText, error, expiresAt, onConfirm, onReject, sending, onTryAgain }: ConfirmCardProps) {
  const [msLeft, setMsLeft] = useState<number>(() => {
    if (!expiresAt) return PENDING_TTL_MS;
    return Math.max(0, expiresAt - Date.now());
  });

  useEffect(() => {
    if (state !== "pending") return;
    const tick = () => {
      const remaining = expiresAt ? Math.max(0, expiresAt - Date.now()) : 0;
      setMsLeft(remaining);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [state, expiresAt]);

  const isExpired = state === "pending" && msLeft <= 0;

  if (state === "rejected") {
    return (
      <div className="rounded-xl border border-border bg-secondary/60 px-3.5 py-3 max-w-[85%]">
        <div className="flex items-center gap-2 text-muted-foreground">
          <X size={13} />
          <span className="text-xs">Action cancelled</span>
        </div>
      </div>
    );
  }

  if (state === "done") {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40 px-3.5 py-3 max-w-[85%]">
        <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 mb-1">
          <Check size={13} />
          <span className="text-xs font-semibold">Done</span>
        </div>
        <p className="text-xs text-emerald-800 dark:text-emerald-300 leading-snug">
          {resultText ?? summary}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3.5 py-3 max-w-[85%]">
        <div className="flex items-center gap-2 text-destructive mb-1">
          <AlertTriangle size={13} />
          <span className="text-xs font-semibold">Action failed</span>
        </div>
        <p className="text-xs text-destructive/80 leading-snug">{error}</p>
        {onTryAgain && (
          <button
            type="button"
            onClick={onTryAgain}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary border border-border text-xs text-foreground hover:bg-accent transition-colors mt-2.5"
          >
            <RotateCcw size={11} />
            Try again
          </button>
        )}
      </div>
    );
  }

  if (isExpired) {
    return (
      <div className="rounded-xl border border-border bg-secondary/60 px-3.5 py-3 max-w-[85%]">
        <div className="flex items-center gap-2 text-muted-foreground mb-1">
          <Clock size={13} />
          <span className="text-xs font-semibold">Expired</span>
        </div>
        <p className="text-xs text-muted-foreground leading-snug mb-2.5">
          This action expired before you responded.
        </p>
        {onTryAgain && (
          <button
            type="button"
            onClick={onTryAgain}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary border border-border text-xs text-foreground hover:bg-accent transition-colors"
          >
            <RotateCcw size={11} />
            Try again
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 px-3.5 py-3.5 max-w-[85%]">
      <div className="flex items-center justify-between gap-1.5 mb-2">
        <div className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
          <Zap size={13} />
          <span className="text-xs font-semibold">Proposed action</span>
        </div>
        {state === "pending" && (
          <div className="flex items-center gap-1 text-amber-600 dark:text-amber-500">
            <Clock size={11} />
            <span className="text-xs tabular-nums">Expires in {formatCountdown(msLeft)}</span>
          </div>
        )}
      </div>
      <p className="text-sm text-amber-900 dark:text-amber-200 leading-snug mb-3">{summary}</p>
      {state === "confirmed" ? (
        <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
          <Loader2 size={12} className="animate-spin" />
          <span className="text-xs">Executing…</span>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onConfirm(actionId)}
            disabled={sending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
          >
            <Check size={12} />
            Confirm
          </button>
          <button
            type="button"
            onClick={() => onReject(actionId)}
            disabled={sending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary border border-border text-xs text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
          >
            <X size={12} />
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Admin: knowledge source badge ──────────────────────────────────────────

/**
 * Collapsible admin-only panel shown under each AI reply that lists the
 * curated knowledge section IDs that were injected into the prompt.
 * Visible only when the parent passes isAdmin={true}.
 */
function KnowledgeSourceBadge({
  sectionIds,
  retentionDisclaimer,
  privacyDisclaimer,
}: {
  sectionIds: string[];
  retentionDisclaimer?: boolean;
  privacyDisclaimer?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
        title="Admin: curated knowledge sections used in this reply"
      >
        <Sparkles size={9} />
        <span>{sectionIds.length} knowledge section{sectionIds.length !== 1 ? "s" : ""} used</span>
        <span className="text-[9px]">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="mt-1 rounded-lg border border-border/60 bg-muted/40 px-2.5 py-2 max-w-[280px]">
          <p className="text-[10px] font-semibold text-muted-foreground mb-1.5">Knowledge sections (admin)</p>
          <ul className="space-y-0.5">
            {sectionIds.map((id) => (
              <li key={id} className="text-[10px] font-mono text-foreground/70 truncate">{id}</li>
            ))}
          </ul>
          {retentionDisclaimer && (
            <p className="text-[10px] text-amber-600 dark:text-amber-500 mt-1.5 font-medium">
              ⚠ Retention legal disclaimer was injected
            </p>
          )}
          {privacyDisclaimer && (
            <p className="text-[10px] text-amber-600 dark:text-amber-500 mt-1 font-medium">
              ⚠ HIPAA/compliance disclaimer was injected
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Tool sources badge ──────────────────────────────────────────────────────

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  lookup_case: "case",
  lookup_invoice: "invoice",
  get_case_history: "case history",
  get_cases_due_soon: "cases due soon",
  draft_message: "message draft",
  monthly_sales_snapshot: "sales snapshot",
  financial_summary: "financial summary",
  remake_rate: "remake rate",
  count_cases_by_status: "case counts",
};

function extractToolLabel(name: string, result: unknown): string {
  const base = TOOL_DISPLAY_NAMES[name] ?? name.replace(/_/g, " ");
  try {
    const r = result as Record<string, unknown>;
    if (name === "lookup_case" && r.found && r.case) {
      const c = r.case as { caseNumber?: string };
      if (c.caseNumber) return `case ${c.caseNumber}`;
    }
    if (name === "get_case_history" && r.found && r.case) {
      const c = r.case as { caseNumber?: string };
      if (c.caseNumber) return `history for case ${c.caseNumber}`;
    }
    if (name === "lookup_invoice" && r.found && r.invoice) {
      const inv = r.invoice as { invoiceNumber?: string };
      if (inv.invoiceNumber) return `invoice ${inv.invoiceNumber}`;
    }
  } catch { /* ignore */ }
  return base;
}

function ToolSourcesBadge({ toolOutputs }: { toolOutputs: Array<{ name: string; result: unknown; trimmed?: boolean }> }) {
  const [open, setOpen] = useState(false);
  const labels = toolOutputs.map((t) => extractToolLabel(t.name, t.result));
  // Restored sessions persist only label metadata (trimmed), so the raw-JSON
  // detail can only be expanded for live messages that still hold full results.
  const expandable = toolOutputs.filter((t) => !t.trimmed);
  const canExpand = expandable.length > 0;

  return (
    <div className="mt-0.5">
      <button
        type="button"
        onClick={() => canExpand && setOpen((v) => !v)}
        className={`flex items-center gap-1 text-[10px] text-muted-foreground/60 ${
          canExpand ? "hover:text-muted-foreground transition-colors cursor-pointer" : "cursor-default"
        }`}
        title="Data Maynard looked up to answer this"
      >
        <Search size={9} />
        <span>Looked up: {labels.join(", ")}</span>
        {canExpand && (
          <ChevronDown size={9} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        )}
      </button>
      {open && canExpand && (
        <div className="mt-1 rounded-lg border border-border/60 bg-muted/40 px-2.5 py-2 max-w-[280px] space-y-2">
          <p className="text-[10px] font-semibold text-muted-foreground">Lookup results</p>
          {expandable.map((t, i) => (
            <div key={i}>
              <p className="text-[10px] font-mono text-foreground/60 mb-0.5">{t.name}</p>
              <pre className="text-[9px] font-mono text-foreground/70 whitespace-pre-wrap break-all leading-tight max-h-32 overflow-y-auto">
                {JSON.stringify(t.result, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Voice preference persistence ───────────────────────────────────────────

const VOICE_PREFS_KEY = "labtrax_ai_voice_prefs_v1";

type TtsVoice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

const TTS_VOICES: { value: TtsVoice; label: string }[] = [
  { value: "alloy", label: "Alloy" },
  { value: "echo", label: "Echo" },
  { value: "fable", label: "Fable" },
  { value: "nova", label: "Nova" },
  { value: "onyx", label: "Onyx" },
  { value: "shimmer", label: "Shimmer" },
];

function readVoicePrefs(): { voiceMode: boolean; ttsVoice: TtsVoice } {
  try {
    const raw = localStorage.getItem(VOICE_PREFS_KEY);
    if (!raw) return { voiceMode: false, ttsVoice: "onyx" };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      voiceMode: typeof parsed.voiceMode === "boolean" ? parsed.voiceMode : false,
      ttsVoice: TTS_VOICES.some((v) => v.value === parsed.ttsVoice)
        ? (parsed.ttsVoice as TtsVoice)
        : "onyx",
    };
  } catch {
    return { voiceMode: false, ttsVoice: "onyx" };
  }
}

function writeVoicePrefs(voiceMode: boolean, ttsVoice: TtsVoice): void {
  try {
    localStorage.setItem(VOICE_PREFS_KEY, JSON.stringify({ voiceMode, ttsVoice }));
  } catch { /* ignore — storage unavailable */ }
}

// ─── Main component ─────────────────────────────────────────────────────────

interface Props {
  onClose: () => void;
  initialCases?: AiCaseContext[];
  labOrganizationId?: string | null;
  /** When true, shows a collapsed knowledge-source audit panel on assistant replies. */
  isAdmin?: boolean;
}

export function AiChatPanel({ onClose, initialCases = [], labOrganizationId, isAdmin = false }: Props) {
  const sessionKey =
    initialCases.length > 0
      ? [...initialCases].map((c) => c.caseId).sort().join("_")
      : "general";

  const [pinnedCases, setPinnedCases] = useState<AiCaseContext[]>(initialCases);
  const [messages, setMessages] = useState<ChatMsg[]>([buildWelcome(initialCases)]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [streamingToolCall, setStreamingToolCall] = useState<string | null>(null);
  const [promptsDismissed, setPromptsDismissed] = useState(false);

  const messagesRef = useRef<ChatMsg[]>([buildWelcome(initialCases)]);
  const pinnedCasesRef = useRef<AiCaseContext[]>(initialCases);

  const [showCasePicker, setShowCasePicker] = useState(false);
  const [caseSearchQuery, setCaseSearchQuery] = useState("");
  const [caseSearchResults, setCaseSearchResults] = useState<CaseSearchResult[]>([]);
  const [caseSearchLoading, setCaseSearchLoading] = useState(false);

  const [allSessions, setAllSessions] = useState<StoredSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showSessionsList, setShowSessionsList] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);

  const currentSessionIdRef = useRef<string | null>(null);
  const allSessionsRef = useRef<StoredSession[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const caseSearchRef = useRef<HTMLInputElement>(null);

  // Voice state — explicit 4-state machine for mic
  type MicState = "idle" | "listening" | "processing" | "error";
  const [micState, setMicState] = useState<MicState>("idle");
  const [micErrorMsg, setMicErrorMsg] = useState<string | null>(null);
  const [micErrorKind, setMicErrorKind] = useState<"permission" | "other">("other");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [voiceMode, setVoiceMode] = useState<boolean>(() => readVoicePrefs().voiceMode);
  const [ttsVoice, setTtsVoice] = useState<TtsVoice>(() => readVoicePrefs().ttsVoice);
  const recognitionRef = useRef<any>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const voiceModeRef = useRef(false);
  const ttsVoiceRef = useRef<TtsVoice>(ttsVoice);
  const prevIsSpeakingRef = useRef(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionsDropdownRef = useRef<HTMLDivElement>(null);

  const sessionsForKey = allSessions
    .filter((s) => s.key === sessionKey)
    .sort((a, b) => b.lastActive - a.lastActive);

  const suggestedPrompts = buildCasePrompts(pinnedCases);
  const showPrompts = !promptsDismissed && messages.length === 1;
  const hasHistory = messages.some((m) => m.id !== "welcome");

  const persistSession = useCallback(
    (msgs: ChatMsg[], sessionId: string, currentPinnedCases: AiCaseContext[]) => {
      const userMsgs = sanitizeMessagesForStorage(msgs);
      if (userMsgs.length === 0) return;
      const now = Date.now();
      setAllSessions((prev) => {
        const existing = prev.find((s) => s.id === sessionId);
        let updated: StoredSession[];
        if (existing) {
          updated = prev.map((s) =>
            s.id === sessionId ? { ...s, messages: userMsgs, lastActive: now } : s,
          );
        } else {
          const newSession: StoredSession = {
            id: sessionId,
            key: sessionKey,
            pinnedCases: currentPinnedCases,
            messages: userMsgs,
            createdAt: now,
            lastActive: now,
          };
          const keyed = prev.filter((s) => s.key === sessionKey);
          const others = prev.filter((s) => s.key !== sessionKey);
          const trimmed = [newSession, ...keyed].slice(0, MAX_SESSIONS_PER_KEY);
          updated = [...others, ...trimmed];
        }
        writeStoredSessions(updated);
        return updated;
      });
    },
    [sessionKey],
  );

  useEffect(() => {
    const sessions = readStoredSessions();
    setAllSessions(sessions);
    const forKey = sessions
      .filter((s) => s.key === sessionKey)
      .sort((a, b) => b.lastActive - a.lastActive);
    if (forKey.length > 0) {
      const latest = forKey[0]!;
      setCurrentSessionId(latest.id);
      currentSessionIdRef.current = latest.id;
      const cases = latest.pinnedCases.length > 0 ? latest.pinnedCases : initialCases;
      setPinnedCases(cases);
      setMessages([buildWelcome(cases), ...latest.messages]);
      setPromptsDismissed(latest.messages.some((m) => m.role === "user"));
    } else {
      // No localStorage session for this key — try to restore from server history so that
      // knowledge-section audit fields (knowledgeSectionIds, retentionDisclaimer) survive
      // beyond the 7-day localStorage TTL.
      apiFetch<{ messages: Array<{ id: string; role: string; content: string; knowledgeSectionIds?: string[] | null; retentionDisclaimer?: boolean | null; createdAt: string }> }>(
        "/ai-chat/history",
      ).then((data) => {
        const serverMsgs = data.messages ?? [];
        if (serverMsgs.length === 0) return;
        const chatMsgs: ChatMsg[] = serverMsgs.map((m) => ({
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content,
          ...(m.knowledgeSectionIds && m.knowledgeSectionIds.length > 0
            ? { knowledgeSectionIds: m.knowledgeSectionIds }
            : {}),
          ...(m.retentionDisclaimer ? { retentionDisclaimer: true } : {}),
        }));
        setMessages([buildWelcome(initialCases), ...chatMsgs]);
        setPromptsDismissed(chatMsgs.some((m) => m.role === "user"));
      }).catch(() => {
        // Server history unavailable; leave the welcome message as-is.
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    pinnedCasesRef.current = pinnedCases;
  }, [pinnedCases]);

  useEffect(() => {
    allSessionsRef.current = allSessions;
  }, [allSessions]);

  useEffect(() => {
    function flushToStorage() {
      const sessionId = currentSessionIdRef.current;
      if (!sessionId) return;
      const userMsgs = sanitizeMessagesForStorage(messagesRef.current);
      if (userMsgs.length === 0) return;
      const now = Date.now();
      const prev = allSessionsRef.current;
      const existing = prev.find((s) => s.id === sessionId);
      let updated: StoredSession[];
      if (existing) {
        updated = prev.map((s) =>
          s.id === sessionId ? { ...s, messages: userMsgs, lastActive: now } : s,
        );
      } else {
        const newSession: StoredSession = {
          id: sessionId,
          key: sessionKey,
          pinnedCases: pinnedCasesRef.current,
          messages: userMsgs,
          createdAt: now,
          lastActive: now,
        };
        const keyed = prev.filter((s) => s.key === sessionKey);
        const others = prev.filter((s) => s.key !== sessionKey);
        const trimmed = [newSession, ...keyed].slice(0, MAX_SESSIONS_PER_KEY);
        updated = [...others, ...trimmed];
      }
      writeStoredSessions(updated);
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") flushToStorage();
    }

    window.addEventListener("beforeunload", flushToStorage);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", flushToStorage);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [sessionKey]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (showCasePicker) {
      setTimeout(() => caseSearchRef.current?.focus(), 50);
    }
  }, [showCasePicker]);

  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);

  useEffect(() => {
    ttsVoiceRef.current = ttsVoice;
  }, [ttsVoice]);

  useEffect(() => {
    writeVoicePrefs(voiceMode, ttsVoice);
  }, [voiceMode, ttsVoice]);

  // Auto-listen after Maynard finishes speaking (voice mode only, idle only)
  useEffect(() => {
    if (prevIsSpeakingRef.current && !isSpeaking && voiceModeRef.current && !sending && micState === "idle") {
      startListening();
    }
    prevIsSpeakingRef.current = isSpeaking;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSpeaking, sending, micState]);

  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!caseSearchQuery.trim() || caseSearchQuery.trim().length < 2) {
      setCaseSearchResults([]);
      return;
    }
    if (!labOrganizationId) return;
    setCaseSearchLoading(true);
    searchDebounceRef.current = setTimeout(async () => {
      try {
        const data = await apiFetch<{ cases: CaseSearchResult[] }>(
          `/cases/quick-search?labOrganizationId=${encodeURIComponent(labOrganizationId)}&q=${encodeURIComponent(caseSearchQuery.trim())}`,
        );
        setCaseSearchResults(data.cases ?? []);
      } catch {
        setCaseSearchResults([]);
      } finally {
        setCaseSearchLoading(false);
      }
    }, 250);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [caseSearchQuery, labOrganizationId]);

  useEffect(() => {
    if (!showSessionsList) return;
    function handleClick(e: MouseEvent) {
      if (
        sessionsDropdownRef.current &&
        !sessionsDropdownRef.current.contains(e.target as Node)
      ) {
        setShowSessionsList(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showSessionsList]);

  function pinCase(result: CaseSearchResult) {
    const alreadyPinned = pinnedCases.some((c) => c.caseId === result.id);
    if (alreadyPinned) return;
    const patientName = [result.patientFirstName, result.patientLastName].filter(Boolean).join(" ");
    const newCase: AiCaseContext = { caseId: result.id, caseNumber: result.caseNumber, patientName };
    const updated = [...pinnedCases, newCase];
    setPinnedCases(updated);
    setMessages((prev) => {
      if (prev.length === 1 && prev[0]!.id === "welcome") return [buildWelcome(updated)];
      return prev;
    });
    setShowCasePicker(false);
    setCaseSearchQuery("");
    setCaseSearchResults([]);
  }

  function unpinCase(caseId: string) {
    const updated = pinnedCases.filter((c) => c.caseId !== caseId);
    setPinnedCases(updated);
  }

  function startNewChat() {
    const newId = generateId();
    setCurrentSessionId(newId);
    currentSessionIdRef.current = newId;
    setPinnedCases(initialCases);
    setMessages([buildWelcome(initialCases)]);
    setPromptsDismissed(false);
    setInput("");
    setShowSessionsList(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function loadSession(session: StoredSession) {
    setCurrentSessionId(session.id);
    currentSessionIdRef.current = session.id;
    const cases = session.pinnedCases.length > 0 ? session.pinnedCases : initialCases;
    setPinnedCases(cases);
    setMessages([buildWelcome(cases), ...session.messages]);
    setPromptsDismissed(session.messages.some((m) => m.role === "user"));
    setShowSessionsList(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function handleDeleteSession(sessionId: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (deletingSessionId === sessionId) {
      const updated = allSessions.filter((s) => s.id !== sessionId);
      setAllSessions(updated);
      writeStoredSessions(updated);
      setDeletingSessionId(null);
      if (sessionId === currentSessionIdRef.current) startNewChat();
    } else {
      setDeletingSessionId(sessionId);
    }
  }

  /** Serialise message list to history array for the AI API.
   *  Completed proposed-actions become assistant text entries so the AI knows
   *  what already happened and can propose the next action in a sequence. */
  function buildHistory(msgs: ChatMsg[]): Array<{ role: "user" | "assistant"; content: string }> {
    return msgs
      .filter((m) => m.id !== "welcome")
      .flatMap((m): Array<{ role: "user" | "assistant"; content: string }> => {
        if (m.proposedAction) {
          const pa = m.proposedAction;
          if (pa.state === "done" && !pa.error) {
            return [{ role: "assistant", content: pa.resultText ?? `Action completed: ${pa.summary}` }];
          }
          if (pa.state === "rejected") {
            return [{ role: "assistant", content: `Action cancelled by user: ${pa.summary}` }];
          }
          return [];
        }
        if (!m.content) return [];
        return [{ role: m.role, content: m.content }];
      });
  }

  // ── Voice helpers ──────────────────────────────────────────────────────────

  function stripMarkdownForSpeech(text: string): string {
    return text
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/\*(.*?)\*/g, "$1")
      .replace(/`{1,3}([\s\S]*?)`{1,3}/g, "$1")
      .replace(/\[(.*?)\]\(.*?\)/g, "$1")
      .replace(/^#+\s+/gm, "")
      .replace(/^[\-\*•]\s+/gm, "")
      .replace(/^\d+\.\s+/gm, "")
      .replace(/\n{2,}/g, ". ")
      .replace(/\n/g, " ")
      .trim()
      .slice(0, 2000);
  }

  async function speakText(text: string) {
    const stripped = stripMarkdownForSpeech(text);
    if (!stripped) return;
    stopSpeaking();
    setIsSpeaking(true);
    try {
      const token = getAccessToken();
      const resp = await fetch(apiUrl("/ai-tts"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ text: stripped, voice: ttsVoiceRef.current }),
      });
      if (!resp.ok) { setIsSpeaking(false); return; }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudioRef.current = audio;
      audio.onended = () => {
        setIsSpeaking(false);
        URL.revokeObjectURL(url);
        currentAudioRef.current = null;
      };
      audio.onerror = () => {
        setIsSpeaking(false);
        currentAudioRef.current = null;
      };
      await audio.play();
    } catch {
      setIsSpeaking(false);
    }
  }

  function stopSpeaking() {
    const audio = currentAudioRef.current;
    if (audio) {
      audio.pause();
      currentAudioRef.current = null;
    }
    setIsSpeaking(false);
  }

  async function startListening() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicState("error");
      setMicErrorMsg("Microphone recording is not supported in this browser.");
      return;
    }
    stopSpeaking();
    const prev = recognitionRef.current as { mr: MediaRecorder; stream: MediaStream } | null;
    if (prev) {
      try { prev.mr.stop(); } catch { /* ignore */ }
      try { prev.stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      recognitionRef.current = null;
    }
    setMicErrorMsg(null);
    setMicErrorKind("other");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e: unknown) {
      const name = (e as { name?: string }).name ?? "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
        setMicState("error");
        setMicErrorKind("permission");
        setMicErrorMsg(
          "Microphone access is blocked. Please allow microphone access in your browser or OS settings, then try again.",
        );
      } else {
        setMicState("error");
        setMicErrorKind("other");
        setMicErrorMsg("Could not access microphone. Please try again.");
      }
      return;
    }

    const chunks: BlobPart[] = [];
    const mr = new MediaRecorder(stream);
    recognitionRef.current = { mr, stream } as any;

    mr.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    mr.onstop = async () => {
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      if (recognitionRef.current && (recognitionRef.current as any).mr === mr) {
        recognitionRef.current = null;
      }
      const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
      setMicState("processing");
      try {
        const token = getAccessToken();
        const formData = new FormData();
        formData.append("audio", blob, "audio.webm");
        const resp = await fetch(apiUrl("/ai-stt"), {
          method: "POST",
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: formData,
        });
        if (!resp.ok) {
          setMicState("error");
          setMicErrorKind("other");
          setMicErrorMsg("Could not transcribe audio. Please try again.");
          return;
        }
        const body = await resp.json() as { ok?: boolean; transcript?: string };
        const transcript = body.transcript?.trim() ?? "";
        if (transcript) {
          setInput(transcript);
          if (voiceModeRef.current) {
            // Voice conversation mode: auto-send
            sendMessage(transcript)
              .then(() => setMicState("idle"))
              .catch(() => setMicState("idle"));
          } else {
            // Dictation mode: just fill the text box, let user review and send
            setMicState("idle");
            setTimeout(() => inputRef.current?.focus(), 50);
          }
        } else {
          setMicState("idle");
        }
      } catch {
        setMicState("error");
        setMicErrorKind("other");
        setMicErrorMsg("Could not transcribe audio. Please try again.");
      }
    };
    mr.onerror = () => {
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      recognitionRef.current = null;
      setMicState("error");
      setMicErrorKind("other");
      setMicErrorMsg("Recording failed. Please try again.");
    };

    mr.start();
    setMicState("listening");
  }

  function stopListening() {
    const rec = recognitionRef.current as { mr: MediaRecorder; stream: MediaStream } | null;
    recognitionRef.current = null;
    if (rec) {
      try { rec.mr.stop(); } catch { /* ignore */ }
      try { rec.stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    }
    setMicState("idle");
  }

  /** Call the AI endpoint with a given message list and append the response.
   *  Uses SSE streaming via /ai-agent/stream for real-time token delivery
   *  AND action proposals (confirm/reject flow). */
  async function dispatchAiContinuation(
    currentMessages: ChatMsg[],
    sessionId: string,
    snapshotPinnedCases: AiCaseContext[],
  ) {
    setSending(true);

    const body: Record<string, unknown> = { messages: buildHistory(currentMessages) };
    if (snapshotPinnedCases.length === 1) {
      body.caseId = snapshotPinnedCases[0]!.caseId;
    } else if (snapshotPinnedCases.length > 1) {
      body.caseIds = snapshotPinnedCases.map((c) => c.caseId);
    }

    // ── Streaming agentic path via /ai-agent/stream ──────────────────────────
    // Handles both text token events and proposed_action events in one stream.
    const streamingId = generateId();
    const streamingMsg: ChatMsg = { id: streamingId, role: "assistant", content: "" };
    setMessages([...currentMessages, streamingMsg]);

    try {
      const token = getAccessToken();
      const resp = await fetch(apiUrl("/ai-agent/stream"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok || !resp.body) {
        // Non-2xx: parse as JSON error and surface it
        let msg = "Sorry, I'm having trouble connecting right now. Please try again.";
        try {
          const errBody = await resp.json() as { error?: string };
          if (resp.status === 429) msg = "Please slow down — try again in a moment.";
          else if (resp.status === 503) msg = errBody.error ?? "AI assistant is not configured on this server.";
          else if (resp.status === 500) msg = errBody.error ? `AI error: ${errBody.error}` : msg;
        } catch { /* ignore parse error */ }
        const errMsg: ChatMsg = { id: streamingId, role: "assistant", content: msg };
        setMessages((prev) => prev.map((m) => m.id === streamingId ? errMsg : m));
        persistSession([...currentMessages, errMsg], sessionId, snapshotPinnedCases);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let fullContent = "";
      let handledProposedAction = false;
      let finalMeta: Pick<ChatMsg, "knowledgeSectionIds" | "retentionDisclaimer" | "privacyDisclaimer" | "disclaimer" | "toolOutputs"> = {};

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let evt: Record<string, unknown>;
          try { evt = JSON.parse(line.slice(6)) as Record<string, unknown>; } catch { continue; }

          if (evt.tool_call && typeof evt.tool_call === "object") {
            const tc = evt.tool_call as { name?: string };
            setStreamingToolCall(tc.name ?? null);
          }

          if (typeof evt.token === "string") {
            if (!fullContent) setStreamingToolCall(null);
            fullContent += evt.token;
            setMessages((prev) =>
              prev.map((m) => m.id === streamingId ? { ...m, content: fullContent } : m),
            );
          }

          if (evt.error) {
            fullContent = typeof evt.error === "string" ? evt.error : "I couldn't generate a response.";
            setMessages((prev) =>
              prev.map((m) => m.id === streamingId ? { ...m, content: fullContent } : m),
            );
            break outer;
          }

          // Proposed action — show ConfirmCard and stop streaming
          if (evt.proposed_action && typeof evt.proposed_action === "object") {
            const pa = evt.proposed_action as {
              actionId: string;
              toolName: string;
              summary: string;
              args: Record<string, unknown>;
            };
            const actionMsg: ChatMsg = {
              id: streamingId,
              role: "assistant",
              // keep any text the model streamed before the tool call (may be empty)
              content: fullContent || undefined,
              proposedAction: {
                actionId: pa.actionId,
                toolName: pa.toolName,
                summary: pa.summary,
                state: "pending",
                expiresAt: Date.now() + PENDING_TTL_MS,
              },
            };
            handledProposedAction = true;
            setMessages((prev) => prev.map((m) => m.id === streamingId ? actionMsg : m));
            persistSession([...currentMessages, actionMsg], sessionId, snapshotPinnedCases);
            break outer;
          }

          if (evt.done) {
            finalMeta = {
              ...(Array.isArray(evt.toolOutputs) && (evt.toolOutputs as unknown[]).length > 0
                ? { toolOutputs: evt.toolOutputs as Array<{ name: string; result: unknown }> }
                : {}),
              ...(Array.isArray(evt.knowledgeSectionIds) && evt.knowledgeSectionIds.length > 0
                ? { knowledgeSectionIds: evt.knowledgeSectionIds as string[] }
                : {}),
              ...(evt.retentionDisclaimer ? { retentionDisclaimer: true } : {}),
              ...(evt.privacyDisclaimer ? { privacyDisclaimer: true } : {}),
              ...(typeof evt.disclaimer === "string" ? { disclaimer: evt.disclaimer } : {}),
            };
          }
        }
      }

      // If we broke out due to proposed_action, the message is already persisted above.
      // Only finalize as a text reply when no proposed action was set.
      // Use a local flag rather than messagesRef.current: React 18 batches the
      // setMessages call from the proposed_action branch, so the ref is still
      // stale here in the same microtask and would let finalMsg overwrite the
      // ConfirmCard before it ever renders.
      if (handledProposedAction) {
        // Already handled by proposed_action branch above
        return;
      }

      if (!fullContent) fullContent = "I couldn't generate a response. Please try again.";

      const finalMsg: ChatMsg = { id: streamingId, role: "assistant", content: fullContent, ...finalMeta };
      const finalMessages = [...currentMessages, finalMsg];
      setMessages((prev) => prev.map((m) => m.id === streamingId ? finalMsg : m));
      persistSession(finalMessages, sessionId, snapshotPinnedCases);
      if (voiceModeRef.current && fullContent) {
        void speakText(fullContent);
      }
    } catch (err: any) {
      const msg = "Sorry, I'm having trouble connecting right now. Please try again.";
      const errMsg: ChatMsg = { id: streamingId, role: "assistant", content: msg };
      setMessages((prev) => prev.map((m) => m.id === streamingId ? errMsg : m));
      persistSession([...currentMessages, errMsg], sessionId, snapshotPinnedCases);
    } finally {
      setSending(false);
      setStreamingToolCall(null);
    }
  }

  async function confirmAction(actionId: string) {
    setMessages((prev) =>
      prev.map((m) =>
        m.proposedAction?.actionId === actionId
          ? { ...m, proposedAction: { ...m.proposedAction!, state: "confirmed" as const } }
          : m,
      ),
    );

    try {
      const result = await apiFetch<{
        type: string;
        success: boolean;
        summary: string;
        error?: string;
      }>("/ai-agent/confirm", { method: "POST", body: JSON.stringify({ actionId }) });

      const resultText = result.success
        ? `✓ ${result.summary ?? "Action completed successfully."}`
        : undefined;
      const errorText = result.success ? undefined : result.error ?? "Action failed.";

      const updatedMessages = messagesRef.current.map((m) =>
        m.proposedAction?.actionId === actionId
          ? {
              ...m,
              proposedAction: {
                ...m.proposedAction!,
                state: "done" as const,
                resultText,
                error: errorText,
              },
            }
          : m,
      );
      setMessages(updatedMessages);

      if (result.success) {
        const sessionId = currentSessionIdRef.current ?? generateId();
        if (!currentSessionIdRef.current) {
          setCurrentSessionId(sessionId);
          currentSessionIdRef.current = sessionId;
        }
        await dispatchAiContinuation(updatedMessages, sessionId, pinnedCasesRef.current);
      }
    } catch (err: any) {
      const errMsg = err?.data?.error ?? err?.message ?? "Action failed. Please try again.";
      setMessages((prev) =>
        prev.map((m) =>
          m.proposedAction?.actionId === actionId
            ? {
                ...m,
                proposedAction: {
                  ...m.proposedAction!,
                  state: "done" as const,
                  error: errMsg,
                },
              }
            : m,
        ),
      );
    }
  }

  const handleCopyDraft = useCallback(async (text: string, msgId: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMsgId(msgId);
      setTimeout(() => setCopiedMsgId((prev) => (prev === msgId ? null : prev)), 2000);
    } catch {
      // clipboard unavailable — silently ignore, no state change
    }
  }, []);

  async function rejectAction(actionId: string) {
    setMessages((prev) =>
      prev.map((m) =>
        m.proposedAction?.actionId === actionId
          ? { ...m, proposedAction: { ...m.proposedAction!, state: "rejected" as const } }
          : m,
      ),
    );
    try {
      await apiFetch("/ai-agent/reject", { method: "POST", body: JSON.stringify({ actionId }) });
    } catch {
      // best-effort
    }
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    let sessionId = currentSessionIdRef.current;
    if (!sessionId) {
      sessionId = generateId();
      setCurrentSessionId(sessionId);
      currentSessionIdRef.current = sessionId;
    }

    setPromptsDismissed(true);
    const userMsg: ChatMsg = { id: generateId(), role: "user", content: trimmed };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput("");

    const snapshotPinnedCases = pinnedCases;
    await dispatchAiContinuation(nextMessages, sessionId, snapshotPinnedCases);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
    if (e.key === "Escape") {
      setShowSessionsList(false);
      setDeletingSessionId(null);
      if (showCasePicker) {
        setShowCasePicker(false);
        setCaseSearchQuery("");
      }
    }
  }

  const placeholder =
    pinnedCases.length === 1
      ? `Ask about case ${pinnedCases[0]!.caseNumber}…`
      : pinnedCases.length > 1
      ? `Ask about these ${pinnedCases.length} cases…`
      : "Ask or say what to do…";

  return (
    <div className="fixed right-0 top-0 bottom-0 w-[380px] z-50 flex flex-col bg-card border-l border-border shadow-2xl">
      {/* Header */}
      <div className="shrink-0 border-b border-border bg-card">
        <div className="h-[60px] flex items-center gap-3 px-4">
          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <Sparkles size={16} className="text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold">Maynard</div>
            {pinnedCases.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">Can answer & take actions</div>
            ) : (
              <div className="text-[11px] text-primary font-medium">
                {pinnedCases.length === 1
                  ? `Case ${pinnedCases[0]!.caseNumber}${pinnedCases[0]!.patientName ? ` · ${pinnedCases[0]!.patientName}` : ""}`
                  : `${pinnedCases.length} cases pinned`}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1">
            {sessionsForKey.length > 0 && (
              <div className="relative" ref={sessionsDropdownRef}>
                <button
                  type="button"
                  onClick={() => { setShowSessionsList((v) => !v); setDeletingSessionId(null); }}
                  title="Past conversations"
                  className="h-8 w-8 rounded-md flex items-center justify-center text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  <Clock size={15} />
                </button>
                {showSessionsList && (
                  <div className="absolute right-0 top-10 w-72 bg-card border border-border rounded-xl shadow-xl z-50 overflow-hidden">
                    <div className="px-3 py-2.5 border-b border-border flex items-center justify-between">
                      <span className="text-xs font-semibold text-foreground">Past Conversations</span>
                      <button
                        type="button"
                        onClick={startNewChat}
                        className="text-xs text-primary hover:underline flex items-center gap-1"
                      >
                        <PenSquare size={11} />
                        New chat
                      </button>
                    </div>
                    <div className="max-h-72 overflow-y-auto scrollbar-thin">
                      {sessionsForKey.map((session) => {
                        const isActive = session.id === currentSessionId;
                        const isDeleting = session.id === deletingSessionId;
                        return (
                          <button
                            key={session.id}
                            type="button"
                            onClick={() => loadSession(session)}
                            className={`w-full text-left px-3 py-2.5 hover:bg-secondary transition-colors border-b border-border/50 last:border-0 flex items-start gap-2 group ${isActive ? "bg-primary/5" : ""}`}
                          >
                            <div className="flex-1 min-w-0">
                              <div className={`text-xs font-medium truncate leading-4 ${isActive ? "text-primary" : "text-foreground"}`}>
                                {getSessionPreview(session)}
                              </div>
                              <div className="text-[10px] text-muted-foreground mt-0.5">
                                {formatRelativeTime(session.lastActive)} ·{" "}
                                {session.messages.filter((m) => m.role === "user").length} message
                                {session.messages.filter((m) => m.role === "user").length !== 1 ? "s" : ""}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={(e) => handleDeleteSession(session.id, e)}
                              title={isDeleting ? "Click again to confirm" : "Delete"}
                              className={`shrink-0 h-5 px-1.5 rounded flex items-center gap-1 text-[10px] transition-colors mt-0.5 ${
                                isDeleting
                                  ? "bg-destructive/10 text-destructive"
                                  : "opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                              }`}
                            >
                              <Trash2 size={10} />
                              {isDeleting ? "Sure?" : ""}
                            </button>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={startNewChat}
              title="New chat"
              className={`h-8 w-8 rounded-md flex items-center justify-center transition-colors ${
                hasHistory
                  ? "text-primary hover:bg-primary/10"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              <PenSquare size={15} />
            </button>

            <button
              type="button"
              onClick={onClose}
              className="h-8 w-8 rounded-md flex items-center justify-center text-muted-foreground hover:bg-secondary hover:text-foreground"
              aria-label="Close AI panel"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Pinned case chips */}
        {pinnedCases.length > 0 && (
          <div className="px-3 pb-2 flex flex-wrap gap-1.5">
            {pinnedCases.map((c) => (
              <div
                key={c.caseId}
                className="flex items-center gap-1 bg-primary/10 border border-primary/20 rounded-full pl-2.5 pr-1 py-0.5"
              >
                <span className="text-[11px] font-medium text-primary">
                  {c.caseNumber}{c.patientName ? ` · ${c.patientName}` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => unpinCase(c.caseId)}
                  className="h-4 w-4 rounded-full flex items-center justify-center text-primary/60 hover:text-primary hover:bg-primary/20 transition-colors"
                  aria-label={`Remove case ${c.caseNumber}`}
                >
                  <X size={9} />
                </button>
              </div>
            ))}
            {labOrganizationId && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowCasePicker((v) => !v)}
                  className="flex items-center gap-1 bg-secondary border border-border rounded-full px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors"
                >
                  <Plus size={10} />
                  Add case
                </button>
                {showCasePicker && (
                  <div className="absolute left-0 top-[calc(100%+4px)] z-10 w-64 bg-popover border border-border rounded-lg shadow-lg overflow-hidden">
                    <div className="p-2 border-b border-border">
                      <input
                        ref={caseSearchRef}
                        type="text"
                        value={caseSearchQuery}
                        onChange={(e) => setCaseSearchQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") { setShowCasePicker(false); setCaseSearchQuery(""); }
                        }}
                        placeholder="Search by case # or patient…"
                        className="w-full px-2 py-1.5 text-xs rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/60"
                      />
                    </div>
                    <div className="max-h-48 overflow-y-auto">
                      {caseSearchLoading ? (
                        <div className="flex items-center justify-center py-4">
                          <Loader2 size={14} className="animate-spin text-muted-foreground" />
                        </div>
                      ) : caseSearchResults.length === 0 ? (
                        <div className="px-3 py-3 text-xs text-muted-foreground text-center">
                          {caseSearchQuery.trim().length < 2 ? "Type at least 2 characters" : "No cases found"}
                        </div>
                      ) : (
                        caseSearchResults.map((result) => {
                          const alreadyPinned = pinnedCases.some((c) => c.caseId === result.id);
                          const patientName = [result.patientFirstName, result.patientLastName].filter(Boolean).join(" ");
                          return (
                            <button
                              key={result.id}
                              type="button"
                              disabled={alreadyPinned}
                              onClick={() => pinCase(result)}
                              className="w-full text-left px-3 py-2 hover:bg-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <div className="text-xs font-medium">
                                {result.caseNumber}
                                {alreadyPinned && <span className="ml-1.5 text-[10px] text-muted-foreground">(pinned)</span>}
                              </div>
                              {patientName && <div className="text-[11px] text-muted-foreground">{patientName}</div>}
                              {result.status && <div className="text-[10px] text-muted-foreground/70 capitalize">{result.status}</div>}
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Add case button when no cases pinned */}
        {pinnedCases.length === 0 && labOrganizationId && (
          <div className="px-3 pb-2 relative">
            <button
              type="button"
              onClick={() => setShowCasePicker((v) => !v)}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-primary transition-colors"
            >
              <Plus size={11} />
              Pin a case for focused context
            </button>
            {showCasePicker && (
              <div className="absolute left-3 top-[calc(100%+4px)] z-10 w-64 bg-popover border border-border rounded-lg shadow-lg overflow-hidden">
                <div className="p-2 border-b border-border">
                  <input
                    ref={caseSearchRef}
                    type="text"
                    value={caseSearchQuery}
                    onChange={(e) => setCaseSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { setShowCasePicker(false); setCaseSearchQuery(""); }
                    }}
                    placeholder="Search by case # or patient…"
                    className="w-full px-2 py-1.5 text-xs rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/60"
                  />
                </div>
                <div className="max-h-48 overflow-y-auto">
                  {caseSearchLoading ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 size={14} className="animate-spin text-muted-foreground" />
                    </div>
                  ) : caseSearchResults.length === 0 ? (
                    <div className="px-3 py-3 text-xs text-muted-foreground text-center">
                      {caseSearchQuery.trim().length < 2 ? "Type at least 2 characters" : "No cases found"}
                    </div>
                  ) : (
                    caseSearchResults.map((result) => {
                      const patientName = [result.patientFirstName, result.patientLastName].filter(Boolean).join(" ");
                      return (
                        <button
                          key={result.id}
                          type="button"
                          onClick={() => pinCase(result)}
                          className="w-full text-left px-3 py-2 hover:bg-secondary transition-colors"
                        >
                          <div className="text-xs font-medium">{result.caseNumber}</div>
                          {patientName && <div className="text-[11px] text-muted-foreground">{patientName}</div>}
                          {result.status && <div className="text-[10px] text-muted-foreground/70 capitalize">{result.status}</div>}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Messages */}
      <div
        className="flex-1 overflow-y-auto scrollbar-thin px-4 py-4 space-y-4"
        onClick={() => {
          setShowSessionsList(false);
          setDeletingSessionId(null);
          if (showCasePicker) { setShowCasePicker(false); setCaseSearchQuery(""); }
        }}
      >
        {messages.map((msg) => {
          const isUser = msg.role === "user";

          // Proposed action card (no avatar, full-width on assistant side)
          if (msg.proposedAction) {
            const msgIndex = messages.indexOf(msg);
            const precedingUserMsg = messages
              .slice(0, msgIndex)
              .reverse()
              .find((m) => m.role === "user" && m.content);
            const tryAgainText = precedingUserMsg?.content;
            return (
              <div key={msg.id} className="flex gap-2 items-end justify-start">
                <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mb-0.5">
                  <Sparkles size={11} className="text-primary" />
                </div>
                <ConfirmCard
                  actionId={msg.proposedAction.actionId}
                  summary={msg.proposedAction.summary}
                  state={msg.proposedAction.state}
                  resultText={msg.proposedAction.resultText}
                  error={msg.proposedAction.error}
                  expiresAt={msg.proposedAction.expiresAt}
                  onConfirm={confirmAction}
                  onReject={rejectAction}
                  sending={sending}
                  onTryAgain={tryAgainText ? () => sendMessage(tryAgainText) : undefined}
                />
              </div>
            );
          }

          // Find case history tool output if present. Restored sessions trim the
          // result to label-only metadata, so the print button (which needs the
          // full timeline) is only offered for live, non-trimmed outputs.
          const caseHistoryToolOutput = msg.toolOutputs?.find((t) => t.name === "get_case_history");
          const caseHistoryOutput = caseHistoryToolOutput?.result as CaseHistoryData | undefined;
          const hasCaseHistory = !!caseHistoryOutput?.found && !caseHistoryToolOutput?.trimmed;

          // Find draft_message tool output if present
          const draftOutput = msg.toolOutputs?.find((t) => t.name === "draft_message")
            ?.result as { draft?: string } | undefined;
          const draftText = draftOutput?.draft;
          const isCopied = copiedMsgId === msg.id;

          // Determine disclaimer callouts for assistant messages.
          // For the retention disclaimer: prefer the structured field from the API (reliable,
          // model-independent). Fall back to text-scanning for old stored messages.
          // For the privacy disclaimer: use text-scanning (no structured field yet).
          let retentionCallout: string | null = null;
          let privacyCallout: string | null = null;
          let disclaimerRest: string = msg.content ?? "";
          if (!isUser) {
            if (msg.disclaimer) {
              retentionCallout = msg.disclaimer;
              const parsed = parseDisclaimerContent(msg.content ?? "");
              privacyCallout = parsed.privacyCallout;
              disclaimerRest = privacyCallout ? parsed.rest : (msg.content ?? "");
            } else {
              const parsed = parseDisclaimerContent(msg.content ?? "");
              retentionCallout = parsed.retentionCallout;
              privacyCallout = parsed.privacyCallout;
              disclaimerRest = parsed.rest;
            }
          }
          const anyCallout = retentionCallout || privacyCallout;
          const bubbleContent = anyCallout ? disclaimerRest : (msg.content ?? "");
          const showBubble = isUser || !anyCallout || !!disclaimerRest;

          return (
            <div
              key={msg.id}
              className={`flex gap-2 items-end ${isUser ? "justify-end" : "justify-start"}`}
            >
              {!isUser && (
                <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mb-0.5">
                  <Sparkles size={11} className="text-primary" />
                </div>
              )}
              <div className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"} max-w-[80%]`}>
                {retentionCallout && (
                  <div className="w-full rounded-xl border border-amber-400 bg-amber-50 dark:bg-amber-950/30 px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <AlertTriangle size={14} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                      <p className="text-xs font-medium text-amber-800 dark:text-amber-300 leading-snug">
                        {retentionCallout.replace(/^⚠️\s*/, "")}
                      </p>
                    </div>
                  </div>
                )}
                {privacyCallout && (
                  <div className="w-full rounded-xl border border-amber-400 bg-amber-50 dark:bg-amber-950/30 px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <AlertTriangle size={14} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                      <p className="text-xs font-medium text-amber-800 dark:text-amber-300 leading-snug">
                        {privacyCallout.replace(/^⚠️\s*/, "")}
                      </p>
                    </div>
                  </div>
                )}
                {showBubble && (
                <div
                  className={`px-3 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                    isUser
                      ? "bg-primary text-primary-foreground rounded-br-sm"
                      : "bg-secondary text-foreground rounded-bl-sm"
                  }`}
                >
                  {bubbleContent || (
                    !isUser &&
                    sending &&
                    streamingToolCall &&
                    msg === messages[messages.length - 1]
                      ? (
                        <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                          <Loader2 size={11} className="animate-spin" />
                          {getToolCallLabel(streamingToolCall)}
                        </span>
                      )
                      : null
                  )}
                </div>
                )}
                {draftText && (
                  <div className="w-full rounded-xl border border-primary/25 bg-primary/5 px-3 py-2.5 mt-0.5">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-primary">
                        Drafted message
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopyDraft(draftText, msg.id)}
                        className={`flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded border transition-colors ${
                          isCopied
                            ? "border-primary/30 bg-primary/10 text-primary"
                            : "border-primary/20 text-primary hover:bg-primary/10"
                        }`}
                      >
                        {isCopied ? <Check size={11} /> : <Copy size={11} />}
                        {isCopied ? "Copied!" : "Copy"}
                      </button>
                    </div>
                    <p className="text-sm text-foreground leading-snug whitespace-pre-wrap">{draftText}</p>
                  </div>
                )}
                {hasCaseHistory && caseHistoryOutput && (
                  <button
                    type="button"
                    onClick={() => printCaseHistory(caseHistoryOutput)}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-1 py-0.5"
                  >
                    <Printer size={12} />
                    Print case history
                  </button>
                )}
                {!isUser && msg.toolOutputs && msg.toolOutputs.length > 0 && (
                  <ToolSourcesBadge toolOutputs={msg.toolOutputs} />
                )}
                {isAdmin && !isUser && msg.knowledgeSectionIds && msg.knowledgeSectionIds.length > 0 && (
                  <KnowledgeSourceBadge
                    sectionIds={msg.knowledgeSectionIds}
                    retentionDisclaimer={msg.retentionDisclaimer}
                    privacyDisclaimer={msg.privacyDisclaimer}
                  />
                )}
              </div>
            </div>
          );
        })}

        {/* Suggested prompts */}
        {showPrompts && (
          <div className="pt-2">
            <p className="text-[11px] text-muted-foreground mb-2">Try asking or telling me to:</p>
            <div className="flex flex-wrap gap-2">
              {suggestedPrompts.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => sendMessage(p)}
                  className="text-xs px-3 py-1.5 rounded-full bg-primary/8 border border-primary/20 text-primary hover:bg-primary/15 transition-colors"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Typing indicator */}
        {sending && (
          <div className="flex gap-2 items-end justify-start">
            <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <Sparkles size={11} className="text-primary" />
            </div>
            <div className="bg-secondary px-3 py-2 rounded-2xl rounded-bl-sm flex items-center gap-1.5">
              <Loader2 size={13} className="animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Thinking…</span>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-border p-3 bg-card">
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={1}
            maxLength={1000}
            disabled={sending}
            className="flex-1 resize-none rounded-lg border border-input bg-secondary px-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 min-h-[38px] max-h-[100px] scrollbar-thin"
            style={{ fieldSizing: "content" } as React.CSSProperties}
          />
          <button
            type="button"
            onClick={() => {
              if (micState === "listening") {
                stopListening();
              } else if (micState === "processing") {
                // no-op while waiting for AI
              } else if (micState === "error") {
                setMicState("idle");
                setMicErrorMsg(null);
              } else if (isSpeaking) {
                stopSpeaking();
                startListening();
              } else {
                startListening();
              }
            }}
            disabled={sending || micState === "processing"}
            aria-label={
              micState === "listening"
                ? "Stop listening"
                : micState === "processing"
                ? "Processing…"
                : micState === "error"
                ? micErrorKind === "permission" ? "Microphone blocked — click to dismiss" : "Microphone error — click to dismiss"
                : isSpeaking
                ? "Interrupt Maynard and speak"
                : "Speak to Maynard"
            }
            title={
              micState === "listening"
                ? "Stop listening"
                : micState === "processing"
                ? "Processing…"
                : micState === "error"
                ? micErrorKind === "permission" ? "Microphone blocked — click to dismiss" : "Microphone error — click to dismiss"
                : isSpeaking
                ? "Interrupt Maynard and speak"
                : "Speak to Maynard"
            }
            className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              micState === "listening"
                ? "bg-destructive text-destructive-foreground animate-pulse"
                : micState === "processing"
                ? "bg-secondary border border-input text-muted-foreground"
                : micState === "error"
                ? "bg-destructive/10 border border-destructive/30 text-destructive"
                : isSpeaking
                ? "bg-primary/20 text-primary"
                : "bg-secondary border border-input text-muted-foreground hover:text-foreground"
            }`}
          >
            {micState === "listening" ? (
              <VoiceWaveform />
            ) : micState === "processing" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : micState === "error" ? (
              <MicOff size={15} />
            ) : isSpeaking ? (
              <VoiceWaveform />
            ) : (
              <Mic size={15} />
            )}
          </button>

          {/* Voice conversation button — toggles voice mode, lives right of mic */}
          <button
            type="button"
            onClick={() => {
              const next = !voiceMode;
              setVoiceMode(next);
              if (!next) { stopListening(); stopSpeaking(); }
            }}
            title={voiceMode ? "Exit voice mode" : "Voice conversation — Maynard will speak and listen automatically"}
            aria-label={voiceMode ? "Exit voice mode" : "Start voice conversation"}
            className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 transition-colors ${
              voiceMode
                ? "bg-foreground text-background"
                : "bg-secondary border border-input text-muted-foreground hover:text-foreground"
            }`}
          >
            <VoiceWaveform />
          </button>

          <button
            type="button"
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || sending}
            className="h-9 w-9 rounded-lg bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            aria-label="Send message"
          >
            <Send size={15} />
          </button>
        </div>

        {/* Microphone permission / error banner */}
        {micErrorMsg && (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
            <MicOff size={13} className="text-destructive shrink-0 mt-0.5" />
            <p className="flex-1 text-[11px] text-destructive leading-snug">{micErrorMsg}</p>
            <button
              type="button"
              onClick={() => { setMicErrorMsg(null); setMicState("idle"); }}
              className="shrink-0 text-destructive/60 hover:text-destructive"
              aria-label="Dismiss"
            >
              <X size={12} />
            </button>
          </div>
        )}

        <p className="text-[10px] text-muted-foreground/50 mt-1.5 text-center">
          {voiceMode
            ? "Voice mode on — Maynard will speak and listen automatically"
            : "Mic to dictate · Hold waveform for voice conversation · Enter to send"}
        </p>
      </div>
    </div>
  );
}
