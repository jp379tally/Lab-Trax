import { deriveCaseHierarchy, encodeRestorationSubtype } from "./taxonomy";

export type ToothAssignmentRole = "crown" | "pontic";
export interface ToothAssignmentProvenance {
  origin: "manual" | "ai_explicit";
  roleEvidence?: string;
  manualFields: Array<"role" | "product" | "shade">;
}

export interface ToothAssignmentUnit {
  toothNumber: string;
  restorationType: string;
  material?: string | null;
  restorationSubtype?: string | null;
  arch?: string | null;
  shade?: string | null;
  quantity?: number | null;
  assignmentProvenance?: ToothAssignmentProvenance | null;
}

/** Expands same-arch Universal ranges without assigning a clinical role. */
export function expandToothAssignmentIdentifiers(value?: string | null): string[] {
  const teeth = new Set<string>();
  for (const token of (value ?? "").toUpperCase().replace(/[–—]/g, "-").split(/[,\s;]+/).filter(Boolean)) {
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a >= 1 && a <= 32 && b >= 1 && b <= 32 && (a <= 16) === (b <= 16)) {
        for (let n = Math.min(a, b); n <= Math.max(a, b); n++) teeth.add(String(n));
      }
    } else if (/^(?:[1-9]|[12]\d|3[0-2]|[A-T])$/.test(token)) {
      teeth.add(token);
    } else {
      const primary = token.match(/^([A-T])-([A-T])$/);
      if (primary && (primary[1] <= "J") === (primary[2] <= "J")) {
        for (let code = Math.min(primary[1].charCodeAt(0), primary[2].charCodeAt(0));
          code <= Math.max(primary[1].charCodeAt(0), primary[2].charCodeAt(0)); code++) {
          teeth.add(String.fromCharCode(code));
        }
      }
    }
  }
  return [...teeth];
}

/** Reject invalid input instead of silently dropping a cross-arch range. */
export function invalidToothAssignmentTokens(value?: string | null): string[] {
  return (value ?? "").toUpperCase().replace(/[–—]/g, "-").split(/[,\s;]+/).filter(Boolean)
    .filter((token) => expandToothAssignmentIdentifiers(token).length === 0);
}

/** Copies only editable values, never record or connector identities. */
export function copyToothAssignment(source: ToothAssignmentUnit, toothNumber: string): ToothAssignmentUnit {
  return {
    toothNumber,
    restorationType: source.restorationType,
    material: source.material,
    restorationSubtype: source.restorationSubtype,
    shade: source.shade,
    arch: /^(crown|pontic)$/i.test(source.restorationType) ? null : source.arch,
  };
}

export interface ToothAssignmentValues {
  material?: string;
  shade?: string;
  restorationSubtype?: string;
}

/** Bulk defaults never substitute a built-in SKU for a custom catalog product. */
export function applyToothAssignmentDefaults(
  values: Record<string, ToothAssignmentValues>,
  patch: { material?: string; shade?: string },
): Record<string, ToothAssignmentValues> {
  return Object.fromEntries(Object.entries(values).map(([tooth, value]) => {
    const hierarchy = deriveCaseHierarchy("Crown", value.restorationSubtype, value.material);
    const nextMaterial = patch.material !== undefined && !hierarchy.customSubtypeId ? patch.material : value.material;
    const nextHierarchy = deriveCaseHierarchy("Crown", undefined, nextMaterial);
    const materialChanged = nextMaterial !== value.material;
    return [tooth, { ...value,
      ...(nextMaterial !== undefined ? { material: nextMaterial } : {}),
      ...(patch.shade !== undefined ? { shade: patch.shade } : {}),
      ...(materialChanged ? { restorationSubtype: nextHierarchy.materialSubtype
        ? encodeRestorationSubtype({ ...hierarchy, materialSubtype: nextHierarchy.materialSubtype, customMaterialSubtypeId: undefined }) ?? undefined
        : value.restorationSubtype } : {}),
    }];
  }));
}

/** An AI range, missing tooth, or bridge label is never proof of a role. */
export function readExplicitAiToothAssignments(value: unknown): ToothAssignmentUnit[] {
  if (!Array.isArray(value)) return [];
  const units = new Map<string, ToothAssignmentUnit>();
  const duplicates = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.toothNumber !== "string" || raw.requiresReview !== false ||
        typeof raw.material !== "string" || !raw.material.trim() ||
        typeof raw.roleEvidence !== "string" ||
        typeof raw.shade !== "string" || !raw.shade.trim()) continue;
    const tooth = raw.toothNumber.trim().toUpperCase().replace(/^#/, "");
    if (expandToothAssignmentIdentifiers(tooth).length !== 1) continue;
    if (/\b(?:no|not|without|exclude|excluding)\b/i.test(raw.roleEvidence)) continue;
    const references = [
      ...[...raw.roleEvidence.matchAll(/#(\d{1,2}(?:\s*[-–]\s*\d{1,2})?)(?!\d)/g)].map((match) => match[1]),
      ...[...raw.roleEvidence.matchAll(/\b(?:tooth|teeth|crowns?|abutments?|pontics?)\s*(?:on\s+)?((?:#?\d{1,2}(?:\s*[-–]\s*\d{1,2})?)(?:\s*[,/&+]\s*#?\d{1,2}(?:\s*[-–]\s*\d{1,2})?)*)(?!\w)/gi)].map((match) => match[1]),
      ...[...raw.roleEvidence.matchAll(/(?:^|[\s,;])(\d{1,2})\s*(?::|=|-)?\s*(?:prepared\s+)?(?:crowns?|abutments?|pontics?)\b/gi)].map((match) => match[1]),
    ];
    const roleReferences = [
      ...[...raw.roleEvidence.matchAll(/\b(?:crowns?|abutments?|pontics?)\s*(?:on\s+)?((?:#?\d{1,2}(?:\s*[-–]\s*\d{1,2})?)(?:\s*(?:[,/&+]|\band\b)\s*#?\d{1,2}(?:\s*[-–]\s*\d{1,2})?)*)(?!\w)/gi)].map((match) => match[1]),
      ...[...raw.roleEvidence.matchAll(/#(\d{1,2}(?:\s*(?:[,/&+]|\band\b)\s*#?\d{1,2})*)\s*(?::|=|-)?\s*(?:prepared\s+)?(?:crowns?|abutments?|pontics?)\b/gi)].map((match) => match[1]),
      ...[...raw.roleEvidence.matchAll(/\b(?:crowns?|abutments?|pontics?)\s*#([A-T](?:-[A-T])?)\b/gi)].map((match) => match[1]),
      ...[...raw.roleEvidence.matchAll(/#([A-T])\s*(?:prepared\s+)?(?:crowns?|abutments?|pontics?)\b/gi)].map((match) => match[1]),
    ];
    const explicitReferences = roleReferences.length ? roleReferences : [
      ...(/#|\b(?:tooth|teeth)\b/i.test(raw.roleEvidence) ? references : []),
      ...(raw.roleEvidence.match(/#[A-T](?:-[A-T])?\b/gi) ?? []),
    ];
    const evidenceTeeth = explicitReferences.flatMap((token) =>
      expandToothAssignmentIdentifiers(token.replaceAll("#", "").replace(/\band\b/gi, ",").replace(/[&/+]/g, ",").replace(/\s*[-–]\s*/g, "-")));
    if (!roleReferences.length && (new Set(evidenceTeeth).size !== 1 || /\b(?:between|adjacent|next|maybe|uncertain|questionable)\b/i.test(raw.roleEvidence))) continue;
    if (!evidenceTeeth.includes(tooth)) continue;
    const role = raw.role === "prepared_crown" && /\b(crowns?|abutments?)\b/i.test(raw.roleEvidence) &&
        !/\bpontics?\b/i.test(raw.roleEvidence)
      ? "Crown"
      : raw.role === "pontic" && /\bpontics?\b/i.test(raw.roleEvidence) &&
        !/\b(crowns?|abutments?)\b/i.test(raw.roleEvidence) ? "Pontic" : null;
    if (!role) continue;
    if (units.has(tooth)) duplicates.add(tooth);
    units.set(tooth, {
      toothNumber: tooth,
      restorationType: role,
      material: raw.material.trim(),
      ...(typeof raw.shade === "string" && raw.shade.trim() ? { shade: raw.shade.trim() } : {}),
      assignmentProvenance: { origin: "ai_explicit", roleEvidence: raw.roleEvidence, manualFields: [] },
    });
  }
  for (const tooth of duplicates) units.delete(tooth);
  return [...units.values()];
}

export interface ConnectorState {
  /** Enabled edges, including automatic suggestions not explicitly declined. */
  active: Set<string>;
  explicitOn: Set<string>;
  explicitOff: Set<string>;
  suggested: Set<string>;
  /** Keep invalid legacy tokens visible until the operator edits connections. */
  invalidTokens?: string[];
}

export interface ConnectorValidation {
  valid: boolean;
  errors: string[];
}

export function connectorPairKey(a: number | string, b: number | string): string {
  const left = String(a).toUpperCase();
  const right = String(b).toUpperCase();
  return [left, right].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join("-");
}

/** Universal adult teeth are adjacent within #1–16 and #17–32. */
export function areUniversalTeethAdjacent(a: number | string, b: number | string): boolean {
  const left = String(a).toUpperCase();
  const right = String(b).toUpperCase();
  if (/^[A-T]$/.test(left) && /^[A-T]$/.test(right)) {
    return (left <= "J") === (right <= "J") && Math.abs(left.charCodeAt(0) - right.charCodeAt(0)) === 1;
  }
  a = Number(a); b = Number(b);
  return (
    Number.isInteger(a) &&
    Number.isInteger(b) &&
    a >= 1 &&
    a <= 32 &&
    b >= 1 &&
    b <= 32 &&
    Math.abs(a - b) === 1 &&
    !((a === 16 && b === 17) || (a === 17 && b === 16))
  );
}

function parsePairToken(token: string): { pair: string; state: "on" | "off" | "suggested" } | null {
  const match = token.trim().toUpperCase().match(/^([!?]?)(\d+|[A-T])-(\d+|[A-T])$/);
  if (!match) return null;
  const a = match[2];
  const b = match[3];
  if (!areUniversalTeethAdjacent(a, b)) return null;
  const pair = connectorPairKey(a, b);
  return {
    pair,
    state: match[1] === "!" ? "off" : match[1] === "?" ? "suggested" : "on",
  };
}

/**
 * Reads both legacy `2-3` edges and the provenance-aware `?2-3` suggested /
 * `!2-3` explicitly disconnected edges.
 */
export function parseConnectorState(value?: string | null): ConnectorState {
  const state: ConnectorState = {
    active: new Set(),
    explicitOn: new Set(),
    explicitOff: new Set(),
    suggested: new Set(),
  };
  for (const token of value?.split(",") ?? []) {
    const parsed = parsePairToken(token);
    if (!parsed) {
      if (token.trim()) (state.invalidTokens ??= []).push(token.trim());
      continue;
    }
    if (parsed.state === "off") {
      state.explicitOff.add(parsed.pair);
      continue;
    }
    state.active.add(parsed.pair);
    if (parsed.state === "suggested") state.suggested.add(parsed.pair);
    else state.explicitOn.add(parsed.pair);
  }
  for (const pair of state.explicitOff) {
    state.active.delete(pair);
    state.suggested.delete(pair);
    state.explicitOn.delete(pair);
  }
  return state;
}

export function serializeConnectorState(state: ConnectorState): string {
  const tokens = new Set<string>();
  for (const pair of state.explicitOn) {
    if (!state.explicitOff.has(pair)) tokens.add(pair);
  }
  for (const pair of state.suggested) {
    if (!state.explicitOff.has(pair) && !state.explicitOn.has(pair)) tokens.add(`?${pair}`);
  }
  for (const pair of state.explicitOff) tokens.add(`!${pair}`);
  for (const token of state.invalidTokens ?? []) tokens.add(token);
  return [...tokens].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(",");
}

/**
 * Older desktop builds split connector strings on "-" and sorted the endpoint
 * strings. A marker on the first endpoint could therefore move to the right,
 * producing artifacts such as `3-?2` for `?2-3` and `3-!2` for `!2-3`.
 * Recognize those only when they refer to a marker state already persisted for
 * this case. If the legacy client also sends the plain pair, that unmarked
 * value is its latest edge choice. All other input is returned byte-for-byte
 * so provenance-aware clients are unchanged.
 */
export function normalizeLegacyDesktopConnectorEcho(
  previousValue: string | null | undefined,
  value?: string | null,
): string {
  const previous = parseConnectorState(previousValue);
  const rawTokens = value?.split(",") ?? [];
  const unmarkedPairs = new Set<string>();
  for (const token of rawTokens) {
    const parsed = parsePairToken(token);
    if (parsed?.state === "on") unmarkedPairs.add(parsed.pair);
  }

  let normalizedLegacyEcho = false;
  const normalizedTokens = rawTokens.map((token) => {
    const parsed = parsePairToken(token);
    if (parsed) return token;
    const legacy = token.trim().toUpperCase().match(/^(\d+|[A-T])-([!?])(\d+|[A-T])$/);
    if (!legacy) return token;
    const marker = legacy[2] as "?" | "!";
    const restored = parsePairToken(`${marker}${legacy[3]}-${legacy[1]}`);
    if (!restored) return token;
    const pair = restored.pair;
    const knownMarkerState = marker === "?"
      ? previous.suggested.has(pair) ||
        (unmarkedPairs.has(pair) && previous.explicitOn.has(pair))
      : previous.explicitOff.has(pair) ||
        (unmarkedPairs.has(pair) && (previous.explicitOn.has(pair) || previous.suggested.has(pair)));
    if (!knownMarkerState || restored.state !== (marker === "?" ? "suggested" : "off")) return token;
    normalizedLegacyEcho = true;
    return `${marker}${pair}`;
  });

  const canonicalInput = normalizedTokens.join(",");
  const tokensByPair = new Map<string, Set<"on" | "off" | "suggested">>();
  for (const token of normalizedTokens) {
    const parsed = parsePairToken(token);
    if (!parsed) continue;
    const states = tokensByPair.get(parsed.pair) ?? new Set();
    states.add(parsed.state);
    tokensByPair.set(parsed.pair, states);
  }

  const conflictedPairs = [...tokensByPair]
    .filter(([, states]) => states.has("on") && (states.has("off") || states.has("suggested")))
    .map(([pair]) => pair);
  if (!normalizedLegacyEcho && !conflictedPairs.length) return value ?? "";

  const reconciled = parseConnectorState(canonicalInput);
  for (const pair of conflictedPairs) {
    reconciled.active.add(pair);
    reconciled.explicitOn.add(pair);
    reconciled.explicitOff.delete(pair);
    reconciled.suggested.delete(pair);
  }
  return serializeConnectorState(reconciled);
}

function assignmentTeeth(unit: ToothAssignmentUnit): string[] {
  const teeth = expandToothAssignmentIdentifiers(unit.toothNumber);
  return teeth.length === 1 ? teeth : [];
}

function normalized(value?: string | null): string {
  return (value ?? "").trim().toLocaleLowerCase();
}
function assignmentCatalogIdentity(unit: ToothAssignmentUnit): string | null {
  const hierarchy = deriveCaseHierarchy("Crown", unit.restorationSubtype, unit.material);
  if (unit.restorationSubtype?.includes("/") && encodeRestorationSubtype(hierarchy) !== unit.restorationSubtype.trim()) return null;
  const namedMaterial = deriveCaseHierarchy("Crown", null, unit.material).materialSubtype;
  if (hierarchy.materialSubtype && !namedMaterial) return null;
  if (namedMaterial && hierarchy.materialSubtype && namedMaterial !== hierarchy.materialSubtype) return null;
  if (hierarchy.caseType !== "restorative" || !(hierarchy.subtype || hierarchy.customSubtypeId) ||
      !(hierarchy.materialSubtype || hierarchy.customMaterialSubtypeId)) return null;
  return encodeRestorationSubtype(hierarchy);
}

export function suggestPonticConnectorPairs(units: ToothAssignmentUnit[]): Set<string> {
  const byTooth = new Map<string, ToothAssignmentUnit>();
  for (const unit of units) {
    const role = normalized(unit.restorationType);
    if (role !== "crown" && role !== "pontic") continue;
    for (const tooth of assignmentTeeth(unit)) byTooth.set(tooth, unit);
  }
  const pairs = new Set<string>();
  for (const [tooth, unit] of byTooth) {
    if (normalized(unit.restorationType) !== "pontic" || !normalized(unit.material)) continue;
    const neighbors = /^[A-T]$/.test(tooth)
      ? [-1, 1].map((offset) => String.fromCharCode(tooth.charCodeAt(0) + offset))
      : [String(Number(tooth) - 1), String(Number(tooth) + 1)];
    for (const neighbor of neighbors) {
      if (!areUniversalTeethAdjacent(tooth, neighbor)) continue;
      const adjacent = byTooth.get(neighbor);
      if (!adjacent || !["crown", "pontic"].includes(normalized(adjacent.restorationType))) continue;
      const identity = assignmentCatalogIdentity(unit);
      if (!identity || assignmentCatalogIdentity(adjacent) !== identity) continue;
      pairs.add(connectorPairKey(tooth, neighbor));
    }
  }
  return pairs;
}

/** Rejects orphaned, non-adjacent, cross-arch, unresolved, or incompatible edges. */
export function validateToothConnectors(
  value: string | null | undefined,
  units: ToothAssignmentUnit[],
): ConnectorValidation {
  const errors: string[] = [];
  const byTooth = new Map<string, ToothAssignmentUnit>();
  for (const unit of units) {
    const role = normalized(unit.restorationType);
    if (role !== "crown" && role !== "pontic") {
      if (/^(bridge|implant|veneer|inlay|onlay)$/i.test(role) && expandToothAssignmentIdentifiers(unit.toothNumber).length) {
        errors.push(`Review legacy restoration #${unit.toothNumber}: confirm explicit per-tooth crown or pontic roles before billing.`);
      }
      continue;
    }
    if (!assignmentCatalogIdentity(unit)) errors.push(`Tooth #${unit.toothNumber} needs a confirmed catalog product and material.`);
    if (!assignmentTeeth(unit).length || (unit.quantity != null && unit.quantity !== 1) || /^(both|upper_lower)$/i.test(unit.arch ?? "")) {
      errors.push(`Review legacy assignment #${unit.toothNumber}: confirm one tooth and one billable unit per assignment.`);
    }
    for (const tooth of assignmentTeeth(unit)) {
      if (byTooth.has(tooth)) errors.push(`Tooth #${tooth} has more than one billable assignment.`);
      byTooth.set(tooth, unit);
    }
  }

  for (const token of value?.split(",") ?? []) {
    const parsed = parsePairToken(token);
    if (!parsed) {
      if (token.trim()) errors.push(`Invalid connector “${token.trim()}”.`);
      continue;
    }
    // A remembered disconnect is a user preference, not a live edge. It may
    // outlast an assignment if that restoration is removed later.
    if (parsed.state === "off") continue;
    const [a, b] = parsed.pair.split("-");
    const left = byTooth.get(a);
    const right = byTooth.get(b);
    if (!left || !right) {
      errors.push(`Connector #${a}–#${b} has an unassigned tooth.`);
      continue;
    }
    if (
      left.arch &&
      right.arch &&
      normalized(left.arch) !== normalized(right.arch)
    ) {
      errors.push(`Connector #${a}–#${b} crosses arches.`);
    }
    if (!normalized(left.material) || !normalized(right.material)) {
      errors.push(`Connector #${a}–#${b} needs a catalog material on both units.`);
    } else if (!assignmentCatalogIdentity(left) || assignmentCatalogIdentity(left) !== assignmentCatalogIdentity(right)) {
      errors.push(`Connector #${a}–#${b} uses incompatible ${normalized(left.material) !== normalized(right.material) ? "materials" : "catalog products"}.`);
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function connectedToothGroups(value?: string | null): string[][] {
  const links = new Map<string, Set<string>>();
  for (const pair of parseConnectorState(value).active) {
    const [a, b] = pair.split("-");
    if (!links.has(a)) links.set(a, new Set());
    if (!links.has(b)) links.set(b, new Set());
    links.get(a)!.add(b);
    links.get(b)!.add(a);
  }
  const groups: string[][] = [];
  const visited = new Set<string>();
  for (const tooth of links.keys()) {
    if (visited.has(tooth)) continue;
    const queue = [tooth];
    const group: string[] = [];
    while (queue.length) {
      const current = queue.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      group.push(current);
      queue.push(...(links.get(current) ?? []));
    }
    groups.push(group.sort((a, b) => Number(a) - Number(b)));
  }
  return groups;
}

export function toothAssignmentSummary(units: ToothAssignmentUnit[], connectors?: string | null) {
  const crowns = new Set<string>();
  const pontics = new Set<string>();
  const materials = new Map<string, number>();
  for (const unit of units) {
    const role = normalized(unit.restorationType);
    if (role !== "crown" && role !== "pontic") continue;
    const teeth = expandToothAssignmentIdentifiers(unit.toothNumber);
    for (const tooth of teeth) (role === "crown" ? crowns : pontics).add(tooth);
    const material = unit.material?.trim() || "Material needs review";
    materials.set(material, (materials.get(material) ?? 0) + teeth.length);
  }
  const groups = connectedToothGroups(connectors);
  const unresolvedPontics = [...pontics].filter((tooth) =>
    !groups.some((group) => group.includes(tooth) && group.some((member) => crowns.has(member))),
  );
  return {
    crowns: crowns.size,
    pontics: pontics.size,
    units: new Set([...crowns, ...pontics]).size,
    groups,
    materials: [...materials].map(([material, count]) => ({ material, count })),
    unresolvedPontics,
  };
}

export function withPonticConnectorSuggestions(value: string | null | undefined, units: ToothAssignmentUnit[], touchedTeeth?: Set<string>): ConnectorState {
  const state = parseConnectorState(value);
  const candidates = suggestPonticConnectorPairs(units);
  for (const pair of state.suggested) {
    if (!candidates.has(pair)) { state.suggested.delete(pair); state.active.delete(pair); }
  }
  for (const pair of candidates) {
    if (touchedTeeth && !pair.split("-").some((tooth) => touchedTeeth.has(tooth))) continue;
    if (state.explicitOn.has(pair) || state.explicitOff.has(pair)) continue;
    state.suggested.add(pair);
    state.active.add(pair);
  }
  return state;
}

export function updateConnectorChoices(state: ConnectorState, nextPairs: Set<string>): string {
  const next = parseConnectorState(serializeConnectorState(state));
  for (const pair of new Set([...state.active, ...nextPairs])) {
    if (state.active.has(pair) === nextPairs.has(pair)) continue;
    next.suggested.delete(pair);
    if (nextPairs.has(pair)) {
      next.explicitOn.add(pair);
      next.explicitOff.delete(pair);
    } else {
      next.explicitOn.delete(pair);
      next.explicitOff.add(pair);
    }
  }
  return serializeConnectorState(next);
}

export function describeToothAssignments(units: ToothAssignmentUnit[], connectors?: string | null): string {
  const assigned = units.filter((unit) => ["crown", "pontic"].includes(normalized(unit.restorationType)));
  if (!assigned.length) return "";
  const summary = toothAssignmentSummary(assigned, connectors);
  const roles = assigned.map((unit) =>
    `#${unit.toothNumber} ${normalized(unit.restorationType) === "crown" ? "prepared crown" : "pontic"}` +
    (unit.material ? `, ${unit.material}` : ", material needs review") +
    (unit.shade ? `, shade ${unit.shade}` : ""),
  );
  return [
    `${summary.units} unit${summary.units === 1 ? "" : "s"} (${summary.crowns} prepared crowns, ${summary.pontics} pontics)`,
    ...roles,
    ...summary.groups.map((group) => `Connected: ${group.map((tooth) => `#${tooth}`).join("–")}`),
    summary.unresolvedPontics.length
      ? `Review: unconnected pontics ${summary.unresolvedPontics.map((tooth) => `#${tooth}`).join(", ")}`
      : "",
  ].filter(Boolean).join("; ");
}
