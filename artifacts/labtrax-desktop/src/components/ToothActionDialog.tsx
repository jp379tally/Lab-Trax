import { useMemo, useState } from "react";
import { Loader2, X } from "lucide-react";
import type { EffectiveCatalogTree } from "@workspace/api-client-react";
import type { CaseRestoration } from "@/lib/types";
import type { ToothRole } from "@/lib/tooth-geometry";
import { ToothSilhouette } from "@/components/ToothSilhouette";
import { parseToothField } from "@/components/ToothChart";
import { encodeCatalogSelection, getCatalogMaterialsForCrown } from "@/components/CatalogRestorationPicker";
import {
  TOOTH_INDICATION_GROUPS,
  indicationCatalogContext,
  isToothIndication,
  deriveCaseHierarchy,
  archSelectionTeeth,
  type ToothArch,
} from "@workspace/case-taxonomy";

const VITA_SHADES = [
  "A1", "A2", "A3", "A3.5", "A4", "B1", "B2", "B3", "B4", "C1", "C2", "C3", "C4",
  "D2", "D3", "D4", "OM1", "OM2", "OM3", "1M1", "1M2", "1M3",
] as const;

/** Role for generic indications is the indication label itself (e.g. "Denture"); arch is set for arch-based choices. */
export type ToothActionPayload =
  | { kind: "change_role"; restorationId: string; toothId: string; role: "Crown" | "Pontic" | "Veneer" }
  | { kind: "copy_assignment"; restorationId: string; toothNumbers: string[] }
  | {
      kind: "add_crown";
      toothId: string;
      material: string;
      restorationType: string;
      restorationSubtype?: string;
      shade?: string;
      arch?: ToothArch;
    }
  | { kind: "add_pontic"; toothId: string; material: string; restorationSubtype?: string; shade?: string }
  | { kind: "mark_missing"; toothId: string }
  | {
      kind: "replace_tooth";
      restorationId: string;
      oldToothId: string;
      newToothNumber: string;
      role?: string;
      material?: string;
      restorationSubtype?: string;
      shade?: string;
      arch?: ToothArch;
    }
  | { kind: "remove_restoration"; toothId: string; restorationId?: string };

interface MaterialOption { key: string; label: string; parentLabel?: string }

interface ToothActionDialogProps {
  initialCopyTargets?: string;
  allowMarkMissing?: boolean;
  toothId: string;
  caseShade?: string | null;
  restorations: CaseRestoration[];
  isPending?: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: (payload: ToothActionPayload) => void;
  locallySelectedType?: "crown" | "pontic" | "missing";
  materialOptions?: MaterialOption[];
  groupTeeth?: string[];
  catalog?: EffectiveCatalogTree;
  selectionArch?: ToothArch;
  selectedTeeth?: string[];
}

const MISSING = "Missing";
const ARCH_SUBTYPE_INDICATION: Record<string, string> = { dentures: "Denture", partials: "Partial denture", night_guards: "Bite splint" };

/** Canonical menu indication for a stored row; unknown legacy fixed types stay as their stored value. */
function canonicalIndication(r: CaseRestoration): string {
  if (isToothIndication(r.restorationType)) return r.restorationType;
  if (/^(crown(?:\s*(?:&|and)\s*bridge)?|bridge|implant)$/i.test(r.restorationType)) return "Crown";
  if (/^(inlay|onlay)$/i.test(r.restorationType)) return "Inlay/Onlay";
  if (r.arch && parseToothField(r.toothNumber).size === 0) {
    const sub = deriveCaseHierarchy(r.restorationType, r.restorationSubtype, r.material).subtype;
    if (sub && ARCH_SUBTYPE_INDICATION[sub]) return ARCH_SUBTYPE_INDICATION[sub];
  }
  return r.restorationType;
}

function roleFor(indication: string): ToothRole {
  if (indication === MISSING) return "missing";
  if (indication === "Pontic") return "pontic";
  if (indication === "Veneer") return "veneer";
  return indication ? "crown" : "unassigned";
}

function catalogMaterialsFor(catalog: EffectiveCatalogTree | undefined, indication: string): MaterialOption[] | null {
  const ctx = indicationCatalogContext(indication);
  const caseType = (catalog?.caseTypes ?? []).find((node) => node.key === ctx.caseType);
  const subtype = caseType?.subtypes.find((node) => node.key === ctx.subtype);
  if (!subtype?.materials?.length) return null;
  // Custom catalog nodes keep their real id token so encodeCatalogSelection stores the actual custom material id.
  return subtype.materials.map((m) => ({ key: m.isCustom && m.id ? `custom:${m.id}` : m.key, label: m.label }));
}

export function ToothActionDialog({
  initialCopyTargets = "",
  toothId,
  caseShade,
  restorations,
  isPending,
  error,
  onClose,
  onConfirm,
  locallySelectedType,
  materialOptions = [],
  groupTeeth = [],
  allowMarkMissing = true,
  catalog,
  selectionArch,
  selectedTeeth = [],
}: ToothActionDialogProps) {
  // A whole-arch selection (every tooth of selectionArch selected) also opens the matching arch-based row, whose
  // toothNumber is empty. Single-tooth clicks never match arch rows, so they cannot edit a denture by accident.
  const wholeArchSelected = !!selectionArch && archSelectionTeeth(selectionArch).every((t) => selectedTeeth.includes(t));
  const billedRestorations = restorations.filter((r) => {
    if (/^missing$/i.test(r.restorationType)) return false;
    if (wholeArchSelected) return !!r.arch && r.arch === selectionArch && parseToothField(r.toothNumber).size === 0;
    return parseToothField(r.toothNumber).has(toothId);
  });
  const [selectedRestorationId, setSelectedRestorationId] = useState(billedRestorations[0]?.id ?? "");
  const selectedRestoration = restorations.find((r) => r.id === selectedRestorationId);
  const editing = !!selectedRestoration && billedRestorations.some((r) => r.id === selectedRestoration.id);
  const editingArchRow = editing && !!selectedRestoration?.arch && parseToothField(selectedRestoration.toothNumber).size === 0;

  const [indication, setIndication] = useState<string>(() => {
    const current = billedRestorations[0];
    if (current) return canonicalIndication(current);
    return locallySelectedType === "pontic" ? "Pontic" : "Crown";
  });
  const [selectedMaterial, setSelectedMaterial] = useState<string>(() => {
    const current = billedRestorations[0];
    if (!current) return "";
    const option = materialOptions.find((o) => o.key === current.restorationSubtype) ?? materialOptions.find((o) => o.label === current.material);
    return option?.key ?? current.restorationSubtype ?? current.material ?? "";
  });
  const [selectedShade, setSelectedShade] = useState<string>(billedRestorations[0] ? billedRestorations[0].shade || caseShade || "" : caseShade ?? "");
  const [isCustomShade, setIsCustomShade] = useState(false);
  const [customShade, setCustomShade] = useState("");
  const [arch, setArch] = useState<ToothArch | "">(() => {
    const row = billedRestorations[0];
    if (row?.arch) return row.arch;
    if (selectionArch) return selectionArch;
    return "";
  });
  const [materialTouched, setMaterialTouched] = useState(false);
  const [copyTargets, setCopyTargets] = useState(initialCopyTargets ?? "");
  const [copyError, setCopyError] = useState<string | null>(null);
  const [pendingCopyTargets, setPendingCopyTargets] = useState<string[] | null>(null);
  const [moveTo, setMoveTo] = useState("");
  const [moveError, setMoveError] = useState<string | null>(null);

  const ctx = indicationCatalogContext(indication);
  const isMissing = indication === MISSING;
  const crownLike = ctx.caseType === "restorative" && ctx.subtype === "crown";

  const options = useMemo<MaterialOption[]>(() => {
    if (isMissing) return [];
    const fromCatalog = catalogMaterialsFor(catalog, indication);
    let list: MaterialOption[];
    if (fromCatalog) {
      list = fromCatalog;
      if (crownLike) for (const extra of materialOptions) if (!list.some((o) => o.key === extra.key || o.label === extra.label)) list = [...list, extra];
    } else if (crownLike) {
      const crownHelper = catalog ? getCatalogMaterialsForCrown(catalog) : [];
      list = materialOptions.length ? materialOptions : crownHelper.length ? crownHelper : getCatalogMaterialsForCrown(undefined);
    }
    else list = []; // never offer crown materials for removable/appliance/diagnostic categories
    const stored = selectedRestoration;
    if (editing && stored && !materialTouched) {
      const hit = list.some((o) => o.key === selectedMaterial || o.label === stored.material);
      const sameFamily = !stored.restorationSubtype || deriveCaseHierarchy(stored.restorationType, stored.restorationSubtype, stored.material).subtype === ctx.subtype || crownLike;
      if (!hit && stored.material && sameFamily) list = [...list, { key: selectedMaterial || stored.restorationSubtype || stored.material, label: stored.material, parentLabel: "Saved" }];
    }
    return list;
  }, [catalog, indication, isMissing, crownLike, materialOptions, editing, selectedRestoration, selectedMaterial, materialTouched, ctx.subtype]);

  const chosen = options.find((o) => o.key === selectedMaterial);
  const materialLabel = chosen?.label ?? (selectedMaterial === selectedRestoration?.restorationSubtype ? selectedRestoration?.material ?? "" : selectedMaterial);
  const keepsStored = editing && !!selectedRestoration && !materialTouched;
  const encoded = selectedMaterial
    ? selectedMaterial.includes("/") ? selectedMaterial : encodeCatalogSelection(ctx.caseType, ctx.subtype, selectedMaterial)
    : null;
  const archRequired = ctx.archBased && !isMissing;
  const effectiveShade = isCustomShade ? customShade.trim() : selectedShade;
  const canConfirm = !isPending && !isMissing && (!archRequired || !!arch) && (options.length === 0 || !!selectedMaterial);

  function pickIndication(next: string) {
    setIndication(next);
    setSelectedMaterial("");
    setMaterialTouched(true);
    if (!indicationCatalogContext(next).archBased) return;
    if (!arch && selectionArch) setArch(selectionArch);
  }

  function confirm() {
    if (!canConfirm) return;
    const shade = effectiveShade || undefined;
    const subtype = keepsStored ? selectedRestoration?.restorationSubtype ?? undefined : encoded ?? undefined;
    const material = keepsStored ? selectedRestoration?.material ?? materialLabel : materialLabel;
    if (editing && selectedRestoration) {
      onConfirm({
        kind: "replace_tooth",
        restorationId: selectedRestoration.id,
        oldToothId: toothId,
        newToothNumber: toothId,
        role: indication,
        material,
        restorationSubtype: subtype,
        shade: shade ?? "",
        ...(archRequired && arch ? { arch } : {}),
      });
      return;
    }
    if (indication === "Pontic") {
      onConfirm({ kind: "add_pontic", toothId, material: materialLabel, restorationSubtype: subtype, shade });
      return;
    }
    onConfirm({
      kind: "add_crown",
      toothId,
      material: materialLabel,
      restorationType: indication,
      restorationSubtype: subtype,
      shade,
      ...(archRequired && arch ? { arch } : {}),
    });
  }

  function requestCopyAssignment() {
    const targets = [...parseToothField(copyTargets)].filter((target) => target !== toothId);
    if (!targets.length || targets.map(Number).some((n) => !Number.isInteger(n) || n < 1 || n > 32)) {
      setCopyError("Choose valid adult tooth numbers from 1 through 32.");
      setPendingCopyTargets(null);
      return;
    }
    setCopyError(null);
    if (targets.some((t) => restorations.some((r) => parseToothField(r.toothNumber).has(t)))) {
      setPendingCopyTargets(targets);
      return;
    }
    onConfirm({ kind: "copy_assignment", restorationId: selectedRestorationId, toothNumbers: targets });
  }

  function confirmCopyAssignment() {
    if (!pendingCopyTargets?.length) return;
    onConfirm({ kind: "copy_assignment", restorationId: selectedRestorationId, toothNumbers: pendingCopyTargets });
    setPendingCopyTargets(null);
  }

  function moveTooth() {
    const parsed = parseToothField(moveTo.trim());
    if (!moveTo.trim() || parsed.size !== 1) {
      setMoveError("Enter one valid tooth number (1-32).");
      return;
    }
    setMoveError(null);
    onConfirm({ kind: "replace_tooth", restorationId: selectedRestorationId, oldToothId: toothId, newToothNumber: [...parsed][0] });
  }

  const toothSide = /^\d+$/.test(toothId)
    ? `${Number(toothId) <= 16 ? "Upper" : "Lower"} arch, patient ${Number(toothId) <= 8 || Number(toothId) >= 25 ? "right" : "left"}`
    : "Primary tooth";
  const choiceCls = (on: boolean) =>
    `min-h-10 w-full rounded-md border px-2.5 text-left text-xs font-semibold transition-colors ${on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-secondary/50 hover:bg-secondary"}`;

  if (selectedRestoration && parseToothField(selectedRestoration.toothNumber).size > 1) {
    return (
      <div className="fixed inset-0 z-[70] flex items-end justify-end bg-black/10 sm:items-center">
        <div className="bg-card border border-border rounded-t-2xl sm:rounded-xl shadow-2xl w-full sm:w-[380px] sm:mr-5 max-h-[86dvh] overflow-y-auto px-5 py-4 space-y-3" role="dialog" aria-modal="true" aria-label={`Tooth ${toothId} action`}>
          <h2 className="font-semibold">Review legacy restoration</h2>
          <p>This record covers teeth {selectedRestoration.toothNumber}. Its individual roles are unconfirmed. Remove the entire legacy row before assigning these teeth individually.</p>
          {error && <p role="alert">{error}</p>}
          <button type="button" disabled={isPending} onClick={onClose} className="min-h-11 px-3">Cancel</button>
          <button type="button" disabled={isPending} className="min-h-11 px-3 text-destructive"
            onClick={() => onConfirm({ kind: "remove_restoration", toothId, restorationId: selectedRestoration.id })}>
            Remove entire row ({selectedRestoration.toothNumber})
          </button>
        </div>
      </div>
    );
  }

  const legacyStored = editing && selectedRestoration && !isToothIndication(selectedRestoration.restorationType) && indication === selectedRestoration.restorationType;

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/20 sm:items-center">
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-xl shadow-2xl w-full sm:w-[860px] sm:max-w-[96vw] max-h-[92dvh] overflow-y-auto overscroll-contain"
        role="dialog" aria-modal="true" aria-label={`Tooth ${toothId} action`}>
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border">
          <div className="flex items-center gap-3 min-w-0">
            <svg width="56" height="52" viewBox="-28 -26 56 52" role="img" aria-label={`Tooth ${toothId} shown as ${roleFor(indication)}`} data-testid="dialog-tooth-badge" className="shrink-0">
              <ToothSilhouette toothId={toothId} x={0} y={0} nx={0} ny={0} role={roleFor(indication)} selected={false} billed={false} size={1.1} />
            </svg>
            <div className="leading-tight min-w-0">
              <h2 className="text-2xl font-semibold tracking-tight">Tooth {toothId}</h2>
              <p className="text-[11px] text-muted-foreground truncate">
                {toothSide}{groupTeeth.length ? ` · bridge ${groupTeeth.map((t) => `#${t}`).join(" ")}` : ""}
                {selectedTeeth.length > 1 ? ` · ${selectedTeeth.length} teeth selected` : ""}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={isPending} aria-label="Close" className="min-h-11 min-w-11 grid place-items-center text-muted-foreground hover:text-foreground disabled:opacity-50">
            <X size={16} />
          </button>
        </div>

        <div className="grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="px-4 py-3 space-y-3 sm:border-r border-border" role="group" aria-label="Indication">
            {TOOTH_INDICATION_GROUPS.map((group) => (
              <div key={group.label}>
                <h3 className="mb-1 text-[11px] font-semibold text-muted-foreground">{group.label}</h3>
                <div className="grid grid-cols-2 gap-1.5">
                  {group.choices.map((choice) => (
                    <button key={choice} type="button" aria-pressed={indication === choice} onClick={() => pickIndication(choice)} className={choiceCls(indication === choice)}>
                      {choice}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {legacyStored && (
              <div>
                <h3 className="mb-1 text-[11px] font-semibold text-muted-foreground">Stored value</h3>
                <button type="button" aria-pressed className={choiceCls(true)}>{indication}</button>
              </div>
            )}
            {allowMarkMissing && (
              <div>
                <h3 className="mb-1 text-[11px] font-semibold text-muted-foreground">Status (not billed)</h3>
                <button type="button" aria-pressed={isMissing} onClick={() => pickIndication(MISSING)} className={choiceCls(isMissing)}>Missing</button>
              </div>
            )}
          </div>

          <div className="px-4 py-3 space-y-3">
            {isMissing ? (
              <div className="space-y-3">
                <p className="text-sm">Mark tooth #{toothId} as missing. This status has no material, shade or charge. Any restoration on this tooth and its connectors will be removed from the working draft.</p>
                <p className="text-xs text-muted-foreground">The case and invoice change only when you save the case. Cancel leaves them unchanged.</p>
                <button type="button" disabled={isPending} onClick={() => onConfirm({ kind: "mark_missing", toothId })}
                  className="min-h-10 rounded-md bg-primary px-4 text-sm text-primary-foreground disabled:opacity-50">Apply missing status</button>
              </div>
            ) : (
              <>
                <section aria-label="Material">
                  <h3 className="mb-1 text-sm font-semibold">Material <span className="text-xs font-normal text-muted-foreground">for {indication}</span></h3>
                  {options.length === 0 ? (
                    <p className="text-xs text-muted-foreground rounded-md border border-dashed border-border p-3">No catalog materials are configured for {indication}. It will be assigned without a material.</p>
                  ) : (
                    <div className="grid grid-cols-2 gap-1.5 max-h-56 overflow-y-auto">
                      {options.map((o) => (
                        <button key={o.key} type="button" aria-pressed={selectedMaterial === o.key}
                          onClick={() => { setSelectedMaterial(o.key); setMaterialTouched(true); }}
                          className={`min-h-10 rounded-md border px-2 text-xs font-medium ${selectedMaterial === o.key ? "border-primary bg-primary/10 text-primary" : "border-border bg-secondary/50 hover:bg-secondary"}`}>
                          {o.label}{o.parentLabel ? ` · ${o.parentLabel}` : ""}
                        </button>
                      ))}
                    </div>
                  )}
                </section>

                {archRequired && (
                  <section aria-label="Arch">
                    <h3 className="mb-1 text-sm font-semibold">Arch <span className="text-xs font-normal text-muted-foreground">required</span></h3>
                    <div className="grid grid-cols-2 gap-1.5">
                      {(["upper", "lower"] as const).map((a) => (
                        <button key={a} type="button" aria-pressed={arch === a} onClick={() => setArch(a)}
                          className={`min-h-10 rounded-md border text-xs font-semibold capitalize ${arch === a ? "border-primary bg-primary text-primary-foreground" : "border-border bg-secondary/50 hover:bg-secondary"}`}>{a} arch</button>
                      ))}
                    </div>
                    {!arch && <p className="mt-1 text-xs text-muted-foreground">Choose the arch; one restoration is created for the whole arch.</p>}
                  </section>
                )}

                <section aria-label="Shade">
                  <h3 className="mb-1 text-sm font-semibold">Shade <span className="text-xs font-normal text-muted-foreground">(optional)</span></h3>
                  {caseShade && (
                    <button type="button" onClick={() => { setSelectedShade(caseShade); setIsCustomShade(false); setCustomShade(""); }}
                      className={`mb-1.5 min-h-9 w-full rounded-md border px-3 text-left text-xs font-medium ${!isCustomShade && selectedShade === caseShade ? "border-primary bg-primary/10 text-primary" : "border-border bg-secondary/50 hover:bg-secondary"}`}>
                      Use case shade · {caseShade}
                    </button>
                  )}
                  <div className="grid grid-cols-6 gap-1">
                    {VITA_SHADES.map((s) => (
                      <button key={s} type="button" onClick={() => { setSelectedShade(s); setIsCustomShade(false); setCustomShade(""); }}
                        className={`h-9 rounded-md border text-xs font-medium ${!isCustomShade && selectedShade === s ? "border-primary bg-primary/10 text-primary" : "border-border bg-secondary/50 hover:bg-secondary"}`}>{s}</button>
                    ))}
                    <button type="button" onClick={() => { setIsCustomShade(true); setSelectedShade(""); }}
                      className={`h-9 rounded-md border text-xs font-medium ${isCustomShade ? "border-primary bg-primary/10 text-primary" : "border-border bg-secondary/50 hover:bg-secondary"}`}>Other</button>
                  </div>
                  {isCustomShade && (
                    <input autoFocus placeholder="Type custom shade..." value={customShade} onChange={(e) => setCustomShade(e.target.value)}
                      className="mt-1.5 w-full h-9 px-3 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary" />
                  )}
                </section>
              </>
            )}
          </div>
        </div>

        {editing && !editingArchRow && (
          <div className="px-4 py-3 border-t border-border space-y-2">
            {billedRestorations.length > 1 && (
              <label className="block text-xs font-medium text-muted-foreground">
                Which restoration to update?
                <select value={selectedRestorationId} onChange={(e) => setSelectedRestorationId(e.target.value)}
                  className="mt-1 w-full h-9 px-2.5 rounded-md bg-secondary text-sm">
                  {billedRestorations.map((r) => (
                    <option key={r.id} value={r.id}>{r.restorationType}{[r.material, r.shade].filter(Boolean).length ? ` / ${[r.material, r.shade].filter(Boolean).join(" · ")}` : ""} — Tooth {r.toothNumber}</option>
                  ))}
                </select>
              </label>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block text-xs text-muted-foreground">
                Copy role, catalog material, and shade to unassigned teeth
                <input className="mt-1 w-full h-10 px-2 border border-border rounded-md bg-background" aria-label="Copy assignment to teeth"
                  placeholder="e.g. 4, 5 or 6-8 (same arch)" value={copyTargets} onChange={(e) => setCopyTargets(e.target.value)} />
              </label>
              <label className="block text-xs text-muted-foreground">
                Move to another tooth
                <input className="mt-1 w-full h-10 px-2 border border-border rounded-md bg-background" aria-label="Move to tooth"
                  placeholder="e.g. 13" value={moveTo} onChange={(e) => { setMoveTo(e.target.value); setMoveError(null); }} />
              </label>
              <button type="button" disabled={isPending || !copyTargets.trim()} onClick={requestCopyAssignment}
                className="min-h-10 px-3 rounded-md bg-primary text-primary-foreground text-xs disabled:opacity-40">Apply copied values to teeth</button>
              <button type="button" disabled={isPending || !moveTo.trim()} onClick={moveTooth}
                className="min-h-10 px-3 rounded-md border border-border text-xs disabled:opacity-40">Move restoration</button>
            </div>
            {copyError && <p className="text-xs text-destructive" role="alert">{copyError}</p>}
            {moveError && <p className="text-xs text-destructive" role="alert">{moveError}</p>}
            {pendingCopyTargets && (
              <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950" role="alert">
                <p>{pendingCopyTargets.length} target{pendingCopyTargets.length === 1 ? "" : "s"} already have assignments. Review before replacing: {pendingCopyTargets.map((t) => `#${t}`).join(", ")}.</p>
                <div className="flex gap-2">
                  <button type="button" disabled={isPending} onClick={() => setPendingCopyTargets(null)} className="min-h-9 rounded-md border border-amber-500/40 px-3">Keep current assignments</button>
                  <button type="button" disabled={isPending} onClick={confirmCopyAssignment} className="min-h-9 rounded-md bg-amber-700 px-3 font-medium text-white">Replace selected</button>
                </div>
              </div>
            )}
          </div>
        )}

        {error && <p className="mx-4 mb-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">{error}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-t border-border">
          <div>
            {(editing || locallySelectedType) && (
              <button type="button" disabled={isPending}
                onClick={() => onConfirm({ kind: "remove_restoration", toothId, restorationId: editing ? selectedRestorationId || undefined : undefined })}
                className="min-h-10 rounded-md border border-destructive/40 bg-destructive/10 px-3 text-sm font-medium text-destructive disabled:opacity-50">
                {editing ? "Remove restoration" : "Remove from chart"}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} disabled={isPending} className="min-h-10 rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-secondary disabled:opacity-50">Cancel</button>
            {!isMissing && (
              <button type="button" onClick={confirm} disabled={!canConfirm}
                className="min-h-10 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-50 inline-flex items-center gap-1.5">
                {isPending && <Loader2 size={13} className="animate-spin" />}
                {editing ? "Save changes" : "Confirm"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
