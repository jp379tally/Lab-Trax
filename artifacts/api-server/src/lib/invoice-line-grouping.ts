import { calculateLineTotal } from "./case";
import { archLabel, type Arch } from "./arch-billing";
import {
  parseConnectorState,
  toothAssignmentSummary,
  validateToothConnectors,
} from "@workspace/case-taxonomy";

import {
  isPfmOrFcmMaterial,
  isPfzMaterial,
  LAYERED_PORCELAIN_DESCRIPTION,
  LAYERED_PORCELAIN_SURCHARGE,
} from "./material-mapping";

/**
 * A lightweight child item emitted alongside a parent line. Used for:
 *   - PFZ: the $37 layered-porcelain surcharge.
 *   - PFM/FCM: a $0 alloy sub-item that needs manual pricing after case create.
 *
 * Callers that persist to the DB insert these with `parentLineItemId` pointing
 * to the just-inserted parent row. Callers that return preview data include
 * these as `subItems` in the response.
 */
export interface SyncLineItemChild {
  caseRestorationId?: string | null;
  description: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  arch?: string | null;
  /**
   * False when no price has been resolved (e.g. per-tooth alloy rows always
   * start at $0 and must be manually priced after case creation).
   * Absent/undefined = the price is valid.
   */
  priced?: boolean;
}

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
  arch?: string | null;
  /**
   * Every source restoration id collapsed into this line (a single-tooth line
   * has one; a grouped/bridge line has many). The draft-invoice preview uses
   * this to map a user's inline price edit on a line back to the exact source
   * restorations, so the override flows into case creation 1:1.
   */
  groupedRestorationIds: string[];
  /**
   * Child sub-items that must be inserted after the parent with
   * `parentLineItemId`. Currently populated only for PFZ (porcelain fused to
   * zirconia) restorations to carry the $37 layered-porcelain surcharge.
   * Absent (or empty) for all other material types.
   */
  childItems?: SyncLineItemChild[];
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
 * Build the layered-porcelain child sub-item for a PFZ parent line.
 * Returns an empty array when `noChargeRemake` is true (all lines are $0).
 */
function buildPfzChildItems(noChargeRemake: boolean): SyncLineItemChild[] {
  if (noChargeRemake) return [];
  return [
    {
      description: LAYERED_PORCELAIN_DESCRIPTION,
      quantity: 1,
      unitPrice: LAYERED_PORCELAIN_SURCHARGE,
      lineTotal: LAYERED_PORCELAIN_SURCHARGE,
    },
  ];
}

/**
 * Group restoration rows by (restorationType, material) for the
 * `syncInvoiceFromRestorations` path where no label cache is available.
 * Produces SyncLineItems with toothLabel populated for multi-tooth groups.
 *
 * The following restoration types are NEVER collapsed into multi-tooth groups
 * — each tooth always gets its own invoice line:
 *
 * - PFZ ("Porcelain Fused to Zirconia"): each tooth gets a $37 Layered
 *   Porcelain child sub-item.
 * - PFM / Full Contour Metal (FCM): each tooth can carry its own $0 Alloy
 *   child sub-item (matched from alloy rows by tooth number).
 * - Flippers (restorationSubtype "Removable/flippers"): each tooth is a
 *   separate physical appliance and must stay as its own line.
 *
 * Alloy surcharge rows with a valid tooth number are NOT emitted as top-level
 * lines — they are attached as $0 child sub-items under the matching PFM/FCM
 * parent. Alloy rows without a real tooth number (legacy "N/A" rows) are
 * emitted as top-level lines for backward compatibility.
 */
export function buildGroupedSyncItems(
  restorations: Array<{
    id: string;
    toothNumber: string;
    restorationType: string;
    restorationSubtype?: string | null;
    arch?: string | null;
    material: string | null;
    quantity: number;
    unitPrice: string;
  }>,
  noChargeRemake: boolean,
): SyncLineItem[] {
  const expandedRestorations = restorations.flatMap((r) =>
    r.arch === "upper_lower"
      ? [
          { ...r, id: `${r.id}:upper`, arch: "upper" as const },
          { ...r, id: `${r.id}:lower`, arch: "lower" as const },
        ]
      : [r],
  );
  restorations = expandedRestorations;
  // ── Step 1: separate per-tooth alloy rows ─────────────────────────────────
  // Alloy rows with a valid numeric tooth number are candidates for sub-item
  // attachment under the matching PFM/FCM parent. Legacy "N/A" alloy rows fall
  // through to top-level rendering for backward compatibility.
  const alloyByTooth = new Map<string, (typeof restorations)[0]>();
  const legacyAlloyRows: (typeof restorations)[0][] = [];
  const mainRestorations: (typeof restorations)[0][] = [];

  for (const r of restorations) {
    if (r.restorationType.trim().toLowerCase() === "alloy") {
      const tooth = (r.toothNumber ?? "").trim();
      if (tooth && tooth !== "N/A" && /^\d+$/.test(tooth)) {
        alloyByTooth.set(tooth, r);
      } else {
        legacyAlloyRows.push(r);
      }
    } else {
      mainRestorations.push(r);
    }
  }

  // ── Step 2: build ordered entry list for main (non-alloy) restorations ────
  type OrderEntry =
    | { kind: "group"; key: string }
    | { kind: "pfz"; r: (typeof mainRestorations)[0] }
    | { kind: "pfm"; r: (typeof mainRestorations)[0] }
    | { kind: "flipper"; r: (typeof mainRestorations)[0] };
  type Group = { rows: typeof mainRestorations };

  const groupMap = new Map<string, Group>();
  const order: OrderEntry[] = [];

  for (const r of mainRestorations) {
    if (isPfzMaterial(r.material)) {
      // PFZ: always emit as a singleton so each tooth gets its own $37 child.
      order.push({ kind: "pfz", r });
    } else if (isPfmOrFcmMaterial(r.material)) {
      // PFM/FCM: always emit as a singleton so each tooth can carry its own
      // Alloy child sub-item at $0 (looked up from alloyByTooth below).
      order.push({ kind: "pfm", r });
    } else if ((r.restorationSubtype ?? "").split("/")[1] === "flippers") {
      // Flipper: each tooth is a separate physical appliance — never group.
      // restorationSubtype is stored as "Removable/flippers" (caseType/subtype).
      order.push({ kind: "flipper", r });
    } else {
      // Independent tooth units keep their own catalog/tier/manual quotes.
      // A connector edit must never replace one unit's quote with a neighbor's.
      const toothQuoteKey = /^(crown|pontic)$/i.test(r.restorationType)
        ? `::${r.restorationSubtype ?? ""}::${Number(r.unitPrice)}` : "";
      const key = `${(r.material ?? "").toLowerCase()}::${r.restorationType.toLowerCase()}::${r.arch ?? ""}${toothQuoteKey}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, { rows: [] });
        order.push({ kind: "group", key });
      }
      groupMap.get(key)!.rows.push(r);
    }
  }

  // ── Step 3: emit line items ───────────────────────────────────────────────
  const items: SyncLineItem[] = [];

  for (const entry of order) {
    if (entry.kind === "pfz") {
      const r = entry.r;
      items.push({
        caseRestorationId: r.id,
        toothNumber: parseToothInt(r.toothNumber),
        toothLabel: null,
        description: `${buildBasicDescription(r, noChargeRemake)}${archLabel(r.arch as Arch) ? ` - ${archLabel(r.arch as Arch)}` : ""}`,
        quantity: r.arch ? 1 : r.quantity,
        unitPrice: noChargeRemake ? "0.00" : r.unitPrice,
        lineTotal: noChargeRemake
          ? "0.00"
          : calculateLineTotal(r.arch ? 1 : r.quantity, r.unitPrice),
        groupedRestorationIds: [r.id],
        arch: r.arch,
        childItems: buildPfzChildItems(noChargeRemake),
      });
      continue;
    }

    if (entry.kind === "pfm") {
      const r = entry.r;
      const tooth = (r.toothNumber ?? "").trim();
      const alloyRow = tooth ? alloyByTooth.get(tooth) : undefined;
      const childItems: SyncLineItemChild[] = [];
      // Attach alloy sub-item at $0 (always needs manual pricing after create).
      // Skip when noChargeRemake since all lines are $0 and no alloy is needed.
      if (alloyRow && !noChargeRemake) {
        childItems.push({
          caseRestorationId: alloyRow.id,
          description: `Alloy #${tooth}`,
          quantity: 1,
          unitPrice: alloyRow.unitPrice,
          lineTotal: calculateLineTotal(1, alloyRow.unitPrice),
          priced: Number(alloyRow.unitPrice) > 0,
        });
      }
      items.push({
        caseRestorationId: r.id,
        toothNumber: parseToothInt(r.toothNumber),
        toothLabel: null,
        description: `${buildBasicDescription(r, noChargeRemake)}${archLabel(r.arch as Arch) ? ` - ${archLabel(r.arch as Arch)}` : ""}`,
        quantity: r.arch ? 1 : r.quantity,
        unitPrice: noChargeRemake ? "0.00" : r.unitPrice,
        lineTotal: noChargeRemake
          ? "0.00"
          : calculateLineTotal(r.arch ? 1 : r.quantity, r.unitPrice),
        groupedRestorationIds: [r.id],
        arch: r.arch,
        ...(childItems.length > 0 ? { childItems } : {}),
      });
      continue;
    }

    if (entry.kind === "flipper") {
      const r = entry.r;
      items.push({
        caseRestorationId: r.id,
        toothNumber: parseToothInt(r.toothNumber),
        toothLabel: null,
        description: `${buildBasicDescription(r, noChargeRemake)}${archLabel(r.arch as Arch) ? ` - ${archLabel(r.arch as Arch)}` : ""}`,
        quantity: r.arch ? 1 : r.quantity,
        unitPrice: noChargeRemake ? "0.00" : r.unitPrice,
        lineTotal: noChargeRemake
          ? "0.00"
          : calculateLineTotal(r.arch ? 1 : r.quantity, r.unitPrice),
        groupedRestorationIds: [r.id],
        arch: r.arch,
      });
      continue;
    }

    // Grouped multi- or single-tooth restoration.
    const { rows } = groupMap.get(entry.key)!;
    const first = rows[0]!;

    if (rows.length === 1) {
      items.push({
        caseRestorationId: first.id,
        toothNumber: parseToothInt(first.toothNumber),
        toothLabel: null,
        description: `${buildBasicDescription(first, noChargeRemake)}${archLabel(first.arch as Arch) ? ` - ${archLabel(first.arch as Arch)}` : ""}`,
        quantity: first.arch ? 1 : first.quantity,
        unitPrice: noChargeRemake ? "0.00" : first.unitPrice,
        lineTotal: noChargeRemake
          ? "0.00"
          : calculateLineTotal(first.arch ? 1 : first.quantity, first.unitPrice),
        groupedRestorationIds: [first.id],
        arch: first.arch,
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
        groupedRestorationIds: rows.map((row) => row.id),
      });
    }
  }

  // ── Step 4: legacy alloy rows (no/N/A tooth) as top-level lines ──────────
  for (const r of legacyAlloyRows) {
    items.push({
      caseRestorationId: r.id,
      toothNumber: null,
      toothLabel: null,
      description: `${buildBasicDescription(r, noChargeRemake)}${archLabel(r.arch as Arch) ? ` - ${archLabel(r.arch as Arch)}` : ""}`,
      quantity: r.quantity,
      unitPrice: noChargeRemake ? "0.00" : r.unitPrice,
      lineTotal: noChargeRemake ? "0.00" : calculateLineTotal(r.quantity, r.unitPrice),
      groupedRestorationIds: [r.id],
      arch: r.arch,
    });
  }

  return items;
}

/**
 * Parse comma-separated connector pairs string ("13-14,14-15") into a Set of
 * normalised `"lo-hi"` pair keys.
 */
export function parseConnectors(value: string | null | undefined): Set<string> {
  return parseConnectorState(value).active;
}

/**
 * Find connected components in a set of pair edges. Returns an array of sets
 * where each set is a group of tooth numbers that form a connected span.
 */
export function findConnectedComponents<T extends number | string>(
  toothNumbers: T[],
  connectorPairs: Set<string>,
): T[][] {
  const parent = new Map<T, T>();
  const labels = new Map(toothNumbers.map((tooth) => [String(tooth).toUpperCase(), tooth]));
  for (const n of toothNumbers) parent.set(n, n);

  function find(x: T): T {
    const p = parent.get(x);
    if (p === undefined || p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  }

  function union(x: T, y: T) {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  }

  for (const pair of connectorPairs) {
    const [as, bs] = pair.split("-");
    const a = labels.get(as.toUpperCase());
    const b = labels.get(bs.toUpperCase());
    if (a !== undefined && b !== undefined && parent.has(a) && parent.has(b)) {
      union(a, b);
    }
  }

  const groups = new Map<T, T[]>();
  for (const n of toothNumbers) {
    const root = find(n);
    const group = groups.get(root) ?? [];
    group.push(n);
    groups.set(root, group);
  }
  return Array.from(groups.values()).map((g) => g.sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })));
}

/**
 * Build invoice line items, collapsing bridge spans into single items when
 * the case has connector data. Falls back to same-material grouping when
 * there are no connectors or no bridge patterns are found.
 *
 * PFZ and PFM/FCM restorations (plus any alloy surcharge rows) are ALWAYS
 * emitted as per-tooth singletons and are never collapsed into bridge spans.
 * This ensures every PFZ tooth gets its $37 Layered Porcelain child, and every
 * PFM/FCM tooth gets its $0 Alloy child sub-item when autoAddAlloyOnPfm is on.
 */
export function buildBridgeAwareLineItems(
  restorations: Array<{
    id: string;
    toothNumber: string;
    restorationType: string;
    restorationSubtype?: string | null;
    arch?: string | null;
    material: string | null;
    quantity: number;
    unitPrice: string;
  }>,
  bridgeConnectors: string | null,
  noChargeRemake: boolean,
): SyncLineItem[] {
  // Helper: is this an alloy surcharge row?
  const isAlloyRow = (r: { restorationType: string }) =>
    r.restorationType.trim().toLowerCase() === "alloy";

  // PFZ restorations are ALWAYS emitted as singletons — never collapsed into
  // a bridge span — so that every non-pontic PFZ tooth gets its own parent
  // line and its $37 Layered Porcelain child sub-item. Separate them before
  // the bridge algorithm touches the input.
  const pfzRestorations = restorations.filter((r) => isPfzMaterial(r.material));

  // PFM/FCM restorations and any alloy surcharge rows are also kept as
  // per-tooth singletons so the alloy sub-item pairing in buildGroupedSyncItems
  // can match each alloy row to its parent PFM/FCM line by tooth number.
  const pfmFcmAndAlloy = restorations.filter(
    (r) =>
      !isPfzMaterial(r.material) &&
      (isPfmOrFcmMaterial(r.material) || isAlloyRow(r)),
  );

  // Remaining restorations are the only candidates for bridge/grouping logic.
  const bridgeCandidates = restorations.filter(
    (r) =>
      !isPfzMaterial(r.material) &&
      !isPfmOrFcmMaterial(r.material) &&
      !isAlloyRow(r),
  );

  // PFZ items will be appended at the end (sortOrder controls invoice position).
  const pfzItems = buildGroupedSyncItems(pfzRestorations, noChargeRemake);
  // PFM/FCM singletons (each may carry an Alloy child sub-item at $0).
  const pfmFcmItems = buildGroupedSyncItems(pfmFcmAndAlloy, noChargeRemake);
  // Keep ancillary pricing rows intact while describing their connected units.
  if (validateToothConnectors(bridgeConnectors, restorations).valid) {
    const groups = toothAssignmentSummary(restorations, bridgeConnectors).groups;
    for (const group of groups) {
      const members = restorations.filter((row) => group.includes(row.toothNumber.toUpperCase()) && /^(Crown|Pontic)$/i.test(row.restorationType));
      const crowns = members.filter((row) => /^crown$/i.test(row.restorationType));
      if (!crowns.length) continue;
      const label = `${members.some((row) => /^pontic$/i.test(row.restorationType)) ? "Bridge" : "Connected crowns"} #${group[0]}-${group[group.length - 1]}`;
      const ids = new Set(members.map((row) => row.id));
      for (const item of [...pfmFcmItems, ...pfzItems]) {
        if (item.caseRestorationId && ids.has(item.caseRestorationId)) item.description = `${label}: ${item.description}`;
      }
    }
  }

  const connectors = parseConnectors(bridgeConnectors);

  // No connector data: group same-material/same-type bridge-candidate restorations.
  if (connectors.size === 0) {
    return [
      ...buildGroupedSyncItems(bridgeCandidates, noChargeRemake),
      ...pfmFcmItems,
      ...pfzItems,
    ];
  }

  // Map bridge-candidate restorations by numeric tooth number for quick lookup.
  const byTooth = new Map<string, typeof restorations[0]>();
  const nonNumeric: typeof restorations = [];
  for (const r of bridgeCandidates) {
    const label = r.toothNumber.trim().toUpperCase();
    if (/^(Crown|Pontic)$/i.test(r.restorationType) && /^(?:[1-9]|[12]\d|3[0-2]|[A-T])$/.test(label)) {
      byTooth.set(label, r);
    } else {
      nonNumeric.push(r);
    }
  }

  const numericTeeth = Array.from(byTooth.keys());
  const components = findConnectedComponents(numericTeeth, connectors);

  // An explicit connector is meaningful even between crowns. Pontic bridges
  // and crown-only connected groups get distinct descriptions rather than
  // being silently folded into an unrelated same-material batch.
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
    const hasCrown = groupRestorations.some((r) =>
      /crown/i.test(r.restorationType),
    );
    if (!hasPontic && !hasCrown) continue;

    // This span is a bridge. Collapse into one line item.
    const lo = group[0]!;
    const hi = group[group.length - 1]!;
    const units = groupRestorations.reduce((s, r) => s + r.quantity, 0);
    // Use the material from the first crown/abutment restoration in the group.
    const abutment = groupRestorations.find(
      (r) => !/pontic/i.test(r.restorationType),
    );
    const material = abutment?.material ?? groupRestorations[0]?.material ?? null;

    const matLabel = material ? `${material} ` : "";
    const roleSummary = `${groupRestorations.filter((r) => /crown/i.test(r.restorationType)).length} crown${groupRestorations.filter((r) => /crown/i.test(r.restorationType)).length === 1 ? "" : "s"}${hasPontic ? `, ${groupRestorations.filter((r) => /pontic/i.test(r.restorationType)).length} pontic${groupRestorations.filter((r) => /pontic/i.test(r.restorationType)).length === 1 ? "" : "s"}` : ""}`;
    const groupLabel = hasPontic ? "Bridge" : "Connected crowns";
    const bridgeDesc = `#${lo}-${hi} ${matLabel}${groupLabel} (${roleSummary}) – ${units} unit${units !== 1 ? "s" : ""}`;
    const toothRoles = groupRestorations.map((row) => `#${row.toothNumber} ${/^pontic$/i.test(row.restorationType) ? "pontic" : "prepared crown"}`).join(", ");
    const finalDesc = `${bridgeDesc}; ${toothRoles}${noChargeRemake ? " (no-charge remake)" : ""}`;

    // Connections describe clinical topology, not a blended billing rate.
    // Keep independently quoted units auditable, including half-cent averages.
    if (!noChargeRemake && new Set(groupRestorations.map((r) => Number(r.unitPrice).toFixed(2))).size > 1) {
      for (const row of groupRestorations) {
        items.push({
          caseRestorationId: row.id,
          toothNumber: parseToothInt(row.toothNumber),
          toothLabel: null,
          description: `#${lo}-${hi} ${matLabel}${groupLabel}; ${buildBasicDescription(row, false)}`,
          quantity: row.quantity,
          unitPrice: row.unitPrice,
          lineTotal: calculateLineTotal(row.quantity, row.unitPrice),
          groupedRestorationIds: [row.id],
        });
        usedRestorationIds.add(row.id);
      }
      continue;
    }
    const perUnitStr = noChargeRemake ? "0.00" : groupRestorations[0]!.unitPrice;
    const lineTotal = calculateLineTotal(units, perUnitStr);

    items.push({
      caseRestorationId: abutment?.id ?? groupRestorations[0]?.id ?? null,
      toothNumber: null,
      toothLabel: null,
      description: finalDesc,
      quantity: units,
      unitPrice: perUnitStr,
      lineTotal,
      groupedRestorationIds: groupRestorations.map((gr) => gr.id),
    });

    for (const r of groupRestorations) usedRestorationIds.add(r.id);
  }

  // Any bridge-candidate restoration not consumed by a bridge span: apply
  // same-material grouping so individual crowns of the same material collapse.
  const unconsumedBridge = bridgeCandidates.filter(
    (r) => !usedRestorationIds.has(r.id),
  );
  const ungrouped = buildGroupedSyncItems(unconsumedBridge, noChargeRemake);
  items.push(...ungrouped);

  // PFM/FCM singletons: each may have an Alloy child sub-item at $0.
  items.push(...pfmFcmItems);
  // PFZ singletons last: each has its $37 child sub-item.
  items.push(...pfzItems);

  return items;
}
