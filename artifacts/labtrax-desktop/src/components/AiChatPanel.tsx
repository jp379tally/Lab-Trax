import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { Loader2, Plus, Send, Sparkles, Trash2, X } from "lucide-react";
import type { AiCaseContext } from "@/lib/ai-panel-context";

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface CaseSearchResult {
  id: string;
  caseNumber: string;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  doctorName?: string | null;
  status?: string | null;
}

const DEFAULT_SUGGESTED_PROMPTS = [
  "What cases are due this week?",
  "What's our average turnaround time?",
  "Show me all rush cases",
  "What's Dr. Smith's price for zirconia?",
];

function buildCasePrompts(pinnedCases: AiCaseContext[]): string[] {
  if (pinnedCases.length === 0) return DEFAULT_SUGGESTED_PROMPTS;
  if (pinnedCases.length === 1) {
    const c = pinnedCases[0]!;
    return [
      `Summarize case ${c.caseNumber}`,
      c.patientName
        ? `What restorations are on ${c.patientName}'s case?`
        : `What restorations are on case ${c.caseNumber}?`,
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
    "Hi! I'm LabTrax AI. I can help you with case status, pricing, turnaround times, and lab info. How can I help?",
};

function buildWelcome(cases: AiCaseContext[]): ChatMsg {
  if (cases.length === 0) return WELCOME_MSG;
  if (cases.length === 1) {
    const c = cases[0]!;
    return {
      id: "welcome",
      role: "assistant",
      content: `Hi! I'm LabTrax AI. I'm ready to help you with case ${c.caseNumber}${c.patientName ? ` (${c.patientName})` : ""}. What would you like to know?`,
    };
  }
  const nums = cases.map((c) => c.caseNumber).join(", ");
  return {
    id: "welcome",
    role: "assistant",
    content: `Hi! I'm LabTrax AI. I have ${cases.length} cases pinned: ${nums}. Ask me anything about these cases or your lab.`,
  };
}

interface Props {
  onClose: () => void;
  initialCases?: AiCaseContext[];
  labOrganizationId?: string | null;
}

export function AiChatPanel({ onClose, initialCases = [], labOrganizationId }: Props) {
  const [pinnedCases, setPinnedCases] = useState<AiCaseContext[]>(initialCases);
  const [messages, setMessages] = useState<ChatMsg[]>([buildWelcome(initialCases)]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [promptsDismissed, setPromptsDismissed] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [showCasePicker, setShowCasePicker] = useState(false);
  const [caseSearchQuery, setCaseSearchQuery] = useState("");
  const [caseSearchResults, setCaseSearchResults] = useState<CaseSearchResult[]>([]);
  const [caseSearchLoading, setCaseSearchLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const caseSearchRef = useRef<HTMLInputElement>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const suggestedPrompts = buildCasePrompts(pinnedCases);
  const showPrompts = !promptsDismissed && messages.length === 1;
  const hasHistory = messages.some((m) => m.id !== "welcome");

  // Load chat history on mount (only when no initial cases)
  useEffect(() => {
    if (initialCases.length > 0) return;
    let cancelled = false;
    async function loadHistory() {
      try {
        const data = await apiFetch<{ messages: Array<{ id: string; role: string; content: string; createdAt: string }> }>(
          "/ai-chat/history",
        );
        const historyMsgs: ChatMsg[] = (data.messages ?? []).map((m) => ({
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content,
        }));
        if (!cancelled && historyMsgs.length > 0) {
          setMessages([WELCOME_MSG, ...historyMsgs]);
          setPromptsDismissed(true);
        }
      } catch {
        // silently ignore — history is a best-effort enhancement
      }
    }
    loadHistory();
    return () => { cancelled = true; };
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  // Focus input on open
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Focus search input when picker opens
  useEffect(() => {
    if (showCasePicker) {
      setTimeout(() => caseSearchRef.current?.focus(), 50);
    }
  }, [showCasePicker]);

  // Debounced case search
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

  function pinCase(result: CaseSearchResult) {
    const alreadyPinned = pinnedCases.some((c) => c.caseId === result.id);
    if (alreadyPinned) return;
    const patientName = [result.patientFirstName, result.patientLastName]
      .filter(Boolean)
      .join(" ");
    const newCase: AiCaseContext = {
      caseId: result.id,
      caseNumber: result.caseNumber,
      patientName,
    };
    const updated = [...pinnedCases, newCase];
    setPinnedCases(updated);
    // Update welcome if this is the very first message shown
    setMessages((prev) => {
      if (prev.length === 1 && prev[0]!.id === "welcome") {
        return [buildWelcome(updated)];
      }
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

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    setPromptsDismissed(true);
    const userMsg: ChatMsg = { id: generateId(), role: "user", content: trimmed };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput("");
    setSending(true);

    try {
      const apiMessages = nextMessages
        .filter((m) => m.id !== "welcome")
        .map((m) => ({ role: m.role, content: m.content }));

      const body: Record<string, unknown> = { messages: apiMessages };
      if (pinnedCases.length === 1) {
        body.caseId = pinnedCases[0]!.caseId;
      } else if (pinnedCases.length > 1) {
        body.caseIds = pinnedCases.map((c) => c.caseId);
      }

      const data = await apiFetch<{ reply: string; error?: string }>("/ai-chat", {
        method: "POST",
        body: JSON.stringify(body),
      });

      setMessages((prev) => [
        ...prev,
        {
          id: generateId(),
          role: "assistant",
          content: data.reply || "I couldn't generate a response. Please try again.",
        },
      ]);
    } catch (err: any) {
      const msg =
        err?.status === 429
          ? "Please slow down — try again in a moment."
          : err?.status === 503
          ? "AI assistant is not configured on this server. Please contact your administrator."
          : "Sorry, I'm having trouble connecting right now. Please try again.";
      setMessages((prev) => [
        ...prev,
        { id: generateId(), role: "assistant", content: msg },
      ]);
    } finally {
      setSending(false);
    }
  }

  async function handleClearHistory() {
    if (!confirmingClear) {
      setConfirmingClear(true);
      return;
    }
    setClearing(true);
    setConfirmingClear(false);
    try {
      await apiFetch("/ai-chat/history", { method: "DELETE" });
      setMessages([buildWelcome(pinnedCases)]);
      setPromptsDismissed(false);
    } catch {
      // ignore
    } finally {
      setClearing(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
    if (e.key === "Escape" && confirmingClear) {
      setConfirmingClear(false);
    }
    if (e.key === "Escape" && showCasePicker) {
      setShowCasePicker(false);
    }
  }

  const placeholder =
    pinnedCases.length === 1
      ? `Ask about case ${pinnedCases[0]!.caseNumber}…`
      : pinnedCases.length > 1
      ? `Ask about these ${pinnedCases.length} cases…`
      : "Ask about a case, pricing, or lab…";

  return (
    <div className="fixed right-0 top-0 bottom-0 w-[380px] z-50 flex flex-col bg-card border-l border-border shadow-2xl">
      {/* Header */}
      <div className="shrink-0 border-b border-border bg-card">
        <div className="h-[60px] flex items-center gap-3 px-4">
          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <Sparkles size={16} className="text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold">AI Assistant</div>
            {pinnedCases.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">Powered by your live data</div>
            ) : (
              <div className="text-[11px] text-primary font-medium">
                {pinnedCases.length === 1
                  ? `Case ${pinnedCases[0]!.caseNumber}${pinnedCases[0]!.patientName ? ` · ${pinnedCases[0]!.patientName}` : ""}`
                  : `${pinnedCases.length} cases pinned`}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1">
            {hasHistory && (
              <button
                type="button"
                onClick={handleClearHistory}
                disabled={clearing}
                title={confirmingClear ? "Click again to confirm" : "Clear chat history"}
                className={`h-8 px-2 rounded-md flex items-center gap-1.5 text-xs transition-colors disabled:opacity-50 ${
                  confirmingClear
                    ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                }`}
              >
                {clearing ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Trash2 size={13} />
                )}
                {confirmingClear ? "Confirm?" : ""}
              </button>
            )}
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
                  {c.caseNumber}
                  {c.patientName ? ` · ${c.patientName}` : ""}
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
                          if (e.key === "Escape") {
                            setShowCasePicker(false);
                            setCaseSearchQuery("");
                          }
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
                          {caseSearchQuery.trim().length < 2
                            ? "Type at least 2 characters"
                            : "No cases found"}
                        </div>
                      ) : (
                        caseSearchResults.map((result) => {
                          const alreadyPinned = pinnedCases.some((c) => c.caseId === result.id);
                          const patientName = [result.patientFirstName, result.patientLastName]
                            .filter(Boolean)
                            .join(" ");
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
                                {alreadyPinned && (
                                  <span className="ml-1.5 text-[10px] text-muted-foreground">(pinned)</span>
                                )}
                              </div>
                              {patientName && (
                                <div className="text-[11px] text-muted-foreground">{patientName}</div>
                              )}
                              {result.status && (
                                <div className="text-[10px] text-muted-foreground/70 capitalize">{result.status}</div>
                              )}
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

        {/* Add case button when no cases are pinned */}
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
                      if (e.key === "Escape") {
                        setShowCasePicker(false);
                        setCaseSearchQuery("");
                      }
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
                      {caseSearchQuery.trim().length < 2
                        ? "Type at least 2 characters"
                        : "No cases found"}
                    </div>
                  ) : (
                    caseSearchResults.map((result) => {
                      const patientName = [result.patientFirstName, result.patientLastName]
                        .filter(Boolean)
                        .join(" ");
                      return (
                        <button
                          key={result.id}
                          type="button"
                          onClick={() => pinCase(result)}
                          className="w-full text-left px-3 py-2 hover:bg-secondary transition-colors"
                        >
                          <div className="text-xs font-medium">{result.caseNumber}</div>
                          {patientName && (
                            <div className="text-[11px] text-muted-foreground">{patientName}</div>
                          )}
                          {result.status && (
                            <div className="text-[10px] text-muted-foreground/70 capitalize">{result.status}</div>
                          )}
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
          if (confirmingClear) setConfirmingClear(false);
          if (showCasePicker) {
            setShowCasePicker(false);
            setCaseSearchQuery("");
          }
        }}
      >
        {messages.map((msg) => {
          const isUser = msg.role === "user";
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
              <div
                className={`max-w-[80%] px-3 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                  isUser
                    ? "bg-primary text-primary-foreground rounded-br-sm"
                    : "bg-secondary text-foreground rounded-bl-sm"
                }`}
              >
                {msg.content}
              </div>
            </div>
          );
        })}

        {/* Suggested prompts */}
        {showPrompts && (
          <div className="pt-2">
            <p className="text-[11px] text-muted-foreground mb-2">Try asking:</p>
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
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || sending}
            className="h-9 w-9 rounded-lg bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            aria-label="Send message"
          >
            <Send size={15} />
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground/50 mt-1.5 text-center">
          Shift+Enter for new line · Enter to send
        </p>
      </div>
    </div>
  );
}
