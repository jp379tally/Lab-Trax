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
import { refreshCaseFinanceQueries } from "@/lib/refresh-case-finance";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { useMe, canAdminAnyLab } from "@/lib/auth-me";
import { formatMoney } from "@/lib/format";
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
  useDismissKeyboardOnTap,
} from "@/components/ui/DismissKeyboardView";
import { filterItemsByName } from "@workspace/item-name-match";

// useLocalSearchParams values are `string | string[]` — coerce to a single value.
function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

// ── Status options (mirror desktop invoice statuses) ──────────────────────────
const STATUS_OPTIONS: { value: NonNullable<UpdateInvoiceInput["status"]>; label: string }[] = [
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
  isDiscount?: boolean | null;
  subItems?: RawSubItem[] | null;
}

// One editable row in the line-items list.
interface DraftLine {
  id: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  isDiscount: boolean;
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
  priceKey?: string | null;
  isDiscount?: boolean;
}

type InvoiceRecord = {
  id?: string;
  invoiceNumber?: string | null;
  status?: string | null;
  tax?: number | string | null;
  discount?: number | string | null;
  total?: number | string | null;
  balanceDue?: number | string | null;
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

function draftLineTotal(line: DraftLine): number {
  const magnitude = num(line.quantity, 0) * num(line.unitPrice, 0);
  const mainItemTotal = line.isDiscount ? -Math.abs(magnitude) : magnitude;
  const subItemTotal = line.subItems.reduce(
    (sum, sub) => sum + num(sub.quantity, 0) * num(sub.unitPrice, 0),
    0,
  );
  return mainItemTotal + subItemTotal;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

export default function InvoiceEditorScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const invoiceId = firstParam(params.id) ?? null;
  const me = useMe().data;
  const isAdminOrOwner = canAdminAnyLab(me);

  const invoiceQuery = useInvoice(invoiceId);
  const invoice = (invoiceQuery.data ?? null) as InvoiceRecord | null;
  const updateInvoice = useUpdateInvoice();

  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [status, setStatus] = useState<NonNullable<UpdateInvoiceInput["status"]>>("open");
  const [teeth, setTeeth] = useState("");
  const [shade, setShade] = useState("");
  const [billTo, setBillTo] = useState("");
  const [notes, setNotes] = useState("");
  const [tax, setTax] = useState("0");
  const [discount, setDiscount] = useState("0");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [saving, setSaving] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Billable items fetched from the lab's items list (vendorType=item).
  const [billableItems, setBillableItems] = useState<BillableItem[]>([]);
  const [discountCatalogItems, setDiscountCatalogItems] = useState<BillableItem[]>([]);
  const discountPriceKeys = new Set(
    discountCatalogItems
      .map((item) => item.priceKey)
      .filter((key): key is string => !!key),
  );
  const pickableBillableItems = billableItems.filter(
    (item) => !item.priceKey || !discountPriceKeys.has(item.priceKey),
  );
  // Tier-resolved prices for each billable item, keyed by item name (display label).
  // Populated from /api/pricing/resolve-items when the invoice has a linked caseId.
  const [resolvedPrices, setResolvedPrices] = useState<Record<string, number>>({});
  const [pickerVisible, setPickerVisible] = useState(false);
  // null  → picker is being used to ADD a new line
  // >= 0  → picker is being used to UPDATE description of the line at that index
  const [pickerLineIdx, setPickerLineIdx] = useState<number | null>(null);
  // Line indexes that the user has explicitly switched to free-text edit mode
  // (after choosing "Custom item" from the picker for an existing line).
  const [descEditLineIdxes, setDescEditLineIdxes] = useState<ReadonlySet<number>>(new Set());

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
      (STATUS_OPTIONS.find((o) => o.value === invoice.status)?.value ?? "open"),
    );
    setTeeth(typeof meta.teeth === "string" ? meta.teeth : "");
    setShade(typeof meta.shade === "string" ? meta.shade : "");
    setBillTo(typeof meta.billTo === "string" ? meta.billTo : "");
    setNotes(invoice.notes ?? "");
    setTax(String(num(invoice.tax)));
    setDiscount(String(num(invoice.discount)));
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
          unitPrice: String(
            it.isDiscount ? Math.abs(num(it.unitPrice, 0)) : num(it.unitPrice, 0),
          ),
          isDiscount: !!it.isDiscount,
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

  // Fetch tier-resolved prices once the invoice's linked caseId is known.
  // When there is no caseId (standalone invoice, or invoice not yet loaded),
  // clear any stale map so pricing from a previous invoice can't bleed through.
  useEffect(() => {
    const caseId = invoice?.caseId;
    if (!caseId) {
      setResolvedPrices({});
      return;
    }
    let cancelled = false;
    resilientFetch(`/api/pricing/resolve-items?caseId=${encodeURIComponent(caseId)}`)
      .then((res) => res.json())
      .then((data: unknown) => {
        if (cancelled) return;
        // Server wraps the response in ok() → { ok: true, data: { items: [...] } }
        const payload =
          data !== null && typeof data === "object"
            ? (data as Record<string, unknown>)
            : {};
        const inner =
          payload.data !== null && typeof payload.data === "object"
            ? (payload.data as Record<string, unknown>)
            : payload;
        const items = Array.isArray(inner.items) ? inner.items : [];
        const map: Record<string, number> = {};
        for (const item of items) {
          const it = item as Record<string, unknown>;
          const label = typeof it.label === "string" ? it.label : null;
          const price =
            typeof it.unitPrice === "number"
              ? it.unitPrice
              : parseFloat(String(it.unitPrice ?? ""));
          // Accept 0 as a valid resolved price (no-charge / default fallback);
          // only reject non-finite values (NaN, Infinity).
          if (label && Number.isFinite(price)) {
            map[label] = price;
          }
        }
        setResolvedPrices(map);
      })
      .catch(() => {
        // On error keep the existing map empty — do not fall through to stale
        // pricing from a previous invoice. The empty state causes resolveItemPrice
        // to fall back to raw item.unitPrice, which is the safe default.
        setResolvedPrices({});
      });
    return () => {
      cancelled = true;
    };
  }, [invoice?.caseId]);

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

  // Explicit discounts come from the lab pricing catalog, not the vendor
  // item list, and are available even when this invoice has no linked case.
  useEffect(() => {
    const labOrgId = invoice?.labOrganizationId;
    if (!labOrgId) {
      setDiscountCatalogItems([]);
      return;
    }
    let cancelled = false;
    const query = new URLSearchParams({ labOrganizationId: labOrgId });
    if (invoice?.caseId) query.set("caseId", invoice.caseId);
    resilientFetch(`/api/pricing/discount-items?${query.toString()}`)
      .then((res) => res.json())
      .then((data: unknown) => {
        if (cancelled) return;
        const payload =
          data !== null && typeof data === "object"
            ? (data as Record<string, unknown>)
            : {};
        const inner =
          payload.data !== null && typeof payload.data === "object"
            ? (payload.data as Record<string, unknown>)
            : payload;
        const items = Array.isArray(inner.items) ? inner.items : [];
        setDiscountCatalogItems(
          items.map((item) => {
            const row = item as Record<string, unknown>;
            return {
              id: `discount:${String(row.key ?? row.label)}`,
              name: String(row.label ?? ""),
              unitPrice: String(row.unitPrice ?? ""),
              priceKey: String(row.key ?? ""),
              isDiscount: true,
            };
          }),
        );
      })
      .catch(() => {
        if (!cancelled) setDiscountCatalogItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [invoice?.labOrganizationId, invoice?.caseId]);

  function updateLine(idx: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  // Returns the best available price string for a billable item:
  // tier-resolved price → raw unitPrice → existingPrice (fallback for existing lines) → "".
  function resolveItemPrice(item: BillableItem, existingPrice?: string): string {
    const tierPrice = item.isDiscount ? undefined : resolvedPrices[item.name];
    if (tierPrice !== undefined) return String(tierPrice);
    if (item.unitPrice != null) {
      const n = parseFloat(item.unitPrice);
      if (Number.isFinite(n)) return String(n);
    }
    // When updating an existing line and no item price is available, preserve
    // whatever the user already had rather than blanking the field.
    if (existingPrice !== undefined) return existingPrice;
    return "";
  }

  function addLine(item?: BillableItem) {
    const prefillPrice = item ? resolveItemPrice(item) : "";
    setLines((prev) => [
      ...prev,
      {
        id: null,
        description: item?.name ?? "",
        quantity: "1",
        unitPrice: prefillPrice,
        isDiscount: !!item?.isDiscount,
        tooth: "",
        subItems: [],
        metaLabel: "",
        metaSubLabels: [],
      },
    ]);
  }

  function addDiscountLine() {
    setLines((prev) => [
      ...prev,
      {
        id: null,
        description: "",
        quantity: "1",
        unitPrice: "",
        isDiscount: true,
        tooth: "",
        subItems: [],
        metaLabel: "",
        metaSubLabels: [],
      },
    ]);
  }

  // Opens the picker when items exist; otherwise adds a blank line immediately.
  function handleAddLine() {
    if (pickableBillableItems.length > 0 || discountCatalogItems.length > 0) {
      setPickerLineIdx(null); // null = adding a new line
      setPickerVisible(true);
    } else {
      addLine();
    }
  }

  // Opens the picker to change the description of an existing line.
  function openPickerForLine(idx: number) {
    setPickerLineIdx(idx);
    setPickerVisible(true);
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  const subtotal = useMemo(
    () => lines.reduce((sum, line) => sum + draftLineTotal(line), 0),
    [lines],
  );
  const credits = Math.max(
    0,
    num(readMeta(invoice).credits as number | string | null | undefined, 0),
  );
  const displayedTotal =
    subtotal +
    num(tax, 0) -
    num(discount, 0) -
    credits;
  const paidAmount =
    invoice?.total != null && invoice.balanceDue != null
      ? num(invoice.total, 0) - num(invoice.balanceDue, 0)
      : 0;
  const displayedAmountDue = displayedTotal - paidAmount;

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
    const invalidPrice = lines.some((line) => {
      const values = [line.unitPrice, ...line.subItems.map((sub) => String(sub.unitPrice ?? ""))];
      return values.some((value) => value.trim() === "" || !Number.isFinite(Number(value)) || Number(value) < 0);
    });
    if (lines.some((line) => line.isDiscount && Number(line.unitPrice) <= 0)) {
      Alert.alert("Valid discount required", "Discount amounts must be greater than 0.");
      return;
    }
    if (invalidPrice) {
      Alert.alert(
        "Valid price required",
        "Every line item needs a valid price. Enter 0 for a no-charge item.",
      );
      return;
    }
    if ([tax, discount].some((value) => !Number.isFinite(Number(value)) || Number(value) < 0)) {
      Alert.alert("Valid amount required", "Tax and discount must be valid, non-negative amounts.");
      return;
    }

    // (D) Spread the existing displayMetadata so credits / patientName /
    // caseNotes survive — the server derives the invoice total from meta.credits.
    // billTo is now directly editable; overwrite it with the current form value.
    const existingMeta = readMeta(invoice);
    const displayMetadata: Record<string, unknown> = {
      ...existingMeta,
      ...(existingMeta.legacyChargesNeedsReview === true ? {
        legacyChargesNeedsReview: false,
        reviewedCharges: true,
        reviewedChargesNeedsReview: false,
      } : {}),
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
      unitPrice: l.isDiscount ? -Math.abs(Number(l.unitPrice)) : Number(l.unitPrice),
      isDiscount: l.isDiscount,
      sortOrder: idx,
      // (C) Round-trip sub-items untouched so the server doesn't hard-delete them.
      subItems: l.subItems.map((sub, sidx) => ({
        ...(sub.id ? { id: sub.id } : {}),
        toothNumber: sub.toothNumber ?? null,
        description: (sub.description ?? "").trim(),
        quantity: num(sub.quantity, 0),
        unitPrice: Number(sub.unitPrice),
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
          tax: Number(tax),
          discount: Number(discount),
          displayMetadata,
          items,
        },
      });
    } catch (e) {
      Alert.alert(
        "Couldn't save invoice",
        e instanceof Error ? e.message : "Please try again.",
      );
      return;
    } finally {
      setSaving(false);
    }
    // The API write is committed. A failed refetch must never turn it into
    // a retryable "save failed" state or drop the editor's successful exit.
    void refreshCaseFinanceQueries(queryClient).catch(() => {
      Alert.alert("Invoice saved", "Some totals could not refresh. Reopen the report to retry.");
    });
    router.back();
  }

  const styles = makeStyles(colors);
  const loading = invoiceQuery.isLoading && !invoice;
  // Legacy mobile-created invoices carry a `mobile:`-prefixed id. When the server
  // can't resolve one to a canonical, editable invoice, show a tailored message
  // instead of the generic "couldn't be loaded" copy.
  const isLegacyMobileInvoice = (invoiceId ?? "").startsWith("mobile:");

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <DismissKeyboardView style={styles.flex} testID="invoice-editor-keyboard-dismiss">
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
            testID="invoice-editor-scroll"
            horizontal={false}
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={scrollKeyboardDismissMode}
          >
            {readMeta(invoice).legacyChargesNeedsReview === true && (
              <View style={styles.frozenBanner} testID="invoice-editor-legacy-review-warning">
                <Text accessibilityRole="alert" style={styles.frozenBannerText}>
                  Legacy charges need review. Some charges have missing ownership information. Charges and totals have been left unchanged. Check each charge against the case, remove any obsolete charges, then save to confirm your review.
                </Text>
              </View>
            )}
            {/* ── Frozen banner ── */}
            {invoice.frozen && (
              <View style={styles.frozenBanner} testID="invoice-editor-frozen-banner">
                <Ionicons name="lock-closed" size={16} color="#92400e" style={{ marginTop: 2 }} />
                <View style={{ flex: 1, gap: 6 }}>
                  <Text style={styles.frozenBannerText}>
                    {invoice.caseDeletedNote ?? "Invoice is frozen — the linked case was deleted."}
                    {invoice.linkedCaseNumber ? ` — Case ${invoice.linkedCaseNumber}` : ""}
                    {invoice.caseDeletedAt ? ` · ${fmtDate(invoice.caseDeletedAt)}` : ""}
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
                autoCorrect={true}
                spellCheck={true}
                autoCapitalize="sentences"
                textAlignVertical="top"
                testID="invoice-editor-notes"
              />
            </View>

            {/* ── Line items ── */}
            <View style={styles.card}>
              <View style={styles.cardHeaderRow}>
                <Text style={styles.cardHeading}>Line items</Text>
                <View style={styles.cardHeaderActions}>
                  <Pressable
                    onPress={addDiscountLine}
                    style={styles.addBtn}
                    hitSlop={8}
                    testID="invoice-editor-add-discount"
                  >
                    <Text style={styles.addBtnText}>Add discount</Text>
                  </Pressable>
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
              </View>

              {lines.length === 0 ? (
                <Text style={styles.emptyHint}>No line items yet.</Text>
              ) : (
                lines.map((line, idx) => (
                  <View key={line.id ?? `new-${idx}`} style={styles.lineCard} testID={`invoice-editor-line-${idx}`}>
                    <View style={styles.lineHeaderRow}>
                      <Text style={styles.lineIndex}>
                        {line.isDiscount ? "Discount" : `Item ${idx + 1}`}
                      </Text>
                      <Pressable
                        onPress={() => removeLine(idx)}
                        hitSlop={8}
                        testID={`invoice-editor-remove-line-${idx}`}
                      >
                        <Ionicons name="trash-outline" size={18} color={colors.error} />
                      </Pressable>
                    </View>
                    {line.metaLabel ? (
                      <Text style={styles.miniLabel}>Item: {line.metaLabel}</Text>
                    ) : null}
                    {(billableItems.length > 0 || discountCatalogItems.length > 0) && !descEditLineIdxes.has(idx) ? (
                      <Pressable
                        style={[styles.input, styles.descPickerTrigger]}
                        onPress={() => openPickerForLine(idx)}
                        testID={`invoice-editor-line-desc-${idx}`}
                        accessibilityLabel={`Description for item ${idx + 1}`}
                      >
                        <Text
                          style={line.description ? styles.descPickerValue : styles.descPickerPlaceholder}
                          numberOfLines={1}
                        >
                          {line.description || "Description"}
                        </Text>
                        <Ionicons name="chevron-down-outline" size={16} color={colors.textTertiary} />
                      </Pressable>
                    ) : (
                      <TextInput
                        value={line.description}
                        onChangeText={(t) => updateLine(idx, { description: t })}
                        style={styles.input}
                        placeholder="Description"
                        placeholderTextColor={colors.textTertiary}
                        autoCorrect={true}
                        spellCheck={true}
                        autoCapitalize="sentences"
                        autoFocus={descEditLineIdxes.has(idx)}
                        testID={`invoice-editor-line-desc-${idx}`}
                      />
                    )}
                    {line.isDiscount && (
                      <Text style={styles.discountBadge}>DISCOUNT</Text>
                    )}
                    <View
                      style={styles.lineFieldsRow}
                      testID={`invoice-editor-line-fields-${idx}`}
                    >
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
                          accessibilityLabel={`Tooth for item ${idx + 1}`}
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
                          accessibilityLabel={`Quantity for item ${idx + 1}`}
                        />
                      </View>
                      <View
                        style={[styles.lineFieldThird, styles.linePriceField]}
                        testID={`invoice-editor-line-price-field-${idx}`}
                      >
                        <Text style={styles.miniLabel}>
                          {line.isDiscount ? "Discount amount" : "Unit price"}
                        </Text>
                        <View style={[styles.input, styles.priceInputWrap]}>
                          <Text style={styles.priceDollar}>
                            {line.isDiscount ? "−$" : "$"}
                          </Text>
                          <TextInput
                            value={line.unitPrice}
                            onChangeText={(t) => updateLine(idx, { unitPrice: t })}
                            style={styles.priceInput}
                            keyboardType="decimal-pad"
                            placeholder="0.00"
                            placeholderTextColor={colors.textTertiary}
                            testID={`invoice-editor-line-price-${idx}`}
                            accessibilityLabel={
                              line.isDiscount
                                ? `Discount amount for item ${idx + 1}`
                                : `Unit price for item ${idx + 1}`
                            }
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
                    <Text
                      style={styles.lineAmount}
                      testID={`invoice-editor-line-total-${idx}`}
                    >
                      {formatMoney(draftLineTotal(line))}
                    </Text>
                  </View>
                ))
              )}

              <View style={styles.subtotalRow}>
                <Text style={styles.subtotalLabel}>Subtotal</Text>
                <Text style={styles.subtotalValue} testID="invoice-editor-subtotal">
                  {formatMoney(subtotal)}
                </Text>
              </View>
              <View style={styles.amountRow}>
                <Text style={styles.subtotalLabel}>Tax</Text>
                <TextInput
                  accessibilityLabel="Tax amount"
                  testID="invoice-editor-tax"
                  style={[styles.input, styles.amountInput]}
                  keyboardType="decimal-pad"
                  value={tax}
                  onChangeText={setTax}
                />
              </View>
              <View style={styles.amountRow}>
                <Text style={styles.subtotalLabel}>Discount</Text>
                <TextInput
                  accessibilityLabel="Discount amount"
                  testID="invoice-editor-discount"
                  style={[styles.input, styles.amountInput]}
                  keyboardType="decimal-pad"
                  value={discount}
                  onChangeText={setDiscount}
                />
              </View>
              {credits > 0 && (
                <View style={styles.amountRow}>
                  <Text style={styles.subtotalLabel}>Credits applied</Text>
                  <Text style={styles.subtotalValue}>{`−${formatMoney(credits)}`}</Text>
                </View>
              )}
              <View style={styles.subtotalRow}>
                <Text style={styles.subtotalLabel}>Total</Text>
                <Text style={styles.subtotalValue} testID="invoice-editor-total">
                  {formatMoney(displayedTotal)}
                </Text>
              </View>
              <View style={styles.subtotalRow}>
                <Text style={styles.subtotalLabel}>Amount due</Text>
                <Text style={styles.subtotalValue} testID="invoice-editor-amount-due">
                  {formatMoney(displayedAmountDue)}
                </Text>
              </View>
            </View>
          </ScrollView>

          <ItemPickerSheet
            visible={pickerVisible}
            items={[...pickableBillableItems, ...discountCatalogItems]}
            resolvedPrices={resolvedPrices}
            isAdminOrOwner={isAdminOrOwner}
            onSelect={(item) => {
              setPickerVisible(false);
              if (pickerLineIdx === null) {
                // Adding a new line via the "+ Add" button.
                if (item) {
                  addLine(item);
                } else {
                  addLine(); // "Custom item" → blank new line
                }
              } else {
                // Updating the description of an existing line.
                if (item) {
                  updateLine(pickerLineIdx, {
                    description: item.name,
                    isDiscount: !!item.isDiscount,
                    // Pass the current line price as a last-resort fallback so
                    // switching descriptions never silently blanks the price.
                    unitPrice: resolveItemPrice(item, lines[pickerLineIdx]?.unitPrice),
                  });
                } else {
                  // "Custom item" → switch this line to free-text edit mode.
                  const editIdx = pickerLineIdx;
                  setDescEditLineIdxes((prev) => {
                    const next = new Set(prev);
                    next.add(editIdx);
                    return next;
                  });
                }
                setPickerLineIdx(null);
              }
            }}
            onAddNew={(typedName) => {
              setPickerVisible(false);
              const params = new URLSearchParams();
              params.set("addItem", "1");
              if (typedName) params.set("name", typedName);
              router.push((`/manage/pricing?${params.toString()}`) as any);
            }}
            onClose={() => setPickerVisible(false)}
          />
        </KeyboardAvoidingView>
      )}
      </DismissKeyboardView>
    </SafeAreaView>
  );
}

// ── Item picker sheet ─────────────────────────────────────────────────────────

interface ItemPickerSheetProps {
  visible: boolean;
  items: BillableItem[];
  /** Tier-resolved prices keyed by item name. When present, shown instead of raw unitPrice. */
  resolvedPrices?: Record<string, number>;
  isAdminOrOwner?: boolean;
  onSelect: (item: BillableItem | null) => void;
  onAddNew?: (typedName: string) => void;
  onClose: () => void;
}

function ItemPickerSheet({ visible, items, resolvedPrices, isAdminOrOwner, onSelect, onAddNew, onClose }: ItemPickerSheetProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState("");
  const styles = useMemo(() => makePickerStyles(colors), [colors]);
  // The sheet body already swallows taps so they never reach the closing
  // backdrop, so it also carries the keyboard dismissal for this sheet.
  const dismissKeyboard = useDismissKeyboardOnTap();

  // Punctuation/spacing-insensitive, ranked matching so "ema" finds
  // "E.max Crown" and "3 unit" finds "3-Unit Bridge".
  const filtered = useMemo(
    () => filterItemsByName(items, search.trim()),
    [items, search],
  );

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
            onPress={dismissKeyboard}
            testID="item-picker-keyboard-dismiss"
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
              keyboardDismissMode={scrollKeyboardDismissMode}
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
                // Prefer tier-resolved price; fall back to raw unitPrice.
                const resolvedAmount = item.isDiscount
                  ? undefined
                  : resolvedPrices?.[item.name];
                const displayAmount =
                  resolvedAmount !== undefined
                    ? resolvedAmount
                    : item.unitPrice != null
                      ? parseFloat(item.unitPrice)
                      : null;
                const price =
                  displayAmount !== null && Number.isFinite(displayAmount as number)
                    ? `${item.isDiscount ? "−" : ""}$${Math.abs(displayAmount as number).toLocaleString(undefined, {
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
                      <View style={styles.pickerNameRow}>
                        <Text style={styles.rowName}>{item.name}</Text>
                        {item.isDiscount && (
                          <Text style={styles.discountPickerBadge}>Discount</Text>
                        )}
                      </View>
                      {price != null && <Text style={styles.rowPrice}>{price}</Text>}
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
                  </Pressable>
                );
              })}

              {search.trim().length > 0 && filtered.length === 0 && (
                <Text style={styles.emptyText}>No matching items</Text>
              )}

              {/* "Add New Billable Item" shortcut — admins/owners only */}
              {isAdminOrOwner && onAddNew && (
                <>
                  <View style={styles.divider} />
                  <Pressable
                    style={styles.row}
                    onPress={() => onAddNew(search.trim())}
                    testID="item-picker-add-new"
                  >
                    <View style={styles.rowIconWrap}>
                      <Ionicons name="add-circle-outline" size={18} color={colors.tint} />
                    </View>
                    <View style={styles.rowBody}>
                      <Text style={[styles.rowName, { color: colors.tint }]}>
                        Add New Billable Item
                      </Text>
                      <Text style={styles.rowPrice}>Go to Pricing to create it</Text>
                    </View>
                  </Pressable>
                </>
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
    flex: { flex: 1 },
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
    cardHeaderActions: { flexDirection: "row", alignItems: "center", gap: 14 },
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
      minWidth: 0,
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
    // Description field shown as a tappable picker trigger when billable items exist.
    descPickerTrigger: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    descPickerValue: { flex: 1, minWidth: 0, fontSize: 15, color: colors.text },
    descPickerPlaceholder: { flex: 1, minWidth: 0, fontSize: 15, color: colors.textTertiary },
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
    discountBadge: {
      alignSelf: "flex-start",
      color: colors.error,
      backgroundColor: colors.error + "18",
      borderRadius: 5,
      paddingHorizontal: 6,
      paddingVertical: 2,
      fontSize: 10,
      fontWeight: "700",
      letterSpacing: 0.4,
    },
    lineAmount: {
      alignSelf: "flex-end",
      flexShrink: 1,
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: "600",
      textAlign: "right",
    },
    lineFieldsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    lineFieldThird: { flexGrow: 1, flexBasis: 80, minWidth: 80 },
    linePriceField: { flexBasis: 132, minWidth: 132 },
    amountRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      alignItems: "center",
      justifyContent: "space-between",
    },
    amountInput: { flexBasis: 132, flexShrink: 1, minWidth: 0, textAlign: "right" },
    subItemsNote: { fontSize: 12, color: colors.textTertiary, fontStyle: "italic" },
    subtotalRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      alignItems: "center",
      justifyContent: "space-between",
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      paddingTop: 12,
    },
    subtotalLabel: { flexShrink: 1, fontSize: 14, fontWeight: "600", color: colors.textSecondary },
    subtotalValue: { flexShrink: 1, fontSize: 16, fontWeight: "700", color: colors.text, textAlign: "right" },
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
    pickerNameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    rowName: { fontSize: 15, fontWeight: "600", color: colors.text },
    discountPickerBadge: {
      color: colors.error,
      fontSize: 10,
      fontWeight: "700",
      textTransform: "uppercase",
    },
    rowPrice: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
    emptyText: {
      fontSize: 14,
      color: colors.textTertiary,
      textAlign: "center",
      paddingVertical: 24,
    },
  });
}
