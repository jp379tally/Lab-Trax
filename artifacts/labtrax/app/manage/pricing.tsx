import React, { useEffect, useMemo, useState } from "react";
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
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { FormSheet } from "@/components/ui/FormSheet";
import { TextField } from "@/components/ui/TextField";
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
} from "@/components/ui/DismissKeyboardView";
import { getJson, sendJson, isForbiddenError, ApiError } from "@/lib/read-api";
import { useMe, primaryAdminLabOrgId, canAdminAnyLab } from "@/lib/auth-me";
import { titleCase } from "@/lib/format";

type Prices = Record<string, string | number | null>;

interface PricingOverride {
  id: string;
  doctorName: string;
  tierName?: string | null;
  defaultDiscountPercent?: number | null;
}

interface PricingTier {
  id: string;
  name: string;
  prices?: Prices | null;
}
interface TiersResponse {
  keys: string[];
  tiers: PricingTier[];
}
interface ItemLabelsResponse {
  labels: Record<string, string>;
  discountKeys: string[];
}

function pricedCount(prices: Prices | null | undefined): number {
  if (!prices) return 0;
  return Object.values(prices).filter((v) => v != null && String(v).trim() !== "").length;
}

function friendlyError(e: unknown, fallback: string): string {
  if (isForbiddenError(e)) {
    return "Your current role can’t make this change. Pricing is managed by lab owners and admins.";
  }
  if (e instanceof ApiError) return e.message;
  return fallback;
}

export default function PricingScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();
  const me = useMe().data;
  // Pricing tiers/overrides are admin-only on the server (resolveLabId →
  // owner/admin); billing-role users can neither read nor write them. Gate the
  // whole screen on admin so we never load data the server will 403, and never
  // show edit affordances that would fail.
  const labOrgId = primaryAdminLabOrgId(me);
  const canEdit = canAdminAnyLab(me);

  // Detect navigation intent from invoices: ?addItem=1&name=<encoded>
  const routeParams = useLocalSearchParams<{ addItem?: string; name?: string }>();
  const [addBillableItemOpen, setAddBillableItemOpen] = useState(false);
  const [addBillableItemName, setAddBillableItemName] = useState("");

  useEffect(() => {
    if (routeParams.addItem === "1") {
      setAddBillableItemName(
        Array.isArray(routeParams.name) ? (routeParams.name[0] ?? "") : (routeParams.name ?? ""),
      );
      setAddBillableItemOpen(true);
    }
  // Only run on mount (when the screen first receives these params).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tiersQ = useQuery<TiersResponse>({
    queryKey: ["pricing-tiers-full", labOrgId ?? ""],
    enabled: !!labOrgId,
    staleTime: 30_000,
    queryFn: () =>
      getJson<TiersResponse>(`/api/pricing/tiers?labOrganizationId=${encodeURIComponent(labOrgId!)}`),
  });
  const labelsQ = useQuery<ItemLabelsResponse>({
    queryKey: ["item-labels", labOrgId ?? ""],
    enabled: !!labOrgId,
    staleTime: 30_000,
    queryFn: async () => {
      return getJson<ItemLabelsResponse>(
        `/api/pricing/item-labels?labOrganizationId=${encodeURIComponent(labOrgId!)}`,
      );
    },
  });
  const overridesQ = useQuery<{ overrides: PricingOverride[] }>({
    queryKey: ["pricing-overrides", labOrgId ?? ""],
    enabled: !!labOrgId,
    staleTime: 30_000,
    queryFn: () =>
      getJson<{ overrides: PricingOverride[] }>(
        `/api/pricing/overrides?labOrganizationId=${encodeURIComponent(labOrgId!)}`,
      ),
  });

  const keys = tiersQ.data?.keys ?? [];
  const labels = labelsQ.data?.labels ?? {};
  const discountKeys = labelsQ.data?.discountKeys ?? [];
  const labelFor = (k: string) => labels[k]?.trim() || titleCase(k.replace(/_/g, " "));

  const loading = !!labOrgId && tiersQ.isLoading;
  const refreshing = tiersQ.isFetching || labelsQ.isFetching || overridesQ.isFetching;

  function refetchAll() {
    tiersQ.refetch();
    labelsQ.refetch();
    overridesQ.refetch();
  }

  const [tierEditor, setTierEditor] = useState<PricingTier | "new" | null>(null);
  const [overrideEditor, setOverrideEditor] = useState<PricingOverride | "new" | null>(null);

  const invalidateTiers = () => qc.invalidateQueries({ queryKey: ["pricing-tiers-full", labOrgId ?? ""] });
  const invalidateOverrides = () => qc.invalidateQueries({ queryKey: ["pricing-overrides", labOrgId ?? ""] });

  if (!canEdit) {
    return (
      <DismissKeyboardView
        style={[styles.screen, { paddingTop: insets.top }]}
        testID="pricing-keyboard-dismiss"
      >
        <Header onBack={() => router.back()} colors={colors} styles={styles} />
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>Not available</Text>
          <Text style={styles.emptyBody}>Pricing is managed by lab owners and admins.</Text>
        </View>
      </DismissKeyboardView>
    );
  }

  return (
    <DismissKeyboardView
      style={[styles.screen, { paddingTop: insets.top }]}
      testID="pricing-keyboard-dismiss"
    >
      <Header onBack={() => router.back()} colors={colors} styles={styles} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : (
        <ScrollView
          keyboardDismissMode={scrollKeyboardDismissMode}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetchAll} tintColor={colors.tint} />}
        >
          <Section
            title="Tiers"
            count={tiersQ.data?.tiers.length ?? 0}
            error={tiersQ.isError}
            styles={styles}
            colors={colors}
            onAdd={() => setTierEditor("new")}
          >
            {(tiersQ.data?.tiers ?? []).map((t) => (
              <Card
                key={t.id}
                style={styles.row}
                onPress={() => setTierEditor(t)}
                testID={`tier-${t.id}`}
              >
                <View style={[styles.icon, { backgroundColor: colors.tint + "1A" }]}>
                  <Text style={[styles.iconText, { color: colors.tint }]}>{(t.name || "?").charAt(0).toUpperCase()}</Text>
                </View>
                <View style={styles.main}>
                  <Text style={styles.name} numberOfLines={1}>
                    {t.name}
                  </Text>
                  <Text style={styles.meta}>
                    {pricedCount(t.prices)} priced item{pricedCount(t.prices) === 1 ? "" : "s"}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
              </Card>
            ))}
          </Section>

          <Section
            title="Doctor Overrides"
            count={overridesQ.data?.overrides.length ?? 0}
            error={overridesQ.isError}
            styles={styles}
            colors={colors}
            onAdd={() => setOverrideEditor("new")}
          >
            {(overridesQ.data?.overrides ?? []).map((o) => (
              <Card
                key={o.id}
                style={styles.row}
                onPress={() => setOverrideEditor(o)}
                testID={`override-${o.id}`}
              >
                <View style={[styles.icon, { backgroundColor: colors.tint + "1A" }]}>
                  <Ionicons name="person-outline" size={20} color={colors.tint} />
                </View>
                <View style={styles.main}>
                  <Text style={styles.name} numberOfLines={1}>
                    {o.doctorName}
                  </Text>
                  <Text style={styles.meta}>
                    {o.tierName ? `Tier: ${o.tierName}` : "No tier"}
                    {o.defaultDiscountPercent != null ? ` · ${o.defaultDiscountPercent}% off` : ""}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
              </Card>
            ))}
          </Section>
        </ScrollView>
      )}

      {tierEditor ? (
        <TierEditor
          labOrgId={labOrgId!}
          tier={tierEditor === "new" ? null : tierEditor}
          keys={keys}
          labelFor={labelFor}
          discountKeys={discountKeys}
          onClose={() => setTierEditor(null)}
          onSaved={() => {
            setTierEditor(null);
            invalidateTiers();
          }}
        />
      ) : null}

      {overrideEditor ? (
        <OverrideEditor
          labOrgId={labOrgId!}
          override={overrideEditor === "new" ? null : overrideEditor}
          tiers={tiersQ.data?.tiers ?? []}
          onClose={() => setOverrideEditor(null)}
          onSaved={() => {
            setOverrideEditor(null);
            invalidateOverrides();
          }}
        />
      ) : null}

      {addBillableItemOpen && labOrgId ? (
        <AddBillableItemSheet
          labOrgId={labOrgId}
          tiers={tiersQ.data?.tiers ?? []}
          initialName={addBillableItemName}
          onClose={() => setAddBillableItemOpen(false)}
          onSaved={() => {
            setAddBillableItemOpen(false);
            invalidateTiers();
          }}
        />
      ) : null}
    </DismissKeyboardView>
  );
}

// --- Add billable item sheet -----------------------------------------------
interface AddBillableItemResult {
  labOrganizationId: string;
  priceKey: string;
  name: string;
  description: string | null;
  price: number;
  isDiscount: boolean;
  tierIds: string[];
  updatedTiers: number;
}

function AddBillableItemSheet({
  labOrgId,
  tiers,
  initialName = "",
  onClose,
  onSaved,
}: {
  labOrgId: string;
  tiers: PricingTier[];
  initialName?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [isDiscount, setIsDiscount] = useState(false);
  const [selectedTierIds, setSelectedTierIds] = useState<string[]>(() =>
    tiers.length === 1 ? [tiers[0].id] : [],
  );

  function toggleTier(id: string) {
    setSelectedTierIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    );
  }

  const save = useMutation({
    mutationFn: async () => {
      const trimmedName = name.trim();
      const priceValue = Number(price);
      if (!trimmedName) throw new Error("Enter a name for the item.");
      if (selectedTierIds.length === 0) throw new Error("Select at least one tier.");
      if (!Number.isFinite(priceValue) || priceValue <= 0)
        throw new Error(
          isDiscount
            ? "Enter a discount amount greater than 0."
            : "Enter a price greater than 0.",
        );
      return sendJson("POST", "/api/pricing/add-item", {
        name: trimmedName,
        description: description.trim() || null,
        price: priceValue,
        isDiscount,
        tierIds: selectedTierIds,
      }) as Promise<AddBillableItemResult>;
    },
    onSuccess: onSaved,
    onError: (e) => Alert.alert("Couldn't add item", friendlyError(e, "Please try again.")),
  });

  const canSubmit = name.trim().length > 0 && selectedTierIds.length > 0 && price.trim().length > 0;

  return (
    <FormSheet
      visible
      title="Add billable item"
      onClose={onClose}
      onSubmit={() => save.mutate()}
      submitting={save.isPending}
      submitDisabled={!canSubmit}
    >
      <TextField
        label="Item name"
        required
        value={name}
        onChangeText={setName}
        placeholder="e.g. Custom whitening tray"
        autoFocus={!initialName}
      />
      <TextField
        label="Description (optional)"
        value={description}
        onChangeText={setDescription}
        placeholder="What this item covers…"
        multiline
      />
      <View style={styles.typeRow}>
        <Text style={styles.fieldLabel}>Item type</Text>
        <View style={styles.typeButtons}>
          {[
            { value: false, label: "Charge" },
            { value: true, label: "Discount" },
          ].map((option) => (
            <Pressable
              key={option.label}
              onPress={() => setIsDiscount(option.value)}
              style={[
                styles.typeButton,
                isDiscount === option.value && styles.typeButtonSelected,
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: isDiscount === option.value }}
            >
              <Text
                style={[
                  styles.typeButtonText,
                  isDiscount === option.value && styles.typeButtonTextSelected,
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      <TextField
        label={isDiscount ? "Discount amount" : "Price"}
        required
        value={price}
        onChangeText={setPrice}
        keyboardType="decimal-pad"
        placeholder="0.00"
      />
      {tiers.length > 0 && (
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Apply to tiers</Text>
          {tiers.map((t) => {
            const checked = selectedTierIds.includes(t.id);
            return (
              <Pressable
                key={t.id}
                style={styles.tierCheckRow}
                onPress={() => toggleTier(t.id)}
                testID={`add-item-tier-${t.id}`}
              >
                <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                  {checked && <Ionicons name="checkmark" size={12} color="#fff" />}
                </View>
                <Text style={styles.tierCheckLabel}>{t.name}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
      {tiers.length === 0 && (
        <Text style={[styles.fieldLabel, { fontStyle: "italic" }]}>
          Create a pricing tier first before adding a billable item.
        </Text>
      )}
    </FormSheet>
  );
}

function pricesToStrings(prices: Prices | null | undefined, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = prices?.[k];
    out[k] = v == null ? "" : String(v);
  }
  return out;
}

function stringsToPrices(input: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input)) {
    const trimmed = v.trim();
    if (trimmed === "") continue;
    const num = Number(trimmed);
    if (!Number.isNaN(num)) out[k] = num;
  }
  return out;
}

// --- Doctor override editor -----------------------------------------------
function OverrideEditor({
  labOrgId,
  override,
  tiers,
  onClose,
  onSaved,
}: {
  labOrgId: string;
  override: PricingOverride | null;
  tiers: PricingTier[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [doctorName, setDoctorName] = useState(override?.doctorName ?? "");
  const [tierName, setTierName] = useState(override?.tierName ?? "");
  const [discount, setDiscount] = useState(
    override?.defaultDiscountPercent != null ? String(override.defaultDiscountPercent) : "",
  );

  useEffect(() => {
    setDoctorName(override?.doctorName ?? "");
    setTierName(override?.tierName ?? "");
    setDiscount(
      override?.defaultDiscountPercent != null ? String(override.defaultDiscountPercent) : "",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [override?.id]);

  async function handleSave() {
    const name = doctorName.trim();
    if (!name) return;

    const discountNum = discount.trim() !== "" ? Number(discount.trim()) : null;
    const body: Record<string, unknown> = {
      tierName: tierName.trim() || null,
      defaultDiscountPercent: discountNum,
    };

    const doSave = async (repriceDraftInvoices: boolean) => {
      try {
        if (override) {
          await sendJson("PATCH", `/api/pricing/overrides/${override.id}`, {
            ...body,
            repriceDraftInvoices,
          });
        } else {
          await sendJson("POST", "/api/pricing/overrides", {
            ...body,
            doctorName: name,
            labOrganizationId: labOrgId,
            repriceDraftInvoices,
          });
        }
        onSaved();
      } catch (e) {
        Alert.alert("Couldn't save", friendlyError(e, "Please try again."));
      }
    };

    // Pre-save: check for open invoices to decide whether to show a dialog.
    try {
      const params = new URLSearchParams({
        doctorName: override?.doctorName ?? name,
        labOrganizationId: labOrgId,
      });
      const result = await getJson<{ count: number }>(
        `/api/pricing/overrides/pending-repricing-count?${params.toString()}`,
      );
      if (result.count > 0) {
        const invoiceWord = result.count === 1 ? "invoice" : "invoices";
        Alert.alert(
          "Update open invoices?",
          `There ${result.count === 1 ? "is" : "are"} ${result.count} open ${invoiceWord} for this doctor. Apply the new pricing to ${result.count === 1 ? "it" : "them"} now?`,
          [
            { text: "No, keep as-is", style: "cancel", onPress: () => doSave(false) },
            { text: "Yes, update invoices", onPress: () => doSave(true) },
          ],
        );
        return;
      }
    } catch {
      // Count fetch failed — proceed without the dialog (non-fatal).
    }

    await doSave(false);
  }

  const save = useMutation({
    mutationFn: handleSave,
    onError: (e) => Alert.alert("Couldn't save", friendlyError(e, "Please try again.")),
  });

  function confirmDelete() {
    Alert.alert("Remove override", `Remove pricing override for "${override!.doctorName}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          try {
            await sendJson("DELETE", `/api/pricing/overrides/${override!.id}`);
            onSaved();
          } catch (e) {
            Alert.alert("Couldn't remove", friendlyError(e, "Please try again."));
          }
        },
      },
    ]);
  }

  return (
    <FormSheet
      visible
      title={override ? "Edit override" : "New doctor override"}
      onClose={onClose}
      onSubmit={() => save.mutate()}
      submitting={save.isPending}
      submitDisabled={doctorName.trim().length === 0}
      onDelete={override ? confirmDelete : undefined}
    >
      {!override ? (
        <TextField
          label="Doctor name"
          required
          value={doctorName}
          onChangeText={setDoctorName}
          placeholder="e.g. Dr. Smith"
          autoFocus
        />
      ) : null}
      <TextField
        label="Tier (optional)"
        value={tierName}
        onChangeText={setTierName}
        placeholder={tiers.length > 0 ? tiers[0].name : "e.g. Standard"}
      />
      <TextField
        label="Default discount %"
        value={discount}
        onChangeText={setDiscount}
        keyboardType="decimal-pad"
        placeholder="0"
      />
    </FormSheet>
  );
}

// --- Tier editor ----------------------------------------------------------
function TierEditor({
  labOrgId,
  tier,
  keys,
  labelFor,
  discountKeys,
  onClose,
  onSaved,
}: {
  labOrgId: string;
  tier: PricingTier | null;
  keys: string[];
  labelFor: (k: string) => string;
  discountKeys: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(tier?.name ?? "");
  const [prices, setPrices] = useState<Record<string, string>>(() => pricesToStrings(tier?.prices, keys));

  // Re-seed from the latest props whenever a different tier is opened, so a
  // reopened sheet always reflects the current server values rather than a
  // stale snapshot captured when the editor first mounted.
  useEffect(() => {
    setName(tier?.name ?? "");
    setPrices(pricesToStrings(tier?.prices, keys));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier?.id]);

  const save = useMutation({
    mutationFn: async () => {
      const body = { name: name.trim(), prices: stringsToPrices(prices) };
      if (tier) return sendJson("PATCH", `/api/pricing/tiers/${tier.id}`, body);
      return sendJson("POST", "/api/pricing/tiers", { ...body, labOrganizationId: labOrgId });
    },
    onSuccess: onSaved,
    onError: (e) => Alert.alert("Couldn’t save", friendlyError(e, "Please try again.")),
  });
  const remove = useMutation({
    mutationFn: () => sendJson("DELETE", `/api/pricing/tiers/${tier!.id}`),
    onSuccess: onSaved,
    onError: (e) => Alert.alert("Couldn’t delete", friendlyError(e, "Please try again.")),
  });

  function confirmDelete() {
    Alert.alert("Delete tier", `Remove “${tier!.name}”?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => remove.mutate() },
    ]);
  }

  return (
    <FormSheet
      visible
      title={tier ? "Edit tier" : "New tier"}
      onClose={onClose}
      onSubmit={() => save.mutate()}
      submitting={save.isPending || remove.isPending}
      submitDisabled={name.trim().length === 0}
      onDelete={tier ? confirmDelete : undefined}
    >
      <TextField label="Tier name" required value={name} onChangeText={setName} placeholder="e.g. Standard" autoFocus />
      <PriceGrid
        keys={keys}
        labelFor={labelFor}
        discountKeys={discountKeys}
        values={prices}
        onChange={setPrices}
      />
    </FormSheet>
  );
}

// --- Shared price grid ----------------------------------------------------
function PriceGrid({
  keys,
  labelFor,
  discountKeys,
  values,
  onChange,
}: {
  keys: string[];
  labelFor: (k: string) => string;
  discountKeys: string[];
  values: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>Prices</Text>
      <View style={styles.priceList}>
        {keys.map((k) => (
          <View key={k} style={styles.priceRow}>
            <Text style={styles.priceLabel} numberOfLines={1}>
              {labelFor(k)}
              {discountKeys.includes(k) ? " · Discount" : ""}
            </Text>
            <View style={styles.priceInputWrap}>
              <Text style={styles.priceCurrency}>
                {discountKeys.includes(k) ? "−$" : "$"}
              </Text>
              <TextField
                value={values[k] ?? ""}
                onChangeText={(t) => onChange({ ...values, [k]: t })}
                keyboardType="decimal-pad"
                placeholder="0"
                testID={`price-${k}`}
              />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

function Header({
  onBack,
  colors,
  styles,
}: {
  onBack: () => void;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.header}>
      <Pressable style={styles.backBtn} onPress={onBack} hitSlop={8} testID="pricing-back">
        <Ionicons name="chevron-back" size={26} color={colors.text} />
      </Pressable>
      <Text style={styles.title}>Pricing</Text>
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
            <Pressable style={styles.addBtn} onPress={onAdd} hitSlop={8} testID={`add-${title.toLowerCase().replace(/\s+/g, "-")}`}>
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
    icon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
    iconText: { ...Typography.bodySemibold },
    main: { flex: 1, gap: 2 },
    name: { ...Typography.bodyLgMedium, color: c.text },
    meta: { ...Typography.caption, color: c.textSecondary },
    field: { gap: Spacing.xs },
    fieldLabel: { ...Typography.captionSemibold, color: c.textSecondary },
    typeRow: { gap: Spacing.xs },
    typeButtons: { flexDirection: "row", gap: Spacing.sm },
    typeButton: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
    },
    typeButtonSelected: { borderColor: c.tint, backgroundColor: c.tint + "1A" },
    typeButtonText: { ...Typography.captionSemibold, color: c.textSecondary },
    typeButtonTextSelected: { color: c.tint },
    priceList: { gap: Spacing.sm },
    priceRow: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    priceLabel: { ...Typography.body, color: c.text, flex: 1 },
    priceInputWrap: { flexDirection: "row", alignItems: "center", gap: Spacing.xs, width: 130 },
    priceCurrency: { ...Typography.body, color: c.textSecondary },
    tierCheckRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingVertical: Spacing.xs,
    },
    checkbox: {
      width: 20,
      height: 20,
      borderRadius: 4,
      borderWidth: 1.5,
      borderColor: c.border,
      backgroundColor: c.backgroundSolid,
      alignItems: "center",
      justifyContent: "center",
    },
    checkboxChecked: {
      backgroundColor: c.tint,
      borderColor: c.tint,
    },
    tierCheckLabel: { ...Typography.body, color: c.text },
  });
}
