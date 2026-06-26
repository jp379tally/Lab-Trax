import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Alert,
  Keyboard,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import {
  useCreateCase,
  usePreviewDraftInvoice,
  useSearchDoctors,
  getSearchDoctorsQueryKey,
  useCases,
  type CreateCaseInput,
  type CreateCaseInputRestorationsItem,
  type DoctorSearchEntry,
  type PreviewDraftInvoiceResultData,
} from "@workspace/api-client-react";
import { resilientFetch } from "@/lib/query-client";
import { useMe, editableLabMemberships, type MeMembership } from "@/lib/auth-me";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { DateField } from "@/components/DateField";
import { SuggestionInput } from "@/components/ui/SuggestionInput";

interface RestorationDraft {
  key: string;
  toothNumber: string;
  restorationType: string;
  material: string;
  shade: string;
}

function blankRestoration(): RestorationDraft {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    toothNumber: "",
    restorationType: "",
    material: "",
    shade: "",
  };
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Something went wrong. Please try again.";
}

export default function NewCaseScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const meQuery = useMe();
  const labs = useMemo(() => editableLabMemberships(meQuery.data), [meQuery.data]);

  // ── Form state ──
  const [selectedLabId, setSelectedLabId] = useState<string | null>(null);
  const [caseNumber, setCaseNumber] = useState("");
  const [caseNumberEdited, setCaseNumberEdited] = useState(false);
  const [patientFirst, setPatientFirst] = useState("");
  const [patientLast, setPatientLast] = useState("");

  const [doctorInput, setDoctorInput] = useState("");
  const [debouncedDoctor, setDebouncedDoctor] = useState("");
  const [doctorName, setDoctorName] = useState("");
  const [providerOrgId, setProviderOrgId] = useState<string | null>(null);
  const [doctorFocused, setDoctorFocused] = useState(false);

  const [restorations, setRestorations] = useState<RestorationDraft[]>([blankRestoration()]);
  const [dueDate, setDueDate] = useState("");
  const [dueDateCapped, setDueDateCapped] = useState(false);
  const [priority, setPriority] = useState<"normal" | "rush">("normal");
  const [notes, setNotes] = useState("");

  const [casePanBarcode, setCasePanBarcode] = useState("");
  const [barcodeConflict, setBarcodeConflict] = useState<{ caseNumber?: string | null } | null>(null);
  const [barcodeChecking, setBarcodeChecking] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);

  const createCase = useCreateCase();

  // ── Draft-invoice preview (read-only, display-only) ──
  // Mirrors the desktop drop-zone preview: POSTs the same restorations the case
  // will be created with to the non-persisting /invoices/preview-draft endpoint
  // so the user sees line items + total before creating. No persistence here.
  const previewInvoice = usePreviewDraftInvoice();
  const previewMutateAsync = previewInvoice.mutateAsync;
  const [invoicePreview, setInvoicePreview] =
    useState<PreviewDraftInvoiceResultData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(false);

  // Restorations the preview should price — the exact set that will be created
  // (rows missing a tooth number or type are skipped, matching handleSubmit).
  const previewRestorations = useMemo(
    () =>
      restorations
        .filter((r) => r.toothNumber.trim() && r.restorationType.trim())
        .map((r) => ({
          toothNumber: r.toothNumber.trim(),
          restorationType: r.restorationType.trim(),
          ...(r.material.trim() ? { material: r.material.trim() } : {}),
          ...(r.shade.trim() ? { shade: r.shade.trim() } : {}),
          quantity: 1,
        })),
    [restorations],
  );

  // Default the lab selector to the first editable lab once /me resolves.
  useEffect(() => {
    if (!selectedLabId && labs.length > 0) setSelectedLabId(labs[0].organizationId);
  }, [labs, selectedLabId]);

  function applyDueDateCap(raw: string): string {
    if (!raw) { setDueDateCapped(false); return raw; }
    const lab = labs.find((m) => m.organizationId === selectedLabId)?.organization;
    const days = lab?.defaultCaseDueDays as number | null | undefined;
    const cap = (lab as any)?.capCaseDueToDefault as boolean | null | undefined;
    if (cap && days) {
      const maxDate = new Date();
      maxDate.setDate(maxDate.getDate() + days);
      const maxStr = maxDate.toISOString().slice(0, 10);
      if (raw > maxStr) {
        setDueDateCapped(true);
        return maxStr;
      }
    }
    setDueDateCapped(false);
    return raw;
  }

  // Auto case number for the chosen lab (kept editable; user edits win).
  const nextNumberQuery = useQuery({
    queryKey: ["next-case-number", selectedLabId],
    queryFn: async () => {
      const res = await resilientFetch(
        `/api/cases/next-case-number?labOrganizationId=${encodeURIComponent(selectedLabId ?? "")}`,
      );
      if (!res.ok) throw new Error(`Could not fetch case number (${res.status}).`);
      const body = (await res.json()) as { data?: { caseNumber?: string }; caseNumber?: string };
      return body?.data?.caseNumber ?? body?.caseNumber ?? "";
    },
    enabled: !!selectedLabId,
    staleTime: 0,
  });

  useEffect(() => {
    if (!caseNumberEdited && nextNumberQuery.data) setCaseNumber(nextNumberQuery.data);
  }, [nextNumberQuery.data, caseNumberEdited]);

  // Debounce doctor search input.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedDoctor(doctorInput.trim()), 300);
    return () => clearTimeout(t);
  }, [doctorInput]);

  // Debounced draft-invoice preview — fires 400 ms after the last edit to the
  // lab, practice, doctor, or restorations. Cancels in-flight requests when
  // inputs change so the latest edit always wins.
  useEffect(() => {
    if (!selectedLabId || previewRestorations.length === 0) {
      setInvoicePreview(null);
      setPreviewError(false);
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await previewMutateAsync({
          data: {
            labOrganizationId: selectedLabId,
            ...(providerOrgId ? { providerOrganizationId: providerOrgId } : {}),
            ...(doctorName.trim() ? { doctorName: doctorName.trim() } : {}),
            restorations: previewRestorations,
          },
        });
        if (!cancelled) {
          setInvoicePreview(res?.data ?? null);
          setPreviewError(false);
        }
      } catch {
        if (!cancelled) {
          setInvoicePreview(null);
          setPreviewError(true);
        }
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [selectedLabId, providerOrgId, doctorName, previewRestorations, previewMutateAsync]);

  // ── Barcode conflict check — debounced, fires 400 ms after last keystroke ──
  useEffect(() => {
    const trimmed = casePanBarcode.trim();
    if (!trimmed || !selectedLabId) {
      setBarcodeConflict(null);
      setBarcodeChecking(false);
      return;
    }
    setBarcodeChecking(true);
    const t = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ barcode: trimmed, labOrganizationId: selectedLabId });
        const res = await resilientFetch(`/api/cases?${qs.toString()}`);
        if (!res.ok) { setBarcodeConflict(null); return; }
        const body = await res.json() as { data?: Array<{ caseNumber?: string | null }> };
        const matches = body?.data ?? [];
        setBarcodeConflict(matches.length > 0 ? matches[0] : null);
      } catch {
        setBarcodeConflict(null);
      } finally {
        setBarcodeChecking(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [casePanBarcode, selectedLabId]);

  const doctorSearchParams = { labOrganizationId: selectedLabId ?? "", q: debouncedDoctor };
  const doctorSearch = useSearchDoctors(doctorSearchParams, {
    query: {
      queryKey: getSearchDoctorsQueryKey(doctorSearchParams),
      enabled: !!selectedLabId && debouncedDoctor.length >= 2 && !providerOrgId,
    },
  });
  const doctorResults: DoctorSearchEntry[] = useMemo(
    () => (doctorSearch.data?.data?.entries ?? []).filter((e) => !!e.providerOrganizationId),
    [doctorSearch.data],
  );

  // ── Name suggestions from existing cases ──
  const existingCasesQuery = useCases(
    { organizationId: selectedLabId ?? "" },
    { enabled: !!selectedLabId, staleTime: 5 * 60 * 1000 },
  );

  const distinctPatientFirstNames = useMemo(() => {
    const names = new Set<string>();
    for (const c of existingCasesQuery.data ?? []) {
      if (c.patientFirstName?.trim()) names.add(c.patientFirstName.trim());
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [existingCasesQuery.data]);

  const distinctPatientLastNames = useMemo(() => {
    const names = new Set<string>();
    for (const c of existingCasesQuery.data ?? []) {
      if (c.patientLastName?.trim()) names.add(c.patientLastName.trim());
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [existingCasesQuery.data]);

  // Distinct doctor entries from existing cases, deduped by BOTH doctorName
  // and providerOrganizationId so colliding names from different practices each
  // get their own selectable row with unambiguous binding.
  const distinctDoctorEntries = useMemo(() => {
    const seen = new Set<string>();
    const entries: { doctorName: string; providerOrganizationId: string }[] = [];
    for (const c of existingCasesQuery.data ?? []) {
      const name = c.doctorName?.trim();
      const orgId = c.providerOrganizationId?.trim();
      if (!name || !orgId) continue;
      const key = `${name}\0${orgId}`;
      if (!seen.has(key)) {
        seen.add(key);
        entries.push({ doctorName: name, providerOrganizationId: orgId });
      }
    }
    return entries.sort((a, b) => a.doctorName.localeCompare(b.doctorName));
  }, [existingCasesQuery.data]);

  // When the same doctor name exists under multiple provider orgs we show a
  // short disambiguator so the user can distinguish rows.
  const doctorNameCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of distinctDoctorEntries) {
      counts.set(e.doctorName, (counts.get(e.doctorName) ?? 0) + 1);
    }
    return counts;
  }, [distinctDoctorEntries]);

  const pastDoctorSuggestions = useMemo(() => {
    if (providerOrgId || !doctorFocused) return [];
    const trimmed = doctorInput.trim().toLowerCase();
    return distinctDoctorEntries
      .filter((e) => trimmed.length === 0 || e.doctorName.toLowerCase().includes(trimmed))
      .slice(0, 6);
  }, [distinctDoctorEntries, doctorInput, providerOrgId, doctorFocused]);

  const showPastDoctorDropdown =
    doctorFocused && !providerOrgId && debouncedDoctor.length < 2 && pastDoctorSuggestions.length > 0;

  function selectPastDoctor(entry: { doctorName: string; providerOrganizationId: string }) {
    setDoctorName(entry.doctorName);
    setProviderOrgId(entry.providerOrganizationId);
    setDoctorInput(entry.doctorName);
    setDoctorFocused(false);
    Keyboard.dismiss();
  }

  function onChangeDoctor(text: string) {
    setDoctorInput(text);
    // Editing the field after a selection clears the bound provider org so the
    // user must reselect a valid doctor (providerOrganizationId is required).
    if (providerOrgId) {
      setProviderOrgId(null);
      setDoctorName("");
    }
  }

  function selectDoctor(entry: DoctorSearchEntry) {
    setDoctorName(entry.doctorName ?? "");
    setProviderOrgId(entry.providerOrganizationId ?? null);
    setDoctorInput(entry.doctorName ?? "");
    setDoctorFocused(false);
    Keyboard.dismiss();
  }

  function updateRestoration(key: string, patch: Partial<RestorationDraft>) {
    setRestorations((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function addRestoration() {
    setRestorations((prev) => [...prev, blankRestoration()]);
  }
  function removeRestoration(key: string) {
    setRestorations((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.key !== key)));
  }

  // ── Validation ──
  const errors = {
    lab: !selectedLabId,
    caseNumber: caseNumber.trim().length === 0,
    patientFirst: patientFirst.trim().length === 0,
    patientLast: patientLast.trim().length === 0,
    doctor: !providerOrgId || doctorName.trim().length === 0,
  };
  const hasErrors = Object.values(errors).some(Boolean);

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)" as never);
  }

  async function handleSubmit() {
    setAttemptedSubmit(true);
    if (hasErrors || !selectedLabId || !providerOrgId) {
      if (errors.doctor) {
        Alert.alert("Select a doctor", "Choose a doctor from the search results so the case is linked to their practice.");
      }
      return;
    }

    const cleanRestorations: CreateCaseInputRestorationsItem[] = restorations
      .filter((r) => r.toothNumber.trim() && r.restorationType.trim())
      .map((r) => ({
        toothNumber: r.toothNumber.trim(),
        restorationType: r.restorationType.trim(),
        ...(r.material.trim() ? { material: r.material.trim() } : {}),
        ...(r.shade.trim() ? { shade: r.shade.trim() } : {}),
      }));

    const payload: CreateCaseInput = {
      caseNumber: caseNumber.trim(),
      labOrganizationId: selectedLabId,
      providerOrganizationId: providerOrgId,
      patientFirstName: patientFirst.trim(),
      patientLastName: patientLast.trim(),
      doctorName: doctorName.trim(),
      priority,
      ...(dueDate.trim() ? { dueDate: dueDate.trim() } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(cleanRestorations.length ? { restorations: cleanRestorations } : {}),
      ...(casePanBarcode.trim() ? { casePanBarcode: casePanBarcode.trim() } : {}),
    };

    setSubmitting(true);
    try {
      const result = await createCase.mutateAsync({ data: payload });
      const newId = result?.data?.id;
      if (!newId) {
        Alert.alert("Case created", "The case was created but could not be opened. Pull to refresh the list.");
        goBack();
        return;
      }
      router.replace(`/case/${newId}` as never);
    } catch (e) {
      Alert.alert("Couldn't create case", errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  // ── Loading / no-lab states ──
  if (meQuery.isLoading) {
    return (
      <View style={[styles.screen, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.tint} />
      </View>
    );
  }

  if (labs.length === 0) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <Header title="New Case" onBack={goBack} styles={styles} colors={colors} />
        <View style={styles.center}>
          <Ionicons name="business-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>No lab to create in</Text>
          <Text style={styles.emptyBody}>
            You need an active lab membership with edit access to create cases.
          </Text>
        </View>
      </View>
    );
  }

  const showError = (key: keyof typeof errors) => attemptedSubmit && errors[key];

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <Header
        title="New Case"
        onBack={goBack}
        styles={styles}
        colors={colors}
        right={
          <Pressable
            onPress={handleSubmit}
            disabled={submitting}
            style={[styles.saveBtn, submitting && styles.saveBtnDisabled]}
            testID="new-case-save"
          >
            {submitting ? (
              <ActivityIndicator color={colors.textInverse} size="small" />
            ) : (
              <Text style={styles.saveBtnText}>Create</Text>
            )}
          </Pressable>
        }
      />

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {/* Lab selector (only when more than one editable lab) */}
        {labs.length > 1 ? (
          <Field label="Lab" styles={styles}>
            <View style={styles.chipRow}>
              {labs.map((m: MeMembership) => {
                const selected = m.organizationId === selectedLabId;
                return (
                  <Pressable
                    key={m.organizationId}
                    onPress={() => setSelectedLabId(m.organizationId)}
                    style={[styles.chip, selected && styles.chipSelected]}
                    testID={`lab-chip-${m.organizationId}`}
                  >
                    <Text style={[styles.chipText, selected && styles.chipTextSelected]} numberOfLines={1}>
                      {m.organization?.name ?? "Lab"}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Field>
        ) : (
          <Field label="Lab" styles={styles}>
            <Text style={styles.staticValue}>{labs[0]?.organization?.name ?? "Lab"}</Text>
          </Field>
        )}

        {/* Case number */}
        <Field label="Case Number" required styles={styles}>
          <View style={styles.inlineRow}>
            <TextInput
              style={[styles.input, styles.inlineInput, showError("caseNumber") && styles.inputError]}
              value={caseNumber}
              onChangeText={(t) => {
                setCaseNumber(t);
                setCaseNumberEdited(true);
              }}
              placeholder="26-1"
              placeholderTextColor={colors.textTertiary}
              autoCapitalize="characters"
              autoCorrect={false}
              testID="new-case-number"
            />
            <Pressable
              onPress={() => {
                setCaseNumberEdited(false);
                nextNumberQuery.refetch();
              }}
              style={styles.iconBtn}
              hitSlop={8}
              testID="new-case-number-refresh"
            >
              {nextNumberQuery.isFetching ? (
                <ActivityIndicator color={colors.tint} size="small" />
              ) : (
                <Ionicons name="refresh" size={18} color={colors.tint} />
              )}
            </Pressable>
          </View>
        </Field>

        {/* Patient */}
        <Field label="Patient First Name" required styles={styles}>
          <SuggestionInput
            value={patientFirst}
            onChangeText={setPatientFirst}
            suggestions={distinctPatientFirstNames}
            placeholder="Jane"
            placeholderTextColor={colors.textTertiary}
            inputStyle={[styles.input, showError("patientFirst") && styles.inputError]}
            testID="new-case-patient-first"
            autoCapitalize="words"
          />
        </Field>
        <Field label="Patient Last Name" required styles={styles}>
          <SuggestionInput
            value={patientLast}
            onChangeText={setPatientLast}
            suggestions={distinctPatientLastNames}
            placeholder="Doe"
            placeholderTextColor={colors.textTertiary}
            inputStyle={[styles.input, showError("patientLast") && styles.inputError]}
            testID="new-case-patient-last"
            autoCapitalize="words"
          />
        </Field>

        {/* Doctor search */}
        <Field label="Doctor" required styles={styles}>
          <TextInput
            style={[styles.input, showError("doctor") && styles.inputError]}
            value={doctorInput}
            onChangeText={onChangeDoctor}
            onFocus={() => setDoctorFocused(true)}
            placeholder="Search doctor or practice"
            placeholderTextColor={colors.textTertiary}
            autoCorrect={false}
            testID="new-case-doctor"
          />
          {providerOrgId ? (
            <View style={styles.selectedDoctorRow}>
              <Ionicons name="checkmark-circle" size={16} color={colors.success} />
              <Text style={styles.selectedDoctorText} numberOfLines={1}>
                Linked to {doctorName}
              </Text>
            </View>
          ) : null}
          {showPastDoctorDropdown ? (
            <View style={styles.dropdown}>
              {pastDoctorSuggestions.map((entry, idx) => (
                <Pressable
                  key={`past-${entry.providerOrganizationId}-${idx}`}
                  onPress={() => selectPastDoctor(entry)}
                  style={styles.dropdownItem}
                  testID={`past-doctor-result-${idx}`}
                >
                  <Text style={styles.dropdownItemName} numberOfLines={1}>
                    {entry.doctorName}
                  </Text>
                  {(doctorNameCount.get(entry.doctorName) ?? 1) > 1 ? (
                    <Text style={styles.dropdownItemSub} numberOfLines={1}>
                      {"…" + entry.providerOrganizationId.slice(-6)}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
            </View>
          ) : null}
          {doctorFocused && !providerOrgId && debouncedDoctor.length >= 2 ? (
            <View style={styles.dropdown}>
              {doctorSearch.isFetching ? (
                <View style={styles.dropdownLoading}>
                  <ActivityIndicator color={colors.tint} size="small" />
                </View>
              ) : doctorResults.length === 0 ? (
                <Text style={styles.dropdownEmpty}>No matching doctors.</Text>
              ) : (
                doctorResults.slice(0, 8).map((entry, idx) => (
                  <Pressable
                    key={`${entry.providerOrganizationId}-${idx}`}
                    onPress={() => selectDoctor(entry)}
                    style={styles.dropdownItem}
                    testID={`doctor-result-${idx}`}
                  >
                    <Text style={styles.dropdownItemName} numberOfLines={1}>
                      {entry.doctorName || "Unnamed doctor"}
                    </Text>
                    {entry.practiceName ? (
                      <Text style={styles.dropdownItemSub} numberOfLines={1}>
                        {entry.practiceName}
                      </Text>
                    ) : null}
                  </Pressable>
                ))
              )}
            </View>
          ) : null}
        </Field>

        {/* Restorations */}
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionHeader}>Restorations</Text>
          <Pressable onPress={addRestoration} hitSlop={8} style={styles.addLink} testID="add-restoration">
            <Ionicons name="add-circle-outline" size={18} color={colors.tint} />
            <Text style={styles.addLinkText}>Add</Text>
          </Pressable>
        </View>
        {restorations.map((r, idx) => (
          <Card key={r.key} style={styles.restoCard}>
            <View style={styles.restoHeaderRow}>
              <Text style={styles.restoIndex}>#{idx + 1}</Text>
              {restorations.length > 1 ? (
                <Pressable onPress={() => removeRestoration(r.key)} hitSlop={8} testID={`remove-restoration-${idx}`}>
                  <Ionicons name="trash-outline" size={16} color={colors.warning} />
                </Pressable>
              ) : null}
            </View>
            <View style={styles.restoGrid}>
              <View style={styles.restoCol}>
                <Text style={styles.miniLabel}>Tooth #</Text>
                <TextInput
                  style={styles.input}
                  value={r.toothNumber}
                  onChangeText={(t) => updateRestoration(r.key, { toothNumber: t })}
                  placeholder="14"
                  placeholderTextColor={colors.textTertiary}
                  testID={`resto-tooth-${idx}`}
                />
              </View>
              <View style={styles.restoCol}>
                <Text style={styles.miniLabel}>Type</Text>
                <TextInput
                  style={styles.input}
                  value={r.restorationType}
                  onChangeText={(t) => updateRestoration(r.key, { restorationType: t })}
                  placeholder="Crown"
                  placeholderTextColor={colors.textTertiary}
                  testID={`resto-type-${idx}`}
                />
              </View>
            </View>
            <View style={styles.restoGrid}>
              <View style={styles.restoCol}>
                <Text style={styles.miniLabel}>Material</Text>
                <TextInput
                  style={styles.input}
                  value={r.material}
                  onChangeText={(t) => updateRestoration(r.key, { material: t })}
                  placeholder="Zirconia"
                  placeholderTextColor={colors.textTertiary}
                  testID={`resto-material-${idx}`}
                />
              </View>
              <View style={styles.restoCol}>
                <Text style={styles.miniLabel}>Shade</Text>
                <TextInput
                  style={styles.input}
                  value={r.shade}
                  onChangeText={(t) => updateRestoration(r.key, { shade: t })}
                  placeholder="A2"
                  placeholderTextColor={colors.textTertiary}
                  testID={`resto-shade-${idx}`}
                />
              </View>
            </View>
          </Card>
        ))}
        <Text style={styles.hint}>
          Restorations need a tooth number and type; blank rows are skipped.
        </Text>

        {/* Draft-invoice preview (read-only) */}
        {(previewLoading || previewError || (invoicePreview?.lineItems?.length ?? 0) > 0) ? (
          <Card style={styles.previewCard} testID="invoice-preview">
            <View style={styles.previewHeaderRow}>
              <Ionicons name="receipt-outline" size={15} color={colors.textSecondary} />
              <Text style={styles.previewTitle}>Invoice preview</Text>
              <Text style={styles.previewSub}>estimated — created with the case</Text>
            </View>
            {previewError ? (
              <Text style={styles.previewMuted}>
                Couldn't load the invoice preview. The draft invoice will still be
                generated when you create the case.
              </Text>
            ) : previewLoading && !invoicePreview ? (
              <Text style={styles.previewMuted} testID="invoice-preview-loading">
                Calculating…
              </Text>
            ) : (invoicePreview?.lineItems?.length ?? 0) === 0 ? (
              <Text style={styles.previewMuted}>No line items yet.</Text>
            ) : (
              <View style={[styles.previewBody, previewLoading && styles.previewBodyLoading]}>
                {invoicePreview!.lineItems!.map((li, idx) => {
                  const qty = li.quantity ?? 1;
                  const unitPrice = li.unitPrice ?? "0.00";
                  const notPriced = li.priced === false;
                  return (
                    <View key={idx} style={styles.previewLineRow} testID={`invoice-preview-line-${idx}`}>
                      <Text style={styles.previewLineDesc} numberOfLines={2}>
                        {li.toothLabel ? (
                          <Text style={styles.previewLineTooth}>{li.toothLabel} </Text>
                        ) : null}
                        {li.description}
                      </Text>
                      <Text style={styles.previewLineQty}>
                        {qty} × ${unitPrice}
                      </Text>
                      {notPriced ? (
                        <Text style={[styles.previewLineAmount, styles.previewNotPriced]} testID={`invoice-preview-notpriced-${idx}`}>
                          not priced
                        </Text>
                      ) : (
                        <Text style={styles.previewLineAmount}>
                          ${li.lineTotal ?? "0.00"}
                        </Text>
                      )}
                    </View>
                  );
                })}
                <View style={styles.previewTotalRow}>
                  <Text style={styles.previewTotalLabel}>Total</Text>
                  <Text style={styles.previewTotalValue} testID="invoice-preview-total">
                    ${invoicePreview!.total ?? "0.00"}
                  </Text>
                </View>
              </View>
            )}
          </Card>
        ) : null}

        {/* Due date */}
        <Field label="Due Date" styles={styles}>
          <DateField
            value={dueDate}
            onChange={(v) => setDueDate(applyDueDateCap(v))}
            placeholder="Select a due date"
            testID="new-case-due-date"
          />
          {dueDateCapped && (
            <Text style={{ fontSize: 11, color: "#d97706", marginTop: 4 }}>
              Capped to lab's turnaround ({(labs.find((m) => m.organizationId === selectedLabId)?.organization?.defaultCaseDueDays as number | null | undefined) ?? "?"}d)
            </Text>
          )}
        </Field>

        {/* Priority */}
        <Field label="Priority" styles={styles}>
          <View style={styles.chipRow}>
            {(["normal", "rush"] as const).map((p) => {
              const selected = priority === p;
              return (
                <Pressable
                  key={p}
                  onPress={() => setPriority(p)}
                  style={[styles.chip, selected && styles.chipSelected]}
                  testID={`priority-${p}`}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                    {p === "rush" ? "Rush" : "Normal"}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Field>

        {/* Notes */}
        <Field label="Notes" styles={styles}>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={notes}
            onChangeText={setNotes}
            placeholder="Optional notes shared with the provider"
            placeholderTextColor={colors.textTertiary}
            multiline
            textAlignVertical="top"
            testID="new-case-notes"
          />
        </Field>

        {/* Pan Barcode */}
        <Field label="Pan Barcode" styles={styles}>
          <TextInput
            style={styles.input}
            value={casePanBarcode}
            onChangeText={setCasePanBarcode}
            placeholder="Scan or type barcode… (optional)"
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="characters"
            autoCorrect={false}
            testID="new-case-barcode"
          />
          {barcodeChecking && (
            <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: 4 }}>
              Checking barcode…
            </Text>
          )}
          {!barcodeChecking && barcodeConflict && (
            <Text style={{ fontSize: 11, color: "#d97706", marginTop: 4 }}>
              {`⚠ This barcode is already used by an active case${barcodeConflict.caseNumber ? ` (Case #${barcodeConflict.caseNumber})` : ""}.`}
            </Text>
          )}
        </Field>

        <Pressable
          onPress={handleSubmit}
          disabled={submitting}
          style={[styles.submitBtn, submitting && styles.saveBtnDisabled]}
          testID="new-case-submit"
        >
          {submitting ? (
            <ActivityIndicator color={colors.textInverse} />
          ) : (
            <Text style={styles.submitBtnText}>Create Case</Text>
          )}
        </Pressable>
        <View style={{ height: insets.bottom + Spacing.xxl }} />
      </ScrollView>
    </View>
  );
}

function Header({
  title,
  onBack,
  right,
  styles,
  colors,
}: {
  title: string;
  onBack: () => void;
  right?: React.ReactNode;
  styles: Styles;
  colors: ThemeColors;
}) {
  return (
    <View style={styles.header}>
      <Pressable onPress={onBack} hitSlop={8} style={styles.backBtn} testID="new-case-back">
        <Ionicons name="chevron-back" size={24} color={colors.text} />
      </Pressable>
      <Text style={styles.headerTitle}>{title}</Text>
      <View style={styles.headerRight}>{right}</View>
    </View>
  );
}

function Field({
  label,
  required,
  children,
  styles,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
  styles: Styles;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>
        {label}
        {required ? <Text style={styles.required}> *</Text> : null}
      </Text>
      {children}
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: Spacing.xl, gap: Spacing.sm },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      gap: Spacing.sm,
    },
    backBtn: { padding: Spacing.xs },
    headerTitle: { ...Typography.h2, color: c.text, flex: 1 },
    headerRight: { minWidth: 64, alignItems: "flex-end" },
    saveBtn: {
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.full,
      backgroundColor: c.tint,
      minWidth: 72,
      alignItems: "center",
    },
    saveBtnDisabled: { opacity: 0.6 },
    saveBtnText: { ...Typography.bodySemibold, color: c.textInverse },
    content: { padding: Spacing.lg, gap: Spacing.md },
    field: { gap: Spacing.xs },
    label: { ...Typography.captionSemibold, color: c.textSecondary },
    required: { color: c.error },
    staticValue: { ...Typography.body, color: c.text, paddingVertical: Spacing.sm },
    input: {
      ...Typography.body,
      color: c.text,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
    },
    inputError: { borderColor: c.error },
    textArea: { minHeight: 90 },
    inlineRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    inlineInput: { flex: 1 },
    iconBtn: {
      width: 40,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: Radius.md,
      backgroundColor: c.surfaceAlt,
    },
    chipRow: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
    chip: {
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.full,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
    },
    chipSelected: { backgroundColor: c.tint, borderColor: c.tint },
    chipText: { ...Typography.bodyMedium, color: c.textSecondary },
    chipTextSelected: { color: c.textInverse },
    selectedDoctorRow: { flexDirection: "row", alignItems: "center", gap: Spacing.xs, marginTop: Spacing.xs },
    selectedDoctorText: { ...Typography.caption, color: c.success, flex: 1 },
    dropdown: {
      marginTop: Spacing.xs,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
      overflow: "hidden",
    },
    dropdownLoading: { padding: Spacing.md, alignItems: "center" },
    dropdownEmpty: { ...Typography.caption, color: c.textTertiary, padding: Spacing.md },
    dropdownItem: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.borderLight },
    dropdownItemName: { ...Typography.bodyMedium, color: c.text },
    dropdownItemSub: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    sectionHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: Spacing.sm },
    sectionHeader: { ...Typography.h3, color: c.text },
    addLink: { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
    addLinkText: { ...Typography.bodySemibold, color: c.tint },
    restoCard: { gap: Spacing.sm },
    restoHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    restoIndex: { ...Typography.captionSemibold, color: c.textSecondary },
    restoGrid: { flexDirection: "row", gap: Spacing.sm },
    restoCol: { flex: 1, gap: Spacing.xs },
    miniLabel: { ...Typography.caption, color: c.textTertiary },
    hint: { ...Typography.caption, color: c.textTertiary },
    previewCard: { gap: Spacing.sm, backgroundColor: c.surfaceAlt },
    previewHeaderRow: { flexDirection: "row", alignItems: "center", gap: Spacing.xs, flexWrap: "wrap" },
    previewTitle: { ...Typography.captionSemibold, color: c.text },
    previewSub: { ...Typography.caption, color: c.textTertiary },
    previewMuted: { ...Typography.caption, color: c.textSecondary },
    previewBody: { gap: Spacing.xs },
    previewBodyLoading: { opacity: 0.6 },
    previewLineRow: { flexDirection: "row", alignItems: "flex-start", gap: Spacing.sm },
    previewLineDesc: { ...Typography.caption, color: c.text, flex: 1 },
    previewLineTooth: { ...Typography.caption, color: c.textSecondary },
    previewLineQty: { ...Typography.caption, color: c.textSecondary, fontVariant: ["tabular-nums"] },
    previewLineAmount: { ...Typography.caption, color: c.text, minWidth: 64, textAlign: "right", fontVariant: ["tabular-nums"] },
    previewNotPriced: { color: c.warning },
    previewTotalRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      paddingTop: Spacing.xs,
      marginTop: Spacing.xs,
    },
    previewTotalLabel: { ...Typography.captionSemibold, color: c.text },
    previewTotalValue: { ...Typography.captionSemibold, color: c.text, fontVariant: ["tabular-nums"] },
    errorText: { ...Typography.caption, color: c.error, marginTop: Spacing.xs },
    submitBtn: {
      marginTop: Spacing.lg,
      paddingVertical: Spacing.md,
      borderRadius: Radius.full,
      backgroundColor: c.tint,
      alignItems: "center",
    },
    submitBtnText: { ...Typography.h3, color: c.textInverse },
    emptyTitle: { ...Typography.h3, color: c.text },
    emptyBody: { ...Typography.body, color: c.textSecondary, textAlign: "center" },
  });
}
