import React, { useState, useMemo, useRef, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Image,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { ScreenShell, SettingsSection } from "@/components/settings/SettingsRow";
import { FormSheet } from "@/components/ui/FormSheet";
import { resilientFetch, getApiUrl } from "@/lib/query-client";
import { ME_QUERY_KEY } from "@/lib/auth-me";
import { formatPhone } from "@/lib/data";

interface OrgMembership {
  id: string;
  role: string;
  status: string;
  organizationId: string;
  organization?: {
    id?: string;
    name?: string;
    displayName?: string;
    type?: string | null;
    phone?: string | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    licenseNumber?: string | null;
    billingEmail?: string | null;
    duplicateSuggestionThreshold?: number | null;
    defaultCaseDueDays?: number | null;
    capCaseDueToDefault?: boolean | null;
    logoUrl?: string | null;
    logoplacements?: string[] | null;
    logoPdfSize?: string | null;
  } | null;
}

interface MeResponse {
  user?: { id?: string; userType?: string | null } | null;
  memberships?: OrgMembership[];
}

interface LabTeamMember {
  id: string;
  username: string;
  firstName?: string | null;
  lastName?: string | null;
  role?: string | null;
  membershipId?: string | null;
  isOwner?: boolean;
  status: string;
  isSelf: boolean;
}

interface PendingInvite {
  id: string;
  token: string;
  email: string | null;
  roleToAssign: string | null;
  status: string;
  organizationId: string;
  expiresAt: string | null;
  organization?: {
    id?: string;
    name?: string | null;
    displayName?: string | null;
  } | null;
  invitedByUser?: {
    id?: string;
    username?: string | null;
    email?: string | null;
  } | null;
}

const PENDING_INVITES_QUERY_KEY = ["pending-invites"] as const;

const INVITE_ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  user: "Team member",
  member: "Team member",
  billing: "Billing",
  read_only: "Read-only",
};

function inviteRoleLabel(role: string | null): string {
  if (!role) return "Team member";
  return INVITE_ROLE_LABELS[role] ?? role.replace(/_/g, " ");
}

const DUP_STEPS = [0.50, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 1.00];

function nearestStep(v: number) {
  return DUP_STEPS.reduce((prev, curr) =>
    Math.abs(curr - v) < Math.abs(prev - v) ? curr : prev
  );
}

function pct(v: number) {
  return `${Math.round(v * 100)}%`;
}

function thresholdLabel(v: number) {
  if (v >= 0.95) return "Strict — nearly identical names only";
  if (v >= 0.80) return "Balanced — recommended";
  if (v >= 0.65) return "Relaxed — more suggestions, more noise";
  return "Very relaxed — broad match";
}

const LOGO_PLACEMENTS = [
  { key: "invoices", label: "Invoices" },
  { key: "statements", label: "Statements" },
  { key: "lab_reports", label: "Lab reports" },
  { key: "welcome_emails", label: "Welcome emails" },
] as const;

const LOGO_SIZES = [
  { value: "small", label: "S" },
  { value: "medium", label: "M" },
  { value: "large", label: "L" },
] as const;

function OrgCard({ m, colors, styles }: { m: OrgMembership; colors: ThemeColors; styles: ReturnType<typeof makeStyles> }) {
  const qc = useQueryClient();
  const org = m.organization;
  const orgId = org?.id ?? "";
  const name = org?.displayName || org?.name || "Unknown";
  const type = org?.type || "—";
  const location = [org?.city, org?.state].filter(Boolean).join(", ");
  const canLeave = m.role !== "owner";
  const isAdmin = m.role === "admin" || m.role === "owner";

  const defaultThreshold = nearestStep(org?.duplicateSuggestionThreshold ?? 0.75);
  const [threshold, setThreshold] = useState(defaultThreshold);
  const [thresholdSaved, setThresholdSaved] = useState(false);

  const [logoPlacements, setLogoPlacements] = useState<string[]>(
    org?.logoplacements ?? ["invoices", "statements", "lab_reports"]
  );
  const [logoSize, setLogoSize] = useState(org?.logoPdfSize ?? "medium");
  const [logoSaved, setLogoSaved] = useState(false);

  const [dueDays, setDueDays] = useState<string>(
    org?.defaultCaseDueDays != null ? String(org.defaultCaseDueDays) : ""
  );
  const [dueDaysSaved, setDueDaysSaved] = useState(false);
  const [capEnabled, setCapEnabled] = useState<boolean>(
    !!(org as any)?.capCaseDueToDefault
  );
  const [capSaved, setCapSaved] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const logoXhrRef = useRef<XMLHttpRequest | null>(null);

  const logoUrl = org?.logoUrl
    ? `${getApiUrl().replace(/\/api\/?$/, "")}${org.logoUrl}`
    : null;

  const clusterQuery = useQuery<{ virtualCount: number; totalCount: number }>({
    queryKey: ["org-clusters", orgId],
    queryFn: async () => {
      const res = await resilientFetch(`/api/organizations/${orgId}/eligible-doctors`);
      if (!res.ok) return { virtualCount: 0, totalCount: 0 };
      const body = await res.json();
      const all: unknown[] = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
      const virtualCount = all.filter((d: any) => d?.isVirtual === true).length;
      return { virtualCount, totalCount: all.length };
    },
    enabled: isAdmin && !!orgId,
    staleTime: 120_000,
  });

  const labTeamQuery = useQuery<{ team: LabTeamMember[]; callerRole: string | null }>({
    queryKey: ["lab-team", orgId],
    queryFn: async () => {
      const res = await resilientFetch(`/api/auth/lab-team?orgId=${orgId}`);
      if (!res.ok) throw new Error("Failed to fetch team");
      return res.json();
    },
    enabled: org?.type === "lab" && !!orgId,
    staleTime: 60_000,
  });

  const changeMemberRoleMutation = useMutation({
    mutationFn: async ({ membershipId, role }: { membershipId: string; role: string }) => {
      const res = await resilientFetch(`/api/organizations/memberships/${membershipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Failed (${res.status})`);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lab-team", orgId] });
    },
    onError: (err: Error) => Alert.alert("Could not update role", err.message),
  });

  const suspendMemberMutation = useMutation({
    mutationFn: async ({ membershipId, status }: { membershipId: string; status: "active" | "suspended" }) => {
      const res = await resilientFetch(`/api/organizations/memberships/${membershipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Failed (${res.status})`);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lab-team", orgId] });
    },
    onError: (err: Error) => Alert.alert("Could not update member status", err.message),
  });

  const removeMemberMutation = useMutation({
    mutationFn: async (membershipId: string) => {
      const res = await resilientFetch(`/api/organizations/memberships/${membershipId}`, { method: "DELETE" });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Failed (${res.status})`);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lab-team", orgId] });
    },
    onError: (err: Error) => Alert.alert("Could not remove member", err.message),
  });

  const transferOwnershipMutation = useMutation({
    mutationFn: async ({ targetMembershipId, selfMembershipId }: { targetMembershipId: string; selfMembershipId: string }) => {
      const r1 = await resilientFetch(`/api/organizations/memberships/${targetMembershipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "owner" }),
      });
      if (!r1.ok) {
        const e = await r1.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Failed (${r1.status})`);
      }
      const r2 = await resilientFetch(`/api/organizations/memberships/${selfMembershipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      });
      if (!r2.ok) {
        const e = await r2.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Failed (${r2.status})`);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lab-team", orgId] });
      qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
    onError: (err: Error) => Alert.alert("Could not transfer ownership", err.message),
  });

  const leaveMutation = useMutation({
    mutationFn: async () => {
      const res = await resilientFetch(`/api/organizations/memberships/${m.id}`, { method: "DELETE" });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Failed (${res.status})`);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["organizations"] });
    },
    onError: (err: Error) => Alert.alert("Could not leave organization", err.message),
  });

  const thresholdMutation = useMutation({
    mutationFn: async (value: number) => {
      if (!orgId) throw new Error("Unknown org ID.");
      const res = await resilientFetch(
        `/api/organizations/${orgId}/duplicate-suggestion-threshold`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threshold: value }),
        }
      );
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Failed (${res.status})`);
      }
    },
    onSuccess: () => {
      setThresholdSaved(true);
      qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["org-clusters", orgId] });
      setTimeout(() => setThresholdSaved(false), 2000);
    },
    onError: (err: Error) => Alert.alert("Could not save threshold", err.message),
  });

  const logoPlacementsMutation = useMutation({
    mutationFn: async (opts: { placements: string[]; logoPdfSize: string }) => {
      const res = await resilientFetch(`/api/organizations/${orgId}/logo-placements`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ placements: opts.placements, logoPdfSize: opts.logoPdfSize }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Failed (${res.status})`);
      }
    },
    onSuccess: () => {
      setLogoSaved(true);
      qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
      setTimeout(() => setLogoSaved(false), 2000);
    },
    onError: (err: Error) => Alert.alert("Could not save logo settings", err.message),
  });

  const dueDaysMutation = useMutation({
    mutationFn: async (value: number | null) => {
      if (!orgId) throw new Error("Unknown org ID.");
      const res = await resilientFetch(`/api/organizations/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultCaseDueDays: value }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Failed (${res.status})`);
      }
    },
    onSuccess: () => {
      setDueDaysSaved(true);
      qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
      setTimeout(() => setDueDaysSaved(false), 2000);
    },
    onError: (err: Error) => Alert.alert("Could not save default due date", err.message),
  });

  const capMutation = useMutation({
    mutationFn: async (value: boolean) => {
      if (!orgId) throw new Error("Unknown org ID.");
      const res = await resilientFetch(`/api/organizations/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capCaseDueToDefault: value }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Failed (${res.status})`);
      }
    },
    onSuccess: () => {
      setCapSaved(true);
      qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
      setTimeout(() => setCapSaved(false), 2000);
    },
    onError: (err: Error) => Alert.alert("Could not save cap setting", err.message),
  });

  async function pickLogo() {
    if (!orgId) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission required", "Allow access to your photo library to upload a logo.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [3, 1],
      quality: 0.9,
    });
    if (result.canceled || !result.assets[0]) return;
    const uri = result.assets[0].uri;
    const filename = uri.split("/").pop() ?? "logo.png";
    const ext = filename.split(".").pop()?.toLowerCase() ?? "png";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "svg" ? "image/svg+xml" : ext === "webp" ? "image/webp" : "image/png";
    setLogoUploading(true);
    const base = getApiUrl().replace(/\/api\/?$/, "");
    const url = `${base}/api/organizations/${orgId}/logo`;
    const xhr = new XMLHttpRequest();
    logoXhrRef.current = xhr;
    xhr.open("POST", url);
    xhr.onload = () => {
      setLogoUploading(false);
      if (xhr.status < 300) {
        qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
      } else {
        try {
          Alert.alert("Upload failed", JSON.parse(xhr.responseText)?.error || `Status ${xhr.status}`);
        } catch {
          Alert.alert("Upload failed", `Status ${xhr.status}`);
        }
      }
    };
    xhr.onerror = () => { setLogoUploading(false); Alert.alert("Upload failed", "Network error."); };
    const fd = new FormData();
    fd.append("file", { uri, name: filename, type: mime } as unknown as Blob);
    xhr.send(fd);
  }

  function togglePlacement(key: string) {
    setLogoPlacements((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }

  function confirmLeave() {
    Alert.alert("Leave organization", `Leave ${name}?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Leave", style: "destructive", onPress: () => leaveMutation.mutate() },
    ]);
  }

  const stepIndex = DUP_STEPS.indexOf(threshold);

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.cardRow}>
        <View style={[styles.iconWrap, { backgroundColor: colors.tint + "1A" }]}>
          <Ionicons name="business-outline" size={18} color={colors.tint} />
        </View>
        <View style={styles.cardInfo}>
          <Text style={[styles.orgName, { color: colors.text }]}>{name}</Text>
          <Text style={[styles.orgMeta, { color: colors.textSecondary }]}>
            {type} · {m.role}
            {location ? ` · ${location}` : ""}
          </Text>
          {org?.billingEmail && (
            <Text style={[styles.orgMeta, { color: colors.textSecondary }]}>{org.billingEmail}</Text>
          )}
        </View>
        <View
          style={[
            styles.badge,
            { backgroundColor: m.status === "active" ? "#10B98120" : colors.warning + "20" },
          ]}
        >
          <Text
            style={[
              styles.badgeText,
              { color: m.status === "active" ? "#10B981" : colors.warning },
            ]}
          >
            {m.status}
          </Text>
        </View>
      </View>

      {type === "lab" && (
        <View style={[styles.detailsSection, { borderTopColor: colors.border }]}>
          <View style={styles.detailsSectionHeader}>
            <Text style={[styles.detailsSectionTitle, { color: colors.textSecondary }]}>Lab details</Text>
            {isAdmin && (
              <Pressable
                style={[styles.editLabBtn, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}
                onPress={() => setEditOpen(true)}
                hitSlop={8}
              >
                <Ionicons name="pencil-outline" size={12} color={colors.textSecondary} />
                <Text style={[styles.editLabBtnText, { color: colors.textSecondary }]}>Edit</Text>
              </Pressable>
            )}
          </View>
          {org?.licenseNumber ? (
            <View style={styles.detailRow}>
              <Text style={[styles.detailLabel, { color: colors.textTertiary }]}>License</Text>
              <Text style={[styles.detailValue, { color: colors.text }]}>{org.licenseNumber}</Text>
            </View>
          ) : null}
          {org?.phone ? (
            <View style={styles.detailRow}>
              <Text style={[styles.detailLabel, { color: colors.textTertiary }]}>Phone</Text>
              <Text style={[styles.detailValue, { color: colors.text }]}>{org.phone}</Text>
            </View>
          ) : null}
          {org?.billingEmail ? (
            <View style={styles.detailRow}>
              <Text style={[styles.detailLabel, { color: colors.textTertiary }]}>Email</Text>
              <Text style={[styles.detailValue, { color: colors.text }]}>{org.billingEmail}</Text>
            </View>
          ) : null}
          {(org?.addressLine1 || org?.city || org?.state || org?.zip) ? (
            <View style={styles.detailRow}>
              <Text style={[styles.detailLabel, { color: colors.textTertiary }]}>Address</Text>
              <Text style={[styles.detailValue, { color: colors.text, textAlign: "right", flex: 1 }]}>
                {[
                  org?.addressLine1,
                  org?.addressLine2,
                  [org?.city, org?.state, org?.zip].filter(Boolean).join(", "),
                ].filter(Boolean).join("\n")}
              </Text>
            </View>
          ) : null}
        </View>
      )}

      {type === "provider" && (
        <View style={[styles.detailsSection, { borderTopColor: colors.border }]}>
          <View style={styles.detailsSectionHeader}>
            <Text style={[styles.detailsSectionTitle, { color: colors.textSecondary }]}>Practice details</Text>
            {isAdmin && (
              <Pressable
                style={[styles.editLabBtn, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}
                onPress={() => setEditOpen(true)}
                hitSlop={8}
              >
                <Ionicons name="pencil-outline" size={12} color={colors.textSecondary} />
                <Text style={[styles.editLabBtnText, { color: colors.textSecondary }]}>Edit</Text>
              </Pressable>
            )}
          </View>
          {org?.phone ? (
            <View style={styles.detailRow}>
              <Text style={[styles.detailLabel, { color: colors.textTertiary }]}>Phone</Text>
              <Text style={[styles.detailValue, { color: colors.text }]}>{org.phone}</Text>
            </View>
          ) : null}
          {org?.billingEmail ? (
            <View style={styles.detailRow}>
              <Text style={[styles.detailLabel, { color: colors.textTertiary }]}>Email</Text>
              <Text style={[styles.detailValue, { color: colors.text }]}>{org.billingEmail}</Text>
            </View>
          ) : null}
          {(org?.addressLine1 || org?.city || org?.state || org?.zip) ? (
            <View style={styles.detailRow}>
              <Text style={[styles.detailLabel, { color: colors.textTertiary }]}>Address</Text>
              <Text style={[styles.detailValue, { color: colors.text, textAlign: "right", flex: 1 }]}>
                {[
                  org?.addressLine1,
                  org?.addressLine2,
                  [org?.city, org?.state, org?.zip].filter(Boolean).join(", "),
                ].filter(Boolean).join("\n")}
              </Text>
            </View>
          ) : null}
          {!org?.phone && !org?.billingEmail && !org?.addressLine1 && !org?.city && !org?.state && !org?.zip ? (
            <Text style={[styles.detailLabel, { color: colors.textTertiary }]}>
              No contact details yet.{isAdmin ? " Tap Edit to add them." : ""}
            </Text>
          ) : null}
        </View>
      )}

      {isAdmin && orgId && (org?.type === "lab" || org?.type === "provider") && (
        <EditLabSheet
          visible={editOpen}
          orgId={orgId}
          kind={org?.type === "provider" ? "provider" : "lab"}
          initialValues={{
            name: org?.displayName || org?.name || "",
            license: org?.licenseNumber || "",
            phone: org?.phone || "",
            email: org?.billingEmail || "",
            addressLine1: org?.addressLine1 || "",
            addressLine2: org?.addressLine2 || "",
            city: org?.city || "",
            state: org?.state || "",
            zip: org?.zip || "",
          }}
          onClose={() => setEditOpen(false)}
          colors={colors}
          styles={styles}
        />
      )}

      {/* Lab branding — admin/owner only */}
      {isAdmin && orgId && (
        <View style={[styles.adminSection, { borderTopColor: colors.border }]}>
          <Text style={[styles.adminSectionTitle, { color: colors.text }]}>Lab branding</Text>

          {/* Logo preview + upload */}
          <View style={styles.logoRow}>
            <View style={[styles.logoPreview, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
              {logoUrl ? (
                <Image source={{ uri: logoUrl }} style={styles.logoImg} resizeMode="contain" />
              ) : (
                <Ionicons name="image-outline" size={22} color={colors.textTertiary} />
              )}
            </View>
            <View style={styles.logoMeta}>
              <Pressable
                style={[styles.logoUploadBtn, { borderColor: colors.tint, backgroundColor: colors.tint + "15" }]}
                onPress={pickLogo}
                disabled={logoUploading}
              >
                {logoUploading
                  ? <ActivityIndicator size={12} color={colors.tint} />
                  : <Ionicons name="cloud-upload-outline" size={13} color={colors.tint} />}
                <Text style={[styles.logoUploadText, { color: colors.tint }]}>
                  {logoUploading ? "Uploading…" : logoUrl ? "Replace" : "Upload logo"}
                </Text>
              </Pressable>
              <Text style={[styles.logoHint, { color: colors.textTertiary }]}>PNG, JPG, SVG, WebP · max 5 MB</Text>
            </View>
          </View>

          {/* Logo size */}
          <View style={styles.logoSizeRow}>
            <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Size on documents</Text>
            <View style={styles.sizeRow}>
              {LOGO_SIZES.map((s) => {
                const active = logoSize === s.value;
                return (
                  <Pressable
                    key={s.value}
                    onPress={() => setLogoSize(s.value)}
                    style={[
                      styles.sizeBtn,
                      { backgroundColor: active ? colors.tint : colors.surfaceAlt, borderColor: active ? colors.tint : colors.border },
                    ]}
                  >
                    <Text style={[styles.sizeBtnText, { color: active ? "#fff" : colors.textSecondary }]}>{s.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Logo placements */}
          <View style={styles.placementsWrap}>
            <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Show on</Text>
            <View style={styles.placementsRow}>
              {LOGO_PLACEMENTS.map((p) => {
                const active = logoPlacements.includes(p.key);
                return (
                  <Pressable
                    key={p.key}
                    onPress={() => togglePlacement(p.key)}
                    style={[
                      styles.placementChip,
                      { backgroundColor: active ? colors.tint + "18" : colors.surfaceAlt, borderColor: active ? colors.tint : colors.border },
                    ]}
                  >
                    <Ionicons
                      name={active ? "checkmark-circle" : "ellipse-outline"}
                      size={12}
                      color={active ? colors.tint : colors.textTertiary}
                    />
                    <Text style={[styles.placementText, { color: active ? colors.tint : colors.textSecondary }]}>{p.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <Pressable
            style={[styles.brandingSaveBtn, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }, logoPlacementsMutation.isPending && { opacity: 0.6 }]}
            onPress={() => logoPlacementsMutation.mutate({ placements: logoPlacements, logoPdfSize: logoSize })}
            disabled={logoPlacementsMutation.isPending}
          >
            {logoSaved
              ? <Ionicons name="checkmark-circle" size={14} color={colors.success} />
              : <Ionicons name="save-outline" size={14} color={colors.textSecondary} />}
            <Text style={[styles.brandingSaveBtnText, { color: logoSaved ? colors.success : colors.textSecondary }]}>
              {logoPlacementsMutation.isPending ? "Saving…" : logoSaved ? "Saved!" : "Save branding"}
            </Text>
          </Pressable>
        </View>
      )}

      {/* Duplicate-detection threshold — admin/owner only */}
      {isAdmin && orgId && (
        <View style={[styles.dupSection, { borderTopColor: colors.border }]}>
          <View style={styles.dupHeader}>
            <Text style={[styles.dupTitle, { color: colors.text }]}>Duplicate detection</Text>
            {thresholdSaved && (
              <View style={[styles.dupSaved, { backgroundColor: colors.success + "20" }]}>
                <Ionicons name="checkmark" size={12} color={colors.success} />
                <Text style={[styles.dupSavedText, { color: colors.success }]}>Saved</Text>
              </View>
            )}
          </View>
          <Text style={[styles.dupSub, { color: colors.textTertiary }]}>
            Flag provider records with name similarity ≥ {pct(threshold)}
          </Text>

          {/* Segmented picker */}
          <View style={styles.stepRow}>
            <Pressable
              onPress={() => setThreshold(DUP_STEPS[Math.max(0, stepIndex - 1)])}
              disabled={stepIndex === 0}
              hitSlop={8}
              style={[styles.stepArrow, stepIndex === 0 && styles.stepArrowDisabled]}
            >
              <Ionicons
                name="chevron-back"
                size={16}
                color={stepIndex === 0 ? colors.textTertiary : colors.tint}
              />
            </Pressable>
            <View style={[styles.stepValue, { backgroundColor: colors.tint + "15", borderColor: colors.tint + "40" }]}>
              <Text style={[styles.stepValueText, { color: colors.tint }]}>{pct(threshold)}</Text>
            </View>
            <Pressable
              onPress={() => setThreshold(DUP_STEPS[Math.min(DUP_STEPS.length - 1, stepIndex + 1)])}
              disabled={stepIndex === DUP_STEPS.length - 1}
              hitSlop={8}
              style={[styles.stepArrow, stepIndex === DUP_STEPS.length - 1 && styles.stepArrowDisabled]}
            >
              <Ionicons
                name="chevron-forward"
                size={16}
                color={stepIndex === DUP_STEPS.length - 1 ? colors.textTertiary : colors.tint}
              />
            </Pressable>
            <View style={styles.dupStepFill} />
            <Pressable
              style={[
                styles.dupSaveBtn,
                { backgroundColor: colors.tint },
                thresholdMutation.isPending && { opacity: 0.6 },
              ]}
              onPress={() => thresholdMutation.mutate(threshold)}
              disabled={thresholdMutation.isPending}
            >
              <Text style={styles.dupSaveBtnText}>
                {thresholdMutation.isPending ? "Saving…" : "Apply"}
              </Text>
            </Pressable>
          </View>
          <Text style={[styles.dupLabel, { color: colors.textSecondary }]}>
            {thresholdLabel(threshold)}
          </Text>

          {/* Cluster count preview — live from API */}
          <View style={[styles.clusterPreview, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
            <Ionicons name="git-merge-outline" size={14} color={colors.textSecondary} style={{ marginTop: 1 }} />
            <View style={{ flex: 1 }}>
              {clusterQuery.isLoading ? (
                <ActivityIndicator size={12} color={colors.textSecondary} />
              ) : clusterQuery.data ? (
                <>
                  <Text style={[styles.clusterPreviewText, { color: colors.textSecondary }]}>
                    <Text style={{ fontWeight: "600" }}>{clusterQuery.data.virtualCount}</Text>
                    {" "}unregistered / virtual provider name{clusterQuery.data.virtualCount !== 1 ? "s" : ""} detected
                    {" "}across{" "}
                    <Text style={{ fontWeight: "600" }}>{clusterQuery.data.totalCount}</Text>
                    {" "}eligible providers — possible duplicate clusters at {pct(threshold)}.
                  </Text>
                  {clusterQuery.data.virtualCount > 0 && (
                    <Text style={[styles.clusterHint, { color: colors.warning }]}>
                      These may include duplicate or misspelled provider names.
                    </Text>
                  )}
                </>
              ) : (
                <Text style={[styles.clusterPreviewText, { color: colors.textSecondary }]}>
                  At {pct(threshold)}, provider records whose normalized names share ≥ {pct(threshold)} bigram overlap are grouped as potential duplicates.
                </Text>
              )}
            </View>
          </View>
        </View>
      )}

      {/* Default case due date — admin/owner, lab orgs only */}
      {isAdmin && orgId && org?.type === "lab" && (
        <View style={[styles.dupSection, { borderTopColor: colors.border }]}>
          <View style={styles.dupHeader}>
            <Text style={[styles.dupTitle, { color: colors.text }]}>Default case due date</Text>
            {dueDaysSaved && (
              <View style={[styles.dupSaved, { backgroundColor: colors.success + "20" }]}>
                <Ionicons name="checkmark" size={12} color={colors.success} />
                <Text style={[styles.dupSavedText, { color: colors.success }]}>Saved</Text>
              </View>
            )}
          </View>
          <Text style={[styles.dupSub, { color: colors.textTertiary }]}>
            Days after received date to set as due date on new cases. Leave blank for no default.
          </Text>
          <View style={styles.stepRow}>
            <TextInput
              style={{
                height: 34,
                width: 72,
                borderRadius: 8,
                borderWidth: 1,
                paddingHorizontal: 10,
                fontSize: 14,
                borderColor: colors.border,
                backgroundColor: colors.surfaceAlt,
                color: colors.text,
              }}
              value={dueDays}
              onChangeText={setDueDays}
              keyboardType="number-pad"
              placeholder="e.g. 7"
              placeholderTextColor={colors.textTertiary}
              maxLength={3}
            />
            <Text style={[styles.dupSub, { color: colors.textSecondary, marginLeft: 6 }]}>days</Text>
            <View style={styles.dupStepFill} />
            <Pressable
              style={[styles.dupSaveBtn, { backgroundColor: colors.tint }, dueDaysMutation.isPending && { opacity: 0.6 }]}
              onPress={() => {
                const val = dueDays.trim();
                const num = val === "" ? null : parseInt(val, 10);
                if (num !== null && (isNaN(num) || num < 1 || num > 365)) {
                  Alert.alert("Invalid value", "Enter a number between 1 and 365.");
                  return;
                }
                dueDaysMutation.mutate(num);
              }}
              disabled={dueDaysMutation.isPending}
            >
              <Text style={styles.dupSaveBtnText}>{dueDaysMutation.isPending ? "Saving…" : "Save"}</Text>
            </Pressable>
          </View>

          {/* Cap toggle */}
          <View style={[styles.stepRow, { marginTop: 12, alignItems: "center" }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.dupTitle, { color: colors.text, fontSize: 13 }]}>
                Never set a case due date later than my turnaround
              </Text>
              {!org?.defaultCaseDueDays && (
                <Text style={[styles.dupSub, { color: colors.warning, marginTop: 2 }]}>
                  Set a default due days above to enable.
                </Text>
              )}
              {capSaved && (
                <Text style={[styles.dupSub, { color: colors.success, marginTop: 2 }]}>Saved</Text>
              )}
            </View>
            <Pressable
              onPress={() => {
                if (!org?.defaultCaseDueDays) {
                  Alert.alert("Set a turnaround first", "Enter a default due days value above before enabling this cap.");
                  return;
                }
                const next = !capEnabled;
                setCapEnabled(next);
                capMutation.mutate(next);
              }}
              disabled={capMutation.isPending}
              style={[
                {
                  width: 44,
                  height: 26,
                  borderRadius: 13,
                  padding: 3,
                  justifyContent: "center",
                  backgroundColor: capEnabled ? colors.tint : colors.border,
                },
                capMutation.isPending && { opacity: 0.6 },
              ]}
            >
              <View
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 10,
                  backgroundColor: "#fff",
                  alignSelf: capEnabled ? "flex-end" : "flex-start",
                }}
              />
            </Pressable>
          </View>
        </View>
      )}

      {/* Members section — lab orgs; all members see the list, only admins get controls */}
      {org?.type === "lab" && orgId && (
        <View style={[styles.dupSection, { borderTopColor: colors.border }]}>
          <View style={styles.dupHeader}>
            <Text style={[styles.dupTitle, { color: colors.text }]}>Team members</Text>
            {labTeamQuery.isLoading && <ActivityIndicator size={12} color={colors.textSecondary} />}
          </View>

          {(labTeamQuery.data?.team ?? []).map((member) => {
            const memberName =
              [member.firstName, member.lastName].filter(Boolean).join(" ") || member.username;
            const isSuspended = member.status === "suspended";
            const isCallerOwner = labTeamQuery.data?.callerRole === "owner";
            const canActOnMember = isAdmin && !member.isSelf && !member.isOwner && !!member.membershipId;

            function showRolePicker() {
              if (!member.membershipId) return;
              const roles: Array<{ label: string; value: string }> = [
                ...(isCallerOwner ? [{ label: "Owner", value: "owner" }] : []),
                { label: "Admin", value: "admin" },
                { label: "Billing", value: "billing" },
                { label: "User", value: "user" },
                { label: "Read-Only", value: "read_only" },
              ];
              const buttons = [
                ...roles.map((r) => ({
                  text: r.label,
                  onPress: () => {
                    if (r.value === "owner") {
                      const selfMember = labTeamQuery.data?.team.find((t) => t.isSelf);
                      if (!selfMember?.membershipId) return;
                      Alert.alert(
                        "Transfer ownership",
                        `Make ${memberName} the new owner? Your role will change to Admin.`,
                        [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Transfer ownership",
                            onPress: () =>
                              transferOwnershipMutation.mutate({
                                targetMembershipId: member.membershipId!,
                                selfMembershipId: selfMember.membershipId!,
                              }),
                          },
                        ]
                      );
                    } else {
                      changeMemberRoleMutation.mutate({ membershipId: member.membershipId!, role: r.value });
                    }
                  },
                })),
                { text: "Cancel", style: "cancel" as const },
              ];
              Alert.alert(`Change role for ${memberName}`, `Current role: ${member.role ?? "user"}`, buttons);
            }

            function showMemberActions() {
              if (!member.membershipId) return;
              const actions = [
                {
                  text: isSuspended ? "Reactivate" : "Suspend",
                  onPress: () =>
                    suspendMemberMutation.mutate({
                      membershipId: member.membershipId!,
                      status: isSuspended ? "active" : "suspended",
                    }),
                },
                {
                  text: "Remove from lab",
                  style: "destructive" as const,
                  onPress: () =>
                    Alert.alert(
                      "Remove member",
                      `Remove ${memberName} from the lab?`,
                      [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Remove",
                          style: "destructive",
                          onPress: () => removeMemberMutation.mutate(member.membershipId!),
                        },
                      ]
                    ),
                },
                { text: "Cancel", style: "cancel" as const },
              ];
              Alert.alert(memberName, undefined, actions);
            }

            return (
              <View
                key={member.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingVertical: 6,
                  opacity: isSuspended ? 0.6 : 1,
                }}
              >
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Text style={[styles.detailValue, { color: colors.text }]}>{memberName}</Text>
                    {member.isSelf && (
                      <Text style={[styles.detailLabel, { color: colors.textTertiary }]}>(you)</Text>
                    )}
                    {isSuspended && (
                      <Text style={{ fontSize: 10, color: "#D97706", fontWeight: "600" }}>suspended</Text>
                    )}
                  </View>
                  <Pressable
                    onPress={canActOnMember ? showRolePicker : undefined}
                    hitSlop={8}
                    style={{ alignSelf: "flex-start", marginTop: 2 }}
                  >
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 3,
                        borderRadius: 4,
                        borderWidth: 1,
                        borderColor: colors.border,
                        paddingHorizontal: 6,
                        paddingVertical: 2,
                        backgroundColor: colors.surfaceAlt,
                      }}
                    >
                      <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>
                        {(member.role ?? "user").replace("_", "-")}
                      </Text>
                      {canActOnMember && (
                        <Ionicons name="chevron-down" size={10} color={colors.textTertiary} />
                      )}
                    </View>
                  </Pressable>
                </View>
                {canActOnMember && (
                  <Pressable onPress={showMemberActions} hitSlop={12} style={{ padding: 4 }}>
                    <Ionicons name="ellipsis-horizontal" size={18} color={colors.textSecondary} />
                  </Pressable>
                )}
              </View>
            );
          })}

          {!labTeamQuery.isLoading && (labTeamQuery.data?.team ?? []).length === 0 && (
            <Text style={[styles.dupLabel, { color: colors.textTertiary }]}>No team members found.</Text>
          )}
          {labTeamQuery.isError && (
            <Text style={[styles.dupLabel, { color: colors.error }]}>Could not load team members.</Text>
          )}
        </View>
      )}

      {canLeave && (
        <Pressable
          style={[styles.leaveBtn, { borderColor: colors.error + "60" }]}
          onPress={confirmLeave}
          disabled={leaveMutation.isPending}
        >
          <Text style={[styles.leaveBtnText, { color: colors.error }]}>Leave organization</Text>
        </Pressable>
      )}
    </View>
  );
}

function LabField({
  label,
  value,
  onChangeText,
  placeholder,
  colors,
  styles,
  keyboardType,
  autoCapitalize,
  maxLength,
  autoFocus,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder: string;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  keyboardType?: "default" | "email-address" | "phone-pad" | "number-pad";
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  maxLength?: number;
  autoFocus?: boolean;
}) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textTertiary}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        maxLength={maxLength}
        autoFocus={autoFocus}
        style={[
          styles.fieldInput,
          { color: colors.text, backgroundColor: colors.surfaceAlt, borderColor: colors.border },
        ]}
      />
    </View>
  );
}

function CreateLabSheet({
  visible,
  onClose,
  colors,
  styles,
}: {
  visible: boolean;
  onClose: () => void;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [license, setLicense] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [addressLine2, setAddressLine2] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zip, setZip] = useState("");
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName("");
    setLicense("");
    setPhone("");
    setEmail("");
    setAddressLine1("");
    setAddressLine2("");
    setCity("");
    setState("");
    setZip("");
    setError(null);
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await resilientFetch("/api/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "lab",
          name: name.trim(),
          displayName: name.trim(),
          licenseNumber: license.trim(),
          phone: phone.trim(),
          billingEmail: email.trim(),
          addressLine1: addressLine1.trim(),
          addressLine2: addressLine2.trim() || undefined,
          city: city.trim() || undefined,
          state: state.trim() || undefined,
          zip: zip.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as any)?.error || `Failed to create lab (${res.status}).`);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["organizations"] });
      reset();
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  function handleSubmit() {
    if (
      !name.trim() ||
      !license.trim() ||
      !phone.trim() ||
      !email.trim() ||
      !addressLine1.trim()
    ) {
      setError("Lab name, license number, phone, email, and street address are required.");
      return;
    }
    setError(null);
    createMutation.mutate();
  }

  return (
    <FormSheet
      visible={visible}
      title="Create lab"
      onClose={() => {
        if (createMutation.isPending) return;
        reset();
        onClose();
      }}
      onSubmit={handleSubmit}
      submitting={createMutation.isPending}
      submitLabel="Create lab"
    >
      <Text style={[styles.createIntro, { color: colors.textSecondary }]}>
        Set up your lab environment. Name, license number, phone, email, and street address are required.
      </Text>
      <LabField label="Lab name" value={name} onChangeText={setName} placeholder="Acme Dental Lab" colors={colors} styles={styles} autoCapitalize="words" autoFocus />
      <LabField label="License number" value={license} onChangeText={(t) => setLicense(t.toUpperCase())} placeholder="Lab license number" colors={colors} styles={styles} autoCapitalize="characters" />
      <LabField label="Phone" value={phone} onChangeText={(t) => setPhone(formatPhone(t))} placeholder="000-000-0000" colors={colors} styles={styles} keyboardType="phone-pad" />
      <LabField label="Email" value={email} onChangeText={setEmail} placeholder="lab@example.com" colors={colors} styles={styles} keyboardType="email-address" autoCapitalize="none" />
      <LabField label="Address line 1" value={addressLine1} onChangeText={setAddressLine1} placeholder="123 Main St" colors={colors} styles={styles} autoCapitalize="words" />
      <LabField label="Address line 2" value={addressLine2} onChangeText={setAddressLine2} placeholder="Suite 200 (optional)" colors={colors} styles={styles} autoCapitalize="words" />
      <View style={styles.cityStateRow}>
        <View style={{ flex: 2 }}>
          <LabField label="City" value={city} onChangeText={setCity} placeholder="City" colors={colors} styles={styles} autoCapitalize="words" />
        </View>
        <View style={{ flex: 1 }}>
          <LabField label="State" value={state} onChangeText={(t) => setState(t.toUpperCase())} placeholder="CA" colors={colors} styles={styles} autoCapitalize="characters" maxLength={2} />
        </View>
        <View style={{ flex: 1.2 }}>
          <LabField label="ZIP" value={zip} onChangeText={setZip} placeholder="00000" colors={colors} styles={styles} keyboardType="number-pad" />
        </View>
      </View>
      {error && <Text style={[styles.createError, { color: colors.error }]}>{error}</Text>}
    </FormSheet>
  );
}

function EditLabSheet({
  visible,
  orgId,
  initialValues,
  onClose,
  colors,
  styles,
  kind = "lab",
}: {
  visible: boolean;
  orgId: string;
  initialValues: {
    name: string;
    license: string;
    phone: string;
    email: string;
    addressLine1: string;
    addressLine2: string;
    city: string;
    state: string;
    zip: string;
  };
  onClose: () => void;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  kind?: "lab" | "provider";
}) {
  const isLab = kind === "lab";
  const entityLabel = isLab ? "lab" : "practice";
  const qc = useQueryClient();
  const [name, setName] = useState(initialValues.name);
  const [license, setLicense] = useState(initialValues.license);
  const [phone, setPhone] = useState(initialValues.phone);
  const [email, setEmail] = useState(initialValues.email);
  const [addressLine1, setAddressLine1] = useState(initialValues.addressLine1);
  const [addressLine2, setAddressLine2] = useState(initialValues.addressLine2);
  const [city, setCity] = useState(initialValues.city);
  const [state, setState] = useState(initialValues.state);
  const [zip, setZip] = useState(initialValues.zip);
  const [error, setError] = useState<string | null>(null);

  function resetToInitial() {
    setName(initialValues.name);
    setLicense(initialValues.license);
    setPhone(initialValues.phone);
    setEmail(initialValues.email);
    setAddressLine1(initialValues.addressLine1);
    setAddressLine2(initialValues.addressLine2);
    setCity(initialValues.city);
    setState(initialValues.state);
    setZip(initialValues.zip);
    setError(null);
  }

  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      resetToInitial();
    }
    wasVisible.current = visible;
  });

  const editMutation = useMutation({
    mutationFn: async () => {
      const res = await resilientFetch(`/api/organizations/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          displayName: name.trim(),
          ...(isLab ? { licenseNumber: license.trim() || undefined } : {}),
          phone: phone.trim() || undefined,
          billingEmail: email.trim() || undefined,
          addressLine1: addressLine1.trim() || undefined,
          addressLine2: addressLine2.trim() || undefined,
          city: city.trim() || undefined,
          state: state.trim() || undefined,
          zip: zip.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 409) {
          throw new Error(`That ${entityLabel} name is already taken. Please choose a different name.`);
        }
        throw new Error((body as any)?.error || `Failed to update ${entityLabel} (${res.status}).`);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["organizations"] });
      setError(null);
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  function handleSubmit() {
    if (!name.trim()) {
      setError(isLab ? "Lab name is required." : "Practice name is required.");
      return;
    }
    setError(null);
    editMutation.mutate();
  }

  return (
    <FormSheet
      visible={visible}
      title={isLab ? "Edit lab details" : "Edit practice details"}
      onClose={() => {
        if (editMutation.isPending) return;
        resetToInitial();
        onClose();
      }}
      onSubmit={handleSubmit}
      submitting={editMutation.isPending}
      submitLabel="Save changes"
    >
      <LabField label={isLab ? "Lab name" : "Practice name"} value={name} onChangeText={setName} placeholder={isLab ? "Acme Dental Lab" : "Acme Dental Practice"} colors={colors} styles={styles} autoCapitalize="words" autoFocus />
      {isLab && (
        <LabField label="License number" value={license} onChangeText={(t) => setLicense(t.toUpperCase())} placeholder="Lab license number" colors={colors} styles={styles} autoCapitalize="characters" />
      )}
      <LabField label="Phone" value={phone} onChangeText={(t) => setPhone(formatPhone(t))} placeholder="000-000-0000" colors={colors} styles={styles} keyboardType="phone-pad" />
      <LabField label="Billing email" value={email} onChangeText={setEmail} placeholder="lab@example.com" colors={colors} styles={styles} keyboardType="email-address" autoCapitalize="none" />
      <LabField label="Address line 1" value={addressLine1} onChangeText={setAddressLine1} placeholder="123 Main St" colors={colors} styles={styles} autoCapitalize="words" />
      <LabField label="Address line 2" value={addressLine2} onChangeText={setAddressLine2} placeholder="Suite 200 (optional)" colors={colors} styles={styles} autoCapitalize="words" />
      <View style={styles.cityStateRow}>
        <View style={{ flex: 2 }}>
          <LabField label="City" value={city} onChangeText={setCity} placeholder="City" colors={colors} styles={styles} autoCapitalize="words" />
        </View>
        <View style={{ flex: 1 }}>
          <LabField label="State" value={state} onChangeText={(t) => setState(t.toUpperCase())} placeholder="CA" colors={colors} styles={styles} autoCapitalize="characters" maxLength={2} />
        </View>
        <View style={{ flex: 1.2 }}>
          <LabField label="ZIP" value={zip} onChangeText={setZip} placeholder="00000" colors={colors} styles={styles} keyboardType="number-pad" />
        </View>
      </View>
      {error && <Text style={[styles.createError, { color: colors.error }]}>{error}</Text>}
    </FormSheet>
  );
}

function PendingInvitesCard({
  colors,
  styles,
}: {
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
}) {
  const qc = useQueryClient();
  const [actingToken, setActingToken] = useState<string | null>(null);

  const invitesQuery = useQuery<PendingInvite[]>({
    queryKey: PENDING_INVITES_QUERY_KEY,
    queryFn: async () => {
      const res = await resilientFetch("/api/organizations/invites/pending-for-me");
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = await res.json();
      const list = Array.isArray(body) ? body : body?.data;
      return Array.isArray(list) ? (list as PendingInvite[]) : [];
    },
    staleTime: 30_000,
  });

  const respondMutation = useMutation({
    mutationFn: async ({
      token,
      action,
    }: {
      token: string;
      action: "accept" | "decline";
    }) => {
      const res = await resilientFetch(
        `/api/organizations/invites/${encodeURIComponent(token)}/${action}`,
        { method: "POST" },
      );
      if (!res.ok) {
        let message = `Failed (${res.status})`;
        try {
          const body = await res.json();
          message = body?.message || body?.error || message;
        } catch {
          /* ignore */
        }
        throw new Error(message);
      }
      return action;
    },
    onSuccess: (action) => {
      qc.invalidateQueries({ queryKey: PENDING_INVITES_QUERY_KEY });
      if (action === "accept") {
        qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
      }
    },
    onError: (err: unknown) => {
      Alert.alert(
        "Couldn't update invitation",
        err instanceof Error ? err.message : "Please try again.",
      );
    },
    onSettled: () => setActingToken(null),
  });

  const invites = invitesQuery.data ?? [];
  if (invitesQuery.isLoading || invites.length === 0) return null;

  function respond(token: string, action: "accept" | "decline") {
    setActingToken(token);
    respondMutation.mutate({ token, action });
  }

  return (
    <SettingsSection title="Pending invitations">
      <View style={{ gap: Spacing.md }}>
        {invites.map((invite) => {
          const orgName =
            invite.organization?.displayName ||
            invite.organization?.name ||
            "a lab";
          const inviter =
            invite.invitedByUser?.username || invite.invitedByUser?.email;
          const busy = actingToken === invite.token && respondMutation.isPending;
          return (
            <View
              key={invite.id}
              style={[
                styles.card,
                { backgroundColor: colors.surface, borderColor: colors.border },
              ]}
            >
              <View style={styles.cardRow}>
                <View
                  style={[styles.iconWrap, { backgroundColor: colors.tint + "22" }]}
                >
                  <Ionicons name="mail-open-outline" size={18} color={colors.tint} />
                </View>
                <View style={styles.cardInfo}>
                  <Text style={[styles.orgName, { color: colors.text }]}>
                    {orgName}
                  </Text>
                  <Text style={[styles.orgMeta, { color: colors.textSecondary }]}>
                    Role: {inviteRoleLabel(invite.roleToAssign)}
                  </Text>
                  {inviter && (
                    <Text style={[styles.orgMeta, { color: colors.textSecondary }]}>
                      Invited by {inviter}
                    </Text>
                  )}
                </View>
              </View>
              <View style={styles.inviteActions}>
                <Pressable
                  disabled={busy}
                  onPress={() => respond(invite.token, "decline")}
                  style={[
                    styles.inviteDeclineBtn,
                    { borderColor: colors.border },
                    busy && { opacity: 0.5 },
                  ]}
                >
                  <Text
                    style={[styles.inviteDeclineText, { color: colors.text }]}
                  >
                    Decline
                  </Text>
                </Pressable>
                <Pressable
                  disabled={busy}
                  onPress={() => respond(invite.token, "accept")}
                  style={[
                    styles.inviteAcceptBtn,
                    { backgroundColor: colors.tint },
                    busy && { opacity: 0.5 },
                  ]}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.inviteAcceptText}>Accept</Text>
                  )}
                </Pressable>
              </View>
            </View>
          );
        })}
      </View>
    </SettingsSection>
  );
}

export default function OrganizationsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const meQuery = useQuery<MeResponse>({
    queryKey: ME_QUERY_KEY,
    queryFn: async () => {
      const res = await resilientFetch("/api/auth/me");
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = await res.json();
      return {
        user: body?.user,
        memberships: Array.isArray(body?.memberships) ? body.memberships : [],
      };
    },
    staleTime: 60_000,
  });

  const memberships = meQuery.data?.memberships ?? [];
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const isLabUser = (meQuery.data?.user?.userType ?? null) === "lab";
  const hasLabMembership = memberships.some(
    (m) => m.organization?.type === "lab" && m.status === "active"
  );
  const canCreateLab = isLabUser && !hasLabMembership && !meQuery.isLoading;

  const filtered = useMemo(() => {
    if (!search.trim()) return memberships;
    const q = search.trim().toLowerCase();
    return memberships.filter((m) => {
      const org = m.organization;
      return (
        (org?.displayName || org?.name || "").toLowerCase().includes(q) ||
        (org?.type || "").toLowerCase().includes(q) ||
        (m.role || "").toLowerCase().includes(q) ||
        (org?.city || "").toLowerCase().includes(q) ||
        (org?.state || "").toLowerCase().includes(q)
      );
    });
  }, [memberships, search]);

  return (
    <ScreenShell
      title="Organizations"
      subtitle="Labs and practices you belong to"
      onBack={() => router.back()}
      insetTop={insets.top}
    >
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={colors.textSecondary} style={styles.searchIcon} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          style={[styles.searchInput, { color: colors.text, backgroundColor: colors.surfaceAlt }]}
          placeholderTextColor={colors.textTertiary}
          placeholder="Search by name, type, city…"
        />
        {search.length > 0 && (
          <Pressable onPress={() => setSearch("")} hitSlop={8}>
            <Ionicons name="close-circle" size={16} color={colors.textSecondary} />
          </Pressable>
        )}
      </View>

      {canCreateLab && (
        <Pressable
          testID="create-lab-open-btn"
          style={[styles.createLabBtn, { backgroundColor: colors.tint }]}
          onPress={() => setCreateOpen(true)}
        >
          <Ionicons name="add-circle-outline" size={18} color={colors.textInverse} />
          <Text style={[styles.createLabBtnText, { color: colors.textInverse }]}>Create lab</Text>
        </Pressable>
      )}

      <ScrollView contentContainerStyle={styles.body}>
        {meQuery.isLoading && <ActivityIndicator color={colors.tint} />}
        {!meQuery.isLoading && memberships.length === 0 && (
          <Text style={[styles.empty, { color: colors.textSecondary }]}>
            {canCreateLab
              ? "You haven't set up your lab yet. Tap \"Create lab\" above to get started."
              : "You're not a member of any organization yet."}
          </Text>
        )}
        {!meQuery.isLoading && memberships.length > 0 && filtered.length === 0 && (
          <Text style={[styles.empty, { color: colors.textSecondary }]}>
            No organizations match "{search}".
          </Text>
        )}

        <PendingInvitesCard colors={colors} styles={styles} />

        {filtered.map((m) => (
          <OrgCard key={m.id} m={m} colors={colors} styles={styles} />
        ))}
      </ScrollView>

      <CreateLabSheet
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        colors={colors}
        styles={styles}
      />
    </ScreenShell>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    searchWrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      margin: Spacing.lg,
      paddingHorizontal: Spacing.md,
      borderRadius: Radius.md,
      backgroundColor: c.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    searchIcon: { flexShrink: 0 },
    searchInput: { flex: 1, ...Typography.body, paddingVertical: Spacing.md },
    createLabBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      marginHorizontal: Spacing.lg,
      marginBottom: Spacing.md,
      paddingVertical: Spacing.md,
      borderRadius: Radius.md,
    },
    createLabBtnText: { ...Typography.bodySemibold },
    createIntro: { ...Typography.caption },
    createError: { ...Typography.caption },
    fieldWrap: { gap: Spacing.xs },
    fieldInput: {
      height: 42,
      borderRadius: Radius.md,
      borderWidth: 1,
      paddingHorizontal: Spacing.md,
      ...Typography.body,
    },
    cityStateRow: { flexDirection: "row", gap: Spacing.sm },
    body: { paddingHorizontal: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.xxxl },
    empty: { ...Typography.body, textAlign: "center", marginTop: Spacing.xxl },
    card: {
      borderRadius: Radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      padding: Spacing.lg,
      gap: Spacing.md,
    },
    cardRow: { flexDirection: "row", gap: Spacing.md, alignItems: "flex-start" },
    iconWrap: {
      width: 36,
      height: 36,
      borderRadius: Radius.sm,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    cardInfo: { flex: 1, gap: 2 },
    orgName: { ...Typography.bodyMedium },
    orgMeta: { ...Typography.caption },
    badge: { borderRadius: Radius.full, paddingHorizontal: 8, paddingVertical: 2 },
    badgeText: { ...Typography.tiny },

    detailsSection: {
      borderTopWidth: StyleSheet.hairlineWidth,
      paddingTop: Spacing.md,
      marginTop: Spacing.md,
      gap: Spacing.xs,
    },
    detailsSectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 2,
    },
    detailsSectionTitle: { ...Typography.captionSemibold },
    editLabBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      borderWidth: 1,
      borderRadius: Radius.sm,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    editLabBtnText: { ...Typography.tiny },
    detailRow: { flexDirection: "row", justifyContent: "space-between", gap: Spacing.md },
    detailLabel: { ...Typography.caption },
    detailValue: { ...Typography.caption, fontWeight: "600" },

    adminSection: {
      borderTopWidth: StyleSheet.hairlineWidth,
      paddingTop: Spacing.md,
      gap: Spacing.sm,
    },
    adminSectionTitle: { ...Typography.bodyMedium },
    logoRow: { flexDirection: "row", gap: Spacing.md, alignItems: "flex-start" },
    logoPreview: {
      width: 72,
      height: 36,
      borderRadius: Radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    logoImg: { width: 68, height: 32, borderRadius: Radius.sm },
    logoMeta: { flex: 1, gap: Spacing.xs },
    logoUploadBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      alignSelf: "flex-start",
      borderWidth: 1,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 3,
    },
    logoUploadText: { ...Typography.tiny },
    logoHint: { ...Typography.tiny },
    logoSizeRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    fieldLabel: { ...Typography.captionSemibold },
    sizeRow: { flexDirection: "row", gap: 6 },
    sizeBtn: {
      width: 32,
      height: 28,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: Radius.sm,
      borderWidth: 1,
    },
    sizeBtnText: { ...Typography.captionMedium },
    placementsWrap: { gap: Spacing.xs },
    placementsRow: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.xs },
    placementChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      borderWidth: 1,
      borderRadius: Radius.full,
      paddingHorizontal: 7,
      paddingVertical: 3,
    },
    placementText: { ...Typography.tiny },
    brandingSaveBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 5,
      borderWidth: 1,
      borderRadius: Radius.sm,
      paddingVertical: 6,
      marginTop: Spacing.xs,
    },
    brandingSaveBtnText: { ...Typography.captionMedium },

    dupSection: {
      borderTopWidth: StyleSheet.hairlineWidth,
      paddingTop: Spacing.md,
      gap: Spacing.sm,
    },
    dupHeader: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    dupTitle: { ...Typography.bodyMedium, flex: 1 },
    dupSaved: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      borderRadius: Radius.full,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    dupSavedText: { ...Typography.tiny },
    dupSub: { ...Typography.caption },
    stepRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      marginTop: Spacing.xs,
    },
    stepArrow: { padding: 4 },
    stepArrowDisabled: { opacity: 0.3 },
    stepValue: {
      borderRadius: Radius.sm,
      borderWidth: 1,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs,
      minWidth: 52,
      alignItems: "center",
    },
    stepValueText: { ...Typography.bodySemibold },
    dupStepFill: { flex: 1 },
    dupSaveBtn: {
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs,
    },
    dupSaveBtnText: { ...Typography.captionMedium, color: "#fff" },
    dupLabel: { ...Typography.caption },
    clusterPreview: {
      flexDirection: "row",
      gap: Spacing.sm,
      borderRadius: Radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      padding: Spacing.md,
      marginTop: Spacing.xs,
    },
    clusterPreviewText: { ...Typography.caption },
    clusterHint: { ...Typography.caption, marginTop: 3 },

    leaveBtn: {
      alignSelf: "flex-start",
      borderWidth: 1,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs,
    },
    leaveBtnText: { ...Typography.captionMedium },

    inviteActions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: Spacing.sm,
    },
    inviteDeclineBtn: {
      borderWidth: 1,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
    },
    inviteDeclineText: { ...Typography.captionMedium },
    inviteAcceptBtn: {
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      minWidth: 84,
      alignItems: "center",
      justifyContent: "center",
    },
    inviteAcceptText: { ...Typography.captionMedium, color: "#fff" },
  });
}
