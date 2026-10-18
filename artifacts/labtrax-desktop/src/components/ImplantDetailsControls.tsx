import { useEffect, useState } from "react";
import { IMPLANT_RETENTIONS, IMPLANT_MANUFACTURERS, IMPLANT_PLATFORM_PLACEHOLDER, IMPLANT_FIELDS, type ImplantDetails } from "@workspace/case-taxonomy";
import { apiFetch } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export function ImplantDetailsControls({ value, onChange, disabled = false }: {
  value: ImplantDetails; onChange: (value: ImplantDetails) => void; disabled?: boolean;
}) {
  return <>
    <label className="min-w-0 text-xs text-muted-foreground">Retention
      <select aria-label="Implant Retention" className="block w-full h-9 rounded border border-border bg-secondary px-2 text-sm" value={value.implantRetention ?? ""} disabled={disabled}
        onChange={(e) => onChange({ ...value, implantRetention: e.target.value || null })}>
        <option value="">—</option>{IMPLANT_RETENTIONS.map((v) => <option key={v}>{v}</option>)}
      </select>
    </label>
    <label className="min-w-0 text-xs text-muted-foreground">Implant Manufacturer
      <select aria-label="Implant Manufacturer" className="block w-full h-9 rounded border border-border bg-secondary px-2 text-sm" value={value.implantManufacturer ?? ""} disabled={disabled}
        onChange={(e) => onChange({ ...value, implantManufacturer: e.target.value || null })}>
        <option value="">—</option>{IMPLANT_MANUFACTURERS.map((v) => <option key={v}>{v}</option>)}
      </select>
    </label>
    <label className="min-w-0 text-xs text-muted-foreground">Implant Platform Notes
      <input aria-label="Implant Platform Notes" className="block w-full h-9 rounded border border-border bg-secondary px-2 text-sm" maxLength={10000}
        placeholder={IMPLANT_PLATFORM_PLACEHOLDER} value={value.implantPlatformNotes ?? ""} disabled={disabled}
        onChange={(e) => onChange({ ...value, implantPlatformNotes: e.target.value || null })} />
    </label>
  </>;
}

/** Row-scoped editor also serves read-only case viewers. */
export function SavedImplantDetails({ row, caseId, canEdit }: {
  row: ImplantDetails & { id: string; toothNumber?: string | null }; caseId: string; canEdit: boolean;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ImplantDetails>(row);
  const [confirmed, setConfirmed] = useState<ImplantDetails>(row);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(row); setConfirmed(row); }, [row]);
  async function save() {
    setSaving(true);
    try {
      const body = Object.fromEntries(IMPLANT_FIELDS.map((key) => [key, draft[key] || null]));
      await apiFetch(`/cases/${caseId}/restorations/${row.id}`, { method: "PATCH", body: JSON.stringify({ ...body, syncLinkedArch: false }) });
      setConfirmed(draft);
      await Promise.allSettled([qc.invalidateQueries({ queryKey: ["case", caseId] }), qc.invalidateQueries({ queryKey: ["cases"] })]);
      toast.success("Implant details saved.");
    } catch (e) {
      setDraft(confirmed);
      toast.error(e instanceof Error ? e.message : "Could not save implant details.");
    } finally { setSaving(false); }
  }
  return <div className="space-y-2 border-t border-border pt-2">
    <div className="text-xs font-medium">Implant · Tooth {row.toothNumber || "—"}</div>
    {canEdit ? <>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(150px,100%),1fr))] gap-2"><ImplantDetailsControls value={draft} onChange={setDraft} disabled={saving} /></div>
      <button type="button" disabled={saving || IMPLANT_FIELDS.every((key) => (draft[key] || null) === (confirmed[key] || null))} onClick={save} className="h-8 px-3 rounded bg-primary text-primary-foreground text-xs disabled:opacity-50">Save implant details</button>
    </> : IMPLANT_FIELDS.map((key) => draft[key] ? <div key={key} className="text-sm whitespace-pre-wrap break-words">{key === "implantRetention" ? "Retention" : key === "implantManufacturer" ? "Implant Manufacturer" : "Implant Platform Notes"}: {draft[key]}</div> : null)}
  </div>;
}
