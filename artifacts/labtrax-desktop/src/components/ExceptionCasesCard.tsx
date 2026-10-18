import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Paperclip,
} from "lucide-react";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { relativeTime, statusLabel } from "@/lib/format";
import type { CaseExceptionQueueItem } from "@/lib/types";

/** Shared React Query key for the active exception queue. */
export const EXCEPTION_QUEUE_QUERY_KEY = ["case-exceptions", "active"] as const;

export function patientLabel(item: {
  patientFirstName: string | null;
  patientLastName: string | null;
}): string {
  const name = [item.patientFirstName, item.patientLastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || "Unnamed patient";
}

export function caseLocationLabel(
  item: Pick<CaseExceptionQueueItem, "currentLocationName" | "caseStatus">,
): string | null {
  if (item.currentLocationName) return item.currentLocationName;
  return item.caseStatus ? statusLabel(item.caseStatus) : null;
}

/**
 * Dashboard queue of cases currently flagged as exceptions.
 *
 * Replaces the former Media Cleanup box. Unlike that box (platform-admin
 * only), this is visible to every internal lab member — anyone can open an
 * exception, so everyone needs to see the queue. Resolution is still
 * owner/admin-gated, but that gate lives on the case drawer and the server.
 */
export function ExceptionCasesCard({
  onSelectCase,
}: {
  onSelectCase?: (caseId: string) => void;
}) {
  const [open, setOpen] = useState(true);

  const query = useQuery({
    queryKey: EXCEPTION_QUEUE_QUERY_KEY,
    queryFn: () =>
      apiFetch<{ exceptions: CaseExceptionQueueItem[] }>(
        "/case-exceptions/active",
      ),
  });

  const exceptions = query.data?.exceptions ?? [];

  return (
    <section
      className="dash-section bg-card border border-slate-200 rounded-lg"
      data-testid="exception-cases-card"
    >
      <header
        className="flex items-center justify-between px-5 py-3.5 border-b border-border cursor-pointer select-none hover:bg-secondary/30 transition-colors rounded-t-xl"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-2">
          <AlertTriangle size={14} className="text-amber-500" />
          <h2 className="text-sm font-semibold">Exception cases</h2>
          {exceptions.length > 0 && (
            <span
              className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 text-xs font-semibold"
              data-testid="exception-cases-count"
            >
              {exceptions.length}
            </span>
          )}
        </div>
        <button
          type="button"
          aria-label={
            open ? "Collapse exception cases" : "Expand exception cases"
          }
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      </header>

      {open && (
        <div className="p-4">
          {query.isPending ? (
            <div
              className="flex items-center gap-2 text-xs text-muted-foreground"
              data-testid="exception-cases-loading"
            >
              <Loader2 size={14} className="animate-spin" />
              Loading exceptions…
            </div>
          ) : query.isError ? (
            <p
              className="text-xs text-destructive"
              data-testid="exception-cases-error"
            >
              Couldn't load exception cases. Please try again.
            </p>
          ) : exceptions.length === 0 ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="exception-cases-empty"
            >
              No exception cases. Flag a case from its overview when it needs
              special attention.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {exceptions.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    data-testid={`exception-case-row-${item.caseId}`}
                    onClick={() => onSelectCase?.(item.caseId)}
                    className="w-full text-left rounded-lg border border-border px-3 py-2.5 hover:bg-secondary/40 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="text-sm font-medium truncate">
                          {patientLabel(item)}
                        </span>
                        {caseLocationLabel(item) && (
                          <span
                            className="shrink-0 text-xs text-muted-foreground"
                            data-testid={`exception-case-location-${item.caseId}`}
                          >
                            · {caseLocationLabel(item)}
                          </span>
                        )}
                      </span>
                      {item.hasMedia && (
                        <span
                          className="shrink-0 text-muted-foreground"
                          title={`${item.mediaCount} attachment${item.mediaCount === 1 ? "" : "s"}`}
                          data-testid={`exception-case-media-${item.caseId}`}
                        >
                          <Paperclip size={13} />
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 truncate">
                      {item.caseNumber ? `Case ${item.caseNumber}` : "Case"}
                      {item.doctorName ? ` · ${item.doctorName}` : ""}
                    </div>
                    {(item.latestNoteText ?? item.issueText) && (
                      <p className="text-xs mt-1 line-clamp-2">
                        {item.latestNoteText ?? item.issueText}
                      </p>
                    )}
                    <div className="text-[11px] text-muted-foreground mt-1">
                      {relativeTime(item.latestNoteCreatedAt ?? item.createdAt)}
                      {(item.latestNoteCreatedAt
                        ? item.latestNoteAuthorName
                        : item.createdByName)
                        ? ` · ${
                            item.latestNoteCreatedAt
                              ? item.latestNoteAuthorName
                              : item.createdByName
                          }`
                        : ""}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
