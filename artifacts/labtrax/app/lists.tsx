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
import { EmptyState } from "@/components/ui/EmptyState";
import { Card } from "@/components/ui/Card";
import { resilientFetch } from "@/lib/query-client";

type ListTab = "vendors" | "employees" | "items" | "categories";

function useLab() {
  const [labId, setLabId] = useState<string | null>(null);
  useEffect(() => {
    resilientFetch("/api/auth/me")
      .then((r) => r.json().catch(() => ({})))
      .then((me) => {
        const memberships: any[] = me?.memberships ?? me?.user?.memberships ?? [];
        const lab = memberships.find(
          (m: any) => m.status === "active" && (m.organization?.type === "lab" || m.labId)
        );
        setLabId(lab?.labId ?? lab?.organizationId ?? null);
      })
      .catch(() => {});
  }, []);
  return labId;
}

interface AddEditModalProps {
  visible: boolean;
  title: string;
  fields: { key: string; label: string; placeholder: string; multiline?: boolean }[];
  values: Record<string, string>;
  onChangeValue: (key: string, val: string) => void;
  onSave: () => void;
  onClose: () => void;
  saving?: boolean;
}

function AddEditModal({ visible, title, fields, values, onChangeValue, onSave, onClose, saving }: AddEditModalProps) {
  const { colors } = useTheme();
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, paddingBottom: 40 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
            <Text style={{ fontSize: 17, fontFamily: "Inter_700Bold", color: colors.text }}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={8}><Ionicons name="close" size={22} color={colors.textSecondary} /></Pressable>
          </View>
          {fields.map((f) => (
            <View key={f.key} style={{ marginBottom: 16 }}>
              <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: colors.textSecondary, marginBottom: 6 }}>{f.label}</Text>
              <TextInput
                value={values[f.key] ?? ""}
                onChangeText={(v) => onChangeValue(f.key, v)}
                placeholder={f.placeholder}
                placeholderTextColor={colors.textTertiary}
                multiline={f.multiline}
                numberOfLines={f.multiline ? 3 : 1}
                style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 14, paddingVertical: f.multiline ? 10 : 12, fontSize: 15, fontFamily: "Inter_400Regular", color: colors.text, backgroundColor: colors.canvas, minHeight: f.multiline ? 70 : undefined }}
              />
            </View>
          ))}
          <Pressable
            onPress={onSave}
            disabled={saving}
            style={{ backgroundColor: colors.tint, borderRadius: 12, paddingVertical: 14, alignItems: "center" }}
          >
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={{ color: "#fff", fontFamily: "Inter_600SemiBold", fontSize: 15 }}>Save</Text>}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function VendorsList({ labId }: { labId: string }) {
  const { colors } = useTheme();
  const [vendors, setVendors] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [modalVisible, setModalVisible] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await resilientFetch(`/api/finance/vendors?organizationId=${labId}`);
      const body = await res.json().catch(() => ({}));
      setVendors(Array.isArray(body) ? body : body?.data ?? []);
    } catch {} finally {
      setLoading(false); setRefreshing(false);
    }
  }, [labId]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return vendors.filter((v) =>
      !v.isArchived && (!q || (v.name || "").toLowerCase().includes(q) || (v.vendorType || "").toLowerCase().includes(q))
    );
  }, [vendors, search]);

  function openAdd() { setEditing(null); setForm({}); setModalVisible(true); }
  function openEdit(v: any) { setEditing(v); setForm({ name: v.name ?? "", email: v.email ?? "", phone: v.phone ?? "", notes: v.notes ?? "" }); setModalVisible(true); }

  async function save() {
    if (!form.name?.trim()) return;
    setSaving(true);
    try {
      if (editing) {
        await resilientFetch(`/api/finance/vendors/${editing.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: form.name, email: form.email || null, phone: form.phone || null, notes: form.notes || null }) });
      } else {
        await resilientFetch("/api/finance/vendors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId: labId, name: form.name, email: form.email || null, phone: form.phone || null, notes: form.notes || null }) });
      }
      setModalVisible(false);
      void load();
    } catch {} finally { setSaving(false); }
  }

  async function archive(v: any) {
    Alert.alert("Archive Vendor", `Archive "${v.name}"?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Archive", style: "destructive", onPress: async () => {
        await resilientFetch(`/api/finance/vendors/${v.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isArchived: true }) }).catch(() => {});
        void load();
      }},
    ]);
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
        <Ionicons name="search" size={16} color={colors.textTertiary} />
        <TextInput style={{ flex: 1, fontSize: 14, color: colors.text, fontFamily: "Inter_400Regular" }} placeholder="Search vendors…" placeholderTextColor={colors.textTertiary} value={search} onChangeText={setSearch} />
        <Pressable onPress={openAdd} style={{ backgroundColor: colors.tint, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 }}>
          <Text style={{ color: "#fff", fontSize: 13, fontFamily: "Inter_600SemiBold" }}>+ Add</Text>
        </Pressable>
      </View>
      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.tint} />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(v) => v.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={colors.tint} />}
          contentContainerStyle={{ paddingBottom: 40 }}
          ListEmptyComponent={<EmptyState icon="storefront-outline" title="No vendors" description="Add vendors to track payments and expenses." />}
          renderItem={({ item: v }) => (
            <Pressable onPress={() => openEdit(v)} style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surface }}>
              <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.tint + "20", alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                <Ionicons name="storefront-outline" size={18} color={colors.tint} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: colors.text }} numberOfLines={1}>{v.name}</Text>
                {v.email ? <Text style={{ fontSize: 12, color: colors.textSecondary }} numberOfLines={1}>{v.email}</Text> : null}
                {v.phone ? <Text style={{ fontSize: 12, color: colors.textTertiary }} numberOfLines={1}>{v.phone}</Text> : null}
              </View>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Pressable onPress={() => archive(v)} hitSlop={8}><Ionicons name="archive-outline" size={18} color={colors.textTertiary} /></Pressable>
                <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
              </View>
            </Pressable>
          )}
        />
      )}
      <AddEditModal
        visible={modalVisible}
        title={editing ? "Edit Vendor" : "Add Vendor"}
        fields={[
          { key: "name", label: "Name *", placeholder: "Vendor name" },
          { key: "email", label: "Email", placeholder: "vendor@example.com" },
          { key: "phone", label: "Phone", placeholder: "(555) 555-5555" },
          { key: "notes", label: "Notes", placeholder: "Optional notes", multiline: true },
        ]}
        values={form}
        onChangeValue={(k, v) => setForm((p) => ({ ...p, [k]: v }))}
        onSave={save}
        onClose={() => setModalVisible(false)}
        saving={saving}
      />
    </View>
  );
}

function EmployeesList({ labId }: { labId: string }) {
  const { colors } = useTheme();
  const [employees, setEmployees] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await resilientFetch(`/api/organizations/${labId}/members`);
      const body = await res.json().catch(() => ({}));
      setEmployees(Array.isArray(body) ? body : body?.data ?? body?.members ?? []);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, [labId]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return employees.filter((e) =>
      !q ||
      (e.firstName || "").toLowerCase().includes(q) ||
      (e.lastName || "").toLowerCase().includes(q) ||
      (e.username || "").toLowerCase().includes(q) ||
      (e.email || "").toLowerCase().includes(q)
    );
  }, [employees, search]);

  const roleColor = (role: string) => {
    if (role === "owner" || role === "admin") return colors.tint;
    if (role === "billing") return colors.success;
    return colors.textSecondary;
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
        <Ionicons name="search" size={16} color={colors.textTertiary} />
        <TextInput style={{ flex: 1, fontSize: 14, color: colors.text, fontFamily: "Inter_400Regular" }} placeholder="Search employees…" placeholderTextColor={colors.textTertiary} value={search} onChangeText={setSearch} />
      </View>
      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><ActivityIndicator color={colors.tint} /></View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(e) => e.id ?? e.userId}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={colors.tint} />}
          contentContainerStyle={{ paddingBottom: 40 }}
          ListEmptyComponent={<EmptyState icon="people-outline" title="No employees" description="Lab staff and members will appear here." />}
          renderItem={({ item: e }) => {
            const name = [e.firstName, e.lastName].filter(Boolean).join(" ") || e.username || "User";
            const initials = (e.initials || name.split(" ").map((n: string) => n[0]).join("")).toUpperCase().slice(0, 2);
            return (
              <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surface }}>
                <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: colors.tint + "25", alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                  <Text style={{ fontSize: 14, fontFamily: "Inter_700Bold", color: colors.tint }}>{initials || "U"}</Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: colors.text }}>{name}</Text>
                  {e.email ? <Text style={{ fontSize: 12, color: colors.textSecondary }} numberOfLines={1}>{e.email}</Text> : null}
                </View>
                <View style={{ backgroundColor: roleColor(e.role || e.membershipRole || "user") + "20", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                  <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: roleColor(e.role || e.membershipRole || "user") }}>
                    {(e.role || e.membershipRole || "staff").replace(/_/g, " ")}
                  </Text>
                </View>
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

function ItemsList({ labId }: { labId: string }) {
  const { colors } = useTheme();
  const [items, setItems] = useState<Array<{ key: string; label: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await resilientFetch(`/api/pricing/item-labels?labOrganizationId=${labId}`);
      const body = await res.json().catch(() => ({}));
      const labelMap: Record<string, string> = body?.labels ?? body ?? {};
      setItems(Object.entries(labelMap).map(([key, label]) => ({ key, label: typeof label === "string" ? label : key })));
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, [labId]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return items.filter((i) => !q || i.label.toLowerCase().includes(q) || i.key.toLowerCase().includes(q));
  }, [items, search]);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
        <Ionicons name="search" size={16} color={colors.textTertiary} />
        <TextInput style={{ flex: 1, fontSize: 14, color: colors.text, fontFamily: "Inter_400Regular" }} placeholder="Search items…" placeholderTextColor={colors.textTertiary} value={search} onChangeText={setSearch} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingBottom: 8, paddingTop: 4 }}>
        <Ionicons name="information-circle-outline" size={14} color={colors.textTertiary} />
        <Text style={{ fontSize: 11, color: colors.textTertiary, fontFamily: "Inter_400Regular" }}>Manage item prices in Pricing → Tiers</Text>
      </View>
      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><ActivityIndicator color={colors.tint} /></View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(i) => i.key}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={colors.tint} />}
          contentContainerStyle={{ paddingBottom: 40 }}
          ListEmptyComponent={<EmptyState icon="cube-outline" title="No items" description="Restoration types and items will appear here once pricing is configured." />}
          renderItem={({ item: i }) => (
            <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surface }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: colors.text }} numberOfLines={1}>{i.label}</Text>
                <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: 1 }}>{i.key}</Text>
              </View>
              <View style={{ backgroundColor: colors.tint + "15", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: colors.tint }}>item</Text>
              </View>
            </View>
          )}
        />
      )}
    </View>
  );
}

function CategoriesList({ labId }: { labId: string }) {
  const { colors } = useTheme();
  const [categories, setCategories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [modalVisible, setModalVisible] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await resilientFetch(`/api/finance/categories?organizationId=${labId}`);
      const body = await res.json().catch(() => ({}));
      setCategories(Array.isArray(body) ? body : body?.data ?? []);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, [labId]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return categories.filter((c) => !c.isArchived && (!q || (c.name || "").toLowerCase().includes(q)));
  }, [categories, search]);

  function openAdd() { setEditing(null); setForm({ kind: "expense" }); setModalVisible(true); }
  function openEdit(c: any) { setEditing(c); setForm({ name: c.name ?? "", kind: c.kind ?? "expense", description: c.description ?? "" }); setModalVisible(true); }

  async function save() {
    if (!form.name?.trim()) return;
    setSaving(true);
    try {
      if (editing) {
        await resilientFetch(`/api/finance/categories/${editing.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: form.name, kind: form.kind, description: form.description || null }) });
      } else {
        await resilientFetch("/api/finance/categories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId: labId, name: form.name, kind: form.kind || "expense", description: form.description || null }) });
      }
      setModalVisible(false);
      void load();
    } catch {} finally { setSaving(false); }
  }

  const kindColor = (kind: string) => {
    if (kind === "income") return colors.success;
    if (kind === "transfer") return colors.tint;
    return colors.warningStrong;
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
        <Ionicons name="search" size={16} color={colors.textTertiary} />
        <TextInput style={{ flex: 1, fontSize: 14, color: colors.text, fontFamily: "Inter_400Regular" }} placeholder="Search categories…" placeholderTextColor={colors.textTertiary} value={search} onChangeText={setSearch} />
        <Pressable onPress={openAdd} style={{ backgroundColor: colors.tint, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 }}>
          <Text style={{ color: "#fff", fontSize: 13, fontFamily: "Inter_600SemiBold" }}>+ Add</Text>
        </Pressable>
      </View>
      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><ActivityIndicator color={colors.tint} /></View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(c) => c.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={colors.tint} />}
          contentContainerStyle={{ paddingBottom: 40 }}
          ListEmptyComponent={<EmptyState icon="pricetag-outline" title="No categories" description="Transaction categories for organizing expenses and income." />}
          renderItem={({ item: c }) => (
            <Pressable onPress={() => openEdit(c)} style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surface }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: colors.text }} numberOfLines={1}>{c.name}</Text>
                {c.description ? <Text style={{ fontSize: 12, color: colors.textSecondary }} numberOfLines={1}>{c.description}</Text> : null}
              </View>
              <View style={{ backgroundColor: kindColor(c.kind || "expense") + "20", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, marginRight: 8 }}>
                <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: kindColor(c.kind || "expense") }}>{c.kind || "expense"}</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
            </Pressable>
          )}
        />
      )}
      <AddEditModal
        visible={modalVisible}
        title={editing ? "Edit Category" : "Add Category"}
        fields={[
          { key: "name", label: "Name *", placeholder: "Category name" },
          { key: "description", label: "Description", placeholder: "Optional description" },
        ]}
        values={form}
        onChangeValue={(k, v) => setForm((p) => ({ ...p, [k]: v }))}
        onSave={save}
        onClose={() => setModalVisible(false)}
        saving={saving}
      />
    </View>
  );
}

export default function ListsScreen() {
  const { colors } = useTheme();
  const labId = useLab();
  const [tab, setTab] = useState<ListTab>("vendors");

  const TABS = [
    { id: "vendors", label: "Vendors" },
    { id: "employees", label: "Employees" },
    { id: "items", label: "Items" },
    { id: "categories", label: "Categories" },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.backgroundSolid }}>
      <Stack.Screen options={{ headerShown: false }} />
      <AppHeader title="Lists" showSearch={false} />
      <FilterBar filters={TABS} activeId={tab} onSelect={(id) => setTab(id as ListTab)} />
      {!labId ? (
        <EmptyState icon="list-outline" title="Loading…" description="Resolving lab access…" />
      ) : (
        <>
          {tab === "vendors" && <VendorsList labId={labId} />}
          {tab === "employees" && <EmployeesList labId={labId} />}
          {tab === "items" && <ItemsList labId={labId} />}
          {tab === "categories" && <CategoriesList labId={labId} />}
        </>
      )}
    </View>
  );
}
