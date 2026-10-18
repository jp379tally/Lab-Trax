import React, { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/lib/auth-context";
import { resilientFetch } from "@/lib/query-client";
import { declineToReadOnly, hasDeclinedReadOnly } from "@/lib/entitlement-decision";
import { useTheme } from "@/lib/theme-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import ProviderSignupRecovery from "./ProviderSignupRecovery";

type Entitlement = {
  status?: string;
  accessLevel?: "full" | "read_only" | "locked" | string;
  planType?: "lab" | "provider" | string | null;
  subjectType?: string | null;
  subjectId?: string | null;
};

function isReadOnly(entitlement: Entitlement | undefined): boolean {
  if (!entitlement) return false;
  if (entitlement.status === "free" || entitlement.status === "onboarding_pending") return false;
  // The canonical server access level includes effective waivers. A locked
  // subscription can legitimately still have full access; status alone must
  // not impose a conflicting client-side renewal decision.
  if (entitlement.accessLevel) {
    return entitlement.accessLevel === "read_only" || entitlement.accessLevel === "locked";
  }
  return ["deactivated", "read_only", "locked", "grace"].includes(entitlement.status ?? "");
}

export default function EntitlementDecisionGate({ children }: { children: React.ReactNode }) {
  const { currentUserId, logout } = useAuth();
  const { colors } = useTheme();
  const [acknowledged, setAcknowledged] = useState<boolean | null>(null);
  const [renewing, setRenewing] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const decisionEpoch = useRef(0);
  const entitlementQuery = useQuery({
    queryKey: ["billing", "subscription", currentUserId],
    queryFn: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const response = await resilientFetch("/api/billing/subscription", { signal: controller.signal });
        if (!response.ok) throw new Error(`Failed (${response.status})`);
        const body = (await response.json()) as { entitlement?: Entitlement };
        return body.entitlement;
      } finally {
        clearTimeout(timer);
      }
    },
    enabled: !!currentUserId,
    staleTime: 30_000,
    retry: false,
    refetchInterval: renewing ? 10_000 : false,
  });
  const entitlement = entitlementQuery.data;
  useEffect(() => {
    if (renewing && entitlement?.accessLevel === "full") setRenewing(false);
  }, [entitlement?.accessLevel, renewing]);
  const subject = useMemo(
    () => `${entitlement?.subjectType ?? "account"}:${entitlement?.subjectId ?? "subscription"}`,
    [entitlement?.subjectType, entitlement?.subjectId],
  );
  useEffect(() => {
    decisionEpoch.current += 1;
    setRenewing(false);
    setDeclining(false);
    setDecisionError(null);
    return () => { decisionEpoch.current += 1; };
  }, [currentUserId, subject]);

  useEffect(() => {
    let active = true;
    if (!currentUserId || !isReadOnly(entitlement)) {
      setAcknowledged(null);
      return () => { active = false; };
    }
    hasDeclinedReadOnly(currentUserId, subject).then((value) => {
      if (active) setAcknowledged(value);
    }).catch(() => { if (active) setAcknowledged(false); });
    return () => { active = false; };
  }, [currentUserId, subject, entitlement]);

  const showDecision =
    !!currentUserId &&
    isReadOnly(entitlement) &&
    acknowledged === false &&
    !renewing;
  // Keep the route to billing available while a renewal is being checked. The
  // server entitlement remains authoritative for restoring full access.
  const showBanner = !!currentUserId && (renewing || (isReadOnly(entitlement) && acknowledged === true));
  const billingRoute = "/settings/subscriptions";

  async function decline() {
    if (!currentUserId || declining) return;
    const epoch = decisionEpoch.current;
    setDeclining(true);
    setDecisionError(null);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      let response: Response;
      try {
        response = await resilientFetch("/api/billing/decline-renewal", { method: "POST", signal: controller.signal });
      } finally { clearTimeout(timer); }
      if (!response.ok) throw new Error("Could not save your decision. Please try again.");
      if (epoch !== decisionEpoch.current) return;
      await declineToReadOnly(currentUserId, subject);
      if (epoch !== decisionEpoch.current) return;
      setAcknowledged(true);
      await entitlementQuery.refetch();
    } catch (error) {
      if (epoch === decisionEpoch.current) setDecisionError(error instanceof Error ? error.message : "Could not save your decision. Please try again.");
    } finally {
      if (epoch === decisionEpoch.current) setDeclining(false);
    }
  }

  return (
    <View style={styles.host}>
      {!!currentUserId && entitlement?.status === "onboarding_pending" && (
        <ProviderSignupRecovery />
      )}
      {entitlementQuery.isError && (
        <Pressable testID="entitlement-status-retry" onPress={() => void entitlementQuery.refetch()} style={styles.banner}>
          <Text style={{ color: colors.text }}>Subscription status could not be checked. Tap to try again. Access is still controlled by the server.</Text>
        </Pressable>
      )}
      {showBanner && (
        <Pressable
          testID="read-only-entitlement-banner"
          style={[styles.banner, { backgroundColor: colors.warning + "18", borderColor: colors.warning + "55" }]}
          onPress={() => router.push(billingRoute as never)}
        >
          <Ionicons name="lock-closed-outline" size={16} color={colors.warning} />
          <Text style={[styles.bannerText, { color: colors.text }]}>
            Read-only access. Renew to restore full access.
          </Text>
          <Ionicons name="chevron-forward" size={16} color={colors.warning} />
        </Pressable>
      )}
      {children}
      <Modal
        visible={showDecision}
        transparent
        animationType="fade"
        onRequestClose={() => {}}
        testID="entitlement-decision-modal"
      >
        <View style={styles.backdrop}>
          <View style={[styles.card, { backgroundColor: colors.surface }]}>
            <View style={[styles.icon, { backgroundColor: colors.warning + "18" }]}>
              <Ionicons name="lock-closed-outline" size={26} color={colors.warning} />
            </View>
            <Text style={[styles.title, { color: colors.text }]}>Your account is read-only</Text>
            <Text style={[styles.copy, { color: colors.textSecondary }]}>
              Your access has been deactivated. Renew now to restore full access, or continue
              with permanent read-only access.
            </Text>
            <Pressable
              testID="entitlement-renew-now"
              style={[styles.primary, { backgroundColor: colors.tint }]}
              onPress={() => {
                // The decision is not acknowledged here. The prompt is hidden
                // only to make the hosted billing screen reachable, and the
                // server entitlement remains the source of truth.
                setRenewing(true);
                router.push(billingRoute as never);
              }}
            >
              <Text style={styles.primaryText}>Renew now</Text>
            </Pressable>
            {decisionError && <Text accessibilityRole="alert" testID="entitlement-decision-error" style={{ color: colors.text }}>{decisionError}</Text>}
            <Pressable testID="entitlement-decline" disabled={declining} style={styles.decline} onPress={() => void decline()}>
              <Text style={[styles.declineText, { color: colors.textSecondary }]}>
                 {declining ? "Saving decision…" : "Decline to permanent read-only"}
              </Text>
            </Pressable>
            <Pressable testID="entitlement-sign-out" style={styles.decline} onPress={() => void logout()}>
              <Text style={[styles.declineText, { color: colors.textSecondary }]}>Sign out</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1 },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    marginHorizontal: Spacing.md,
    marginTop: Spacing.sm,
    padding: Spacing.sm,
    borderRadius: Radius.md,
    borderWidth: 1,
  },
  bannerText: { ...Typography.caption, flex: 1 },
  backdrop: {
    flex: 1,
    justifyContent: "center",
    padding: Spacing.lg,
    backgroundColor: "rgba(0,0,0,0.52)",
  },
  card: { borderRadius: Radius.lg, padding: Spacing.xl, gap: Spacing.md },
  icon: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center" },
  title: { ...Typography.h1 },
  copy: { ...Typography.body, lineHeight: 22 },
  primary: { borderRadius: Radius.md, alignItems: "center", paddingVertical: Spacing.md },
  primaryText: { ...Typography.bodyMedium, color: "#fff" },
  decline: { alignItems: "center", paddingVertical: Spacing.sm },
  declineText: { ...Typography.caption },
});