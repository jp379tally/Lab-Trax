import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  FlatList,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Linking,
} from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Typography, Radius } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { StatusBadge, type BadgeVariant } from "@/components/ui/StatusBadge";
import { getJson } from "@/lib/read-api";
import { useMe, primaryLabOrgId } from "@/lib/auth-me";
import { formatDate, formatMoney, titleCase } from "@/lib/format";

type ViewMode = "open" | "all";
type InvoiceFilter = "all" | "open" | "paid" | "overdue" | "void";

interface CaseEntry {
  id: string;
  caseNumber: string;
  status: string;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  expectedDeliveryDate?: string | null;
  createdAt?: string | null;
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

type ListItem =
  | { kind: "sectionHeader"; label: string }
  | { kind: "case"; data: CaseEntry }
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
  if (s.includes("draft")) return "draft";
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
  const isDraft = s === "draft";

  if (filter === "paid") return isPaid;
  if (filter === "overdue") return isOverdue;
  if (filter === "void") return isVoid;
  // open = unpaid, not overdue, not void/cancelled, not draft, not paid
  if (filter === "open") return !isPaid && !isOverdue && !isVoid && !isDraft;
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

  const me = useMe().data;
  const labOrgId = primaryLabOrgId(me);

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

    const result: ListItem[] = [];
    if (cases.length > 0) {
      result.push({ kind: "sectionHeader", label: `Cases (${cases.length})` });
      for (const c of cases) result.push({ kind: "case", data: c });
    }
    if (scopedInvoices.length > 0) {
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
  const accountNum = orgData?.platformAccountNumber ?? orgData?.accountNumber ?? null;
  const formattedAddress = orgData ? formatAddress(orgData) : null;

  function renderItem({ item }: { item: ListItem }) {
    if (item.kind === "sectionHeader") {
      return (
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionLabel}>{item.label}</Text>
        </View>
      );
    }
    if (item.kind === "invoiceFilterRow") {
      return (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
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
        <Card style={styles.row} onPress={() => router.push(`/case/${c.id}` as never)}>
          <View style={styles.rowMain}>
            <Text style={styles.rowName} numberOfLines={1}>
              {patientName(c)}
            </Text>
            <Text style={styles.rowMeta} numberOfLines={1}>
              {c.caseNumber}
              {c.expectedDeliveryDate ? ` · Due ${formatDate(c.expectedDeliveryDate)}` : ""}
            </Text>
          </View>
          <StatusBadge label={titleCase(c.status ?? "—")} variant={statusVariant(c.status)} size="sm" />
        </Card>
      );
    }
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

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
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
            return `${item.kind}-${item.data.id}`;
          }}
          renderItem={renderItem}
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
