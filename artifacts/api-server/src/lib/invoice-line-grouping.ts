import { calculateLineTotal } from "./case";

/**
 * A single invoice line item produced by the grouping helpers. Shared by the
 * `syncInvoiceFromRestorations` path (real, persisting) and the read-only
 * draft-invoice preview endpoint so both render identical lines from the same
 * pure code. No DB or network access — given the same restoration rows it
 * always returns the same line items.
 */
export interface SyncLineItem {
  caseRestorationId: string | null;
  toothNumber: number | null;
  toothLabel: string | null;
  description: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
}

export function parseToothInt(toothNumber: string): number | null {
  const n = parseInt(toothNumber, 10);
  return Number.isInteger(n) && n >= 1 && n <= 32 ? n : null;
}

export function buildBasicDescription(
  r: { restorationType: string; toothNumber: string; material?: string | null },
  noChargeRemake: boolean,
): string {
  // The alloy surcharge isn't tied to a tooth — render it as a plain "Alloy"
  // line instead of "Alloy - Tooth N/A".
  if (r.restorationType.trim().toLowerCase() === "alloy") {
    return noChargeRemake ? "Alloy (no-charge remake)" : "Alloy";
  }
  const base = r.material
    ? `${r.material} ${r.restorationType} - Tooth ${r.toothNumber}`
    : `${r.restorationType} - Tooth ${r.toothNumber}`;
  return noChargeRemake ? `${base} (no-charge remake)` : base;
}

/**
 * Group restoration rows by (restorationType, material) for the
 * `syncInvoiceFromRestorations` path where no label cache is available.
 * Produces SyncLineItems with toothLabel populated for multi-tooth groups.
 */
export function buildGroupedSyncItems(
  restorations: Array<{
    id: string;
    toothNumber: string;
    restorationType: string;
    material: string | null;
    quantity: number;
    unitPrice: string;
  }>,
  noChargeRemake: boolean,
): SyncLineItem[] {
  type Group = { rows: typeof restorations };
  const groupMap = new Map<string, Group>();
  const order: string[] = [];

  for (const r of restorations) {
    const key = `${(r.material ?? "").toLowerCase()}::${r.restorationType.toLowerCase()}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, { rows: [] });
      order.push(key);
    }
    groupMap.get(key)!.rows.push(r);
  }

  const items: SyncLineItem[] = [];

  for (const key of order) {
    const { rows } = groupMap.get(key)!;
    const first = rows[0]!;

    if (rows.length === 1) {
      items.push({
        caseRestorationId: first.id,
        toothNumber: parseToothInt(first.toothNumber),
        toothLabel: null,
        description: buildBasicDescription(first, noChargeRemake),
        quantity: first.quantity,
        unitPrice: noChargeRemake ? "0.00" : first.unitPrice,
        lineTotal: noChargeRemake
          ? "0.00"
          : calculateLineTotal(first.quantity, first.unitPrice),
      });
    } else {
      const qty = rows.reduce((s, r) => s + r.quantity, 0);
      const teeth = rows
        .map((r) => parseInt(r.toothNumber, 10))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 32)
        .sort((a, b) => a - b);
      const toothLabel = teeth.length > 0 ? teeth.join(", ") : null;
      const matLabel = first.material ? `${first.material} ` : "";
      const baseDesc = `${matLabel}${first.restorationType}`;
      const description = noChargeRemake ? `${baseDesc} (no-charge remake)` : baseDesc;
      const unitPrice = noChargeRemake ? "0.00" : first.unitPrice;
      items.push({
        caseRestorationId: first.id,
        toothNumber: null,
        toothLabel,
        description,
        quantity: qty,
        unitPrice,
        lineTotal: noChargeRemake ? "0.00" : calculateLineTotal(qty, first.unitPrice),
      });
    }
  }

  return items;
}

/**
 * Parse comma-separated connector pairs string ("13-14,14-15") into a Set of
 * normalised `"lo-hi"` pair keys.
 */
export function parseConnectors(value: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!value) return out;
  for (const part of value.split(",")) {
    const [a, b] = part.trim().split("-").map((s) => s.trim());
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na > 0 && nb > 0) {
      out.add(na < nb ? `${na}-${nb}` : `${nb}-${na}`);
    }
  }
  return out;
}

/**
 * Find connected components in a set of pair edges. Returns an array of sets
 * where each set is a group of tooth numbers that form a connected span.
 */
export function findConnectedComponents(
  toothNumbers: number[],
  connectorPairs: Set<string>,
): number[][] {
  const parent = new Map<number, number>();
  for (const n of toothNumbers) parent.set(n, n);

  function find(x: number): number {
    const p = parent.get(x);
    if (p === undefined || p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  }

  function union(x: number, y: number) {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  }

  for (const pair of connectorPairs) {
    const [as, bs] = pair.split("-");
    const a = Number(as);
    const b = Number(bs);
    if (parent.has(a) && parent.has(b)) {
      union(a, b);
    }
  }

  const groups = new Map<number, number[]>();
  for (const n of toothNumbers) {
    const root = find(n);
    const group = groups.get(root) ?? [];
    group.push(n);
    groups.set(root, group);
  }
  return Array.from(groups.values()).map((g) => g.sort((a, b) => a - b));
}

/**
 * Build invoice line items, collapsing bridge spans into single items when
 * the case has connector data. Falls back to same-material grouping when
 * there are no connectors or no bridge patterns are found.
 */
export function buildBridgeAwareLineItems(
  restorations: Array<{
    id: string;
    toothNumber: string;
    restorationType: string;
    material: string | null;
    quantity: number;
    unitPrice: string;
  }>,
  bridgeConnectors: string | null,
  noChargeRemake: boolean,
): SyncLineItem[] {
  const connectors = parseConnectors(bridgeConnectors);

  // No connector data: group same-material/same-type restorations so that
  // e.g. 6 individual PFM Crowns collapse into one line item.
  if (connectors.size === 0) {
    return buildGroupedSyncItems(restorations, noChargeRemake);
  }

  // Map restoration by numeric tooth number for quick lookup.
  const byTooth = new Map<number, typeof restorations[0]>();
  const nonNumeric: typeof restorations = [];
  for (const r of restorations) {
    const num = Number(r.toothNumber.trim());
    if (Number.isInteger(num) && num >= 1 && num <= 32) {
      byTooth.set(num, r);
    } else {
      nonNumeric.push(r);
    }
  }

  const numericTeeth = Array.from(byTooth.keys());
  const components = findConnectedComponents(numericTeeth, connectors);

  // Identify which components form a bridge: must have ≥2 teeth and at least
  // one "Pontic" restoration type within the span.
  const usedRestorationIds = new Set<string>();
  const items: SyncLineItem[] = [];

  for (const group of components) {
    if (group.length < 2) continue;

    const groupRestorations = group.flatMap((n) => {
      const r = byTooth.get(n);
      return r ? [r] : [];
    });
    const hasPontic = groupRestorations.some((r) =>
      /pontic/i.test(r.restorationType),
    );
    if (!hasPontic) continue;

    // This span is a bridge. Collapse into one line item.
    const lo = group[0]!;
    const hi = group[group.length - 1]!;
    const units = groupRestorations.reduce((s, r) => s + r.quantity, 0);
    // Use the material from the first crown/abutment restoration in the group.
    const abutment = groupRestorations.find(
      (r) => !/pontic/i.test(r.restorationType),
    );
    const material = abutment?.material ?? groupRestorations[0]?.material ?? null;
    const totalUnitPrice = groupRestorations.reduce(
      (s, r) => s + Number(r.unitPrice),
      0,
    );
    const avgUnitPrice = groupRestorations.length > 0
      ? totalUnitPrice / groupRestorations.length
      : 0;

    const matLabel = material ? `${material} ` : "";
    const bridgeDesc = `#${lo}-${hi} ${matLabel}Bridge – ${units} unit${units !== 1 ? "s" : ""}`;
    const finalDesc = noChargeRemake ? `${bridgeDesc} (no-charge remake)` : bridgeDesc;

    const perUnitStr = noChargeRemake ? "0.00" : avgUnitPrice.toFixed(2);
    const lineTotal = noChargeRemake ? "0.00" : calculateLineTotal(units, perUnitStr);

    items.push({
      caseRestorationId: abutment?.id ?? groupRestorations[0]?.id ?? null,
      toothNumber: null,
      toothLabel: null,
      description: finalDesc,
      quantity: units,
      unitPrice: perUnitStr,
      lineTotal,
    });

    for (const r of groupRestorations) usedRestorationIds.add(r.id);
  }

  // Any restoration not consumed by a bridge span: apply same-material
  // grouping so individual crowns of the same material collapse too.
  const unconsumedBridge = restorations.filter((r) => !usedRestorationIds.has(r.id));
  const ungrouped = buildGroupedSyncItems(unconsumedBridge, noChargeRemake);
  items.push(...ungrouped);

  return items;
}
