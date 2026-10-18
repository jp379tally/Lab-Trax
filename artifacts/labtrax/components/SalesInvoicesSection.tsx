import React, { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { TextField } from "@/components/ui/TextField";
import { formatMoney } from "@/lib/format";
import {
  SALES_PRESETS,
  customRange,
  rangeForPreset,
  type SalesPreset,
  type SalesRange,
} from "@/lib/sales-range";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import {
  useSalesInvoicePages,
  getSalesInvoices,
  fetchAllSalesInvoicePages,
  buildSalesInvoiceExportRows,
  salesInvoiceExportRowsToCsv,
} from "@workspace/api-client-react";

export function SalesInvoicesSection({
  organizationId,
  initialPreset = "month",
}: {
  organizationId: string;
  initialPreset?: SalesPreset;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [preset, setPreset] = useState<SalesPreset>(initialPreset);
  const [presetRange, setPresetRange] = useState<SalesRange>(() =>
    rangeForPreset(initialPreset === "custom" ? "month" : initialPreset),
  );
  const [fromText, setFromText] = useState("");
  const [toText, setToText] = useState("");
  const [applied, setApplied] = useState<SalesRange | null>(null);
  const [customError, setCustomError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const range = preset === "custom" ? applied : presetRange;

  const q = useSalesInvoicePages(
    { organizationId, dateFrom: range?.dateFrom ?? "", dateTo: range?.dateTo ?? "" },
    !!range,
  );
  const pages = q.data?.pages ?? [];
  const rows = pages.flatMap((p) => p.rows);
  const first = pages[0];
  const nextFailed = q.isFetchNextPageError;

  function choose(p: SalesPreset) {
    if (exporting) return;
    setPreset(p);
    if (p !== "custom") setPresetRange(rangeForPreset(p));
  }

  function applyCustom() {
    if (exporting) return;
    const r = customRange(fromText, toText);
    if ("error" in r) {
      setCustomError(r.error);
      return;
    }
    setCustomError(null);
    setApplied(r.range);
  }

  async function exportInvoices() {
    if (!range || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      if (!(await Sharing.isAvailableAsync())) {
        throw new Error("Sharing isn't available on this device.");
      }
      const result = await fetchAllSalesInvoicePages(async (offset, limit) =>
        (await getSalesInvoices({
          organizationId,
          dateFrom: range.dateFrom,
          dateTo: range.dateTo,
          offset,
          limit,
        })).data,
      );
      const csv = salesInvoiceExportRowsToCsv(
        buildSalesInvoiceExportRows(result, range.dateFrom, range.dateTo),
      );
      const cacheDirectory = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
      if (!cacheDirectory) throw new Error("A temporary file location isn't available.");
      const filename = `sales-invoices-${range.dateFrom.slice(0, 10)}-${range.dateTo.slice(0, 10)}.csv`;
      const uri = `${cacheDirectory}${filename}`;
      await FileSystem.writeAsStringAsync(uri, csv);
      await Sharing.shareAsync(uri, {
        mimeType: "text/csv",
        dialogTitle: "Export invoices behind billed sales",
        UTI: "public.comma-separated-values-text",
      });
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "Couldn't export invoices. Please try again.",
      );
    } finally {
      setExporting(false);
    }
  }

  return (
    <Card style={styles.card} testID="sales-invoices-section">
      <View style={styles.header}>
        <Text style={styles.title}>Invoices behind billed sales</Text>
        {range && (
          <Pressable
            style={[styles.exportBtn, exporting && styles.exportBtnDisabled]}
            onPress={() => void exportInvoices()}
            disabled={exporting}
            accessibilityRole="button"
            accessibilityLabel="Export invoices CSV"
            testID="sales-invoices-export"
          >
            {exporting ? <ActivityIndicator size="small" color={colors.tint} /> : null}
            <Text style={styles.btnText}>{exporting ? "Preparing…" : "Export CSV"}</Text>
          </Pressable>
        )}
      </View>
      {exportError ? <Text style={styles.error} role="alert" testID="sales-invoices-export-error">{exportError}</Text> : null}
      <View style={styles.presets}>
        {SALES_PRESETS.map((p) => (
          <Pressable
            key={p.key}
            onPress={() => choose(p.key)}
            disabled={exporting}
            style={[styles.chip, preset === p.key && styles.chipActive]}
            accessibilityRole="button"
            accessibilityState={{ selected: preset === p.key }}
            testID={`sales-preset-${p.key}`}
          >
            <Text style={[styles.chipText, preset === p.key && styles.chipTextActive]}>{p.label}</Text>
          </Pressable>
        ))}
      </View>

      {preset === "custom" && (
        <View style={styles.custom}>
          <TextField label="From (YYYY-MM-DD)" value={fromText} onChangeText={setFromText} placeholder="2025-01-01" autoCapitalize="none" autoCorrect={false} editable={!exporting} />
          <TextField label="To (YYYY-MM-DD)" value={toText} onChangeText={setToText} placeholder="2025-01-31" autoCapitalize="none" autoCorrect={false} onSubmitEditing={applyCustom} editable={!exporting} />
          {customError ? <Text style={styles.error} testID="sales-custom-error">{customError}</Text> : null}
          <Pressable style={[styles.btn, exporting && styles.exportBtnDisabled]} onPress={applyCustom} disabled={exporting} accessibilityRole="button" testID="sales-custom-apply">
            <Text style={styles.btnText}>Apply</Text>
          </Pressable>
        </View>
      )}

      {!range && <Text style={styles.muted}>Choose a start and end date.</Text>}

      {range && q.isLoading && (
        <View style={styles.center} testID="sales-invoices-loading">
          <ActivityIndicator size="small" color={colors.tint} />
        </View>
      )}

      {range && q.isError && pages.length === 0 && (
        <View style={styles.center} testID="sales-invoices-error">
          <Text style={styles.muted}>Couldn't load invoices.</Text>
          <Pressable style={styles.btn} onPress={() => q.refetch()} accessibilityRole="button">
            <Text style={styles.btnText}>Retry</Text>
          </Pressable>
        </View>
      )}

      {range && q.isError && pages.length > 0 && !nextFailed && (
        <View style={styles.center} testID="sales-invoices-refresh-error">
          <Text style={styles.muted}>Couldn't refresh invoices. Showing previously loaded results.</Text>
          <Pressable style={styles.btn} onPress={() => q.refetch()} accessibilityRole="button">
            <Text style={styles.btnText}>Retry</Text>
          </Pressable>
        </View>
      )}

      {first && (
        <Text style={styles.caption} testID="sales-invoices-caption">
          {`Showing ${rows.length} of ${first.total} invoice${first.total === 1 ? "" : "s"} · Billed total ${formatMoney(first.billedTotal)}`}
        </Text>
      )}

      {first && rows.length === 0 && (
        <Text style={styles.muted} testID="sales-invoices-empty">No invoiced sales in this range.</Text>
      )}

      {rows.map((r) => (
        <Pressable
          key={r.id}
          style={styles.row}
          onPress={() => router.push({
            pathname: "/finance/invoices",
            params: { invoiceId: r.id, fromSalesReport: "1" },
          } as never)}
          accessibilityRole="button"
          accessibilityLabel={`Open invoice ${r.invoiceNumber}`}
          testID="sales-invoice-row"
        >
          <View style={styles.main}>
            <Text style={styles.name} numberOfLines={1}>{r.invoiceNumber}</Text>
            <Text style={styles.meta} numberOfLines={1}>
              {[new Date(r.issuedAt).toLocaleDateString(), r.practiceName, r.doctorName, r.status].filter(Boolean).join(" · ")}
            </Text>
          </View>
          <Text style={styles.amount}>{formatMoney(r.total)}</Text>
        </Pressable>
      ))}

      {nextFailed && (
        <View style={styles.center} testID="sales-invoices-next-error">
          <Text style={styles.muted}>Couldn't load more invoices. Loaded rows are kept.</Text>
          <Pressable style={styles.btn} onPress={() => q.fetchNextPage()} accessibilityRole="button">
            <Text style={styles.btnText}>Retry</Text>
          </Pressable>
        </View>
      )}

      {q.hasNextPage && !nextFailed && (
        <Pressable
          style={styles.btn}
          onPress={() => { if (!q.isFetching) void q.fetchNextPage(); }}
          disabled={q.isFetchingNextPage}
          accessibilityRole="button"
          testID="sales-invoices-load-more"
        >
          <Text style={styles.btnText}>{q.isFetchingNextPage ? "Loading…" : "Load more"}</Text>
        </Pressable>
      )}
    </Card>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    card: { padding: Spacing.md, marginBottom: Spacing.md, gap: Spacing.sm },
    header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: Spacing.sm },
    title: { ...Typography.bodySemibold, color: c.text, flex: 1 },
    exportBtn: { flexDirection: "row", alignItems: "center", gap: Spacing.xs, paddingHorizontal: Spacing.md, paddingVertical: 8, borderRadius: Radius.sm, backgroundColor: c.tint + "1A" },
    exportBtnDisabled: { opacity: 0.6 },
    presets: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.xs },
    chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: Radius.full, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
    chipActive: { backgroundColor: c.tint, borderColor: c.tint },
    chipText: { ...Typography.caption, color: c.textSecondary },
    chipTextActive: { ...Typography.caption, color: "#fff" },
    custom: { gap: Spacing.sm },
    error: { ...Typography.caption, color: "#DC2626" },
    muted: { ...Typography.caption, color: c.textTertiary, textAlign: "center" },
    center: { alignItems: "center", gap: Spacing.sm, paddingVertical: Spacing.md },
    caption: { ...Typography.caption, color: c.textSecondary },
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
    main: { flex: 1, gap: 2 },
    name: { ...Typography.bodySemibold, color: c.text },
    meta: { ...Typography.caption, color: c.textSecondary },
    amount: { ...Typography.bodySemibold, color: c.text },
    btn: { alignSelf: "center", paddingHorizontal: Spacing.lg, paddingVertical: 8, borderRadius: Radius.sm, backgroundColor: c.tint + "1A" },
    btnText: { ...Typography.captionMedium, color: c.tint },
  });
}
