import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { Loader2, Send, Sparkles, X } from "lucide-react";

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
}

const SUGGESTED_PROMPTS = [
  "What cases are due this week?",
  "What's our average turnaround time?",
  "Show me all rush cases",
  "What's Dr. Smith's price for zirconia?",
];

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

interface Props {
  onClose: () => void;
}

export function AiChatPanel({ onClose }: Props) {
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "Hi! I'm LabTrax AI. I can help you with case status, pricing, turnaround times, and lab info. How can I help?",
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [promptsDismissed, setPromptsDismissed] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const showPrompts = !promptsDismissed && messages.length === 1;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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

      const data = await apiFetch<{ reply: string; error?: string }>("/ai-chat", {
        method: "POST",
        body: JSON.stringify({ messages: apiMessages }),
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

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  }

  return (
    <div className="fixed right-0 top-0 bottom-0 w-[380px] z-50 flex flex-col bg-card border-l border-border shadow-2xl">
      {/* Header */}
      <div className="h-[60px] shrink-0 flex items-center gap-3 px-4 border-b border-border bg-card">
        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <Sparkles size={16} className="text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold">AI Assistant</div>
          <div className="text-[11px] text-muted-foreground">Powered by your live data</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="h-8 w-8 rounded-md flex items-center justify-center text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label="Close AI panel"
        >
          <X size={16} />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-4 space-y-4">
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
              {SUGGESTED_PROMPTS.map((p) => (
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
            placeholder="Ask about a case, pricing, or lab…"
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
