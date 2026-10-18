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
import { useMe, editableLabMemberships, canAdminAnyLab } from "@/lib/auth-me";
import { useLabLocations } from "@/lib/lab-locations";
import { resilientFetch } from "@/lib/query-client";
import { router } from "expo-router";
import {
  OutgoingPhotosModal,
  type OutgoingPhotoCase,
} from "@/components/OutgoingPhotosModal";
import {
  firstReturnedWizardStage,
  isReturnedLocate,
  setPendingReturnedWizard,
} from "@/lib/returned-case-wizard";

type SingleProps = {
  locatingCase: CanonicalCase | null;
  onDismiss: () => void;
  onLocated: (caseId: string) => void;
  /**
   * Opt-in: when this single locate brings a case back from a complete status
   * to an intake status, navigate to the case's detail screen with the
   * returned-case wizard resumed. Hosts that already sit on that case (the
   * detail screen's related-cases sheet) leave this off so the user isn't
   * navigated away. Bulk locates never trigger the wizard.
   */
  returnedWizardHandoff?: boolean;
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

/**
 * The lab that owns a case. `organizationId` only reaches the client through
 * the canonical case's index signature, so it is narrowed here rather than
 * trusted as a string.
 */
function caseLabOrgId(c: CanonicalCase | null | undefined): string | null {
  const v = c?.labOrganizationId ?? (c as { organizationId?: unknown } | null | undefined)?.organizationId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function patientDisplayName(c: CanonicalCase): string {
  const name = `${c.patientFirstName ?? ""} ${c.patientLastName ?? ""}`.trim();
  return name || "Unnamed patient";
}

/**
 * Returns the shared lowercase status when every case in the array has the
 * same status value, or `null` when the array is empty or statuses differ.
 *
 * Exported so unit tests can exercise the filter logic without rendering the
 * full sheet component.
 */
export function computeCommonBulkStatus(
  cases: ReadonlyArray<{ status?: string | null }>,
): string | null {
  if (cases.length === 0) return null;
  const first = (cases[0]!.status ?? "").toLowerCase();
  return cases.every((c) => (c.status ?? "").toLowerCase() === first)
    ? first
    : null;
}

export function filterSelectableStations(
  stations: ReadonlyArray<{ id: string; status: string; name: string }>,
  currentStatus: string | null,
  currentLabLocationId: string | null,
): Array<{ id: string; status: string; name: string }> {
  return stations.filter((station) =>
    currentLabLocationId != null
      ? station.id !== currentLabLocationId
      : currentStatus === null || station.status !== currentStatus,
  );
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
  // Set after a single-case move to "complete" succeeds; drives the optional
  // outgoing-photo prompt. The prompt renders in a sibling Modal so it
  // survives the sheet itself being dismissed (this component stays mounted
  // in every host — only the Modal's visibility toggles).
  const [outgoingPhotoCases, setOutgoingPhotoCases] = useState<OutgoingPhotoCase[]>([]);

  const updateCase = useUpdateCase();
  const queryClient = useQueryClient();
  const meQuery = useMe();
  // Derive the org that owns this case's locations. For single-case locating
  // use the case's labOrganizationId (the lab that owns the case). For bulk
  // use the first case's org. Fall back to the user's first editable lab only
  // when the case props don't supply an org ID (should be rare).
  const caseOrgId = !isBulk
    ? caseLabOrgId(props.locatingCase)
    : caseLabOrgId(props.locatingCases[0]);
  const orgId = caseOrgId ?? editableLabMemberships(meQuery.data)[0]?.organizationId ?? null;
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

  // Loading / error / loaded are kept distinct so a list that is merely still
  // in flight is never shown as if it were the lab's final list.
  const {
    locations: apiLocations,
    status: locationsStatus,
    retry: retryLocations,
  } = useLabLocations(orgId, isVisible);

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
          body: JSON.stringify({
            caseIds,
            status: selectedStatus,
            ...(selectedId ? { labLocationId: selectedId } : {}),
          }),
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

        // Cases that moved successfully are exactly the updated ids (now
        // includes legacy cases — the server writes their JSON blob too).
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
        // The ["cases"] prefix covers list, dashboard, and mounted detail
        // queries (including ["cases", caseId]).
        await queryClient.invalidateQueries({ queryKey: ["cases"] });
        if (__DEV__) {
          console.log("[Locate] Bulk locate invalidated 'cases' queries");
        }
        onDismiss();

        props.onBulkLocated(succeededIds, failedIds);

        if (failedIds.length > 0) {
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
        data: {
          status: selectedStatus as UpdateCaseInputStatus,
          ...(selectedId ? { labLocationId: selectedId } : {}),
        },
      });
      const successId = locatingCase.id;
      // Completing a case? Offer the optional outgoing-photo capture after
      // the sheet closes. Declining never blocks — the move already happened.
      if (selectedStatus === "complete") {
        setOutgoingPhotoCases([
          {
            caseId: successId,
            patientName: patientDisplayName(locatingCase),
            caseNumber: locatingCase.caseNumber ?? null,
          },
        ]);
      }
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
      // The case just came back to the lab — hand off to the guided wizard on
      // its detail screen rather than duplicating the questions here.
      if (props.returnedWizardHandoff && isReturnedLocate(locatingCase.status, selectedStatus)) {
        const first = firstReturnedWizardStage({ canChangeStep: isAdmin });
        if (first) {
          setPendingReturnedWizard(successId, first);
          router.push(`/case/${successId}` as never);
        }
      }
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

  // In single-case mode the current status is the case's own status.
  // In bulk mode, derive the common status only when ALL selected cases share
  // the same status — if they differ, we can't filter any station out (null
  // means "unknown / mixed"). This mirrors the single-case filter so a user
  // can never pick a same-status station on a homogeneous bulk selection.
  const currentStatus = !isBulk
    ? (props.locatingCase?.status ?? "").toLowerCase()
    : computeCommonBulkStatus(props.locatingCases);

  // When the case has an exact labLocationId, filter out only that specific
  // station — other stations that share the same workflow status remain
  // available, allowing moves between custom stations mapped to the same stage.
  // Bulk mode and cases without labLocationId fall back to the status-based
  // filter (existing behaviour).
  const currentLabLocationId = !isBulk
    ? (props.locatingCase?.labLocationId ?? null)
    : null;

  // Only a genuinely loaded list is ever selectable — loading and error render
  // their own states instead of standing in the built-in station list.
  const stations: { id: string; value: string; label: string }[] =
    locationsStatus === "loaded"
      ? filterSelectableStations(
          apiLocations,
          currentStatus,
          typeof currentLabLocationId === "string" ? currentLabLocationId : null,
        ).map((loc) => ({ id: loc.id, value: loc.status, label: loc.name }))
      : [];

  const headerTitle = isBulk
    ? `Locate ${props.locatingCases.length} Case${props.locatingCases.length === 1 ? "" : "s"}`
    : "Locate Case";

  const headerSubtitle = isBulk
    ? `${props.locatingCases.length} case${props.locatingCases.length === 1 ? "" : "s"} selected`
    : props.locatingCase
    ? `${patientDisplayName(props.locatingCase)}${props.locatingCase.caseNumber ? `  ·  #${props.locatingCase.caseNumber}` : ""}`
    : null;

  return (
    <>
    <OutgoingPhotosModal
      cases={outgoingPhotoCases}
      onDone={() => setOutgoingPhotoCases([])}
    />
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

          {/* Location fetch error — shown instead of the station list */}
          {locationsStatus === "error" ? (
            <View style={styles.fetchError} testID="locate-sheet-locations-error">
              <Ionicons name="cloud-offline-outline" size={28} color={colors.textTertiary} />
              <Text style={[styles.fetchErrorText, { color: colors.textSecondary }]}>
                Couldn't load locations
              </Text>
              <Pressable
                style={[styles.retryBtn, { borderColor: colors.tint }]}
                onPress={retryLocations}
                testID="locate-sheet-locations-retry"
              >
                <Text style={[styles.retryBtnText, { color: colors.tint }]}>Retry</Text>
              </Pressable>
            </View>
          ) : null}

          {/* Still loading — never show the built-in list as a stand-in */}
          {locationsStatus === "loading" ? (
            <View style={styles.fetchError} testID="locate-sheet-locations-loading">
              <ActivityIndicator size="small" color={colors.tint} />
              <Text style={[styles.fetchErrorText, { color: colors.textSecondary }]}>
                Loading locations…
              </Text>
            </View>
          ) : null}

          {/* Loaded, but this lab has no active location to move to */}
          {locationsStatus === "loaded" && stations.length === 0 ? (
            <View style={styles.fetchError} testID="locate-sheet-locations-empty">
              <Ionicons name="location-outline" size={28} color={colors.textTertiary} />
              <Text style={[styles.fetchErrorText, { color: colors.textSecondary }]}>
                {apiLocations.length === 0
                  ? "This lab has no active locations yet."
                  : isBulk
                  ? "No active locations available."
                  : "This case is already at the lab's only active location."}
              </Text>
            </View>
          ) : null}

          {/* Station list — explicit backgroundColor prevents rows from
              appearing on the dark backdrop during scroll overscroll frames */}
          {locationsStatus === "loaded" && stations.length > 0 ? <ScrollView
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
                    // Keyed by the location row id (not its mapped status) so two
                    // custom locations sharing a status stay independently selectable.
                    testID={`locate-option-${station.id}`}
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
          </ScrollView> : null}

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
    </>
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
  fetchError: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: Spacing.xl,
    gap: Spacing.sm,
  },
  fetchErrorText: {
    ...Typography.body,
    textAlign: "center",
  },
  retryBtn: {
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    marginTop: Spacing.xs,
  },
  retryBtnText: {
    ...Typography.bodySemibold,
  },
});
