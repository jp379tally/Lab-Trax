import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, router as expoRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { getAccessToken, getApiUrl } from "@/lib/query-client";
import { useApp } from "@/lib/app-context";
import { formatPhone } from "@/lib/data";

interface ProviderOrg {
  id: string;
  name: string;
  displayName?: string | null;
  phone?: string | null;
  billingEmail?: string | null;
  city?: string | null;
  state?: string | null;
  deletedAt?: string | null;
}

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  providerOrganizationId: string;
  status: string;
  total?: string | number | null;
  balanceDue?: string | number | null;
  issuedAt?: string | null;
  dueAt?: string | null;
}

function fmtMoney(v?: string | number | null) {
  const n = Number(v) || 0;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtDate(d?: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

async function apiFetch<T>(
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(`/api${path}`, getApiUrl()).toString();
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

interface EligibleDoctor {
  id: string;
  username: string;
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  doctorName?: string | null;
  platformAccountNumber?: string | null;
  currentPractices: string[];
  virtual?: boolean;
}

export default function CustomersScreen() {
  const insets = useSafeAreaInsets();
  const { invoices: appInvoices, setPendingInvoiceEditId, role } = useApp();
  const [orgs, setOrgs] = useState<ProviderOrg[]>([]);
  const [apiInvoices, setApiInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addDoctorOpen, setAddDoctorOpen] = useState(false);
  const isLabAdmin = role === "admin";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [orgsData, invData] = await Promise.all([
          apiFetch<(ProviderOrg & { type?: string })[]>("/organizations"),
          apiFetch<InvoiceRow[]>("/invoices"),
        ]);
        if (!cancelled) {
          setOrgs(
            orgsData.filter(
              (o) =>
                o.deletedAt == null &&
                (o.type === "provider" || o.type === "practice")
            )
          );
          setApiInvoices(invData);
        }
      } catch {
        // swallow
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function openInvoice(apiInvoiceId: string) {
    const local = appInvoices.find((i) => i.serverId === apiInvoiceId || i.id === apiInvoiceId);
    if (local) {
      setPendingInvoiceEditId(local.id);
      expoRouter.push("/(tabs)" as any);
    }
  }

  const openBalanceByOrg = useMemo(() => {
    const map = new Map<string, number>();
    for (const inv of apiInvoices) {
      const isOpen = inv.status === "open" || inv.status === "partially_paid";
      if (!isOpen) continue;
      const bal = Number(inv.balanceDue ?? inv.total ?? 0);
      map.set(inv.providerOrganizationId, (map.get(inv.providerOrganizationId) ?? 0) + bal);
    }
    return map;
  }, [apiInvoices]);

  const invoiceCountByOrg = useMemo(() => {
    const map = new Map<string, number>();
    for (const inv of apiInvoices) {
      map.set(inv.providerOrganizationId, (map.get(inv.providerOrganizationId) ?? 0) + 1);
    }
    return map;
  }, [apiInvoices]);

  const filteredOrgs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orgs
      .filter((o) => {
        if (!q) return true;
        return (
          o.name.toLowerCase().includes(q) ||
          (o.displayName || "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) =>
        (a.displayName || a.name).localeCompare(b.displayName || b.name)
      );
  }, [orgs, search]);

  const selectedOrg = orgs.find((o) => o.id === selectedId) ?? null;

  const orgInvoices = useMemo(() => {
    if (!selectedId) return [];
    return apiInvoices
      .filter((inv) => inv.providerOrganizationId === selectedId)
      .sort((a, b) =>
        (b.issuedAt || "").localeCompare(a.issuedAt || "")
      );
  }, [apiInvoices, selectedId]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator size="large" color={Colors.light.tint} />
      </View>
    );
  }

  if (selectedOrg) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.header}>
          <Pressable
            onPress={() => setSelectedId(null)}
            style={styles.backBtn}
            hitSlop={8}
          >
            <Ionicons name="chevron-back" size={22} color={Colors.light.tint} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {selectedOrg.displayName || selectedOrg.name}
            </Text>
            <Text style={styles.headerSub}>
              {invoiceCountByOrg.get(selectedOrg.id) ?? 0} invoice
              {(invoiceCountByOrg.get(selectedOrg.id) ?? 0) !== 1 ? "s" : ""}
            </Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={styles.balanceLabel}>Open balance</Text>
            <Text
              style={[
                styles.balanceValue,
                (openBalanceByOrg.get(selectedOrg.id) ?? 0) > 0 && { color: "#D97706" },
              ]}
            >
              {fmtMoney(openBalanceByOrg.get(selectedOrg.id) ?? 0)}
            </Text>
          </View>
        </View>

        {isLabAdmin && !selectedOrg.deletedAt && (
          <View style={styles.actionsBar}>
            <Pressable
              onPress={() => setAddDoctorOpen(true)}
              style={({ pressed }) => [styles.addDoctorBtn, pressed && { opacity: 0.85 }]}
              testID="add-doctor-to-practice"
            >
              <Ionicons name="person-add-outline" size={14} color="#fff" />
              <Text style={styles.addDoctorBtnText}>Add doctor to practice</Text>
            </Pressable>
          </View>
        )}

        {/* Practice info strip */}
        <View style={styles.infoStrip}>
          {selectedOrg.phone ? (
            <View style={styles.infoItem}>
              <Ionicons name="call-outline" size={13} color={Colors.light.textSecondary} />
              <Text style={styles.infoText}>{selectedOrg.phone}</Text>
            </View>
          ) : null}
          {selectedOrg.billingEmail ? (
            <View style={styles.infoItem}>
              <Ionicons name="mail-outline" size={13} color={Colors.light.textSecondary} />
              <Text style={styles.infoText} numberOfLines={1}>
                {selectedOrg.billingEmail}
              </Text>
            </View>
          ) : null}
          {(selectedOrg.city || selectedOrg.state) ? (
            <View style={styles.infoItem}>
              <Ionicons name="location-outline" size={13} color={Colors.light.textSecondary} />
              <Text style={styles.infoText}>
                {[selectedOrg.city, selectedOrg.state].filter(Boolean).join(", ")}
              </Text>
            </View>
          ) : null}
        </View>

        <FlatList
          data={orgInvoices}
          keyExtractor={(inv) => inv.id}
          contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No invoices found.</Text>
            </View>
          }
          renderItem={({ item: inv }) => {
            const isOpen = inv.status === "open" || inv.status === "partially_paid";
            const balance = Number(inv.balanceDue ?? inv.total ?? 0);
            return (
              <Pressable
                style={({ pressed }) => [styles.invoiceRow, pressed && { opacity: 0.7 }]}
                onPress={() => openInvoice(inv.id)}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.invNum}>{inv.invoiceNumber}</Text>
                  <Text style={styles.invDate}>Issued {fmtDate(inv.issuedAt)}</Text>
                  {inv.dueAt && (
                    <Text style={styles.invDate}>Due {fmtDate(inv.dueAt)}</Text>
                  )}
                </View>
                <View style={{ alignItems: "flex-end", gap: 4 }}>
                  <View
                    style={[
                      styles.statusBadge,
                      inv.status === "paid" && { backgroundColor: "#DCFCE7" },
                      (inv.status === "open" || inv.status === "partially_paid") && { backgroundColor: "#FEF9C3" },
                      inv.status === "void" && { backgroundColor: "#F1F5F9" },
                      inv.status === "draft" && { backgroundColor: "#F1F5F9" },
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusText,
                        inv.status === "paid" && { color: "#16A34A" },
                        (inv.status === "open" || inv.status === "partially_paid") && { color: "#D97706" },
                        (inv.status === "void" || inv.status === "draft") && { color: "#64748B" },
                      ]}
                    >
                      {inv.status.replace(/_/g, " ")}
                    </Text>
                  </View>
                  <Text style={styles.invTotal}>{fmtMoney(inv.total)}</Text>
                  {isOpen && balance > 0 && (
                    <Text style={[styles.invBalance, { color: "#D97706" }]}>
                      bal {fmtMoney(balance)}
                    </Text>
                  )}
                </View>
                <Ionicons name="chevron-forward" size={16} color={Colors.light.textSecondary} style={{ marginLeft: 8 }} />
              </Pressable>
            );
          }}
        />

        <AddDoctorToPracticeModal
          visible={addDoctorOpen}
          org={selectedOrg}
          onClose={() => setAddDoctorOpen(false)}
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Pressable
          onPress={() => expoRouter.back()}
          style={styles.backBtn}
          hitSlop={8}
        >
          <Ionicons name="chevron-back" size={22} color={Colors.light.tint} />
        </Pressable>
        <Text style={styles.headerTitle}>Customers</Text>
      </View>

      <View style={styles.searchWrap}>
        <Ionicons
          name="search-outline"
          size={16}
          color={Colors.light.textSecondary}
          style={{ position: "absolute", left: 12, top: "50%", marginTop: -8 }}
        />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search practices…"
          placeholderTextColor={Colors.light.textSecondary}
          style={styles.searchInput}
        />
      </View>

      <FlatList
        data={filteredOrgs}
        keyExtractor={(o) => o.id}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No practices found.</Text>
          </View>
        }
        renderItem={({ item: org }) => {
          const balance = openBalanceByOrg.get(org.id) ?? 0;
          const count = invoiceCountByOrg.get(org.id) ?? 0;
          return (
            <Pressable
              style={({ pressed }) => [styles.orgRow, pressed && { opacity: 0.7 }]}
              onPress={() => setSelectedId(org.id)}
            >
              <View style={styles.orgIcon}>
                <Ionicons name="business-outline" size={18} color={Colors.light.tint} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.orgName} numberOfLines={1}>
                  {org.displayName || org.name}
                </Text>
                <Text style={styles.orgSub}>
                  {count} invoice{count !== 1 ? "s" : ""}
                </Text>
                {(org.phone || org.city || org.state) ? (
                  <Text style={styles.orgContact} numberOfLines={1}>
                    {[
                      org.phone,
                      (org.city || org.state)
                        ? [org.city, org.state].filter(Boolean).join(", ")
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                ) : null}
              </View>
              <View style={{ alignItems: "flex-end", marginRight: 4 }}>
                {balance > 0 && (
                  <Text style={styles.orgBalance}>{fmtMoney(balance)}</Text>
                )}
              </View>
              <Ionicons name="chevron-forward" size={16} color={Colors.light.textSecondary} />
            </Pressable>
          );
        }}
      />
    </View>
  );
}

interface AddDoctorToPracticeModalProps {
  visible: boolean;
  org: ProviderOrg;
  onClose: () => void;
}

function AddDoctorToPracticeModal({ visible, org, onClose }: AddDoctorToPracticeModalProps) {
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // new-doctor fields
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  // existing-doctor picker
  const [eligible, setEligible] = useState<EligibleDoctor[]>([]);
  const [eligibleLoading, setEligibleLoading] = useState(false);
  const [eligibleError, setEligibleError] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [search, setSearch] = useState("");

  // Reset everything when the modal opens.
  useEffect(() => {
    if (!visible) return;
    setMode("new");
    setError(null);
    setSuccess(null);
    setFirstName("");
    setLastName("");
    setEmail("");
    setPhone("");
    setSelectedUserId("");
    setSearch("");
    setSubmitting(false);
  }, [visible, org.id]);

  // Load eligible doctors lazily when the "existing" tab is opened.
  useEffect(() => {
    if (!visible || mode !== "existing") return;
    let cancelled = false;
    setEligibleLoading(true);
    setEligibleError(null);
    apiFetch<EligibleDoctor[]>(`/organizations/${org.id}/eligible-doctors`)
      .then((rows) => {
        if (!cancelled) setEligible(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setEligibleError(err instanceof Error ? err.message : "Failed to load doctors.");
        }
      })
      .finally(() => {
        if (!cancelled) setEligibleLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, mode, org.id]);

  const filteredEligible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return eligible;
    return eligible.filter((u) => {
      const name = `${u.firstName ?? ""} ${u.lastName ?? ""}`.toLowerCase();
      return (
        name.includes(q) ||
        (u.email ?? "").toLowerCase().includes(q) ||
        (u.username ?? "").toLowerCase().includes(q) ||
        (u.platformAccountNumber ?? "").toLowerCase().includes(q) ||
        (u.doctorName ?? "").toLowerCase().includes(q)
      );
    });
  }, [eligible, search]);

  async function submitNewDoctor() {
    const fName = firstName.trim();
    if (!fName) {
      setError("First name is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch<{
        created: Array<{ firstName?: string | null; lastName?: string | null }>;
        skipped: Array<{ index: number; reason: string }>;
      }>(`/organizations/${org.id}/doctors`, {
        method: "POST",
        body: {
          doctors: [
            {
              firstName: fName,
              lastName: lastName.trim(),
              email: email.trim() || undefined,
              phone: phone.trim() || undefined,
            },
          ],
        },
      });
      const skipped = res.skipped?.[0];
      if (skipped) {
        setError(skipped.reason || "Could not add doctor.");
        return;
      }
      const d = res.created?.[0];
      const name = [d?.firstName, d?.lastName].filter(Boolean).join(" ") || "Doctor";
      setSuccess(`${name} added to ${org.displayName || org.name}.`);
      setFirstName("");
      setLastName("");
      setEmail("");
      setPhone("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not add doctor.");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitLinkExisting() {
    if (!selectedUserId) {
      setError("Pick a doctor from the list first.");
      return;
    }
    const selectedDoc = eligible.find((u) => u.id === selectedUserId);
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      // "Virtual" doctors (extracted from case history with no real account)
      // need an account created first; mirror the desktop's two-step flow.
      if (selectedDoc?.virtual) {
        const raw = (selectedDoc.doctorName || selectedDoc.username || "").trim();
        const stripped = raw.replace(/^dr\.?\s+/i, "").trim();
        const parts = stripped.split(/\s+/);
        const fName = parts[0] || "Doctor";
        const lName = parts.slice(1).join(" ") || undefined;
        const res = await apiFetch<{
          created: Array<{ firstName?: string | null; lastName?: string | null }>;
          skipped: Array<{ index: number; reason: string }>;
        }>(`/organizations/${org.id}/doctors`, {
          method: "POST",
          body: { doctors: [{ firstName: fName, lastName: lName }] },
        });
        const skipped = res.skipped?.[0];
        if (skipped) {
          setError(skipped.reason || "Could not create doctor account.");
          return;
        }
        const d = res.created?.[0];
        const name = [d?.firstName, d?.lastName].filter(Boolean).join(" ") || "Doctor";
        setSuccess(`${name} added to ${org.displayName || org.name}.`);
      } else {
        const res = await apiFetch<{ firstName?: string | null; lastName?: string | null }>(
          `/organizations/${org.id}/doctors/link`,
          { method: "POST", body: { userId: selectedUserId } }
        );
        const name = [res.firstName, res.lastName].filter(Boolean).join(" ") || "Doctor";
        setSuccess(`${name} linked to ${org.displayName || org.name}.`);
      }
      setSelectedUserId("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not link doctor.");
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
    // Best-effort refresh of the picker — the just-added doctor should drop
    // off the list. Failure here must NOT clobber the success banner above.
    setEligibleLoading(true);
    try {
      const rows = await apiFetch<EligibleDoctor[]>(`/organizations/${org.id}/eligible-doctors`);
      setEligible(rows);
    } catch {
      // ignore refresh failure; the link/create itself succeeded.
    } finally {
      setEligibleLoading(false);
    }
  }

  function handleSubmit() {
    if (mode === "new") submitNewDoctor();
    else submitLinkExisting();
  }

  const submitDisabled =
    submitting || (mode === "new" ? !firstName.trim() : !selectedUserId);

  const selectedVirtual =
    mode === "existing" &&
    selectedUserId &&
    eligible.find((u) => u.id === selectedUserId)?.virtual;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: Colors.light.backgroundSolid }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={modalStyles.header}>
          <View style={{ flex: 1 }}>
            <Text style={modalStyles.headerEyebrow}>Practice</Text>
            <Text style={modalStyles.headerTitle} numberOfLines={1}>
              {org.displayName || org.name}
            </Text>
          </View>
          <Pressable onPress={onClose} hitSlop={10} style={modalStyles.closeBtn}>
            <Ionicons name="close" size={22} color={Colors.light.text} />
          </Pressable>
        </View>

        <View style={modalStyles.tabs}>
          <Pressable
            onPress={() => {
              setMode("new");
              setError(null);
              setSuccess(null);
            }}
            style={[modalStyles.tab, mode === "new" && modalStyles.tabActive]}
          >
            <Ionicons
              name="person-add-outline"
              size={14}
              color={mode === "new" ? "#fff" : Colors.light.text}
            />
            <Text style={[modalStyles.tabText, mode === "new" && modalStyles.tabTextActive]}>
              Add new doctor
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setMode("existing");
              setError(null);
              setSuccess(null);
            }}
            style={[modalStyles.tab, mode === "existing" && modalStyles.tabActive]}
          >
            <Ionicons
              name="people-outline"
              size={14}
              color={mode === "existing" ? "#fff" : Colors.light.text}
            />
            <Text style={[modalStyles.tabText, mode === "existing" && modalStyles.tabTextActive]}>
              Pick existing
            </Text>
          </Pressable>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={modalStyles.body}
          keyboardShouldPersistTaps="handled"
        >
          {error && (
            <View style={[modalStyles.banner, { backgroundColor: "#FEE2E2" }]}>
              <Text style={[modalStyles.bannerText, { color: "#B91C1C" }]}>{error}</Text>
            </View>
          )}
          {success && (
            <View style={[modalStyles.banner, { backgroundColor: "#DCFCE7" }]}>
              <Text style={[modalStyles.bannerText, { color: "#15803D" }]}>{success}</Text>
            </View>
          )}

          {mode === "new" ? (
            <View style={{ gap: 12 }}>
              <View style={modalStyles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={modalStyles.label}>First name</Text>
                  <TextInput
                    value={firstName}
                    onChangeText={setFirstName}
                    placeholder="Jane"
                    placeholderTextColor={Colors.light.textSecondary}
                    style={modalStyles.input}
                    autoCapitalize="words"
                    autoFocus
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={modalStyles.label}>Last name</Text>
                  <TextInput
                    value={lastName}
                    onChangeText={setLastName}
                    placeholder="Smith"
                    placeholderTextColor={Colors.light.textSecondary}
                    style={modalStyles.input}
                    autoCapitalize="words"
                  />
                </View>
              </View>
              <View>
                <Text style={modalStyles.label}>Email</Text>
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="optional"
                  placeholderTextColor={Colors.light.textSecondary}
                  style={modalStyles.input}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  autoCorrect={false}
                />
              </View>
              <View>
                <Text style={modalStyles.label}>Phone</Text>
                <TextInput
                  value={phone}
                  onChangeText={(v) => setPhone(formatPhone(v))}
                  placeholder="000-000-0000"
                  placeholderTextColor={Colors.light.textSecondary}
                  style={modalStyles.input}
                  keyboardType="phone-pad"
                />
              </View>
              <Text style={modalStyles.hint}>
                Creates a new doctor account at this practice. They'll receive
                their own platform account number.
              </Text>
            </View>
          ) : (
            <View style={{ gap: 10 }}>
              <View style={modalStyles.searchWrap}>
                <Ionicons
                  name="search-outline"
                  size={16}
                  color={Colors.light.textSecondary}
                  style={{ position: "absolute", left: 12, top: 12 }}
                />
                <TextInput
                  value={search}
                  onChangeText={setSearch}
                  placeholder="Search existing doctors…"
                  placeholderTextColor={Colors.light.textSecondary}
                  style={modalStyles.searchInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              <View style={modalStyles.list}>
                {eligibleLoading && (
                  <View style={modalStyles.listMsg}>
                    <ActivityIndicator size="small" color={Colors.light.tint} />
                    <Text style={modalStyles.listMsgText}>Loading doctors…</Text>
                  </View>
                )}
                {!eligibleLoading && eligibleError && (
                  <View style={modalStyles.listMsg}>
                    <Text style={[modalStyles.listMsgText, { color: "#B91C1C" }]}>
                      {eligibleError}
                    </Text>
                  </View>
                )}
                {!eligibleLoading && !eligibleError && filteredEligible.length === 0 && (
                  <View style={modalStyles.listMsg}>
                    <Text style={modalStyles.listMsgText}>
                      {eligible.length === 0
                        ? "No existing doctors on the platform to link yet."
                        : "No matches."}
                    </Text>
                  </View>
                )}
                {filteredEligible.map((u) => {
                  const checked = selectedUserId === u.id;
                  const name = u.virtual
                    ? u.doctorName || u.username
                    : [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username;
                  return (
                    <Pressable
                      key={u.id}
                      onPress={() => setSelectedUserId(u.id)}
                      style={[modalStyles.listRow, checked && modalStyles.listRowChecked]}
                    >
                      <View
                        style={[
                          modalStyles.radio,
                          checked && { borderColor: Colors.light.tint },
                        ]}
                      >
                        {checked && <View style={modalStyles.radioDot} />}
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <Text style={modalStyles.listName} numberOfLines={1}>
                            {name}
                          </Text>
                          {u.virtual ? (
                            <View style={[modalStyles.tag, { backgroundColor: "#FEF3C7" }]}>
                              <Text style={[modalStyles.tagText, { color: "#92400E" }]}>
                                no account yet
                              </Text>
                            </View>
                          ) : u.platformAccountNumber ? (
                            <View style={[modalStyles.tag, { backgroundColor: Colors.light.tintLight || "#EFF6FF" }]}>
                              <Text style={[modalStyles.tagText, { color: Colors.light.tint, fontFamily: "Inter_500Medium" }]}>
                                {u.platformAccountNumber}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                        <Text style={modalStyles.listSub} numberOfLines={1}>
                          {u.virtual
                            ? "From case history — will create account"
                            : u.email || u.phone || u.username}
                        </Text>
                        {!u.virtual && u.currentPractices.length > 0 && (
                          <Text style={modalStyles.listSub} numberOfLines={1}>
                            Currently at: {u.currentPractices.join(", ")}
                          </Text>
                        )}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={modalStyles.hint}>
                {eligible.some((u) => u.virtual)
                  ? "Doctors with accounts can be linked instantly. Doctors from case history will get a new account created."
                  : "Links any existing doctor on the platform to this practice without creating a duplicate account."}
              </Text>
            </View>
          )}
        </ScrollView>

        <View style={modalStyles.footer}>
          <Pressable onPress={onClose} style={modalStyles.footerBtnSecondary}>
            <Text style={modalStyles.footerBtnSecondaryText}>Close</Text>
          </Pressable>
          <Pressable
            onPress={handleSubmit}
            disabled={submitDisabled}
            style={[
              modalStyles.footerBtnPrimary,
              submitDisabled && { opacity: 0.5 },
            ]}
          >
            {submitting && <ActivityIndicator size="small" color="#fff" style={{ marginRight: 6 }} />}
            <Text style={modalStyles.footerBtnPrimaryText}>
              {mode === "new"
                ? "Add doctor"
                : selectedVirtual
                  ? "Create & link"
                  : "Link doctor"}
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const modalStyles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.light.border,
    gap: 10,
  },
  headerEyebrow: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  headerTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
    marginTop: 2,
  },
  closeBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  tabs: {
    flexDirection: "row",
    marginHorizontal: 16,
    marginTop: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.light.border,
    borderRadius: 8,
    overflow: "hidden",
  },
  tab: {
    flex: 1,
    height: 34,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: Colors.light.backgroundSolid,
  },
  tabActive: {
    backgroundColor: Colors.light.tint,
  },
  tabText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: Colors.light.text,
  },
  tabTextActive: {
    color: "#fff",
  },
  body: {
    padding: 16,
    paddingBottom: 24,
  },
  banner: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    marginBottom: 12,
  },
  bannerText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  row: {
    flexDirection: "row",
    gap: 10,
  },
  label: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  input: {
    height: 42,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.light.border,
    backgroundColor: Colors.light.surface || "#fff",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
  },
  hint: {
    fontSize: 11,
    color: Colors.light.textSecondary,
    fontFamily: "Inter_400Regular",
    marginTop: 4,
    lineHeight: 16,
  },
  searchWrap: {
    position: "relative",
  },
  searchInput: {
    height: 40,
    paddingLeft: 36,
    paddingRight: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.light.border,
    backgroundColor: Colors.light.surface || "#fff",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
  },
  list: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.light.border,
    backgroundColor: Colors.light.surface || "#fff",
    overflow: "hidden",
    maxHeight: 360,
  },
  listMsg: {
    paddingVertical: 24,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    flexDirection: "row",
  },
  listMsgText: {
    fontSize: 13,
    color: Colors.light.textSecondary,
    fontFamily: "Inter_400Regular",
  },
  listRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.light.border,
  },
  listRowChecked: {
    backgroundColor: Colors.light.tintLight || "#EFF6FF",
  },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: Colors.light.border,
    marginTop: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  radioDot: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: Colors.light.tint,
  },
  listName: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
    flexShrink: 1,
  },
  listSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginTop: 1,
  },
  tag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  tagText: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
  },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.light.border,
    backgroundColor: Colors.light.backgroundSolid,
  },
  footerBtnSecondary: {
    height: 40,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  footerBtnSecondaryText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: Colors.light.text,
  },
  footerBtnPrimary: {
    flexDirection: "row",
    alignItems: "center",
    height: 40,
    paddingHorizontal: 18,
    borderRadius: 8,
    backgroundColor: Colors.light.tint,
  },
  footerBtnPrimaryText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light.backgroundSolid,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: Colors.light.backgroundSolid,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.light.border,
    gap: 10,
  },
  backBtn: {
    padding: 2,
  },
  headerTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
    flex: 1,
  },
  headerSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
  },
  balanceLabel: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  balanceValue: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  infoStrip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.light.border,
    backgroundColor: Colors.light.surface || Colors.light.backgroundSolid,
    gap: 4,
  },
  actionsBar: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 4,
    gap: 8,
  },
  addDoctorBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    height: 34,
    borderRadius: 8,
    backgroundColor: Colors.light.tint,
  },
  addDoctorBtnText: {
    color: "#fff",
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  infoItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  infoText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
  },
  searchWrap: {
    position: "relative",
    marginHorizontal: 16,
    marginVertical: 10,
  },
  searchInput: {
    height: 40,
    paddingLeft: 38,
    paddingRight: 12,
    backgroundColor: Colors.light.surface || "#F1F5F9",
    borderRadius: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
  },
  orgRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.light.border,
    gap: 12,
  },
  orgIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: Colors.light.tintLight || "#EFF6FF",
    alignItems: "center",
    justifyContent: "center",
  },
  orgName: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  orgSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginTop: 1,
  },
  orgContact: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginTop: 1,
  },
  orgBalance: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#D97706",
  },
  invoiceRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.light.border,
    gap: 8,
  },
  invNum: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  invDate: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginTop: 1,
  },
  invTotal: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  invBalance: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 99,
    backgroundColor: "#F1F5F9",
  },
  statusText: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
    textTransform: "capitalize",
  },
  empty: {
    padding: 40,
    alignItems: "center",
  },
  emptyText: {
    fontSize: 14,
    color: Colors.light.textSecondary,
    fontFamily: "Inter_400Regular",
  },
});
