// Provider portal → Dashboard.
//
// The mobile mirror of the desktop ProviderDashboard: the provider's active
// cases, a dated panel for their completed ones, and a tap target on every row
// that opens the case. Desktop lays this out as a wide table; a phone gets a
// stacked card per case instead, but the field set, the copy, the empty/error
// states, and every formatted value are the desktop ones so the same case
// reads identically on both.
//
// Cases are loaded once for the whole portal and then served from cache, so
// the Dashboard is also where a provider asks for fresh ones: pulling the list
// down re-fetches it (desktop does the same from its portal shell). A refresh
// that fails leaves the cases already on screen alone — the provider is no
// worse off for having pulled.
//
// The one structural difference is where the case detail lives. Desktop opens
// ProviderCaseDetailModal over the dashboard; mobile already has the detail as
// its own route (app/case/provider/[id].tsx), so rows — and the notification
// deep-link the shell hands in as `caseId` — navigate there instead of opening
// a modal in place.
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { BorderWidth, Radius, Spacing, Typography } from "@/constants/tokens";
import { DateField } from "@/components/DateField";
import { useProviderCases, type ProviderCase } from "@/lib/provider-cases";
// Every formatted value on a case row comes from the package desktop's
// ProviderDashboard reads too, so the same case cannot render one way here and
// another way there. These rules deliberately differ from @/lib/format —
// titleCase also splits on hyphens and formatMoney renders 0 as "$0.00" — so
// this screen must not be "tidied up" onto the mobile formatters.
import {
  formatProviderBalance,
  formatProviderDueDate,
  providerPatientDisplayName,
  providerStatusLabel,
} from "@workspace/provider-case-format";

/** Local calendar day as "YYYY-MM-DD" — the completed panel's filter space. */
function toDateInputValue(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function openCaseDetail(caseId: string): void {
  router.push(`/case/provider/${encodeURIComponent(caseId)}` as never);
}

// ── Case row ────────────────────────────────────────────────────────────────

interface CaseRowProps {
  providerCase: ProviderCase;
  /** Lab name is only a column for providers linked to more than one lab. */
  multiLab: boolean;
  /** Completed rows carry the open balance; active rows carry the status. */
  variant: "active" | "completed";
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
  onPress: () => void;
  testID: string;
}

function CaseRow({
  providerCase: c,
  multiLab,
  variant,
  styles,
  colors,
  onPress,
  testID,
}: CaseRowProps) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.row}
      accessibilityRole="button"
      testID={testID}
    >
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.caseNumber} numberOfLines={1}>
            {c.caseNumber}
          </Text>
          {variant === "active" ? (
            <Text style={styles.statusPill} testID={`${testID}-status`}>
              {providerStatusLabel(c.status)}
            </Text>
          ) : (
            <Text style={styles.balance} testID={`${testID}-balance`}>
              {formatProviderBalance(c.openInvoiceAmount)}
            </Text>
          )}
        </View>

        <Text style={styles.patient} numberOfLines={1}>
          {providerPatientDisplayName(c)}
        </Text>

        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Restorations</Text>
          <Text style={styles.metaValue} numberOfLines={2}>
            {c.restorationTypes ?? "—"}
          </Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Due</Text>
          <Text style={styles.metaValue}>{formatProviderDueDate(c.dueDate)}</Text>
        </View>
        {multiLab ? (
          <View style={styles.metaRow} testID={`${testID}-lab`}>
            <Text style={styles.metaLabel}>Lab</Text>
            <Text style={styles.metaValue} numberOfLines={1}>
              {c.labName ?? "—"}
            </Text>
          </View>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
    </Pressable>
  );
}

// ── Completed cases panel ───────────────────────────────────────────────────

/**
 * The dated history panel, rendered as an in-tree overlay rather than a
 * <Modal> — the same choice ReturnedCaseWizard documents. Each DateField opens
 * its own native modal, and stacking one native modal inside another is
 * unreliable on iOS: the calendar can simply fail to appear, which would make
 * the panel's only filter unusable.
 */
function CompletedCasesPanel({
  completedCases,
  multiLab,
  onClose,
  onSelectCase,
}: {
  completedCases: ProviderCase[];
  multiLab: boolean;
  onClose: () => void;
  onSelectCase: (caseId: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  // Defaults to the month in progress, exactly as desktop does.
  const [fromDate, setFromDate] = useState(() =>
    toDateInputValue(new Date(new Date().getFullYear(), new Date().getMonth(), 1)),
  );
  const [toDate, setToDate] = useState(() => toDateInputValue(new Date()));

  const filtered = completedCases.filter((c) => {
    if (!c.dueDate) return true;
    const due = c.dueDate.slice(0, 10);
    return due >= fromDate && due <= toDate;
  });

  return (
    <Pressable
      style={styles.panelBackdrop}
      onPress={onClose}
      accessibilityLabel="Close completed cases"
    >
      {/* Swallows taps so pressing inside the panel does not close it. */}
      <Pressable style={styles.panel} onPress={() => undefined}>
        <View testID="provider-completed-panel">
          <View style={styles.panelHeader}>
            <View style={styles.panelHeading}>
              <Text style={styles.panelTitle}>Your Completed Cases</Text>
              <Text style={styles.panelSubtitle}>
                Completed cases assigned to your account
              </Text>
            </View>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={styles.panelClose}
              testID="provider-completed-close"
            >
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </Pressable>
          </View>

          <View style={styles.filterBar}>
            <Text style={styles.filterHeading}>Date range</Text>
            <View style={styles.filterFields}>
              <View style={styles.filterField}>
                <Text style={styles.filterLabel}>From</Text>
                <DateField
                  value={fromDate}
                  onChange={setFromDate}
                  title="From date"
                  maxDate={toDate || undefined}
                  testID="provider-completed-from"
                />
              </View>
              <View style={styles.filterField}>
                <Text style={styles.filterLabel}>To</Text>
                <DateField
                  value={toDate}
                  onChange={setToDate}
                  title="To date"
                  minDate={fromDate || undefined}
                  testID="provider-completed-to"
                />
              </View>
            </View>
            <Text style={styles.matchCount} testID="provider-completed-count">
              {filtered.length} {filtered.length === 1 ? "case" : "cases"}
            </Text>
          </View>

          {filtered.length === 0 ? (
            <View style={styles.panelEmpty} testID="provider-completed-empty">
              <Text style={styles.emptyTitle}>
                No completed cases in this date range
              </Text>
              <Text style={styles.emptyBody}>
                Try expanding the date range to see earlier completed cases.
              </Text>
            </View>
          ) : (
            <ScrollView
              style={styles.panelList}
              contentContainerStyle={styles.panelListContent}
            >
              {filtered.map((c) => (
                <CaseRow
                  key={c.id}
                  providerCase={c}
                  multiLab={multiLab}
                  variant="completed"
                  styles={styles}
                  colors={colors}
                  onPress={() => onSelectCase(c.id)}
                  testID={`provider-completed-row-${c.id}`}
                />
              ))}
            </ScrollView>
          )}
        </View>
      </Pressable>
    </Pressable>
  );
}

// ── Section ─────────────────────────────────────────────────────────────────

export interface ProviderDashboardSectionProps {
  /** Case whose detail should be showing, set by a notification deep-link. */
  caseId?: string | null;
  onClearCaseId?: () => void;
}

export function ProviderDashboardSection({
  caseId,
  onClearCaseId,
}: ProviderDashboardSectionProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { cases, error, isRefreshing, refetch } = useProviderCases();
  const [showCompleted, setShowCompleted] = useState(false);

  // Tapping a completed row navigates away, so the panel has to come down
  // first: a React Native Modal belongs to the whole app, not to this screen,
  // and would otherwise stay on top of the case detail the push just opened.
  function openCaseFromCompleted(caseId: string): void {
    setShowCompleted(false);
    openCaseDetail(caseId);
  }

  // A notification deep-link opens the case straight away. The id is cleared
  // as soon as it is consumed so returning to the portal does not bounce the
  // provider back into the same case. The ref makes consuming it idempotent:
  // the shell hands `onClearCaseId` down as a fresh closure on every render,
  // so the effect can re-run before the cleared id has propagated back. It is
  // released again the moment the id clears, so tapping the same notification
  // a second time still opens the case.
  const consumedCaseId = useRef<string | null>(null);
  useEffect(() => {
    if (!caseId) {
      consumedCaseId.current = null;
      return;
    }
    if (consumedCaseId.current === caseId) return;
    consumedCaseId.current = caseId;
    openCaseDetail(caseId);
    onClearCaseId?.();
  }, [caseId, onClearCaseId]);

  const labNames = cases
    ? Array.from(new Set(cases.map((c) => c.labName).filter(Boolean)))
    : [];
  const multiLab = labNames.length > 1;

  const completedCases = cases ? cases.filter((c) => c.status === "complete") : [];
  const activeCases = cases ? cases.filter((c) => c.status !== "complete") : null;

  function renderList() {
    if (activeCases === null || activeCases.length === 0) {
      return (
        <Text style={styles.empty} testID="provider-dashboard-empty">
          {cases !== null && cases.length === 0
            ? "You have no assigned cases yet."
            : "No active cases. Check completed cases for your history."}
        </Text>
      );
    }
    return (
      <View style={styles.list}>
        {activeCases.map((c) => (
          <CaseRow
            key={c.id}
            providerCase={c}
            multiLab={multiLab}
            variant="active"
            styles={styles}
            colors={colors}
            onPress={() => openCaseDetail(c.id)}
            testID={`provider-case-row-${c.id}`}
          />
        ))}
      </View>
    );
  }

  function renderBody() {
    // A load that has never succeeded has nothing to show but the failure —
    // the desktop dashboard's error state.
    if (error && cases === null) {
      return (
        <View
          style={styles.errorBox}
          accessibilityRole="alert"
          testID="provider-dashboard-error"
        >
          <Text style={styles.errorText}>{error}</Text>
        </View>
      );
    }
    if (cases === null) {
      return (
        <Text style={styles.loading} testID="provider-dashboard-loading">
          Loading cases…
        </Text>
      );
    }
    return (
      <>
        {/* A pull-to-refresh that fails keeps the cases already on screen:
            the provider loses nothing by pulling, and the failure is still
            said out loud rather than passing as a successful refresh. */}
        {error ? (
          <View
            style={styles.errorBox}
            accessibilityRole="alert"
            testID="provider-dashboard-refresh-error"
          >
            <Text style={styles.errorText}>
              Could not refresh your cases. Showing the ones last loaded.
            </Text>
            <Text style={styles.errorDetail}>{error}</Text>
          </View>
        ) : null}
        {renderList()}
      </>
    );
  }

  return (
    <View style={styles.root} testID="provider-portal-section-dashboard">
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        testID="provider-dashboard-scroll"
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={refetch}
            tintColor={colors.tint}
          />
        }
      >
        <View style={styles.heading}>
          <Text style={styles.title}>Your Active Cases</Text>
          <Text style={styles.subtitle}>
            All active cases assigned to your account
          </Text>
        </View>

        {cases !== null && completedCases.length > 0 ? (
          <Pressable
            onPress={() => setShowCompleted(true)}
            style={styles.completedEntry}
            accessibilityRole="button"
            testID="provider-dashboard-view-completed"
          >
            <Text style={styles.completedEntryLabel}>View completed cases</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.tint} />
          </Pressable>
        ) : null}

        {renderBody()}
      </ScrollView>

      {showCompleted ? (
        <CompletedCasesPanel
          completedCases={completedCases}
          multiLab={multiLab}
          onClose={() => setShowCompleted(false)}
          onSelectCase={openCaseFromCompleted}
        />
      ) : null}
    </View>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root: { flex: 1 },
    scroll: { flex: 1 },
    content: { padding: Spacing.lg, gap: Spacing.md },
    heading: { gap: 2 },
    title: { ...Typography.h2, color: colors.text },
    subtitle: { ...Typography.caption, color: colors.textSecondary },

    completedEntry: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.md,
      borderRadius: Radius.md,
      borderWidth: BorderWidth.section,
      borderColor: colors.sectionBorder,
      backgroundColor: colors.surface,
    },
    completedEntryLabel: { ...Typography.bodyMedium, color: colors.tint },

    loading: { ...Typography.body, color: colors.textSecondary },
    empty: {
      ...Typography.body,
      color: colors.textSecondary,
      textAlign: "center",
      paddingVertical: Spacing.xxl,
    },
    errorBox: {
      gap: Spacing.xs,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.error,
      backgroundColor: colors.surface,
      padding: Spacing.md,
    },
    errorText: { ...Typography.body, color: colors.error },
    errorDetail: { ...Typography.caption, color: colors.textSecondary },

    list: { gap: Spacing.sm },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      padding: Spacing.md,
      borderRadius: Radius.md,
      borderWidth: BorderWidth.section,
      borderColor: colors.sectionBorder,
      backgroundColor: colors.surface,
    },
    rowBody: { flex: 1, gap: Spacing.xs },
    rowTop: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: Spacing.sm,
    },
    caseNumber: { ...Typography.captionSemibold, color: colors.textSecondary },
    statusPill: {
      ...Typography.captionMedium,
      color: colors.tintDark,
      backgroundColor: colors.tintLight,
      borderRadius: Radius.full,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 2,
      overflow: "hidden",
    },
    balance: { ...Typography.bodySemibold, color: colors.text },
    patient: { ...Typography.bodyLgMedium, color: colors.text },
    metaRow: { flexDirection: "row", alignItems: "flex-start", gap: Spacing.sm },
    metaLabel: { ...Typography.caption, color: colors.textTertiary, width: 88 },
    metaValue: { ...Typography.caption, color: colors.textSecondary, flex: 1 },

    // An in-tree overlay, so it needs to claim the section's whole area and
    // sit above the list a <Modal> would otherwise have covered for free.
    panelBackdrop: {
      ...StyleSheet.absoluteFillObject,
      justifyContent: "flex-end",
      backgroundColor: "rgba(0,0,0,0.4)",
      zIndex: 10,
      elevation: 10,
    },
    panel: {
      maxHeight: "88%",
      backgroundColor: colors.backgroundSolid,
      borderTopLeftRadius: Radius.lg,
      borderTopRightRadius: Radius.lg,
    },
    panelHeader: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.sm,
      padding: Spacing.lg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    panelHeading: { flex: 1, gap: 2 },
    panelTitle: { ...Typography.h3, color: colors.text },
    panelSubtitle: { ...Typography.caption, color: colors.textSecondary },
    panelClose: { padding: Spacing.xs },

    filterBar: {
      gap: Spacing.sm,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      backgroundColor: colors.surfaceAlt,
    },
    filterHeading: {
      ...Typography.label,
      color: colors.textSecondary,
      textTransform: "uppercase",
    },
    filterFields: { flexDirection: "row", gap: Spacing.sm },
    filterField: { flex: 1, gap: Spacing.xs },
    filterLabel: { ...Typography.caption, color: colors.textSecondary },
    matchCount: { ...Typography.caption, color: colors.textSecondary, textAlign: "right" },

    panelList: { flexGrow: 0 },
    panelListContent: { padding: Spacing.lg, gap: Spacing.sm },
    panelEmpty: {
      alignItems: "center",
      gap: Spacing.xs,
      paddingVertical: Spacing.huge,
      paddingHorizontal: Spacing.lg,
    },
    emptyTitle: {
      ...Typography.bodyMedium,
      color: colors.textSecondary,
      textAlign: "center",
    },
    emptyBody: {
      ...Typography.caption,
      color: colors.textTertiary,
      textAlign: "center",
    },
  });
}
