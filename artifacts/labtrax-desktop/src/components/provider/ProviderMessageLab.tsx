import { useState } from "react";
import type { LabCase } from "@/lib/types";
import { ProviderMessengerChat } from "@/components/messenger/ProviderMessengerChat";
import { ProviderSentNotes } from "@/components/provider/ProviderSentNotes";

type ProviderCase = LabCase & {
  restorationTypes?: string | null;
  labName?: string | null;
  labOrganizationId: string;
};

interface ProviderMessageLabProps {
  cases: ProviderCase[] | null;
  casesError: string | null;
}

export function ProviderMessageLab({
  cases,
  casesError,
}: ProviderMessageLabProps) {
  // Derive unique labs from cases
  const labs = cases
    ? Array.from(
        new Map(
          cases
            .filter((c) => c.labOrganizationId)
            .map((c) => [
              c.labOrganizationId,
              {
                id: c.labOrganizationId,
                name: c.labName ?? c.labOrganizationId,
              },
            ])
        ).values()
      )
    : [];

  const [selectedLabId, setSelectedLabId] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"chat" | "sent">("chat");

  // Auto-select when only one lab is linked
  const effectiveLabId = selectedLabId || (labs.length === 1 ? labs[0].id : "");
  const effectiveLab = labs.find((l) => l.id === effectiveLabId);

  if (casesError) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-destructive">{casesError}</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Lab picker — only shown when provider is linked to multiple labs */}
      {labs.length > 1 && (
        <div className="shrink-0 px-4 py-3 border-b border-border">
          <label
            htmlFor="labPicker"
            className="block text-xs font-medium text-muted-foreground mb-1"
          >
            Chat with Lab
          </label>
          <select
            id="labPicker"
            value={selectedLabId}
            onChange={(e) => setSelectedLabId(e.target.value)}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value="">Select a lab…</option>
            {labs.map((lab) => (
              <option key={lab.id} value={lab.id}>
                {lab.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* No labs linked yet */}
      {labs.length === 0 && cases !== null && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-sm text-muted-foreground">
            <div className="text-3xl mb-3">🔗</div>
            <p className="font-medium">No lab linked yet</p>
            <p className="text-xs mt-1">
              Contact your lab to get connected.
            </p>
          </div>
        </div>
      )}

      {/* Loading cases */}
      {cases === null && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      )}

      {/* Need to select a lab */}
      {labs.length > 1 && !effectiveLabId && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">Select a lab to start chatting.</p>
        </div>
      )}

      {/* Chat / Sent tabs + panel */}
      {effectiveLabId && (
        <>
          <div className="shrink-0 flex border-b border-border">
            <button
              type="button"
              onClick={() => setActiveTab("chat")}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === "chat"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              Chat
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("sent")}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === "sent"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              Sent
            </button>
          </div>
          <div className="flex-1 min-h-0">
            {activeTab === "chat" ? (
              <ProviderMessengerChat
                key={effectiveLabId}
                labOrganizationId={effectiveLabId}
                labName={effectiveLab?.name}
              />
            ) : (
              <ProviderSentNotes
                key={effectiveLabId}
                labOrganizationId={effectiveLabId}
                labName={effectiveLab?.name}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
