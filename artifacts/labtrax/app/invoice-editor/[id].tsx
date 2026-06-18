import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  ScrollView,
  TextInput,
  Alert,
  Modal,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  useInvoice,
  useUpdateInvoice,
  type UpdateInvoiceInput,
  type UpdateInvoiceInputItemsItem,
} from "@workspace/api-client-react";
import { queryClient, resilientFetch } from "@/lib/query-client";
import { useTheme, type ThemeColors } from "@/lib/theme-context";

// useLocalSearchParams values are `string | string[]` — coerce to a single value.
function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

// ── Status options (mirror desktop invoice statuses) ──────────────────────────
const STATUS_OPTIONS: { value: NonNullable<UpdateInvoiceInput["status"]>; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "open", label: "Open" },
  { value: "partially_paid", label: "Partial" },
  { value: "paid", label: "Paid" },
  { value: "void", label: "Void" },
];

// Raw sub-item shape as it arrives from the GET response. The mobile editor does
// not edit sub-items, but it MUST round-trip them untouched: the server PATCH
// replaces ALL line items, so omitting sub-items hard-deletes them.
interface RawSubItem {
  id?: string;
  toothNumber?: number | null;
  description?: string | null;
  quantity?: number | string | null;
  unitPrice?: number | string | null;
  sortOrder?: number | null;
}

interface RawLineItem {
  id: string;
  toothNumber?: number | null;
  toothLabel?: string | null;
  description?: string | null;
  quantity?: number | string | null;
  unitPrice?: number | string | null;
  subItems?: RawSubItem[] | null;
}

// One editable row in the line-items list.
interface DraftLine {
  id: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  tooth: string;
  // Carried through untouched so the server doesn't hard-delete nested rows.
  subItems: RawSubItem[];
  // displayMetadata.lineItems sidecar (item label + sub-item labels), kept
  // index-aligned so desktop's editor prefill stays correct after a mobile edit.
  metaLabel: string;
  metaSubLabels: string[];
}

// A billable item configured by the lab (vendorType=item vendors).
interface BillableItem {
  id: string;
  name: string;
  unitPrice: string | null;
}

type InvoiceRecord = {
  id?: string;
  invoiceNumber?: string | null;
  status?: string | null;
  notes?: string | null;
  labOrganizationId?: string | null;
  frozen?: boolean | null;
  caseDeletedNote?: string | null;
  caseDeletedAt?: string | null;
  caseId?: string | null;
  linkedCaseIsDeleted?: boolean | null;
  linkedCaseNumber?: string | null;
  items?: RawLineItem[] | null;
  lineItems?: RawLineItem[] | null;
  displayMetadata?: Record<string, unknown> | null;
  displayMetadataJson?: Record<string, unknown> | null;
};

function readMeta(inv: InvoiceRecord | null): Record<string, unknown> {
  if (!inv) return {};
  const meta = inv.displayMetadata ?? inv.displayMetadataJson;
  return meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};
}

// Parse a tooth string into a single int (1–32) when possible; otherwise null.
// The free-form string is always preserved as toothLabel (supports ranges).
function parseToothNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = parseInt(trimmed, 10);
  return n >= 1 && n <= 32 ? n : null;
}

function num(value: number | string | null | undefined, fallback = 0): number {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

export default function InvoiceEditorScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const invoiceId = firstParam(params.id) ?? null;

  const invoiceQuery = useInvoice(invoiceId);
  const invoice = (invoiceQuery.data ?? null) as InvoiceRecord | null;
  const updateInvoice = useUpdateInvoice();

  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [status, setStatus] = useState<NonNullable<UpdateInvoiceInput["status"]>>("draft");
  const [teeth, setTeeth] = useState("");
  const [shade, setShade] = useState("");
  const [billTo, setBillTo] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [saving, setSaving] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Billable items fetched from the lab's items list (vendorType=item).
  const [billableItems, setBillableItems] = useState<BillableItem[]>([]);
  const [pickerVisible, setPickerVisible] = useState(false);

  // Prefill the form once the invoice loads.
  useEffect(() => {
    if (!invoice || hydrated) return;
    const meta = readMeta(invoice);
    const metaItems = Array.isArray(meta.lineItems)
      ? (meta.lineItems as Array<{ item?: string; subItems?: Array<{ item?: string }> }>)
      : [];
    const raw = (invoice.items ?? invoice.lineItems ?? []) as RawLineItem[];

    setInvoiceNumber(invoice.invoiceNumber ?? "");
    setStatus(
      (STATUS_OPTIONS.find((o) => o.value === invoice.status)?.value ?? "draft"),
    );
    setTeeth(typeof meta.teeth === "string" ? meta.teeth : "");
    setShade(typeof meta.shade === "string" ? meta.shade : "");
    setBillTo(typeof meta.billTo === "string" ? meta.billTo : "");
    setNotes(invoice.notes ?? "");
    setLines(
      raw.map((it, idx) => {
        const subItems = Array.isArray(it.subItems) ? it.subItems : [];
        const metaSub = Array.isArray(metaItems[idx]?.subItems)
          ? (metaItems[idx]!.subItems as Array<{ item?: string }>)
          : [];
        return {
          id: it.id ?? null,
          description: it.description ?? "",
          quantity: String(Math.max(0, Math.round(num(it.quantity, 1)))),
          unitPrice: String(num(it.unitPrice, 0)),
          tooth:
            it.toothLabel != null && it.toothLabel !== ""
              ? it.toothLabel
              : it.toothNumber != null
                ? String(it.toothNumber)
                : "",
          subItems,
          metaLabel: typeof metaItems[idx]?.item === "string" ? metaItems[idx]!.item! : "",
          metaSubLabels: subItems.map((_, sidx) =>
            typeof metaSub[sidx]?.item === "string" ? metaSub[sidx]!.item! : "",
          ),
        };
      }),
    );
    setHydrated(true);
  }, [invoice, hydrated]);

  // Fetch billable items once labOrganizationId is known.
  useEffect(() => {
    const labOrgId = invoice?.labOrganizationId;
    if (!labOrgId) return;
    let cancelled = false;
    resilientFetch(
      `/api/finance/vendors?organizationId=${encodeURIComponent(labOrgId)}&vendorType=item`,
    )
      .then((res) => res.json())
      .then((data: unknown) => {
        if (cancelled) return;
        if (Array.isArray(data)) {
          setBillableItems(data as BillableItem[]);
        } else if (
          data !== null &&
          typeof data === "object" &&
          Array.isArray((data as Record<string, unknown>).data)
        ) {
          setBillableItems((data as { data: BillableItem[] }).data);
        }
      })
      .catch(() => {
        // Fire-and-forget — fall back to blank custom line on error.
      });
    return () => {
      cancelled = true;
    };
  }, [invoice?.labOrganizationId]);

  function updateLine(idx: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function addLine(item?: BillableItem) {
    let prefillPrice = "";
    if (item?.unitPrice != null) {
      const n = parseFloat(item.unitPrice);
      prefillPrice = Number.isFinite(n) ? String(n) : "";
    }
    setLines((prev) => [
      ...prev,
      {
        id: null,
        description: item?.name ?? "",
        quantity: "1",
        unitPrice: prefillPrice,
        tooth: "",
        subItems: [],
        metaLabel: "",
        metaSubLabels: [],
      },
    ]);
  }

  // Opens the picker when items exist; otherwise adds a blank line immediately.
  function handleAddLine() {
    if (billableItems.length > 0) {
      setPickerVisible(true);
    } else {
      addLine();
    }
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  const subtotal = useMemo(
    () =>
      lines.reduce((sum, l) => {
        const lineTotal = num(l.quantity, 0) * num(l.unitPrice, 0);
        const subTotal = l.subItems.reduce(
          (s, sub) => s + num(sub.quantity, 0) * num(sub.unitPrice, 0),
          0,
        );
        return sum + lineTotal + subTotal;
      }, 0),
    [lines],
  );

  async function handleSave() {
    // Legacy mobile-created invoices surface with a `mobile:`-prefixed id and no
    // editable row. The GET resolves such ids to their canonical invoice; always
    // save against the resolved canonical id, never the synthetic `mobile:` one.
    const saveId = invoice?.id ?? invoiceId;
    if (!saveId) return;
    if (!invoiceNumber.trim()) {
      Alert.alert("Invoice number required", "Enter an invoice number.");
      return;
    }
    if (lines.some((l) => !l.description.trim())) {
      Alert.alert("Description required", "Every line item needs a description.");
      return;
    }

    // (D) Spread the existing displayMetadata so credits / patientName /
    // caseNotes survive — the server derives the invoice total from meta.credits.
    // billTo is now directly editable; overwrite it with the current form value.
    const existingMeta = readMeta(invoice);
    const displayMetadata: Record<string, unknown> = {
      ...existingMeta,
      teeth: teeth.trim(),
      shade: shade.trim(),
      billTo: billTo.trim(),
      // Keep the label sidecar index-aligned with the items we send.
      lineItems: lines.map((l) => ({
        item: l.metaLabel,
        description: l.description.trim(),
        subItems: l.subItems.map((sub, sidx) => ({
          item: l.metaSubLabels[sidx] ?? "",
          description: (sub.description ?? "").trim(),
        })),
      })),
    };

    const items: UpdateInvoiceInputItemsItem[] = lines.map((l, idx) => ({
      ...(l.id ? { id: l.id } : {}),
      toothLabel: l.tooth.trim() ? l.tooth.trim() : null,
      toothNumber: parseToothNumber(l.tooth),
      description: l.description.trim(),
      quantity: Math.max(0, Math.round(num(l.quantity, 1))),
      unitPrice: num(l.unitPrice, 0),
      sortOrder: idx,
      // (C) Round-trip sub-items untouched so the server doesn't hard-delete them.
      subItems: l.subItems.map((sub, sidx) => ({
        ...(sub.id ? { id: sub.id } : {}),
        toothNumber: sub.toothNumber ?? null,
        description: (sub.description ?? "").trim(),
        quantity: num(sub.quantity, 0),
        unitPrice: num(sub.unitPrice, 0),
        sortOrder: sub.sortOrder ?? sidx,
      })),
    }));

    setSaving(true);
    try {
      await updateInvoice.mutateAsync({
        invoiceId: saveId,
        data: {
          invoiceNumber: invoiceNumber.trim(),
          status,
          notes: notes.trim() || null,
          displayMetadata,
          items,
        },
      });
      await queryClient.invalidateQueries({ queryKey: ["invoices"] });
      router.back();
    } catch (e) {
      Alert.alert(
        "Couldn't save invoice",
        e instanceof Error ? e.message : "Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  const styles = makeStyles(colors);
  const loading = invoiceQuery.isLoading && !invoice;
  // Legacy mobile-created invoices carry a `mobile:`-prefixed id. When the server
  // can't resolve one to a canonical, editable invoice, show a tailored message
  // instead of the generic "couldn't be loaded" copy.
  const isLegacyMobileInvoice = (invoiceId ?? "").startsWith("mobile:");

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.headerButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          testID="invoice-editor-back"
        >
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          Edit Invoice
        </Text>
        <Pressable
          onPress={handleSave}
          hitSlop={12}
          style={styles.headerButton}
          disabled={saving || loading || !invoice || !!invoice.frozen}
          accessibilityRole="button"
          accessibilityLabel="Save invoice"
          testID="invoice-editor-save"
        >
          {saving ? (
            <ActivityIndicator color={colors.tint} size="small" />
          ) : (
            <Text
              style={[
                styles.saveText,
                (loading || !invoice) && { color: colors.textTertiary },
              ]}
            >
              Save
            </Text>
          )}
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center} testID="invoice-editor-loading">
          <ActivityIndicator color={colors.tint} />
          {isLegacyMobileInvoice && (
            <Text style={styles.loadingHint}>Setting up your invoice…</Text>
          )}
        </View>
      ) : !invoice ? (
        <View style={styles.center} testID="invoice-editor-error">
          <Ionicons name="receipt-outline" size={44} color={colors.textTertiary} />
          <Text style={styles.errorTitle}>
            {isLegacyMobileInvoice
              ? "This invoice was created in an older version of the app. Open the case to try generating an editable invoice."
              : "This invoice couldn't be loaded."}
          </Text>
          <Pressable onPress={() => router.back()} style={styles.errorButton}>
            <Text style={styles.errorButtonText}>Go back</Text>
          </Pressable>
        </View>
      ) : (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={{ flex: 1 }}
        >
          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
          >
            {/* ── Frozen banner ── */}
            {invoice.frozen && (
              <View style={styles.frozenBanner} testID="invoice-editor-frozen-banner">
                <Ionicons name="lock-closed" size={16} color="#92400e" style={{ marginTop: 2 }} />
                <View style={{ flex: 1, gap: 6 }}>
                  <Text style={styles.frozenBannerText}>
                    {invoice.caseDeletedNote ?? "Invoice is frozen — the linked case was deleted."}
                    {invoice.linkedCaseNumber ? ` — Case ${invoice.linkedCaseNumber}` : ""}
                    {invoice.caseDeletedAt
                      ? ` · ${new Date(invoice.caseDeletedAt).toLocaleDateString()}`
                      : ""}
                    {" "}This invoice cannot be edited.
                  </Text>
                  {invoice.caseId && (
                    <Pressable
                      onPress={() => router.push(`/case/${invoice.caseId}` as any)}
                      hitSlop={8}
                    >
                      <Text style={styles.frozenBannerLink}>View linked case →</Text>
                    </Pressable>
                  )}
                  {invoice.linkedCaseIsDeleted === true && (
                    <Text style={styles.frozenBannerSubtext}>
                      The linked case is still deleted — billing is paused. A lab admin can restore the case to resume billing.
                    </Text>
                  )}
                  {invoice.linkedCaseIsDeleted === false && (
                    <Text style={styles.frozenBannerSubtext}>
                      The linked case appears to have been restored but this invoice is still frozen. Please contact support.
                    </Text>
                  )}
                </View>
              </View>
            )}
            {/* ── Details ── */}
            <View style={styles.card}>
              <Text style={styles.cardHeading}>Details</Text>
              <Field label="Invoice number">
                <TextInput
                  value={invoiceNumber}
                  onChangeText={setInvoiceNumber}
                  style={styles.input}
                  placeholder="INV-0001"
                  placeholderTextColor={colors.textTertiary}
                  autoCapitalize="characters"
                  testID="invoice-editor-number"
                />
              </Field>
              <Field label="Status">
                <View style={styles.statusRow}>
                  {STATUS_OPTIONS.map((opt) => {
                    const active = opt.value === status;
                    return (
                      <Pressable
                        key={opt.value}
                        onPress={() => setStatus(opt.value)}
                        style={[styles.statusChip, active && styles.statusChipActive]}
                        testID={`invoice-editor-status-${opt.value}`}
                      >
                        <Text
                          style={[
                            styles.statusChipText,
                            active && styles.statusChipTextActive,
                          ]}
                        >
                          {opt.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </Field>
              <Field label="Teeth">
                <TextInput
                  value={teeth}
                  onChangeText={setTeeth}
                  style={styles.input}
                  placeholder="e.g. 8-10"
                  placeholderTextColor={colors.textTertiary}
                  autoCapitalize="none"
                  testID="invoice-editor-teeth"
                />
              </Field>
              <Field label="Shade">
                <TextInput
                  value={shade}
                  onChangeText={setShade}
                  style={styles.input}
                  placeholder="e.g. A2"
                  placeholderTextColor={colors.textTertiary}
                  autoCapitalize="characters"
                  testID="invoice-editor-shade"
                />
              </Field>
              <Field label="Bill to">
                <TextInput
                  value={billTo}
                  onChangeText={setBillTo}
                  style={styles.input}
                  placeholder="Doctor or practice name"
                  placeholderTextColor={colors.textTertiary}
                  autoCapitalize="words"
                  testID="invoice-editor-bill-to"
                />
              </Field>
            </View>

            {/* ── Notes ── */}
            <View style={styles.card}>
              <Text style={styles.cardHeading}>Invoice notes</Text>
              <TextInput
                value={notes}
                onChangeText={setNotes}
                style={[styles.input, styles.notesInput]}
                placeholder="Optional notes visible on the invoice"
                placeholderTextColor={colors.textTertiary}
                multiline
                numberOfLines={4}
                autoCapitalize="sentences"
                textAlignVertical="top"
                testID="invoice-editor-notes"
              />
            </View>

            {/* ── Line items ── */}
            <View style={styles.card}>
              <View style={styles.cardHeaderRow}>
                <Text style={styles.cardHeading}>Line items</Text>
                <Pressable
                  onPress={handleAddLine}
                  style={styles.addBtn}
                  hitSlop={8}
                  testID="invoice-editor-add-line"
                >
                  <Ionicons name="add" size={18} color={colors.tint} />
                  <Text style={styles.addBtnText}>Add</Text>
                </Pressable>
              </View>

              {lines.length === 0 ? (
                <Text style={styles.emptyHint}>No line items yet.</Text>
              ) : (
                lines.map((line, idx) => (
                  <View key={line.id ?? `new-${idx}`} style={styles.lineCard} testID={`invoice-editor-line-${idx}`}>
                    <View style={styles.lineHeaderRow}>
                      <Text style={styles.lineIndex}>Item {idx + 1}</Text>
                      <Pressable
                        onPress={() => removeLine(idx)}
                        hitSlop={8}
                        testID={`invoice-editor-remove-line-${idx}`}
                      >
                        <Ionicons name="trash-outline" size={18} color={colors.error} />
                      </Pressable>
                    </View>
                    <TextInput
                      value={line.description}
                      onChangeText={(t) => updateLine(idx, { description: t })}
                      style={styles.input}
                      placeholder="Description"
                      placeholderTextColor={colors.textTertiary}
                      autoCapitalize="sentences"
                      testID={`invoice-editor-line-desc-${idx}`}
                    />
                    <View style={styles.lineFieldsRow}>
                      <View style={styles.lineFieldThird}>
                        <Text style={styles.miniLabel}>Tooth</Text>
                        <TextInput
                          value={line.tooth}
                          onChangeText={(t) => updateLine(idx, { tooth: t })}
                          style={styles.input}
                          placeholder="—"
                          placeholderTextColor={colors.textTertiary}
                          autoCapitalize="none"
                          testID={`invoice-editor-line-tooth-${idx}`}
                        />
                      </View>
                      <View style={styles.lineFieldThird}>
                        <Text style={styles.miniLabel}>Qty</Text>
                        <TextInput
                          value={line.quantity}
                          onChangeText={(t) => updateLine(idx, { quantity: t })}
                          style={styles.input}
                          keyboardType="number-pad"
                          placeholder="1"
                          placeholderTextColor={colors.textTertiary}
                          testID={`invoice-editor-line-qty-${idx}`}
                        />
                      </View>
                      <View style={styles.lineFieldThird}>
                        <Text style={styles.miniLabel}>Unit price</Text>
                        <View style={[styles.input, styles.priceInputWrap]}>
                          <Text style={styles.priceDollar}>$</Text>
                          <TextInput
                            value={line.unitPrice}
                            onChangeText={(t) => updateLine(idx, { unitPrice: t })}
                            style={styles.priceInput}
                            keyboardType="decimal-pad"
                            placeholder="0.00"
                            placeholderTextColor={colors.textTertiary}
                            testID={`invoice-editor-line-price-${idx}`}
                          />
                        </View>
                      </View>
                    </View>
                    {line.subItems.length > 0 ? (
                      <Text style={styles.subItemsNote}>
                        {line.subItems.length} sub-item
                        {line.subItems.length === 1 ? "" : "s"} (edit on desktop)
                      </Text>
                    ) : null}
                  </View>
                ))
              )}

              <View style={styles.subtotalRow}>
                <Text style={styles.subtotalLabel}>Subtotal</Text>
                <Text style={styles.subtotalValue}>
                  $
                  {subtotal.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </Text>
              </View>
            </View>
          </ScrollView>

          <ItemPickerSheet
            visible={pickerVisible}
            items={billableItems}
            onSelect={(item) => {
              setPickerVisible(false);
              if (item) {
                addLine(item);
              } else {
                addLine();
              }
            }}
            onClose={() => setPickerVisible(false)}
          />
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

// ── Item picker sheet ─────────────────────────────────────────────────────────

interface ItemPickerSheetProps {
  visible: boolean;
  items: BillableItem[];
  onSelect: (item: BillableItem | null) => void;
  onClose: () => void;
}

function ItemPickerSheet({ visible, items, onSelect, onClose }: ItemPickerSheetProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState("");
  const styles = useMemo(() => makePickerStyles(colors), [colors]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => it.name.toLowerCase().includes(q));
  }, [items, search]);

  // Reset search when sheet opens.
  useEffect(() => {
    if (visible) setSearch("");
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={styles.backdrop} onPress={onClose}>
          <Pressable
            style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}
            onPress={() => undefined}
          >
            <View style={styles.grabber} />
            <Text style={styles.title}>Select item</Text>

            {items.length >= 5 && (
              <TextInput
                value={search}
                onChangeText={setSearch}
                style={styles.searchInput}
                placeholder="Search items…"
                placeholderTextColor={colors.textTertiary}
                autoCorrect={false}
                clearButtonMode="while-editing"
                testID="item-picker-search"
              />
            )}

            <ScrollView
              style={styles.list}
              contentContainerStyle={styles.listContent}
              keyboardShouldPersistTaps="handled"
            >
              {/* Custom item always appears first */}
              <Pressable
                style={styles.row}
                onPress={() => onSelect(null)}
                testID="item-picker-custom"
              >
                <View style={styles.rowIconWrap}>
                  <Ionicons name="pencil-outline" size={18} color={colors.tint} />
                </View>
                <View style={styles.rowBody}>
                  <Text style={[styles.rowName, { color: colors.tint }]}>Custom item</Text>
                  <Text style={styles.rowPrice}>Enter a custom description</Text>
                </View>
              </Pressable>

              {items.length > 0 && <View style={styles.divider} />}

              {filtered.map((item) => {
                const price =
                  item.unitPrice != null
                    ? `$${parseFloat(item.unitPrice).toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}`
                    : null;
                return (
                  <Pressable
                    key={item.id}
                    style={styles.row}
                    onPress={() => onSelect(item)}
                    testID={`item-picker-${item.id}`}
                  >
                    <View style={styles.rowBody}>
                      <Text style={styles.rowName}>{item.name}</Text>
                      {price != null && <Text style={styles.rowPrice}>{price}</Text>}
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
                  </Pressable>
                );
              })}

              {search.trim().length > 0 && filtered.length === 0 && (
                <Text style={styles.emptyText}>No matching items</Text>
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.backgroundSolid },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 8,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      backgroundColor: colors.surface,
    },
    headerButton: {
      minWidth: 56,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
    },
    headerTitle: {
      flex: 1,
      textAlign: "center",
      fontSize: 16,
      fontWeight: "600",
      color: colors.text,
      marginHorizontal: 8,
    },
    saveText: { fontSize: 16, fontWeight: "600", color: colors.tint },
    body: { flex: 1 },
    bodyContent: { padding: 16, gap: 16, paddingBottom: 48 },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      padding: 16,
      gap: 12,
    },
    cardHeaderRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    cardHeading: { fontSize: 15, fontWeight: "700", color: colors.text },
    field: { gap: 6 },
    fieldLabel: { fontSize: 13, fontWeight: "600", color: colors.textSecondary },
    miniLabel: { fontSize: 11, fontWeight: "600", color: colors.textTertiary, marginBottom: 4 },
    input: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 9,
      fontSize: 15,
      color: colors.text,
      backgroundColor: colors.backgroundSolid,
    },
    notesInput: {
      minHeight: 96,
      paddingTop: 10,
    },
    // Unit price field: inline "$" prefix sharing the same input border.
    priceInputWrap: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 0,
      paddingHorizontal: 10,
    },
    priceDollar: {
      fontSize: 15,
      color: colors.textSecondary,
      marginRight: 2,
    },
    priceInput: {
      flex: 1,
      fontSize: 15,
      color: colors.text,
      paddingVertical: 9,
    },
    statusRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    statusChip: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.backgroundSolid,
    },
    statusChipActive: { backgroundColor: colors.tint, borderColor: colors.tint },
    statusChipText: { fontSize: 13, fontWeight: "600", color: colors.textSecondary },
    statusChipTextActive: { color: colors.textInverse },
    addBtn: { flexDirection: "row", alignItems: "center", gap: 2 },
    addBtnText: { fontSize: 14, fontWeight: "600", color: colors.tint },
    emptyHint: { fontSize: 14, color: colors.textTertiary, paddingVertical: 8 },
    lineCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 12,
      padding: 10,
      gap: 8,
      backgroundColor: colors.backgroundSolid,
    },
    lineHeaderRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    lineIndex: { fontSize: 13, fontWeight: "700", color: colors.textSecondary },
    lineFieldsRow: { flexDirection: "row", gap: 6 },
    lineFieldThird: { flex: 1 },
    subItemsNote: { fontSize: 12, color: colors.textTertiary, fontStyle: "italic" },
    subtotalRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      paddingTop: 12,
    },
    subtotalLabel: { fontSize: 14, fontWeight: "600", color: colors.textSecondary },
    subtotalValue: { fontSize: 16, fontWeight: "700", color: colors.text },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
    errorTitle: { fontSize: 16, fontWeight: "600", color: colors.text, textAlign: "center" },
    loadingHint: { fontSize: 13, color: colors.textSecondary, textAlign: "center", marginTop: 4 },
    errorButton: {
      marginTop: 8,
      paddingHorizontal: 20,
      paddingVertical: 10,
      borderRadius: 10,
      backgroundColor: colors.tint,
    },
    errorButtonText: { color: colors.textInverse, fontWeight: "600", fontSize: 15 },
    frozenBanner: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      padding: 12,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: "#d97706",
      backgroundColor: "#fffbeb",
    },
    frozenBannerText: { fontSize: 14, color: "#92400e", lineHeight: 20 },
    frozenBannerLink: {
      fontSize: 13,
      color: "#b45309",
      textDecorationLine: "underline",
    },
    frozenBannerSubtext: { fontSize: 13, color: "#92400e", lineHeight: 18 },
  });
}

function makePickerStyles(colors: ThemeColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.45)",
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: colors.backgroundSolid,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingTop: 8,
      paddingHorizontal: 0,
      maxHeight: "80%",
    },
    grabber: {
      alignSelf: "center",
      width: 40,
      height: 4,
      borderRadius: 999,
      backgroundColor: colors.border,
      marginBottom: 8,
    },
    title: {
      fontSize: 17,
      fontWeight: "700",
      color: colors.text,
      paddingHorizontal: 20,
      marginBottom: 12,
    },
    searchInput: {
      marginHorizontal: 16,
      marginBottom: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 9,
      fontSize: 15,
      color: colors.text,
      backgroundColor: colors.surface,
    },
    list: { flexGrow: 0 },
    listContent: { paddingBottom: 8 },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
      marginVertical: 4,
      marginHorizontal: 16,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 13,
      paddingHorizontal: 20,
      gap: 12,
    },
    rowIconWrap: {
      width: 28,
      alignItems: "center",
    },
    rowBody: { flex: 1 },
    rowName: { fontSize: 15, fontWeight: "600", color: colors.text },
    rowPrice: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
    emptyText: {
      fontSize: 14,
      color: colors.textTertiary,
      textAlign: "center",
      paddingVertical: 24,
    },
  });
}
