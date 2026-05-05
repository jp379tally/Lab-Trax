import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Loader2, Pencil, Search, Tag, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { LabCase } from "@/lib/types";
import { formatMoney } from "@/lib/format";

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

type SortKey = "restorationType" | "material" | "unitsBilled" | "caseCount" | "avgPrice" | "totalRevenue";

export default function PricingPage() {
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
        return r.restorationType.toLowerCase().includes(q) || r.material.toLowerCase().includes(q);
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
  function SortHeader({ k, children, align = "left" }: { k: SortKey; children: React.ReactNode; align?: "left" | "right" }) {
    return (
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className={`inline-flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground font-medium hover:text-foreground ${align === "right" ? "justify-end" : ""}`}
      >
        {children}
        {sortKey === k && (sortDir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
      </button>
    );
  }

  const isLoading = casesQuery.isLoading;

  return (
    <div className="px-8 py-7">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pricing</h1>
          <p className="text-sm text-muted-foreground mt-1">
            What every restoration type & material is actually billing for, rolled up across cases.
          </p>
        </div>
        <div className="text-sm text-muted-foreground">{filtered.length} of {rows.length}</div>
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search restoration or material…"
              className="w-full h-9 pl-8 pr-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Click any row to set a new unit price across every matching restoration.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40">
                <th className="text-left px-5 py-2.5"><SortHeader k="restorationType">Restoration</SortHeader></th>
                <th className="text-left py-2.5"><SortHeader k="material">Material</SortHeader></th>
                <th className="text-right py-2.5"><SortHeader k="unitsBilled" align="right">Units</SortHeader></th>
                <th className="text-right py-2.5"><SortHeader k="caseCount" align="right">Cases</SortHeader></th>
                <th className="text-right py-2.5"><SortHeader k="avgPrice" align="right">Avg unit</SortHeader></th>
                <th className="text-right py-2.5">Range</th>
                <th className="text-right py-2.5"><SortHeader k="totalRevenue" align="right">Revenue</SortHeader></th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center text-muted-foreground">
                    <Loader2 size={16} className="inline animate-spin mr-2" />
                    Loading pricing…
                  </td>
                </tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center text-muted-foreground">
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
                  <td className="py-3 text-right tabular-nums font-medium">{formatMoney(r.avgPrice)}</td>
                  <td className="py-3 text-right tabular-nums text-xs text-muted-foreground">
                    {r.minPrice > 0 ? `${formatMoney(r.minPrice)} – ${formatMoney(r.maxPrice)}` : "—"}
                  </td>
                  <td className="py-3 text-right tabular-nums">{formatMoney(r.totalRevenue)}</td>
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
      </div>

      {editing && <PricingEditor row={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function PricingEditor({ row, onClose }: { row: PriceRow; onClose: () => void }) {
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
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-foreground/30" onClick={onClose} />
      <aside className="w-full max-w-[460px] bg-card border-l border-border h-full flex flex-col">
        <header className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <div className="text-xs text-muted-foreground">Set unit price</div>
            <div className="text-sm font-semibold">
              {row.restorationType} · {row.material}
            </div>
          </div>
          <button type="button" onClick={onClose} className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center" aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Stat label="Current avg" value={formatMoney(row.avgPrice)} />
            <Stat label="Range" value={row.minPrice > 0 ? `${formatMoney(row.minPrice)} – ${formatMoney(row.maxPrice)}` : "—"} />
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
              Updates every restoration with this type and material across every case in your lab(s) you administer.
            </p>
          </div>

          {error && (
            <div className="text-sm rounded-md px-3 py-2 bg-destructive/10 text-destructive">{error}</div>
          )}
          {success !== null && (
            <div className="text-sm rounded-md px-3 py-2 bg-success/15 text-success">
              Updated {success} restoration{success === 1 ? "" : "s"}.
            </div>
          )}
        </div>

        <footer className="px-6 py-4 border-t border-border flex items-center justify-end gap-2">
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
        </footer>
      </aside>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-secondary/40 rounded-md px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">{label}</div>
      <div className="text-sm font-medium tabular-nums mt-0.5">{value}</div>
    </div>
  );
}
