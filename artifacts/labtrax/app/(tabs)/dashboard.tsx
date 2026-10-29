import React, { useEffect, useMemo, useRef, useState } from "react";
import { useProfilePhoto } from "@/lib/use-profile-photo";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Modal,
  RefreshControl,
  LayoutAnimation,
  Platform,
  UIManager,
  Image,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  DASHBOARD_PREFS_KEY,
  DEFAULT_DASHBOARD_PREFS,
  loadDashboardPrefs,
  type DashboardPrefs,
} from "@/lib/dashboard-preferences";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import {
  DUE_TOMORROW_SORT_LABELS,
  sortDueTomorrowCases as sortSharedDueTomorrowCases,
  useCases,
  useRecentCases,
  useListLabInboxFiles,
  getListLabInboxFilesQueryKey,
  type CanonicalCase,
  type DueTomorrowSort,
} from "@workspace/api-client-react";
import { DASHBOARD_SECTION_LABELS } from "@workspace/dashboard-labels";

export { DUE_TOMORROW_SORT_LABELS };
export type { DueTomorrowSort };
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { StatusBadge, type BadgeVariant } from "@/components/ui/StatusBadge";
import { CaseQuickActionSheet } from "@/components/CaseQuickActionSheet";
import { CaseLookupSheet } from "@/components/CaseLookupSheet";
import { useAuth } from "@/lib/auth-context";
import {
  useMe,
  activeMemberships,
  canAdminAnyLab,
  primaryAdminLabOrgId,
  primaryLabOrgId,
} from "@/lib/auth-me";
import { requestRxIntake } from "@/lib/rx-intake-events";
import { useQuery } from "@tanstack/react-query";
import { resilientFetch } from "@/lib/query-client";
import { JoinLabCard } from "@/components/JoinLabCard";
import {
  formatRelativeCreated,
  formatRelativeDue,
  formatCompletedAt,
  getDueDayDiff,
  parseDueTimeMinutes,
  isDueTimePast,
} from "@/lib/format";
import { getCompactWorkDetails } from "@/lib/case-category";
import { TypeBadge } from "@/components/ui/TypeBadge";
import { TODAY_SALES_ROUTE } from "@/lib/sales-range";
import { useDayChange } from "@/hooks/useDayChange";
import { UnassignedDocumentsCard } from "@/components/UnassignedDocumentsCard";
import {
  EXCEPTION_QUEUE_QUERY_KEY,
  exceptionPatientLabel,
  fetchActiveExceptions,
  type CaseExceptionQueueItem,
} from "@/lib/case-exceptions";
import { caseLocationLabel } from "@/lib/case-location-label";
import { useLongPressGuard } from "@/lib/use-long-press-guard";
import { isActiveCaseRecord } from "@/lib/case-quick-actions";

if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const DUE_TOMORROW_CAP = 8;
const DUE_TODAY_CAP = 6;

type IconName = React.ComponentProps<typeof Ionicons>["name"];

function patientName(c: CanonicalCase): string {
  const name = `${c.patientFirstName ?? ""} ${c.patientLastName ?? ""}`.trim();
  return name || "Unnamed patient";
}

function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

function getGreeting(firstName?: string): string {
  const hour = new Date().getHours();
  const period = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const name = firstName?.trim();
  return name ? `Good ${period}, ${name}` : "Welcome";
}

function isClosedCase(status: string | null | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return (
    s.includes("complete") ||
    s.includes("delivered") ||
    s.includes("done") ||
    s.includes("cancel") ||
    s.includes("void")
  );
}

// Only `dueDate` has a paired `dueTime` — `expectedDeliveryDate` (doctor's
// requested delivery date) has no time-of-day companion field. So the time
// only applies to the day-diff comparison when the expectedDeliveryDate ??
// dueDate fallback specifically resolved to dueDate.
function pairedDueTime(c: CanonicalCase): string | null | undefined {
  return c.expectedDeliveryDate ? null : c.dueTime;
}

/**
 * Raw (status-agnostic) "is this case past its effective due point" check,
 * shared by the exported caseIsOverdue predicate AND renderCaseRow's inline
 * overdue-color calculation (which intentionally does not gate on closed
 * status, so a closed case with a past due date still renders in red in the
 * "Recent" section — preserved here rather than folded into caseIsOverdue).
 *
 * A whole past day is always overdue regardless of time. A day diff of 0
 * (due today) is overdue only once its paired due time (if any) has passed;
 * a date-only case due today is never overdue by this rule, matching prior
 * date-level behaviour.
 */
function isPastDueRaw(c: CanonicalCase): boolean {
  const diff = getDueDayDiff(c.expectedDeliveryDate ?? c.dueDate);
  if (diff == null) return false;
  if (diff < 0) return true;
  if (diff === 0) return isDueTimePast(pairedDueTime(c));
  return false;
}

/** Mirror of isPastDueRaw for the "due today" bucket — see its docstring. */
function isDueTodayRaw(c: CanonicalCase): boolean {
  const diff = getDueDayDiff(c.expectedDeliveryDate ?? c.dueDate);
  if (diff !== 0) return false;
  return !isDueTimePast(pairedDueTime(c));
}

/**
 * Returns the number of calendar days from today to the next Monday–Friday
 * business day. Saturdays and Sundays are skipped — no holidays.
 *   Mon–Thu → 1   Fri → 3 (skip Sat+Sun to Mon)   Sat → 2 (skip Sun)   Sun → 1
 */
function nextBizDayOffset(): number {
  const dow = new Date().getDay(); // 0=Sun … 5=Fri … 6=Sat
  if (dow === 5) return 3;
  if (dow === 6) return 2;
  return 1;
}

// Untimed cases sort after timed ones on the same day — a defensible "end of
// day" convention. Because every untimed case shares this same sentinel, and
// Array#sort is stable, date-only cases keep exactly their prior relative
// order against each other; only their position against newly-time-aware
// cases on the same day changes.
const UNTIMED_MINUTES_SENTINEL = 24 * 60;

/**
 * Combined sort key for the past-due/due-today lists: whole days dominate
 * (via the *1440 multiplier), with minutes-of-day breaking ties within the
 * same day when a due time is present. `diffFallback` mirrors the previous
 * per-bucket fallback for the (practically unreachable, since callers filter
 * by the matching predicate first) case where no date is present at all.
 * Exported so regression tests can call the real production logic directly.
 */
export function dueSortKey(c: CanonicalCase, diffFallback: number): number {
  const diff =
    getDueDayDiff(c.expectedDeliveryDate ?? c.dueDate) ?? diffFallback;
  const minutesOfDay =
    parseDueTimeMinutes(pairedDueTime(c)) ?? UNTIMED_MINUTES_SENTINEL;
  return diff * 1440 + minutesOfDay;
}

/**
 * Predicate used by the pastDueCases memo. Uses the mobile dashboard's
 * existing effective-date precedence and paired due-time behavior.
 * Exported so regression tests can call the real production logic directly.
 */
export function caseIsOverdue(
  c: CanonicalCase,
): boolean {
  return !isClosedCase(c.status) && isPastDueRaw(c);
}

/**
 * Predicate used by the dueTodayCases memo.
 * Exported so regression tests can call the real production logic directly.
 *
 * Mirrors desktop caseIsDueTodayFn: prefers expectedDeliveryDate and falls back
 * to dueDate. A case is due today when the day diff is exactly 0, its paired
 * due time (if any) has not yet passed, and the case is not closed.
 */
export function caseIsDueToday(c: CanonicalCase): boolean {
  if (isClosedCase(c.status)) return false;
  return isDueTodayRaw(c);
}

/**
 * Predicate used by the dueTomorrowCases memo.
 * Exported so regression tests can call the real production logic directly.
 *
 * "Due tomorrow" means due on the next Monday–Friday business day (Saturdays
 * and Sundays are skipped — no holidays). On a Friday the target is Monday;
 * on any Mon–Thu the target is the following calendar day.
 *
 * Uses expectedDeliveryDate as the primary field (matching desktop
 * caseIsDueTomorrowFn), falling back to dueDate only when expectedDeliveryDate
 * is absent. Completed cases are excluded.
 */
export function caseIsDueTomorrow(c: CanonicalCase): boolean {
  if (isClosedCase(c.status)) return false;
  const diff = getDueDayDiff(c.expectedDeliveryDate ?? c.dueDate);
  return diff === nextBizDayOffset();
}

function comparableDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function comparableText(value: unknown): string | null {
  const normalized =
    typeof value === "string" ? value.trim().toLocaleLowerCase() : null;
  return normalized ? normalized : null;
}

function compareNullable(
  a: string | number | null,
  b: string | number | null,
  direction: "asc" | "desc" = "asc",
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const result =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b), undefined, {
          numeric: true,
          sensitivity: "base",
        });
  return direction === "desc" ? -result : result;
}

function caseTypeIndicatorKey(
  c: Pick<
    CanonicalCase,
    "restorationTypes" | "restorationMaterials" | "firstRestorationSubtype"
  >,
): string | null {
  return comparableText(
    deriveCaseTypeIndicator(
      c.restorationTypes,
      c.restorationMaterials,
      c.firstRestorationSubtype,
    ),
  );
}

function caseSortTieBreak(a: CanonicalCase, b: CanonicalCase): number {
  return (a.id ?? "").localeCompare(b.id ?? "", undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/**
 * Shared C/D/O case-type comparison for every dashboard section that offers a
 * Case Type sort (mirrors the desktop comparator): crowns first, then
 * removables, then ortho/appliances, cases with no derivable indicator last,
 * and the deterministic id tie-break so equal rows keep a stable order as
 * fresh data arrives.
 */
export function compareCaseTypeIndicator(
  a: CanonicalCase,
  b: CanonicalCase,
): number {
  return (
    compareNullable(caseTypeIndicatorKey(a), caseTypeIndicatorKey(b)) ||
    caseSortTieBreak(a, b)
  );
}

export function sortDueTomorrowCases(
  cases: CanonicalCase[],
  sort: DueTomorrowSort,
): CanonicalCase[] {
  return sortSharedDueTomorrowCases(cases, sort, {
    getLocationLabel: (caseItem) => caseLocationLabel(caseItem),
    getTypeIndicator: (caseItem) =>
      deriveCaseTypeIndicator(
        caseItem.restorationTypes,
        caseItem.restorationMaterials,
        caseItem.firstRestorationSubtype,
      ),
  });
}

/**
 * Sort choices shared by the Past Due and Due Today sections. The list (and
 * its order) mirrors the desktop dashboard menus for the same sections; each
 * section keeps its own default selection and comparator details.
 */
export type SectionSort =
  | "due_date"
  | "entered"
  | "case_number"
  | "patient"
  | "doctor"
  | "status"
  | "priority"
  | "type";

export const SECTION_SORT_LABELS: Record<SectionSort, string> = {
  due_date: "Due date",
  entered: "Entered date",
  case_number: "Case #",
  patient: "Patient name",
  doctor: "Doctor",
  status: "Location / Status",
  priority: "Priority",
  type: "Case Type",
};

function compareCaseNumber(a: CanonicalCase, b: CanonicalCase): number {
  const na = parseInt(a.caseNumber ?? "", 10);
  const nb = parseInt(b.caseNumber ?? "", 10);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return (a.caseNumber ?? "").localeCompare(b.caseNumber ?? "");
}

function comparePatientName(a: CanonicalCase, b: CanonicalCase): number {
  const pa = `${a.patientLastName ?? ""} ${a.patientFirstName ?? ""}`
    .trim()
    .toLowerCase();
  const pb = `${b.patientLastName ?? ""} ${b.patientFirstName ?? ""}`
    .trim()
    .toLowerCase();
  return pa.localeCompare(pb);
}

function compareEnteredDate(a: CanonicalCase, b: CanonicalCase): number {
  return (a.updatedAt || a.createdAt || "").localeCompare(
    b.updatedAt || b.createdAt || "",
  );
}

function compareRushFirst(a: CanonicalCase, b: CanonicalCase): number {
  const rushA = a.priority === "rush" ? 0 : 1;
  const rushB = b.priority === "rush" ? 0 : 1;
  return rushA - rushB;
}

function compareSection(
  a: CanonicalCase,
  b: CanonicalCase,
  sort: SectionSort,
  diffFallback: number,
): number {
  switch (sort) {
    case "due_date":
      return dueSortKey(a, diffFallback) - dueSortKey(b, diffFallback);
    case "case_number":
      return compareCaseNumber(a, b);
    case "patient":
      return comparePatientName(a, b);
    case "doctor":
      return (a.doctorName ?? "")
        .toLowerCase()
        .localeCompare((b.doctorName ?? "").toLowerCase());
    case "status":
      return (a.status ?? "")
        .toLowerCase()
        .localeCompare((b.status ?? "").toLowerCase());
    case "priority":
      return (
        compareRushFirst(a, b) ||
        dueSortKey(a, diffFallback) - dueSortKey(b, diffFallback)
      );
    case "type":
      return compareCaseTypeIndicator(a, b);
    default:
      return compareEnteredDate(a, b);
  }
}

/**
 * Sort the already-filtered Past Due bucket. Defaults to the due-based order
 * the section has always opened in.
 * Exported so regression tests can call the real production logic directly.
 */
export function sortPastDueCases(
  cases: CanonicalCase[],
  sort: SectionSort,
): CanonicalCase[] {
  return [...cases].sort((a, b) => compareSection(a, b, sort, 0));
}

/**
 * Sort the already-filtered Due Today bucket.
 * Exported so regression tests can call the real production logic directly.
 */
export function sortDueTodayCases(
  cases: CanonicalCase[],
  sort: SectionSort,
): CanonicalCase[] {
  return [...cases].sort((a, b) => compareSection(a, b, sort, 9999));
}

/**
 * Bottom-sheet sort picker shared by every dashboard case section. The
 * section it belongs to is passed in (e.g. "Due tomorrow", "Past due") so the
 * heading and the accessibility labels name that section rather than
 * hard-coding one of them.
 */
export function CaseSortSheet<T extends string>({
  visible,
  sectionLabel,
  sort,
  labels,
  colors,
  onClose,
  onSelect,
}: {
  visible: boolean;
  sectionLabel: string;
  sort: T;
  labels: Record<T, string>;
  colors: ThemeColors;
  onClose: () => void;
  onSelect: (sort: T) => void;
}) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const closeLabel = `Close ${sectionLabel} sort options`;
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.sortModalBackdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={closeLabel}
        />
        <View
          style={[
            styles.sortSheet,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
          accessibilityViewIsModal
          accessibilityLabel={`${sectionLabel} sort options`}
        >
          <View style={styles.sortSheetHeading}>
            <Text style={[styles.sortSheetTitle, { color: colors.text }]}>
              {`Sort ${sectionLabel.toLowerCase()}`}
            </Text>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={closeLabel}
            >
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </Pressable>
          </View>
          {(Object.keys(labels) as T[]).map((key) => {
            const selected = sort === key;
            return (
              <Pressable
                key={key}
                style={[
                  styles.sortOption,
                  selected && { backgroundColor: colors.tint + "12" },
                ]}
                onPress={() => onSelect(key)}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={`Sort by ${labels[key]}`}
              >
                <Text style={[styles.sortOptionText, { color: colors.text }]}>
                  {labels[key]}
                </Text>
                {selected ? (
                  <Ionicons name="checkmark" size={18} color={colors.tint} />
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </View>
    </Modal>
  );
}

function caseStatusVariant(status: string | null | undefined): BadgeVariant {
  const s = (status ?? "").toLowerCase();
  if (s.includes("remake")) return "remake";
  if (s.includes("complete") || s.includes("delivered") || s.includes("done"))
    return "complete";
  if (s.includes("ship") || s.includes("ready") || s.includes("delivery"))
    return "ship";
  if (s.includes("hold") || s.includes("cancel") || s.includes("void"))
    return "draft";
  if (
    s.includes("intake") ||
    s.includes("new") ||
    s.includes("received") ||
    s.includes("pending")
  )
    return "intake";
  return "progress";
}

const _IMPLANT_RE =
  /\bimplant|\babutment|screw[- ]?retained|all[- ]?on[- ]?(4|6|x)/i;
const _CROWN_BRIDGE_RE =
  /\bcrown|\bbridge|\bveneer|\binlay|\bonlay|\bmaryland|\bpontic|\bcoping/i;
const _REMOVABLE_RE = /\bdenture|\bpartial|\bflipper|\bflexible|\bvalplast/i;
const _ZIRCONIA_RE = /\bzirconia|\bbruxzir|\bbrux\b|\bzirc\b|\b(pfz)\b/i;

/**
 * Ortho / appliance free-text signals. Mirrors the desktop classifier
 * (`case-date-filter.ts`) and, like it, deliberately excludes the ambiguous
 * "essix" (removable with teeth vs ortho without) — those cases classify from
 * their structured subtype instead.
 */
const _ORTHO_RE =
  /night\s*guard|nightguard|occlusal\s*guard|bite\s*guard|sports?\s*guard|snore\s*guard|mouth\s*guard|mouthguard|\bretainer|\bsplint|bleach\s*tray|\bhawley|space\s*maintainer|\bortho|\bappliance/i;
/**
 * Sort-only case-type indicator ("C" restorative / "D" removable / "O" ortho).
 * The rendered badge comes from `getCompactWorkDetails`; this mirrors the same
 * ortho branch so the Case Type sort can never disagree with the letter shown
 * on the row.
 */
export function deriveCaseTypeIndicator(
  restorationTypes?: string | null,
  restorationMaterials?: string | null,
  restorationSubtype?: string | null,
): "C" | "D" | "O" | null {
  // Prefer the encoded taxonomy subtype when available — it is authoritative.
  if (restorationSubtype) {
    const topSegment = restorationSubtype.split("/")[0];
    if (topSegment === "removable") return "D";
    if (topSegment === "restorative") return "C";
    if (topSegment === "ortho") return "O";
  }

  const rt = (restorationTypes ?? "").trim();
  const mat = (restorationMaterials ?? "").trim();
  if (!rt && !mat) return null;
  // Explicit removable restoration type wins over any material-only signal
  // (e.g. a PFZ/zirconia material on a denture case). Crown/bridge/implant
  // keywords in the same restoration-type string still take precedence.
  if (
    _REMOVABLE_RE.test(rt) &&
    !_IMPLANT_RE.test(rt) &&
    !_CROWN_BRIDGE_RE.test(rt)
  )
    return "D";
  // Same rule for an explicit ortho/appliance restoration type: it beats a
  // material-only signal (e.g. an acrylic night guard), but never a
  // crown/bridge/implant or removable keyword in the same type string.
  if (
    _ORTHO_RE.test(rt) &&
    !_IMPLANT_RE.test(rt) &&
    !_CROWN_BRIDGE_RE.test(rt) &&
    !_REMOVABLE_RE.test(rt)
  ) {
    return "O";
  }
  const haystack = `${rt} ${mat}`;
  if (
    _IMPLANT_RE.test(haystack) ||
    _CROWN_BRIDGE_RE.test(haystack) ||
    _ZIRCONIA_RE.test(mat)
  ) {
    return "C";
  }
  if (_REMOVABLE_RE.test(haystack)) return "D";
  if (_ORTHO_RE.test(haystack)) return "O";
  return null;
}

export default function DashboardScreen() {
  const insets = useSafeAreaInsets();
  const unassignedYRef = useRef<number>(0);
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  // ── Profile data ─────────────────────────────────────────────────────────
  const me = useMe(true);
  const { photoUrl, onPhotoError } = useProfilePhoto(me.data?.user as { id?: string; profilePhotoUrl?: string | null } | undefined);
  const meUser = me.data?.user as any;
  const memberships = me.data?.memberships ?? [];

  const fullName = [meUser?.firstName, meUser?.lastName]
    .filter(Boolean)
    .join(" ");
  const displayName = fullName || meUser?.username || "";
  const avatarLetter = (displayName || "?").charAt(0).toUpperCase();
  const displayRole = meUser?.role ?? "";

  const WORK_STATUS_COLORS: Record<string, string> = {
    available: "#10B981",
    break: "#F59E0B",
    lunch: "#F97316",
    out_of_office: "#94A3B8",
  };
  const workStatusColor = meUser?.workStatus
    ? (WORK_STATUS_COLORS[meUser.workStatus] ?? null)
    : null;
  const labMembership = memberships.find(
    (m: any) =>
      m.status === "active" &&
      (m.organization?.type ?? "").toLowerCase() === "lab",
  );
  const labName: string =
    labMembership?.organization?.name ?? meUser?.practiceName ?? "";
  // Use auth-me helpers so the gate/org-id correctly reflect the first active
  // lab membership where the user is owner/admin — not just the first lab
  // membership regardless of role.
  const isAdminRole = canAdminAnyLab(me.data);
  const labOrgId: string | null = primaryAdminLabOrgId(me.data);

  // Shared by Today's Sales query and the due-date case memos below.
  const dayKey = useDayChange();

  // ── Today's Sales ─────────────────────────────────────────────────────────
  interface TodaySalesData {
    totalSales: string;
    openBalance: string;
    invoices: number;
    paidInvoices: number;
    openInvoices: number;
  }
  const todaySalesQuery = useQuery<TodaySalesData>({
    queryKey: ["invoices", "reports", "sales", "today", labOrgId, dayKey],
    queryFn: async () => {
      // Build start-of-local-day / end-of-local-day UTC bounds so the server's
      // inclusive gte/lte comparison covers the full local calendar day.
      const now = new Date();
      const startOfDay = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        0,
        0,
        0,
        0,
      );
      const endOfDay = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        23,
        59,
        59,
        999,
      );
      const params = new URLSearchParams({
        organizationId: labOrgId!,
        dateFrom: startOfDay.toISOString(),
        dateTo: endOfDay.toISOString(),
      });
      const res = await resilientFetch(`/api/invoices/reports/sales?${params}`);
      if (!res.ok)
        throw new Error(`Failed to load today's sales (${res.status})`);
      const body = (await res.json()) as { data: TodaySalesData };
      return body.data;
    },
    enabled: isAdminRole && !!labOrgId,
    refetchInterval: 60_000,
  });

  // ── Exception cases ──────────────────────────────────────────────────────
  // Open to every internal lab member (not just admins) — anyone can flag a
  // case; only owners/admins can resolve, which the detail screen gates.
  const exceptionsQuery = useQuery<CaseExceptionQueueItem[]>({
    queryKey: EXCEPTION_QUEUE_QUERY_KEY,
    queryFn: fetchActiveExceptions,
    enabled: !!labMembership,
    refetchInterval: 60_000,
  });
  const activeExceptions = exceptionsQuery.data ?? [];

  // ── Prefs (persisted) ────────────────────────────────────────────────────
  const prefsLoadedRef = useRef(false);
  const [exceptionsOpen, setExceptionsOpen] = useState(
    DEFAULT_DASHBOARD_PREFS.exceptionsOpen,
  );
  const [pastDueOpen, setPastDueOpen] = useState(DEFAULT_DASHBOARD_PREFS.pastDueOpen);
  const [dueTodayOpen, setDueTodayOpen] = useState(DEFAULT_DASHBOARD_PREFS.dueTodayOpen);
  const [dueTomorrowOpen, setDueTomorrowOpen] = useState(
    DEFAULT_DASHBOARD_PREFS.dueTomorrowOpen,
  );
  const [dueTomorrowSort, setDueTomorrowSort] =
    useState<DueTomorrowSort>("entered");
  const [dueTomorrowSortOpen, setDueTomorrowSortOpen] = useState(false);
  const [pastDueSort, setPastDueSort] = useState<SectionSort>("due_date");
  const [pastDueSortOpen, setPastDueSortOpen] = useState(false);
  const [dueTodaySort, setDueTodaySort] = useState<SectionSort>("due_date");
  const [dueTodaySortOpen, setDueTodaySortOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(DEFAULT_DASHBOARD_PREFS.recentOpen);

  // Per-section "show all" expansion — resets to false when the section is collapsed.
  const [dueTomorrowExpanded, setDueTomorrowExpanded] = useState(false);
  const [dueTodayExpanded, setDueTodayExpanded] = useState(false);

  useEffect(() => {
    let active = true;
    const readPrefs = async () => {
      try {
        const saved = await loadDashboardPrefs((key) =>
          AsyncStorage.getItem(key),
        );
        if (!active) return;
        if (typeof saved.exceptionsOpen === "boolean")
          setExceptionsOpen(saved.exceptionsOpen);
        if (typeof saved.pastDueOpen === "boolean")
          setPastDueOpen(saved.pastDueOpen);
        if (typeof saved.dueTodayOpen === "boolean")
          setDueTodayOpen(saved.dueTodayOpen);
        if (typeof saved.dueTomorrowOpen === "boolean")
          setDueTomorrowOpen(saved.dueTomorrowOpen);
        if (typeof saved.recentOpen === "boolean")
          setRecentOpen(saved.recentOpen);
      } catch {
        // Preferences are optional and must never block the dashboard.
      } finally {
        if (active) prefsLoadedRef.current = true;
      }
    };
    void readPrefs();
    return () => {
      active = false;
    };
  }, []);

  function savePrefs(updates: Partial<DashboardPrefs>) {
    if (!prefsLoadedRef.current) return;
    const next: DashboardPrefs = {
      exceptionsOpen,
      pastDueOpen,
      dueTodayOpen,
      dueTomorrowOpen,
      recentOpen,
      ...updates,
    };
    AsyncStorage.setItem(DASHBOARD_PREFS_KEY, JSON.stringify(next)).catch(() => {});
  }

  function togglePastDue() {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setPastDueOpen((v) => {
      savePrefs({ pastDueOpen: !v });
      return !v;
    });
  }

  function toggleDueToday() {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setDueTodayOpen((v) => {
      savePrefs({ dueTodayOpen: !v });
      if (v) setDueTodayExpanded(false);
      return !v;
    });
  }

  function toggleDueTomorrow() {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setDueTomorrowOpen((v) => {
      savePrefs({ dueTomorrowOpen: !v });
      if (v) setDueTomorrowExpanded(false);
      return !v;
    });
  }

  function toggleExceptions() {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExceptionsOpen((v) => {
      savePrefs({ exceptionsOpen: !v });
      return !v;
    });
  }

  function toggleRecent() {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setRecentOpen((v) => {
      savePrefs({ recentOpen: !v });
      return !v;
    });
  }

  // ── Cases data ───────────────────────────────────────────────────────────
  const casesQuery = useCases();
  // Same key/options as UnassignedDocumentsCard: one shared request.
  const inboxLabOrgId = primaryLabOrgId(me.data) ?? "";
  const inboxQuery = useListLabInboxFiles(
    { labOrganizationId: inboxLabOrgId },
    {
      query: {
        queryKey: getListLabInboxFilesQueryKey({ labOrganizationId: inboxLabOrgId }),
        enabled: !!inboxLabOrgId,
      },
    },
  );
  const cases = casesQuery.data ?? [];

  // dayKey is declared above (shared with Today's Sales query).

  const pastDueCases = useMemo(() => {
    return sortPastDueCases(
      cases.filter(caseIsOverdue),
      pastDueSort,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cases, dayKey, pastDueSort]);

  const dueTodayCases = useMemo(() => {
    return sortDueTodayCases(cases.filter(caseIsDueToday), dueTodaySort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cases, dayKey, dueTodaySort]);

  const dueTomorrowCases = useMemo(() => {
    return sortDueTomorrowCases(
      cases.filter(caseIsDueTomorrow),
      dueTomorrowSort,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cases, dayKey, dueTomorrowSort]);

  const recentCasesQuery = useRecentCases();
  const recentCases = recentCasesQuery.data ?? [];

  // ── ScrollView ref + section offsets (for chip tap-through) ─────────────
  const scrollViewRef = useRef<ScrollView>(null);
  const dueTomorrowYRef = useRef<number>(0);
  const recentYRef = useRef<number>(0);
  const pastDueYRef = useRef<number>(0);
  const dueTodayYRef = useRef<number>(0);

  const rushCases = useMemo(
    () => cases.filter((c) => c.priority === "rush"),
    [cases],
  );

  // Jump to whichever section (in on-screen order) contains the first rush
  // case, expanding it first if it's collapsed. Mirrors the Due Tomorrow
  // chip's scroll-to-section behavior rather than scrolling to an exact row,
  // since rows don't track their own ScrollView-relative offset.
  function scrollToFirstRushSection() {
    const sections: Array<{
      yRef: React.MutableRefObject<number>;
      hasRush: boolean;
      isOpen: boolean;
      expand: () => void;
    }> = [
      {
        yRef: recentYRef,
        hasRush: recentCases.some((c) => c.priority === "rush"),
        isOpen: recentOpen,
        expand: () => {
          if (!recentOpen) toggleRecent();
        },
      },
      {
        yRef: pastDueYRef,
        hasRush: pastDueCases.some((c) => c.priority === "rush"),
        isOpen: pastDueOpen,
        expand: () => {
          if (!pastDueOpen) togglePastDue();
        },
      },
      {
        yRef: dueTodayYRef,
        hasRush: dueTodayCases.some((c) => c.priority === "rush"),
        isOpen: dueTodayOpen,
        expand: () => {
          if (!dueTodayOpen) toggleDueToday();
        },
      },
      {
        yRef: dueTomorrowYRef,
        hasRush: dueTomorrowCases.some((c) => c.priority === "rush"),
        isOpen: dueTomorrowOpen,
        expand: () => {
          if (!dueTomorrowOpen) toggleDueTomorrow();
        },
      },
    ];

    const target = sections.find((s) => s.hasRush);
    if (!target) return;
    if (!target.isOpen) target.expand();
    // Small delay lets any expand animation start before we scroll.
    setTimeout(() => {
      scrollViewRef.current?.scrollTo({
        y: target.yRef.current,
        animated: true,
      });
    }, 50);
  }

  // Active cases share one quick-action controller across mobile surfaces.
  const { markLongPress, consumeLongPress } = useLongPressGuard<string>();
  const [quickActionCase, setQuickActionCase] = useState<CanonicalCase | null>(null);

  // ── "Look Up Case" pop-up (search + on-demand barcode scan)
  const [showLookupSheet, setShowLookupSheet] = useState(false);


  // ── Case row renderer ────────────────────────────────────────────────────
  // Dashboard rows expose identity, station and status separately; the existing
  // case navigation, long-press actions and clinical work details stay intact.
  function renderCaseRow(c: CanonicalCase) {
    const overdue = isPastDueRaw(c);
    const work = getCompactWorkDetails(c);
    return (
      <Card
        key={c.id}
        style={[
          styles.row,
          c.priority === "rush" && { backgroundColor: colors.error + "0D" },
        ]}
        onPress={() => {
          if (consumeLongPress(c.id)) return;
          router.push(`/case/${c.id}` as never);
        }}
        onLongPress={() => {
          if (!isActiveCaseRecord(c)) return;
          markLongPress(c.id);
          Promise.resolve(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)).catch(() => {});
          setQuickActionCase(c);
        }}
        delayLongPress={400}
        accessibilityRole="button"
        accessibilityLabel={`${patientName(c)}${c.caseNumber ? `, case ${c.caseNumber}` : ""}`}
        accessibilityHint={
          isActiveCaseRecord(c)
            ? "Tap to open case details. Long press for quick actions."
            : "Tap to open case details."
        }
      >
        <View style={styles.rowMain}>
          {c.caseNumber ? (
            <Text style={styles.rowMeta} testID={`dashboard-case-number-${c.id}`}>
              {c.caseNumber}
            </Text>
          ) : null}
          <Text
            style={[
              styles.rowName,
              c.priority === "rush" && { color: colors.error },
            ]}
            numberOfLines={1}
          >
            {patientName(c)}
          </Text>
          {c.doctorName ? (
            <Text
              style={[
                styles.rowMeta,
                c.priority === "rush" && { color: colors.error },
              ]}
              numberOfLines={1}
            >
              {c.doctorName}
            </Text>
          ) : null}
          <Text style={styles.rowMeta} testID={`dashboard-case-location-${c.id}`}>
            Location: <Text>{caseLocationLabel(c)}</Text>
          </Text>
          {(work.typeLabel &&
            work.typeLabel !== "C" &&
            work.typeLabel !== "D" &&
            work.typeLabel !== "O") ||
          work.material ||
          work.detail ? (
            <View
              style={styles.workRow}
              testID={`compact-case-details-${c.id}`}
            >
              {work.typeLabel &&
              work.typeLabel !== "C" &&
              work.typeLabel !== "D" &&
              work.typeLabel !== "O" ? (
                <Text
                  style={[
                    styles.workType,
                    c.priority === "rush" && { color: colors.error },
                  ]}
                >
                  {work.typeLabel}
                </Text>
              ) : null}
              {work.material ? (
                <Text
                  style={[
                    styles.workText,
                    c.priority === "rush" && { color: colors.error },
                  ]}
                  numberOfLines={1}
                >
                  {work.material}
                </Text>
              ) : null}
              {work.detail ? (
                <Text
                  style={[
                    styles.workText,
                    c.priority === "rush" && { color: colors.error },
                  ]}
                  numberOfLines={1}
                >
                  {work.detail}
                </Text>
              ) : null}
            </View>
          ) : null}
          {c.status === "complete" ? (
            <Text
              style={[
                styles.rowDue,
                c.priority === "rush" && { color: colors.error },
              ]}
            >
              {formatCompletedAt(c.updatedAt)}
            </Text>
          ) : (
            <>
              {formatRelativeCreated(c.createdAt) ? (
                <Text
                  style={[
                    styles.rowDue,
                    c.priority === "rush" && { color: colors.error },
                  ]}
                >
                  {formatRelativeCreated(c.createdAt)}
                </Text>
              ) : null}
              {formatRelativeDue(c.dueDate, c.dueTime) ? (
                <Text
                  style={[
                    styles.rowDue,
                    (overdue || c.priority === "rush") && {
                      color: colors.error,
                    },
                  ]}
                >
                  {formatRelativeDue(c.dueDate, c.dueTime)}
                </Text>
              ) : null}
            </>
          )}
        </View>
        <View style={styles.rowRight}>
          {work.typeLabel === "C" ||
          work.typeLabel === "D" ||
          work.typeLabel === "O" ? (
            <TypeBadge letter={work.typeLabel} />
          ) : null}
          <StatusBadge
            label={caseLocationLabel({ status: c.status })}
            variant={caseStatusVariant(c.status)}
            color={c.priority === "rush" ? colors.error : undefined}
            bg={c.priority === "rush" ? colors.errorLight : undefined}
          />
          <Ionicons
            name="chevron-forward"
            size={18}
            color={colors.textTertiary}
          />
        </View>
      </Card>
    );
  }

  // ── Section renderers ────────────────────────────────────────────────────
  function renderPastDue() {
    return (
      <View
        style={styles.section}
        testID="dashboard-section-past-due"
        onLayout={(e) => {
          pastDueYRef.current = e.nativeEvent.layout.y;
        }}
      >
        <Pressable
          style={[
            styles.sectionHeader,
            { borderLeftWidth: 3, borderLeftColor: colors.error },
          ]}
          onPress={togglePastDue}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={pastDueOpen ? "Collapse past due" : "Expand past due"}
        >
          <View style={styles.sectionTitleRow}>
            <Ionicons name="alert-circle" size={16} color={colors.error} />
            <Text style={[styles.sectionTitle, { color: colors.error }]}>
              {DASHBOARD_SECTION_LABELS.pastDue}
            </Text>
            <View
              testID="dashboard-past-due-count"
              style={[
                styles.countBadge,
                { backgroundColor: colors.error + "20" },
              ]}
            >
              <Text style={[styles.countBadgeText, { color: colors.error }]}>
                {casesQuery.isLoading ? "…" : casesQuery.isError ? "—" : pastDueCases.length}
              </Text>
            </View>
          </View>
          <View style={styles.sectionActions}>
            <Pressable
              style={styles.sortButton}
              onPress={(e) => {
                e.stopPropagation();
                setPastDueSortOpen(true);
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Sort past due cases by ${SECTION_SORT_LABELS[pastDueSort]}`}
            >
              <Ionicons
                name="swap-vertical-outline"
                size={16}
                color={colors.error}
              />
              <Text style={[styles.sortButtonText, { color: colors.error }]}>
                Sort
              </Text>
            </Pressable>
            <Ionicons
              name={pastDueOpen ? "chevron-up" : "chevron-down"}
              size={16}
              color={colors.error}
            />
          </View>
        </Pressable>
        <Text style={styles.pastDueDescription}>
          Active cases with past due dates.
        </Text>
        {pastDueOpen && (
          <View style={styles.list}>
            {casesQuery.isLoading ? (
              <Text style={styles.emptyText}>Loading cases…</Text>
            ) : casesQuery.isError ? (
              <Text style={styles.emptyText}>Couldn't load cases. Tap the summary to retry.</Text>
            ) : pastDueCases.length === 0 ? (
              <Text style={styles.emptyText}>No active cases past due.</Text>
            ) : pastDueCases.map((c) => renderCaseRow(c))}
          </View>
        )}
      </View>
    );
  }

  function renderDueTomorrow() {
    return (
      <View
        style={styles.section}
        testID="dashboard-section-due-tomorrow"
        onLayout={(e) => {
          dueTomorrowYRef.current = e.nativeEvent.layout.y;
        }}
      >
        <Pressable
          style={styles.sectionHeader}
          onPress={toggleDueTomorrow}
          accessibilityRole="button"
          accessibilityLabel={dueTomorrowOpen ? "Collapse due tomorrow" : "Expand due tomorrow"}
          hitSlop={8}
        >
          <View style={styles.sectionTitleRow}>
            <Ionicons
              name="calendar-outline"
              size={16}
              color={colors.textSecondary}
            />
            <Text style={styles.sectionTitle}>
              {DASHBOARD_SECTION_LABELS.dueTomorrow}
            </Text>
            <View
              style={[
                styles.countBadge,
                { backgroundColor: colors.tint + "1A" },
              ]}
            >
              <Text style={[styles.countBadgeText, { color: colors.tint }]}>
                {dueTomorrowCases.length}
              </Text>
            </View>
          </View>
          <View style={styles.sectionActions}>
            <Pressable
              style={styles.sortButton}
              onPress={(e) => {
                e.stopPropagation();
                setDueTomorrowSortOpen(true);
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Sort due tomorrow cases by ${DUE_TOMORROW_SORT_LABELS[dueTomorrowSort]}`}
            >
              <Ionicons
                name="swap-vertical-outline"
                size={16}
                color={colors.textTertiary}
              />
              <Text
                style={[styles.sortButtonText, { color: colors.textTertiary }]}
              >
                Sort
              </Text>
            </Pressable>
            <Ionicons
              name={dueTomorrowOpen ? "chevron-up" : "chevron-down"}
              size={16}
              color={colors.textTertiary}
            />
          </View>
        </Pressable>

        {dueTomorrowOpen && (
          <View style={styles.list}>
            {casesQuery.isLoading ? (
              <Text style={styles.emptyText}>Loading cases…</Text>
            ) : casesQuery.isError ? (
              <Text style={styles.emptyText}>Couldn't load cases. Tap the summary to retry.</Text>
            ) : dueTomorrowCases.length === 0 ? (
              <Text style={styles.emptyText}>Nothing due tomorrow.</Text>
            ) : null}
            {(dueTomorrowExpanded
              ? dueTomorrowCases
              : dueTomorrowCases.slice(0, DUE_TOMORROW_CAP)
            ).map((c) => renderCaseRow(c))}
            {!dueTomorrowExpanded &&
              dueTomorrowCases.length > DUE_TOMORROW_CAP && (
                <Pressable
                  onPress={() => setDueTomorrowExpanded(true)}
                  hitSlop={8}
                  style={styles.showMoreBtn}
                >
                  <Text
                    style={[
                      styles.showMoreText,
                      { color: colors.textTertiary },
                    ]}
                  >
                    and {dueTomorrowCases.length - DUE_TOMORROW_CAP} more
                  </Text>
                </Pressable>
              )}
          </View>
        )}
      </View>
    );
  }

  function renderDueToday() {
    return (
      <View
        style={styles.section}
        testID="dashboard-section-due-today"
        onLayout={(e) => {
          dueTodayYRef.current = e.nativeEvent.layout.y;
        }}
      >
        <Pressable
          style={[styles.sectionHeader, { borderLeftWidth: 3, borderLeftColor: "#1D5FD8" }]}
          onPress={toggleDueToday}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={dueTodayOpen ? "Collapse due today" : "Expand due today"}
        >
          <View style={styles.sectionTitleRow}>
            <Ionicons
              name="today-outline"
              size={16}
              color="#1D5FD8"
            />
            <Text style={[styles.sectionTitle, { color: "#1D5FD8" }]}>
              {DASHBOARD_SECTION_LABELS.dueToday}
            </Text>
            {dueTodayCases.length > 0 && (
              <View
                style={[
                  styles.countBadge,
                  { backgroundColor: "#DBEAFE" },
                ]}
              >
                <Text
                  style={[
                    styles.countBadgeText,
                    { color: "#1D5FD8" },
                  ]}
                >
                  {dueTodayCases.length}
                </Text>
              </View>
            )}
          </View>
          <View style={styles.sectionActions}>
            <Pressable
              style={styles.sortButton}
              onPress={(e) => {
                e.stopPropagation();
                setDueTodaySortOpen(true);
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Sort due today cases by ${SECTION_SORT_LABELS[dueTodaySort]}`}
            >
              <Ionicons
                name="swap-vertical-outline"
                size={16}
                color={colors.textTertiary}
              />
              <Text
                style={[styles.sortButtonText, { color: colors.textTertiary }]}
              >
                Sort
              </Text>
            </Pressable>
            <Ionicons
              name={dueTodayOpen ? "chevron-up" : "chevron-down"}
              size={16}
              color={colors.textTertiary}
            />
          </View>
        </Pressable>

        {dueTodayOpen &&
          (casesQuery.isLoading || casesQuery.isError ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyText}>
                {casesQuery.isLoading ? "Loading cases…" : "Couldn't load cases. Tap the summary to retry."}
              </Text>
            </Card>
          ) : dueTodayCases.length === 0 ? (
            <Card style={styles.emptyCard}>
              <Ionicons
                name="checkmark-circle-outline"
                size={28}
                color={colors.success}
              />
              <Text style={styles.emptyText}>Nothing due today.</Text>
            </Card>
          ) : (
            <View style={styles.list}>
              {(dueTodayExpanded
                ? dueTodayCases
                : dueTodayCases.slice(0, DUE_TODAY_CAP)
              ).map((c) => renderCaseRow(c))}
              {!dueTodayExpanded && dueTodayCases.length > DUE_TODAY_CAP && (
                <Pressable
                  onPress={() => setDueTodayExpanded(true)}
                  hitSlop={8}
                  style={styles.showMoreBtn}
                >
                  <Text
                    style={[
                      styles.showMoreText,
                      { color: colors.textTertiary },
                    ]}
                  >
                    and {dueTodayCases.length - DUE_TODAY_CAP} more
                  </Text>
                </Pressable>
              )}
            </View>
          ))}
      </View>
    );
  }

  function renderExceptions() {
    if (!labMembership) return null;
    return (
      <View
        key="exceptions"
        style={styles.section}
        testID="dashboard-exception-cases"
      >
        <Pressable
          style={styles.sectionHeader}
          onPress={toggleExceptions}
          hitSlop={8}
        >
          <View style={styles.sectionTitleRow}>
            <Text style={styles.sectionTitle}>
              {DASHBOARD_SECTION_LABELS.exceptionCases}
            </Text>
            {activeExceptions.length > 0 && (
              <View
                style={[
                  styles.countBadge,
                  { backgroundColor: colors.warning + "1A" },
                ]}
              >
                <Text
                  style={[styles.countBadgeText, { color: colors.warning }]}
                  testID="dashboard-exception-count"
                >
                  {activeExceptions.length}
                </Text>
              </View>
            )}
          </View>
          <View style={styles.sectionActions}>
            <Ionicons
              name={exceptionsOpen ? "chevron-up" : "chevron-down"}
              size={16}
              color={colors.textTertiary}
            />
          </View>
        </Pressable>

        {exceptionsOpen &&
          (exceptionsQuery.isLoading ? (
            <Card style={styles.emptyCard} testID="dashboard-exception-loading">
              <ActivityIndicator size="small" color={colors.tint} />
              <Text style={styles.emptyText}>Loading exception cases…</Text>
            </Card>
          ) : exceptionsQuery.isError ? (
            <Card style={styles.emptyCard} testID="dashboard-exception-error">
              <Ionicons
                name="alert-circle-outline"
                size={24}
                color={colors.error}
              />
              <Text style={styles.emptyText}>
                Couldn't load exception cases.
              </Text>
            </Card>
          ) : activeExceptions.length === 0 ? (
            <Card style={styles.emptyCard} testID="dashboard-exception-empty">
              <Ionicons
                name="checkmark-circle-outline"
                size={28}
                color={colors.textTertiary}
              />
              <Text style={styles.emptyText}>
                No exception cases right now.
              </Text>
            </Card>
          ) : (
            <View style={styles.list}>
              {activeExceptions.map((ex) => (
                <Card
                  key={ex.id}
                  style={styles.row}
                  testID={`dashboard-exception-row-${ex.id}`}
                  onPress={() => router.push(`/case/${ex.caseId}` as never)}
                >
                  <View style={styles.rowMain}>
                    <View style={styles.exceptionPatientRow}>
                      <Text
                        style={[styles.rowName, { flexShrink: 1 }]}
                        numberOfLines={1}
                      >
                        {exceptionPatientLabel(ex)}
                      </Text>
                      <Text
                        style={styles.rowMeta}
                        testID={`dashboard-exception-location-${ex.id}`}
                        numberOfLines={1}
                      >
                        {`· ${
                          ex.currentLocationName ??
                          (ex.caseStatus
                            ? titleCase(ex.caseStatus)
                            : "Location unavailable")
                        }`}
                      </Text>
                    </View>
                    <Text style={styles.rowMeta} numberOfLines={1}>
                      {ex.caseNumber ? `#${ex.caseNumber}` : "No case #"}
                      {ex.doctorName ? `  ·  ${ex.doctorName}` : ""}
                    </Text>
                    {(ex.latestNoteText ?? ex.issueText) ? (
                      <Text style={styles.rowDue} numberOfLines={2}>
                        {ex.latestNoteText ?? ex.issueText}
                      </Text>
                    ) : null}
                    <Text style={styles.rowDue}>
                      {formatRelativeCreated(
                        ex.latestNoteCreatedAt ?? ex.createdAt,
                      ) ?? "Just now"}
                      {(ex.latestNoteCreatedAt
                        ? ex.latestNoteAuthorName
                        : ex.createdByName)
                        ? `  ·  ${
                            ex.latestNoteCreatedAt
                              ? ex.latestNoteAuthorName
                              : ex.createdByName
                          }`
                        : ""}
                    </Text>
                  </View>
                  <View style={styles.rowRight}>
                    {ex.hasMedia ? (
                      <Ionicons
                        name="attach-outline"
                        size={16}
                        color={colors.textTertiary}
                        testID={`dashboard-exception-media-${ex.id}`}
                      />
                    ) : null}
                    <StatusBadge label="Exception" variant="open" size="sm" />
                  </View>
                </Card>
              ))}
            </View>
          ))}
      </View>
    );
  }

  function renderRecentCases() {
    return (
      <View
        key="recent"
        style={styles.section}
        onLayout={(e) => {
          recentYRef.current = e.nativeEvent.layout.y;
        }}
      >
        <Pressable
          style={styles.sectionHeader}
          onPress={toggleRecent}
          hitSlop={8}
        >
          <View style={styles.sectionTitleRow}>
            <Text style={styles.sectionTitle}>
              {DASHBOARD_SECTION_LABELS.recentCases}
            </Text>
            {recentCases.length > 0 && (
              <View
                style={[
                  styles.countBadge,
                  { backgroundColor: colors.tint + "1A" },
                ]}
              >
                <Text style={[styles.countBadgeText, { color: colors.tint }]}>
                  {recentCases.length}
                </Text>
              </View>
            )}
          </View>
          <View style={styles.sectionActions}>
            <Ionicons
              name={recentOpen ? "chevron-up" : "chevron-down"}
              size={16}
              color={colors.textTertiary}
            />
          </View>
        </Pressable>

        {recentOpen &&
          (recentCases.length === 0 ? (
            <Card style={styles.emptyCard}>
              <Ionicons
                name="folder-open-outline"
                size={28}
                color={colors.textTertiary}
              />
              <Text style={styles.emptyText}>No cases yet.</Text>
            </Card>
          ) : (
            <View style={styles.list}>
              {recentCases.map((c) => renderCaseRow(c))}
            </View>
          ))}
      </View>
    );
  }

  // A signed-up user with no active membership of any kind (e.g. a lab employee
  // waiting for an invite/approval) has no lab data and none of the lab-only
  // actions below apply. Show a friendly waiting state instead. Gated on
  // me.isSuccess so members never see it flash during the initial fetch.
  const noActiveMembership =
    me.isSuccess && activeMemberships(me.data).length === 0;
  if (noActiveMembership) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: "center",
            padding: Spacing.xl,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <JoinLabCard />
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {/* ── Profile header ─────────────────────────────────────────────── */}
      <Pressable
        style={[styles.profileHeader, { paddingTop: insets.top + Spacing.sm }]}
        onPress={() => router.push("/settings/profile" as never)}
        testID="dashboard-profile-header"
      >
        <View style={styles.profileAvatarContainer}>
          {photoUrl ? (
            <Image
              key={photoUrl}
              source={{ uri: photoUrl }}
              onError={onPhotoError}
              style={styles.profileAvatar}
            />
          ) : (
            <View
              style={[
                styles.profileAvatarFallback,
                { backgroundColor: colors.tint + "20" },
              ]}
            >
              <Text
                style={[styles.profileAvatarLetter, { color: colors.tint }]}
              >
                {avatarLetter}
              </Text>
            </View>
          )}
          {workStatusColor ? (
            <View
              style={[
                styles.profileStatusDot,
                { backgroundColor: workStatusColor },
              ]}
            />
          ) : null}
        </View>
        <View style={styles.profileText}>
        {displayName ? (
          <Text
            style={[styles.profileName, { color: "#FFFFFF" }]}
            numberOfLines={1}
          >
            {displayName}
          </Text>
        ) : null}
        {labName ? (
          <Text
            style={[styles.profileLab, { color: "#BFD0F0" }]}
            numberOfLines={1}
          >
            {labName}
          </Text>
        ) : null}
        {displayRole ? (
          <Text
            style={[styles.profileRole, { color: "#8FA6D6" }]}
            numberOfLines={1}
          >
            <Text style={{ textTransform: "capitalize" }}>{displayRole}</Text>
          </Text>
        ) : null}
        </View>
        <Ionicons name="chevron-forward" size={18} color="#8FA6D6" />
      </Pressable>

      <ScrollView
        ref={scrollViewRef}
        testID="dashboard-scroll"
        style={styles.dashboardScroll}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={casesQuery.isFetching}
            onRefresh={() => casesQuery.refetch()}
            tintColor={colors.tint}
          />
        }
      >
      <View style={styles.greetingRow} testID="dashboard-greeting">
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Dashboard</Text>
          <Text style={styles.subtitle}>
            {getGreeting(meUser?.firstName)} - your lab at a glance
          </Text>
        </View>
      </View>

      {isAdminRole && !todaySalesQuery.isError && (
        <Pressable
          testID="dashboard-today-sales"
          style={({ pressed }) => [
            styles.todaySalesCard,
            pressed && { opacity: 0.75 },
          ]}
          onPress={() => router.push(TODAY_SALES_ROUTE as never)}
          accessibilityRole="button"
          accessibilityLabel="Today's sales — tap to open finance report"
        >
          <View style={styles.todaySalesHeader}>
            <Text style={[styles.todaySalesLabel, { color: colors.textSecondary }]}>
              Today's sales
            </Text>
            <View style={styles.todaySalesLiveDot} />
          </View>
          {todaySalesQuery.isLoading ? (
            <View style={[styles.todaySalesSkeleton, { backgroundColor: colors.border }]} />
          ) : (
            <>
              <Text style={[styles.todaySalesAmount, { color: colors.text }]}>
                {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
                  Number(todaySalesQuery.data?.totalSales ?? 0),
                )}
              </Text>
              <Text style={[styles.todaySalesInvoiceCount, { color: colors.textTertiary }]}>
                {todaySalesQuery.data?.invoices ?? 0}{" "}
                {(todaySalesQuery.data?.invoices ?? 0) === 1 ? "invoice" : "invoices"} today
              </Text>
              {todaySalesQuery.dataUpdatedAt ? (
                <Text style={[styles.todaySalesUpdated, { color: colors.textTertiary }]}>
                  Updated{" "}
                  {new Date(todaySalesQuery.dataUpdatedAt).toLocaleTimeString([], {
                    hour: "2-digit", minute: "2-digit",
                  })}
                </Text>
              ) : null}
            </>
          )}
        </Pressable>
      )}

      <View style={styles.primaryActions} testID="dashboard-primary-actions">
        <Pressable
          style={styles.addCaseBtn}
          onPress={() => router.push("/new-case" as never)}
          accessibilityRole="button"
          accessibilityLabel="Add case"
          testID="dashboard-add-case-btn"
        >
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={styles.addCaseText}>Add case</Text>
        </Pressable>
        <Pressable
          style={styles.addCaseBtn}
          onPress={() => router.push("/ai-assistant" as never)}
          accessibilityRole="button"
          accessibilityLabel="LabTrax Assistant"
          testID="dashboard-ai-assistant-btn"
        >
          <Ionicons name="sparkles" size={18} color="#fff" />
          <Text style={styles.addCaseText}>LabTrax Assistant</Text>
        </Pressable>
      </View>

      <View style={styles.summaryRow} testID="dashboard-summary">
        {(
          [
            {
              id: "past-due",
              title: DASHBOARD_SECTION_LABELS.pastDue,
              color: "#DC2626",
              bg: "#FEE2E2",
              icon: "alert-circle" as IconName,
              loading: casesQuery.isLoading,
              error: casesQuery.isError,
              count: pastDueCases.length,
              retry: () => casesQuery.refetch(),
              onPress: () => {
                if (!pastDueOpen) togglePastDue();
                setTimeout(
                  () => scrollViewRef.current?.scrollTo({ y: pastDueYRef.current, animated: true }),
                  50,
                );
              },
            },
            {
              id: "due-today",
              title: DASHBOARD_SECTION_LABELS.dueToday,
              color: "#1D5FD8",
              bg: "#DBEAFE",
              icon: "time" as IconName,
              loading: casesQuery.isLoading,
              error: casesQuery.isError,
              count: dueTodayCases.length,
              retry: () => casesQuery.refetch(),
              onPress: () => {
                if (!dueTodayOpen) toggleDueToday();
                setTimeout(
                  () => scrollViewRef.current?.scrollTo({ y: dueTodayYRef.current, animated: true }),
                  50,
                );
              },
            },
            {
              id: "due-tomorrow",
              title: DASHBOARD_SECTION_LABELS.dueTomorrow,
              color: "#1D5FD8",
              bg: "#DBEAFE",
              icon: "calendar-outline" as IconName,
              loading: casesQuery.isLoading,
              error: casesQuery.isError,
              count: dueTomorrowCases.length,
              retry: () => casesQuery.refetch(),
              onPress: () => {
                if (!dueTomorrowOpen) toggleDueTomorrow();
                setTimeout(
                  () => scrollViewRef.current?.scrollTo({ y: dueTomorrowYRef.current, animated: true }),
                  50,
                );
              },
            },
            {
              id: "unassigned",
              title: DASHBOARD_SECTION_LABELS.unassignedDocuments,
              color: "#B45309",
              bg: "#FEF3C7",
              icon: "document-text" as IconName,
              loading: me.isLoading || (!!inboxLabOrgId && inboxQuery.isLoading),
              error: me.isError || inboxQuery.isError,
              count: inboxQuery.data?.data?.length ?? 0,
              retry: () => me.isError ? me.refetch() : inboxQuery.refetch(),
              onPress: () => {
                requestRxIntake("reveal");
                setTimeout(
                  () => scrollViewRef.current?.scrollTo({ y: unassignedYRef.current, animated: true }),
                  50,
                );
              },
            },
          ] as const
        ).map((card) => (
          <Pressable
            key={card.id}
            style={[styles.summaryCard, styles.summaryCardPhone]}
            onPress={card.error ? card.retry : card.onPress}
            accessibilityRole="button"
            accessibilityLabel={
              card.error
                ? `${card.title} count unavailable, tap to retry`
                : `${card.title}: ${card.loading ? "loading" : card.count}`
            }
            testID={`dashboard-summary-${card.id}`}
          >
            <View style={[styles.summaryIcon, { backgroundColor: card.bg }]}>
              <Ionicons name={card.icon} size={16} color={card.color} />
            </View>
            <Text style={[styles.summaryCount, { color: card.color }]}>
              {card.loading ? "..." : card.error ? "--" : card.count}
            </Text>
            <Text style={[styles.summaryTitle, { flex: 1, order: 3 } as object]} numberOfLines={2}>
              {card.error ? "Tap to retry" : card.title}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.rxCard} testID="dashboard-rx-intake">
        <Text style={styles.rxTitle}>RX Intake</Text>
        <View style={styles.rxActions}>
          <Pressable
            style={styles.rxBtn}
            onPress={() => requestRxIntake("browse")}
            accessibilityRole="button"
            accessibilityLabel="Browse files"
            testID="dashboard-rx-browse-btn"
          >
            <Ionicons name="folder-open-outline" size={18} color="#1D5FD8" />
            <Text style={styles.rxBtnText}>Browse files</Text>
          </Pressable>
          <Pressable
            style={styles.rxBtn}
            onPress={() => requestRxIntake("photo")}
            accessibilityRole="button"
            accessibilityLabel="Capture photo"
            testID="dashboard-rx-capture-btn"
          >
            <Ionicons name="camera-outline" size={18} color="#1D5FD8" />
            <Text style={styles.rxBtnText}>Capture photo</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.header}>
        <Pressable
          style={styles.actionBtn}
          onPress={() => router.push("/batch-locate" as never)}
          testID="dashboard-batch-locate-btn"
        >
          <Ionicons name="layers-outline" size={18} color="#fff" />
          <Text
            style={styles.actionBtnText}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.7}
          >
            Batch Locate
          </Text>
        </Pressable>
        <Pressable
          style={styles.actionBtn}
          onPress={() => setShowLookupSheet(true)}
          testID="dashboard-case-lookup-btn"
        >
          <Ionicons name="search" size={18} color="#fff" />
          <Text
            style={styles.actionBtnText}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.7}
          >
            Look Up Case
          </Text>
        </Pressable>
        {/* The AI Rx capture flow's only entry point in the app — keeps the
            original testID so its navigation stays pinned by the same test. */}
        <Pressable
          style={styles.actionBtn}
          onPress={() => router.push("/ai-reader/capture?new=1" as never)}
          testID="dashboard-ai-reader-btn"
        >
          <Ionicons name="sparkles" size={18} color="#fff" />
          <Text
            style={styles.actionBtnText}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.7}
          >
            Scan Rx
          </Text>
        </Pressable>
      </View>

      {rushCases.length > 0 && (
        <View style={styles.statsChips}>
          {rushCases.length > 0 && (
            <Pressable
              style={styles.statsChip}
              onPress={scrollToFirstRushSection}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Scroll to rush cases"
            >
              <Ionicons
                name="alert-circle-outline"
                size={12}
                color={colors.error}
              />
              <Text style={[styles.statsChipText, { color: colors.error }]}>
                {rushCases.length} rush
              </Text>
            </Pressable>
          )}
        </View>
      )}

      {casesQuery.isLoading ? (
        <View accessibilityLabel="Loading cases">
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : null}
          <View style={{ paddingHorizontal: Spacing.lg }} onLayout={(e) => { unassignedYRef.current = e.nativeEvent.layout.y; }}>
            <UnassignedDocumentsCard />
          </View>
          {renderExceptions()}
          {renderRecentCases()}
          {renderPastDue()}
          {renderDueToday()}
          {renderDueTomorrow()}
        </ScrollView>

      <CaseQuickActionSheet
        visible={quickActionCase !== null}
        caseItem={quickActionCase}
        onDismiss={() => setQuickActionCase(null)}
        returnedWizardHandoff
      />
      <CaseLookupSheet
        visible={showLookupSheet}
        onDismiss={() => setShowLookupSheet(false)}
      />
      <CaseSortSheet
        visible={pastDueSortOpen}
        sectionLabel="Past due"
        sort={pastDueSort}
        labels={SECTION_SORT_LABELS}
        colors={colors}
        onClose={() => setPastDueSortOpen(false)}
        onSelect={(sort) => {
          setPastDueSort(sort);
          setPastDueSortOpen(false);
        }}
      />
      <CaseSortSheet
        visible={dueTodaySortOpen}
        sectionLabel="Due today"
        sort={dueTodaySort}
        labels={SECTION_SORT_LABELS}
        colors={colors}
        onClose={() => setDueTodaySortOpen(false)}
        onSelect={(sort) => {
          setDueTodaySort(sort);
          setDueTodaySortOpen(false);
        }}
      />
      <CaseSortSheet
        visible={dueTomorrowSortOpen}
        sectionLabel="Due tomorrow"
        sort={dueTomorrowSort}
        labels={DUE_TOMORROW_SORT_LABELS}
        colors={colors}
        onClose={() => setDueTomorrowSortOpen(false)}
        onSelect={(sort) => {
          setDueTomorrowSort(sort);
          setDueTomorrowSortOpen(false);
        }}
      />
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: "#EEF3F9" },
    profileHeader: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: "#0B1B3F",
      paddingHorizontal: Spacing.lg,
      paddingBottom: Spacing.sm,
      gap: Spacing.sm,
    },
    profileText: { flex: 1, gap: 1 },
    primaryActions: {
      flexDirection: "row",
      alignItems: "stretch",
      gap: Spacing.xs,
      paddingHorizontal: Spacing.lg,
    },
    addCaseBtn: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
      backgroundColor: "#1D5FD8",
      paddingHorizontal: Spacing.md,
      minHeight: 44,
      borderRadius: 6,
    },
    addCaseText: { ...Typography.bodySemibold, color: "#fff", flexShrink: 1, textAlign: "center" },
    summaryRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: Spacing.xs,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.xs,
    },
    summaryCard: {
      flexGrow: 1,
      flexBasis: "30%",
      minHeight: 44,
      backgroundColor: "#FFFFFF",
      borderWidth: 1,
      borderColor: "#DCE5F0",
      borderRadius: 8,
      padding: Spacing.sm,
      gap: 2,
    },
    summaryCardPhone: {
      flexBasis: "100%",
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      minHeight: 52,
    },
    summaryIcon: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
    },
    summaryCount: { ...Typography.h2 },
    summaryTitle: { ...Typography.caption, color: "#475569" },
    rxCard: {
      marginHorizontal: Spacing.lg,
      marginTop: Spacing.xs,
      backgroundColor: "#FFFFFF",
      borderWidth: 1,
      borderColor: "#DCE5F0",
      borderRadius: 8,
      padding: Spacing.sm,
      gap: Spacing.xs,
    },
    rxTitle: { ...Typography.bodySemibold, color: "#0F1F4A" },
    rxActions: { flexDirection: "row", gap: Spacing.xs },
    rxBtn: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      minHeight: 44,
      borderRadius: 6,
      borderWidth: 1.5,
      borderStyle: "dashed",
      borderColor: "#94B4EA",
    },
    rxBtnText: { ...Typography.bodySemibold, color: "#1D5FD8" },
    profileAvatarContainer: {
      position: "relative",
      width: 60,
      height: 60,
      marginBottom: Spacing.xs,
    },
    profileAvatar: {
      width: 60,
      height: 60,
      borderRadius: 30,
    },
    profileAvatarFallback: {
      width: 60,
      height: 60,
      borderRadius: 30,
      alignItems: "center",
      justifyContent: "center",
    },
    profileStatusDot: {
      position: "absolute",
      bottom: 1,
      right: 1,
      width: 14,
      height: 14,
      borderRadius: 7,
      borderWidth: 2,
      borderColor: c.backgroundSolid,
    },
    profileAvatarLetter: { ...Typography.h2 },
    profileName: { ...Typography.h3, textAlign: "center" },
    profileLab: { ...Typography.body, textAlign: "center" },
    profileRole: { ...Typography.caption, textAlign: "center" },
    greetingRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.xs,
      paddingBottom: 2,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      // Four actions no longer fit legibly on one line at typical phone
      // widths, so they wrap into a 2×2 grid instead of shrinking their
      // labels to the point of being unreadable.
      flexWrap: "wrap",
      gap: Spacing.xs,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.xs,
      paddingBottom: Spacing.xs,
    },
    title: { ...Typography.h1, color: c.text },
    subtitle: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    actionBtn: {
      // flexBasis just under half the row keeps two buttons per line once the
      // Spacing.xs gap is taken into account; flexGrow lets them fill it.
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: "45%",
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      backgroundColor: "#1D5FD8",
      paddingHorizontal: Spacing.md,
      paddingVertical: 10,
      borderRadius: Radius.md,
      minHeight: 44,
    },
    actionBtnText: {
      ...Typography.bodySemibold,
      color: "#fff",
      flexShrink: 1,
    },
    statsChips: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: Spacing.xs,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.xs,
      paddingBottom: 2,
    },
    statsChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 99,
      backgroundColor: c.surface,
    },
    statsChipText: { ...Typography.caption, color: c.textSecondary },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: Spacing.xl,
      minHeight: 280,
    },
    content: {
      paddingBottom: Spacing.lg,
      paddingTop: Spacing.sm,
      gap: Spacing.sm,
      width: "100%",
      maxWidth: 1040,
      alignSelf: "center",
    },
    dashboardScroll: { flex: 1, minHeight: 0 },
    section: {
      gap: Spacing.md,
      marginHorizontal: Spacing.lg,
      padding: Spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
    },
    pastDueDescription: {
      ...Typography.caption,
      color: c.textSecondary,
      marginTop: -Spacing.sm,
    },
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    sectionTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    sectionTitle: { ...Typography.h2, color: c.text },
    countBadge: {
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: Radius.full ?? 99,
    },
    countBadgeText: { ...Typography.captionSemibold },
    sectionActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    sortButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      paddingHorizontal: 4,
      paddingVertical: 2,
    },
    sortButtonText: { ...Typography.caption },
    sortModalBackdrop: {
      flex: 1,
      justifyContent: "flex-end",
      backgroundColor: c.text + "66",
    },
    sortSheet: {
      borderTopWidth: 1,
      borderTopLeftRadius: Radius.lg,
      borderTopRightRadius: Radius.lg,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.lg,
      paddingBottom: Spacing.xl,
      gap: Spacing.xs,
    },
    sortSheetHeading: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: Spacing.sm,
    },
    sortSheetTitle: { ...Typography.h2 },
    sortOption: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      minHeight: 44,
      paddingHorizontal: Spacing.sm,
      borderRadius: Radius.md,
    },
    sortOptionText: { ...Typography.body },
    list: { gap: Spacing.sm },
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    rowMain: { flex: 1, gap: 2 },
    exceptionPatientRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
    },
    rowName: { ...Typography.bodySemibold, color: c.text },
    rowMeta: { ...Typography.caption, color: c.textSecondary },
    rowDue: { ...Typography.caption, color: c.textTertiary, marginTop: 2 },
    workRow: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: Spacing.xs,
      marginTop: 2,
    },
    workType: { ...Typography.captionSemibold, color: c.tint },
    workText: { ...Typography.caption, color: c.textSecondary },
    rowRight: { alignItems: "flex-end", gap: Spacing.xs },
    emptyCard: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    emptyText: { ...Typography.body, color: c.textSecondary, flex: 1 },
    locatedBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
    },
    locatedBadgeText: { ...Typography.captionSemibold },
    showMoreBtn: {
      alignSelf: "center",
      paddingVertical: 4,
      paddingHorizontal: 8,
    },
    showMoreText: {
      ...Typography.caption,
      textDecorationLine: "underline" as const,
    },
    todaySalesCard: {
      marginHorizontal: Spacing.lg,
      backgroundColor: c.surface,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      gap: 3,
    },
    todaySalesHeader: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: Spacing.xs,
    },
    todaySalesLabel: { ...Typography.caption },
    todaySalesLiveDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: "#10B981",
    },
    todaySalesAmount: { ...Typography.h2 },
    todaySalesSkeleton: {
      height: 24,
      width: 100,
      borderRadius: Radius.sm ?? 4,
      marginVertical: 2,
    },
    todaySalesInvoiceCount: { ...Typography.caption },
    todaySalesUpdated: { ...Typography.caption, fontSize: 10, marginTop: 1 },
  });
}
