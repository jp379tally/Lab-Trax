import React, { useMemo, useState, useEffect, useRef } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  AppState,
  View,
  Text,
  FlatList,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Linking,
  TextInput,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useLocalSearchParams, router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useQuery } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Typography, Radius } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { DismissKeyboardView, scrollKeyboardDismissMode } from "@/components/ui/DismissKeyboardView";
import { StatusBadge, type BadgeVariant } from "@/components/ui/StatusBadge";
import { getJson, sendJson } from "@/lib/read-api";
import { trackSavedCardSetup } from "@/lib/saved-card-analytics";
import { useMe, primaryLabOrgId, canEditOrg } from "@/lib/auth-me";
import { formatDate, formatMoney, titleCase } from "@/lib/format";
import { CaseQuickActionSheet } from "@/components/CaseQuickActionSheet";
import { useLongPressGuard } from "@/lib/use-long-press-guard";
import { isActiveCaseRecord } from "@/lib/case-quick-actions";
import type { CanonicalCase } from "@workspace/api-client-react";
import { formatAccountNumberForDisplay } from "@workspace/account-number";

type ViewMode = "open" | "all";
type InvoiceFilter = "all" | "open" | "paid" | "overdue" | "void";

interface CaseEntry {
  id: string;
  caseNumber: string;
  status: string;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  createdAt?: string | null;
  dueDate?: string | null;
}

interface InvoiceEntry {
  id: string;
  caseId?: string | null;
  invoiceNumber?: string | null;
  status?: string | null;
  total?: number | string | null;
  balanceDue?: number | string | null;
  issuedAt?: string | null;
  dueAt?: string | null;
}

interface OrgDetails {
  id?: string | null;
  name?: string | null;
  displayName?: string | null;
  platformAccountNumber?: string | null;
  accountNumber?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

interface InvoiceSummary {
  totalInvoiced: number;
  totalPaid: number;
  outstanding: number;
}

interface LabCardResponse {
  hasCard: boolean;
  card: { brand: string; last4: string; expMonth: number; expYear: number } | null;
  autoPay: { enabled: boolean; dayOfMonth: number | null };
}

interface CardChargeResult {
  checkoutId: string;
  status: string;
  totalAmount: number;
  failureReason?: string;
}

type ListItem =
  | { kind: "sectionHeader"; label: string }
  | { kind: "case"; data: CaseEntry }
  | { kind: "invoiceSummary"; summary: InvoiceSummary }
  | { kind: "invoiceFilterRow" }
  | { kind: "invoice"; data: InvoiceEntry };

const INVOICE_FILTER_OPTIONS: { key: InvoiceFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "paid", label: "Paid" },
  { key: "overdue", label: "Overdue" },
  { key: "void", label: "Void" },
];

function patientName(c: CaseEntry): string {
  const name = `${c.patientFirstName ?? ""} ${c.patientLastName ?? ""}`.trim();
  return name || "Unnamed patient";
}

function statusVariant(status: string | null | undefined): BadgeVariant {
  const s = (status ?? "").toLowerCase();
  if (s.includes("remake")) return "remake";
  if (s.includes("complete") || s.includes("delivered") || s.includes("done")) return "complete";
  if (s.includes("ship") || s.includes("ready") || s.includes("delivery")) return "ship";
  if (s.includes("hold") || s.includes("cancel") || s.includes("void")) return "draft";
  if (s.includes("intake") || s.includes("new") || s.includes("received") || s.includes("pending"))
    return "intake";
  return "progress";
}

function invoiceVariant(status: string | null | undefined): BadgeVariant {
  const s = (status ?? "").toLowerCase();
  if (s.includes("paid")) return "paid";
  if (s.includes("overdue") || s.includes("past")) return "overdue";
  if (s.includes("void") || s.includes("cancel")) return "void";
  return "unpaid";
}

function matchesInvoiceFilter(inv: InvoiceEntry, filter: InvoiceFilter): boolean {
  if (filter === "all") return true;
  const s = (inv.status ?? "").toLowerCase().trim();
  // Normalise token-based checks: "paid" must NOT match "unpaid".
  // Use word-boundary-safe helpers: isPaid = exactly "paid" or "fully_paid" etc.
  const isPaid = s === "paid" || s === "fully_paid";
  const isOverdue = s.includes("overdue") || s.includes("past_due") || s === "past";
  const isVoid = s.includes("void") || s.includes("cancel");

  if (filter === "paid") return isPaid;
  if (filter === "overdue") return isOverdue;
  if (filter === "void") return isVoid;
  // open = unpaid, not overdue, not void/cancelled, not paid
  if (filter === "open") return !isPaid && !isOverdue && !isVoid;
  return true;
}

function formatAddress(org: OrgDetails): string | null {
  const parts: string[] = [];
  if (org.addressLine1) parts.push(org.addressLine1);
  if (org.addressLine2) parts.push(org.addressLine2);
  const cityStateZip = [org.city, org.state, org.zip].filter(Boolean).join(", ");
  if (cityStateZip) parts.push(cityStateZip);
  return parts.length > 0 ? parts.join(", ") : null;
}

function hasContactInfo(org: OrgDetails): boolean {
  return !!(
    org.platformAccountNumber ||
    org.accountNumber ||
    org.phone ||
    org.addressLine1 ||
    org.city
  );
}

export default function DoctorCasesScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const params = useLocalSearchParams<{
    doctorName: string;
    providerOrganizationId?: string;
    practiceName?: string;
    initialViewMode?: string;
    phone?: string;
  }>();

  const doctorName = params.doctorName ?? "";
  const providerOrganizationId = params.providerOrganizationId ?? "";
  const practiceName = params.practiceName ?? "";
  const phoneParam = params.phone ?? "";

  const [viewMode, setViewMode] = useState<ViewMode>(
    params.initialViewMode === "all" ? "all" : "open",
  );
  const [invoiceFilter, setInvoiceFilter] = useState<InvoiceFilter>("all");
  const { markLongPress, consumeLongPress } = useLongPressGuard<string>();
  const [quickActionCase, setQuickActionCase] = useState<CaseEntry | null>(null);


  const filterStorageKey = providerOrganizationId
    ? `invoice_filter_v1_${providerOrganizationId}`
    : "invoice_filter_v1_global";

  // Hydrate persisted filter on mount; skip writing back during initial load.
  const hydratedRef = useRef(false);
  useEffect(() => {
    AsyncStorage.getItem(filterStorageKey).then((stored) => {
      const valid: InvoiceFilter[] = ["all", "open", "paid", "overdue", "void"];
      if (stored && (valid as string[]).includes(stored)) {
        setInvoiceFilter(stored as InvoiceFilter);
      }
      hydratedRef.current = true;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStorageKey]);

  // Persist whenever the user changes the filter (skip the initial default write).
  useEffect(() => {
    if (!hydratedRef.current) return;
    AsyncStorage.setItem(filterStorageKey, invoiceFilter);
  }, [invoiceFilter, filterStorageKey]);

  const me = useMe().data;
  const labOrgId = primaryLabOrgId(me);
  const canManageCard = canEditOrg(me, labOrgId);
  const [selectedAmounts, setSelectedAmounts] = useState<Record<string, string>>({});
  const [isReviewingCharge, setIsReviewingCharge] = useState(false);
  const [cardActionBusy, setCardActionBusy] = useState(false);
  const [chargeResult, setChargeResult] = useState<CardChargeResult | null>(null);
  const [cardActionError, setCardActionError] = useState<string | null>(null);

  const cardQuery = useQuery<LabCardResponse>({
    queryKey: ["provider-lab-card", labOrgId ?? "", providerOrganizationId],
    enabled: !!labOrgId && !!providerOrganizationId && canManageCard,
    staleTime: 15_000,
    queryFn: async () =>
      getJson<LabCardResponse>(
        `/api/provider/lab-card?${new URLSearchParams({
          labOrganizationId: labOrgId!,
          providerOrganizationId,
        }).toString()}`,
      ),
  });

  // A hosted card setup hands control to the browser. Refresh when the app is
  // foregrounded again so the summary always reflects the server's card state.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        cardQuery.refetch();
        invoicesQuery.refetch();
      }
    });
    const urlSubscription = Linking.addEventListener("url", () => {
      cardQuery.refetch();
      invoicesQuery.refetch();
    });
    return () => {
      subscription.remove();
      urlSubscription.remove();
    };
  // react-query returns stable refetch functions; this avoids re-subscribing for data updates.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labOrgId, providerOrganizationId]);

  const orgQuery = useQuery<OrgDetails | null>({
    queryKey: ["org-detail", providerOrganizationId],
    enabled: !!providerOrganizationId,
    staleTime: 60_000,
    queryFn: async () => {
      const data = await getJson<OrgDetails>(
        `/api/organizations/${encodeURIComponent(providerOrganizationId)}`,
      );
      return data ?? null;
    },
  });

  const casesQuery = useQuery<CaseEntry[]>({
    queryKey: ["doctor-cases", labOrgId ?? "", doctorName, providerOrganizationId, viewMode],
    enabled: !!labOrgId && !!doctorName,
    staleTime: 30_000,
    queryFn: async () => {
      const qp = new URLSearchParams();
      if (labOrgId) qp.set("organizationId", labOrgId);
      qp.set("doctorName", doctorName);
      if (providerOrganizationId) qp.set("providerOrganizationId", providerOrganizationId);
      if (viewMode === "open") qp.set("openOnly", "true");
      const data = await getJson<CaseEntry[]>(`/api/cases?${qp.toString()}`);
      return Array.isArray(data) ? data : [];
    },
  });

  const invoicesQuery = useQuery<InvoiceEntry[]>({
    queryKey: ["doctor-invoices", labOrgId ?? "", providerOrganizationId, doctorName],
    enabled: !!labOrgId,
    staleTime: 30_000,
    queryFn: async () => {
      const qp = new URLSearchParams();
      if (providerOrganizationId) {
        qp.set("practiceId", providerOrganizationId);
      } else if (labOrgId) {
        qp.set("labOrganizationId", labOrgId);
      }
      const data = await getJson<InvoiceEntry[]>(`/api/invoices?${qp.toString()}`);
      return Array.isArray(data) ? data : [];
    },
  });

  const listItems = useMemo((): ListItem[] => {
    const cases = casesQuery.data ?? [];
    const allInvoices = invoicesQuery.data ?? [];

    // Scope invoices to this specific doctor: include an invoice only when
    // its caseId belongs to one of the doctor's fetched cases. Invoices with
    // no caseId are excluded (no reliable way to attribute them to a single
    // doctor within a shared practice).
    const doctorCaseIds = new Set(cases.map((c) => c.id));
    const scopedInvoices = allInvoices.filter(
      (inv) => inv.caseId != null && doctorCaseIds.has(inv.caseId),
    );

    const filteredInvoices = scopedInvoices.filter((inv) =>
      matchesInvoiceFilter(inv, invoiceFilter),
    );

    // Summary computed from all scoped invoices (full set, ignoring the active filter)
    // so the snapshot always reflects the doctor's complete financial picture.
    const totalInvoiced = scopedInvoices.reduce((sum, inv) => sum + Number(inv.total ?? 0), 0);
    const outstanding = scopedInvoices.reduce((sum, inv) => sum + Number(inv.balanceDue ?? 0), 0);
    const totalPaid = totalInvoiced - outstanding;
    const summary: InvoiceSummary = { totalInvoiced, totalPaid, outstanding };

    const result: ListItem[] = [];
    if (cases.length > 0) {
      result.push({ kind: "sectionHeader", label: `Cases (${cases.length})` });
      for (const c of cases) result.push({ kind: "case", data: c });
    }
    if (scopedInvoices.length > 0) {
      result.push({ kind: "invoiceSummary", summary });
      result.push({ kind: "invoiceFilterRow" });
      const filterLabel =
        invoiceFilter !== "all"
          ? ` · ${INVOICE_FILTER_OPTIONS.find((o) => o.key === invoiceFilter)?.label ?? ""}`
          : "";
      result.push({
        kind: "sectionHeader",
        label: `Invoices (${filteredInvoices.length}${filterLabel})`,
      });
      for (const inv of filteredInvoices) result.push({ kind: "invoice", data: inv });
    }
    return result;
  }, [casesQuery.data, invoicesQuery.data, invoiceFilter]);

  const isLoading = casesQuery.isLoading || invoicesQuery.isLoading;
  const isError = casesQuery.isError || invoicesQuery.isError;
  const isFetching = casesQuery.isFetching || invoicesQuery.isFetching;
  const caseCount = casesQuery.data?.length ?? 0;

  const subtitle = isLoading
    ? "Loading…"
    : viewMode === "open"
    ? `${caseCount} open case${caseCount === 1 ? "" : "s"}`
    : `${caseCount} case${caseCount === 1 ? "" : "s"}`;

  const orgData = orgQuery.data;
  // Use org phone when available; fall back to the phone passed from the
  // customer list (which may be the doctor's user-record phone or practice
  // phone from the search endpoint).
  const effectivePhone = orgData?.phone || (phoneParam || null);
  const showInfoCard =
    !!effectivePhone ||
    !!(orgData && hasContactInfo(orgData));
  const accountNum = orgData?.platformAccountNumber
    ? formatAccountNumberForDisplay(orgData.platformAccountNumber)
    : orgData?.accountNumber ?? null;
  const formattedAddress = orgData ? formatAddress(orgData) : null;
  const payableInvoices = useMemo(
    () =>
      (invoicesQuery.data ?? []).filter((inv) => {
        const status = (inv.status ?? "").toLowerCase();
        return !status.includes("paid") && !status.includes("void") && Number(inv.balanceDue ?? 0) > 0;
      }),
    [invoicesQuery.data],
  );
  const allocations = useMemo(
    () =>
      payableInvoices
        .map((invoice) => ({
          invoiceId: invoice.id,
          amount: Number(selectedAmounts[invoice.id] ?? 0),
          invoice,
        }))
        .filter((allocation) => allocation.amount > 0 && allocation.amount <= Number(allocation.invoice.balanceDue ?? 0)),
    [payableInvoices, selectedAmounts],
  );
  const allocationTotal = allocations.reduce((sum, allocation) => sum + allocation.amount, 0);

  const updateAllocation = (invoice: InvoiceEntry, raw: string) => {
    const normalized = raw.replace(/[^0-9.]/g, "");
    setSelectedAmounts((current) => ({ ...current, [invoice.id]: normalized }));
    setIsReviewingCharge(false);
    setChargeResult(null);
  };

  const startCardSetup = async () => {
    if (!labOrgId || !providerOrganizationId) return;
    setCardActionBusy(true);
    setCardActionError(null);
    try {
      trackSavedCardSetup("started");
      const result = await sendJson<{ url: string }>("POST", "/api/provider/lab-card/setup", {
        labOrganizationId: labOrgId,
        providerOrganizationId,
        successUrl: "labtrax://finance/lab-card-complete",
        cancelUrl: "labtrax://finance/lab-card-cancelled",
      });
      if (!result.url) throw new Error("Card setup link was unavailable.");
      await Linking.openURL(result.url);
    } catch (error) {
      setCardActionError(error instanceof Error ? error.message : "Couldn't open card setup.");
    } finally {
      setCardActionBusy(false);
    }
  };

  const confirmCharge = async () => {
    if (!labOrgId || !providerOrganizationId || allocations.length === 0) return;
    setCardActionBusy(true);
    setCardActionError(null);
    try {
      const chargeKeyStorage = `lab-card-charge:${labOrgId}:${providerOrganizationId}`;
      const persistedKey = await AsyncStorage.getItem(chargeKeyStorage);
      const idempotencyKey =
        persistedKey ?? `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      if (!persistedKey) await AsyncStorage.setItem(chargeKeyStorage, idempotencyKey);
      const result = await sendJson<CardChargeResult>("POST", "/api/provider/lab-card/charge", {
        labOrganizationId: labOrgId,
        providerOrganizationId,
        allocations: allocations.map(({ invoiceId, amount }) => ({ invoiceId, amount })),
        idempotencyKey,
      });
      setChargeResult(result);
      setIsReviewingCharge(false);
      if (result.status.toLowerCase() !== "pending") {
        await AsyncStorage.removeItem(chargeKeyStorage);
      }
      if (result.status.toLowerCase() === "succeeded" || result.status.toLowerCase() === "success") {
        setSelectedAmounts({});
        invoicesQuery.refetch();
      }
    } catch (error) {
      setCardActionError(error instanceof Error ? error.message : "Charge could not be completed.");
    } finally {
      setCardActionBusy(false);
    }
  };

  function renderItem({ item }: { item: ListItem }) {
    if (item.kind === "sectionHeader") {
      return (
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionLabel}>{item.label}</Text>
        </View>
      );
    }
    if (item.kind === "invoiceSummary") {
      const { totalInvoiced, totalPaid, outstanding } = item.summary;
      return (
        <View style={styles.summaryCard}>
          <View style={styles.summaryCol}>
            <Text style={styles.summaryLabel}>Invoiced</Text>
            <Text style={styles.summaryValue}>{formatMoney(totalInvoiced)}</Text>
          </View>
          <View style={styles.summarySep} />
          <View style={styles.summaryCol}>
            <Text style={styles.summaryLabel}>Paid</Text>
            <Text style={[styles.summaryValue, totalPaid > 0 && styles.summaryValuePaid]}>
              {formatMoney(totalPaid)}
            </Text>
          </View>
          <View style={styles.summarySep} />
          <View style={styles.summaryCol}>
            <Text style={styles.summaryLabel}>Outstanding</Text>
            <Text style={[styles.summaryValue, outstanding > 0 && styles.summaryValueDue]}>
              {formatMoney(outstanding)}
            </Text>
          </View>
        </View>
      );
    }
    if (item.kind === "invoiceFilterRow") {
      return (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.filterRow}
          style={styles.filterScroll}
        >
          {INVOICE_FILTER_OPTIONS.map((opt, i) => {
            const isActive = invoiceFilter === opt.key;
            const isFirst = i === 0;
            const isLast = i === INVOICE_FILTER_OPTIONS.length - 1;
            return (
              <TouchableOpacity
                key={opt.key}
                style={[
                  styles.filterBtn,
                  isFirst && styles.filterBtnFirst,
                  isLast && styles.filterBtnLast,
                  isActive && styles.filterBtnActive,
                ]}
                onPress={() => setInvoiceFilter(opt.key)}
              >
                <Text style={[styles.filterText, isActive && styles.filterTextActive]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      );
    }
    if (item.kind === "case") {
      const c = item.data;
      return (
        <Card
          style={styles.row}
          onPress={() => {
            if (consumeLongPress(c.id)) return;
            router.push(`/case/${c.id}` as never);
          }}
          onLongPress={() => {
            if (!isActiveCaseRecord(c)) return;
            markLongPress(c.id);
            Promise.resolve(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)).catch(() => {});
            setQuickActionCase(c);
          }}
          delayLongPress={400}
          testID={`doctor-case-${c.id}`}
          accessibilityRole="button"
          accessibilityLabel={`${patientName(c)}${c.caseNumber ? `, case ${c.caseNumber}` : ""}`}
          accessibilityHint={
            isActiveCaseRecord(c)
              ? "Tap to open case details. Long press for quick actions."
              : "Tap to open case details."
          }
        >
          <View style={styles.rowMain}>
            <Text style={styles.rowName} numberOfLines={1}>
              {patientName(c)}
            </Text>
            <Text style={styles.rowMeta} numberOfLines={1}>
              {c.caseNumber}
              {c.dueDate ? ` · Due ${formatDate(c.dueDate)}` : ""}
            </Text>
          </View>
          <StatusBadge label={titleCase(c.status ?? "—")} variant={statusVariant(c.status)} size="sm" />
        </Card>
      );
    }
    if (item.kind === "invoice") {
      const inv = item.data;
      return (
        <Card style={styles.row} onPress={() => router.push(`/invoice-editor/${inv.id}` as never)}>
          <View style={styles.rowMain}>
            <Text style={styles.rowName} numberOfLines={1}>
              {inv.invoiceNumber || "Invoice"}
            </Text>
            <Text style={styles.rowMeta} numberOfLines={1}>
              Issued {formatDate(inv.issuedAt)} · Due {formatDate(inv.dueAt)}
            </Text>
          </View>
          <View style={styles.rowRight}>
            <Text style={styles.rowAmount}>
              {formatMoney(Number(inv.balanceDue ?? inv.total ?? 0))}
            </Text>
            <StatusBadge
              label={titleCase(inv.status ?? "unpaid")}
              variant={invoiceVariant(inv.status)}
              size="sm"
            />
          </View>
        </Card>
      );
    }
    return null;
  }

  return (
    <DismissKeyboardView
      style={[styles.screen, { paddingTop: insets.top }]}
      testID="doctor-cases-keyboard-dismiss"
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={8} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {doctorName}
          </Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {practiceName ? practiceName : subtitle}
          </Text>
          {practiceName ? (
            <Text style={styles.headerCount} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <View style={styles.toggle}>
          <TouchableOpacity
            style={[styles.toggleBtn, viewMode === "open" && styles.toggleBtnActive]}
            onPress={() => setViewMode("open")}
          >
            <Text style={[styles.toggleText, viewMode === "open" && styles.toggleTextActive]}>
              Open
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toggleBtn, styles.toggleBtnRight, viewMode === "all" && styles.toggleBtnActive]}
            onPress={() => setViewMode("all")}
          >
            <Text style={[styles.toggleText, viewMode === "all" && styles.toggleTextActive]}>
              All
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {showInfoCard ? (
        <View style={styles.infoCard}>
          {accountNum ? (
            <View style={styles.infoRow}>
              <Ionicons name="card-outline" size={14} color={colors.textSecondary} style={styles.infoIcon} />
              <Text style={styles.infoText} numberOfLines={1}>
                {accountNum}
              </Text>
            </View>
          ) : null}
          {effectivePhone ? (
            <TouchableOpacity
              style={styles.infoRow}
              onPress={() => Linking.openURL(`tel:${effectivePhone}`)}
            >
              <Ionicons name="call-outline" size={14} color={colors.textSecondary} style={styles.infoIcon} />
              <Text style={[styles.infoText, styles.infoLink]} numberOfLines={1}>
                {effectivePhone}
              </Text>
            </TouchableOpacity>
          ) : null}
          {formattedAddress ? (
            <View style={styles.infoRow}>
              <Ionicons name="location-outline" size={14} color={colors.textSecondary} style={styles.infoIcon} />
              <Text style={styles.infoText} numberOfLines={2}>
                {formattedAddress}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {canManageCard && providerOrganizationId ? (
        <KeyboardAwareScrollView
          style={styles.paymentScroll}
          contentContainerStyle={styles.paymentContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={scrollKeyboardDismissMode}
          bottomOffset={Spacing.xl}
        >
          <View style={styles.paymentCard}>
            <View style={styles.paymentHeading}>
              <View style={styles.paymentHeadingCopy}>
                <Text style={styles.paymentTitle}>Practice payment card</Text>
                {cardQuery.isLoading ? (
                  <Text style={styles.paymentDetail}>Loading card…</Text>
                ) : cardQuery.data?.hasCard && cardQuery.data.card ? (
                  <Text style={styles.paymentDetail}>
                    {cardQuery.data.card.brand} •••• {cardQuery.data.card.last4} · expires {cardQuery.data.card.expMonth}/{cardQuery.data.card.expYear}
                  </Text>
                ) : (
                  <Text style={styles.paymentDetail}>No shared card on file — add one to charge open invoices.</Text>
                )}
              </View>
              <TouchableOpacity
                testID="lab-card-setup"
                style={styles.outlineBtn}
                disabled={cardActionBusy}
                onPress={startCardSetup}
              >
                <Text style={styles.outlineBtnText}>
                  {cardQuery.data?.hasCard ? "Replace" : "Add card"}
                </Text>
              </TouchableOpacity>
            </View>
            <View style={styles.autoPayNote}>
              <Ionicons name="information-circle-outline" size={16} color={colors.textSecondary} />
              <Text style={styles.autoPayText}>
                Auto-pay is {cardQuery.data?.autoPay.enabled ? `on${cardQuery.data.autoPay.dayOfMonth ? ` for day ${cardQuery.data.autoPay.dayOfMonth}` : ""}` : "off"}. This card is shared for this practice. Invoices are due by the 10th; auto-pay settings are managed outside this screen.
              </Text>
            </View>
            {cardActionError ? <Text style={styles.paymentError}>{cardActionError}</Text> : null}
            {cardQuery.isError ? (
              <Text style={styles.paymentError}>Couldn&apos;t load the shared card. Pull to refresh and try again.</Text>
            ) : null}
            <TouchableOpacity
              testID="lab-shared-account"
              style={styles.accountContextLink}
              onPress={() =>
                router.push({
                  pathname: "/settings/shared-account",
                  params: {
                    labOrganizationId: labOrgId!,
                    providerOrganizationId,
                    relationshipName: practiceName || doctorName,
                  },
                } as never)
              }
            >
              <View style={styles.rowMain}>
                <Text style={styles.paymentTitle}>Shared account details</Text>
                <Text style={styles.paymentDetail}>Contact profile, pending approvals, and account history</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>

          {cardQuery.data?.hasCard && payableInvoices.length > 0 ? (
            <View style={styles.paymentCard}>
              <Text style={styles.paymentTitle}>Pay open invoices</Text>
              <Text style={styles.paymentDetail}>Enter a full or partial amount for each invoice.</Text>
              {payableInvoices.map((invoice) => {
                const balance = Number(invoice.balanceDue ?? 0);
                return (
                  <View key={invoice.id} style={styles.allocationRow}>
                    <View style={styles.allocationInfo}>
                      <Text style={styles.allocationName}>{invoice.invoiceNumber || "Invoice"}</Text>
                      <Text style={styles.paymentDetail}>Balance {formatMoney(balance)}</Text>
                    </View>
                    <View style={styles.amountEdit}>
                      <Text style={styles.currencyMark}>$</Text>
                      <TextInput
                        testID={`invoice-allocation-${invoice.id}`}
                        value={selectedAmounts[invoice.id] ?? ""}
                        onChangeText={(value) => updateAllocation(invoice, value)}
                        placeholder={balance.toFixed(2)}
                        placeholderTextColor={colors.textTertiary}
                        keyboardType="decimal-pad"
                        style={styles.amountInput}
                      />
                    </View>
                  </View>
                );
              })}
              {isReviewingCharge ? (
                <View style={styles.reviewBox}>
                  <Text style={styles.reviewText}>Charge {formatMoney(allocationTotal)} to the shared practice card?</Text>
                  <View style={styles.reviewActions}>
                    <TouchableOpacity style={styles.cancelBtn} onPress={() => setIsReviewingCharge(false)}>
                      <Text style={styles.cancelBtnText}>Back</Text>
                    </TouchableOpacity>
                    <TouchableOpacity testID="confirm-card-charge" style={styles.primaryBtn} disabled={cardActionBusy} onPress={confirmCharge}>
                      <Text style={styles.primaryBtnText}>{cardActionBusy ? "Charging…" : "Confirm charge"}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <TouchableOpacity
                  testID="review-card-charge"
                  style={[styles.primaryBtn, allocations.length === 0 && styles.disabledBtn]}
                  disabled={allocations.length === 0 || cardActionBusy}
                  onPress={() => setIsReviewingCharge(true)}
                >
                  <Text style={styles.primaryBtnText}>Review {allocationTotal > 0 ? formatMoney(allocationTotal) : "payment"}</Text>
                </TouchableOpacity>
              )}
              {chargeResult ? (
                <View style={chargeResult.status.toLowerCase().includes("success") || chargeResult.status.toLowerCase().includes("succeed") ? styles.successNotice : styles.failureNotice}>
                  <Text style={styles.noticeText}>
                    {chargeResult.status.toLowerCase().includes("success") || chargeResult.status.toLowerCase().includes("succeed")
                      ? `Payment successful: ${formatMoney(chargeResult.totalAmount)}`
                      : `Payment failed: ${chargeResult.failureReason || "The card was not charged."}`}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </KeyboardAwareScrollView>
      ) : null}

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : isError ? (
        <View style={styles.center}>
          <Ionicons name="cloud-offline-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>Couldn't load data</Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={() => {
              casesQuery.refetch();
              invoicesQuery.refetch();
            }}
          >
            <Text style={styles.retryText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : listItems.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="folder-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>
            {viewMode === "open" ? "No open cases" : "No cases or invoices"}
          </Text>
          <Text style={styles.emptyBody}>
            {viewMode === "open"
              ? "This doctor has no active open cases."
              : "No cases or invoices found for this doctor."}
          </Text>
        </View>
      ) : (
        <FlatList
          data={listItems}
          keyExtractor={(item, i) => {
            if (item.kind === "sectionHeader") return `section-${i}`;
            if (item.kind === "invoiceFilterRow") return "invoice-filter-row";
            if (item.kind === "invoiceSummary") return "invoice-summary";
            return `${item.kind}-${item.data.id}`;
          }}
          renderItem={renderItem}
            keyboardDismissMode={scrollKeyboardDismissMode}
            keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={isFetching && !isLoading}
              onRefresh={() => {
                casesQuery.refetch();
                invoicesQuery.refetch();
              }}
              tintColor={colors.tint}
            />
          }
        />
      )}
      <CaseQuickActionSheet
        visible={quickActionCase !== null}
        caseItem={quickActionCase as CanonicalCase | null}
        onDismiss={() => setQuickActionCase(null)}
        labOrganizationId={labOrgId}
        onActionSuccess={() => {
          void casesQuery.refetch();
        }}
      />
    </DismissKeyboardView>
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
      paddingBottom: Spacing.sm,
      gap: Spacing.xs,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    backBtn: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
    },
    headerText: { flex: 1, minWidth: 0 },
    headerTitle: { ...Typography.h3, color: c.text },
    headerSubtitle: { ...Typography.caption, color: c.textSecondary, marginTop: 1 },
    headerCount: { ...Typography.caption, color: c.textTertiary, marginTop: 1 },
    toggle: {
      flexDirection: "row",
      borderRadius: Radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      overflow: "hidden",
    },
    toggleBtn: {
      paddingHorizontal: Spacing.sm,
      paddingVertical: 6,
      backgroundColor: c.surface,
    },
    toggleBtnRight: {
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: c.border,
    },
    toggleBtnActive: { backgroundColor: c.tint },
    toggleText: { ...Typography.captionSemibold, color: c.textSecondary },
    toggleTextActive: { color: "#fff" },
    infoCard: {
      marginHorizontal: Spacing.lg,
      marginTop: Spacing.sm,
      marginBottom: Spacing.xs,
      padding: Spacing.sm,
      backgroundColor: c.surface,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      gap: Spacing.xs,
    },
    infoRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.xs,
    },
    infoIcon: {
      marginTop: 1,
    },
    infoText: {
      ...Typography.caption,
      color: c.textSecondary,
      flex: 1,
    },
    infoLink: {
      color: c.tint,
    },
    paymentScroll: {
      flexGrow: 0,
      maxHeight: 430,
    },
    paymentContent: {
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.sm,
      gap: Spacing.sm,
    },
    paymentCard: {
      backgroundColor: c.surface,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      padding: Spacing.md,
      gap: Spacing.sm,
    },
    paymentHeading: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    paymentHeadingCopy: {
      flex: 1,
      gap: 2,
    },
    paymentTitle: {
      ...Typography.bodySemibold,
      color: c.text,
    },
    paymentDetail: {
      ...Typography.caption,
      color: c.textSecondary,
    },
    outlineBtn: {
      borderWidth: 1,
      borderColor: c.tint,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 6,
    },
    outlineBtnText: {
      ...Typography.captionSemibold,
      color: c.tint,
    },
    autoPayNote: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.xs,
      paddingTop: Spacing.xs,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    accountContextLink: {
      minHeight: 52,
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      paddingTop: Spacing.md,
    },
    autoPayText: {
      ...Typography.caption,
      color: c.textSecondary,
      flex: 1,
    },
    paymentError: {
      ...Typography.caption,
      color: c.error,
    },
    allocationRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      paddingTop: Spacing.sm,
    },
    allocationInfo: {
      flex: 1,
      gap: 1,
    },
    allocationName: {
      ...Typography.bodyMedium,
      color: c.text,
    },
    amountEdit: {
      flexDirection: "row",
      alignItems: "center",
      width: 100,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.sm,
      backgroundColor: c.backgroundSolid,
    },
    currencyMark: {
      ...Typography.body,
      color: c.textSecondary,
    },
    amountInput: {
      ...Typography.body,
      color: c.text,
      flex: 1,
      paddingVertical: 7,
      paddingLeft: 2,
      textAlign: "right",
    },
    primaryBtn: {
      alignItems: "center",
      justifyContent: "center",
      borderRadius: Radius.sm,
      backgroundColor: c.tint,
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.md,
    },
    primaryBtnText: {
      ...Typography.bodySemibold,
      color: c.textInverse,
    },
    disabledBtn: {
      opacity: 0.45,
    },
    reviewBox: {
      gap: Spacing.sm,
      padding: Spacing.sm,
      borderRadius: Radius.sm,
      backgroundColor: c.tintLight,
    },
    reviewText: {
      ...Typography.bodyMedium,
      color: c.text,
    },
    reviewActions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: Spacing.sm,
    },
    cancelBtn: {
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.md,
    },
    cancelBtnText: {
      ...Typography.bodySemibold,
      color: c.textSecondary,
    },
    successNotice: {
      borderRadius: Radius.sm,
      padding: Spacing.sm,
      backgroundColor: c.tintLight,
    },
    failureNotice: {
      borderRadius: Radius.sm,
      padding: Spacing.sm,
      backgroundColor: c.errorLight,
    },
    noticeText: {
      ...Typography.captionMedium,
      color: c.text,
    },
    summaryCard: {
      flexDirection: "row",
      alignItems: "stretch",
      marginHorizontal: Spacing.lg,
      marginTop: Spacing.sm,
      marginBottom: Spacing.xs,
      backgroundColor: c.surface,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      overflow: "hidden",
    },
    summaryCol: {
      flex: 1,
      alignItems: "center",
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.xs,
      gap: 3,
    },
    summarySep: {
      width: StyleSheet.hairlineWidth,
      backgroundColor: c.border,
      alignSelf: "stretch",
    },
    summaryLabel: {
      ...Typography.caption,
      color: c.textTertiary,
      textAlign: "center" as const,
    },
    summaryValue: {
      ...Typography.bodySemibold,
      color: c.text,
      textAlign: "center" as const,
    },
    summaryValuePaid: {
      color: "#22c55e",
    },
    summaryValueDue: {
      color: c.tint,
    },
    filterScroll: {
      marginHorizontal: Spacing.lg,
      marginTop: Spacing.xs,
      marginBottom: Spacing.xs,
    },
    filterRow: {
      flexDirection: "row",
      gap: 0,
      borderRadius: Radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      overflow: "hidden",
      alignSelf: "flex-start",
    },
    filterBtn: {
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs,
      backgroundColor: c.surface,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: c.border,
    },
    filterBtnFirst: {
      borderLeftWidth: 0,
    },
    filterBtnLast: {},
    filterBtnActive: { backgroundColor: c.tint },
    filterText: { ...Typography.captionSemibold, color: c.textSecondary },
    filterTextActive: { color: "#fff" },
    sectionHeader: {
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.xs,
    },
    sectionLabel: {
      ...Typography.label,
      color: c.textTertiary,
      textTransform: "uppercase" as const,
    },
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    rowMain: { flex: 1, gap: 2 },
    rowRight: { alignItems: "flex-end", gap: Spacing.xs },
    rowName: { ...Typography.bodySemibold, color: c.text },
    rowMeta: { ...Typography.caption, color: c.textSecondary },
    rowAmount: { ...Typography.bodySemibold, color: c.text },
    listContent: { padding: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.sm },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: Spacing.xl,
      gap: Spacing.sm,
    },
    emptyTitle: { ...Typography.h3, color: c.text, textAlign: "center" },
    emptyBody: { ...Typography.body, color: c.textSecondary, textAlign: "center" },
    retryBtn: {
      marginTop: Spacing.sm,
      paddingHorizontal: Spacing.xl,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.full,
      backgroundColor: c.tint,
    },
    retryText: { ...Typography.bodySemibold, color: c.textInverse },
  });
}
