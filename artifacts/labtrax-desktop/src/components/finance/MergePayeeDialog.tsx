import { useState } from "react";
import { GitMerge, Loader2, X } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface MergeableVendor {
  id: string;
  name: string;
  isActive: boolean;
}

interface MergePreview {
  transactionsRelinked: number;
  recurringRelinked: number;
  dryRun: boolean;
}

export function MergePayeeDialog({
  source,
  allVendors,
  onClose,
  onMerged,
}: {
  source: MergeableVendor;
  allVendors: MergeableVendor[];
  onClose: () => void;
  onMerged: () => void;
}) {
  const [canonicalId, setCanonicalId] = useState("");
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const mergeMut = useMutation({
    mutationFn: () =>
      apiFetch<MergePreview>(`/finance/vendors/${source.id}/merge`, {
        method: "POST",
        body: JSON.stringify({ canonicalVendorId: canonicalId, dryRun: false }),
      }),
    onSuccess: () => {
      onMerged();
    },
    onError: (e) => {
      setMergeError(e instanceof Error ? e.message : "Merge failed.");
    },
  });

  async function loadPreview(id: string) {
    if (!id) return;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreview(null);
    try {
      const result = await apiFetch<MergePreview>(
        `/finance/vendors/${source.id}/merge`,
        {
          method: "POST",
          body: JSON.stringify({ canonicalVendorId: id, dryRun: true }),
        }
      );
      setPreview(result);
    } catch (e) {
      setPreviewError(
        e instanceof Error ? e.message : "Could not load preview."
      );
    } finally {
      setPreviewLoading(false);
    }
  }

  function handleCanonicalChange(id: string) {
    setCanonicalId(id);
    setPreview(null);
    setPreviewError(null);
    setMergeError(null);
    if (id) loadPreview(id);
  }

  const canonicalVendor = allVendors.find((v) => v.id === canonicalId);
  const totalRelinked = preview
    ? preview.transactionsRelinked + preview.recurringRelinked
    : 0;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <GitMerge size={16} className="text-muted-foreground" />
            <h2 className="font-semibold text-sm">Merge payee</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-7 w-7 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2.5 text-sm">
            <p className="font-medium text-amber-800 dark:text-amber-200">
              Merging:{" "}
              <span className="font-semibold">{source.name}</span>
            </p>
            <p className="text-amber-700 dark:text-amber-300 text-xs mt-0.5">
              All transactions linked to this payee will be re-assigned to the
              one you choose below, and this payee will be removed.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Keep this payee as canonical
            </label>
            <select
              value={canonicalId}
              onChange={(e) => handleCanonicalChange(e.target.value)}
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">— pick a payee —</option>
              {allVendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                  {!v.isActive ? " (inactive)" : ""}
                </option>
              ))}
            </select>
          </div>

          {previewLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 size={14} className="animate-spin" />
              Checking transactions…
            </div>
          )}

          {previewError && (
            <p className="text-xs text-destructive">{previewError}</p>
          )}

          {preview && canonicalVendor && (
            <div className="rounded-lg bg-secondary/40 border border-border px-3 py-3 space-y-1">
              <p className="text-sm font-medium">Merge summary</p>
              <ul className="text-sm text-muted-foreground space-y-0.5 mt-1">
                <li>
                  <span className="text-foreground font-medium">
                    {preview.transactionsRelinked}
                  </span>{" "}
                  {preview.transactionsRelinked === 1
                    ? "transaction"
                    : "transactions"}{" "}
                  will be re-linked to{" "}
                  <span className="font-medium text-foreground">
                    {canonicalVendor.name}
                  </span>
                </li>
                {preview.recurringRelinked > 0 && (
                  <li>
                    <span className="text-foreground font-medium">
                      {preview.recurringRelinked}
                    </span>{" "}
                    recurring{" "}
                    {preview.recurringRelinked === 1 ? "rule" : "rules"} will be
                    re-linked
                  </li>
                )}
                {totalRelinked === 0 && (
                  <li className="text-muted-foreground">
                    No transactions are linked to this payee.
                  </li>
                )}
              </ul>
              <p className="text-xs text-muted-foreground pt-1">
                This action cannot be undone.{" "}
                <span className="font-medium text-foreground">
                  {source.name}
                </span>{" "}
                will be permanently removed.
              </p>
            </div>
          )}

          {mergeError && (
            <p className="text-xs text-destructive">{mergeError}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 rounded-md text-sm text-muted-foreground hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => mergeMut.mutate()}
            disabled={
              !canonicalId ||
              !preview ||
              previewLoading ||
              mergeMut.isPending
            }
            className="h-8 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90 disabled:opacity-60 inline-flex items-center gap-1.5"
          >
            {mergeMut.isPending && (
              <Loader2 size={13} className="animate-spin" />
            )}
            Merge &amp; remove duplicate
          </button>
        </div>
      </div>
    </div>
  );
}
