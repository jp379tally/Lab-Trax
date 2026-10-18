import { useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, X } from "lucide-react";
import type { Vendor } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";

/** The server's limit for a payee's default net terms. */
const MAX_TERMS_DAYS = 365;

const INPUT_CLASS =
  "w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm focus:outline-none focus:ring-1 focus:ring-ring";

/**
 * Quick "New vendor" window opened from a vendor list, such as the Enter bill
 * form. It creates a Vendor-type payee from the few details needed to keep
 * working; address and notes are still edited under Payees.
 *
 * It renders as its own layer above the window that opened it, so anything
 * already typed there stays put.
 */
export function NewVendorDialog({
  organizationId,
  onClose,
  onSaved,
}: {
  organizationId: string;
  onClose: () => void;
  /** Receives the saved vendor. Only called while this window is still open. */
  onSaved: (vendor: Vendor) => void;
}) {
  const qc = useQueryClient();
  const id = useId();
  const [name, setName] = useState("");
  const [termsDays, setTermsDays] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The pending state reaches the Save button a moment after the click, so a
  // fast double-click needs this guard to avoid creating the vendor twice.
  const saving = useRef(false);

  const create = useMutation({
    mutationFn: (paymentTermsDays: number | null) =>
      apiFetch<Vendor>("/finance/vendors", {
        method: "POST",
        body: JSON.stringify({
          organizationId,
          name: name.trim(),
          vendorType: "vendor",
          paymentTermsDays,
          phone: phone.trim() || null,
          email: email.trim() || null,
        }),
      }),
    // Refresh here rather than in `onSaved`: this also runs if the window
    // unmounts before the save finishes, and the vendor exists either way.
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["finance", "vendors", organizationId],
      });
    },
    onError: (err: unknown) => {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Could not save this vendor.",
      );
    },
    onSettled: () => {
      saving.current = false;
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current || !name.trim()) return;
    const terms = termsDays === "" ? null : Number(termsDays);
    if (terms != null && terms > MAX_TERMS_DAYS) {
      setError(`Default terms can be at most ${MAX_TERMS_DAYS} days.`);
      return;
    }
    saving.current = true;
    setError(null);
    // Callbacks passed here only run while this window is mounted, so a save
    // that finishes after it unmounts never changes the caller's selection.
    create.mutate(terms, { onSuccess: onSaved });
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/30 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="w-full max-w-sm bg-card border border-border rounded-xl shadow-xl"
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 id={`${id}-title`} className="text-sm font-semibold">
            New vendor
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={create.isPending}
            className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center disabled:opacity-60"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </header>
        <form onSubmit={submit} className="px-5 py-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            Only the name is required. Add an address or notes later under
            Payees.
          </p>
          {error && (
            <p
              role="alert"
              className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md"
            >
              {error}
            </p>
          )}
          <div>
            <label
              htmlFor={`${id}-name`}
              className="block text-xs font-medium mb-1"
            >
              Name
            </label>
            <input
              id={`${id}-name`}
              autoFocus
              required
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Vendor name"
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label
              htmlFor={`${id}-terms`}
              className="block text-xs font-medium mb-1"
            >
              Default terms (days)
            </label>
            <input
              id={`${id}-terms`}
              inputMode="numeric"
              maxLength={3}
              value={termsDays}
              onChange={(event) =>
                setTermsDays(event.target.value.replace(/[^0-9]/g, ""))
              }
              placeholder="e.g. 30"
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label
              htmlFor={`${id}-phone`}
              className="block text-xs font-medium mb-1"
            >
              Phone
            </label>
            <input
              id={`${id}-phone`}
              type="tel"
              maxLength={50}
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="(555) 555-5555"
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label
              htmlFor={`${id}-email`}
              className="block text-xs font-medium mb-1"
            >
              Email
            </label>
            <input
              id={`${id}-email`}
              type="email"
              maxLength={200}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@example.com"
              className={INPUT_CLASS}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            {/* Closing is unavailable while saving, so Cancel never leaves
                behind a vendor that the caller does not show. */}
            <button
              type="button"
              onClick={onClose}
              disabled={create.isPending}
              className="h-9 px-4 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/80 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || create.isPending}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
            >
              {create.isPending ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Plus size={14} />
              )}
              Save vendor
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
