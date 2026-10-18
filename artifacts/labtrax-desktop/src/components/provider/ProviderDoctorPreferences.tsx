import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

export type DoctorPreferencesData = {
  occlusionAmount: number | null;
  occlusionUnit: "mm" | "microns" | null;
  proximalContactAmount: number | null;
  proximalContactUnit: "mm" | "microns" | null;
  anatomyPreference: "primary_only" | "primary_and_secondary" | "other" | null;
  anatomyOther: string | null;
  caseQuestionContactMethod: "text" | "phone_call" | "email" | null;
  caseQuestionContactValue: string | null;
};

type DoctorPreferencesForm = {
  occlusionAmount: string;
  occlusionUnit: "" | "mm" | "microns";
  proximalContactAmount: string;
  proximalContactUnit: "" | "mm" | "microns";
  anatomyPreference: "" | "primary_only" | "primary_and_secondary" | "other";
  anatomyOther: string;
  caseQuestionContactMethod: "" | "text" | "phone_call" | "email";
  caseQuestionContactValue: string;
};

const EMPTY_FORM: DoctorPreferencesForm = {
  occlusionAmount: "",
  occlusionUnit: "",
  proximalContactAmount: "",
  proximalContactUnit: "",
  anatomyPreference: "",
  anatomyOther: "",
  caseQuestionContactMethod: "",
  caseQuestionContactValue: "",
};

function toForm(data: DoctorPreferencesData): DoctorPreferencesForm {
  return {
    occlusionAmount: data.occlusionAmount == null ? "" : String(data.occlusionAmount),
    occlusionUnit: data.occlusionUnit ?? "",
    proximalContactAmount:
      data.proximalContactAmount == null ? "" : String(data.proximalContactAmount),
    proximalContactUnit: data.proximalContactUnit ?? "",
    anatomyPreference: data.anatomyPreference ?? "",
    anatomyOther: data.anatomyOther ?? "",
    caseQuestionContactMethod: data.caseQuestionContactMethod ?? "",
    caseQuestionContactValue: data.caseQuestionContactValue ?? "",
  };
}

function phoneIsValid(value: string) {
  const digits = value.replace(/\D/g, "");
  return /^\+?[0-9\s().-]+$/.test(value) && digits.length >= 7 && digits.length <= 15;
}

export function ProviderDoctorPreferences() {
  const [form, setForm] = useState<DoctorPreferencesForm>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"saved" | "failed" | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<DoctorPreferencesData>("/users/me/doctor-preferences")
      .then((data) => {
        if (!cancelled) setForm(toForm(data));
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Could not load doctor preferences.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function update<K extends keyof DoctorPreferencesForm>(
    key: K,
    value: DoctorPreferencesForm[K],
  ) {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: "" }));
    setStatus(null);
  }

  function validate() {
    const next: Record<string, string> = {};
    for (const [key, value] of [
      ["occlusionAmount", form.occlusionAmount],
      ["proximalContactAmount", form.proximalContactAmount],
    ] as const) {
      if (value.trim() !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
        next[key] = "Enter a number of 0 or greater.";
      }
    }
    if (form.anatomyPreference === "other") {
      if (!form.anatomyOther.trim()) next.anatomyOther = "Describe the other anatomy preference.";
      else if (form.anatomyOther.length > 100) next.anatomyOther = "Use 100 characters or fewer.";
    }
    if (form.caseQuestionContactMethod === "email") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.caseQuestionContactValue.trim())) {
        next.caseQuestionContactValue = "Enter a valid email address.";
      }
    } else if (form.caseQuestionContactMethod === "text" || form.caseQuestionContactMethod === "phone_call") {
      if (!phoneIsValid(form.caseQuestionContactValue.trim())) {
        next.caseQuestionContactValue = "Enter a valid phone number.";
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function save() {
    if (!validate()) return;
    setSaving(true);
    setStatus(null);
    try {
      await apiFetch<DoctorPreferencesData>("/users/me/doctor-preferences", {
        method: "PATCH",
        body: JSON.stringify({
          occlusionAmount: form.occlusionAmount.trim() === "" ? null : Number(form.occlusionAmount),
          occlusionUnit: form.occlusionUnit || null,
          proximalContactAmount:
            form.proximalContactAmount.trim() === "" ? null : Number(form.proximalContactAmount),
          proximalContactUnit: form.proximalContactUnit || null,
          anatomyPreference: form.anatomyPreference || null,
          anatomyOther: form.anatomyPreference === "other" ? form.anatomyOther.trim() : null,
          caseQuestionContactMethod: form.caseQuestionContactMethod || null,
          caseQuestionContactValue:
            form.caseQuestionContactMethod ? form.caseQuestionContactValue.trim() : null,
        }),
      });
      setStatus("saved");
    } catch {
      setStatus("failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-4 border-t border-border pt-6" aria-labelledby="doctor-preferences-heading">
      <div>
        <h3 id="doctor-preferences-heading" className="text-base font-semibold">Doctor Preferences</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Save fabrication and case-question preferences once for your provider account. These are optional.
        </p>
      </div>
      {loading && <p className="text-sm text-muted-foreground">Loading doctor preferences…</p>}
      {loadError && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{loadError}</p>}
      {errors.form && <p role="alert" className="text-sm text-destructive">{errors.form}</p>}
      {!loading && !loadError && (
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Occlusion amount" error={errors.occlusionAmount}>
              <div className="flex gap-2">
                <input aria-label="Occlusion amount" type="number" min="0" step="any" inputMode="decimal" value={form.occlusionAmount} onChange={(e) => update("occlusionAmount", e.target.value)} className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm" />
                <select aria-label="Occlusion unit" value={form.occlusionUnit} onChange={(e) => update("occlusionUnit", e.target.value as DoctorPreferencesForm["occlusionUnit"])} className="w-32 rounded-md border border-border bg-background px-2 py-2 text-sm">
                  <option value="">Unit</option><option value="mm">Millimeters</option><option value="microns">Microns</option>
                </select>
              </div>
            </Field>
            <Field label="Proximal-contact amount" error={errors.proximalContactAmount}>
              <div className="flex gap-2">
                <input aria-label="Proximal-contact amount" type="number" min="0" step="any" inputMode="decimal" value={form.proximalContactAmount} onChange={(e) => update("proximalContactAmount", e.target.value)} className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm" />
                <select aria-label="Proximal-contact unit" value={form.proximalContactUnit} onChange={(e) => update("proximalContactUnit", e.target.value as DoctorPreferencesForm["proximalContactUnit"])} className="w-32 rounded-md border border-border bg-background px-2 py-2 text-sm">
                  <option value="">Unit</option><option value="mm">Millimeters</option><option value="microns">Microns</option>
                </select>
              </div>
            </Field>
          </div>
          <Field label="Anatomy preference" error={errors.anatomyOther}>
            <select aria-label="Anatomy preference" value={form.anatomyPreference} onChange={(e) => update("anatomyPreference", e.target.value as DoctorPreferencesForm["anatomyPreference"])} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
              <option value="">Choose an option</option><option value="primary_only">Primary anatomy only</option><option value="primary_and_secondary">Primary and secondary anatomy</option><option value="other">Other</option>
            </select>
            {form.anatomyPreference === "other" && <><input aria-label="Other anatomy preference" maxLength={100} value={form.anatomyOther} onChange={(e) => update("anatomyOther", e.target.value)} placeholder="Describe the anatomy preference" className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm" /><p className="mt-1 text-xs text-muted-foreground">{form.anatomyOther.length}/100</p></>}
          </Field>
          <Field label="How should we contact you about case questions?" error={errors.caseQuestionContactValue}>
            <select aria-label="Case-question contact method" value={form.caseQuestionContactMethod} onChange={(e) => update("caseQuestionContactMethod", e.target.value as DoctorPreferencesForm["caseQuestionContactMethod"])} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
              <option value="">Choose a method</option><option value="text">Text</option><option value="phone_call">Phone call</option><option value="email">Email</option>
            </select>
            {form.caseQuestionContactMethod && <input aria-label="Case-question contact value" type={form.caseQuestionContactMethod === "email" ? "email" : "tel"} value={form.caseQuestionContactValue} onChange={(e) => update("caseQuestionContactValue", e.target.value)} placeholder={form.caseQuestionContactMethod === "email" ? "you@example.com" : "(555) 555-5555"} className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />}
          </Field>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={saving} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">{saving ? "Saving…" : "Save Doctor Preferences"}</button>
            {status === "saved" && <span role="status" className="text-sm text-green-700">Doctor preferences saved.</span>}
            {status === "failed" && <span role="alert" className="text-sm text-destructive">Could not save doctor preferences. Your entries are still here.</span>}
          </div>
        </form>
      )}
    </section>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
      {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}