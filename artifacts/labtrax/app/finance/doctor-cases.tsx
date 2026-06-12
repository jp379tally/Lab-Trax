import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
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

type ListItem =
  | { kind: "sectionHeader"; label: string }
  | { kind: "case"; data: CaseEntry }
  | { kind: "invoice"; data: InvoiceEntry };

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

export default function DoctorCasesScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const params = useLocalSearchParams<{
    doctorName: string;
    providerOrganizationId?: string;
    practiceName?: string;
    initialViewMode?: string;
  }>();

  const doctorName = params.doctorName ?? "";
  const providerOrganizationId = params.providerOrganizationId ?? "";
  const practiceName = params.practiceName ?? "";

  const [viewMode, setViewMode] = useState<ViewMode>(
    params.initialViewMode === "all" ? "all" : "open",
  );
  const me = useMe().data;
  const labOrgId = primaryLabOrgId(me);

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
    const invoices = allInvoices.filter(
      (inv) => inv.caseId != null && doctorCaseIds.has(inv.caseId),
    );

    const result: ListItem[] = [];
    if (cases.length > 0) {
      result.push({ kind: "sectionHeader", label: `Cases (${cases.length})` });
      for (const c of cases) result.push({ kind: "case", data: c });
    }
    if (invoices.length > 0) {
      result.push({ kind: "sectionHeader", label: `Invoices (${invoices.length})` });
      for (const inv of invoices) result.push({ kind: "invoice", data: inv });
    }
    return result;
  }, [casesQuery.data, invoicesQuery.data]);

  const isLoading = casesQuery.isLoading || invoicesQuery.isLoading;
  const isError = casesQuery.isError || invoicesQuery.isError;
  const isFetching = casesQuery.isFetching || invoicesQuery.isFetching;
  const caseCount = casesQuery.data?.length ?? 0;

  const subtitle = isLoading
    ? "Loading…"
    : viewMode === "open"
    ? `${caseCount} open case${caseCount === 1 ? "" : "s"}`
    : `${caseCount} case${caseCount === 1 ? "" : "s"}`;

  function renderItem({ item }: { item: ListItem }) {
    if (item.kind === "sectionHeader") {
      return (
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionLabel}>{item.label}</Text>
        </View>
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
