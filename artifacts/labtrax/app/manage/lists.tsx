import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { FormSheet } from "@/components/ui/FormSheet";
import { TextField } from "@/components/ui/TextField";
import { getJson, sendJson, isForbiddenError, ApiError } from "@/lib/read-api";
import { useMe, primaryLabOrgId, canEditAnyLab, canAdminAnyLab } from "@/lib/auth-me";
import { titleCase } from "@/lib/format";

interface Vendor {
  id: string;
  name: string;
  vendorTypeName?: string | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
}
interface Category {
  id: string;
  name: string;
  kind?: string | null;
  color?: string | null;
  description?: string | null;
}

type VendorKind = "vendor" | "employee" | "item";
const VENDOR_KINDS: { value: VendorKind; label: string }[] = [
  { value: "vendor", label: "Vendor" },
  { value: "employee", label: "Employee" },
  { value: "item", label: "Item" },
];
type CategoryKind = "expense" | "income" | "transfer";
const CATEGORY_KINDS: { value: CategoryKind; label: string }[] = [
  { value: "expense", label: "Expense" },
  { value: "income", label: "Income" },
  { value: "transfer", label: "Transfer" },
];
const CATEGORY_COLORS = ["#145DA0", "#10B981", "#F59E0B", "#EF4444", "#7C3AED", "#0EA5E9", "#EC4899", "#64748B"];

function friendlyError(e: unknown, fallback: string): string {
  if (isForbiddenError(e)) {
    return "Your current role can’t make this change. Lab owners and admins manage this.";
  }
  if (e instanceof ApiError) return e.message;
  return fallback;
}

export default function ListsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();
  const me = useMe().data;
  const labOrgId = primaryLabOrgId(me);
  // Vendors and categories are BILLING_ROLES on the server (read + write), so
  // billing users get the full Lists screen. Item-label *writes* are admin-only
  // (PUT /pricing/item-labels → resolveLabId), so the label rows are only
  // editable by owners/admins; billing users see them read-only.
  const canEdit = canEditAnyLab(me);
  const canEditLabels = canAdminAnyLab(me);
  const enabled = !!labOrgId && canEdit;

  const vendorsQ = useQuery<Vendor[]>({
    queryKey: ["vendors", labOrgId ?? ""],
    enabled,
    staleTime: 30_000,
    queryFn: () => getJson<Vendor[]>(`/api/finance/vendors?organizationId=${encodeURIComponent(labOrgId!)}`),
  });
  const categoriesQ = useQuery<Category[]>({
    queryKey: ["categories", labOrgId ?? ""],
    enabled,
    staleTime: 30_000,
    queryFn: () => getJson<Category[]>(`/api/finance/categories?organizationId=${encodeURIComponent(labOrgId!)}`),
  });
  const labelsQ = useQuery<Record<string, string>>({
    queryKey: ["item-labels", labOrgId ?? ""],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const data = await getJson<{ labels: Record<string, string> }>(
        `/api/pricing/item-labels?labOrganizationId=${encodeURIComponent(labOrgId!)}`,
      );
      return data.labels ?? {};
    },
  });

  const loading = enabled && (vendorsQ.isLoading || categoriesQ.isLoading || labelsQ.isLoading);
  const refreshing = vendorsQ.isFetching || categoriesQ.isFetching || labelsQ.isFetching;
  const labelEntries = Object.entries(labelsQ.data ?? {}).filter(([, v]) => v && String(v).trim() !== "");

  function refetchAll() {
    vendorsQ.refetch();
    categoriesQ.refetch();
    labelsQ.refetch();
  }

  // --- Editor state -------------------------------------------------------
  const [vendorEditor, setVendorEditor] = useState<Vendor | "new" | null>(null);
  const [categoryEditor, setCategoryEditor] = useState<Category | "new" | null>(null);
  const [labelEditor, setLabelEditor] = useState<{ key: string; value: string } | null>(null);

  const invalidateVendors = () => qc.invalidateQueries({ queryKey: ["vendors", labOrgId ?? ""] });
  const invalidateCategories = () => qc.invalidateQueries({ queryKey: ["categories", labOrgId ?? ""] });
  const invalidateLabels = () => qc.invalidateQueries({ queryKey: ["item-labels", labOrgId ?? ""] });

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8} testID="lists-back">
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>Lists</Text>
      </View>

      {!canEdit ? (
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>Not available</Text>
          <Text style={styles.emptyBody}>Lists are available to lab owners, admins, and billing users.</Text>
        </View>
      ) : loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetchAll} tintColor={colors.tint} />}
        >
          <Section
            title="Vendors"
            count={vendorsQ.data?.length ?? 0}
            error={vendorsQ.isError}
            styles={styles}
            colors={colors}
            onAdd={() => setVendorEditor("new")}
          >
            {(vendorsQ.data ?? []).map((v) => (
              <Card key={v.id} style={styles.row} onPress={() => setVendorEditor(v)} testID={`vendor-${v.id}`}>
                <View style={styles.main}>
                  <Text style={styles.name} numberOfLines={1}>
                    {v.name}
                  </Text>
                  {v.vendorTypeName ? (
                    <Text style={styles.meta} numberOfLines={1}>
                      {v.vendorTypeName}
                    </Text>
                  ) : null}
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
              </Card>
            ))}
          </Section>

          <Section
            title="Categories"
            count={categoriesQ.data?.length ?? 0}
            error={categoriesQ.isError}
            styles={styles}
            colors={colors}
            onAdd={() => setCategoryEditor("new")}
          >
            {(categoriesQ.data ?? []).map((cat) => (
              <Card key={cat.id} style={styles.row} onPress={() => setCategoryEditor(cat)} testID={`category-${cat.id}`}>
                <View style={[styles.dot, { backgroundColor: cat.color || colors.textTertiary }]} />
                <View style={styles.main}>
                  <Text style={styles.name} numberOfLines={1}>
                    {cat.name}
                  </Text>
                  {cat.kind ? (
                    <Text style={styles.meta} numberOfLines={1}>
                      {titleCase(cat.kind)}
                    </Text>
                  ) : null}
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
              </Card>
            ))}
          </Section>

          <Section title="Item Labels" count={labelEntries.length} error={labelsQ.isError} styles={styles} colors={colors}>
            {labelEntries.map(([key, value]) => (
              <Card
                key={key}
                style={styles.row}
                onPress={canEditLabels ? () => setLabelEditor({ key, value }) : undefined}
                testID={`label-${key}`}
              >
                <View style={styles.main}>
                  <Text style={styles.name} numberOfLines={1}>
                    {value}
                  </Text>
                  <Text style={styles.meta} numberOfLines={1}>
                    {key}
                  </Text>
                </View>
                {canEditLabels ? <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} /> : null}
              </Card>
            ))}
          </Section>
        </ScrollView>
      )}

      {vendorEditor ? (
        <VendorEditor
          labOrgId={labOrgId!}
          vendor={vendorEditor === "new" ? null : vendorEditor}
          onClose={() => setVendorEditor(null)}
          onSaved={() => {
            setVendorEditor(null);
            invalidateVendors();
          }}
        />
      ) : null}

      {categoryEditor ? (
        <CategoryEditor
          labOrgId={labOrgId!}
          category={categoryEditor === "new" ? null : categoryEditor}
          onClose={() => setCategoryEditor(null)}
          onSaved={() => {
            setCategoryEditor(null);
            invalidateCategories();
          }}
        />
      ) : null}

      {labelEditor ? (
        <LabelEditor
          labOrgId={labOrgId!}
          labels={labelsQ.data ?? {}}
          entry={labelEditor}
          onClose={() => setLabelEditor(null)}
          onSaved={() => {
            setLabelEditor(null);
            invalidateLabels();
          }}
        />
      ) : null}
    </View>
  );
}

// --- Vendor editor --------------------------------------------------------
function VendorEditor({
  labOrgId,
  vendor,
  onClose,
  onSaved,
}: {
  labOrgId: string;
  vendor: Vendor | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(vendor?.name ?? "");
  const [kind, setKind] = useState<VendorKind | null>(() => {
    const n = (vendor?.vendorTypeName ?? "").toLowerCase();
    return (VENDOR_KINDS.find((k) => k.label.toLowerCase() === n)?.value as VendorKind) ?? null;
  });
  const [phone, setPhone] = useState(vendor?.phone ?? "");
  const [email, setEmail] = useState(vendor?.email ?? "");
  const [notes, setNotes] = useState(vendor?.notes ?? "");

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name: name.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        notes: notes.trim() || null,
      };
      if (kind) body.vendorType = kind;
      if (vendor) {
        return sendJson("PATCH", `/api/finance/vendors/${vendor.id}`, body);
      }
      return sendJson("POST", "/api/finance/vendors", { ...body, organizationId: labOrgId });
    },
    onSuccess: onSaved,
    onError: (e) => Alert.alert("Couldn’t save", friendlyError(e, "Please try again.")),
  });

  const remove = useMutation({
    mutationFn: () => sendJson("DELETE", `/api/finance/vendors/${vendor!.id}?hard=true`),
    onSuccess: onSaved,
    onError: (e) => Alert.alert("Couldn’t delete", friendlyError(e, "Please try again.")),
  });

  function confirmDelete() {
    Alert.alert("Delete payee", `Remove “${vendor!.name}”? This cannot be undone.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => remove.mutate() },
    ]);
  }

  return (
    <FormSheet
      visible
      title={vendor ? "Edit payee" : "New payee"}
      onClose={onClose}
      onSubmit={() => save.mutate()}
      submitting={save.isPending || remove.isPending}
      submitDisabled={name.trim().length === 0}
      onDelete={vendor ? confirmDelete : undefined}
    >
      <TextField label="Name" required value={name} onChangeText={setName} placeholder="Payee name" autoFocus />
      <KindChips
        label="Type"
        options={VENDOR_KINDS}
        value={kind}
        onChange={(v) => setKind(v as VendorKind)}
      />
      <TextField label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="Optional" />
      <TextField label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" placeholder="Optional" />
      <TextField label="Notes" value={notes} onChangeText={setNotes} multiline placeholder="Optional" />
    </FormSheet>
  );
}

// --- Category editor ------------------------------------------------------
function CategoryEditor({
  labOrgId,
  category,
  onClose,
  onSaved,
}: {
  labOrgId: string;
  category: Category | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(category?.name ?? "");
  const [kind, setKind] = useState<CategoryKind>((category?.kind as CategoryKind) ?? "expense");
  const [color, setColor] = useState<string | null>(category?.color ?? null);
  const [description, setDescription] = useState(category?.description ?? "");

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name: name.trim(),
        kind,
        color: color || null,
        description: description.trim() || null,
      };
      if (category) {
        return sendJson("PATCH", `/api/finance/categories/${category.id}`, body);
      }
      return sendJson("POST", "/api/finance/categories", { ...body, organizationId: labOrgId });
    },
    onSuccess: onSaved,
    onError: (e) => Alert.alert("Couldn’t save", friendlyError(e, "Please try again.")),
  });

  const remove = useMutation({
    mutationFn: () => sendJson("DELETE", `/api/finance/categories/${category!.id}`),
    onSuccess: onSaved,
    onError: (e) => Alert.alert("Couldn’t archive", friendlyError(e, "Please try again.")),
  });

  function confirmDelete() {
    Alert.alert("Archive category", `Archive “${category!.name}”?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Archive", style: "destructive", onPress: () => remove.mutate() },
    ]);
  }

  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <FormSheet
      visible
      title={category ? "Edit category" : "New category"}
      onClose={onClose}
      onSubmit={() => save.mutate()}
      submitting={save.isPending || remove.isPending}
      submitDisabled={name.trim().length === 0}
      onDelete={category ? confirmDelete : undefined}
      deleteLabel="Archive"
    >
      <TextField label="Name" required value={name} onChangeText={setName} placeholder="Category name" autoFocus />
      <KindChips label="Kind" options={CATEGORY_KINDS} value={kind} onChange={(v) => setKind(v as CategoryKind)} />
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Color</Text>
        <View style={styles.swatchRow}>
          {CATEGORY_COLORS.map((c) => (
            <Pressable
              key={c}
              onPress={() => setColor(c === color ? null : c)}
              style={[styles.swatch, { backgroundColor: c }, color === c && styles.swatchSelected]}
              testID={`swatch-${c}`}
            >
              {color === c ? <Ionicons name="checkmark" size={16} color="#fff" /> : null}
            </Pressable>
          ))}
        </View>
      </View>
      <TextField label="Description" value={description} onChangeText={setDescription} multiline placeholder="Optional" />
    </FormSheet>
  );
}

// --- Item label editor ----------------------------------------------------
function LabelEditor({
  labOrgId,
  labels,
  entry,
  onClose,
  onSaved,
}: {
  labOrgId: string;
  labels: Record<string, string>;
  entry: { key: string; value: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(entry.value);

  const save = useMutation({
    mutationFn: () =>
      sendJson("PUT", "/api/pricing/item-labels", {
        labOrganizationId: labOrgId,
        labels: { ...labels, [entry.key]: value.trim() },
      }),
    onSuccess: onSaved,
    onError: (e) => Alert.alert("Couldn’t save", friendlyError(e, "Please try again.")),
  });

  return (
    <FormSheet
      visible
      title="Edit item label"
      onClose={onClose}
      onSubmit={() => save.mutate()}
      submitting={save.isPending}
      submitDisabled={value.trim().length === 0}
    >
      <TextField label="Display name" required value={value} onChangeText={setValue} autoFocus />
      <TextField label="Key" value={entry.key} editable={false} hint="Internal identifier — cannot be changed." />
    </FormSheet>
  );
}

// --- Shared chip selector -------------------------------------------------
function KindChips({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string | null;
  onChange: (v: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.chipRow}>
        {options.map((opt) => {
          const selected = opt.value === value;
          return (
            <Pressable
              key={opt.value}
              onPress={() => onChange(opt.value)}
              style={[styles.chip, selected && styles.chipSelected]}
              testID={`chip-${opt.value}`}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{opt.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Section({
  title,
  count,
  error,
  children,
  styles,
  colors,
  onAdd,
}: {
  title: string;
  count: number;
  error: boolean;
  children: React.ReactNode;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
  onAdd?: () => void;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <View style={styles.sectionHeaderRight}>
          <Text style={styles.sectionCount}>{count}</Text>
          {onAdd ? (
            <Pressable style={styles.addBtn} onPress={onAdd} hitSlop={8} testID={`add-${title.toLowerCase()}`}>
              <Ionicons name="add" size={20} color={colors.tint} />
            </Pressable>
          ) : null}
        </View>
      </View>
      {error ? (
        <Text style={styles.sectionEmpty}>Couldn’t load.</Text>
      ) : count === 0 ? (
        <Text style={styles.sectionEmpty}>Nothing here yet.</Text>
      ) : (
        <View style={styles.list}>{children}</View>
      )}
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.md,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.xs,
      gap: Spacing.xs,
    },
    backBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
    title: { ...Typography.h1, color: c.text },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: Spacing.xl, gap: Spacing.sm, minHeight: 280 },
    emptyTitle: { ...Typography.h3, color: c.text, textAlign: "center" },
    emptyBody: { ...Typography.body, color: c.textSecondary, textAlign: "center" },
    content: { padding: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.xl },
    section: { gap: Spacing.sm },
    sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    sectionHeaderRight: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    sectionTitle: { ...Typography.h2, color: c.text },
    sectionCount: { ...Typography.captionSemibold, color: c.textTertiary },
    addBtn: {
      width: 32,
      height: 32,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.tint + "1A",
    },
    sectionEmpty: { ...Typography.caption, color: c.textTertiary },
    list: { gap: Spacing.sm },
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    dot: { width: 12, height: 12, borderRadius: Radius.full },
    main: { flex: 1, gap: 2 },
    name: { ...Typography.bodySemibold, color: c.text },
    meta: { ...Typography.caption, color: c.textSecondary },
    field: { gap: Spacing.xs },
    fieldLabel: { ...Typography.captionSemibold, color: c.textSecondary },
    chipRow: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
    chip: {
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs,
      borderRadius: Radius.full,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
    },
    chipSelected: { backgroundColor: c.tint, borderColor: c.tint },
    chipText: { ...Typography.bodyMedium, color: c.textSecondary },
    chipTextSelected: { color: c.textInverse },
    swatchRow: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
    swatch: {
      width: 36,
      height: 36,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 2,
      borderColor: "transparent",
    },
    swatchSelected: { borderColor: c.text },
  });
}
