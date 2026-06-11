import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Modal,
  RefreshControl,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useCase, useInvoices, useInvoice, useCaseAttachments } from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { StatusBadge, type BadgeVariant } from "@/components/ui/StatusBadge";
import { AuthedImage } from "@/components/ui/AuthedImage";
import { ReadOnlyToothChart } from "@/components/ReadOnlyToothChart";
import { deriveRxSummary, buildHighlightedToothSet, formatRxTeethLabel } from "@/lib/rx-summary";

// ─── Viewer-local detail shape ────────────────────────────────────────────────
// GET /api/cases/:id returns the full desktop DetailedCase payload. The
// generated `CanonicalCase` type loosely types `notes` as a string and uses
// `activityLog`, but the real payload carries structured `notes[]`, `events[]`,
// and the free-text Rx under `caseNotes`. We model exactly what we render here
// (read-only) and cast the hook result rather than editing generated code.
interface DetailNote {
  id: string;
  noteText?: string | null;
  visibility?: string | null;
  authorName?: string | null;
  createdAt?: string | null;
}
interface DetailEvent {
  id: string;
  eventType?: string | null;
  actorInitials?: string | null;
  actorName?: string | null;
  metadataJson?: unknown;
  occurredAt?: string | null;
  createdAt?: string | null;
}
interface DetailRestoration {
  id?: string | null;
  toothNumber?: string | null;
  restorationType?: string | null;
  restorationSubtype?: string | null;
  material?: string | null;
  shade?: string | null;
  notes?: string | null;
  quantity?: number | null;
}
interface DetailRemakeRef {
  id: string;
  caseNumber?: string | null;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  status?: string | null;
}
interface DetailedCase {
  id: string;
  caseNumber?: string | null;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  doctorName?: string | null;
  status?: string | null;
  priority?: string | null;
  dueDate?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  shade?: string | null;
  caseNotes?: string | null;
  notes?: DetailNote[] | null;
  events?: DetailEvent[] | null;
  originalCaseEvents?: DetailEvent[] | null;
  remakeChildrenEvents?: DetailEvent[] | null;
  restorations?: DetailRestoration[] | null;
  remakeOriginal?: DetailRemakeRef | null;
  remakeChildren?: DetailRemakeRef[] | null;
  remakeReason?: string | null;
}

type SectionKey = "overview" | "restorations" | "notes" | "files" | "invoice" | "history";

const SECTIONS: { key: SectionKey; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: "overview", label: "Overview", icon: "information-circle-outline" },
  { key: "restorations", label: "Restorations", icon: "construct-outline" },
  { key: "notes", label: "Notes", icon: "chatbox-ellipses-outline" },
  { key: "files", label: "Files", icon: "images-outline" },
  { key: "invoice", label: "Invoice", icon: "receipt-outline" },
  { key: "history", label: "History", icon: "time-outline" },
];

// ─── Formatting helpers ───────────────────────────────────────────────────────
function patientName(c: { patientFirstName?: string | null; patientLastName?: string | null }): string {
  const name = `${c.patientFirstName ?? ""} ${c.patientLastName ?? ""}`.trim();
  return name || "Unnamed patient";
}

function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function money(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return `$${n.toFixed(2)}`;
}

function statusVariant(status: string | null | undefined): BadgeVariant {
  const s = (status ?? "").toLowerCase();
  if (s.includes("remake")) return "remake";
  if (s.includes("complete") || s.includes("delivered") || s.includes("done")) return "complete";
  if (s.includes("ship") || s.includes("ready") || s.includes("delivery")) return "ship";
  if (s.includes("hold") || s.includes("cancel") || s.includes("void")) return "draft";
  if (s.includes("intake") || s.includes("new") || s.includes("received") || s.includes("pending"))
    return "intake";
  return "progress";
}

function invoiceVariant(status: string | null | undefined): BadgeVariant {
  const s = (status ?? "").toLowerCase();
  if (s.includes("paid")) return "paid";
  if (s.includes("overdue")) return "overdue";
  if (s.includes("void") || s.includes("cancel")) return "void";
  if (s.includes("draft")) return "draft";
  return "open";
}

function isImageAttachment(fileType?: string | null, fileName?: string | null): boolean {
  if (fileType && fileType.toLowerCase().startsWith("image")) return true;
  if (fileName && /\.(jpe?g|png|heic|heif|gif|webp)$/i.test(fileName)) return true;
  return false;
}

// Best-effort one-line description from a history event's metadata blob.
function eventDescription(ev: DetailEvent): string | null {
  let meta: Record<string, unknown> | null = null;
  if (ev.metadataJson && typeof ev.metadataJson === "object") {
    meta = ev.metadataJson as Record<string, unknown>;
  } else if (typeof ev.metadataJson === "string" && ev.metadataJson.trim()) {
    try {
      const parsed = JSON.parse(ev.metadataJson);
      if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
    } catch {
      return ev.metadataJson;
    }
  }
  if (!meta) return null;
  const from = meta.fromStatus ?? meta.from ?? meta.previousStatus;
  const to = meta.toStatus ?? meta.to ?? meta.newStatus ?? meta.status;
  if (typeof to === "string" && to) {
    return typeof from === "string" && from
      ? `${titleCase(from)} → ${titleCase(to)}`
      : titleCase(to);
  }
  if (typeof meta.note === "string" && meta.note) return meta.note;
  if (typeof meta.message === "string" && meta.message) return meta.message;
  return null;
}

export default function CaseDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [active, setActive] = useState<SectionKey>("overview");
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const caseQuery = useCase(id);
  const c = (caseQuery.data ?? null) as unknown as DetailedCase | null;

  const attachmentsQuery = useCaseAttachments(id);
  const attachments = attachmentsQuery.data ?? [];

  const invoicesQuery = useInvoices({ caseId: id });
  const invoiceList = invoicesQuery.data ?? [];
  const primaryInvoiceId = invoiceList.length > 0 ? invoiceList[0].id : null;
  const invoiceQuery = useInvoice(primaryInvoiceId);
  const invoice = invoiceQuery.data ?? invoiceList[0] ?? null;

  const rxSummary = useMemo(
    () =>
      deriveRxSummary(
        (c?.restorations ?? []).map((r) => ({
          restorationType: r.restorationType ?? null,
          material: r.material ?? null,
          toothNumber: r.toothNumber ?? null,
        })),
      ),
    [c?.restorations],
  );
  const highlightedTeeth = useMemo(() => buildHighlightedToothSet(rxSummary), [rxSummary]);

  const history = useMemo(() => {
    const merged: DetailEvent[] = [
      ...(c?.events ?? []),
      ...(c?.originalCaseEvents ?? []),
      ...(c?.remakeChildrenEvents ?? []),
    ];
    const seen = new Set<string>();
    const deduped = merged.filter((ev) => {
      if (!ev?.id || seen.has(ev.id)) return false;
      seen.add(ev.id);
      return true;
    });
    deduped.sort((a, b) => {
      const ta = new Date(a.occurredAt ?? a.createdAt ?? 0).getTime();
      const tb = new Date(b.occurredAt ?? b.createdAt ?? 0).getTime();
      return tb - ta;
    });
    return deduped;
  }, [c?.events, c?.originalCaseEvents, c?.remakeChildrenEvents]);

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)" as never);
  }

  function onRefresh() {
    caseQuery.refetch();
    attachmentsQuery.refetch();
    invoicesQuery.refetch();
    invoiceQuery.refetch();
  }

  const refreshing =
    caseQuery.isFetching || invoicesQuery.isFetching || attachmentsQuery.isFetching;

  // ── Loading / error / not-found states ──
  if (caseQuery.isLoading) {
    return (
      <View style={[styles.screen, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.tint} />
      </View>
    );
  }

  if (caseQuery.isError || !c) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <Header title="Case" onBack={goBack} styles={styles} colors={colors} />
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>Unable to load this case</Text>
          <Text style={styles.emptyBody}>
            It may have been moved, or your session needs a refresh.
          </Text>
          <Pressable style={styles.retryBtn} onPress={() => caseQuery.refetch()}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <Header
        title={c.caseNumber ? `#${c.caseNumber}` : "Case"}
        subtitle={patientName(c)}
        onBack={goBack}
        styles={styles}
        colors={colors}
        right={<StatusBadge label={titleCase(c.status ?? "—")} variant={statusVariant(c.status)} />}
      />

      {/* Section switcher */}
      <View style={styles.tabsWrap}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabsRow}
        >
          {SECTIONS.map((s) => {
            const on = s.key === active;
            return (
              <Pressable
                key={s.key}
                onPress={() => setActive(s.key)}
                style={[styles.tab, on && styles.tabActive]}
                testID={`section-tab-${s.key}`}
              >
                <Ionicons
                  name={s.icon}
                  size={15}
                  color={on ? colors.textInverse : colors.textSecondary}
                />
                <Text style={[styles.tabLabel, on && styles.tabLabelActive]}>{s.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.tint} />
        }
      >
        {active === "overview" && <OverviewSection c={c} styles={styles} />}

        {active === "restorations" && (
          <RestorationsSection
            restorations={c.restorations ?? []}
            highlighted={highlightedTeeth}
            teethLabel={formatRxTeethLabel(rxSummary)}
            styles={styles}
            colors={colors}
          />
        )}

        {active === "notes" && (
          <NotesSection caseNotes={c.caseNotes} notes={c.notes ?? []} styles={styles} colors={colors} />
        )}

        {active === "files" && (
          <FilesSection
            caseId={c.id}
            attachments={attachments}
            loading={attachmentsQuery.isLoading}
            onOpenImage={setLightboxUrl}
            styles={styles}
            colors={colors}
          />
        )}

        {active === "invoice" && (
          <InvoiceSection
            invoice={invoice}
            loading={invoicesQuery.isLoading || invoiceQuery.isLoading}
            styles={styles}
            colors={colors}
          />
        )}

        {active === "history" && <HistorySection events={history} styles={styles} colors={colors} />}
      </ScrollView>

      {/* Full-screen image viewer */}
      <Modal visible={!!lightboxUrl} transparent animationType="fade" onRequestClose={() => setLightboxUrl(null)}>
        <Pressable style={styles.lightbox} onPress={() => setLightboxUrl(null)}>
          {lightboxUrl ? (
            <AuthedImage url={lightboxUrl} style={styles.lightboxImage} contentFit="contain" />
          ) : null}
          <View style={[styles.lightboxClose, { top: insets.top + Spacing.md }]}>
            <Ionicons name="close" size={26} color="#FFFFFF" />
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────
function Header({
  title,
  subtitle,
  onBack,
  right,
  styles,
  colors,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  right?: React.ReactNode;
  styles: Styles;
  colors: ThemeColors;
}) {
  return (
    <View style={styles.header}>
      <Pressable onPress={onBack} hitSlop={10} style={styles.backBtn} testID="case-back">
        <Ionicons name="chevron-back" size={24} color={colors.text} />
      </Pressable>
      <View style={styles.headerTitles}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ? <View style={styles.headerRight}>{right}</View> : null}
    </View>
  );
}

// ─── Sections ─────────────────────────────────────────────────────────────────
function FieldRow({ label, value, styles }: { label: string; value: string; styles: Styles }) {
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{value}</Text>
    </View>
  );
}

function OverviewSection({ c, styles }: { c: DetailedCase; styles: Styles }) {
  return (
    <View style={styles.sectionGap}>
      <Card>
        <FieldRow label="Patient" value={patientName(c)} styles={styles} />
        <FieldRow label="Doctor" value={c.doctorName || "—"} styles={styles} />
        <FieldRow label="Case #" value={c.caseNumber || "—"} styles={styles} />
        <FieldRow label="Status" value={titleCase(c.status ?? "—")} styles={styles} />
        <FieldRow label="Priority" value={c.priority ? titleCase(c.priority) : "Standard"} styles={styles} />
        <FieldRow label="Due" value={formatDate(c.dueDate)} styles={styles} />
        <FieldRow label="Created" value={formatDate(c.createdAt)} styles={styles} />
      </Card>

      {c.remakeOriginal || (c.remakeChildren && c.remakeChildren.length > 0) ? (
        <Card>
          <Text style={styles.cardHeading}>Remake</Text>
          {c.remakeOriginal ? (
            <FieldRow label="Original" value={`#${c.remakeOriginal.caseNumber ?? "—"}`} styles={styles} />
          ) : null}
          {c.remakeChildren && c.remakeChildren.length > 0 ? (
            <FieldRow
              label="Remakes"
              value={c.remakeChildren.map((r) => `#${r.caseNumber ?? "—"}`).join(", ")}
              styles={styles}
            />
          ) : null}
          {c.remakeReason ? <FieldRow label="Reason" value={c.remakeReason} styles={styles} /> : null}
        </Card>
      ) : null}

      {c.caseNotes && c.caseNotes.trim() ? (
        <Card>
          <Text style={styles.cardHeading}>Rx instructions</Text>
          <Text style={styles.bodyText}>{c.caseNotes.trim()}</Text>
        </Card>
      ) : null}
    </View>
  );
}

function RestorationsSection({
  restorations,
  highlighted,
  teethLabel,
  styles,
  colors,
}: {
  restorations: DetailRestoration[];
  highlighted: Set<string>;
  teethLabel: string;
  styles: Styles;
  colors: ThemeColors;
}) {
  if (restorations.length === 0) {
    return <EmptyState icon="construct-outline" text="No restorations on this case." styles={styles} colors={colors} />;
  }
  return (
    <View style={styles.sectionGap}>
      <Card>
        <Text style={styles.cardHeading}>Teeth</Text>
        <Text style={styles.teethLabel}>{teethLabel}</Text>
        <View style={styles.toothChartWrap}>
          <ReadOnlyToothChart highlighted={highlighted} />
        </View>
      </Card>

      {restorations.map((r, i) => (
        <Card key={r.id ?? `rest-${i}`}>
          <View style={styles.restHeaderRow}>
            <Text style={styles.cardHeading}>
              {r.restorationType ? titleCase(r.restorationType) : "Restoration"}
            </Text>
            {r.toothNumber ? (
              <View style={styles.toothPill}>
                <Text style={styles.toothPillText}>#{r.toothNumber}</Text>
              </View>
            ) : null}
          </View>
          {r.restorationSubtype ? (
            <FieldRow label="Subtype" value={titleCase(r.restorationSubtype)} styles={styles} />
          ) : null}
          {r.material ? <FieldRow label="Material" value={r.material} styles={styles} /> : null}
          {r.shade ? <FieldRow label="Shade" value={r.shade} styles={styles} /> : null}
          {typeof r.quantity === "number" ? (
            <FieldRow label="Quantity" value={String(r.quantity)} styles={styles} />
          ) : null}
          {r.notes && r.notes.trim() ? (
            <Text style={[styles.bodyText, { marginTop: Spacing.sm }]}>{r.notes.trim()}</Text>
          ) : null}
        </Card>
      ))}
    </View>
  );
}

function NotesSection({
  caseNotes,
  notes,
  styles,
  colors,
}: {
  caseNotes?: string | null;
  notes: DetailNote[];
  styles: Styles;
  colors: ThemeColors;
}) {
  const hasRx = !!(caseNotes && caseNotes.trim());
  if (!hasRx && notes.length === 0) {
    return <EmptyState icon="chatbox-ellipses-outline" text="No notes on this case." styles={styles} colors={colors} />;
  }
  return (
    <View style={styles.sectionGap}>
      {hasRx ? (
        <Card>
          <Text style={styles.cardHeading}>Rx instructions</Text>
          <Text style={styles.bodyText}>{caseNotes!.trim()}</Text>
        </Card>
      ) : null}
      {notes.map((n) => (
        <Card key={n.id}>
          <View style={styles.noteMetaRow}>
            <Text style={styles.noteAuthor}>{n.authorName || "Unknown"}</Text>
            <Text style={styles.noteDate}>{formatDateTime(n.createdAt)}</Text>
          </View>
          <Text style={styles.bodyText}>{n.noteText?.trim() || "—"}</Text>
          {n.visibility && n.visibility.toLowerCase() !== "all" ? (
            <Text style={styles.noteVisibility}>{titleCase(n.visibility)} only</Text>
          ) : null}
        </Card>
      ))}
    </View>
  );
}

function FilesSection({
  caseId,
  attachments,
  loading,
  onOpenImage,
  styles,
  colors,
}: {
  caseId: string;
  attachments: { id: string; fileName?: string | null; fileType?: string | null; uploaderName?: string | null; createdAt?: string | null }[];
  loading: boolean;
  onOpenImage: (url: string) => void;
  styles: Styles;
  colors: ThemeColors;
}) {
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.tint} />
      </View>
    );
  }
  if (attachments.length === 0) {
    return <EmptyState icon="images-outline" text="No files on this case." styles={styles} colors={colors} />;
  }

  const images = attachments.filter((a) => isImageAttachment(a.fileType, a.fileName));
  const docs = attachments.filter((a) => !isImageAttachment(a.fileType, a.fileName));

  return (
    <View style={styles.sectionGap}>
      {images.length > 0 ? (
        <View style={styles.imageGrid}>
          {images.map((a) => {
            const url = `/api/cases/${caseId}/attachments/${a.id}/file`;
            return (
              <Pressable key={a.id} style={styles.thumb} onPress={() => onOpenImage(url)}>
                <AuthedImage url={url} style={styles.thumbImage} contentFit="cover" />
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {docs.map((a) => (
        <Card key={a.id}>
          <View style={styles.docRow}>
            <Ionicons name="document-text-outline" size={22} color={colors.tint} />
            <View style={styles.docInfo}>
              <Text style={styles.docName} numberOfLines={1}>
                {a.fileName || "File"}
              </Text>
              <Text style={styles.docMeta}>
                {a.uploaderName ? `${a.uploaderName} · ` : ""}
                {formatDate(a.createdAt)}
              </Text>
            </View>
          </View>
        </Card>
      ))}
    </View>
  );
}

function InvoiceSection({
  invoice,
  loading,
  styles,
  colors,
}: {
  invoice:
    | {
        invoiceNumber?: string;
        status?: string;
        total?: string | number | null;
        balanceDue?: string | number | null;
        issuedAt?: string | null;
        dueAt?: string | null;
        items?: { id: string; description?: string | null; quantity?: number | null; unitPrice?: string | number | null; lineTotal?: string | number | null; toothNumbers?: string | null }[];
        lineItems?: { id: string; description?: string | null; quantity?: number | null; unitPrice?: string | number | null; lineTotal?: string | number | null; toothNumbers?: string | null }[];
      }
    | null;
  loading: boolean;
  styles: Styles;
  colors: ThemeColors;
}) {
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.tint} />
      </View>
    );
  }
  if (!invoice) {
    return <EmptyState icon="receipt-outline" text="No invoice for this case." styles={styles} colors={colors} />;
  }

  const lines = invoice.items ?? invoice.lineItems ?? [];

  return (
    <View style={styles.sectionGap}>
      <Card>
        <View style={styles.restHeaderRow}>
          <Text style={styles.cardHeading}>
            {invoice.invoiceNumber ? `Invoice #${invoice.invoiceNumber}` : "Invoice"}
          </Text>
          {invoice.status ? (
            <StatusBadge label={titleCase(invoice.status)} variant={invoiceVariant(invoice.status)} />
          ) : null}
        </View>
        <FieldRow label="Issued" value={formatDate(invoice.issuedAt)} styles={styles} />
        <FieldRow label="Due" value={formatDate(invoice.dueAt)} styles={styles} />
        <FieldRow label="Total" value={money(invoice.total)} styles={styles} />
        <FieldRow label="Balance" value={money(invoice.balanceDue)} styles={styles} />
      </Card>

      {lines.length > 0 ? (
        <Card>
          <Text style={styles.cardHeading}>Line items</Text>
          {lines.map((li) => (
            <View key={li.id} style={styles.lineItem}>
              <View style={styles.lineItemMain}>
                <Text style={styles.lineDesc} numberOfLines={2}>
                  {li.description || "Item"}
                  {li.toothNumbers ? `  ·  #${li.toothNumbers}` : ""}
                </Text>
                <Text style={styles.lineSub}>
                  {(li.quantity ?? 1)} × {money(li.unitPrice)}
                </Text>
              </View>
              <Text style={styles.lineTotal}>{money(li.lineTotal)}</Text>
            </View>
          ))}
        </Card>
      ) : null}
    </View>
  );
}

function HistorySection({
  events,
  styles,
  colors,
}: {
  events: DetailEvent[];
  styles: Styles;
  colors: ThemeColors;
}) {
  if (events.length === 0) {
    return <EmptyState icon="time-outline" text="No history yet." styles={styles} colors={colors} />;
  }
  return (
    <Card padding="none">
      {events.map((ev, i) => {
        const desc = eventDescription(ev);
        const actor = ev.actorName || ev.actorInitials;
        return (
          <View key={ev.id} style={[styles.eventRow, i > 0 && styles.eventDivider]}>
            <View style={styles.eventDot} />
            <View style={styles.eventBody}>
              <Text style={styles.eventTitle}>{titleCase(ev.eventType ?? "Event")}</Text>
              {desc ? <Text style={styles.eventDesc}>{desc}</Text> : null}
              <Text style={styles.eventMeta}>
                {actor ? `${actor} · ` : ""}
                {formatDateTime(ev.occurredAt ?? ev.createdAt)}
              </Text>
            </View>
          </View>
        );
      })}
    </Card>
  );
}

function EmptyState({
  icon,
  text,
  styles,
  colors,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  text: string;
  styles: Styles;
  colors: ThemeColors;
}) {
  return (
    <View style={styles.emptyState}>
      <Ionicons name={icon} size={36} color={colors.textTertiary} />
      <Text style={styles.emptyBody}>{text}</Text>
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: Spacing.xl, gap: Spacing.md },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      gap: Spacing.sm,
    },
    backBtn: { padding: Spacing.xs },
    headerTitles: { flex: 1 },
    headerTitle: { ...Typography.h2, color: c.text },
    headerSubtitle: { ...Typography.caption, color: c.textSecondary },
    headerRight: { marginLeft: Spacing.sm },
    tabsWrap: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    tabsRow: { paddingHorizontal: Spacing.md, paddingBottom: Spacing.sm, gap: Spacing.sm },
    tab: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.full,
      backgroundColor: c.surfaceAlt,
    },
    tabActive: { backgroundColor: c.tint },
    tabLabel: { ...Typography.captionMedium, color: c.textSecondary },
    tabLabelActive: { color: c.textInverse },
    body: { padding: Spacing.lg, paddingBottom: Spacing.huge, gap: Spacing.md },
    sectionGap: { gap: Spacing.md },
    cardHeading: { ...Typography.h3, color: c.text, marginBottom: Spacing.sm },
    bodyText: { ...Typography.body, color: c.text },
    fieldRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-start",
      paddingVertical: Spacing.xs + 2,
      gap: Spacing.md,
    },
    fieldLabel: { ...Typography.bodyMedium, color: c.textSecondary },
    fieldValue: { ...Typography.bodyMedium, color: c.text, flexShrink: 1, textAlign: "right" },
    teethLabel: { ...Typography.bodyMedium, color: c.tint, marginBottom: Spacing.md },
    toothChartWrap: { alignItems: "center" },
    restHeaderRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: Spacing.xs,
    },
    toothPill: {
      backgroundColor: c.tintLight,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 2,
      borderRadius: Radius.xs,
    },
    toothPillText: { ...Typography.captionSemibold, color: c.tint },
    noteMetaRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: Spacing.xs },
    noteAuthor: { ...Typography.bodySemibold, color: c.text },
    noteDate: { ...Typography.caption, color: c.textTertiary },
    noteVisibility: { ...Typography.caption, color: c.warning, marginTop: Spacing.xs },
    imageGrid: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
    thumb: {
      width: "31%",
      aspectRatio: 1,
      borderRadius: Radius.md,
      overflow: "hidden",
      backgroundColor: c.surfaceAlt,
    },
    thumbImage: { width: "100%", height: "100%" },
    docRow: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    docInfo: { flex: 1 },
    docName: { ...Typography.bodyMedium, color: c.text },
    docMeta: { ...Typography.caption, color: c.textTertiary, marginTop: 2 },
    lineItem: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: Spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      gap: Spacing.md,
    },
    lineItemMain: { flex: 1 },
    lineDesc: { ...Typography.bodyMedium, color: c.text },
    lineSub: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    lineTotal: { ...Typography.bodySemibold, color: c.text },
    eventRow: { flexDirection: "row", gap: Spacing.md, padding: Spacing.lg },
    eventDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
    eventDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.tint, marginTop: 6 },
    eventBody: { flex: 1 },
    eventTitle: { ...Typography.bodySemibold, color: c.text },
    eventDesc: { ...Typography.body, color: c.textSecondary, marginTop: 2 },
    eventMeta: { ...Typography.caption, color: c.textTertiary, marginTop: 4 },
    emptyState: { alignItems: "center", justifyContent: "center", paddingVertical: Spacing.huge, gap: Spacing.md },
    emptyTitle: { ...Typography.h3, color: c.text },
    emptyBody: { ...Typography.body, color: c.textSecondary, textAlign: "center" },
    retryBtn: {
      marginTop: Spacing.sm,
      paddingHorizontal: Spacing.xl,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.full,
      backgroundColor: c.tint,
    },
    retryText: { ...Typography.bodySemibold, color: c.textInverse },
    lightbox: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)", alignItems: "center", justifyContent: "center" },
    lightboxImage: { width: "100%", height: "80%" },
    lightboxClose: { position: "absolute", right: Spacing.lg },
  });
}
