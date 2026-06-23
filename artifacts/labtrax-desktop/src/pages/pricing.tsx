import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  History,
  Layers,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import {
  DEFAULT_PRICE_KEYS,
  formatPriceTwoDecimals,
  labelFor,
} from "@/lib/pricing-keys";

type Section = "tiers" | "labels";

interface PricingTier {
  id: string;
  labOrganizationId: string;
  name: string;
  prices: Record<string, number>;
}

interface TiersResponse {
  labOrganizationId: string;
  keys: string[];
  tiers: PricingTier[];
}

// labelFor / PRICE_KEY_LABELS now imported from @/lib/pricing-keys.

interface PriceDiffEntry {
  key: string;
  before: number;
  after: number;
  kind: "added" | "removed" | "changed";
}

function diffPrices(
  before: Record<string, number> | null | undefined,
  after: Record<string, number> | null | undefined
): PriceDiffEntry[] {
  const out: PriceDiffEntry[] = [];
  const keys = new Set<string>([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);
  for (const k of keys) {
    const b = Number(before?.[k] ?? 0);
    const a = Number(after?.[k] ?? 0);
    if (b === a) continue;
    let kind: PriceDiffEntry["kind"] = "changed";
    if (b <= 0 && a > 0) kind = "added";
    else if (b > 0 && a <= 0) kind = "removed";
    out.push({ key: k, before: b, after: a, kind });
  }
  out.sort((x, y) => labelFor(x.key).localeCompare(labelFor(y.key)));
  return out;
}

function PriceDiffList({ diff }: { diff: PriceDiffEntry[] }) {
  if (diff.length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic">
        No price changes.
      </div>
    );
  }
  return (
    <ul className="space-y-1">
      {diff.map((d) => (
        <li
          key={d.key}
          className="flex items-center justify-between text-xs"
        >
          <span className="text-foreground">{labelFor(d.key)}</span>
          <span className="tabular-nums">
            {d.kind === "added" && (
              <>
                <span className="text-muted-foreground">— →</span>{" "}
                <span className="text-success font-medium">
                  {formatMoney(d.after)}
                </span>
              </>
            )}
            {d.kind === "removed" && (
              <>
                <span className="text-muted-foreground line-through">
                  {formatMoney(d.before)}
                </span>{" "}
                <span className="text-muted-foreground">→ —</span>
              </>
            )}
            {d.kind === "changed" && (
              <>
                <span className="text-muted-foreground line-through">
                  {formatMoney(d.before)}
                </span>{" "}
                <span className="text-muted-foreground">→</span>{" "}
                <span
                  className={
                    d.after > d.before
                      ? "text-warning font-medium"
                      : "text-success font-medium"
                  }
                >
                  {formatMoney(d.after)}
                </span>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

interface AuditEntry {
  id: string;
  action: string;
  createdAt: string;
  userId: string | null;
  userName: string | null;
  beforePrices: Record<string, number> | null;
  afterPrices: Record<string, number> | null;
  beforeName: string | null;
  afterName: string | null;
  beforeDoctorName: string | null;
  afterDoctorName: string | null;
  beforePracticeName: string | null;
  afterPracticeName: string | null;
  beforeNotes: string | null;
  afterNotes: string | null;
}

function formatRelativeDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function actionLabel(action: string): string {
  if (action.endsWith("_created")) return "Created";
  if (action.endsWith("_updated")) return "Updated";
  if (action.endsWith("_deleted")) return "Deleted";
  return action;
}

function HistoryPanel({
  endpoint,
  enabled,
  onRestore,
}: {
  endpoint: string;
  enabled: boolean;
  onRestore?: (entry: AuditEntry) => void;
}) {
  const query = useQuery({
    queryKey: ["pricing", "history", endpoint],
    queryFn: () => apiFetch<{ entries: AuditEntry[] }>(endpoint),
    enabled,
    retry: false,
  });

  if (!enabled) return null;

  if (query.isLoading) {
    return (
      <div className="text-xs text-muted-foreground py-3">
        <Loader2 size={12} className="inline animate-spin mr-1.5" />
        Loading history…
      </div>
    );
  }
  if (query.error) {
    const err = query.error as ApiError;
    return (
      <div className="text-xs text-destructive bg-destructive/10 rounded-md px-3 py-2">
        {err.message}
      </div>
    );
  }
  const entries = query.data?.entries ?? [];
  if (entries.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-3 italic">
        No edits recorded yet.
      </div>
    );
  }
  return (
    <ol className="space-y-3">
      {entries.map((e) => {
        const diff = diffPrices(e.beforePrices, e.afterPrices);
        const renamed =
          e.beforeName !== null &&
          e.afterName !== null &&
          e.beforeName !== e.afterName;
        const practiceChanged =
          e.beforePracticeName !== e.afterPracticeName &&
          e.action.endsWith("_updated");
        const notesChanged =
          (e.beforeNotes ?? "") !== (e.afterNotes ?? "") &&
          e.action.endsWith("_updated");
        return (
          <li
            key={e.id}
            className="border border-border rounded-md p-3 bg-secondary/20"
          >
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-xs font-medium">
                {actionLabel(e.action)}
                {e.userName ? (
                  <>
                    {" "}
                    by{" "}
                    <span className="text-muted-foreground font-normal">
                      {e.userName}
                    </span>
                  </>
                ) : null}
              </div>
              <div className="text-[11px] text-muted-foreground tabular-nums">
                {formatRelativeDate(e.createdAt)}
              </div>
            </div>
            {renamed && (
              <div className="text-[11px] text-muted-foreground mb-1">
                Renamed{" "}
                <span className="line-through">{e.beforeName}</span> →{" "}
                <span className="text-foreground">{e.afterName}</span>
              </div>
            )}
            {practiceChanged && (
              <div className="text-[11px] text-muted-foreground mb-1">
                Practice:{" "}
                <span className="line-through">
                  {e.beforePracticeName || "—"}
                </span>{" "}
                →{" "}
                <span className="text-foreground">
                  {e.afterPracticeName || "—"}
                </span>
              </div>
            )}
            {notesChanged && (
              <div className="text-[11px] text-muted-foreground mb-1">
                Notes updated.
              </div>
            )}
            {e.action.endsWith("_created") && e.afterPrices ? (
              <div className="text-[11px] text-muted-foreground">
                Created with{" "}
                {Object.values(e.afterPrices).filter((v) => Number(v) > 0)
                  .length}{" "}
                priced item
                {Object.values(e.afterPrices).filter((v) => Number(v) > 0)
                  .length === 1
                  ? ""
                  : "s"}
                .
              </div>
            ) : e.action.endsWith("_deleted") ? (
              <div className="text-[11px] text-muted-foreground">Deleted.</div>
            ) : (
              <PriceDiffList diff={diff} />
            )}
            {onRestore && e.afterPrices && !e.action.endsWith("_deleted") && (
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => onRestore(e)}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                >
                  <RotateCcw size={11} />
                  Restore these prices
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ConfirmChangesDialog({
  title,
  diff,
  metaChanges,
  isPending,
  onCancel,
  onConfirm,
}: {
  title: string;
  diff: PriceDiffEntry[];
  metaChanges: { label: string; before: string; after: string }[];
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const hasAnyChange = diff.length > 0 || metaChanges.length > 0;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/40 px-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md bg-card border border-border rounded-xl shadow-lg flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-border">
          <div className="text-xs text-muted-foreground">Review changes</div>
          <div className="text-sm font-semibold mt-0.5">{title}</div>
        </div>
        <div className="px-5 py-4 overflow-y-auto space-y-4">
          {!hasAnyChange && (
            <div className="text-sm text-muted-foreground italic">
              You haven't changed anything yet.
            </div>
          )}
          {metaChanges.length > 0 && (
            <div className="space-y-1.5">
              {metaChanges.map((m) => (
                <div key={m.label} className="text-xs">
                  <span className="text-muted-foreground">{m.label}: </span>
                  <span className="line-through text-muted-foreground">
                    {m.before || "—"}
                  </span>{" "}
                  →{" "}
                  <span className="text-foreground">{m.after || "—"}</span>
                </div>
              ))}
            </div>
          )}
          {diff.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-2">
                Price changes ({diff.length})
              </div>
              <PriceDiffList diff={diff} />
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary"
          >
            Keep editing
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending || !hasAnyChange}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
          >
            {isPending ? "Saving…" : "Confirm save"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PricingPage() {
  const [section, setSection] = useState<Section>("tiers");

  return (
    <div className="px-8 py-7">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pricing</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your lab's pricing tiers and what's currently being billed
            across cases.
          </p>
        </div>
      </div>

      <ResolutionOrderExplainer />

      <div className="flex items-center gap-1 border-b border-border mb-5 text-sm">
        <SectionTab
          active={section === "tiers"}
          onClick={() => setSection("tiers")}
          icon={<Layers size={14} />}
          label="Pricing tiers"
        />
        <SectionTab
          active={section === "labels"}
          onClick={() => setSection("labels")}
          icon={<Type size={14} />}
          label="Item labels"
        />
      </div>

      {section === "tiers" && <TiersSection />}
      {section === "labels" && <ItemLabelsSection />}
    </div>
  );
}

function SectionTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-2 -mb-px border-b-2 ${
        active
          ? "border-primary text-foreground font-medium"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// ---- Tiers ----

interface PricingSettingsResponse {
  labOrganizationId: string;
  defaultDoctorTierName: string | null;
}

function DefaultDoctorTierSetting({ tiers }: { tiers: PricingTier[] }) {
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ["pricing", "settings"],
    queryFn: () => apiFetch<PricingSettingsResponse>("/pricing/settings"),
    staleTime: 60 * 1000,
  });

  const [localValue, setLocalValue] = useState<string | null | undefined>(
    undefined,
  );
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settingsQuery.data !== undefined && localValue === undefined) {
      setLocalValue(settingsQuery.data.defaultDoctorTierName ?? null);
    }
  }, [settingsQuery.data, localValue]);

  const patchMutation = useMutation({
    mutationFn: (tierName: string | null) =>
      apiFetch<PricingSettingsResponse>("/pricing/settings", {
        method: "PATCH",
        body: JSON.stringify({ defaultDoctorTierName: tierName }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["pricing", "settings"], data);
      setLocalValue(data.defaultDoctorTierName ?? null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const currentValue =
    localValue !== undefined
      ? localValue
      : (settingsQuery.data?.defaultDoctorTierName ?? null);

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value || null;
    setLocalValue(val);
    patchMutation.mutate(val);
  }

  if (tiers.length === 0) return null;

  return (
    <div className="bg-card border border-border rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">Default tier for new doctors</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          Automatically assigned to a new doctor when no explicit tier is set.
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {settingsQuery.isLoading ? (
          <Loader2 size={14} className="animate-spin text-muted-foreground" />
        ) : (
          <select
            value={currentValue ?? ""}
            onChange={handleChange}
            disabled={patchMutation.isPending}
            className="h-9 px-2 rounded-md bg-background border border-input text-sm min-w-[160px] disabled:opacity-60"
          >
            <option value="">No default</option>
            {tiers.map((t) => (
              <option key={t.id} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        {patchMutation.isPending && (
          <Loader2 size={14} className="animate-spin text-muted-foreground" />
        )}
        {saved && !patchMutation.isPending && (
          <CheckCircle2 size={14} className="text-success" />
        )}
        {patchMutation.error && (
          <span className="text-xs text-destructive">
            {(patchMutation.error as ApiError).message}
          </span>
        )}
      </div>
    </div>
  );
}

function TiersSection() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PricingTier | null>(null);
  const [addingItem, setAddingItem] = useState(false);

  const tiersQuery = useQuery({
    queryKey: ["pricing", "tiers"],
    queryFn: () => apiFetch<TiersResponse>("/pricing/tiers"),
    retry: false,
  });

  const labelsQuery = useQuery({
    queryKey: ["pricing", "item-labels", undefined],
    queryFn: () => apiFetch<ItemLabelsResponse>("/pricing/item-labels"),
    staleTime: 30_000,
  });

  const tiers = tiersQuery.data?.tiers ?? [];
  const keys = tiersQuery.data?.keys ?? [];
  const itemLabels = labelsQuery.data?.labels ?? {};
  const resolveLabel = (k: string) => itemLabels[k] ?? labelFor(k);

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/pricing/tiers/${id}`, { method: "DELETE" }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["pricing", "tiers"] }),
  });

  if (tiersQuery.isLoading) {
    return (
      <div className="text-sm text-muted-foreground py-12 text-center">
        <Loader2 size={16} className="inline animate-spin mr-2" />
        Loading tiers…
      </div>
    );
  }
  if (tiersQuery.error) {
    const err = tiersQuery.error as ApiError;
    return (
      <div className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
        {err.message}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Tiers are price lists you can assign to client practices.
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAddingItem(true)}
            disabled={tiers.length === 0}
            className="h-9 px-3 rounded-md border border-input bg-background text-sm font-semibold inline-flex items-center gap-1.5 hover:bg-secondary disabled:opacity-60 disabled:cursor-not-allowed"
            title={
              tiers.length === 0
                ? "Create a pricing tier first"
                : "Add a custom billable item to one or more tiers"
            }
          >
            <Plus size={14} /> Add billable item
          </button>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-semibold inline-flex items-center gap-1.5 hover:bg-primary/90"
          >
            <Plus size={14} /> New tier
          </button>
        </div>
      </div>

      <DefaultDoctorTierSetting tiers={tiers} />

      {tiers.length === 0 ? (
        <div className="bg-card border border-border rounded-xl py-14 text-center">
          <Layers
            size={28}
            className="inline text-muted-foreground/50 mb-3"
          />
          <div className="text-sm font-medium">No pricing tiers yet</div>
          <div className="text-xs text-muted-foreground mt-1">
            Create your first tier (e.g. Standard, Premium) and set per-item
            prices.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {tiers.map((t) => (
            <div
              key={t.id}
              className="bg-card border border-border rounded-xl p-4"
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="font-semibold">{t.name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {Object.values(t.prices).filter((v) => Number(v) > 0).length}{" "}
                    of {keys.length} items priced
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setEditing(t)}
                    className="h-8 w-8 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground flex items-center justify-center"
                    aria-label="Edit tier"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete the "${t.name}" tier? Practices on this tier will fall back to defaults.`,
                        )
                      ) {
                        deleteMutation.mutate(t.id);
                      }
                    }}
                    className="h-8 w-8 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive flex items-center justify-center"
                    aria-label="Delete tier"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              <div className="space-y-1 text-xs">
                {keys.slice(0, 6).map((k) => (
                  <div key={k} className="flex items-center justify-between">
                    <span className="text-muted-foreground">{resolveLabel(k)}</span>
                    <span className="tabular-nums">
                      {Number(t.prices[k]) > 0
                        ? formatMoney(Number(t.prices[k]))
                        : "—"}
                    </span>
                  </div>
                ))}
                {keys.length > 6 && (
                  <button
                    type="button"
                    onClick={() => setEditing(t)}
                    className="text-primary text-xs mt-1"
                  >
                    +{keys.length - 6} more
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <TierEditor
          mode="create"
          keys={keys}
          tier={null}
          resolveLabel={resolveLabel}
          onClose={() => setCreating(false)}
        />
      )}
      {editing && (
        <TierEditor
          mode="edit"
          keys={keys}
          tier={editing}
          resolveLabel={resolveLabel}
          onClose={() => setEditing(null)}
        />
      )}
      {addingItem && (
        <AddBillableItemEditor
          tiers={tiers}
          onClose={() => setAddingItem(false)}
        />
      )}
    </div>
  );
}

interface AddBillableItemResult {
  labOrganizationId: string;
  priceKey: string;
  name: string;
  description: string | null;
  price: number;
  tierIds: string[];
  updatedTiers: number;
}

function AddBillableItemEditor({
  tiers,
  onClose,
}: {
  tiers: PricingTier[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [selectedTierIds, setSelectedTierIds] = useState<string[]>(() =>
    tiers.length === 1 ? [tiers[0].id] : [],
  );
  const [error, setError] = useState<string | null>(null);

  function toggleTier(id: string) {
    setSelectedTierIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    );
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const trimmedName = name.trim();
      const priceValue = Number(price);
      if (!trimmedName) {
        throw new Error("Enter a name for the item.");
      }
      if (selectedTierIds.length === 0) {
        throw new Error("Select at least one tier.");
      }
      if (!Number.isFinite(priceValue) || priceValue <= 0) {
        throw new Error("Enter a price greater than 0.");
      }
      return apiFetch<AddBillableItemResult>(`/pricing/add-item`, {
        method: "POST",
        body: JSON.stringify({
          name: trimmedName,
          description: description.trim() || null,
          price: priceValue,
          tierIds: selectedTierIds,
        }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pricing", "tiers"] });
      queryClient.invalidateQueries({ queryKey: ["pricing", "item-labels"] });
      queryClient.invalidateQueries({ queryKey: ["pricing", "history"] });
      onClose();
    },
    onError: (err: Error) => {
      setError(err.message || "Could not add the item.");
    },
  });

  return (
    <SidePanel
      title="Add billable item"
      subtitle="Apply a custom item to one or more tiers"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              setError(null);
              mutation.mutate();
            }}
            disabled={mutation.isPending}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
          >
            {mutation.isPending ? "Adding…" : "Add item"}
          </button>
        </>
      }
    >
      <div>
        <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
          Item name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Custom whitening tray"
          maxLength={80}
          className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
        />
      </div>

      <div>
        <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
          Description <span className="normal-case">(optional)</span>
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this item covers…"
          maxLength={500}
          rows={3}
          className="w-full px-2.5 py-2 rounded-md bg-background border border-input text-sm resize-y"
        />
      </div>

      <div>
        <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
          Price
        </label>
        <PriceField label="Unit price" value={price} onChange={setPrice} />
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
          Apply to tiers
        </div>
        <div className="space-y-1.5">
          {tiers.map((t) => (
            <label
              key={t.id}
              className="flex items-center gap-2 text-sm rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selectedTierIds.includes(t.id)}
                onChange={() => toggleTier(t.id)}
                className="h-4 w-4 rounded border-input"
              />
              <span>{t.name}</span>
            </label>
          ))}
        </div>
      </div>

      {error && (
        <div className="text-sm rounded-md px-3 py-2 bg-destructive/10 text-destructive">
          {error}
        </div>
      )}
    </SidePanel>
  );
}

function TierEditor({
  mode,
  keys,
  tier,
  resolveLabel,
  onClose,
}: {
  mode: "create" | "edit";
  keys: string[];
  tier: PricingTier | null;
  resolveLabel: (k: string) => string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(tier?.name ?? "");
  const [prices, setPrices] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const k of keys) {
      const v = Number(tier?.prices?.[k] ?? 0);
      out[k] = v > 0 ? v.toFixed(2) : "";
    }
    return out;
  });
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoring, setRestoring] = useState<AuditEntry | null>(null);

  const nextPrices = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(prices)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[k] = n;
    }
    return out;
  }, [prices]);

  const diff = useMemo(
    () => diffPrices(tier?.prices ?? {}, nextPrices),
    [tier, nextPrices]
  );

  const metaChanges = useMemo(() => {
    const m: { label: string; before: string; after: string }[] = [];
    if (mode === "edit" && tier && tier.name !== name.trim()) {
      m.push({ label: "Name", before: tier.name, after: name.trim() });
    }
    return m;
  }, [mode, tier, name]);

  const restoreTargetPrices = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(restoring?.afterPrices ?? {})) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[k] = n;
    }
    return out;
  }, [restoring]);

  const restoreDiff = useMemo(
    () => diffPrices(tier?.prices ?? {}, restoreTargetPrices),
    [tier, restoreTargetPrices]
  );

  const restoreMetaChanges = useMemo(() => {
    const m: { label: string; before: string; after: string }[] = [];
    if (!restoring || !tier) return m;
    const targetName = (restoring.afterName ?? tier.name).trim();
    if (targetName && targetName !== tier.name) {
      m.push({ label: "Name", before: tier.name, after: targetName });
    }
    return m;
  }, [restoring, tier]);

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        prices: nextPrices,
      };
      if (mode === "create") {
        return apiFetch<PricingTier>("/pricing/tiers", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }
      return apiFetch<PricingTier>(`/pricing/tiers/${tier!.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pricing", "tiers"] });
      queryClient.invalidateQueries({ queryKey: ["pricing", "history"] });
      setConfirming(false);
      onClose();
    },
    onError: (err: Error) => {
      setError(err.message || "Could not save tier.");
      setConfirming(false);
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async () => {
      if (!tier || !restoring) throw new Error("Nothing to restore.");
      const payload: Record<string, unknown> = {
        name: (restoring.afterName ?? tier.name).trim() || tier.name,
        prices: restoreTargetPrices,
      };
      return apiFetch<PricingTier>(`/pricing/tiers/${tier.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pricing", "tiers"] });
      queryClient.invalidateQueries({ queryKey: ["pricing", "history"] });
      setRestoring(null);
      onClose();
    },
    onError: (err: Error) => {
      setError(err.message || "Could not restore tier.");
      setRestoring(null);
    },
  });

  function handleSaveClick() {
    setError(null);
    if (mode === "edit" && diff.length === 0 && metaChanges.length === 0) {
      onClose();
      return;
    }
    if (mode === "create") {
      mutation.mutate();
      return;
    }
    setConfirming(true);
  }

  return (
    <SidePanel
      title={mode === "create" ? "New pricing tier" : `Edit ${tier?.name}`}
      subtitle="Pricing tier"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSaveClick}
            disabled={mutation.isPending || !name.trim()}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
          >
            {mutation.isPending
              ? "Saving…"
              : mode === "edit"
                ? "Review & save"
                : "Save tier"}
          </button>
        </>
      }
    >
      <div>
        <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
          Tier name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Standard, Premium, Corporate…"
          className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
        />
      </div>

      <BulkPriceTools
        keys={keys}
        prices={prices}
        onApply={(next) => setPrices(next)}
      />

      <div>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
          Item prices
        </div>
        <div className="space-y-2">
          {keys.map((k) => (
            <PriceField
              key={k}
              label={resolveLabel(k)}
              value={prices[k] ?? ""}
              onChange={(v) => setPrices((p) => ({ ...p, [k]: v }))}
            />
          ))}
        </div>
      </div>

      {mode === "edit" && (diff.length > 0 || metaChanges.length > 0) && (
        <div className="rounded-md border border-border bg-secondary/30 p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-2">
            Pending changes
          </div>
          {metaChanges.map((m) => (
            <div key={m.label} className="text-xs mb-1">
              <span className="text-muted-foreground">{m.label}: </span>
              <span className="line-through text-muted-foreground">
                {m.before || "—"}
              </span>{" "}
              → <span className="text-foreground">{m.after || "—"}</span>
            </div>
          ))}
          <PriceDiffList diff={diff} />
        </div>
      )}

      {mode === "edit" && tier && (
        <div>
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <History size={12} />
            {historyOpen ? "Hide history" : "Show history"}
            {historyOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {historyOpen && (
            <div className="mt-3">
              <HistoryPanel
                endpoint={`/pricing/tiers/${tier.id}/history`}
                enabled={historyOpen}
                onRestore={(entry) => {
                  setError(null);
                  setRestoring(entry);
                }}
              />
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="text-sm rounded-md px-3 py-2 bg-destructive/10 text-destructive">
          {error}
        </div>
      )}

      {confirming && (
        <ConfirmChangesDialog
          title={tier ? `${tier.name} (pricing tier)` : "Pricing tier"}
          diff={diff}
          metaChanges={metaChanges}
          isPending={mutation.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => mutation.mutate()}
        />
      )}

      {restoring && tier && (
        <ConfirmChangesDialog
          title={`Restore ${tier.name} to ${formatRelativeDate(restoring.createdAt)}`}
          diff={restoreDiff}
          metaChanges={restoreMetaChanges}
          isPending={restoreMutation.isPending}
          onCancel={() => setRestoring(null)}
          onConfirm={() => restoreMutation.mutate()}
        />
      )}
    </SidePanel>
  );
}

// ---- Shared UI ----

export function PriceField({
  label,
  value,
  onChange,
  placeholder = "0.00",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [focused, setFocused] = useState(false);
  const displayValue = focused ? value : formatPriceTwoDecimals(value);
  return (
    <div className="flex items-center gap-3">
      <div className="text-sm text-muted-foreground flex-1">{label}</div>
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">$</span>
        <input
          type="text"
          inputMode="decimal"
          pattern="[0-9]*[.]?[0-9]*"
          min="0"
          value={displayValue}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={(e) => {
            setFocused(false);
            onChange(formatPriceTwoDecimals(e.target.value));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onChange(formatPriceTwoDecimals(e.currentTarget.value));
            }
          }}
          placeholder={placeholder}
          className="w-28 h-8 px-2 rounded-md bg-background border border-input text-sm text-right tabular-nums"
        />
      </div>
    </div>
  );
}

function SidePanel({
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-foreground/30" onClick={onClose} />
      <aside className="w-full max-w-[480px] bg-card border-l border-border h-full flex flex-col">
        <header className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            {subtitle && (
              <div className="text-xs text-muted-foreground">{subtitle}</div>
            )}
            <div className="text-sm font-semibold">{title}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {children}
        </div>
        <footer className="px-6 py-4 border-t border-border flex items-center justify-end gap-2">
          {footer}
        </footer>
      </aside>
    </div>
  );
}

export function BulkPriceTools({
  keys,
  prices,
  onApply,
}: {
  keys: string[];
  prices: Record<string, string>;
  onApply: (next: Record<string, string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pct, setPct] = useState("");
  const [paste, setPaste] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<
    { key: string; label: string; before: string; after: string }[] | null
  >(null);

  function applyPct() {
    setErr(null);
    setMsg(null);
    setPreview(null);
    const n = Number(pct);
    if (!Number.isFinite(n) || n === 0) {
      setErr("Enter a non-zero percent (e.g. 5 for +5%, -3 for −3%).");
      return;
    }
    const factor = 1 + n / 100;
    let touched = 0;
    const next: Record<string, string> = { ...prices };
    const rows: { key: string; label: string; before: string; after: string }[] = [];
    for (const k of keys) {
      const cur = Number(prices[k]);
      if (Number.isFinite(cur) && cur > 0) {
        const after = (cur * factor).toFixed(2);
        next[k] = after;
        rows.push({
          key: k,
          label: labelFor(k),
          before: formatPriceTwoDecimals(prices[k] || ""),
          after: formatPriceTwoDecimals(after),
        });
        touched++;
      }
    }
    if (touched === 0) {
      setErr("No priced items to adjust. Set at least one price first.");
      return;
    }
    onApply(next);
    setPreview(rows);
    setMsg(`Adjusted ${touched} price${touched === 1 ? "" : "s"} by ${n}%.`);
  }

  function applyPaste() {
    setErr(null);
    setMsg(null);
    setPreview(null);
    const next: Record<string, string> = { ...prices };
    const rows: { key: string; label: string; before: string; after: string }[] = [];
    let updated = 0;
    const skipped: string[] = [];
    const lines = paste
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      const m = line.match(/^([A-Za-z0-9_.\- ]+?)\s*[=:,\t]\s*\$?([0-9]+(?:\.[0-9]+)?)$/);
      if (!m) {
        skipped.push(line);
        continue;
      }
      const rawKey = m[1].trim().toLowerCase().replace(/\s+/g, "_");
      const value = Number(m[2]);
      if (!keys.includes(rawKey) || !Number.isFinite(value) || value < 0) {
        skipped.push(line);
        continue;
      }
      const after = value.toFixed(2);
      next[rawKey] = after;
      rows.push({
        key: rawKey,
        label: labelFor(rawKey),
        before: formatPriceTwoDecimals(prices[rawKey] || ""),
        after: formatPriceTwoDecimals(after),
      });
      updated++;
    }
    if (updated === 0) {
      setErr(
        skipped.length
          ? `No valid lines. Format: key = price (e.g. zirconia_crown = 250).`
          : "Paste at least one line.",
      );
      return;
    }
    onApply(next);
    setPreview(rows);
    setMsg(
      `Updated ${updated} item${updated === 1 ? "" : "s"}${
        skipped.length ? `, skipped ${skipped.length}.` : "."
      }`,
    );
  }

  return (
    <div className="rounded-md border border-border bg-secondary/20">
      <button
        type="button"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (!next) setPreview(null);
        }}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium hover:bg-secondary/40"
      >
        <span className="inline-flex items-center gap-1.5">
          <Pencil size={12} /> Bulk edit prices
        </span>
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-3">
          <div>
            <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">
              Adjust all priced items by percent
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                step="0.5"
                value={pct}
                onChange={(e) => setPct(e.target.value)}
                placeholder="e.g. 5 or -3"
                className="h-8 w-32 px-2 rounded-md bg-background border border-input text-sm"
              />
              <span className="text-xs text-muted-foreground">%</span>
              <button
                type="button"
                onClick={applyPct}
                className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90"
              >
                Apply
              </button>
            </div>
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">
              Paste many (one per line — key = price)
            </label>
            <textarea
              rows={4}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder={"zirconia_crown = 250\npfm_crown = 235\nimplant: 850"}
              className="w-full px-2 py-1.5 rounded-md bg-background border border-input text-xs font-mono"
            />
            <button
              type="button"
              onClick={applyPaste}
              className="mt-1 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90"
            >
              Apply pasted prices
            </button>
          </div>
          {preview && preview.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-1">
                Result
              </div>
              <ul className="space-y-0.5" aria-label="Bulk price result">
                {preview.map((row) => (
                  <li
                    key={row.key}
                    className="flex items-center justify-between text-xs"
                    aria-label={`${row.label}: ${row.before} to ${row.after}`}
                  >
                    <span className="text-muted-foreground truncate mr-2">{row.label}</span>
                    <span className="tabular-nums shrink-0">
                      <span className="text-muted-foreground line-through">{row.before}</span>
                      {" → "}
                      <span className="font-medium">{row.after}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {msg && <div className="text-xs text-success">{msg}</div>}
          {err && <div className="text-xs text-destructive">{err}</div>}
          <div className="text-[10px] text-muted-foreground">
            Tip: changes here update the form only — hit Save to commit.
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Item Labels Section ----

interface ItemLabelsResponse {
  labOrganizationId: string;
  labels: Record<string, string>;
}

function ItemLabelsSection() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [labOrgId, setLabOrgId] = useState<string | undefined>(undefined);

  // Fetch current labels
  const labelsQuery = useQuery({
    queryKey: ["pricing", "item-labels", labOrgId],
    queryFn: () =>
      apiFetch<ItemLabelsResponse>(
        `/pricing/item-labels${labOrgId ? `?labOrganizationId=${labOrgId}` : ""}`,
      ),
    staleTime: 30_000,
  });

  // When data arrives, initialize the draft with server values
  const serverLabels = labelsQuery.data?.labels ?? {};
  useEffect(() => {
    if (labelsQuery.data && draft === null) {
      setDraft({ ...labelsQuery.data.labels });
    }
    // Store the resolved labOrgId so subsequent saves target the same lab
    if (labelsQuery.data?.labOrganizationId && !labOrgId) {
      setLabOrgId(labelsQuery.data.labOrganizationId);
    }
  }, [labelsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (labels: Record<string, string>) =>
      apiFetch<ItemLabelsResponse>("/pricing/item-labels", {
        method: "PUT",
        body: JSON.stringify({ labOrganizationId: labOrgId, labels }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(["pricing", "item-labels", labOrgId], data);
      setDraft({ ...data.labels });
      setToast({ ok: true, msg: "Item labels saved." });
      setTimeout(() => setToast(null), 3000);
    },
    onError: (err: any) => {
      setToast({ ok: false, msg: err?.message ?? "Failed to save labels." });
    },
  });

  function handleLabelChange(key: string, value: string) {
    setDraft((d) => ({ ...(d ?? {}), [key]: value }));
  }

  function handleReset(key: string) {
    // Reset to the static default by looking up the labelFor function
    const staticDefault = labelFor(key);
    setDraft((d) => ({ ...(d ?? {}), [key]: staticDefault }));
  }

  function handleSave() {
    if (!draft) return;
    saveMutation.mutate(draft);
  }

  if (labelsQuery.isLoading) {
    return (
      <div className="py-10 flex items-center justify-center text-muted-foreground text-sm gap-2">
        <Loader2 size={16} className="animate-spin" />
        Loading item labels…
      </div>
    );
  }

  if (labelsQuery.error) {
    const err = labelsQuery.error as ApiError;
    return (
      <div className="text-sm text-destructive bg-destructive/10 rounded-md px-4 py-3">
        {err.message}
      </div>
    );
  }

  const currentDraft = draft ?? serverLabels;
  const isDirty = Object.entries(currentDraft).some(
    ([k, v]) => v !== serverLabels[k],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Item labels</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Customize how each restoration type appears on invoices. The label
            is combined with the tooth number to produce the line-item
            description (e.g. "#30 Zirconia Crown" or "Upper Denture").
          </p>
        </div>
        <button
          type="button"
          disabled={!isDirty || saveMutation.isPending}
          onClick={handleSave}
          className="shrink-0 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {saveMutation.isPending ? (
            <span className="flex items-center gap-1.5">
              <Loader2 size={13} className="animate-spin" />
              Saving…
            </span>
          ) : (
            "Save all changes"
          )}
        </button>
      </div>

      {toast && (
        <div
          className={`flex items-center gap-2 text-sm rounded-md px-3 py-2 ${
            toast.ok
              ? "bg-green-50 text-green-700 border border-green-200"
              : "bg-destructive/10 text-destructive border border-destructive/20"
          }`}
        >
          {toast.ok && <CheckCircle2 size={14} />}
          {toast.msg}
        </div>
      )}

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/40">
              <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs uppercase tracking-wide w-48">
                Price key
              </th>
              <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Display label on invoices
              </th>
              <th className="px-3 py-2.5 w-28" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {DEFAULT_PRICE_KEYS.map((key) => {
              const current = currentDraft[key] ?? labelFor(key);
              const staticDefault = labelFor(key);
              const isModified = current !== staticDefault;
              return (
                <tr key={key} className="group hover:bg-secondary/20">
                  <td className="px-4 py-2 text-xs text-muted-foreground font-mono">
                    {key}
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="text"
                      value={current}
                      maxLength={200}
                      onChange={(e) => handleLabelChange(key, e.target.value)}
                      className="w-full h-8 px-2.5 rounded-md bg-transparent border border-transparent focus:border-input focus:bg-secondary focus:outline-none focus:ring-1 focus:ring-primary text-sm"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    {isModified ? (
                      <button
                        type="button"
                        onClick={() => handleReset(key)}
                        title={`Reset to default: "${staticDefault}"`}
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <RotateCcw size={11} />
                        Reset
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Changes take effect on newly generated invoices only. Existing invoice
        line items are not retroactively updated.
      </p>
    </div>
  );
}

function ResolutionOrderExplainer() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-4 rounded-lg border border-border bg-secondary/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-medium hover:bg-secondary/50 rounded-lg"
      >
        <span className="inline-flex items-center gap-2">
          <Layers size={14} className="text-primary" />
          How prices are resolved on a case
        </span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 text-xs text-muted-foreground space-y-1.5">
          <p className="text-foreground font-medium">
            For each restoration on a case, the unit price is picked in this
            order — the first match wins:
          </p>
          <ol className="list-decimal pl-5 space-y-1">
            <li>
              <span className="text-foreground">Manual unit price</span> —
              whatever a user typed directly on the restoration line.
            </li>
            <li>
              <span className="text-foreground">Practice tier</span> — the
              tier assigned to the case's provider organization
              (Practices → Pricing).
            </li>
            <li>
              <span className="text-foreground">Lab default tier</span> —
              the first/only tier on this lab, used when no per-practice tier
              is assigned.
            </li>
            <li>
              <span className="text-foreground">No price</span> — the
              restoration is left at $0 and shows as unmapped/unpriced in
              billed analytics.
            </li>
          </ol>
          <p className="pt-1">
            Restorations whose material doesn't match a known pricing key
            (e.g. a free-text "Custom" type) are flagged "unmapped" in the
            Billed tab — tier prices won't auto-apply to them.
          </p>
        </div>
      )}
    </div>
  );
}
