import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Bookmark, FolderOpen, Trash2 } from "lucide-react";
import { formatDate } from "@/lib/format";
import type { SavedSelection, Selection } from "./types";
import {
  plural,
  readSavedSelections,
  restoreSavedSelection,
  savedSelectionCustomers,
  upsertSavedSelection,
  writeSavedSelections,
  type PayableCustomer,
} from "./model";

function browserStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

type Message = { tone: "info" | "warning" | "error"; text: string };

function Popover({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      const anchor = box.current?.parentElement;
      if (anchor && !anchor.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [onClose]);
  return (
    <div
      ref={box}
      role="dialog"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      className="absolute right-0 top-full z-40 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card p-3 text-sm shadow-xl"
    >
      {children}
    </div>
  );
}

/**
 * Named sets of customers, kept on this computer for one user and lab, each
 * with the payment scope (statement or picked invoices) it was saved with.
 * Loading a set re-selects the customers whose scope still applies and names
 * the ones that are no longer payable or were left unselected or narrowed.
 */
export function SavedSelections({
  storageKey,
  selection,
  customersById,
  ready,
  onLoad,
}: {
  /** Null when there is no signed-in user to keep selections for. */
  storageKey: string | null;
  selection: Selection;
  customersById: ReadonlyMap<string, PayableCustomer>;
  /** False until the payable customer lists have loaded. */
  ready: boolean;
  onLoad: (next: Selection) => void;
}) {
  const [saved, setSaved] = useState<SavedSelection[]>([]);
  const [open, setOpen] = useState<"save" | "load" | null>(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState<Message | null>(null);

  useEffect(() => {
    setSaved(storageKey ? readSavedSelections(browserStorage(), storageKey) : []);
  }, [storageKey]);

  const close = useCallback(() => setOpen(null), []);
  const persist = (next: SavedSelection[]): boolean => {
    if (!storageKey) return false;
    const ok = writeSavedSelections(browserStorage(), storageKey, next);
    if (ok) setSaved(next);
    return ok;
  };

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed || !selection.ids.length) return;
    const entry: SavedSelection = {
      name: trimmed,
      savedAt: new Date().toISOString(),
      customers: savedSelectionCustomers(selection, customersById),
    };
    if (persist(upsertSavedSelection(saved, entry))) {
      setMessage({ tone: "info", text: `Saved “${trimmed}” (${plural(entry.customers.length, "customer")}) on this computer.` });
      setName("");
      close();
    } else {
      setMessage({ tone: "error", text: "This selection could not be saved on this computer." });
    }
  };

  const load = (entry: SavedSelection) => {
    const { selection: restored, narrowed, unselected, missing } = restoreSavedSelection(entry, customersById);
    onLoad(restored);
    const names = (rows: ReadonlyArray<{ name: string }>) => rows.map((row) => row.name).join(", ");
    const statementGone = unselected.filter((row) => row.reason === "statement");
    const picksGone = unselected.filter((row) => row.reason === "invoices");
    const notes = [
      missing.length ? `No longer payable: ${names(missing)}.` : null,
      statementGone.length ? `Not selected because their statement is no longer payable: ${names(statementGone)}.` : null,
      picksGone.length
        ? `Not selected because none of their picked invoices are still outstanding: ${names(picksGone)}.`
        : null,
      narrowed.length ? `Picked invoices no longer outstanding were left out for ${names(narrowed)}.` : null,
    ].filter((note): note is string => !!note);
    const count = restored.ids.length;
    if (!count && !unselected.length) {
      setMessage({
        tone: "warning",
        text: `None of the customers in “${entry.name}” have a payable balance now${missing.length ? `: ${names(missing)}` : ""}.`,
      });
    } else if (!count) {
      setMessage({ tone: "warning", text: [`Nothing in “${entry.name}” could be selected.`, ...notes].join(" ") });
    } else {
      setMessage({
        tone: notes.length ? "warning" : "info",
        text: [`Loaded “${entry.name}”: ${plural(count, "customer")} selected.`, ...notes].join(" "),
      });
    }
    close();
  };

  const remove = (entry: SavedSelection) => {
    if (!window.confirm(`Delete the saved selection “${entry.name}”?`)) return;
    if (!persist(saved.filter((row) => row !== entry))) {
      setMessage({ tone: "error", text: "The saved selection could not be deleted." });
    }
  };

  const unavailable = !storageKey ? "Saved selections need a signed-in user." : null;
  const buttonClass =
    "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-background px-2.5 text-xs font-medium hover:bg-secondary disabled:opacity-50";

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <div className="relative">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open === "load"}
          disabled={!!unavailable || !ready}
          title={unavailable ?? (!ready ? "Customers are still loading." : undefined)}
          onClick={() => {
            setMessage(null);
            setOpen((current) => (current === "load" ? null : "load"));
          }}
          className={buttonClass}
        >
          <FolderOpen size={13} aria-hidden="true" />
          Load Saved Selection
        </button>
        {open === "load" && (
          <Popover label="Saved selections" onClose={close}>
            <h4 className="mb-2 text-xs font-semibold">Saved on this computer</h4>
            {saved.length === 0 ? (
              <p className="text-xs text-muted-foreground">No saved selections yet.</p>
            ) : (
              <ul className="max-h-64 space-y-1 overflow-y-auto">
                {saved.map((entry) => (
                  <li key={`${entry.name}:${entry.savedAt}`} className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-secondary/50">
                    <button
                      type="button"
                      aria-label={`Load ${entry.name}`}
                      onClick={() => load(entry)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="block truncate text-sm font-medium">{entry.name}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {plural(entry.customers.length, "customer")} · saved {formatDate(entry.savedAt)}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${entry.name}`}
                      onClick={() => remove(entry)}
                      className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Popover>
        )}
      </div>
      <div className="relative">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open === "save"}
          disabled={!!unavailable || !selection.ids.length}
          title={unavailable ?? (!selection.ids.length ? "Select customers to save them as a set." : undefined)}
          onClick={() => {
            setMessage(null);
            setOpen((current) => (current === "save" ? null : "save"));
          }}
          className={buttonClass}
        >
          <Bookmark size={13} aria-hidden="true" />
          Save Selection
        </button>
        {open === "save" && (
          <Popover label="Save selection" onClose={close}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                save();
              }}
              className="space-y-2"
            >
              <label className="block text-xs font-medium" htmlFor="receive-saved-selection-name">
                Name this set of {plural(selection.ids.length, "customer")}
              </label>
              <input
                id="receive-saved-selection-name"
                autoFocus
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Monthly statement customers"
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              />
              <p className="text-[11px] text-muted-foreground">
                Kept on this computer for you and this lab. Saving with an existing name replaces it.
              </p>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={close} className="h-8 rounded-md bg-secondary px-3 text-xs font-medium">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!name.trim()}
                  className="h-8 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </form>
          </Popover>
        )}
      </div>
      {message && (
        <p
          role={message.tone === "info" ? "status" : "alert"}
          className={`basis-full text-right text-xs ${
            message.tone === "error"
              ? "text-destructive"
              : message.tone === "warning"
                ? "text-amber-700 dark:text-amber-300"
                : "text-muted-foreground"
          }`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
