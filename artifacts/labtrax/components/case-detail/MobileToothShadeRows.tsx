import React, { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetVocabularyQueryKey,
  useGetVocabulary,
  useUpdateCaseRestoration,
  type CanonicalRestoration,
} from "@workspace/api-client-react";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { useTheme } from "@/lib/theme-context";
import { deriveRxSummary, formatRxTeethLabel } from "@/lib/rx-summary";
import { CaseDetailSelect, CaseDetailOptions, caseDetailFieldStyles } from "./CaseDetailField";

export interface MobileToothShadeRowsProps {
  restorations: ReadonlyArray<ToothShadeRestoration> | null | undefined;
  legacyTeeth?: string | null;
  legacyShade?: string | null;
  caseId: string;
  labOrganizationId?: string | null;
  canEdit: boolean;
  onSaved?: () => Promise<unknown> | void;
}

type ToothShadeRestoration = Pick<
  CanonicalRestoration,
  "id" | "toothNumber" | "restorationType" | "arch" | "shade"
>;

const STANDARD_SHADES = [
  "A1", "A2", "A3", "A3.5", "A4",
  "B1", "B2", "B3", "B4",
  "C1", "C2", "C3", "C4",
  "D2", "D3", "D4",
  "BL1", "BL2", "BL3", "BL4",
];

function restorationLabel(restoration: ToothShadeRestoration): string {
  // An explicitly recorded arch is authoritative. Legacy data can encode the
  // arch in free text (U/D, upper/lower) or omit teeth for a denture, so use
  // the same fallback detection as the mobile Rx summary helper.
  if (restoration.arch === "upper") return "Upper arch";
  if (restoration.arch === "lower") return "Lower arch";
  if (restoration.arch === "upper_lower") return "Full arch (upper & lower)";
  const detected = deriveRxSummary([{
    toothNumber: restoration.toothNumber,
    restorationType: restoration.restorationType ?? null,
  }]);
  if (detected.isFullArch) return formatRxTeethLabel(detected);
  return restoration.toothNumber?.trim() || "No tooth specified";
}

function uniqueShadeOptions(
  vocabulary: string[],
  confirmed: string,
  selected: string,
  lastObservedServer: string,
): string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  for (const option of [
    ...vocabulary,
    confirmed,
    selected,
    lastObservedServer,
  ]) {
    const trimmed = option.trim();
    const key = trimmed.toLocaleLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    options.push(trimmed);
  }
  return options;
}

function errorReason(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message;
  }
  return "Could not save this shade.";
}

function ToothShadeRow({
  restoration,
  caseId,
  shadeOptions,
  canEdit,
  onSaved,
}: {
  restoration: ToothShadeRestoration;
  caseId: string;
  shadeOptions: string[];
  canEdit: boolean;
  onSaved?: () => Promise<unknown> | void;
}) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const updateRestoration = useUpdateCaseRestoration();
  const serverShade = (restoration.shade ?? "").trim();
  const [confirmedShade, setConfirmedShade] = useState(serverShade);
  const [lastObservedServerShade, setLastObservedServerShade] =
    useState(serverShade);
  const [selectedShade, setSelectedShade] = useState(serverShade);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const inFlight = useRef(false);

  // Adopt server-confirmed refetches (including edits from another client)
  // without resetting a choice while its mutation is still pending.
  if (!pending && serverShade !== lastObservedServerShade) {
    setLastObservedServerShade(serverShade);
    setConfirmedShade(serverShade);
    setSelectedShade(serverShade);
  }

  const options = useMemo(
    () =>
      uniqueShadeOptions(
        shadeOptions,
        confirmedShade,
        selectedShade,
        lastObservedServerShade,
      ),
    [shadeOptions, confirmedShade, selectedShade, lastObservedServerShade],
  );

  async function saveShade(nextShade: string) {
    if (!canEdit) return;
    setExpanded(false);
    setError(null);
    if (nextShade === confirmedShade) {
      setSelectedShade(confirmedShade);
      return;
    }
    if (!restoration.id) {
      setSelectedShade(confirmedShade);
      setError("This restoration has no saved row ID, so its shade cannot be updated.");
      return;
    }
    if (inFlight.current) return;

    setSelectedShade(nextShade);
    inFlight.current = true;
    setPending(true);
    try {
      await updateRestoration.mutateAsync({
        caseId,
        restorationId: restoration.id,
        data: { shade: nextShade, syncLinkedArch: false },
      });
      // The mutation response confirms the new durable value independently
      // from any later case query/refetch.
      setConfirmedShade(nextShade);
      setSelectedShade(nextShade);

      // The PATCH is committed. Refreshing or notifying the parent is
      // deliberately best-effort; failures here must not invite a duplicate
      // write by presenting the committed change as failed.
      try {
        await Promise.allSettled([
          queryClient.invalidateQueries({ queryKey: ["cases", caseId] }),
          queryClient.invalidateQueries({ queryKey: ["cases"] }),
        ]);
      } catch {
        // Promise.allSettled itself is not expected to reject, but keep refresh
        // work out of the mutation failure path even with unusual clients.
      }
      try {
        await onSaved?.();
      } catch {
        // Parent refresh is also best-effort after a successful PATCH.
      }
    } catch (saveError) {
      setSelectedShade(confirmedShade);
      setError(errorReason(saveError));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const label = restorationLabel(restoration);
  const styles = makeStyles(colors);

  return (
    <View style={styles.row} testID={`tooth-shade-row-${restoration.id ?? "missing-id"}`}>
      <CaseDetailSelect label={label} accessibilityLabel={`Shade for ${label}`}
        labelTestID={`tooth-shade-label-${restoration.id ?? "missing-id"}`}
        testID={`tooth-shade-select-${restoration.id ?? "missing-id"}`}
        valueTestID={`tooth-shade-value-${restoration.id ?? "missing-id"}`}
        valueLabel={selectedShade || (canEdit ? "— No shade —" : "—")}
        expanded={expanded} busy={pending} invalid={!!error}
        onPress={canEdit ? () => setExpanded((value) => !value) : undefined} />

      {expanded && canEdit && !pending ? (
        <CaseDetailOptions label={`Shade for ${label}`}
          options={[{ key: "", label: "— No shade —" }, ...options.map((option) => ({ key: option, label: option }))]}
          selected={selectedShade} onSelect={(value) => void saveShade(value)}
          optionTestID={(value) => value ? `tooth-shade-option-${restoration.id ?? "missing-id"}-${value}` : `tooth-shade-option-clear-${restoration.id ?? "missing-id"}`} />
      ) : null}
      {error ? (
        <Text
          accessibilityRole="alert"
          style={[Typography.caption, { color: colors.error }]}
          testID={`tooth-shade-error-${restoration.id ?? "missing-id"}`}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function MobileToothShadeRows({
  restorations,
  legacyTeeth,
  legacyShade,
  caseId,
  labOrganizationId,
  canEdit,
  onSaved,
}: MobileToothShadeRowsProps) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const vocabularyQuery = useGetVocabulary(
    {
      kind: "shade",
      ...(labOrganizationId ? { labOrganizationId } : {}),
    },
    {
      query: {
        queryKey: getGetVocabularyQueryKey({
          kind: "shade",
          ...(labOrganizationId ? { labOrganizationId } : {}),
        }),
        enabled: !!labOrganizationId,
        staleTime: 120_000,
      },
    },
  );
  const vocabularyData = vocabularyQuery.data?.data;
  const labShades = Array.isArray(vocabularyData)
    ? vocabularyData.map((item) => item.value)
    : [];
  const vocabularyLoaded =
    !!labOrganizationId &&
    !vocabularyQuery.isLoading &&
    !vocabularyQuery.isError &&
    Array.isArray(vocabularyData);
  const hasVocabularyError =
    !!labOrganizationId &&
    (vocabularyQuery.isError ||
      (!vocabularyQuery.isLoading &&
        !Array.isArray(vocabularyData) &&
        vocabularyQuery.data !== undefined));
  const shadeOptions = useMemo(() => {
    if (!vocabularyLoaded) return [];
    const choices = labShades.length > 0 ? labShades : STANDARD_SHADES;
    const seen = new Set<string>();
    return choices.filter((shade) => {
      const key = shade.trim().toLocaleLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [labShades, vocabularyLoaded]);

  const rows = restorations ?? [];
  const legacyEntries = [legacyTeeth?.trim(), legacyShade?.trim()].filter(
    (entry): entry is string => !!entry,
  );

  return (
    <View style={styles.container} testID="mobile-tooth-shade-rows">
      <Text
        style={[
          caseDetailFieldStyles.heading,
          { color: colors.text, marginBottom: Spacing.xs },
        ]}
      >
        Tooth / Shade
      </Text>
      {!!labOrganizationId && vocabularyQuery.isLoading ? (
        <View style={styles.vocabularyStatus} testID="tooth-shade-vocabulary-loading">
          <ActivityIndicator size="small" color={colors.tint} />
          <Text style={[Typography.caption, { color: colors.textSecondary }]}>
            Loading lab shades…
          </Text>
        </View>
      ) : null}
      {hasVocabularyError ? (
        <View style={styles.vocabularyStatus} testID="tooth-shade-vocabulary-error">
          <Text style={[Typography.caption, { color: colors.error, flex: 1 }]}>
            Could not load lab shades.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading lab shades"
            testID="tooth-shade-vocabulary-retry"
            style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: Spacing.sm }}
            onPress={() => void vocabularyQuery.refetch()}
          >
            <Text style={[Typography.caption, { color: colors.tint }]}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
      {!labOrganizationId ? (
        <Text
          style={[Typography.caption, { color: colors.textTertiary }]}
          testID="tooth-shade-vocabulary-unavailable"
        >
          Lab shade vocabulary is unavailable for this case.
        </Text>
      ) : null}
      {rows.length > 0 ? (
        rows.map((restoration, index) => (
          <ToothShadeRow
            // A persisted id is the row identity; the index fallback only keeps
            // malformed/unsaved legacy data renderable without merging rows.
            key={restoration.id ?? `restoration-without-id-${index}`}
            restoration={restoration}
            caseId={caseId}
            shadeOptions={shadeOptions}
            canEdit={canEdit}
            onSaved={onSaved}
          />
        ))
      ) : (
        <View
          style={[
            styles.legacy,
            { backgroundColor: colors.surfaceSecondary, borderColor: colors.border },
          ]}
          testID="tooth-shade-legacy-fallback"
        >
          <Text style={[Typography.body, { color: colors.textSecondary }]}>
            No restoration rows are available for per-tooth shade editing.
            {legacyEntries.length > 0
              ? ` Recorded on the case: ${legacyEntries.join(" — ")}.`
              : ""}
          </Text>
        </View>
      )}
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    container: { width: "100%", minWidth: 0, gap: Spacing.sm },
    row: { width: "100%", minWidth: 0, gap: Spacing.xs, paddingVertical: Spacing.xs },
    vocabularyStatus: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingVertical: Spacing.xs,
    },
    legacy: {
      borderWidth: StyleSheet.hairlineWidth,
      borderStyle: "dashed",
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
    },
  });
}