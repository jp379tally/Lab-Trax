import { useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import {
  REMAKE_REASONS,
  CUSTOM_REMAKE_REASON_MAX_LENGTH,
  remakeReasonUsesField,
  type RemakeReasonKey,
} from "@workspace/case-taxonomy";

/**
 * Shared remake-linking building blocks used by the New Case dialog
 * (cases.tsx), the case-detail "Create Remake" modal (cases.tsx), and the
 * Invoice Editor's "Mark as remake" action (invoices.tsx). Keeping this in
 * one place means the reason catalogue, questionnaire fields, and the
 * "search for the original case" picker stay in lockstep across every
 * surface that can link a remake.
 */

export { REMAKE_REASONS, CUSTOM_REMAKE_REASON_MAX_LENGTH };
export type { RemakeReasonKey };

export interface RemakeQuestionnaireValue {
  reasonKey: RemakeReasonKey | "";
  customReason?: string;
  shadeLightness: "light" | "dark" | "";
  shadePrescribed: string;
  shadeProvided: string;
  materialPrescribed: string;
  materialProvided: string;
  returnedToLab: boolean | null;
  category: "crown_bridge" | "removable" | "";
  charge: "yes" | "no" | "";
  notes: string;
}

export function blankQuestionnaire(): RemakeQuestionnaireValue {
  return {
    reasonKey: "", customReason: "", shadeLightness: "", shadePrescribed: "", shadeProvided: "",
    materialPrescribed: "", materialProvided: "", returnedToLab: null, category: "", charge: "",
    notes: "",
  };
}

/** Inline structured remake questionnaire used in the new-case form, the duplicate
 *  modal, the case-detail "Create Remake" modal, and the invoice "Mark as remake" flow. */
export function RemakeQuestionnaire({
  value,
  onChange,
  size = "md",
  isAdmin = false,
}: {
  value: RemakeQuestionnaireValue;
  onChange: (v: RemakeQuestionnaireValue) => void;
  size?: "sm" | "md";
  isAdmin?: boolean;
}) {
  const showShade = remakeReasonUsesField(value.reasonKey, "shade");
  const showMaterial = remakeReasonUsesField(value.reasonKey, "material");
  const showCustomReason = remakeReasonUsesField(value.reasonKey, "customReason");
  const customReason = value.customReason ?? "";
  const h = size === "sm" ? "h-7" : "h-8";
  const txt = size === "sm" ? "text-xs" : "text-xs";
  const inputCls = `w-full ${h} px-2 rounded-md bg-background ${txt} border border-border focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary`;
  const labelCls = "block text-[11px] font-medium text-muted-foreground mb-1";

  function toggleCls(active: boolean, variant: "primary" | "amber" = "primary") {
    return `flex-1 ${h} rounded-md ${txt} font-medium transition-colors ${
      active
        ? variant === "amber"
          ? "bg-amber-500/15 text-amber-700 border border-amber-500/40"
          : "bg-primary/10 text-primary border border-primary/30"
        : "bg-secondary text-muted-foreground border border-transparent hover:bg-secondary/80"
    }`;
  }

  function set(patch: Partial<RemakeQuestionnaireValue>) {
    onChange({ ...value, ...patch });
  }

  return (
    <div className="space-y-3">
      <div>
        <label className={labelCls}>
          Remake reason <span className="text-destructive">*</span>
        </label>
        <select
          value={value.reasonKey}
          onChange={(e) => {
            const key = e.target.value as RemakeReasonKey | "";
            const found = REMAKE_REASONS.find((r) => r.key === key);
            set({
              reasonKey: key,
              customReason: key === "other" ? customReason : "",
              category: found?.category ?? "",
              shadeLightness: remakeReasonUsesField(key, "shade") ? value.shadeLightness : "",
              shadePrescribed: remakeReasonUsesField(key, "shade") ? value.shadePrescribed : "",
              shadeProvided: remakeReasonUsesField(key, "shade") ? value.shadeProvided : "",
              materialPrescribed: remakeReasonUsesField(key, "material") ? value.materialPrescribed : "",
              materialProvided: remakeReasonUsesField(key, "material") ? value.materialProvided : "",
            });
          }}
          className={`${inputCls} pr-6`}
        >
          <option value="">Select a reason…</option>
          <optgroup label="Crown &amp; Bridge">
            {REMAKE_REASONS.filter((r) => r.category === "crown_bridge").map((r) => (
              <option key={r.key} value={r.key}>{r.label}</option>
            ))}
          </optgroup>
          <optgroup label="Removable">
            {REMAKE_REASONS.filter((r) => r.category === "removable").map((r) => (
              <option key={r.key} value={r.key}>{r.label}</option>
            ))}
          </optgroup>
          <option value="other">Other</option>
        </select>
      </div>

      {showCustomReason && (
        <div>
          <label htmlFor="remake-custom-reason" className={labelCls}>
            Custom remake reason <span className="text-destructive">*</span>
          </label>
          <input
            id="remake-custom-reason"
            type="text"
            value={customReason}
            maxLength={CUSTOM_REMAKE_REASON_MAX_LENGTH}
            aria-required="true"
            aria-describedby="remake-custom-reason-help"
            onChange={(e) => set({ customReason: e.target.value })}
            placeholder="Describe why this case needs a remake"
            className={inputCls}
          />
          <p id="remake-custom-reason-help" className="mt-1 text-[11px] text-muted-foreground">
            Required · {customReason.length}/{CUSTOM_REMAKE_REASON_MAX_LENGTH}
          </p>
        </div>
      )}

      {showShade && (
        <>
          <div>
            <label className={labelCls}>Shade — too light or too dark?</label>
            <div className="flex gap-2">
              {(["light", "dark"] as const).map((v) => (
                <button key={v} type="button"
                  onClick={() => set({ shadeLightness: value.shadeLightness === v ? "" : v })}
                  className={toggleCls(value.shadeLightness === v)}
                >
                  {v === "light" ? "Too light" : "Too dark"}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>Shade prescribed</label>
              <input type="text" className={inputCls} value={value.shadePrescribed}
                onChange={(e) => set({ shadePrescribed: e.target.value })} placeholder="e.g. A2" />
            </div>
            <div>
              <label className={labelCls}>Shade provided</label>
              <input type="text" className={inputCls} value={value.shadeProvided}
                onChange={(e) => set({ shadeProvided: e.target.value })} placeholder="e.g. B1" />
            </div>
          </div>
        </>
      )}

      {showMaterial && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>Material prescribed</label>
            <input type="text" className={inputCls} value={value.materialPrescribed}
              onChange={(e) => set({ materialPrescribed: e.target.value })} placeholder="e.g. PFZ" />
          </div>
          <div>
            <label className={labelCls}>Material provided</label>
            <input type="text" className={inputCls} value={value.materialProvided}
              onChange={(e) => set({ materialProvided: e.target.value })} placeholder="e.g. Zirconia" />
          </div>
        </div>
      )}

      <div>
        <label className={labelCls}>Items returned to lab?</label>
        <div className="flex gap-2">
          <button type="button" onClick={() => set({ returnedToLab: value.returnedToLab === true ? null : true })}
            className={toggleCls(value.returnedToLab === true)}>Yes</button>
          <button type="button" onClick={() => set({ returnedToLab: value.returnedToLab === false ? null : false })}
            className={toggleCls(value.returnedToLab === false)}>No</button>
        </div>
      </div>

      <div>
        <label className={labelCls}>
          Charge for this remake? <span className="text-destructive">*</span>
        </label>
        <div className="flex gap-2">
          <button type="button" onClick={() => set({ charge: value.charge === "yes" ? "" : "yes" })}
            className={toggleCls(value.charge === "yes")}>Yes — invoice as usual</button>
          <button type="button" onClick={() => set({ charge: value.charge === "no" ? "" : "no" })}
            className={toggleCls(value.charge === "no", "amber")}>No — no-charge</button>
        </div>
      </div>

      {isAdmin && (
        <div>
          <label className={labelCls}>Remake notes (technician instructions)</label>
          <textarea
            value={value.notes}
            onChange={(e) => set({ notes: e.target.value })}
            rows={3}
            placeholder="Optional: enter specific instructions for the technician…"
            className={`w-full px-2 py-1.5 rounded-md bg-background text-xs border border-border focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary resize-none`}
          />
        </div>
      )}
    </div>
  );
}

export interface RemakeDecision {
  remakeOfCaseId: string;
  remakeReason: string;
  remakeCharged: boolean | null;
  remakeReasonKey?: RemakeReasonKey;
  remakeShadeLightness?: "light" | "dark";
  remakeShadePrescribed?: string;
  remakeShadeProvided?: string;
  remakeMaterialPrescribed?: string;
  remakeMaterialProvided?: string;
  remakeReturnedToLab?: boolean;
  remakeCategory?: "crown_bridge" | "removable";
  remakeNotes?: string;
}

export function remakeQuestionnaireError(q: RemakeQuestionnaireValue): string | null {
  if (!q.reasonKey) return "Select a remake reason.";
  if (q.reasonKey === "other") {
    const custom = (q.customReason ?? "").trim();
    if (!custom) return "Enter a custom remake reason.";
    if (custom.length > CUSTOM_REMAKE_REASON_MAX_LENGTH) {
      return `Custom remake reason must be ${CUSTOM_REMAKE_REASON_MAX_LENGTH} characters or fewer.`;
    }
  }
  if (q.charge === "") return "Choose whether to charge for this remake.";
  return null;
}

export function isRemakeQuestionnaireComplete(q: RemakeQuestionnaireValue): boolean {
  return remakeQuestionnaireError(q) === null;
}

export interface RemakeCaseHit {
  id: string;
  caseNumber: string;
  patientFirstName: string;
  patientLastName: string;
  doctorName: string;
  status: string;
}

/** Maps a filled-out questionnaire + selected original into the payload shape
 *  expected by the remake-linking endpoints (POST /cases, POST /cases/:id/remake,
 *  PATCH /cases/:id/mark-as-remake). Omits optional fields the user left blank. */
export function buildRemakeLinkPayload(
  original: RemakeCaseHit,
  q: RemakeQuestionnaireValue,
): RemakeDecision {
  const reasonLabel = q.reasonKey === "other"
    ? (q.customReason ?? "").trim()
    : REMAKE_REASONS.find((r) => r.key === q.reasonKey)?.label ?? q.reasonKey;
  return {
    remakeOfCaseId: original.id,
    remakeReason: reasonLabel,
    remakeCharged: q.charge === "yes" ? true : q.charge === "no" ? false : null,
    ...(q.reasonKey ? { remakeReasonKey: q.reasonKey } : {}),
    ...(q.shadeLightness ? { remakeShadeLightness: q.shadeLightness } : {}),
    ...(q.shadePrescribed.trim() ? { remakeShadePrescribed: q.shadePrescribed.trim() } : {}),
    ...(q.shadeProvided.trim() ? { remakeShadeProvided: q.shadeProvided.trim() } : {}),
    ...(q.materialPrescribed.trim() ? { remakeMaterialPrescribed: q.materialPrescribed.trim() } : {}),
    ...(q.materialProvided.trim() ? { remakeMaterialProvided: q.materialProvided.trim() } : {}),
    ...(q.returnedToLab !== null ? { remakeReturnedToLab: q.returnedToLab } : {}),
    ...(q.category ? { remakeCategory: q.category } : {}),
    ...(q.notes.trim() ? { remakeNotes: q.notes.trim() } : {}),
  };
}

/**
 * Search-and-select picker for "which existing case is being remade", plus
 * the questionnaire once one is picked. Used standalone (New Case dialog) or
 * inside a purpose-built modal (Invoice Editor's "Mark as remake" action).
 */
export function RemakeOriginalPicker({
  labOrganizationId,
  selected,
  onSelect,
  onClear,
  questionnaire,
  onQuestionnaireChange,
  isAdmin = false,
  excludeCaseId,
  size = "sm",
}: {
  labOrganizationId: string;
  selected: RemakeCaseHit | null;
  onSelect: (hit: RemakeCaseHit) => void;
  onClear: () => void;
  questionnaire: RemakeQuestionnaireValue;
  onQuestionnaireChange: (v: RemakeQuestionnaireValue) => void;
  isAdmin?: boolean;
  excludeCaseId?: string;
  size?: "sm" | "md";
}) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<RemakeCaseHit[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimerRef = useRef<number | null>(null);

  // Prefetch the next remake suffix so the picker can preview the number that
  // will actually be assigned. This matters when the selected case is itself a
  // remake (e.g. remaking "26-334B" yields "26-334C", not "26-334BB").
  const nextSuffixQuery = useQuery({
    queryKey: ["next-remake-suffix", selected?.id],
    queryFn: () =>
      apiFetch<{ caseNumber: string }>(
        `/cases/next-remake-suffix?remakeOfCaseId=${encodeURIComponent(selected!.id)}`,
      ),
    enabled: !!selected,
    staleTime: 15_000,
  });

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2">
      {!selected ? (
        <>
          <p className="text-[11px] font-medium text-foreground">
            Find the original case being remade
          </p>
          {!labOrganizationId ? (
            <p className="text-[11px] text-muted-foreground">
              Select a lab organization to search cases.
            </p>
          ) : (
            <>
              <div className="relative">
                <input
                  type="search"
                  placeholder="Search by case #, patient, or doctor…"
                  value={search}
                  onChange={(e) => {
                    const q = e.target.value;
                    setSearch(q);
                    if (searchTimerRef.current !== null) {
                      window.clearTimeout(searchTimerRef.current);
                    }
                    if (q.length < 2) {
                      setResults([]);
                      setSearching(false);
                      return;
                    }
                    setSearching(true);
                    searchTimerRef.current = window.setTimeout(async () => {
                      searchTimerRef.current = null;
                      try {
                        const result = await apiFetch<{ cases: RemakeCaseHit[] }>(
                          `/cases/quick-search?labOrganizationId=${encodeURIComponent(labOrganizationId)}&q=${encodeURIComponent(q)}`,
                        );
                        const hits = (result.cases ?? []).filter((c) => c.id !== excludeCaseId);
                        setResults(hits);
                      } catch {
                        setResults([]);
                      } finally {
                        setSearching(false);
                      }
                    }, 280);
                  }}
                  className="w-full h-8 px-2.5 pr-7 rounded-md bg-background text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                />
                {searching && (
                  <Loader2
                    size={12}
                    className="absolute right-2.5 top-2 animate-spin text-muted-foreground"
                  />
                )}
              </div>
              {results.length > 0 && (
                <div className="rounded-md border border-border bg-card overflow-hidden max-h-40 overflow-y-auto divide-y divide-border">
                  {results.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        onSelect(c);
                        setSearch("");
                        setResults([]);
                      }}
                      className="w-full px-3 py-2 text-left text-xs hover:bg-secondary/50 transition-colors"
                    >
                      <div className="font-medium font-mono">
                        {c.caseNumber} · {c.patientFirstName} {c.patientLastName}
                      </div>
                      <div className="text-muted-foreground text-[11px]">
                        {c.doctorName} · {c.status}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {search.length >= 2 && !searching && results.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  No cases found for "{search}".
                </p>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-foreground">
                Remaking:{" "}
                <span className="font-mono">{selected.caseNumber}</span>
                {nextSuffixQuery.data?.caseNumber && (
                  <span className="text-muted-foreground font-normal">
                    {" "}— new number:{" "}
                    <span className="font-mono text-foreground">
                      {nextSuffixQuery.data.caseNumber}
                    </span>
                  </span>
                )}
                {nextSuffixQuery.isFetching && !nextSuffixQuery.data && (
                  <span className="text-muted-foreground font-normal"> — fetching number…</span>
                )}
              </p>
              <p className="text-[11px] text-muted-foreground truncate">
                {selected.patientFirstName} {selected.patientLastName} ·{" "}
                {selected.doctorName}
              </p>
            </div>
            <button
              type="button"
              onClick={onClear}
              className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Clear remake selection"
            >
              <X size={13} />
            </button>
          </div>
          <RemakeQuestionnaire value={questionnaire} onChange={onQuestionnaireChange} size={size} isAdmin={isAdmin} />
        </>
      )}
    </div>
  );
}
