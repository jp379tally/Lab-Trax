import React, { useEffect, useMemo, useRef, useState } from "react";
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
  Modal,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  TouchableOpacity,
} from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { DismissKeyboardView, scrollKeyboardDismissMode } from "@/components/ui/DismissKeyboardView";
import { getJson, sendJson, isForbiddenError } from "@/lib/read-api";
import { useMe, primaryLabOrgId, adminLabMemberships } from "@/lib/auth-me";
import { toNumber, formatMoney, formatDate } from "@/lib/format";
import { resilientFetch, getApiUrl, getAccessToken, getCsrfToken } from "@/lib/query-client";
import { RegisterWebHeader, type RegisterWebFilters } from "@/components/register-analytics/RegisterWebHeader";

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

const EMPTY_WEB_FILTERS: RegisterWebFilters = { categoryId: "", dateFrom: "", dateTo: "", amountMin: "", amountMax: "" };
type RegisterPage = { rows: BankTransaction[]; total: number; hasMore: boolean; nextCursor?: string | null };

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
  const meData = useMe().data;
  const labOrgId = primaryLabOrgId(meData);
  const qc = useQueryClient();
  const canImport = adminLabMemberships(meData).length > 0;

  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilterKey>("all");
  const [showImport, setShowImport] = useState(false);
  const web = Platform.OS === "web";
  const [webFilters, setWebFilters] = useState<RegisterWebFilters>(EMPTY_WEB_FILTERS);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ key: string; rows: BankTransaction[]; total: number }>({ key: "", rows: [], total: 0 });

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
    if (web) {
      p.set("limit", "30");
      if (webFilters.categoryId) p.set("categoryId", webFilters.categoryId);
      if (webFilters.dateFrom) p.set("dateFrom", `${webFilters.dateFrom}T00:00:00.000Z`);
      if (webFilters.dateTo) p.set("dateTo", `${webFilters.dateTo}T23:59:59.999Z`);
      if (webFilters.amountMin !== "") p.set("amountMin", webFilters.amountMin);
      if (webFilters.amountMax !== "") p.set("amountMax", webFilters.amountMax);
    }
    return p.toString();
  }, [labOrgId, effectiveAccountId, search, statusFilter, web, webFilters]);

  const [queryIdentity, setQueryIdentity] = useState(txnParams);
  if (queryIdentity !== txnParams) {
    setQueryIdentity(txnParams);
    setCursor(null);
  }
  const requestParams = txnParams && cursor && web ? `${txnParams}&cursor=${encodeURIComponent(cursor)}` : txnParams;
  // Existing finance writers invalidate this prefix. Restart the web cursor at
  // the head before those refetches so stale accumulated rows cannot survive.
  useEffect(() => {
    if (!web) return;
    return qc.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "invalidate" &&
          event.query.queryKey[0] === "bank-transactions") setCursor(null);
    });
  }, [qc, web]);
  const txnsQuery = useQuery({
    queryKey: ["bank-transactions", requestParams ?? ""],
    enabled: !!txnParams,
    staleTime: 30_000,
    queryFn: async () => {
      const response = await getJson<BankTransaction[] | RegisterPage>(`/api/finance/transactions?${requestParams}`);
      const page = Array.isArray(response) ? { rows: response, total: response.length, hasMore: false, nextCursor: null } : response;
      return { ...page, identity: txnParams, cursor, requestParams };
    },
  });
  useEffect(() => {
    const page = txnsQuery.data;
    if (!web || !page || page.requestParams !== requestParams) return;
    setLoaded((previous) => ({
      key: page.identity ?? "",
      rows: previous.key === page.identity && page.cursor
        ? [...new Map([...previous.rows, ...page.rows].map((row) => [row.id, row])).values()]
        : page.rows,
      total: page.total,
    }));
  }, [web, txnsQuery.data, requestParams]);
  const transactions = web ? loaded.key === txnParams ? loaded.rows : [] : txnsQuery.data?.rows ?? [];
  const sections = useMemo(
    () => groupByDate(transactions),
    [transactions]
  );
  function refreshWeb() {
    setCursor(null);
    void qc.invalidateQueries({ queryKey: ["bank-transactions"] });
    void qc.invalidateQueries({ queryKey: ["finance-accounts"] });
  }

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
    <DismissKeyboardView
      style={[styles.screen, { paddingTop: web ? Math.max(67, insets.top) : insets.top }, web && { backgroundColor: "#f1f7fc" }]}
      testID="bank-register-keyboard-dismiss"
    >
      <ScreenHeader />

      <SectionList<BankTransaction, Section>
        sections={sections}
        keyExtractor={(t) => t.id}
        stickySectionHeadersEnabled
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={scrollKeyboardDismissMode}
        refreshControl={
          <RefreshControl
            refreshing={txnsQuery.isFetching && !txnsQuery.isLoading}
            onRefresh={() => web ? refreshWeb() : txnsQuery.refetch()}
            tintColor={colors.tint}
          />
        }
        ListHeaderComponent={
          web ? <RegisterWebHeader
            organizationId={labOrgId}
            accounts={accounts}
            accountId={effectiveAccountId}
            onSelectAccount={setSelectedAccountId}
            search={search}
            onSearchChange={setSearch}
            status={statusFilter}
            onStatusChange={(value) => setStatusFilter(value as StatusFilterKey)}
            categories={catsQuery.data ?? []}
            filters={webFilters}
            onFiltersChange={setWebFilters}
            onReset={() => { setSearch(""); setStatusFilter("all"); setWebFilters(EMPTY_WEB_FILTERS); }}
            canImport={canImport}
            onImport={() => setShowImport(true)}
            onRefresh={refreshWeb}
          /> : <ListHeader
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
            canImport={canImport}
            onImportFromStatement={() => setShowImport(true)}
          />
        }
        ListFooterComponent={web && transactions.length > 0 ? (
          <View style={{ padding: 16, gap: 8 }}>
            <Text style={{ color: colors.textSecondary }}>Showing {transactions.length} of {loaded.total} entries</Text>
            {txnsQuery.isFetching && <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <ActivityIndicator size="small" color={colors.tint} />
              <Text style={{ color: colors.textSecondary }}>{cursor ? "Loading more entries…" : "Refreshing entries…"}</Text>
            </View>}
            {txnsQuery.isError && <Text style={{ color: colors.error }}>Couldn’t refresh register. Previously loaded entries are shown.</Text>}
            {txnsQuery.isError && <Pressable onPress={() => txnsQuery.refetch()} accessibilityRole="button"><Text style={{ color: colors.tint, padding: 12 }}>Retry</Text></Pressable>}
            {txnsQuery.data?.hasMore && txnsQuery.data.nextCursor && <Pressable
              testID="bank-register-load-more" accessibilityRole="button" disabled={txnsQuery.isFetching}
              onPress={() => setCursor(txnsQuery.data!.nextCursor!)} style={{ padding: 12, backgroundColor: colors.surfaceAlt, borderRadius: 8 }}>
              <Text style={{ color: colors.tint }}>{txnsQuery.isFetching ? "Loading…" : "Load more"}</Text>
            </Pressable>}
          </View>
        ) : null}
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

      {showImport && labOrgId && effectiveAccountId && (
        <StatementImportModal
          organizationId={labOrgId}
          accountId={effectiveAccountId}
          accountName={selectedAccount?.name}
          onClose={() => setShowImport(false)}
          onImported={() => {
            setShowImport(false);
            void qc.invalidateQueries({ queryKey: ["bank-transactions"] });
            if (web) {
              setCursor(null);
              void qc.invalidateQueries({ queryKey: ["finance-accounts"] });
            }
          }}
        />
      )}
    </DismissKeyboardView>
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
  canImport?: boolean;
  onImportFromStatement?: () => void;
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
  canImport,
  onImportFromStatement,
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
          keyboardShouldPersistTaps="handled"
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
            onSubmitEditing={() => Keyboard.dismiss()}
            clearButtonMode="while-editing"
            testID="bank-register-search"
          />
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
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

      {canImport && onImportFromStatement && (
        <View style={styles.importBtnRow}>
          <TouchableOpacity
            onPress={onImportFromStatement}
            activeOpacity={0.75}
            style={styles.importBtn}
          >
            <Ionicons name="document-text-outline" size={15} color={colors.tint} />
            <Text style={styles.importBtnText}>Import from Statement</Text>
          </TouchableOpacity>
        </View>
      )}

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

  if (Platform.OS === "web") return (
    <View style={{ marginHorizontal: 16, marginBottom: 6, padding: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: 8, gap: 6 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: "space-between" }}>
        <Text style={{ color: colors.text, fontWeight: "600", flexShrink: 1 }}>{t.payee || "Unspecified payee"}</Text>
        <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{t.txnDate ? formatDate(t.txnDate) : "Unknown date"}</Text>
      </View>
      <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
        {isVoid ? "Voided" : t.status !== "posted" ? "Projected / Pending" : t.reconciled ? "Reconciled" : t.cleared ? "Cleared" : "Uncleared"}
        {typeLabel ? ` · ${typeLabel}` : ""}{t.checkNumber ? ` · #${t.checkNumber}` : ""}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
        <Text style={{ color: colors.text, fontSize: 12 }}>Payment {t.debitAmount == null ? "Unavailable" : formatMoney(debit)}</Text>
        <Text style={{ color: "#087f5b", fontSize: 12 }}>Deposit {t.creditAmount == null ? "Unavailable" : formatMoney(credit)}</Text>
        <Text style={{ color: colors.text, fontSize: 12, fontWeight: "600" }}>Balance {t.runningBalance == null ? "Unavailable" : formatMoney(toNumber(t.runningBalance))}</Text>
      </View>
      <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Category: {catName || "Uncategorized"}</Text>
      {t.memo && <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{t.memo}</Text>}
    </View>
  );

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

    importBtnRow: {
      paddingHorizontal: Spacing.lg,
      paddingBottom: Spacing.sm,
    },
    importBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      alignSelf: "flex-start",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: c.tint,
      backgroundColor: c.tintLight,
    },
    importBtnText: { ...Typography.captionSemibold, color: c.tint },

    modalBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "flex-end",
    },
    modalSheet: {
      backgroundColor: c.backgroundSolid,
      borderTopLeftRadius: Radius.xl,
      borderTopRightRadius: Radius.xl,
      maxHeight: "90%",
    },
    modalHandle: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: c.border,
      alignSelf: "center",
      marginTop: Spacing.md,
      marginBottom: Spacing.sm,
    },
    modalHeader: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.lg,
      paddingBottom: Spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    modalTitle: { ...Typography.h2, color: c.text, flex: 1 },
    modalCloseBtn: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: c.surfaceAlt,
      alignItems: "center",
      justifyContent: "center",
    },
    modalBody: { padding: Spacing.lg, gap: Spacing.lg },
    modalFooter: {
      flexDirection: "row",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.lg,
      paddingBottom: Spacing.xl,
      paddingTop: Spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },

    pickZone: {
      borderWidth: 2,
      borderStyle: "dashed",
      borderColor: c.border,
      borderRadius: Radius.lg,
      padding: Spacing.xl,
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.md,
    },
    pickTitle: { ...Typography.bodySemibold, color: c.text, textAlign: "center" },
    pickSub: { ...Typography.caption, color: c.textSecondary, textAlign: "center" },
    pickBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      paddingHorizontal: Spacing.xl,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.full,
      backgroundColor: c.tint,
    },
    pickBtnText: { ...Typography.bodySemibold, color: c.textInverse },

    infoRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    infoLabel: { ...Typography.caption, color: c.textSecondary },
    infoValue: { ...Typography.captionSemibold, color: c.text },

    reviewRow: {
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: c.border,
      padding: Spacing.md,
      gap: Spacing.xs,
      backgroundColor: c.surface,
    },
    reviewRowRejected: { opacity: 0.45 },
    reviewRowDup: { borderColor: c.warning, backgroundColor: c.warningSurface },
    reviewRowTop: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    reviewPayee: { ...Typography.bodySemibold, color: c.text, flex: 1 },
    reviewDate: { ...Typography.caption, color: c.textSecondary },
    reviewAmtRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    reviewCredit: { ...Typography.bodySemibold, color: c.success },
    reviewDebit: { ...Typography.bodySemibold, color: c.error },
    reviewBadge: {
      alignSelf: "flex-start",
      paddingHorizontal: Spacing.sm,
      paddingVertical: 2,
      borderRadius: Radius.xs,
    },
    reviewBadgeText: { fontSize: 10, fontFamily: "Inter_600SemiBold", letterSpacing: 0.3 },
    reviewDupWarn: {
      ...Typography.caption,
      color: c.warning,
      flexDirection: "row",
      alignItems: "center",
    },
    reviewChkRow: { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
    reviewChkLabel: { ...Typography.caption, color: c.textSecondary },

    rowActionBtn: {
      padding: 4,
      borderRadius: Radius.xs,
    },

    editForm: {
      marginTop: Spacing.sm,
      gap: Spacing.xs,
      padding: Spacing.sm,
      borderRadius: Radius.sm,
      backgroundColor: c.backgroundSolid,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    editFormRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    editLabel: {
      ...Typography.caption,
      color: c.textSecondary,
      width: 72,
    },
    editInput: {
      ...Typography.caption,
      color: c.text,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: Radius.xs,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 4,
      minWidth: 100,
      backgroundColor: c.surface,
    },

    dupCompare: {
      marginTop: Spacing.sm,
      padding: Spacing.sm,
      borderRadius: Radius.sm,
      backgroundColor: c.warningSurface,
      gap: Spacing.xs,
    },
    dupCompareLabel: {
      ...Typography.caption,
      color: c.warning,
      fontFamily: "Inter_600SemiBold",
    },
    dupCompareRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.sm,
    },
    dupCompareKey: {
      ...Typography.caption,
      color: c.textSecondary,
      width: 44,
    },
    dupCompareValue: {
      ...Typography.caption,
      color: c.text,
      flex: 1,
    },
    dupActions: {
      flexDirection: "row",
      gap: Spacing.sm,
      marginTop: Spacing.xs,
    },
    dupActionBtn: {
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surfaceAlt,
    },
    dupActionBtnPrimary: {
      borderColor: c.tint,
      backgroundColor: c.tintLight,
    },
    dupActionBtnText: {
      ...Typography.captionSemibold,
      color: c.textSecondary,
    },

    approveAllBtn: {
      alignSelf: "flex-start",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.xs,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surfaceAlt,
    },
    approveAllText: { ...Typography.captionSemibold, color: c.text },

    confirmBtn: {
      flex: 1,
      height: 44,
      borderRadius: Radius.full,
      backgroundColor: c.tint,
      alignItems: "center",
      justifyContent: "center",
    },
    confirmBtnDisabled: { opacity: 0.45 },
    confirmBtnText: { ...Typography.bodySemibold, color: c.textInverse },
    cancelBtn: {
      height: 44,
      paddingHorizontal: Spacing.xl,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surfaceAlt,
      alignItems: "center",
      justifyContent: "center",
    },
    cancelBtnText: { ...Typography.bodySemibold, color: c.text },
  });
}

// ─────────────────────────── Statement Import Modal ───────────────────────────

type ImportPhase = "pick" | "parsing" | "review" | "confirming" | "done";

interface ImportRow {
  rowIndex: number;
  txnDate: string;
  description: string;
  checkNumber: string | null;
  debit: number;
  credit: number;
  confidence: "high" | "medium" | "low";
  duplicateCandidateId: string | null;
  duplicateCandidateDate: string | null;
  duplicateCandidatePayee: string | null;
  duplicateCandidateAmount: number | null;
  duplicateScore: number;
  approved: boolean;
  markedDuplicate: boolean;
}

function StatementImportModal({
  organizationId,
  accountId,
  accountName,
  onClose,
  onImported,
}: {
  organizationId: string;
  accountId: string;
  accountName?: string | null;
  onClose: () => void;
  onImported: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();

  const [phase, setPhase] = useState<ImportPhase>("pick");
  const [error, setError] = useState<string | null>(null);
  const [filename, setFilename] = useState("");
  const [previewToken, setPreviewToken] = useState("");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [editIdx, setEditIdx] = useState<number | null>(null);

  async function pickAndUpload() {
    setError(null);
    let result: DocumentPicker.DocumentPickerResult;
    try {
      result = await DocumentPicker.getDocumentAsync({
        type: ["application/pdf", "image/png", "image/jpeg", "image/webp"],
        copyToCacheDirectory: true,
      });
    } catch {
      setError("Could not open file picker. Please try again.");
      return;
    }
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    if (!asset.uri) return;

    const name = asset.name ?? asset.uri.split("/").pop() ?? "statement";
    const mime = asset.mimeType ?? "application/octet-stream";
    const sizeBytes = asset.size ?? 0;
    if (sizeBytes > 20 * 1024 * 1024) {
      setError("File must be under 20 MB.");
      return;
    }

    setFilename(name);
    setPhase("parsing");

    try {
      await new Promise<void>((resolve, reject) => {
        // Build an absolute URL so the request works on native (relative URLs
        // resolve against the bundle, not the API server).
        const apiBase = getApiUrl().replace(/\/+$/, "");
        const url = `${apiBase}/api/finance/transactions/import/preview`;

        // Attach the bearer token the same way uploadCaseMedia does — never
        // rely on a cookie jar, which the server's CSRF guard will reject.
        const accessToken = getAccessToken();

        const xhr = new XMLHttpRequest();
        xhr.open("POST", url);
        xhr.setRequestHeader("Accept", "application/json");
        if (accessToken) xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
        // On web, also forward the CSRF token (bearer requests are CSRF-exempt
        // on native; on web the cookie jar is active so the token is required).
        if (Platform.OS === "web") {
          const csrf = getCsrfToken();
          if (csrf) xhr.setRequestHeader("x-csrf-token", csrf);
          xhr.withCredentials = true;
        }
        // Never set Content-Type manually — the runtime adds the multipart boundary.

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const body = JSON.parse(xhr.responseText) as {
                ok?: boolean;
                data?: { previewToken: string; rows: ImportRow[] };
                previewToken?: string;
                rows?: ImportRow[];
              };
              const data = body.data ?? body;
              const token = data.previewToken ?? "";
              const rawRows: ImportRow[] = (data.rows ?? []).map((r) => ({
                ...r,
                approved: r.duplicateScore < 0.7,
                markedDuplicate: r.duplicateScore >= 0.7,
              }));
              setPreviewToken(token);
              setRows(rawRows);
              setPhase("review");
              resolve();
            } catch {
              reject(new Error("Invalid server response."));
            }
          } else {
            let msg = `Upload failed (${xhr.status}).`;
            try {
              const parsed = JSON.parse(xhr.responseText) as { error?: string };
              if (parsed?.error) msg = parsed.error;
            } catch { /* ignore */ }
            reject(new Error(msg));
          }
        };
        xhr.onerror = () => reject(new Error("Network error during upload."));

        const formData = new FormData();
        if (Platform.OS === "web") {
          // On web, materialize the blob so FormData uses the standard Blob overload.
          globalThis.fetch(asset.uri).then((r) => r.blob()).then((blob) => {
            formData.append("file", blob, name);
            formData.append("organizationId", organizationId);
            formData.append("bankAccountId", accountId);
            xhr.send(formData);
          }).catch(() => reject(new Error("Could not read selected file.")));
        } else {
          // React Native's FormData runtime accepts the native file descriptor.
          (formData as any).append("file", { uri: asset.uri, name, type: mime });
          formData.append("organizationId", organizationId);
          formData.append("bankAccountId", accountId);
          xhr.send(formData);
        }
      });
    } catch (e: any) {
      setError(e?.message ?? "Upload failed. Please try again.");
      setPhase("pick");
    }
  }

  function toggleApprove(idx: number) {
    setRows((prev) =>
      prev.map((r, i) => i === idx ? { ...r, approved: !r.approved, markedDuplicate: false } : r)
    );
  }

  function approveAll() {
    setRows((prev) => prev.map((r) => ({ ...r, approved: true, markedDuplicate: false })));
  }

  function deleteRow(idx: number) {
    setRows((prev) => prev.filter((_, i) => i !== idx));
    if (editIdx === idx) setEditIdx(null);
    else if (editIdx !== null && editIdx > idx) setEditIdx(editIdx - 1);
  }

  function updateRow(idx: number, patch: Partial<Pick<ImportRow, "txnDate" | "description" | "debit" | "credit" | "checkNumber">>) {
    setRows((prev) => prev.map((r, i) => i === idx ? { ...r, ...patch } : r));
  }

  function markDuplicate(idx: number) {
    setRows((prev) => prev.map((r, i) => i === idx ? { ...r, markedDuplicate: true, approved: false } : r));
    if (editIdx === idx) setEditIdx(null);
  }

  function keepBoth(idx: number) {
    setRows((prev) => prev.map((r, i) => i === idx ? { ...r, markedDuplicate: false, approved: true } : r));
  }

  async function confirmImport() {
    const approvedRows = rows.filter((r) => r.approved && !r.markedDuplicate);
    if (!approvedRows.length) {
      setError("No approved rows to import.");
      return;
    }
    setPhase("confirming");
    setError(null);
    try {
      await sendJson<{ imported: number }>("POST", "/api/finance/transactions/import/confirm", {
        previewToken,
        organizationId,
        bankAccountId: accountId,
        sourceFilename: filename,
        approvedRows: approvedRows.map((r) => ({
          rowIndex: r.rowIndex,
          txnDate: r.txnDate,
          description: r.description,
          checkNumber: r.checkNumber ?? null,
          debit: r.debit,
          credit: r.credit,
        })),
        skippedCount: rows.length - approvedRows.length,
      });
      setPhase("done");
      onImported();
    } catch (e: any) {
      setError(e?.message ?? "Import failed. Please try again.");
      setPhase("review");
    }
  }

  const approvedCount = rows.filter((r) => r.approved && !r.markedDuplicate).length;

  const CONF_COLOR: Record<string, string> = {
    high: colors.success,
    medium: colors.warning,
    low: colors.error,
  };
  const CONF_BG: Record<string, string> = {
    high: colors.successLight,
    medium: colors.warningSurface,
    low: colors.errorSurface ?? colors.warningSurface,
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.modalBackdrop}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <DismissKeyboardView
          style={[styles.modalSheet, { paddingBottom: insets.bottom }]}
          testID="bank-import-keyboard-dismiss"
        >
          <View style={styles.modalHandle} />
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Import from Statement</Text>
            <TouchableOpacity style={styles.modalCloseBtn} onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={16} color={colors.text} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={{ maxHeight: 520 }}
            contentContainerStyle={styles.modalBody}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={scrollKeyboardDismissMode}
          >
            {error ? (
              <View style={{ flexDirection: "row", gap: Spacing.sm, padding: Spacing.md, borderRadius: Radius.md, backgroundColor: colors.errorSurface ?? colors.warningSurface }}>
                <Ionicons name="warning-outline" size={16} color={colors.error} />
                <Text style={{ ...Typography.caption, color: colors.error, flex: 1 }}>{error}</Text>
              </View>
            ) : null}

            {phase === "pick" && (
              <View style={styles.pickZone}>
                <Ionicons name="document-text-outline" size={40} color={colors.textTertiary} />
                <Text style={styles.pickTitle}>Choose your bank statement</Text>
                <Text style={styles.pickSub}>PDF, PNG, JPG, or WEBP · Max 20 MB</Text>
                <TouchableOpacity style={styles.pickBtn} onPress={() => void pickAndUpload()} activeOpacity={0.8}>
                  <Ionicons name="cloud-upload-outline" size={16} color={colors.textInverse} />
                  <Text style={styles.pickBtnText}>Choose File</Text>
                </TouchableOpacity>
              </View>
            )}

            {phase === "parsing" && (
              <View style={[styles.pickZone, { gap: Spacing.lg }]}>
                <ActivityIndicator size="large" color={colors.tint} />
                <Text style={styles.pickTitle}>Analyzing with AI…</Text>
                <Text style={styles.pickSub}>This may take 10–30 seconds.</Text>
              </View>
            )}

            {phase === "review" && (
              <>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>{filename}</Text>
                  <Text style={styles.infoValue}>{rows.length} row{rows.length !== 1 ? "s" : ""}</Text>
                </View>
                {accountName ? (
                  <View style={styles.infoRow}>
                    <Text style={styles.infoLabel}>Account</Text>
                    <Text style={styles.infoValue}>{accountName}</Text>
                  </View>
                ) : null}
                <TouchableOpacity style={styles.approveAllBtn} onPress={approveAll} activeOpacity={0.8}>
                  <Text style={styles.approveAllText}>Approve all</Text>
                </TouchableOpacity>
                {rows.map((r, idx) => {
                  const confColor = CONF_COLOR[r.confidence] ?? colors.textSecondary;
                  const confBg = CONF_BG[r.confidence] ?? colors.surfaceAlt;
                  const hasDup = !!r.duplicateCandidateId;
                  const isEditing = editIdx === idx;
                  return (
                    <View
                      key={`${r.rowIndex}-${idx}`}
                      style={[
                        styles.reviewRow,
                        r.markedDuplicate && styles.reviewRowRejected,
                        hasDup && !r.markedDuplicate && styles.reviewRowDup,
                      ]}
                    >
                      {/* ── Row header ── */}
                      <View style={styles.reviewRowTop}>
                        <TouchableOpacity onPress={() => toggleApprove(idx)} hitSlop={8}>
                          <Ionicons
                            name={r.approved && !r.markedDuplicate ? "checkmark-circle" : "ellipse-outline"}
                            size={20}
                            color={r.approved && !r.markedDuplicate ? colors.success : colors.textTertiary}
                          />
                        </TouchableOpacity>
                        <Text style={styles.reviewPayee} numberOfLines={1}>{r.description || "—"}</Text>
                        <Text style={styles.reviewDate}>{r.txnDate}</Text>
                        <TouchableOpacity
                          onPress={() => setEditIdx(isEditing ? null : idx)}
                          hitSlop={8}
                          style={styles.rowActionBtn}
                        >
                          <Ionicons name={isEditing ? "chevron-up" : "create-outline"} size={16} color={colors.textSecondary} />
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => deleteRow(idx)}
                          hitSlop={8}
                          style={styles.rowActionBtn}
                        >
                          <Ionicons name="trash-outline" size={16} color={colors.error} />
                        </TouchableOpacity>
                      </View>

                      {/* ── Amount + badges ── */}
                      <View style={styles.reviewAmtRow}>
                        {r.credit > 0 ? (
                          <Text style={styles.reviewCredit}>+{formatMoney(r.credit)}</Text>
                        ) : r.debit > 0 ? (
                          <Text style={styles.reviewDebit}>−{formatMoney(r.debit)}</Text>
                        ) : null}
                        {r.checkNumber ? (
                          <Text style={styles.reviewDate}>#{r.checkNumber}</Text>
                        ) : null}
                        <View style={[styles.reviewBadge, { backgroundColor: confBg }]}>
                          <Text style={[styles.reviewBadgeText, { color: confColor }]}>
                            {r.confidence.toUpperCase()}
                          </Text>
                        </View>
                        {hasDup && (
                          <View style={[styles.reviewBadge, { backgroundColor: colors.warningSurface }]}>
                            <Text style={[styles.reviewBadgeText, { color: colors.warning }]}>DUP?</Text>
                          </View>
                        )}
                      </View>

                      {/* ── Inline edit form ── */}
                      {isEditing && (
                        <View style={styles.editForm}>
                          <View style={styles.editFormRow}>
                            <Text style={styles.editLabel}>Date</Text>
                            <TextInput
                              style={styles.editInput}
                              value={r.txnDate}
                              onChangeText={(v) => updateRow(idx, { txnDate: v })}
                              placeholder="YYYY-MM-DD"
                              placeholderTextColor={colors.textTertiary}
                            />
                          </View>
                          <View style={styles.editFormRow}>
                            <Text style={styles.editLabel}>Description</Text>
                            <TextInput
                              style={[styles.editInput, { flex: 1 }]}
                              value={r.description}
                              onChangeText={(v) => updateRow(idx, { description: v })}
                              placeholder="Payee / memo"
                              placeholderTextColor={colors.textTertiary}
                               autoCorrect={true}
                               spellCheck={true}
                               autoCapitalize="sentences"
                            />
                          </View>
                          <View style={styles.editFormRow}>
                            <Text style={styles.editLabel}>Debit</Text>
                            <TextInput
                              style={styles.editInput}
                              value={r.debit > 0 ? String(r.debit) : ""}
                              onChangeText={(v) => updateRow(idx, { debit: parseFloat(v) || 0, credit: v ? 0 : r.credit })}
                              keyboardType="decimal-pad"
                              placeholder="0.00"
                              placeholderTextColor={colors.textTertiary}
                            />
                          </View>
                          <View style={styles.editFormRow}>
                            <Text style={styles.editLabel}>Credit</Text>
                            <TextInput
                              style={styles.editInput}
                              value={r.credit > 0 ? String(r.credit) : ""}
                              onChangeText={(v) => updateRow(idx, { credit: parseFloat(v) || 0, debit: v ? 0 : r.debit })}
                              keyboardType="decimal-pad"
                              placeholder="0.00"
                              placeholderTextColor={colors.textTertiary}
                            />
                          </View>
                          <View style={styles.editFormRow}>
                            <Text style={styles.editLabel}>Check #</Text>
                            <TextInput
                              style={styles.editInput}
                              value={r.checkNumber ?? ""}
                              onChangeText={(v) => updateRow(idx, { checkNumber: v || null })}
                              placeholder="Optional"
                              placeholderTextColor={colors.textTertiary}
                            />
                          </View>
                        </View>
                      )}

                      {/* ── Duplicate side-by-side comparison ── */}
                      {hasDup && !r.markedDuplicate && (
                        <View style={styles.dupCompare}>
                          <Text style={styles.dupCompareLabel}>Possible duplicate already in register:</Text>
                          <View style={styles.dupCompareRow}>
                            <Text style={styles.dupCompareKey}>Existing</Text>
                            <Text style={styles.dupCompareValue} numberOfLines={1}>
                              {r.duplicateCandidateDate ?? "—"}
                              {r.duplicateCandidatePayee ? `  ·  ${r.duplicateCandidatePayee}` : ""}
                              {r.duplicateCandidateAmount != null ? `  ·  ${formatMoney(r.duplicateCandidateAmount)}` : ""}
                            </Text>
                          </View>
                          <View style={styles.dupCompareRow}>
                            <Text style={styles.dupCompareKey}>New</Text>
                            <Text style={styles.dupCompareValue} numberOfLines={1}>
                              {r.txnDate}
                              {r.description ? `  ·  ${r.description}` : ""}
                              {"  ·  "}{formatMoney(r.debit > 0 ? r.debit : r.credit)}
                            </Text>
                          </View>
                          <View style={styles.dupActions}>
                            <TouchableOpacity
                              style={[styles.dupActionBtn]}
                              onPress={() => markDuplicate(idx)}
                              activeOpacity={0.8}
                            >
                              <Text style={styles.dupActionBtnText}>Skip (duplicate)</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={[styles.dupActionBtn, styles.dupActionBtnPrimary]}
                              onPress={() => keepBoth(idx)}
                              activeOpacity={0.8}
                            >
                              <Text style={[styles.dupActionBtnText, { color: colors.tint }]}>Keep both</Text>
                            </TouchableOpacity>
                          </View>
                        </View>
                      )}
                    </View>
                  );
                })}
              </>
            )}

            {phase === "confirming" && (
              <View style={[styles.pickZone, { gap: Spacing.lg }]}>
                <ActivityIndicator size="large" color={colors.tint} />
                <Text style={styles.pickTitle}>Importing transactions…</Text>
              </View>
            )}

            {phase === "done" && (
              <View style={[styles.pickZone, { gap: Spacing.lg }]}>
                <Ionicons name="checkmark-circle" size={48} color={colors.success} />
                <Text style={styles.pickTitle}>Import complete</Text>
                <Text style={styles.pickSub}>Transactions have been added to the register.</Text>
                <TouchableOpacity style={styles.pickBtn} onPress={onClose} activeOpacity={0.8}>
                  <Text style={styles.pickBtnText}>Close</Text>
                </TouchableOpacity>
              </View>
            )}
          </ScrollView>

          {phase === "review" && (
            <View style={styles.modalFooter}>
              <TouchableOpacity style={styles.cancelBtn} onPress={onClose} activeOpacity={0.8}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmBtn, approvedCount === 0 && styles.confirmBtnDisabled]}
                onPress={() => void confirmImport()}
                disabled={approvedCount === 0}
                activeOpacity={0.8}
              >
                <Text style={styles.confirmBtnText}>
                  Import {approvedCount} row{approvedCount !== 1 ? "s" : ""}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </DismissKeyboardView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
