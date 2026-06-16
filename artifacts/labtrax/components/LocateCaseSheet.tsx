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
import {
  useCases,
  useUpdateCase,
  type CanonicalCase,
  type UpdateCaseInputStatus,
} from "@workspace/api-client-react";
import { useTheme } from "@/lib/theme-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import { CASE_STATIONS } from "@/lib/case-stations";
import { useMe, editableLabMemberships, canAdminAnyLab } from "@/lib/auth-me";
import { getJson } from "@/lib/read-api";
import { router } from "expo-router";

type Props = {
  locatingCase: CanonicalCase | null;
  onDismiss: () => void;
  onLocated: (caseId: string) => void;
};

interface LabLocation {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
  sortOrder: number;
}

function patientDisplayName(c: CanonicalCase): string {
  const name = `${c.patientFirstName ?? ""} ${c.patientLastName ?? ""}`.trim();
  return name || "Unnamed patient";
}

export function LocateCaseSheet({ locatingCase, onDismiss, onLocated }: Props) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();

  const [locateTarget, setLocateTarget] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [apiLocations, setApiLocations] = useState<LabLocation[] | null>(null);

  const updateCase = useUpdateCase();
  const casesQuery = useCases();
  const meQuery = useMe();
  const orgId = editableLabMemberships(meQuery.data)[0]?.organizationId ?? null;
  const isAdmin = canAdminAnyLab(meQuery.data);

  useEffect(() => {
    setLocateTarget(null);
  }, [locatingCase?.id]);

  useEffect(() => {
    if (!orgId || !locatingCase) return;
    let cancelled = false;
    getJson<LabLocation[]>(`/api/locations?organizationId=${orgId}&activeOnly=true`)
      .then((rows) => {
        if (!cancelled) setApiLocations(rows);
      })
      .catch(() => {
        if (!cancelled) setApiLocations(null);
      });
    return () => { cancelled = true; };
  }, [orgId, locatingCase?.id]);

  async function confirmLocate() {
    if (!locatingCase || !locateTarget) return;
    setLocating(true);
    try {
      await updateCase.mutateAsync({
        caseId: locatingCase.id,
        data: { status: locateTarget as UpdateCaseInputStatus },
      });
      const successId = locatingCase.id;
      onDismiss();
      await casesQuery.refetch();
      onLocated(successId);
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
    setLocateTarget(null);
    onDismiss();
  }

  const currentStatus = (locatingCase?.status ?? "").toLowerCase();

  const stations: { value: string; label: string }[] =
    apiLocations !== null
      ? apiLocations
          .filter((loc) => loc.code.toLowerCase() !== currentStatus)
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((loc) => ({ value: loc.code.toLowerCase(), label: loc.name }))
      : CASE_STATIONS.filter((s) => s.value !== currentStatus);

  return (
    <Modal
      visible={locatingCase !== null}
      transparent
      animationType="slide"
      onRequestClose={dismiss}
    >
      <TouchableWithoutFeedback onPress={dismiss}>
        <View style={styles.backdrop} />
      </TouchableWithoutFeedback>

      <View style={styles.sheet}>
        <View
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
              <Text style={[styles.title, { color: colors.text }]}>Locate Case</Text>
              {locatingCase ? (
                <Text
                  style={[styles.subtitle, { color: colors.textSecondary }]}
                  numberOfLines={1}
                >
                  {patientDisplayName(locatingCase)}
                  {locatingCase.caseNumber ? `  ·  #${locatingCase.caseNumber}` : ""}
                </Text>
              ) : null}
            </View>
            {isAdmin ? (
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
              const active = locateTarget === station.value;
              const isLast = index === stations.length - 1;
              return (
                <React.Fragment key={station.value}>
                  <Pressable
                    style={({ pressed }) => [
                      styles.row,
                      active && { backgroundColor: colors.tint + "14" },
                      pressed && !active && { backgroundColor: colors.surfaceAlt },
                    ]}
                    onPress={() => setLocateTarget(station.value)}
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
                    locateTarget && !locating ? colors.tint : colors.border,
                },
              ]}
              onPress={confirmLocate}
              disabled={!locateTarget || locating}
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
        </View>
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
