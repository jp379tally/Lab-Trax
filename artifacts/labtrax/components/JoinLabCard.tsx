import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { resilientFetch, apiRequest } from "@/lib/query-client";

interface LabLookupResult {
  id: string;
  name: string;
  displayName: string;
  city: string | null;
  state: string | null;
}

interface MyJoinRequest {
  id: string;
  organizationId: string;
  status: string;
  organization?: {
    id: string;
    name: string;
    displayName?: string | null;
  } | null;
}

const PENDING_KEY = ["join-requests", "mine", "pending"] as const;

// Self-serve "request to join a lab" card shown on the mobile dashboard to
// signed-up users who are not yet a member of any active lab. Mirrors the
// desktop dashboard waiting card: search a lab by name/city, send a join
// request the lab admin can approve, and reflect a pending request back.
export function JoinLabCard() {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selectedLabId, setSelectedLabId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const pendingQuery = useQuery<MyJoinRequest[]>({
    queryKey: PENDING_KEY,
    queryFn: async () => {
      const res = await resilientFetch(
        "/api/organizations/join-requests/mine/pending",
      );
      if (!res.ok) throw new Error(`Could not load your requests (${res.status}).`);
      const body = await res.json();
      return Array.isArray(body?.data) ? body.data : [];
    },
    refetchInterval: 20_000,
  });
  const pendingRequest = pendingQuery.data?.[0] ?? null;

  const lookupQuery = useQuery<LabLookupResult[]>({
    queryKey: ["labs", "lookup", debounced],
    queryFn: async () => {
      const res = await resilientFetch(
        `/api/labs/lookup?q=${encodeURIComponent(debounced)}`,
      );
      if (!res.ok) throw new Error(`Lab search failed (${res.status}).`);
      const body = await res.json();
      return Array.isArray(body?.labs) ? body.labs : [];
    },
    enabled: debounced.length >= 2 && !pendingRequest,
  });
  const labs = lookupQuery.data ?? [];

  const sendRequestMutation = useMutation({
    mutationFn: async (labId: string) => {
      setSelectedLabId(labId);
      await apiRequest(
        "POST",
        `/api/organizations/${labId}/join-requests`,
        { requestedRole: "user" },
      );
    },
    onSuccess: () => {
      setErrorMsg(null);
      setQuery("");
      setDebounced("");
      void queryClient.invalidateQueries({ queryKey: PENDING_KEY });
    },
    onError: (err: Error) => {
      setErrorMsg(
        err.message || "Could not send your request. Please try again.",
      );
    },
    onSettled: () => setSelectedLabId(null),
  });

  const cancelRequestMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/organizations/join-requests/${id}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PENDING_KEY });
    },
  });

  if (pendingRequest) {
    const labName =
      pendingRequest.organization?.displayName ||
      pendingRequest.organization?.name ||
      "the lab";
    return (
      <View style={styles.center}>
        <Ionicons name="time-outline" size={48} color={colors.warning} />
        <Text
          style={[
            Typography.h2,
            { color: colors.text, marginTop: Spacing.md, textAlign: "center" },
          ]}
        >
          Request pending
        </Text>
        <Text
          style={[
            Typography.body,
            {
              color: colors.textSecondary,
              marginTop: Spacing.sm,
              textAlign: "center",
            },
          ]}
        >
          Your request to join {labName} has been sent. You'll get access as soon
          as a lab admin approves it.
        </Text>
        <Pressable
          onPress={() => cancelRequestMutation.mutate(pendingRequest.id)}
          disabled={cancelRequestMutation.isPending}
          style={[
            styles.secondaryBtn,
            { borderColor: colors.border, opacity: cancelRequestMutation.isPending ? 0.5 : 1 },
          ]}
        >
          <Text style={[Typography.bodyMedium, { color: colors.textSecondary }]}>
            {cancelRequestMutation.isPending ? "Cancelling…" : "Cancel request"}
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.center}>
        <Ionicons name="time-outline" size={48} color={colors.tint} />
        <Text
          style={[
            Typography.h2,
            { color: colors.text, marginTop: Spacing.md, textAlign: "center" },
          ]}
        >
          Your account is ready
        </Text>
        <Text
          style={[
            Typography.body,
            {
              color: colors.textSecondary,
              marginTop: Spacing.sm,
              textAlign: "center",
            },
          ]}
        >
          Find your lab below and send a request to join, or wait for a lab admin
          to invite you.
        </Text>
      </View>

      <Text
        style={[
          Typography.captionSemibold,
          { color: colors.textSecondary, marginTop: Spacing.xl, marginBottom: Spacing.xs },
        ]}
      >
        Search for your lab
      </Text>
      <View
        style={[
          styles.inputWrap,
          { borderColor: colors.border, backgroundColor: colors.surface },
        ]}
      >
        <Ionicons name="search" size={18} color={colors.textTertiary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Lab name or city"
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, { color: colors.text }]}
        />
        {lookupQuery.isFetching && (
          <ActivityIndicator size="small" color={colors.textTertiary} />
        )}
      </View>

      {errorMsg && (
        <Text style={[Typography.caption, { color: colors.error, marginTop: Spacing.sm }]}>
          {errorMsg}
        </Text>
      )}

      {debounced.length >= 2 && (
        <View
          style={[
            styles.results,
            { borderColor: colors.border, backgroundColor: colors.surface },
          ]}
        >
          {labs.length === 0 && !lookupQuery.isFetching && (
            <Text
              style={[
                Typography.caption,
                { color: colors.textTertiary, padding: Spacing.md, textAlign: "center" },
              ]}
            >
              No labs found. Try a different search.
            </Text>
          )}
          {labs.map((lab, idx) => {
            const location = [lab.city, lab.state].filter(Boolean).join(", ");
            const sending =
              sendRequestMutation.isPending && selectedLabId === lab.id;
            return (
              <View
                key={lab.id}
                style={[
                  styles.row,
                  idx > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
                ]}
              >
                <View style={{ flex: 1, marginRight: Spacing.sm }}>
                  <Text style={[Typography.bodyMedium, { color: colors.text }]} numberOfLines={1}>
                    {lab.displayName || lab.name}
                  </Text>
                  {location ? (
                    <Text
                      style={[Typography.caption, { color: colors.textSecondary }]}
                      numberOfLines={1}
                    >
                      {location}
                    </Text>
                  ) : null}
                </View>
                <Pressable
                  onPress={() => sendRequestMutation.mutate(lab.id)}
                  disabled={sendRequestMutation.isPending}
                  style={[
                    styles.joinBtn,
                    { backgroundColor: colors.tint, opacity: sendRequestMutation.isPending ? 0.6 : 1 },
                  ]}
                >
                  {sending ? (
                    <ActivityIndicator size="small" color={colors.textInverse} />
                  ) : (
                    <Text style={[Typography.captionSemibold, { color: colors.textInverse }]}>
                      Request to join
                    </Text>
                  )}
                </Pressable>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
    maxWidth: 440,
    alignSelf: "center",
  },
  center: {
    alignItems: "center",
    justifyContent: "center",
  },
  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    height: 46,
  },
  input: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    paddingVertical: 0,
  },
  results: {
    marginTop: Spacing.sm,
    borderWidth: 1,
    borderRadius: Radius.md,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
  },
  joinBtn: {
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.md,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryBtn: {
    marginTop: Spacing.lg,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.lg,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
  },
});
