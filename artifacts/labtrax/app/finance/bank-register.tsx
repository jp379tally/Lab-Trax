import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  TextInput,
  ScrollView,
  Pressable,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { getJson, isForbiddenError } from "@/lib/read-api";
import { useMe, primaryLabOrgId } from "@/lib/auth-me";
import { toNumber, formatMoney, formatDate } from "@/lib/format";

interface BankAccount {
  id: string;
  name: string;
  institution?: string | null;
  last4?: string | null;
  isArchived?: boolean | null;
  bookBalance?: string | number | null;
  clearedBalance?: string | number | null;
  unreconciledBalance?: string | number | null;
}

interface TransactionCategory {
  id: string;
  name: string;
  kind: string;
}

interface BankTransaction {
  id: string;
  txnDate?: string | null;
  type?: string | null;
  checkNumber?: string | null;
  payee?: string | null;
  memo?: string | null;
  categoryId?: string | null;
  debitAmount?: string | number | null;
  creditAmount?: string | number | null;
  netAmount?: string | number | null;
  cleared?: boolean | null;
  reconciled?: boolean | null;
  status?: string | null;
  runningBalance?: string | number | null;
}

const STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "posted", label: "Posted" },
  { key: "projected", label: "Projected" },
  { key: "uncleared", label: "Uncleared" },
  { key: "unreconciled", label: "Unreconciled" },
  { key: "void", label: "Voided" },
] as const;

type StatusFilterKey = (typeof STATUS_FILTERS)[number]["key"];

interface Section {
  title: string;
  data: BankTransaction[];
}

function groupByDate(txns: BankTransaction[]): Section[] {
  const map = new Map<string, BankTransaction[]>();
  for (const t of txns) {
    const key = (t.txnDate ?? "").slice(0, 10) || "Unknown";
    const arr = map.get(key);
    if (arr) arr.push(t);
    else map.set(key, [t]);
  }
  return Array.from(map.entries()).map(([date, data]) => ({
    title: date === "Unknown" ? "Unknown Date" : formatDate(date),
    data,
  }));
}

function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

export default function BankRegisterScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const labOrgId = primaryLabOrgId(useMe().data);

  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilterKey>("all");

  const accountsQuery = useQuery<BankAccount[]>({
    queryKey: ["finance-accounts", labOrgId ?? ""],
    enabled: !!labOrgId,
    staleTime: 60_000,
    queryFn: () =>
      getJson<BankAccount[]>(
        `/api/finance/accounts?organizationId=${encodeURIComponent(labOrgId!)}`
      ),
  });

  const accounts = useMemo(
    () => (accountsQuery.data ?? []).filter((a) => !a.isArchived),
    [accountsQuery.data]
  );

  const effectiveAccountId = useMemo(() => {
    if (selectedAccountId && accounts.find((a) => a.id === selectedAccountId))
      return selectedAccountId;
    return accounts[0]?.id ?? null;
  }, [selectedAccountId, accounts]);

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === effectiveAccountId) ?? null,
    [accounts, effectiveAccountId]
  );

  const catsQuery = useQuery<TransactionCategory[]>({
    queryKey: ["finance-categories", labOrgId ?? ""],
    enabled: !!labOrgId,
    staleTime: 120_000,
    queryFn: () =>
      getJson<TransactionCategory[]>(
        `/api/finance/categories?organizationId=${encodeURIComponent(labOrgId!)}`
      ),
  });

  const catNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of catsQuery.data ?? []) m.set(c.id, c.name);
    return m;
  }, [catsQuery.data]);

  const txnParams = useMemo(() => {
    if (!labOrgId || !effectiveAccountId) return null;
    const p = new URLSearchParams({
      organizationId: labOrgId,
      bankAccountId: effectiveAccountId,
    });
    if (search.trim()) p.set("search", search.trim());
    if (statusFilter !== "all") p.set("status", statusFilter);
    return p.toString();
  }, [labOrgId, effectiveAccountId, search, statusFilter]);

  const txnsQuery = useQuery<BankTransaction[]>({
    queryKey: ["bank-transactions", txnParams ?? ""],
    enabled: !!txnParams,
    staleTime: 30_000,
    queryFn: () =>
      getJson<BankTransaction[]>(`/api/finance/transactions?${txnParams}`),
  });

  const sections = useMemo(
    () => groupByDate(txnsQuery.data ?? []),
    [txnsQuery.data]
  );

  if (!labOrgId) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <ScreenHeader />
        <View style={styles.center}>
          <Ionicons name="swap-horizontal-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>No lab selected</Text>
          <Text style={styles.emptyBody}>
            The bank register is scoped to a lab. This view is available to lab members.
          </Text>
        </View>
      </View>
    );
  }

  if (accountsQuery.isError) {
    const accountsForbidden = isForbiddenError(accountsQuery.error);
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <ScreenHeader />
        <View style={styles.center}>
          {accountsForbidden ? (
            <>
              <Ionicons name="lock-closed-outline" size={40} color={colors.textTertiary} />
              <Text style={styles.emptyTitle}>Not available</Text>
              <Text style={styles.emptyBody}>
                You don't have permission to view bank accounts for this lab.
              </Text>
            </>
          ) : (
            <>
              <Ionicons name="cloud-offline-outline" size={40} color={colors.textTertiary} />
              <Text style={styles.emptyTitle}>Couldn't load accounts</Text>
              <Pressable
                style={styles.retryBtn}
                onPress={() => accountsQuery.refetch()}
              >
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    );
  }

  const isLoading = accountsQuery.isLoading || txnsQuery.isLoading;
  const isError = txnsQuery.isError;
  const isForbidden = isError && isForbiddenError(txnsQuery.error);

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <ScreenHeader />

      <SectionList<BankTransaction, Section>
        sections={sections}
        keyExtractor={(t) => t.id}
        stickySectionHeadersEnabled
        refreshControl={
          <RefreshControl
            refreshing={txnsQuery.isFetching && !txnsQuery.isLoading}
            onRefresh={() => txnsQuery.refetch()}
            tintColor={colors.tint}
          />
        }
        ListHeaderComponent={
          <ListHeader
            colors={colors}
            styles={styles}
            accounts={accounts}
            selectedAccount={selectedAccount}
            effectiveAccountId={effectiveAccountId}
            onSelectAccount={setSelectedAccountId}
            search={search}
            onSearchChange={setSearch}
            statusFilter={statusFilter}
            onStatusChange={setStatusFilter}
            isLoading={isLoading}
          />
        }
        renderSectionHeader={({ section }) => (
          <View style={styles.dateHeader}>
            <Text style={styles.dateHeaderText}>{section.title.toUpperCase()}</Text>
          </View>
        )}
        renderItem={({ item: t }) => (
          <TxnRow
            t={t}
            catNameById={catNameById}
            colors={colors}
            styles={styles}
          />
        )}
        ListEmptyComponent={
          isLoading ? (
            <View style={styles.center}>
              <ActivityIndicator size="large" color={colors.tint} />
            </View>
          ) : isError ? (
            <View style={styles.center}>
              {isForbidden ? (
                <>
                  <Ionicons name="lock-closed-outline" size={40} color={colors.textTertiary} />
                  <Text style={styles.emptyTitle}>Not available</Text>
                  <Text style={styles.emptyBody}>
                    You don't have access to the register for your current role.
                  </Text>
                </>
              ) : (
                <>
                  <Ionicons name="cloud-offline-outline" size={40} color={colors.textTertiary} />
                  <Text style={styles.emptyTitle}>Couldn't load transactions</Text>
                  <Pressable
                    style={styles.retryBtn}
                    onPress={() => txnsQuery.refetch()}
                  >
                    <Text style={styles.retryText}>Try again</Text>
                  </Pressable>
                </>
              )}
            </View>
          ) : !accountsQuery.isLoading && !effectiveAccountId ? (
            <View style={styles.center}>
              <Ionicons name="wallet-outline" size={40} color={colors.textTertiary} />
              <Text style={styles.emptyTitle}>No accounts yet</Text>
              <Text style={styles.emptyBody}>
                Add a bank account to start tracking transactions.
              </Text>
            </View>
          ) : (
            <View style={styles.center}>
              <Ionicons name="swap-horizontal-outline" size={40} color={colors.textTertiary} />
              <Text style={styles.emptyTitle}>No transactions</Text>
              <Text style={styles.emptyBody}>
                {search || statusFilter !== "all"
                  ? "No transactions match the current filters."
                  : "Transactions will appear here once entries are added."}
              </Text>
            </View>
          )
        }
        contentContainerStyle={styles.listContent}
      />
    </View>
  );
}

function ScreenHeader() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.header}>
      <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
        <Ionicons name="chevron-back" size={26} color={colors.text} />
      </Pressable>
      <Text style={styles.title}>Bank Register</Text>
    </View>
  );
}

interface ListHeaderProps {
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  accounts: BankAccount[];
  selectedAccount: BankAccount | null;
  effectiveAccountId: string | null;
  onSelectAccount: (id: string) => void;
  search: string;
  onSearchChange: (s: string) => void;
  statusFilter: StatusFilterKey;
  onStatusChange: (s: StatusFilterKey) => void;
  isLoading: boolean;
}

function ListHeader({
  colors,
  styles,
  accounts,
  selectedAccount,
  effectiveAccountId,
  onSelectAccount,
  search,
  onSearchChange,
  statusFilter,
  onStatusChange,
  isLoading,
}: ListHeaderProps) {
  const bookBalance = toNumber(selectedAccount?.bookBalance);
  const clearedBalance = toNumber(selectedAccount?.clearedBalance);
  const unclearedBalance = bookBalance - clearedBalance;
  const unreconciledBalance = toNumber(selectedAccount?.unreconciledBalance);

  return (
    <View>
      {accounts.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.accountPicker}
        >
          {accounts.map((a) => {
            const active = a.id === effectiveAccountId;
            return (
              <Pressable
                key={a.id}
                onPress={() => onSelectAccount(a.id)}
                style={[styles.accountPill, active && styles.accountPillActive]}
              >
                <Text
                  style={[styles.accountPillText, active && styles.accountPillTextActive]}
                  numberOfLines={1}
                >
                  {a.name}
                  {a.last4 ? ` ··${a.last4}` : ""}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      {selectedAccount && (
        <View style={styles.balanceGrid}>
          <BalanceCard
            label="Book balance"
            value={bookBalance}
            color={colors.text}
            bg={colors.surface}
            styles={styles}
          />
          <BalanceCard
            label="Cleared"
            value={clearedBalance}
            color={colors.info}
            bg={colors.infoSurface}
            styles={styles}
          />
          <BalanceCard
            label="Uncleared"
            value={unclearedBalance}
            color={colors.warning}
            bg={colors.warningSurface}
            styles={styles}
          />
          <BalanceCard
            label="Unreconciled"
            value={unreconciledBalance}
            color={colors.orange}
            bg={colors.orangeLight}
            styles={styles}
          />
        </View>
      )}

      <View style={styles.searchRow}>
        <View style={styles.searchWrap}>
          <Ionicons
            name="search-outline"
            size={15}
            color={colors.textTertiary}
            style={styles.searchIcon}
          />
          <TextInput
            value={search}
            onChangeText={onSearchChange}
            placeholder="Search payee, memo, check #…"
            placeholderTextColor={colors.textTertiary}
            style={styles.searchInput}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterRow}
      >
        {STATUS_FILTERS.map((f) => {
          const active = f.key === statusFilter;
          return (
            <Pressable
              key={f.key}
              onPress={() => onStatusChange(f.key)}
              style={[styles.filterChip, active && styles.filterChipActive]}
            >
              <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                {f.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {isLoading && (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={colors.tint} />
          <Text style={styles.loadingText}>Loading…</Text>
        </View>
      )}
    </View>
  );
}

interface BalanceCardProps {
  label: string;
  value: number;
  color: string;
  bg: string;
  styles: ReturnType<typeof makeStyles>;
}

function BalanceCard({ label, value, color, bg, styles }: BalanceCardProps) {
  return (
    <View style={[styles.balanceCard, { backgroundColor: bg }]}>
      <Text style={[styles.balanceLabel, { color }]}>{label}</Text>
      <Text style={[styles.balanceValue, { color }]}>{formatMoney(value)}</Text>
    </View>
  );
}

interface TxnRowProps {
  t: BankTransaction;
  catNameById: Map<string, string>;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
}

function TxnRow({ t, catNameById, colors, styles }: TxnRowProps) {
  const credit = toNumber(t.creditAmount);
  const debit = toNumber(t.debitAmount);
  const isVoid = (t.status ?? "").toLowerCase() === "void";
  const isProjected = (t.status ?? "").toLowerCase() === "projected";
  const catName = t.categoryId ? catNameById.get(t.categoryId) : null;
  const typeLabel = t.type ? titleCase(t.type) : null;

  const rowMod = isVoid ? styles.rowVoid : isProjected ? styles.rowProjected : undefined;

  return (
    <View style={styles.txnRow}>
      <View style={styles.txnLeft}>
        {typeLabel && (
          <View style={styles.typeBadge}>
            <Text style={styles.typeBadgeText}>{typeLabel.toUpperCase()}</Text>
          </View>
        )}
        <Text
          style={[styles.payeeText, rowMod]}
          numberOfLines={1}
        >
          {t.payee || t.memo || "—"}
        </Text>
        {catName ? (
          <Text style={[styles.metaText, rowMod]} numberOfLines={1}>
            {catName}
          </Text>
        ) : null}
        {t.memo && t.payee ? (
          <Text style={[styles.metaText, rowMod]} numberOfLines={1}>
            {t.memo}
          </Text>
        ) : null}
        {t.checkNumber ? (
          <Text style={[styles.checkText, rowMod]} numberOfLines={1}>
            #{t.checkNumber}
          </Text>
        ) : null}
        <View style={styles.chipRow}>
          {t.cleared ? (
            <View style={[styles.chip, { backgroundColor: colors.successLight }]}>
              <Text style={[styles.chipText, { color: colors.successStrong }]}>✓ Clr</Text>
            </View>
          ) : null}
          {t.reconciled ? (
            <View style={[styles.chip, { backgroundColor: colors.infoLight }]}>
              <Text style={[styles.chipText, { color: colors.infoStrong }]}>✓ Rec</Text>
            </View>
          ) : null}
          {isVoid ? (
            <View style={[styles.chip, { backgroundColor: colors.surfaceAlt }]}>
              <Text style={[styles.chipText, { color: colors.textSecondary }]}>VOID</Text>
            </View>
          ) : null}
          {isProjected ? (
            <View style={[styles.chip, { backgroundColor: colors.surfaceAlt }]}>
              <Text style={[styles.chipText, { color: colors.textSecondary }]}>PROJ</Text>
            </View>
          ) : null}
        </View>
      </View>

      <View style={styles.txnRight}>
        {credit > 0 ? (
          <Text style={[styles.creditAmount, rowMod]}>{formatMoney(credit)}</Text>
        ) : debit > 0 ? (
          <Text style={[styles.debitAmount, rowMod]}>−{formatMoney(debit)}</Text>
        ) : (
          <Text style={[styles.zeroAmount, rowMod]}>{formatMoney(0)}</Text>
        )}
        {t.runningBalance != null ? (
          <Text style={[styles.runningBalance, rowMod]}>{formatMoney(t.runningBalance)}</Text>
        ) : null}
      </View>
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
    backBtn: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
    },
    title: { ...Typography.h1, color: c.text, flex: 1 },

    listContent: { paddingBottom: Spacing.xxxl },

    accountPicker: {
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      gap: Spacing.sm,
    },
    accountPill: {
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.full,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
    },
    accountPillActive: {
      backgroundColor: c.tint,
      borderColor: c.tint,
    },
    accountPillText: { ...Typography.captionSemibold, color: c.textSecondary },
    accountPillTextActive: { color: c.textInverse },

    balanceGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      paddingHorizontal: Spacing.lg,
      paddingBottom: Spacing.sm,
      gap: Spacing.sm,
    },
    balanceCard: {
      flex: 1,
      minWidth: "45%",
      borderRadius: Radius.md,
      padding: Spacing.lg,
      gap: 4,
    },
    balanceLabel: { ...Typography.captionMedium },
    balanceValue: { ...Typography.h3 },

    searchRow: {
      paddingHorizontal: Spacing.lg,
      paddingBottom: Spacing.sm,
    },
    searchWrap: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.surfaceAlt,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: Spacing.md,
      height: 40,
    },
    searchIcon: { marginRight: Spacing.xs },
    searchInput: {
      flex: 1,
      ...Typography.body,
      color: c.text,
    },

    filterRow: {
      paddingHorizontal: Spacing.lg,
      paddingBottom: Spacing.md,
      gap: Spacing.sm,
    },
    filterChip: {
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.xs + 2,
      borderRadius: Radius.full,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
    },
    filterChipActive: {
      backgroundColor: c.tintLight,
      borderColor: c.tint,
    },
    filterChipText: { ...Typography.captionSemibold, color: c.textSecondary },
    filterChipTextActive: { color: c.tint },

    loadingRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      paddingVertical: Spacing.sm,
    },
    loadingText: { ...Typography.caption, color: c.textSecondary },

    dateHeader: {
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.xs + 2,
      backgroundColor: c.backgroundSolid,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    dateHeaderText: {
      ...Typography.label,
      color: c.textSecondary,
    },

    txnRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      backgroundColor: c.backgroundSolid,
      gap: Spacing.md,
    },
    txnLeft: { flex: 1, gap: 3 },
    txnRight: {
      alignItems: "flex-end",
      gap: 4,
      minWidth: 80,
    },

    typeBadge: {
      alignSelf: "flex-start",
      backgroundColor: c.surfaceAlt,
      borderRadius: Radius.xs,
      paddingHorizontal: Spacing.xs + 2,
      paddingVertical: 2,
      marginBottom: 2,
    },
    typeBadgeText: {
      fontSize: 9,
      fontFamily: "Inter_600SemiBold",
      letterSpacing: 0.5,
      color: c.textTertiary,
    },

    payeeText: { ...Typography.bodySemibold, color: c.text },
    metaText: { ...Typography.caption, color: c.textSecondary },
    checkText: {
      fontSize: 11,
      fontFamily: "Inter_400Regular",
      color: c.textTertiary,
    },

    rowVoid: {
      color: c.textTertiary,
      textDecorationLine: "line-through",
    } as any,
    rowProjected: {
      color: c.textSecondary,
      fontStyle: "italic",
    } as any,

    chipRow: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.xs, marginTop: 2 },
    chip: {
      paddingHorizontal: Spacing.xs + 2,
      paddingVertical: 2,
      borderRadius: Radius.xs,
    },
    chipText: {
      fontSize: 9,
      fontFamily: "Inter_600SemiBold",
      letterSpacing: 0.4,
    },

    creditAmount: {
      ...Typography.bodySemibold,
      color: c.success,
      textAlign: "right",
    },
    debitAmount: {
      ...Typography.bodySemibold,
      color: c.error,
      textAlign: "right",
    },
    zeroAmount: {
      ...Typography.bodySemibold,
      color: c.textSecondary,
      textAlign: "right",
    },
    runningBalance: {
      ...Typography.caption,
      color: c.textSecondary,
      textAlign: "right",
    },

    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: Spacing.xl,
      gap: Spacing.sm,
      minHeight: 280,
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
