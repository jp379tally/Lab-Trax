import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/lib/theme-context";
import { AppHeader } from "@/components/ui/AppHeader";
import { FilterBar } from "@/components/ui/FilterBar";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { StatTile } from "@/components/ui/StatTile";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { useAuth } from "@/lib/auth-context";
import { resilientFetch } from "@/lib/query-client";

type ReportTab = "summary" | "production" | "sales" | "aging";

const SCREEN_WIDTH = Dimensions.get("window").width;

function fmtMoney(v?: number | string | null) {
  const n = Number(v) || 0;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtPct(v?: number | null) {
  if (v == null) return "—";
  return `${Math.round(v)}%`;
}

interface BarChartItem {
  label: string;
  value: number;
  color?: string;
}

function BarChart({ data, max, height = 120 }: { data: BarChartItem[]; max: number; height?: number }) {
  const { colors } = useTheme();
  if (!data.length) return null;
  const barMax = max || 1;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", height, gap: 4, paddingTop: 8 }}>
      {data.map((item, idx) => {
        const pct = Math.max(0, Math.min(1, item.value / barMax));
        const barH = Math.max(4, Math.floor(pct * (height - 24)));
        return (
          <View key={idx} style={{ flex: 1, alignItems: "center" }}>
            <Text style={{ fontSize: 8, color: colors.textTertiary, marginBottom: 2 }} numberOfLines={1}>
              {item.value > 0 ? fmtMoney(item.value).replace("$", "").split(".")[0] : ""}
            </Text>
            <View style={{ width: "80%", height: barH, borderRadius: 4, backgroundColor: item.color || colors.tint, opacity: 0.85 }} />
            <Text style={{ fontSize: 8, color: colors.textTertiary, marginTop: 3, textAlign: "center" }} numberOfLines={2}>
              {item.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function HorizBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const { colors } = useTheme();
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <View style={{ marginBottom: 10 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
        <Text style={{ fontSize: 12, color: colors.text, fontFamily: "Inter_500Medium" }} numberOfLines={1}>
          {label}
        </Text>
        <Text style={{ fontSize: 12, color: colors.tint, fontFamily: "Inter_600SemiBold" }}>
          {fmtMoney(value)}
        </Text>
      </View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.border }}>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: color, width: `${pct * 100}%` }} />
      </View>
    </View>
  );
}

const BAR_COLORS = ["#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899", "#14B8A6", "#F97316"];

export default function ReportsScreen() {
  const { colors, isDark } = useTheme();
  const { organizationId, userType } = useAuth() as any;
  const [tab, setTab] = useState<ReportTab>("summary");
  const [labId, setLabId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dateRange, setDateRange] = useState<"30d" | "90d" | "ytd" | "12m">("30d");

  const [summaryData, setSummaryData] = useState<any>(null);
  const [productionData, setProductionData] = useState<any>(null);
  const [salesData, setSalesData] = useState<any>(null);
  const [agingData, setAgingData] = useState<any>(null);

  const resolveLabId = useCallback(async () => {
    try {
      const meRes = await resilientFetch("/api/auth/me");
      const me = await meRes.json().catch(() => ({}));
      const memberships: any[] = me?.memberships ?? me?.user?.memberships ?? [];
      const lab = memberships.find(
        (m: any) => m.status === "active" && (m.organization?.type === "lab" || m.labId)
      );
      const id = lab?.labId ?? lab?.organizationId ?? (organizationId as string | null) ?? null;
      setLabId(id);
      return id;
    } catch {
      return null;
    }
  }, [organizationId]);

  const dateParams = useMemo(() => {
    const now = new Date();
    const end = now.toISOString().split("T")[0];
    let start: string;
    if (dateRange === "30d") {
      const d = new Date(now); d.setDate(d.getDate() - 30);
      start = d.toISOString().split("T")[0];
    } else if (dateRange === "90d") {
      const d = new Date(now); d.setDate(d.getDate() - 90);
      start = d.toISOString().split("T")[0];
    } else if (dateRange === "ytd") {
      start = `${now.getFullYear()}-01-01`;
    } else {
      const d = new Date(now); d.setFullYear(d.getFullYear() - 1);
      start = d.toISOString().split("T")[0];
    }
    return { start, end };
  }, [dateRange]);

  const fetchSummary = useCallback(async (orgId: string) => {
    try {
      const { start, end } = dateParams;
      const [casesRes, invoicesRes] = await Promise.all([
        resilientFetch(`/api/cases?organizationId=${orgId}&limit=1`),
        resilientFetch(`/api/invoices?organizationId=${orgId}&dateFrom=${start}&dateTo=${end}`),
      ]);
      const casesBody = await casesRes.json().catch(() => ({}));
      const invoicesBody = await invoicesRes.json().catch(() => ({}));

      const invoiceList: any[] = Array.isArray(invoicesBody) ? invoicesBody : invoicesBody?.data ?? [];
      const totalRevenue = invoiceList
        .filter((i: any) => i.status === "paid")
        .reduce((sum: number, i: any) => sum + (Number(i.total) || 0), 0);
      const openBalance = invoiceList
        .filter((i: any) => i.status === "open" || i.status === "partially_paid")
        .reduce((sum: number, i: any) => sum + (Number(i.balanceDue) || 0), 0);
      const overdueBalance = invoiceList
        .filter((i: any) => {
          if (i.status !== "open" && i.status !== "partially_paid") return false;
          if (!i.dueAt) return false;
          return new Date(i.dueAt).getTime() < Date.now();
        })
        .reduce((sum: number, i: any) => sum + (Number(i.balanceDue) || 0), 0);

      const casesMeta = casesBody?.meta ?? {};
      const totalCases = casesMeta?.total ?? casesBody?.total ?? invoiceList.length;

      setSummaryData({
        totalRevenue,
        openBalance,
        overdueBalance,
        invoiceCount: invoiceList.length,
        paidCount: invoiceList.filter((i: any) => i.status === "paid").length,
        openCount: invoiceList.filter((i: any) => i.status === "open" || i.status === "partially_paid").length,
        draftCount: invoiceList.filter((i: any) => i.status === "draft").length,
        invoices: invoiceList,
      });
    } catch {
      setSummaryData(null);
    }
  }, [dateParams]);

  const fetchProduction = useCallback(async (orgId: string) => {
    try {
      const { start, end } = dateParams;
      const res = await resilientFetch(
        `/api/cases?organizationId=${orgId}&dateFrom=${start}&dateTo=${end}&limit=500`
      );
      const body = await res.json().catch(() => ({}));
      const caseList: any[] = Array.isArray(body) ? body : body?.data ?? body?.cases ?? [];
      const statusMap: Record<string, number> = {};
      const monthMap: Record<string, number> = {};
      for (const c of caseList) {
        statusMap[c.status || "unknown"] = (statusMap[c.status || "unknown"] || 0) + 1;
        const d = new Date(c.createdAt || c.receivedAt || Date.now());
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        monthMap[key] = (monthMap[key] || 0) + 1;
      }
      const byStatus = Object.entries(statusMap)
        .sort((a, b) => b[1] - a[1])
        .map(([label, value]) => ({ label, value }));
      const byMonth = Object.entries(monthMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-6)
        .map(([label, value]) => ({ label: label.slice(5), value }));
      setProductionData({ caseList, byStatus, byMonth, total: caseList.length });
    } catch {
      setProductionData(null);
    }
  }, [dateParams]);

  const fetchSales = useCallback(async (orgId: string) => {
    try {
      const { start, end } = dateParams;
      const res = await resilientFetch(
        `/api/invoices?organizationId=${orgId}&dateFrom=${start}&dateTo=${end}&limit=500`
      );
      const body = await res.json().catch(() => ({}));
      const invoiceList: any[] = Array.isArray(body) ? body : body?.data ?? [];
      const byOrg: Record<string, { name: string; revenue: number; invoiceCount: number }> = {};
      for (const inv of invoiceList) {
        const key = inv.providerOrganizationId || "unknown";
        const name = inv.providerOrganization?.displayName || inv.providerOrganization?.name || inv.providerOrganizationId || "Unknown Practice";
        if (!byOrg[key]) byOrg[key] = { name, revenue: 0, invoiceCount: 0 };
        if (inv.status === "paid") byOrg[key].revenue += Number(inv.total) || 0;
        byOrg[key].invoiceCount += 1;
      }
      const sorted = Object.values(byOrg).sort((a, b) => b.revenue - a.revenue).slice(0, 10);
      setSalesData({ byOrg: sorted, total: invoiceList.length });
    } catch {
      setSalesData(null);
    }
  }, [dateParams]);

  const fetchAging = useCallback(async (orgId: string) => {
    try {
      const res = await resilientFetch(`/api/invoices?organizationId=${orgId}&status=open&limit=500`);
      const body = await res.json().catch(() => ({}));
      const invoiceList: any[] = Array.isArray(body) ? body : body?.data ?? [];
      const now = Date.now();
      const buckets: Record<string, { label: string; amount: number; count: number }> = {
        current: { label: "Current", amount: 0, count: 0 },
        d1_30: { label: "1–30 days", amount: 0, count: 0 },
        d31_60: { label: "31–60 days", amount: 0, count: 0 },
        d61_90: { label: "61–90 days", amount: 0, count: 0 },
        d90plus: { label: "90+ days", amount: 0, count: 0 },
      };
      for (const inv of invoiceList) {
        const balance = Number(inv.balanceDue) || Number(inv.total) || 0;
        if (!inv.dueAt) {
          buckets.current.amount += balance;
          buckets.current.count += 1;
          continue;
        }
        const daysPast = Math.floor((now - new Date(inv.dueAt).getTime()) / 86400000);
        if (daysPast <= 0) { buckets.current.amount += balance; buckets.current.count += 1; }
        else if (daysPast <= 30) { buckets.d1_30.amount += balance; buckets.d1_30.count += 1; }
        else if (daysPast <= 60) { buckets.d31_60.amount += balance; buckets.d31_60.count += 1; }
        else if (daysPast <= 90) { buckets.d61_90.amount += balance; buckets.d61_90.count += 1; }
        else { buckets.d90plus.amount += balance; buckets.d90plus.count += 1; }
      }
      const totalAging = Object.values(buckets).reduce((s, b) => s + b.amount, 0);
      setAgingData({ buckets: Object.values(buckets), total: totalAging });
    } catch {
      setAgingData(null);
    }
  }, []);

  const loadAll = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    const orgId = await resolveLabId();
    if (orgId) {
      await Promise.all([fetchSummary(orgId), fetchProduction(orgId), fetchSales(orgId), fetchAging(orgId)]);
    }
    setLoading(false);
    setRefreshing(false);
  }, [resolveLabId, fetchSummary, fetchProduction, fetchSales, fetchAging]);

  useEffect(() => { void loadAll(); }, []);
  useEffect(() => {
    if (labId) {
      void fetchSummary(labId);
      void fetchProduction(labId);
      void fetchSales(labId);
    }
  }, [dateRange]);

  const TABS: { id: ReportTab; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { id: "summary", label: "Summary", icon: "stats-chart-outline" },
    { id: "production", label: "Production", icon: "construct-outline" },
    { id: "sales", label: "Sales", icon: "business-outline" },
    { id: "aging", label: "Aging", icon: "time-outline" },
  ];

  const DATE_FILTERS = [
    { id: "30d", label: "30 days" },
    { id: "90d", label: "90 days" },
    { id: "ytd", label: "YTD" },
    { id: "12m", label: "12 months" },
  ];

  function renderSummary() {
    const d = summaryData;
    return (
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40, paddingTop: 8 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadAll(true)} tintColor={colors.tint} />}
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 12, gap: 10 }}>
          <StatTile
            label="Revenue Collected"
            value={fmtMoney(d?.totalRevenue)}
            icon="card-outline"
            style={{ flex: 1, minWidth: "44%" }}
          />
          <StatTile
            label="Open Balance"
            value={fmtMoney(d?.openBalance)}
            icon="alert-circle-outline"
            style={{ flex: 1, minWidth: "44%" }}
          />
          <StatTile
            label="Overdue"
            value={fmtMoney(d?.overdueBalance)}
            icon="warning-outline"
            style={{ flex: 1, minWidth: "44%" }}
          />
          <StatTile
            label="Invoices Issued"
            value={String(d?.invoiceCount ?? 0)}
            icon="receipt-outline"
            style={{ flex: 1, minWidth: "44%" }}
          />
        </View>

        <SectionHeader title="Invoice Status Breakdown" />
        <Card style={{ marginHorizontal: 16 }}>
          {[
            { label: "Paid", value: d?.paidCount ?? 0, color: colors.success },
            { label: "Open", value: d?.openCount ?? 0, color: colors.warningStrong },
            { label: "Draft", value: d?.draftCount ?? 0, color: colors.textTertiary },
          ].map((row) => (
            <View key={row.label} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: row.color }} />
                <Text style={{ fontSize: 14, color: colors.text, fontFamily: "Inter_400Regular" }}>{row.label}</Text>
              </View>
              <Text style={{ fontSize: 14, color: colors.tint, fontFamily: "Inter_600SemiBold" }}>{row.value}</Text>
            </View>
          ))}
        </Card>
      </ScrollView>
    );
  }

  function renderProduction() {
    const d = productionData;
    if (!d) return <EmptyState icon="construct-outline" title="No production data" description="Case data will appear here once cases have been created." />;
    const monthMax = Math.max(...(d.byMonth?.map((m: any) => m.value) ?? [1]), 1);
    return (
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40, paddingTop: 8 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadAll(true)} tintColor={colors.tint} />}>
        <View style={{ paddingHorizontal: 12 }}>
          <StatTile label="Total Cases" value={String(d.total)} icon="file-tray-full-outline" style={{ marginBottom: 10 }} />
        </View>
        <SectionHeader title="Cases by Month" />
        <Card style={{ marginHorizontal: 16, padding: 16 }}>
          {d.byMonth?.length ? (
            <BarChart data={d.byMonth.map((m: any, i: number) => ({ ...m, color: BAR_COLORS[i % BAR_COLORS.length] }))} max={monthMax} height={130} />
          ) : (
            <Text style={{ color: colors.textTertiary, fontSize: 13, textAlign: "center", padding: 16 }}>No monthly data available</Text>
          )}
        </Card>
        <SectionHeader title="Cases by Status" />
        <Card style={{ marginHorizontal: 16, padding: 16 }}>
          {d.byStatus?.map((s: any, i: number) => (
            <HorizBar key={s.label} label={s.label} value={s.value} max={d.total || 1} color={BAR_COLORS[i % BAR_COLORS.length]} />
          ))}
        </Card>
      </ScrollView>
    );
  }

  function renderSales() {
    const d = salesData;
    if (!d || !d.byOrg?.length) return <EmptyState icon="business-outline" title="No sales data" description="Sales data by practice will appear here." />;
    const maxRev = Math.max(...d.byOrg.map((o: any) => o.revenue), 1);
    return (
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40, paddingTop: 8 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadAll(true)} tintColor={colors.tint} />}>
        <SectionHeader title="Revenue by Practice" />
        <Card style={{ marginHorizontal: 16, padding: 16 }}>
          {d.byOrg.map((org: any, i: number) => (
            <HorizBar key={i} label={org.name} value={org.revenue} max={maxRev} color={BAR_COLORS[i % BAR_COLORS.length]} />
          ))}
        </Card>
        <SectionHeader title="Top Practices" />
        <Card style={{ marginHorizontal: 16 }}>
          {d.byOrg.map((org: any, i: number) => (
            <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
                <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: BAR_COLORS[i % BAR_COLORS.length] + "30", alignItems: "center", justifyContent: "center" }}>
                  <Text style={{ fontSize: 11, fontFamily: "Inter_700Bold", color: BAR_COLORS[i % BAR_COLORS.length] }}>{i + 1}</Text>
                </View>
                <Text style={{ fontSize: 14, color: colors.text, fontFamily: "Inter_500Medium", flex: 1 }} numberOfLines={1}>{org.name}</Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={{ fontSize: 13, color: colors.tint, fontFamily: "Inter_600SemiBold" }}>{fmtMoney(org.revenue)}</Text>
                <Text style={{ fontSize: 11, color: colors.textTertiary, fontFamily: "Inter_400Regular" }}>{org.invoiceCount} invoices</Text>
              </View>
            </View>
          ))}
        </Card>
      </ScrollView>
    );
  }

  function renderAging() {
    const d = agingData;
    if (!d) return <EmptyState icon="time-outline" title="No aging data" description="Aging report shows open invoice balances by how long they've been outstanding." />;
    const maxAmount = Math.max(...d.buckets.map((b: any) => b.amount), 1);
    return (
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40, paddingTop: 8 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadAll(true)} tintColor={colors.tint} />}>
        <View style={{ paddingHorizontal: 12 }}>
          <StatTile label="Total Outstanding" value={fmtMoney(d.total)} icon="alert-circle-outline" style={{ marginBottom: 10 }} />
        </View>
        <SectionHeader title="Aging Buckets" />
        <Card style={{ marginHorizontal: 16 }}>
          {d.buckets.map((bucket: any, i: number) => {
            const isRed = bucket.label.includes("90+");
            const isOrange = bucket.label.includes("61–90");
            const col = isRed ? colors.error : isOrange ? colors.warningStrong : BAR_COLORS[i % BAR_COLORS.length];
            return (
              <View key={bucket.label} style={{ paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
                  <Text style={{ fontSize: 14, color: colors.text, fontFamily: "Inter_500Medium" }}>{bucket.label}</Text>
                  <View style={{ alignItems: "flex-end" }}>
                    <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: bucket.amount > 0 ? col : colors.textTertiary }}>{fmtMoney(bucket.amount)}</Text>
                    <Text style={{ fontSize: 11, color: colors.textTertiary }}>{bucket.count} invoice{bucket.count !== 1 ? "s" : ""}</Text>
                  </View>
                </View>
                <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.border }}>
                  <View style={{ height: 4, borderRadius: 2, backgroundColor: col, width: `${(bucket.amount / maxAmount) * 100}%` }} />
                </View>
              </View>
            );
          })}
        </Card>
      </ScrollView>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.backgroundSolid }}>
      <Stack.Screen options={{ headerShown: false }} />
      <AppHeader title="Reports" showSearch={false} />

      <FilterBar
        filters={TABS.map((t) => ({ id: t.id, label: t.label }))}
        activeId={tab}
        onSelect={(id) => setTab(id as ReportTab)}
      />

      {tab !== "aging" && (
        <FilterBar
          filters={DATE_FILTERS}
          activeId={dateRange}
          onSelect={(id) => setDateRange(id as typeof dateRange)}
          style={{ paddingVertical: 6 }}
        />
      )}

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : !labId ? (
        <EmptyState icon="stats-chart-outline" title="Reports unavailable" description="Reports are available for lab admin accounts only." />
      ) : (
        <>
          {tab === "summary" && renderSummary()}
          {tab === "production" && renderProduction()}
          {tab === "sales" && renderSales()}
          {tab === "aging" && renderAging()}
        </>
      )}
    </View>
  );
}
