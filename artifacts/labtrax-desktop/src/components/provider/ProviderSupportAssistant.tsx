import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

export function ProviderSupportAssistant({ providerOrganizationId }: { providerOrganizationId: string }) {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  return <section className="max-w-3xl space-y-4">
    <div><h1 className="text-2xl font-semibold">LabTrax Support</h1>
      <p className="text-sm text-muted-foreground mt-1">Ask about your practice’s cases, invoices, or using LabTrax.</p></div>
    <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">Answers use your selected practice’s permissions. This assistant reads records and makes no changes.</div>
    <div role="log" aria-live="polite" aria-label="Support conversation" className="space-y-3">
      {!messages.length && <p className="text-muted-foreground text-sm">Try “What is the status of case 1234?” or “How do I send a digital impression to SDR?”</p>}
      {messages.map((entry, index) => <div key={index} className={`rounded-lg border border-border p-4 whitespace-pre-wrap break-words ${entry.role === "user" ? "bg-primary/5 ml-8" : "bg-card mr-4"}`}>
        <span className="block text-xs font-semibold text-muted-foreground mb-1">{entry.role === "user" ? "You" : "LabTrax Support"}</span>{entry.content}
      </div>)}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <form className="space-y-2" onSubmit={async event => {
      event.preventDefault(); const question = message.trim(); if (!question || busy) return;
      setBusy(true); setError(""); setMessage("");
      setMessages(previous => [...previous, { role: "user", content: question }]);
      const abort = new AbortController(); controller.current = abort;
      const timer = window.setTimeout(() => abort.abort(), 35_000);
      try {
        const result = await apiFetch<{ reply: string }>("/support-assistant/account", {
          method: "POST", body: JSON.stringify({ message: question }), signal: abort.signal,
          headers: { "x-provider-organization-id": providerOrganizationId },
        });
        if (!abort.signal.aborted) setMessages(previous => [...previous, { role: "assistant", content: result.reply }]);
      } catch (failure) {
        if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : "The assistant is unavailable. Please try again.");
        else setError("The response was interrupted. Please try again.");
      } finally { window.clearTimeout(timer); setBusy(false); }
    }}>
      <label htmlFor="support-question" className="block font-medium text-sm">Your question</label>
      <textarea id="support-question" value={message} onChange={event => setMessage(event.target.value)} required maxLength={2000} rows={3} className="w-full rounded-lg border border-input bg-background p-3 text-sm" />
      <button type="submit" disabled={busy || !message.trim()} className="rounded-md bg-primary text-primary-foreground px-5 py-2 text-sm font-medium disabled:opacity-50">{busy ? "Checking…" : "Ask LabTrax"}</button>
    </form>
    <p className="text-xs text-muted-foreground">Each question checks current records. Include the case or invoice number in follow-up questions. AI answers may need verification.</p>
  </section>;
}
