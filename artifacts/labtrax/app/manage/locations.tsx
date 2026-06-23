import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  PanResponder,
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Platform,
  Switch,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { FormSheet } from "@/components/ui/FormSheet";
import { TextField } from "@/components/ui/TextField";
import { getJson, sendJson, isForbiddenError, ApiError } from "@/lib/read-api";
import { useMe, primaryLabOrgId, canAdminAnyLab } from "@/lib/auth-me";
import { CASE_STATIONS, stationLabelFor } from "@/lib/case-stations";

interface LabLocation {
  id: string;
  name: string;
  code: string;
  status: string;
  isActive: boolean;
  sortOrder: number;
}

const ROW_HEIGHT = 64;
const ROW_GAP = Spacing.sm; // gap between rows in the list

function friendlyError(e: unknown, fallback: string): string {
  if (isForbiddenError(e)) return "Your current role can't make this change. Lab owners and admins manage locations.";
  if (e instanceof ApiError) return e.message;
  return fallback;
}

export default function LocationsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();
  const me = useMe().data;
  const labOrgId = primaryLabOrgId(me);
  const canAdmin = canAdminAnyLab(me);

  const locationsQ = useQuery<LabLocation[]>({
    queryKey: ["locations", labOrgId ?? "", "all"],
    enabled: !!labOrgId,
    staleTime: 30_000,
    queryFn: () =>
      getJson<LabLocation[]>(`/api/locations?organizationId=${encodeURIComponent(labOrgId!)}`),
  });

  // Local ordered list — mirrors server but allows optimistic reorder
  const [items, setItems] = useState<LabLocation[]>([]);
  useEffect(() => {
    if (locationsQ.data) {
      setItems([...locationsQ.data].sort((a, b) => a.sortOrder - b.sortOrder));
    }
  }, [locationsQ.data]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["locations", labOrgId ?? ""] });
    qc.invalidateQueries({ queryKey: ["locations"] });
  };

  const patchOrderMut = useMutation({
    mutationFn: async (changed: { id: string; sortOrder: number }[]) => {
      await Promise.all(
        changed.map(({ id, sortOrder }) =>
          sendJson("PATCH", `/api/locations/${id}`, { sortOrder }),
        ),
      );
    },
    onError: (e) => {
      Alert.alert("Couldn't save order", friendlyError(e, "Please try again."));
      locationsQ.refetch();
    },
    onSuccess: () => {
      invalidate();
    },
  });

  // --- Drag state (all via refs to avoid re-creating PanResponder) ---------
  const dragActiveRef = useRef(false);
  const dragFromIndexRef = useRef(-1);
  const dragHoverIndexRef = useRef(-1);
  const dragStartPageYRef = useRef(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Animated values — one translateY per slot, plus ghost Y
  const rowAnims = useRef<Animated.Value[]>([]);
  const ghostY = useRef(new Animated.Value(0)).current;
  const ghostOpacity = useRef(new Animated.Value(0)).current;
  const listTopRef = useRef(0); // absolute Y of the list container's top edge on screen
  const scrollOffsetRef = useRef(0); // how far the ScrollView has scrolled
  const listContainerRef = useRef<View>(null); // used to measure listTop via measureInWindow

  // Keep rowAnims in sync with list length
  while (rowAnims.current.length < 200) {
    rowAnims.current.push(new Animated.Value(0));
  }

  const [dragIndex, setDragIndex] = useState(-1);
  const [hoverIndex, setHoverIndex] = useState(-1);

  const rowStep = ROW_HEIGHT + ROW_GAP;

  function activateDrag(fromIndex: number, pageY: number) {
    if (!canAdmin) return;
    // Measure the list container's absolute on-screen top using a ref so we
    // get the true value including any layout shifts, without relying on the
    // broken `e.target.measure()` approach (target is a native number, not a node).
    listContainerRef.current?.measureInWindow((_x, py) => {
      listTopRef.current = py;
    });
    dragActiveRef.current = true;
    dragFromIndexRef.current = fromIndex;
    dragHoverIndexRef.current = fromIndex;
    dragStartPageYRef.current = pageY;
    // Position ghost over the dragged row (scroll offset included)
    const relY = pageY - listTopRef.current + scrollOffsetRef.current;
    ghostY.setValue(relY - ROW_HEIGHT / 2);
    ghostOpacity.setValue(1);
    setDragIndex(fromIndex);
    setHoverIndex(fromIndex);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  }

  function moveDrag(pageY: number) {
    if (!dragActiveRef.current) return;
    const from = dragFromIndexRef.current;
    const count = itemsRef.current.length;

    // Account for ScrollView scroll offset so reorder is correct in a scrolled list
    const relY = pageY - listTopRef.current + scrollOffsetRef.current;
    ghostY.setValue(relY - ROW_HEIGHT / 2);

    const newHover = clamp(Math.round(relY / rowStep), 0, count - 1);
    if (newHover === dragHoverIndexRef.current) return;
    dragHoverIndexRef.current = newHover;

    // Animate non-dragged rows to show the gap
    for (let i = 0; i < count; i++) {
      if (i === from) continue;
      const shift = getGapTranslate(i, from, newHover);
      Animated.spring(rowAnims.current[i]!, {
        toValue: shift * rowStep,
        useNativeDriver: true,
        speed: 30,
        bounciness: 0,
      }).start();
    }

    setHoverIndex(newHover);
    Haptics.selectionAsync().catch(() => {});
  }

  function endDrag() {
    if (!dragActiveRef.current) return;
    dragActiveRef.current = false;
    ghostOpacity.setValue(0);

    const from = dragFromIndexRef.current;
    const to = dragHoverIndexRef.current;
    dragFromIndexRef.current = -1;
    dragHoverIndexRef.current = -1;

    // Reset all row animations
    const count = itemsRef.current.length;
    for (let i = 0; i < count; i++) {
      rowAnims.current[i]!.setValue(0);
    }

    setDragIndex(-1);
    setHoverIndex(-1);

    if (from === to) return;

    const next = [...itemsRef.current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    const updated = next.map((item, i) => ({ ...item, sortOrder: i }));
    setItems(updated);

    const changed = updated.filter((item, i) => {
      const orig = itemsRef.current.find((x) => x.id === item.id);
      return orig && orig.sortOrder !== i;
    });
    if (changed.length > 0) {
      patchOrderMut.mutate(changed.map((item) => ({ id: item.id, sortOrder: item.sortOrder })));
    }
  }

  // Editor state
  const [editor, setEditor] = useState<LabLocation | "new" | null>(null);

  const draggedItem = dragIndex >= 0 ? items[dragIndex] : null;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable
          style={styles.backBtn}
          onPress={() => router.back()}
          hitSlop={8}
          testID="locations-back"
        >
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>Locations</Text>
        {canAdmin ? (
          <Pressable
            style={styles.addBtn}
            onPress={() => setEditor("new")}
            hitSlop={8}
            testID="locations-add"
          >
            <Ionicons name="add" size={24} color={colors.tint} />
          </Pressable>
        ) : null}
      </View>

      {locationsQ.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : locationsQ.isError ? (
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>Couldn't load locations</Text>
          <Pressable onPress={() => locationsQ.refetch()}>
            <Text style={[styles.emptyBody, { color: colors.tint }]}>Tap to retry</Text>
          </Pressable>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="location-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>No locations yet</Text>
          <Text style={styles.emptyBody}>
            Add lab stations to let staff track where cases are.
          </Text>
        </View>
      ) : (
        <View ref={listContainerRef} style={styles.listContainer}>
          {canAdmin ? (
            <Text style={[styles.hint, { color: colors.textTertiary }]}>
              Long-press{" "}
              <Ionicons name="reorder-three-outline" size={13} color={colors.textTertiary} /> to
              drag and reorder
            </Text>
          ) : null}
          <ScrollView
            contentContainerStyle={[
              styles.list,
              { paddingBottom: insets.bottom + Spacing.xl },
            ]}
            scrollEnabled={dragIndex < 0}
            scrollEventThrottle={16}
            onScroll={(e) => {
              scrollOffsetRef.current = e.nativeEvent.contentOffset.y;
            }}
          >
            {items.map((item, index) => (
              <LocationRow
                key={item.id}
                item={item}
                index={index}
                dragIndex={dragIndex}
                translateY={rowAnims.current[index]!}
                canAdmin={canAdmin}
                colors={colors}
                styles={styles}
                onPress={() => canAdmin && dragIndex < 0 && setEditor(item)}
                onActivateDrag={activateDrag}
                onMoveDrag={moveDrag}
                onEndDrag={endDrag}
              />
            ))}
          </ScrollView>

          {/* Floating ghost row shown while dragging */}
          {draggedItem ? (
            <Animated.View
              style={[
                styles.ghost,
                styles.row,
                {
                  backgroundColor: colors.surface,
                  borderColor: colors.tint + "50",
                  opacity: ghostOpacity,
                  transform: [{ translateY: ghostY }],
                },
              ]}
              pointerEvents="none"
            >
              <View style={styles.rowInner}>
                <View style={styles.rowMain}>
                  <Text style={[styles.rowName, { color: colors.text }]} numberOfLines={1}>
                    {draggedItem.name}
                  </Text>
                  <Text style={[styles.rowCode, { color: colors.textTertiary }]} numberOfLines={1}>
                    {stationLabelFor(draggedItem.status)}
                  </Text>
                </View>
                <View style={styles.handle}>
                  <Ionicons name="reorder-three-outline" size={22} color={colors.tint} />
                </View>
              </View>
            </Animated.View>
          ) : null}
        </View>
      )}

      {editor ? (
        <LocationEditor
          labOrgId={labOrgId!}
          location={editor === "new" ? null : editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            locationsQ.refetch().then(() => invalidate());
          }}
        />
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// LocationRow — each row has its own PanResponder on the handle
// ---------------------------------------------------------------------------

interface LocationRowProps {
  item: LabLocation;
  index: number;
  dragIndex: number;
  translateY: Animated.Value;
  canAdmin: boolean;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  onPress: () => void;
  onActivateDrag: (fromIndex: number, pageY: number) => void;
  onMoveDrag: (pageY: number) => void;
  onEndDrag: () => void;
}

function LocationRow({
  item,
  index,
  dragIndex,
  translateY,
  canAdmin,
  colors,
  styles,
  onPress,
  onActivateDrag,
  onMoveDrag,
  onEndDrag,
}: LocationRowProps) {
  const isDragging = dragIndex === index;

  // Track whether this row's long-press has activated a drag
  const isActiveRef = useRef(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onActivateDragRef = useRef(onActivateDrag);
  const onMoveDragRef = useRef(onMoveDrag);
  const onEndDragRef = useRef(onEndDrag);
  onActivateDragRef.current = onActivateDrag;
  onMoveDragRef.current = onMoveDrag;
  onEndDragRef.current = onEndDrag;

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => canAdmin,
      onMoveShouldSetPanResponder: () => isActiveRef.current,
      onPanResponderGrant: (evt) => {
        isActiveRef.current = false;
        const pageY = evt.nativeEvent.pageY;
        longPressTimerRef.current = setTimeout(() => {
          isActiveRef.current = true;
          onActivateDragRef.current(index, pageY);
        }, 350);
      },
      onPanResponderMove: (evt) => {
        if (!isActiveRef.current) {
          // Cancel long press if significant movement before threshold
          if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
          }
          return;
        }
        onMoveDragRef.current(evt.nativeEvent.pageY);
      },
      onPanResponderRelease: () => {
        if (longPressTimerRef.current) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
        if (isActiveRef.current) {
          isActiveRef.current = false;
          onEndDragRef.current();
        }
      },
      onPanResponderTerminate: () => {
        if (longPressTimerRef.current) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
        if (isActiveRef.current) {
          isActiveRef.current = false;
          onEndDragRef.current();
        }
      },
    }),
  ).current;

  return (
    <Animated.View
      style={[
        styles.row,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          transform: [{ translateY }],
          opacity: isDragging ? 0 : 1,
        },
        !item.isActive && styles.rowInactive,
      ]}
    >
      <Pressable
        style={styles.rowPressable}
        onPress={onPress}
        android_ripple={{ color: colors.border }}
        disabled={dragIndex >= 0}
      >
        <View style={styles.rowInner}>
          <View style={styles.rowMain}>
            <Text
              style={[styles.rowName, { color: item.isActive ? colors.text : colors.textTertiary }]}
              numberOfLines={1}
            >
              {item.name}
            </Text>
            <Text style={[styles.rowCode, { color: colors.textTertiary }]} numberOfLines={1}>
              {stationLabelFor(item.status)}
            </Text>
          </View>
          {!item.isActive ? (
            <View style={[styles.badge, { backgroundColor: colors.border }]}>
              <Text style={[styles.badgeText, { color: colors.textTertiary }]}>Inactive</Text>
            </View>
          ) : null}
          {canAdmin ? (
            <View style={styles.handle} {...pan.panHandlers} testID={`drag-handle-${item.id}`}>
              <Ionicons name="reorder-three-outline" size={22} color={colors.textTertiary} />
            </View>
          ) : null}
        </View>
      </Pressable>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// LocationEditor
// ---------------------------------------------------------------------------

function LocationEditor({
  labOrgId,
  location,
  onClose,
  onSaved,
}: {
  labOrgId: string;
  location: LabLocation | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(location?.name ?? "");
  const [status, setStatus] = useState(location?.status ?? "received");
  const [isActive, setIsActive] = useState(location?.isActive ?? true);
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  useEffect(() => {
    setName(location?.name ?? "");
    setStatus(location?.status ?? "received");
    setIsActive(location?.isActive ?? true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location?.id]);

  const save = useMutation({
    mutationFn: async () => {
      if (location) {
        return sendJson("PATCH", `/api/locations/${location.id}`, {
          name: name.trim(),
          status,
          isActive,
        });
      }
      return sendJson("POST", "/api/locations", {
        organizationId: labOrgId,
        name: name.trim(),
        status,
        isActive,
      });
    },
    onSuccess: onSaved,
    onError: (e) => Alert.alert("Couldn't save", friendlyError(e, "Please try again.")),
  });

  const remove = useMutation({
    mutationFn: () => sendJson("DELETE", `/api/locations/${location!.id}`),
    onSuccess: onSaved,
    onError: (e) => Alert.alert("Couldn't delete", friendlyError(e, "Please try again.")),
  });

  function confirmDelete() {
    Alert.alert(
      "Delete location",
      `Remove "${location!.name}"? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => remove.mutate() },
      ],
    );
  }

  const canSave = name.trim().length > 0 && status.trim().length > 0;

  return (
    <FormSheet
      visible
      title={location ? "Edit location" : "New location"}
      onClose={onClose}
      onSubmit={() => save.mutate()}
      submitting={save.isPending || remove.isPending}
      submitDisabled={!canSave}
      onDelete={location ? confirmDelete : undefined}
    >
      <TextField
        label="Name"
        required
        value={name}
        onChangeText={setName}
        placeholder="e.g. In Porcelain"
        autoFocus
      />
      <Text style={[styles.stageLabel, { color: colors.text }]}>
        Workflow stage <Text style={{ color: colors.error }}>*</Text>
      </Text>
      <Text style={[styles.stageHint, { color: colors.textSecondary }]}>
        Cases moved to this station are set to this stage.
      </Text>
      <View style={styles.stageGrid}>
        {CASE_STATIONS.map((opt) => {
          const selected = opt.value === status;
          return (
            <Pressable
              key={opt.value}
              onPress={() => setStatus(opt.value)}
              style={[
                styles.stageChip,
                {
                  backgroundColor: selected ? colors.tint : colors.surface,
                  borderColor: selected ? colors.tint : colors.border,
                },
              ]}
            >
              <Text
                style={[
                  styles.stageChipText,
                  { color: selected ? colors.surface : colors.text },
                ]}
              >
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.toggleRow}>
        <View style={styles.toggleLabel}>
          <Text style={[styles.toggleTitle, { color: colors.text }]}>Active</Text>
          <Text style={[styles.toggleSub, { color: colors.textSecondary }]}>
            Inactive locations won't appear in the Locate Case list
          </Text>
        </View>
        <Switch
          value={isActive}
          onValueChange={setIsActive}
          trackColor={{ true: colors.tint, false: colors.border }}
          thumbColor={Platform.OS === "android" ? colors.surface : undefined}
        />
      </View>
    </FormSheet>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getGapTranslate(index: number, dragIndex: number, hoverIndex: number): number {
  if (dragIndex < 0 || index === dragIndex) return 0;
  if (dragIndex < hoverIndex && index > dragIndex && index <= hoverIndex) return -1;
  if (dragIndex > hoverIndex && index >= hoverIndex && index < dragIndex) return 1;
  return 0;
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.md,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.xs,
    },
    backBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
    title: { ...Typography.h1, color: c.text, flex: 1, marginLeft: Spacing.xs },
    addBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
    hint: {
      ...Typography.caption,
      paddingHorizontal: Spacing.lg,
      paddingBottom: Spacing.xs,
    },
    listContainer: { flex: 1, position: "relative" },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: Spacing.xl,
      gap: Spacing.sm,
      minHeight: 280,
    },
    emptyTitle: { ...Typography.h3, color: c.text, textAlign: "center" },
    emptyBody: { ...Typography.body, color: c.textSecondary, textAlign: "center" },
    list: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.xs, gap: ROW_GAP },
    row: {
      height: ROW_HEIGHT,
      borderRadius: Radius.md,
      borderWidth: 1,
      overflow: "hidden",
    },
    rowInactive: { opacity: 0.6 },
    rowPressable: { flex: 1 },
    rowInner: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.md,
      gap: Spacing.sm,
    },
    rowMain: { flex: 1, gap: 2 },
    rowName: { ...Typography.bodySemibold },
    rowCode: { ...Typography.caption },
    stageLabel: { ...Typography.bodySemibold, marginBottom: 2 },
    stageHint: { ...Typography.caption, marginBottom: Spacing.sm },
    stageGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: Spacing.xs,
      marginBottom: Spacing.md,
    },
    stageChip: {
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.md,
      borderWidth: 1,
    },
    stageChipText: { ...Typography.caption },
    badge: {
      paddingHorizontal: Spacing.sm,
      paddingVertical: 2,
      borderRadius: Radius.full,
    },
    badgeText: { ...Typography.caption },
    handle: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
    },
    ghost: {
      position: "absolute",
      left: Spacing.lg,
      right: Spacing.lg,
      borderWidth: 1.5,
      elevation: 8,
      shadowColor: "#000",
      shadowOpacity: 0.18,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
      zIndex: 999,
    },
    toggleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      paddingVertical: Spacing.xs,
    },
    toggleLabel: { flex: 1, gap: 2 },
    toggleTitle: { ...Typography.bodySemibold },
    toggleSub: { ...Typography.caption },
  });
}
