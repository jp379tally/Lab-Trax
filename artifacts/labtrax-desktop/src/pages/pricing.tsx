import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  History,
  Layers,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Stethoscope,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import type { LabCase, MeResponse } from "@/lib/types";
import { formatMoney } from "@/lib/format";

type Section = "billed" | "tiers" | "overrides";

interface PricingTier {
  id: string;
  labOrganizationId: string;
  name: string;
  prices: Record<string, number>;
}

interface PricingOverride {
  id: string;
  labOrganizationId: string;
  doctorName: string;
  practiceName: string | null;
  providerOrganizationId: string | null;
  prices: Record<string, number>;
  tierName: string | null;
  notes: string | null;
}

interface TiersResponse {
  labOrganizationId: string;
  keys: string[];
  tiers: PricingTier[];
}

interface OverridesResponse {
  labOrganizationId: string;
  keys: string[];
  overrides: PricingOverride[];
}

const PRICE_KEY_LABELS: Record<string, string> = {
  zirconia_crown: "Zirconia Crown",
  emax_crown: "E.max Crown",
  pfm_crown: "PFM Crown",
  denture: "Denture",
  partial: "Partial",
  implant: "Implant",
  night_guard_hard: "Night Guard - Hard",
  night_guard_soft: "Night Guard - Soft",
  night_guard_hard_soft: "Night Guard - Hard/Soft",
  retainer_hawley: "Retainer - Hawley",
  retainer_hard: "Retainer - Hard",
  retainer_lingual: "Retainer - Lingual",
  snore_guard: "Snore Guard",
  sports_guard: "Sports Guard",
};

function labelFor(key: string): string {
  return (
    PRICE_KEY_LABELS[key] ||
    key.replace(/_/g, " ").replace(/\b\w/g, (s) => s.toUpperCase())
  );
}

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
  const [section, setSection] = useState<Section>("billed");

  return (
    <div className="px-8 py-7">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pricing</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your lab's pricing tiers, per-doctor overrides, and what's
            currently being billed across cases.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-border mb-5 text-sm">
        <SectionTab
          active={section === "billed"}
          onClick={() => setSection("billed")}
          icon={<Tag size={14} />}
          label="Billed (live)"
        />
        <SectionTab
          active={section === "tiers"}
          onClick={() => setSection("tiers")}
          icon={<Layers size={14} />}
          label="Pricing tiers"
        />
        <SectionTab
          active={section === "overrides"}
          onClick={() => setSection("overrides")}
          icon={<Stethoscope size={14} />}
          label="Per-doctor overrides"
        />
      </div>

      {section === "billed" && <BilledSection />}
      {section === "tiers" && <TiersSection />}
      {section === "overrides" && <OverridesSection />}
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

// ---- Billed (existing read-only roll-up + bulk update) ----

interface PriceRow {
  key: string;
  restorationType: string;
  material: string;
  unitsBilled: number;
  caseCount: number;
  totalRevenue: number;
  avgPrice: number;
  minPrice: number;
  maxPrice: number;
}

type SortKey =
  | "restorationType"
  | "material"
  | "unitsBilled"
  | "caseCount"
  | "avgPrice"
  | "totalRevenue";

function BilledSection() {
  const casesQuery = useQuery({
    queryKey: ["cases", { include: "restorations" }],
    queryFn: () => apiFetch<LabCase[]>("/cases?include=restorations"),
  });

  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("totalRevenue");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [editing, setEditing] = useState<PriceRow | null>(null);

  const rows = useMemo<PriceRow[]>(() => {
    const cases = casesQuery.data ?? [];
    interface Bucket extends PriceRow {
      caseIds: Set<string>;
    }
    const map = new Map<string, Bucket>();
    for (const c of cases) {
      for (const r of c.restorations ?? []) {
        const type = (r.restorationType || "Other").trim();
        const material = (r.material || "—").trim() || "—";
        const key = `${type}|${material}`;
        const qty = Number(r.quantity ?? 0);
        const unit = Number(r.unitPrice ?? 0);
        const existing = map.get(key);
        if (existing) {
          existing.unitsBilled += qty;
          existing.totalRevenue += qty * unit;
          existing.caseIds.add(c.id);
          if (unit > 0 && unit < existing.minPrice) existing.minPrice = unit;
          if (unit > existing.maxPrice) existing.maxPrice = unit;
        } else {
          map.set(key, {
            key,
            restorationType: type,
            material,
            unitsBilled: qty,
            caseCount: 0,
            totalRevenue: qty * unit,
            avgPrice: 0,
            minPrice: unit > 0 ? unit : Number.POSITIVE_INFINITY,
            maxPrice: unit,
            caseIds: new Set([c.id]),
          });
        }
      }
    }
    const list: PriceRow[] = [];
    for (const v of map.values()) {
      const { caseIds, ...rest } = v;
      list.push({
        ...rest,
        caseCount: caseIds.size,
        avgPrice: v.unitsBilled > 0 ? v.totalRevenue / v.unitsBilled : 0,
        minPrice: Number.isFinite(v.minPrice) ? v.minPrice : 0,
      });
    }
    return list;
  }, [casesQuery.data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((r) => {
        if (!q) return true;
        return (
          r.restorationType.toLowerCase().includes(q) ||
          r.material.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const va = a[sortKey];
        const vb = b[sortKey];
        if (typeof va === "number" && typeof vb === "number") {
          return sortDir === "asc" ? va - vb : vb - va;
        }
        return sortDir === "asc"
          ? String(va).localeCompare(String(vb))
          : String(vb).localeCompare(String(va));
      });
  }, [rows, search, sortKey, sortDir]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  }
  function SortHeader({
    k,
    children,
    align = "left",
  }: {
    k: SortKey;
    children: React.ReactNode;
    align?: "left" | "right";
  }) {
    return (
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className={`inline-flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground font-medium hover:text-foreground ${
          align === "right" ? "justify-end" : ""
        }`}
      >
        {children}
        {sortKey === k &&
          (sortDir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
      </button>
    );
  }

  const isLoading = casesQuery.isLoading;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search restoration or material…"
            className="w-full h-9 pl-8 pr-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Click any row to retroactively set a unit price on every matching
          restoration in your cases.
        </p>
        <div className="ml-auto text-sm text-muted-foreground">
          {filtered.length} of {rows.length}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-secondary/40">
              <th className="text-left px-5 py-2.5">
                <SortHeader k="restorationType">Restoration</SortHeader>
              </th>
              <th className="text-left py-2.5">
                <SortHeader k="material">Material</SortHeader>
              </th>
              <th className="text-right py-2.5">
                <SortHeader k="unitsBilled" align="right">
                  Units
                </SortHeader>
              </th>
              <th className="text-right py-2.5">
                <SortHeader k="caseCount" align="right">
                  Cases
                </SortHeader>
              </th>
              <th className="text-right py-2.5">
                <SortHeader k="avgPrice" align="right">
                  Avg unit
                </SortHeader>
              </th>
              <th className="text-right py-2.5">Range</th>
              <th className="text-right py-2.5">
                <SortHeader k="totalRevenue" align="right">
                  Revenue
                </SortHeader>
              </th>
              <th className="px-5 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td
                  colSpan={8}
                  className="px-5 py-12 text-center text-muted-foreground"
                >
                  <Loader2 size={16} className="inline animate-spin mr-2" />
                  Loading pricing…
                </td>
              </tr>
            )}
            {!isLoading && filtered.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="px-5 py-12 text-center text-muted-foreground"
                >
                  No restorations have been priced yet.
                </td>
              </tr>
            )}
            {filtered.map((r) => (
              <tr
                key={r.key}
                onClick={() => setEditing(r)}
                className="border-t border-border hover:bg-secondary/40 cursor-pointer"
              >
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2.5">
                    <div className="h-7 w-7 rounded-md bg-primary/10 text-primary flex items-center justify-center">
                      <Tag size={13} />
                    </div>
                    <div className="font-medium">{r.restorationType}</div>
                  </div>
                </td>
                <td className="py-3 text-muted-foreground">{r.material}</td>
                <td className="py-3 text-right tabular-nums">{r.unitsBilled}</td>
                <td className="py-3 text-right tabular-nums">{r.caseCount}</td>
                <td className="py-3 text-right tabular-nums font-medium">
                  {formatMoney(r.avgPrice)}
                </td>
                <td className="py-3 text-right tabular-nums text-xs text-muted-foreground">
                  {r.minPrice > 0
                    ? `${formatMoney(r.minPrice)} – ${formatMoney(r.maxPrice)}`
                    : "—"}
                </td>
                <td className="py-3 text-right tabular-nums">
                  {formatMoney(r.totalRevenue)}
                </td>
                <td className="px-5 py-3 text-right">
                  <span className="inline-flex items-center gap-1 text-xs text-primary">
                    <Pencil size={11} /> Edit
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <BilledEditor row={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function BilledEditor({
  row,
  onClose,
}: {
  row: PriceRow;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [unitPrice, setUnitPrice] = useState<string>(row.avgPrice.toFixed(2));
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<number | null>(null);

  useEffect(() => {
    setUnitPrice(row.avgPrice.toFixed(2));
    setError(null);
    setSuccess(null);
  }, [row.key, row.avgPrice]);

  const mutation = useMutation({
    mutationFn: async () => {
      const value = Number(unitPrice);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error("Unit price must be a non-negative number.");
      }
      return apiFetch<{ updated: number }>(`/cases/restorations/pricing`, {
        method: "PATCH",
        body: JSON.stringify({
          restorationType: row.restorationType,
          material: row.material === "—" ? null : row.material,
          unitPrice: value,
        }),
      });
    },
    onSuccess: (res) => {
      setSuccess(res.updated);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["cases"] });
    },
    onError: (err: Error) => {
      setSuccess(null);
      setError(err.message || "Could not update pricing.");
    },
  });

  return (
    <SidePanel
      title={`${row.restorationType} · ${row.material}`}
      subtitle="Set unit price"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
          >
            {mutation.isPending ? "Updating…" : "Update price"}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3 text-sm">
        <Stat label="Current avg" value={formatMoney(row.avgPrice)} />
        <Stat
          label="Range"
          value={
            row.minPrice > 0
              ? `${formatMoney(row.minPrice)} – ${formatMoney(row.maxPrice)}`
              : "—"
          }
        />
        <Stat label="Units" value={String(row.unitsBilled)} />
        <Stat label="Cases" value={String(row.caseCount)} />
      </div>

      <div>
        <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
          New unit price
        </label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">$</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={unitPrice}
            onChange={(e) => setUnitPrice(e.target.value)}
            className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm tabular-nums"
          />
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Updates every restoration with this type and material across every
          case in your lab(s) you administer.
        </p>
      </div>

      {error && (
        <div className="text-sm rounded-md px-3 py-2 bg-destructive/10 text-destructive">
          {error}
        </div>
      )}
      {success !== null && (
        <div className="text-sm rounded-md px-3 py-2 bg-success/15 text-success">
          Updated {success} restoration{success === 1 ? "" : "s"}.
        </div>
      )}
    </SidePanel>
  );
}

// ---- Tiers ----

function TiersSection() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PricingTier | null>(null);

  const tiersQuery = useQuery({
    queryKey: ["pricing", "tiers"],
    queryFn: () => apiFetch<TiersResponse>("/pricing/tiers"),
    retry: false,
  });

  const tiers = tiersQuery.data?.tiers ?? [];
  const keys = tiersQuery.data?.keys ?? [];

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
          Tiers are price lists you can assign to client practices. Per-doctor
          overrides take precedence over tiers.
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-semibold inline-flex items-center gap-1.5 hover:bg-primary/90"
        >
          <Plus size={14} /> New tier
        </button>
      </div>

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
                    <span className="text-muted-foreground">{labelFor(k)}</span>
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
          onClose={() => setCreating(false)}
        />
      )}
      {editing && (
        <TierEditor
          mode="edit"
          keys={keys}
          tier={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function TierEditor({
  mode,
  keys,
  tier,
  onClose,
}: {
  mode: "create" | "edit";
  keys: string[];
  tier: PricingTier | null;
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

      <div>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
          Item prices
        </div>
        <div className="space-y-2">
          {keys.map((k) => (
            <PriceField
              key={k}
              label={labelFor(k)}
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

// ---- Overrides ----

function OverridesSection() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PricingOverride | null>(null);
  const [search, setSearch] = useState("");

  const meQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch<MeResponse>("/auth/me"),
  });
  const overridesQuery = useQuery({
    queryKey: ["pricing", "overrides"],
    queryFn: () => apiFetch<OverridesResponse>("/pricing/overrides"),
    retry: false,
  });

  const items = overridesQuery.data?.overrides ?? [];
  const keys = overridesQuery.data?.keys ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (o) =>
        o.doctorName.toLowerCase().includes(q) ||
        (o.practiceName || "").toLowerCase().includes(q)
    );
  }, [items, search]);

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/pricing/overrides/${id}`, { method: "DELETE" }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["pricing", "overrides"] }),
  });

  // role check via memberships
  const isAdmin = (meQuery.data?.memberships ?? []).some(
    (m) =>
      m.status === "active" &&
      m.organization?.type === "lab" &&
      (m.role === "owner" || m.role === "admin")
  );

  if (overridesQuery.isLoading) {
    return (
      <div className="text-sm text-muted-foreground py-12 text-center">
        <Loader2 size={16} className="inline animate-spin mr-2" />
        Loading overrides…
      </div>
    );
  }
  if (overridesQuery.error) {
    const err = overridesQuery.error as ApiError;
    return (
      <div className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
        {err.message}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by doctor or practice…"
            className="w-full h-9 pl-8 pr-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
          />
        </div>
        <div className="text-xs text-muted-foreground flex-1">
          Per-doctor prices override your tiers when new restorations are
          billed.
        </div>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-semibold inline-flex items-center gap-1.5 hover:bg-primary/90"
          >
            <Plus size={14} /> New override
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="bg-card border border-border rounded-xl py-14 text-center">
          <Stethoscope
            size={28}
            className="inline text-muted-foreground/50 mb-3"
          />
          <div className="text-sm font-medium">
            {items.length === 0 ? "No overrides yet" : "No matches"}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {items.length === 0
              ? "Add a per-doctor override to give a specific doctor or practice their own pricing."
              : "Try a different search."}
          </div>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="text-left px-5 py-2.5 font-medium">Doctor</th>
                <th className="text-left py-2.5 font-medium">Practice</th>
                <th className="text-right py-2.5 font-medium">Items priced</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => (
                <tr
                  key={o.id}
                  onClick={() => setEditing(o)}
                  className="border-t border-border hover:bg-secondary/40 cursor-pointer"
                >
                  <td className="px-5 py-3 font-medium">{o.doctorName}</td>
                  <td className="py-3 text-muted-foreground">
                    {o.practiceName || "—"}
                  </td>
                  <td className="py-3 text-right tabular-nums">
                    {Object.values(o.prices).filter((v) => Number(v) > 0).length}{" "}
                    / {keys.length}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="inline-flex items-center gap-1">
                      <span className="text-xs text-primary">
                        <Pencil size={11} className="inline mr-1" />
                        Edit
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (
                            window.confirm(
                              `Remove override for ${o.doctorName}?`,
                            )
                          ) {
                            deleteMutation.mutate(o.id);
                          }
                        }}
                        className="h-7 w-7 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive flex items-center justify-center ml-1"
                        aria-label="Delete override"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <OverrideEditor
          mode="create"
          keys={keys}
          override={null}
          onClose={() => setCreating(false)}
        />
      )}
      {editing && (
        <OverrideEditor
          mode="edit"
          keys={keys}
          override={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function OverrideEditor({
  mode,
  keys,
  override,
  onClose,
}: {
  mode: "create" | "edit";
  keys: string[];
  override: PricingOverride | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [doctorName, setDoctorName] = useState(override?.doctorName ?? "");
  const [practiceName, setPracticeName] = useState(
    override?.practiceName ?? ""
  );
  const [tierName, setTierName] = useState<string>(override?.tierName ?? "");
  const [notes, setNotes] = useState(override?.notes ?? "");

  const tiersQuery = useQuery({
    queryKey: ["pricing", "tiers"],
    queryFn: () => apiFetch<TiersResponse>("/pricing/tiers"),
  });
  const availableTiers = tiersQuery.data?.tiers ?? [];
  const [prices, setPrices] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const k of keys) {
      const v = Number(override?.prices?.[k] ?? 0);
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
    () => diffPrices(override?.prices ?? {}, nextPrices),
    [override, nextPrices]
  );

  const metaChanges = useMemo(() => {
    const m: { label: string; before: string; after: string }[] = [];
    if (mode !== "edit" || !override) return m;
    const trimmedPractice = practiceName.trim();
    if ((override.practiceName ?? "") !== trimmedPractice) {
      m.push({
        label: "Practice",
        before: override.practiceName ?? "",
        after: trimmedPractice,
      });
    }
    const trimmedNotes = notes.trim();
    if ((override.notes ?? "") !== trimmedNotes) {
      m.push({
        label: "Notes",
        before: override.notes ?? "",
        after: trimmedNotes,
      });
    }
    return m;
  }, [mode, override, practiceName, notes]);

  const restoreTargetPrices = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(restoring?.afterPrices ?? {})) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[k] = n;
    }
    return out;
  }, [restoring]);

  const restoreDiff = useMemo(
    () => diffPrices(override?.prices ?? {}, restoreTargetPrices),
    [override, restoreTargetPrices]
  );

  const restoreMetaChanges = useMemo(() => {
    const m: { label: string; before: string; after: string }[] = [];
    if (!restoring || !override) return m;
    const targetPractice =
      restoring.afterPracticeName ?? override.practiceName ?? "";
    if ((override.practiceName ?? "") !== (targetPractice ?? "")) {
      m.push({
        label: "Practice",
        before: override.practiceName ?? "",
        after: targetPractice ?? "",
      });
    }
    const targetNotes = restoring.afterNotes ?? override.notes ?? "";
    if ((override.notes ?? "") !== (targetNotes ?? "")) {
      m.push({
        label: "Notes",
        before: override.notes ?? "",
        after: targetNotes ?? "",
      });
    }
    return m;
  }, [restoring, override]);

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        doctorName: doctorName.trim(),
        practiceName: practiceName.trim() || null,
        tierName: tierName.trim() ? tierName.trim() : null,
        notes: notes.trim() || null,
        prices: nextPrices,
      };
      if (mode === "create") {
        return apiFetch<PricingOverride>("/pricing/overrides", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }
      return apiFetch<PricingOverride>(`/pricing/overrides/${override!.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pricing", "overrides"] });
      queryClient.invalidateQueries({ queryKey: ["pricing", "history"] });
      setConfirming(false);
      onClose();
    },
    onError: (err: Error) => {
      setError(err.message || "Could not save override.");
      setConfirming(false);
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async () => {
      if (!override || !restoring) throw new Error("Nothing to restore.");
      const payload: Record<string, unknown> = {
        practiceName:
          (restoring.afterPracticeName ?? override.practiceName ?? null) ||
          null,
        notes: (restoring.afterNotes ?? override.notes ?? null) || null,
        prices: restoreTargetPrices,
      };
      return apiFetch<PricingOverride>(`/pricing/overrides/${override.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pricing", "overrides"] });
      queryClient.invalidateQueries({ queryKey: ["pricing", "history"] });
      setRestoring(null);
      onClose();
    },
    onError: (err: Error) => {
      setError(err.message || "Could not restore override.");
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
      title={
        mode === "create" ? "New per-doctor override" : `Edit ${override?.doctorName}`
      }
      subtitle="Per-doctor pricing"
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
            disabled={mutation.isPending || !doctorName.trim()}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
          >
            {mutation.isPending
              ? "Saving…"
              : mode === "edit"
                ? "Review & save"
                : "Save override"}
          </button>
        </>
      }
    >
      <div>
        <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
          Doctor name
        </label>
        <input
          type="text"
          value={doctorName}
          onChange={(e) => setDoctorName(e.target.value)}
          placeholder="Dr. Aris"
          className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
          disabled={mode === "edit"}
        />
        {mode === "edit" && (
          <p className="text-xs text-muted-foreground mt-1">
            Doctor name can't be changed once an override exists. Delete and
            recreate to reassign.
          </p>
        )}
      </div>

      <div>
        <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
          Practice (optional)
        </label>
        <input
          type="text"
          value={practiceName}
          onChange={(e) => setPracticeName(e.target.value)}
          placeholder="Elite Dental Group"
          className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
        />
      </div>

      <div>
        <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
          Assigned tier (optional)
        </label>
        <select
          value={tierName}
          onChange={(e) => setTierName(e.target.value)}
          className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
        >
          <option value="">— Use practice default / first tier —</option>
          {availableTiers.map((t) => (
            <option key={t.id} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground mt-1">
          Per-item prices below still take precedence. Use this to put a doctor
          on a specific tier without setting every price.
        </p>
      </div>

      <div>
        <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
          Notes (optional)
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="w-full px-2.5 py-2 rounded-md bg-background border border-input text-sm"
        />
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
          Item prices
        </div>
        <div className="space-y-2">
          {keys.map((k) => (
            <PriceField
              key={k}
              label={labelFor(k)}
              value={prices[k] ?? ""}
              onChange={(v) => setPrices((p) => ({ ...p, [k]: v }))}
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Leave a row blank to fall back to this doctor's tier (or the default).
        </p>
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

      {mode === "edit" && override && (
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
                endpoint={`/pricing/overrides/${override.id}/history`}
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
          title={
            override
              ? `${override.doctorName} (per-doctor override)`
              : "Per-doctor override"
          }
          diff={diff}
          metaChanges={metaChanges}
          isPending={mutation.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => mutation.mutate()}
        />
      )}

      {restoring && override && (
        <ConfirmChangesDialog
          title={`Restore ${override.doctorName} to ${formatRelativeDate(restoring.createdAt)}`}
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

function PriceField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="text-sm text-muted-foreground flex-1">{label}</div>
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">$</span>
        <input
          type="number"
          min="0"
          step="0.01"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0.00"
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-secondary/40 rounded-md px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
        {label}
      </div>
      <div className="text-sm font-medium tabular-nums mt-0.5">{value}</div>
    </div>
  );
}
