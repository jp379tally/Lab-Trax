import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import {
  useUpdateCase,
  type CanonicalCase,
  type UpdateCaseInputStatus,
} from "@workspace/api-client-react";
import { useTheme } from "@/lib/theme-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import { CASE_STATIONS } from "@/lib/case-stations";
import { useMe, editableLabMemberships, canAdminAnyLab } from "@/lib/auth-me";
import { getJson } from "@/lib/read-api";
import { resilientFetch } from "@/lib/query-client";
import { router } from "expo-router";

type SingleProps = {
  locatingCase: CanonicalCase | null;
  onDismiss: () => void;
  onLocated: (caseId: string) => void;
  locatingCases?: undefined;
  onBulkLocated?: undefined;
};

type BulkProps = {
  locatingCase?: undefined;
  onDismiss: () => void;
  onLocated?: undefined;
  locatingCases: CanonicalCase[];
  onBulkLocated: (succeededIds: string[], failedIds: string[]) => void;
};

type Props = SingleProps | BulkProps;

interface LabLocation {
  id: string;
  name: string;
  code: string;
  status: string;
  isActive: boolean;
  sortOrder: number;
}

function patientDisplayName(c: CanonicalCase): string {
  const name = `${c.patientFirstName ?? ""} ${c.patientLastName ?? ""}`.trim();
  return name || "Unnamed patient";
}

export function LocateCaseSheet(props: Props) {
  const { onDismiss } = props;
  const isBulk = props.locatingCases !== undefined;

  const insets = useSafeAreaInsets();
  const { colors } = useTheme();

  // selectedId is the unique location row id; selectedStatus is the workflow
  // stage sent to the API. Kept separate so two locations sharing the same
  // status never both appear selected.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [apiLocations, setApiLocations] = useState<LabLocation[] | null>(null);

  const updateCase = useUpdateCase();
  const queryClient = useQueryClient();
  const meQuery = useMe();
  const orgId = editableLabMemberships(meQuery.data)[0]?.organizationId ?? null;
  const isAdmin = canAdminAnyLab(meQuery.data);

  const isVisible = isBulk
    ? props.locatingCases.length > 0
    : props.locatingCase !== null;

  const singleCaseId = !isBulk ? props.locatingCase?.id : undefined;

  useEffect(() => {
    setSelectedId(null);
    setSelectedStatus(null);
  }, [singleCaseId, isBulk]);

  // Also clear the selection whenever the sheet closes so that reopening it
  // never shows a pre-selected station from a previous session.
  useEffect(() => {
    if (!isVisible) { setSelectedId(null); setSelectedStatus(null); }
  }, [isVisible]);

  useEffect(() => {
    if (!orgId || !isVisible) return;
    let cancelled = false;
    getJson<LabLocation[]>(`/api/locations?organizationId=${orgId}&activeOnly=true`)
      .then((rows) => {
        if (!cancelled) setApiLocations(rows);
      })
      .catch(() => {
        if (!cancelled) setApiLocations(null);
      });
    return () => { cancelled = true; };
  }, [orgId, isVisible]);

  async function confirmLocate() {
    if (!selectedStatus) return;

    if (isBulk) {
      const cases = props.locatingCases;
      if (cases.length === 0) return;
      setLocating(true);
      try {
        const caseIds = cases.map((c) => c.id);
        if (__DEV__) {
          console.log("[Locate] Bulk locate request", {
            caseIds,
            selectedId,
            selectedStatus,
          });
        }
        const response = await resilientFetch("/api/cases/bulk-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ caseIds, status: selectedStatus }),
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          const msg = (body as { message?: string })?.message ?? `Server error (${response.status})`;
          throw new Error(msg);
        }

        const body = await response.json();
        const data = (body?.data ?? body) as {
          updatedIds?: string[];
          skippedLegacyIds?: string[];
          updatedCount?: number;
          skippedLegacyCount?: number;
        };
        // The id arrays are the source of truth for per-case success/failure
        // (the API server ships in lockstep with this app and always returns
        // them). The legacy count aliases are only consulted as a last resort
        // for the user-facing alert wording below; they cannot reconstruct
        // which specific ids moved, so succeededIds/failedIds rely on the
        // arrays alone.
        const updatedIds = data.updatedIds ?? [];
        const skippedLegacyIds = data.skippedLegacyIds ?? [];
        const updatedCount = data.updatedIds?.length ?? data.updatedCount ?? 0;
        const skippedLegacyCount =
          data.skippedLegacyIds?.length ?? data.skippedLegacyCount ?? 0;

        // Cases that moved successfully are exactly the canonical updated ids.
        const accountedFor = new Set([...updatedIds, ...skippedLegacyIds]);
        // Any IDs the server never reported back are treated as failures.
        const failedIds: string[] = caseIds.filter((id) => !accountedFor.has(id));
        const succeededIds = updatedIds;

        if (__DEV__) {
          console.log("[Locate] Bulk locate response", {
            updatedIds,
            skippedLegacyIds,
            updatedCount,
            skippedLegacyCount,
            failedIds,
          });
        }

        // Await the refetch so the dashboard/HUD shows fresh status before the
        // sheet closes and the success callback fires (eliminates stale HUD).
        await queryClient.invalidateQueries({ queryKey: ["cases"] });
        if (__DEV__) {
          console.log("[Locate] Bulk locate invalidated 'cases' queries");
        }
        onDismiss();

        props.onBulkLocated(succeededIds, failedIds);

        if (updatedCount === 0 && skippedLegacyCount > 0 && failedIds.length === 0) {
          // Every selected case is a legacy blob — bulk-status can't move them.
          Alert.alert(
            "Can't locate these cases",
            `${skippedLegacyCount === 1 ? "This case is" : `These ${skippedLegacyCount} cases are`} in an older format and must be opened individually to be located.`,
          );
        } else if (skippedLegacyCount > 0 && failedIds.length === 0) {
          Alert.alert(
            "Partially located",
            `${updatedCount} case${updatedCount !== 1 ? "s" : ""} located. ${skippedLegacyCount} legacy case${skippedLegacyCount !== 1 ? "s" : ""} could not be moved (legacy format — open each case to locate it manually).`,
          );
        } else if (failedIds.length > 0) {
          Alert.alert(
            updatedCount === 0 ? "Locate failed" : "Partial success",
            updatedCount === 0
              ? `Could not locate ${failedIds.length} case${failedIds.length === 1 ? "" : "s"}. Please check your connection and try again.`
              : `${updatedCount} case${updatedCount !== 1 ? "s" : ""} located. ${failedIds.length} could not be moved — please try again for those.`,
          );
        }
      } catch (e) {
        console.warn("[Locate] Bulk locate unexpected error:", e);
        Alert.alert("Couldn't locate cases", e instanceof Error ? e.message : "Please try again.");
      } finally {
        setLocating(false);
      }
      return;
    }

    const locatingCase = props.locatingCase;
    if (!locatingCase) return;
    setLocating(true);
    try {
      if (__DEV__) {
        console.log("[Locate] Single locate request", {
          caseId: locatingCase.id,
          selectedId,
          selectedStatus,
        });
      }
      await updateCase.mutateAsync({
        caseId: locatingCase.id,
        data: { status: selectedStatus as UpdateCaseInputStatus },
      });
      const successId = locatingCase.id;
      // Await both the list and the individual case query so the HUD/detail
      // screen show fresh status before the sheet closes.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["cases"] }),
        queryClient.invalidateQueries({ queryKey: ["cases", successId] }),
      ]);
      if (__DEV__) {
        console.log("[Locate] Single locate invalidated queries", { successId });
      }
      onDismiss();
      props.onLocated(successId);
    } catch (e) {
      Alert.alert(
        "Couldn't locate case",
        e instanceof Error ? e.message : "Please try again.",
      );
    } finally {
      setLocating(false);
    }
  }

  function dismiss() {
    if (locating) return;
    setSelectedId(null);
    setSelectedStatus(null);
    onDismiss();
  }

  const currentStatus = !isBulk
    ? (props.locatingCase?.status ?? "").toLowerCase()
    : null;

  const stations: { id: string; value: string; label: string }[] =
    apiLocations !== null && apiLocations.length > 0
      ? apiLocations
          // `value` = mapped workflow stage sent to the API (a valid case-status).
          // `id`    = unique location row id used for selection + React key, so
          //           two locations sharing the same status never both appear selected.
          .filter((loc) => isBulk || loc.status !== currentStatus)
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((loc) => ({ id: loc.id, value: loc.status, label: loc.name }))
      : CASE_STATIONS
          .filter((s) => isBulk || s.value !== currentStatus)
          .map((s) => ({ id: s.value, value: s.value, label: s.label }));

  const headerTitle = isBulk
    ? `Locate ${props.locatingCases.length} Case${props.locatingCases.length === 1 ? "" : "s"}`
    : "Locate Case";

  const headerSubtitle = isBulk
    ? `${props.locatingCases.length} case${props.locatingCases.length === 1 ? "" : "s"} selected`
    : props.locatingCase
    ? `${patientDisplayName(props.locatingCase)}${props.locatingCase.caseNumber ? `  ·  #${props.locatingCase.caseNumber}` : ""}`
    : null;

  return (
    <Modal
      visible={isVisible}
      transparent
      animationType="slide"
      onRequestClose={dismiss}
    >
      <TouchableWithoutFeedback onPress={dismiss}>
        <View style={styles.backdrop} />
      </TouchableWithoutFeedback>

      <View style={styles.sheet}>
        {/* Guard: only render sheet body when visible to avoid duplicate testIDs
            when multiple LocateCaseSheet instances coexist in the tree. */}
        {!isVisible ? null : <View
          style={[
            styles.sheetInner,
            {
              backgroundColor: colors.surface,
              paddingBottom: Math.max(insets.bottom, Spacing.lg),
            },
          ]}
        >
          {/* Handle */}
          <View style={[styles.handle, { backgroundColor: colors.border }]} />

          {/* Header */}
          <View style={styles.headerRow}>
            <View style={styles.headerText}>
              <Text style={[styles.title, { color: colors.text }]}>{headerTitle}</Text>
              {headerSubtitle ? (
                <Text
                  style={[styles.subtitle, { color: colors.textSecondary }]}
                  numberOfLines={1}
                >
                  {headerSubtitle}
                </Text>
              ) : null}
            </View>
            {isAdmin && !isBulk ? (
              <Pressable
                style={[styles.editOrderBtn, { backgroundColor: colors.surfaceAlt }]}
                onPress={() => {
                  dismiss();
                  router.push("/manage/locations" as never);
                }}
                hitSlop={8}
                testID="locate-sheet-edit-order"
              >
                <Ionicons name="reorder-three-outline" size={20} color={colors.tint} />
              </Pressable>
            ) : null}
          </View>

          {/* Station list — explicit backgroundColor prevents rows from
              appearing on the dark backdrop during scroll overscroll frames */}
          <ScrollView
            style={[styles.list, { backgroundColor: colors.surface }]}
            contentContainerStyle={{ backgroundColor: colors.surface }}
            bounces={false}
            showsVerticalScrollIndicator={false}
          >
            {stations.map((station, index) => {
              const active = selectedId === station.id;
              const isLast = index === stations.length - 1;
              return (
                <React.Fragment key={station.id}>
                  <Pressable
                    style={({ pressed }) => [
                      styles.row,
                      active && { backgroundColor: colors.tint + "14" },
                      pressed && !active && { backgroundColor: colors.surfaceAlt },
                    ]}
                    onPress={() => { setSelectedId(station.id); setSelectedStatus(station.value); }}
                    android_ripple={{ color: colors.tint + "28" }}
                    testID={`locate-option-${station.value}`}
                  >
                    <Text
                      style={[
                        styles.rowLabel,
                        { color: active ? colors.tint : colors.text },
                      ]}
                    >
                      {station.label}
                    </Text>

                    {active ? (
                      <Ionicons name="checkmark-circle" size={20} color={colors.tint} />
                    ) : (
                      <View
                        style={[styles.radio, { borderColor: colors.border }]}
                      />
                    )}
                  </Pressable>

                  {!isLast && (
                    <View
                      style={[styles.divider, { backgroundColor: colors.border }]}
                    />
                  )}
                </React.Fragment>
              );
            })}
          </ScrollView>

          {/* Action buttons */}
          <View style={styles.actions}>
            <Pressable
              style={[
                styles.cancelBtn,
                { borderColor: colors.border, backgroundColor: colors.surfaceAlt },
              ]}
              onPress={dismiss}
              disabled={locating}
            >
              <Text style={[styles.cancelBtnText, { color: colors.textSecondary }]}>
                Cancel
              </Text>
            </Pressable>

            <Pressable
              style={[
                styles.locateBtn,
                {
                  backgroundColor:
                    selectedId && !locating ? colors.tint : colors.border,
                },
              ]}
              onPress={confirmLocate}
              disabled={!selectedId || locating}
              testID="locate-sheet-confirm"
            >
              {locating ? (
                <ActivityIndicator size="small" color={colors.textInverse} />
              ) : (
                <Text style={[styles.locateBtnText, { color: colors.textInverse }]}>
                  Locate
                </Text>
              )}
            </Pressable>
          </View>
        </View>}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  sheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: "80%",
  },
  sheetInner: {
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    gap: Spacing.md,
    overflow: "hidden",
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: Spacing.xs,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  editOrderBtn: {
    width: 36,
    height: 36,
    borderRadius: Radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    ...Typography.h2,
  },
  subtitle: {
    ...Typography.caption,
    marginTop: 2,
  },
  list: {
    maxHeight: 360,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.xs,
    borderRadius: Radius.sm,
  },
  rowLabel: {
    ...Typography.bodySemibold,
    flex: 1,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: Spacing.xs,
  },
  actions: {
    flexDirection: "row",
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  cancelBtn: {
    flex: 1,
    alignItems: "center",
    paddingVertical: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
  },
  cancelBtnText: {
    ...Typography.bodySemibold,
  },
  locateBtn: {
    flex: 2,
    alignItems: "center",
    paddingVertical: Spacing.md,
    borderRadius: Radius.md,
  },
  locateBtnText: {
    ...Typography.bodySemibold,
  },
});
