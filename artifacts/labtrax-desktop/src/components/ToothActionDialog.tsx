import { useState } from "react";
import { Loader2, X } from "lucide-react";
import type { CaseRestoration } from "@/lib/types";
import { parseToothField } from "@/components/ToothChart";
import { encodeCatalogSelection } from "@/components/CatalogRestorationPicker";
import { isImplantRestoration } from "@workspace/case-taxonomy";

const VITA_SHADES = [
  "A1", "A2", "A3", "A3.5", "A4",
  "B1", "B2", "B3", "B4",
  "C1", "C2", "C3", "C4",
  "D2", "D3", "D4",
  "OM1", "OM2", "OM3",
  "1M1", "1M2", "1M3",
] as const;

export type ToothActionPayload =
  | { kind: "change_role"; restorationId: string; toothId: string; role: "Crown" | "Pontic" }
  | { kind: "copy_assignment"; restorationId: string; toothNumbers: string[] }
  | {
      kind: "add_crown";
      toothId: string;
      material: string;
      restorationType: string;
      restorationSubtype?: string;
      shade?: string;
    }
  | {
      kind: "add_pontic";
      toothId: string;
      material: string;
      restorationSubtype?: string;
      shade?: string;
    }
  | { kind: "mark_missing"; toothId: string }
  | {
      kind: "replace_tooth";
      restorationId: string;
      oldToothId: string;
      newToothNumber: string;
      material?: string;
      restorationSubtype?: string;
      shade?: string;
    }
  | { kind: "remove_restoration"; toothId: string; restorationId?: string };

type Step =
  | "choose_action"
  | "choose_kind"
  | "choose_material"
  | "choose_shade"
  | "choose_replace_tooth"
  | "ask_update_material"
  | "replace_material"
  | "replace_shade";

interface ToothActionDialogProps {
  allowMarkMissing?: boolean;
  toothId: string;
  restorations: CaseRestoration[];
  isPending?: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: (payload: ToothActionPayload) => void;
  locallySelectedType?: "crown" | "pontic" | "missing";
  materialOptions?: Array<{ key: string; label: string; parentLabel?: string }>;
  groupTeeth?: string[];
}

export function ToothActionDialog({
  toothId,
  restorations,
  isPending,
  error,
  onClose,
  onConfirm,
  locallySelectedType,
  materialOptions = [],
  groupTeeth = [],
  allowMarkMissing = true,
}: ToothActionDialogProps) {
  const billedRestorations = restorations.filter((r) => {
    const teeth = parseToothField(r.toothNumber);
    return /^(Crown(?:\s*(?:&|and)\s*Bridge)?|Pontic|Bridge|Implant|Veneer|Inlay|Onlay)$/i.test(r.restorationType) && teeth.has(toothId);
  });
  const isBilled = billedRestorations.length > 0;
  const [copyTargets, setCopyTargets] = useState("");
  const [copyError, setCopyError] = useState<string | null>(null);

  const [step, setStep] = useState<Step>(
    isBilled ? "choose_action" : "choose_kind",
  );
  const [selectedRestorationId, setSelectedRestorationId] = useState<string>(
    billedRestorations[0]?.id ?? "",
  );
  const [selectedKind, setSelectedKind] = useState<
    "crown" | "pontic" | "missing" | ""
  >("");
  const [selectedMaterial, setSelectedMaterial] = useState("");
  const [selectedShade, setSelectedShade] = useState("");
  const [isCustomShade, setIsCustomShade] = useState(false);
  const [customShade, setCustomShade] = useState("");
  const [newToothNumber, setNewToothNumber] = useState("");
  const [newToothError, setNewToothError] = useState<string | null>(null);

  const selectedRestoration = restorations.find(
    (r) => r.id === selectedRestorationId,
  );
  const selectedMaterialOption = materialOptions.find(
    (option) => option.key === selectedMaterial,
  );
  const selectedMaterialLabel = selectedMaterialOption?.label ?? selectedMaterial;
  const selectedRestorationSubtype = selectedMaterial
    ? selectedMaterial.includes("/") ? selectedMaterial
      : encodeCatalogSelection("restorative", selectedRestoration && isImplantRestoration(selectedRestoration) ? "implant" : "crown", selectedMaterial)
    : undefined;

  function resolvedShade() {
    if (isCustomShade) return customShade.trim();
    return selectedShade;
  }

  function handleChooseAdd() {
    setStep("choose_kind");
  }

  function handleChooseReplace() {
    setStep("choose_replace_tooth");
  }

  function handleKindSelect(kind: "crown" | "pontic" | "missing") {
    setSelectedKind(kind);
    if (kind === "crown" || kind === "pontic") {
      setStep("choose_material");
    } else {
      onConfirm({ kind: "mark_missing", toothId });
    }
  }

  function handleMaterialConfirm() {
    if (!selectedMaterial) return;
    setSelectedShade("");
    setIsCustomShade(false);
    setCustomShade("");
    setStep("choose_shade");
  }

  function handleShadeConfirm() {
    const shade = resolvedShade() || undefined;
    if (selectedKind === "pontic") {
      onConfirm({
        kind: "add_pontic",
        toothId,
        material: selectedMaterialLabel,
        restorationSubtype: selectedRestorationSubtype ?? undefined,
        shade,
      });
    } else {
      onConfirm({
        kind: "add_crown",
        toothId,
        material: selectedMaterialLabel,
        restorationType: "Crown",
        restorationSubtype: selectedRestorationSubtype ?? undefined,
        shade,
      });
    }
  }

  function handleReplaceToothNext() {
    const trimmed = newToothNumber.trim();
    if (!trimmed) {
      setNewToothError("Please enter a tooth number.");
      return;
    }
    const parsed = parseToothField(trimmed);
    if (parsed.size === 0) {
      setNewToothError("Enter a valid tooth number (1–32).");
      return;
    }
    setNewToothError(null);
    setStep("ask_update_material");
  }

  function handleUpdateMaterialYes() {
    setStep("replace_material");
  }

  function handleUpdateMaterialNo() {
    onConfirm({
      kind: "replace_tooth",
      restorationId: selectedRestorationId,
      oldToothId: toothId,
      newToothNumber: newToothNumber.trim(),
    });
  }

  function handleReplaceMaterialConfirm() {
    if (!selectedMaterial) return;
    setSelectedShade("");
    setIsCustomShade(false);
    setCustomShade("");
    setStep("replace_shade");
  }

  function handleReplaceShadeConfirm() {
    const shade = resolvedShade() || undefined;
    onConfirm({
      kind: "replace_tooth",
      restorationId: selectedRestorationId,
      oldToothId: toothId,
      newToothNumber: newToothNumber.trim(),
      material: selectedMaterialLabel || undefined,
      restorationSubtype: selectedRestorationSubtype ?? undefined,
      shade,
    });
  }

  function renderShadeStep(onSkip: () => void, onConfirmShade: () => void) {
    return (
      <>
        <p className="text-sm text-muted-foreground">
          Select a shade{" "}
          <span className="text-muted-foreground/70">(optional)</span>:
        </p>
        <div className="grid grid-cols-4 gap-1.5">
          {VITA_SHADES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setSelectedShade(s);
                setIsCustomShade(false);
                setCustomShade("");
              }}
              className={`h-9 rounded-lg border text-xs font-medium transition-colors ${
                !isCustomShade && selectedShade === s
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-secondary/50 hover:bg-secondary"
              }`}
            >
              {s}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setIsCustomShade(true);
              setSelectedShade("");
            }}
            className={`h-9 rounded-lg border text-xs font-medium transition-colors col-span-1 ${
              isCustomShade
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-secondary/50 hover:bg-secondary"
            }`}
          >
            Other
          </button>
        </div>
        {isCustomShade && (
          <input
            autoFocus
            placeholder="Type custom shade…"
            value={customShade}
            onChange={(e) => setCustomShade(e.target.value)}
            className="w-full h-9 px-3 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary"
          />
        )}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onSkip}
            disabled={isPending}
            className="h-9 rounded-lg border border-border bg-secondary/50 hover:bg-secondary text-sm font-medium transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
          >
            {isPending && <Loader2 size={13} className="animate-spin" />}
            Skip
          </button>
          <button
            type="button"
            onClick={onConfirmShade}
            disabled={
              isPending ||
              (isCustomShade ? !customShade.trim() : !selectedShade)
            }
            className="h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
          >
            {isPending && <Loader2 size={13} className="animate-spin" />}
            Confirm
          </button>
        </div>
      </>
    );
  }

  function materialShadeLabel(material?: string | null, shade?: string | null) {
    const parts = [material, shade].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : "";
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm mx-4"
        role="dialog"
        aria-modal="true"
        aria-label={`Tooth ${toothId} action`}
      >
        {selectedRestoration && parseToothField(selectedRestoration.toothNumber).size > 1 ? (
          <div className="px-5 py-4 space-y-3">
            <h2 className="font-semibold">Review legacy restoration</h2>
            <p>This record covers teeth {selectedRestoration.toothNumber}. Its individual roles are unconfirmed. Remove the entire legacy row before assigning these teeth individually.</p>
            {error && <p role="alert">{error}</p>}
            <button type="button" disabled={isPending} onClick={onClose} className="min-h-11 px-3">Cancel</button>
            <button type="button" disabled={isPending} className="min-h-11 px-3 text-destructive"
              onClick={() => onConfirm({ kind: "remove_restoration", toothId, restorationId: selectedRestoration.id })}>
              Remove entire row ({selectedRestoration.toothNumber})
            </button>
          </div>
        ) : <div>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold">Tooth {toothId}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Step: choose_action — tooth is already billed */}
          {step === "choose_action" && (
            <>
              <p className="text-sm text-muted-foreground">
                Tooth <span className="font-medium text-foreground">{toothId}</span> already has{" "}
                {billedRestorations.length > 1
                  ? `${billedRestorations.length} restoration(s)`
                  : `a restoration (${billedRestorations[0]?.restorationType}${materialShadeLabel(billedRestorations[0]?.material, billedRestorations[0]?.shade) ? ` / ${materialShadeLabel(billedRestorations[0]?.material, billedRestorations[0]?.shade)}` : ""})`}
                .
              </p>
              <p className="text-xs text-muted-foreground">
                {groupTeeth.length ? `Connected group: ${groupTeeth.map((tooth) => `#${tooth}`).join(", ")}` : "Not connected to another assigned unit."}
              </p>
              {billedRestorations.length === 1 &&
                parseToothField(billedRestorations[0].toothNumber).size === 1 && (
                  <div className="flex gap-2">
                    {(["Crown", "Pontic"] as const).map((role) => (
                      <button key={role} type="button" disabled={isPending}
                        className="min-h-10 px-3 rounded-md border border-border text-xs"
                        onClick={() => onConfirm({ kind: "change_role", restorationId: billedRestorations[0].id, toothId, role })}>
                        Set as {role === "Crown" ? "prepared crown" : "pontic"}
                      </button>
                    ))}
                  </div>
                )}
              <label className="block text-xs text-muted-foreground">
                Copy role, catalog material, and shade to unassigned teeth
                <input className="mt-1 w-full h-10 px-2 border border-border rounded-md bg-background"
                  aria-label="Copy assignment to teeth"
                  placeholder="e.g. 4, 5 or 6-8 (same arch)"
                  value={copyTargets} onChange={(event) => setCopyTargets(event.target.value)} />
              </label>
              <button type="button" disabled={isPending || !copyTargets.trim()}
                className="min-h-10 px-3 rounded-md bg-primary text-primary-foreground text-xs disabled:opacity-40"
                onClick={() => {
                  const targets = [...parseToothField(copyTargets)].filter((target) => target !== toothId);
                  const numbers = targets.map(Number);
                  if (!targets.length || numbers.some((n) => !Number.isInteger(n) || n < 1 || n > 32) ||
                      numbers.some((n) => (n <= 16) !== (numbers[0] <= 16))) {
                    setCopyError("Choose valid teeth from one arch.");
                    return;
                  }
                  setCopyError(null);
                  onConfirm({ kind: "copy_assignment", restorationId: selectedRestorationId, toothNumbers: targets });
                }}>
                Apply copied values to teeth
              </button>
              {copyError && <p className="text-xs text-destructive" role="alert">{copyError}</p>}

              {billedRestorations.length > 1 && (
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Which restoration to update?
                  </label>
                  <select
                    value={selectedRestorationId}
                    onChange={(e) => setSelectedRestorationId(e.target.value)}
                    className="w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    {billedRestorations.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.restorationType}
                        {materialShadeLabel(r.material, r.shade) ? ` / ${materialShadeLabel(r.material, r.shade)}` : ""} — Tooth{" "}
                        {r.toothNumber}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={handleChooseReplace}
                  className="h-20 rounded-lg border border-border bg-secondary/50 hover:bg-secondary text-sm font-medium flex flex-col items-center justify-center gap-1 transition-colors px-2 text-center"
                >
                  <span className="text-base">🔄</span>
                  Replace
                  <span className="text-[10px] font-normal text-muted-foreground">
                    Move to a different tooth #
                  </span>
                </button>
                <button
                  type="button"
                  onClick={handleChooseAdd}
                  className="h-20 rounded-lg border border-border bg-secondary/50 hover:bg-secondary text-sm font-medium flex flex-col items-center justify-center gap-1 transition-colors px-2 text-center"
                >
                  <span className="text-base">➕</span>
                  Add alongside
                  <span className="text-[10px] font-normal text-muted-foreground">
                    New restoration on this tooth
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onConfirm({
                      kind: "remove_restoration",
                      toothId,
                      restorationId: selectedRestorationId || undefined,
                    })
                  }
                  disabled={isPending}
                  className="h-20 rounded-lg border border-destructive/40 bg-destructive/10 hover:bg-destructive/20 text-destructive text-sm font-medium flex flex-col items-center justify-center gap-1 transition-colors px-2 text-center disabled:opacity-50"
                >
                  <span className="text-base">🗑️</span>
                  Remove
                  <span className="text-[10px] font-normal text-destructive/70">
                    Delete this restoration
                  </span>
                </button>
              </div>
            </>
          )}

          {/* Step: choose_kind */}
          {step === "choose_kind" && (
            <>
              <p className="text-sm text-muted-foreground">
                {locallySelectedType
                  ? <>Tooth <span className="font-medium text-foreground">{toothId}</span> is already marked as <span className="font-medium text-foreground">{locallySelectedType}</span>. Add a different type or remove it.</>
                  : <>What are you adding to tooth{" "}<span className="font-medium text-foreground">{toothId}</span>?</>
                }
              </p>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    {
                      kind: "crown" as const,
                      icon: "👑",
                      label: "Crown / Restoration",
                      desc: "Adds a billed line item",
                    },
                    {
                      kind: "pontic" as const,
                      icon: "🔗",
                      label: "Pontic",
                      desc: "Bridge unit",
                    },
                    {
                      kind: "missing" as const,
                      icon: "✕",
                      label: "Missing",
                      desc: "Visual only, no invoice",
                    },
                  ] as const
                ).filter((opt) => allowMarkMissing || opt.kind !== "missing").map((opt) => (
                  <button
                    key={opt.kind}
                    type="button"
                    onClick={() => handleKindSelect(opt.kind)}
                    className="h-24 rounded-lg border border-border bg-secondary/50 hover:bg-secondary text-xs font-medium flex flex-col items-center justify-center gap-1 transition-colors px-1 text-center"
                  >
                    <span className="text-xl">{opt.icon}</span>
                    <span>{opt.label}</span>
                    <span className="text-[10px] font-normal text-muted-foreground">
                      {opt.desc}
                    </span>
                  </button>
                ))}
              </div>
              {locallySelectedType && (
                <button
                  type="button"
                  onClick={() =>
                    onConfirm({ kind: "remove_restoration", toothId })
                  }
                  disabled={isPending}
                  className="w-full h-9 rounded-lg border border-destructive/40 bg-destructive/10 hover:bg-destructive/20 text-destructive text-sm font-medium transition-colors disabled:opacity-50"
                >
                  Remove from chart
                </button>
              )}
            </>
          )}

          {/* Step: choose_material */}
          {step === "choose_material" && (
            <>
              <p className="text-sm text-muted-foreground">
                Select a material for the {selectedKind === "pontic" ? "pontic" : "crown"} on tooth{" "}
                <span className="font-medium text-foreground">{toothId}</span>:
              </p>
              <div className="grid grid-cols-3 gap-2">
                {materialOptions.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setSelectedMaterial(option.key)}
                    className={`h-10 rounded-lg border text-xs font-medium transition-colors ${
                        selectedMaterial === option.key
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-secondary/50 hover:bg-secondary"
                    }`}
                  >
                    {option.label}{option.parentLabel ? ` · ${option.parentLabel}` : ""}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={handleMaterialConfirm}
                disabled={!selectedMaterial || isPending}
                className="w-full h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
              >
                {isPending && <Loader2 size={13} className="animate-spin" />}
                Next — Pick Shade
              </button>
            </>
          )}

          {/* Step: choose_shade (crown or pontic path) */}
          {step === "choose_shade" &&
            renderShadeStep(
              () => {
                if (selectedKind === "pontic") {
                  onConfirm({
                    kind: "add_pontic",
                    toothId,
                    material: selectedMaterialLabel,
                    restorationSubtype: selectedRestorationSubtype ?? undefined,
                  });
                } else {
                  onConfirm({
                    kind: "add_crown",
                    toothId,
                    material: selectedMaterialLabel,
                    restorationType: "Crown",
                    restorationSubtype: selectedRestorationSubtype ?? undefined,
                  });
                }
              },
              handleShadeConfirm,
            )}

          {/* Step: choose_replace_tooth */}
          {step === "choose_replace_tooth" && (
            <>
              <p className="text-sm text-muted-foreground">
                Move{" "}
                <span className="font-medium text-foreground">
                  {selectedRestoration?.restorationType ?? "restoration"}
                </span>{" "}
                from tooth {toothId} to which tooth number?
              </p>
              <div>
                <input
                  autoFocus
                  placeholder="New tooth # (e.g. 13)"
                  value={newToothNumber}
                  onChange={(e) => {
                    setNewToothNumber(e.target.value);
                    setNewToothError(null);
                  }}
                  className="w-full h-9 px-3 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary"
                />
                {newToothError && (
                  <p className="mt-1 text-xs text-destructive">{newToothError}</p>
                )}
              </div>
              <button
                type="button"
                onClick={handleReplaceToothNext}
                disabled={!newToothNumber.trim()}
                className="w-full h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
              >
                Next
              </button>
            </>
          )}

          {/* Step: ask_update_material */}
          {step === "ask_update_material" && (
            <>
              <p className="text-sm text-muted-foreground">
                Moving to tooth{" "}
                <span className="font-medium text-foreground">{newToothNumber}</span>.
                Update the material too?
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleUpdateMaterialYes}
                  className="h-12 rounded-lg border border-border bg-secondary/50 hover:bg-secondary text-sm font-medium transition-colors"
                >
                  Yes — pick material
                </button>
                <button
                  type="button"
                  onClick={handleUpdateMaterialNo}
                  disabled={isPending}
                  className="h-12 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
                >
                  {isPending && <Loader2 size={13} className="animate-spin" />}
                  No — save now
                </button>
              </div>
            </>
          )}

          {/* Step: replace_material */}
          {step === "replace_material" && (
            <>
              <p className="text-sm text-muted-foreground">
                Select the new material:
              </p>
              <div className="grid grid-cols-3 gap-2">
                {materialOptions.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setSelectedMaterial(option.key)}
                    className={`h-10 rounded-lg border text-xs font-medium transition-colors ${
                        selectedMaterial === option.key
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-secondary/50 hover:bg-secondary"
                    }`}
                  >
                    {option.label}{option.parentLabel ? ` · ${option.parentLabel}` : ""}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={handleReplaceMaterialConfirm}
                disabled={!selectedMaterial || isPending}
                className="w-full h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
              >
                {isPending && <Loader2 size={13} className="animate-spin" />}
                Next — Pick Shade
              </button>
            </>
          )}

          {/* Step: replace_shade (replace tooth path) */}
          {step === "replace_shade" &&
            renderShadeStep(
              () =>
                onConfirm({
                  kind: "replace_tooth",
                  restorationId: selectedRestorationId,
                  oldToothId: toothId,
                  newToothNumber: newToothNumber.trim(),
                  material: selectedMaterialLabel || undefined,
                  restorationSubtype: selectedRestorationSubtype ?? undefined,
                }),
              handleReplaceShadeConfirm,
            )}

          {error && (
            <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </p>
          )}
        </div>
        </div>}
      </div>
    </div>
  );
}
