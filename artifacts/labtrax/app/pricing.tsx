import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/lib/theme-context";
import { AppHeader } from "@/components/ui/AppHeader";
import { FilterBar } from "@/components/ui/FilterBar";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Card } from "@/components/ui/Card";
import { resilientFetch } from "@/lib/query-client";

type PricingTab = "tiers" | "overrides" | "history";

function fmtPrice(v?: string | number | null, unit?: string | null) {
  const n = Number(v);
  if (!v && v !== 0) return "—";
  if (isNaN(n)) return "—";
  const formatted = n.toLocaleString("en-US", { style: "currency", currency: "USD" });
  return unit ? `${formatted} / ${unit}` : formatted;
}

function useLab() {
  const [labId, setLabId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    resilientFetch("/api/auth/me")
      .then((r) => r.json().catch(() => ({})))
      .then((me) => {
        const memberships: any[] = me?.memberships ?? me?.user?.memberships ?? [];
        const lab = memberships.find(
          (m: any) => m.status === "active" && (m.organization?.type === "lab" || m.labId)
        );
        setLabId(lab?.labId ?? lab?.organizationId ?? null);
        setIsAdmin(["owner", "admin"].includes(lab?.role ?? ""));
      })
      .catch(() => {});
  }, []);
  return { labId, isAdmin };
}

interface PricingTier {
  id: string;
  name: string;
  isDefault?: boolean;
  restorationPrices?: Record<string, number | string | null>;
  items?: Array<{ id?: string; description?: string | null; price?: string | number | null; unit?: string | null; material?: string | null }>;
}

interface PricingOverride {
  id: string;
  providerOrganizationId: string;
  providerOrganization?: { name?: string | null; displayName?: string | null } | null;
  tierId?: string | null;
  tier?: { name?: string | null } | null;
  restorationPrices?: Record<string, number | string | null>;
  createdAt?: string | null;
  updatedAt?: string | null;
}

function OverrideHistoryModal({ visible, onClose, overrideId }: { visible: boolean; onClose: () => void; overrideId: string }) {
  const { colors } = useTheme();
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!visible || !overrideId) return;
    setLoading(true);
    resilientFetch(`/api/pricing/overrides/${overrideId}/history`)
      .then((r) => r.json().catch(() => ({})))
      .then((body) => setHistory(Array.isArray(body) ? body : body?.entries ?? body?.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [visible, overrideId]);

  function fmtDate(d?: string | null) {
    if (!d) return "—";
    return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "80%", paddingBottom: 36 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 20 }}>
            <Text style={{ fontSize: 17, fontFamily: "Inter_700Bold", color: colors.text }}>Override History</Text>
            <Pressable onPress={onClose} hitSlop={8}><Ionicons name="close" size={22} color={colors.textSecondary} /></Pressable>
          </View>
          {loading ? (
            <View style={{ padding: 40, alignItems: "center" }}><ActivityIndicator color={colors.tint} /></View>
          ) : history.length === 0 ? (
            <View style={{ padding: 40, alignItems: "center" }}>
              <Text style={{ fontSize: 14, color: colors.textSecondary }}>No history found</Text>
            </View>
          ) : (
            <FlatList
              data={history}
              keyExtractor={(h) => h.id}
              contentContainerStyle={{ paddingHorizontal: 20 }}
              renderItem={({ item: h }) => (
                <View style={{ paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: colors.text }}>{h.action ?? h.eventType ?? "Updated"}</Text>
                    <Text style={{ fontSize: 11, color: colors.textTertiary }}>{fmtDate(h.createdAt ?? h.timestamp)}</Text>
                  </View>
                  {h.actorInitials && <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>By {h.actorInitials}</Text>}
                  {h.note && <Text style={{ fontSize: 12, color: colors.textTertiary, marginTop: 2 }}>{h.note}</Text>}
                </View>
              )}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

function TierDetail({ tier, onEditItem, isAdmin }: { tier: PricingTier; onEditItem: (tierId: string, item: any) => void; isAdmin: boolean }) {
  const { colors } = useTheme();
  const items = tier.items ?? [];
  const prices = tier.restorationPrices ?? {};

  const restEntries = Object.entries(prices).filter(([, v]) => v != null && v !== "");

  return (
    <View style={{ marginBottom: 8 }}>
      <SectionHeader title={tier.name + (tier.isDefault ? " · Default" : "")} />
      <Card style={{ marginHorizontal: 16 }} padding="none">
        {items.length === 0 && restEntries.length === 0 ? (
          <View style={{ padding: 20, alignItems: "center" }}>
            <Text style={{ fontSize: 13, color: colors.textTertiary }}>No items configured for this tier</Text>
          </View>
        ) : null}
        {items.map((item, idx) => (
          <Pressable
            key={item.id || idx}
            onPress={() => isAdmin && onEditItem(tier.id, item)}
            style={[{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }, idx === items.length - 1 && { borderBottomWidth: 0 }]}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ fontSize: 14, fontFamily: "Inter_400Regular", color: colors.text }} numberOfLines={2}>{item.description ?? item.material ?? "—"}</Text>
              {item.unit && <Text style={{ fontSize: 11, color: colors.textTertiary }}>per {item.unit}</Text>}
            </View>
            <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: colors.tint }}>{fmtPrice(item.price, null)}</Text>
            {isAdmin && <Ionicons name="create-outline" size={14} color={colors.textTertiary} style={{ marginLeft: 8 }} />}
          </Pressable>
        ))}
        {restEntries.map(([key, val], idx) => (
          <Pressable
            key={key}
            onPress={() => isAdmin && onEditItem(tier.id, { key, price: val, description: key.replace(/_/g, " ") })}
            style={[{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }, idx === restEntries.length - 1 && { borderBottomWidth: 0 }]}
          >
            <Text style={{ flex: 1, fontSize: 14, fontFamily: "Inter_400Regular", color: colors.text }} numberOfLines={1}>{key.replace(/_/g, " ")}</Text>
            <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: colors.tint }}>{fmtPrice(val, null)}</Text>
            {isAdmin && <Ionicons name="create-outline" size={14} color={colors.textTertiary} style={{ marginLeft: 8 }} />}
          </Pressable>
        ))}
      </Card>
    </View>
  );
}

function OverrideCard({ override, onHistory }: { override: PricingOverride; onHistory: (id: string) => void }) {
  const { colors } = useTheme();
  const practiceName = override.providerOrganization?.displayName ?? override.providerOrganization?.name ?? override.providerOrganizationId;
  const tierName = override.tier?.name ?? override.tierId ?? "Custom";
  const prices = override.restorationPrices ?? {};
  const priceEntries = Object.entries(prices).filter(([, v]) => v != null && v !== "");

  function fmtDate(d?: string | null) {
    if (!d) return null;
    return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  return (
    <Card style={{ marginHorizontal: 16, marginBottom: 10 }} padding="none">
      <Pressable onPress={() => onHistory(override.id)} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14, borderBottomWidth: priceEntries.length ? StyleSheet.hairlineWidth : 0, borderBottomColor: colors.border }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: colors.text }} numberOfLines={1}>{practiceName}</Text>
          <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>Tier: {tierName}</Text>
          {override.updatedAt && <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: 2 }}>Updated {fmtDate(override.updatedAt)}</Text>}
        </View>
        <Ionicons name="time-outline" size={18} color={colors.tint} />
      </Pressable>
      {priceEntries.slice(0, 4).map(([key, val]) => (
        <View key={key} style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
          <Text style={{ fontSize: 13, color: colors.textSecondary }}>{key.replace(/_/g, " ")}</Text>
          <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: colors.tint }}>{fmtPrice(val, null)}</Text>
        </View>
      ))}
      {priceEntries.length > 4 && (
        <View style={{ padding: 10, alignItems: "center" }}>
          <Text style={{ fontSize: 12, color: colors.textTertiary }}>+{priceEntries.length - 4} more overrides</Text>
        </View>
      )}
    </Card>
  );
}

function EditItemModal({
  visible,
  item,
  onClose,
  onSave,
}: {
  visible: boolean;
  item: any | null;
  onClose: () => void;
  onSave: (price: string, unit: string) => Promise<void>;
}) {
  const { colors } = useTheme();
  const [price, setPrice] = useState("");
  const [unit, setUnit] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (item) {
      setPrice(item.price != null ? String(item.price) : "");
      setUnit(item.unit ?? "");
    }
  }, [item]);

  async function handleSave() {
    setSaving(true);
    await onSave(price, unit).finally(() => setSaving(false));
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 40 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <Text style={{ fontSize: 17, fontFamily: "Inter_700Bold", color: colors.text }}>Edit Price</Text>
            <Pressable onPress={onClose} hitSlop={8}><Ionicons name="close" size={22} color={colors.textSecondary} /></Pressable>
          </View>
          {item?.description && <Text style={{ fontSize: 14, color: colors.textSecondary, marginBottom: 16, fontFamily: "Inter_400Regular" }}>{item.description}</Text>}
          <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: colors.textSecondary, marginBottom: 6 }}>Price ($)</Text>
          <TextInput value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={colors.textTertiary} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 11, fontSize: 16, fontFamily: "Inter_600SemiBold", color: colors.text, backgroundColor: colors.canvas, marginBottom: 14 }} />
          <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: colors.textSecondary, marginBottom: 6 }}>Unit (optional)</Text>
          <TextInput value={unit} onChangeText={setUnit} placeholder="unit, arch, per tooth…" placeholderTextColor={colors.textTertiary} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 11, fontSize: 14, fontFamily: "Inter_400Regular", color: colors.text, backgroundColor: colors.canvas, marginBottom: 16 }} />
          <Pressable onPress={handleSave} disabled={saving} style={{ backgroundColor: colors.tint, borderRadius: 12, paddingVertical: 14, alignItems: "center" }}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={{ color: "#fff", fontFamily: "Inter_600SemiBold", fontSize: 15 }}>Save Price</Text>}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export default function PricingScreen() {
  const { colors } = useTheme();
  const { labId, isAdmin } = useLab();
  const [tab, setTab] = useState<PricingTab>("tiers");
  const [tiers, setTiers] = useState<PricingTier[]>([]);
  const [overrides, setOverrides] = useState<PricingOverride[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editItem, setEditItem] = useState<{ tierId: string; item: any } | null>(null);
  const [historyOverrideId, setHistoryOverrideId] = useState<string | null>(null);

  const loadTiers = useCallback(async (orgId: string) => {
    try {
      const res = await resilientFetch(`/api/pricing/tiers?organizationId=${orgId}`);
      const body = await res.json().catch(() => ({}));
      setTiers(Array.isArray(body) ? body : body?.data ?? body?.tiers ?? []);
    } catch {}
  }, []);

  const loadOverrides = useCallback(async (orgId: string) => {
    try {
      const res = await resilientFetch(`/api/pricing/overrides?organizationId=${orgId}`);
      const body = await res.json().catch(() => ({}));
      setOverrides(Array.isArray(body) ? body : body?.data ?? body?.overrides ?? []);
    } catch {}
  }, []);

  const loadAll = useCallback(async (isRefresh = false) => {
    if (!labId) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    await Promise.all([loadTiers(labId), loadOverrides(labId)]);
    setLoading(false);
    setRefreshing(false);
  }, [labId, loadTiers, loadOverrides]);

  useEffect(() => { if (labId) void loadAll(); }, [labId]);

  async function saveItemPrice(price: string, _unit: string) {
    if (!editItem || !labId) { setEditItem(null); return; }
    const { tierId, item } = editItem;
    if (!item?.key) { setEditItem(null); return; }
    const tier = tiers.find((t) => t.id === tierId);
    const currentPrices: Record<string, number | string | null> = { ...(tier?.restorationPrices ?? {}) };
    currentPrices[item.key] = price ? Number(price) : null;
    try {
      await resilientFetch(`/api/pricing/tiers/${tierId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prices: currentPrices }),
      });
      setEditItem(null);
      void loadTiers(labId);
    } catch {
      Alert.alert("Error", "Failed to update price. Please try again.");
    }
  }

  const TABS: { id: PricingTab; label: string }[] = [
    { id: "tiers", label: "Tiers" },
    { id: "overrides", label: "Overrides" },
    { id: "history", label: "History" },
  ];

  function renderTiers() {
    if (tiers.length === 0) {
      return <EmptyState icon="pricetag-outline" title="No pricing tiers" description="Pricing tiers can be configured by your lab administrator." />;
    }
    return (
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40, paddingTop: 8 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadAll(true)} tintColor={colors.tint} />}
      >
        {tiers.map((tier) => (
          <TierDetail
            key={tier.id}
            tier={tier}
            isAdmin={isAdmin}
            onEditItem={(tierId, item) => setEditItem({ tierId, item })}
          />
        ))}
      </ScrollView>
    );
  }

  function renderOverrides() {
    if (overrides.length === 0) {
      return <EmptyState icon="git-branch-outline" title="No overrides" description="Per-practice pricing overrides will appear here. Set them from the Practices page." />;
    }
    return (
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40, paddingTop: 8 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadAll(true)} tintColor={colors.tint} />}
      >
        <Text style={{ fontSize: 12, color: colors.textTertiary, paddingHorizontal: 16, paddingBottom: 8, fontFamily: "Inter_400Regular" }}>
          Tap an override to view its change history
        </Text>
        {overrides.map((o) => (
          <OverrideCard key={o.id} override={o} onHistory={(id) => setHistoryOverrideId(id)} />
        ))}
      </ScrollView>
    );
  }

  function renderHistory() {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 40 }}>
        <Ionicons name="time-outline" size={40} color={colors.textTertiary} />
        <Text style={{ fontSize: 15, fontFamily: "Inter_500Medium", color: colors.textSecondary, marginTop: 12, textAlign: "center" }}>
          Override History
        </Text>
        <Text style={{ fontSize: 13, color: colors.textTertiary, marginTop: 8, textAlign: "center", lineHeight: 18 }}>
          Select an override from the Overrides tab to view its complete change history.
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.backgroundSolid }}>
      <Stack.Screen options={{ headerShown: false }} />
      <AppHeader title="Pricing" showSearch={false} />
      <FilterBar filters={TABS} activeId={tab} onSelect={(id) => setTab(id as PricingTab)} />

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : (
        <>
          {tab === "tiers" && renderTiers()}
          {tab === "overrides" && renderOverrides()}
          {tab === "history" && renderHistory()}
        </>
      )}

      <EditItemModal
        visible={!!editItem}
        item={editItem?.item ?? null}
        onClose={() => setEditItem(null)}
        onSave={saveItemPrice}
      />

      {historyOverrideId && (
        <OverrideHistoryModal
          visible={!!historyOverrideId}
          onClose={() => setHistoryOverrideId(null)}
          overrideId={historyOverrideId}
        />
      )}
    </View>
  );
}
