import { useState } from "react";
import { Loader2, X } from "lucide-react";
import type { CaseRestoration } from "@/lib/types";
import { parseToothField } from "@/components/ToothChart";

const CROWN_MATERIALS = [
  "Zirconia",
  "PFM",
  "E.max",
  "Full Cast",
  "Composite",
  "Acrylic",
  "Metal",
  "PMMA",
  "Other",
] as const;

export type ToothActionPayload =
  | {
      kind: "add_crown";
      toothId: string;
      material: string;
      restorationType: string;
    }
  | { kind: "add_pontic"; toothId: string }
  | { kind: "mark_missing"; toothId: string }
  | {
      kind: "replace_tooth";
      restorationId: string;
      oldToothId: string;
      newToothNumber: string;
      material?: string;
    };

type Step =
  | "choose_action"
  | "choose_kind"
  | "choose_material"
  | "choose_replace_tooth"
  | "ask_update_material"
  | "replace_material";

interface ToothActionDialogProps {
  toothId: string;
  restorations: CaseRestoration[];
  isPending?: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: (payload: ToothActionPayload) => void;
}

export function ToothActionDialog({
  toothId,
  restorations,
  isPending,
  error,
  onClose,
  onConfirm,
}: ToothActionDialogProps) {
  const billedRestorations = restorations.filter((r) => {
    const teeth = parseToothField(r.toothNumber);
    return teeth.has(toothId);
  });
  const isBilled = billedRestorations.length > 0;

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
  const [newToothNumber, setNewToothNumber] = useState("");
  const [newToothError, setNewToothError] = useState<string | null>(null);

  const selectedRestoration = restorations.find(
    (r) => r.id === selectedRestorationId,
  );

  function handleChooseAdd() {
    setStep("choose_kind");
  }

  function handleChooseReplace() {
    setStep("choose_replace_tooth");
  }

  function handleKindSelect(kind: "crown" | "pontic" | "missing") {
    setSelectedKind(kind);
    if (kind === "crown") {
      setStep("choose_material");
    } else {
      onConfirm(
        kind === "pontic"
          ? { kind: "add_pontic", toothId }
          : { kind: "mark_missing", toothId },
      );
    }
  }

  function handleMaterialConfirm() {
    if (!selectedMaterial) return;
    onConfirm({
      kind: "add_crown",
      toothId,
      material: selectedMaterial,
      restorationType: "Crown",
    });
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
    onConfirm({
      kind: "replace_tooth",
      restorationId: selectedRestorationId,
      oldToothId: toothId,
      newToothNumber: newToothNumber.trim(),
      material: selectedMaterial || undefined,
    });
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm mx-4"
        role="dialog"
        aria-modal="true"
        aria-label={`Tooth ${toothId} action`}
      >
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
                  : `a restoration (${billedRestorations[0]?.restorationType}${billedRestorations[0]?.material ? ` / ${billedRestorations[0].material}` : ""})`}
                .
              </p>

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
                        {r.material ? ` / ${r.material}` : ""} — Tooth{" "}
                        {r.toothNumber}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
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
              </div>
            </>
          )}

          {/* Step: choose_kind */}
          {step === "choose_kind" && (
            <>
              <p className="text-sm text-muted-foreground">
                What are you adding to tooth{" "}
                <span className="font-medium text-foreground">{toothId}</span>?
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
                ).map((opt) => (
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
            </>
          )}

          {/* Step: choose_material */}
          {step === "choose_material" && (
            <>
              <p className="text-sm text-muted-foreground">
                Select a material for the crown on tooth{" "}
                <span className="font-medium text-foreground">{toothId}</span>:
              </p>
              <div className="grid grid-cols-3 gap-2">
                {CROWN_MATERIALS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setSelectedMaterial(m)}
                    className={`h-10 rounded-lg border text-xs font-medium transition-colors ${
                      selectedMaterial === m
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-secondary/50 hover:bg-secondary"
                    }`}
                  >
                    {m}
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
                Add Crown
              </button>
            </>
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
                {CROWN_MATERIALS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setSelectedMaterial(m)}
                    className={`h-10 rounded-lg border text-xs font-medium transition-colors ${
                      selectedMaterial === m
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-secondary/50 hover:bg-secondary"
                    }`}
                  >
                    {m}
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
                Save Changes
              </button>
            </>
          )}

          {error && (
            <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
