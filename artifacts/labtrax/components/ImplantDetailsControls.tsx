import React, { useEffect, useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { IMPLANT_FIELDS, IMPLANT_RETENTIONS, IMPLANT_MANUFACTURERS, IMPLANT_PLATFORM_PLACEHOLDER, type ImplantDetails } from "@workspace/case-taxonomy";
import { useTheme } from "@/lib/theme-context";
import { resilientFetch } from "@/lib/query-client";
import { CaseDetailField, CaseDetailSelect, CaseDetailOptions, caseDetailFieldStyles } from "@/components/case-detail/CaseDetailField";

export function ImplantDetailsControls({ value, onChange, disabled = false, fieldLayout = "standard" }: {
  value: ImplantDetails; onChange: (value: ImplantDetails) => void; disabled?: boolean;
  fieldLayout?: "standard" | "overview";
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState<string | null>(null);
  function picker(field: "implantRetention" | "implantManufacturer", label: string, options: readonly string[]) {
    if (fieldLayout === "overview") return <View style={{ width: "100%", minWidth: 0, gap: 4 }}>
      <CaseDetailSelect label={label} valueLabel={value[field] || "—"}
        testID={`overview-${field}-select`} expanded={open === field} disabled={disabled}
        onPress={() => setOpen(open === field ? null : field)} />
      {open === field ? <CaseDetailOptions label={label}
        options={["", ...new Set([...options, ...(value[field] ? [value[field]!] : [])])].map((option) => ({ key: option, label: option || "None" }))}
        selected={value[field] || ""} disabled={disabled} optionTestID={(key) => `overview-${field}-${key || "none"}`}
        onSelect={(key) => {
          setOpen(null);
          if (key !== (value[field] || "")) onChange({ ...value, [field]: key || null });
        }} /> : null}
    </View>;
    return <View style={{ gap: 6 }}>
      <Text style={{ color: colors.textSecondary }}>{label}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, expanded: open === field }}
        disabled={disabled} onPress={() => setOpen(open === field ? null : field)}
        style={{ padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}>
        <Text style={{ color: colors.text }}>{value[field] || "Select…"}</Text>
      </Pressable>
      {open === field && <View style={{ gap: 4 }}>{["", ...options].map((option) =>
        <Pressable key={option} accessibilityRole="radio" accessibilityState={{ selected: (value[field] || "") === option }}
          disabled={disabled} onPress={() => { if (!disabled) { onChange({ ...value, [field]: option || null }); setOpen(null); } }}
          style={{ padding: 12, backgroundColor: colors.surfaceAlt, borderRadius: 8 }}>
          <Text style={{ color: colors.text }}>{option || "None"}</Text>
        </Pressable>)}</View>}
    </View>;
  }
  return <View style={{ width: "100%", gap: 12, paddingVertical: 8 }} testID="implant-details-controls">
    {picker("implantRetention", "Implant Retention", IMPLANT_RETENTIONS)}
    {picker("implantManufacturer", "Implant Manufacturer", IMPLANT_MANUFACTURERS)}
    <Text style={[{ color: colors.textSecondary }, fieldLayout === "overview" && caseDetailFieldStyles.heading]}>Implant Platform Notes</Text>
    <TextInput accessibilityLabel="Implant Platform Notes" testID="implant-platform-notes" value={value.implantPlatformNotes ?? ""}
      onChangeText={(text) => onChange({ ...value, implantPlatformNotes: text || null })} editable={!disabled} multiline maxLength={10000}
      placeholder={IMPLANT_PLATFORM_PLACEHOLDER} placeholderTextColor={colors.textTertiary}
      style={{ minHeight: 48, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8, color: colors.text, textAlignVertical: "top" }} />
  </View>;
}

export function SavedImplantDetails({ row, caseId, canEdit, fieldLayout = "standard" }: {
  row: ImplantDetails & { id?: string | null; toothNumber?: string | null }; caseId: string; canEdit: boolean;
  fieldLayout?: "standard" | "overview";
}) {
  const { colors } = useTheme();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ImplantDetails>(row);
  const [confirmed, setConfirmed] = useState<ImplantDetails>(row);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(row); setConfirmed(row); }, [row]);
  async function save() {
    if (!canEdit || !row.id || saving) return;
    setSaving(true);
    try {
      const response = await resilientFetch(`/api/cases/${caseId}/restorations/${row.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...Object.fromEntries(IMPLANT_FIELDS.map((field) => [field, draft[field] || null])), syncLinkedArch: false }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error || "Could not save implant details.");
      }
    } catch (e) {
      setDraft(confirmed);
      Alert.alert("Couldn't save implant details", e instanceof Error ? e.message : "Please try again.");
      setSaving(false);
      return;
    }
    setConfirmed(draft);
    // The write committed. A refresh failure must not offer a duplicate retry.
    await Promise.allSettled([qc.invalidateQueries({ queryKey: ["cases"] }), qc.invalidateQueries({ queryKey: ["cases", caseId] })]);
    setSaving(false);
    Alert.alert("Implant details saved");
  }
  return <View style={{ gap: 6, width: "100%" }}>
    <Text style={{ color: colors.text, fontWeight: "600" }}>Implant · Tooth {row.toothNumber || "—"}</Text>
    {canEdit && row.id ? <>
      <ImplantDetailsControls value={draft} onChange={setDraft} disabled={saving} fieldLayout={fieldLayout} />
      <Pressable accessible accessibilityRole="button" accessibilityLabel="Save implant details" accessibilityState={{ disabled: saving || IMPLANT_FIELDS.every((key) => (draft[key] || null) === (confirmed[key] || null)) }} disabled={saving || IMPLANT_FIELDS.every((key) => (draft[key] || null) === (confirmed[key] || null))} onPress={save} style={{ padding: 12 }}>
        <Text style={{ color: colors.tint }}>{saving ? "Saving…" : "Save implant details"}</Text>
      </Pressable>
    </> : IMPLANT_FIELDS.map((key) => row[key] ? fieldLayout === "overview" ?
      <CaseDetailField key={key} label={key === "implantRetention" ? "Implant Retention" : key === "implantManufacturer" ? "Implant Manufacturer" : "Implant Platform Notes"}>
        <Text style={{ color: colors.text }}>{row[key]}</Text>
      </CaseDetailField> :
      <Text key={key} style={{ color: colors.text }}>{key === "implantRetention" ? "Retention" : key === "implantManufacturer" ? "Implant Manufacturer" : "Implant Platform Notes"}: {row[key]}</Text> : null)}
  </View>;
}
