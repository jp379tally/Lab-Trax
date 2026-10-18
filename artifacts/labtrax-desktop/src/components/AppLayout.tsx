import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createSingleFlight } from "@/lib/single-flight";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { UpdateBanner } from "./UpdateBanner";
import { Link, useLocation } from "wouter";
import {
  AlertTriangle,
  BarChart3,
  Bell,
  Building2,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  CreditCard,
  FileBarChart2,
  FileText,
  LayoutDashboard,
  List,
  Loader2,
  LogOut,
  MessageSquare,
  MonitorDown,
  Receipt,
  Settings,
  Sparkles,
  Tag,
  Upload,
  Users,
  Wallet,
  Wrench,
  XCircle,
  HardDrive,
  Zap,
  ExternalLink,
  Crown,
  Menu,
  X,
} from "lucide-react";
import { AiChatPanel } from "./AiChatPanel";
import { AiPanelContext, type AiCaseContext } from "@/lib/ai-panel-context";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import { customerRequestLabs, useCustomerRequestCounts } from "@/lib/customer-requests";
import { useUploads } from "@/lib/uploads-context";
import { Logo } from "./Logo";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { headerRoleLabel } from "@/lib/membership-roles";
import {
  useGetDoctorDuplicateClusters,
  getGetDoctorDuplicateClustersQueryKey,
} from "@workspace/api-client-react";
import { apiFetch, apiFetchArrayBuffer, apiDownloadBackupToFolder, serverAssetUrl } from "@/lib/api";
import { Avatar, AvatarImage, AvatarFallback } from "./ui/avatar";
import { startLocalBackupScheduler } from "@/lib/local-backup-scheduler";
import type { LocalBackupLiveStatus } from "@/lib/local-backup-execution";
import { setScheduledLocalBackupProgress } from "@/lib/local-backup-progress";
import { BackupStalenessBanner, useBackupFreshness } from "./BackupStalenessBanner";
import type { MeResponse } from "@/lib/types";
import { useCreatorAccess } from "@/lib/creator";
import { canReportIssueRole, ReportIssueAction, FeedbackAction } from "./ReportIssueDialog";
import { ScheduledBackupIndicator } from "./ScheduledBackupIndicator";

interface NavItem {
  label: string;
  path: string;
  icon: typeof LayoutDashboard;
  badge?: string;
  adminOnly?: boolean;
  billingOnly?: boolean;
  recoveryBillingOnly?: boolean;
  ownerOnly?: boolean;
  creatorOnly?: boolean;
  /** Visible only to billing-role members of this specific lab. */
  labId?: string;
}

interface NavGroup {
  label: string;
  icon: typeof LayoutDashboard;
  /** When set, the group header navigates here; a separate chevron toggles the children. */
  path?: string;
  children: (NavItem | NavGroup)[];
  adminOnly?: boolean;
  billingOnly?: boolean;
  ownerOnly?: boolean;
  creatorOnly?: boolean;
}

export const NAV: (NavItem | NavGroup)[] = [
  { label: "Dashboard", path: "/", icon: LayoutDashboard },
  { label: "Cases", path: "/cases", icon: FileText },
  { label: "Messages", path: "/messages", icon: MessageSquare },
];

function isGroup(item: NavItem | NavGroup): item is NavGroup {
  return "children" in item;
}

function navPathActive(path: string, location: string): boolean {
  if (path === "/") return location === "/" || location === "";
  return location.startsWith(path);
}

function groupContainsActive(group: NavGroup, location: string): boolean {
  return group.children.some((child) =>
    isGroup(child)
      ? groupContainsActive(child, location)
      : navPathActive(child.path, location),
  );
}

function groupContainsPath(group: NavGroup, path: string): boolean {
  return group.children.some((child) =>
    isGroup(child)
      ? groupContainsPath(child, path)
      : child.path === path,
  );
}

// iPhone-style red count badge used on nav items/group headers.
function DuplicateCountBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="shrink-0 inline-flex items-center justify-center rounded-full bg-red-500 px-1.5 text-[10px] font-semibold leading-none text-white"
      style={{ minWidth: 18, height: 18 }}
      aria-label={`${count} possible duplicate doctor ${
        count === 1 ? "group" : "groups"
      }`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

const BILLING_ROLES = new Set(["owner", "admin", "billing"]);

export const SECONDARY: (NavItem | NavGroup)[] = [
  { label: "Subscription", path: "/billing", icon: Zap },
  {
    label: "Admin Settings",
    path: "/settings",
    icon: Settings,
    children: [
      { label: "Customer Center", path: "/accounts", icon: Building2 },
      {
        label: "Financial",
        icon: Wallet,
        children: [
          { label: "Invoices", path: "/invoices", icon: Receipt },
          { label: "Statements", path: "/statements", icon: CreditCard },
          { label: "Bank Register", path: "/finance", icon: Wallet },
          { label: "Recovery Billing", path: "/recovery-billing", icon: Receipt, billingOnly: true, recoveryBillingOnly: true },
        ],
      },
      { label: "Pricing", path: "/pricing", icon: Tag },
      { label: "Lists", path: "/lists", icon: List, billingOnly: true },
      { label: "Reports", path: "/reports", icon: FileBarChart2, billingOnly: true },
      { label: "Maintenance", path: "/maintenance", icon: HardDrive, adminOnly: true },
    ],
  },
  {
    label: "Creator",
    path: "/creator",
    icon: Crown,
    creatorOnly: true,
    children: [
      { label: "Revenue", path: "/creator?tab=revenue", icon: BarChart3, creatorOnly: true },
      { label: "Feedback inbox", path: "/creator?tab=feedback", icon: FileText, creatorOnly: true },
      { label: "Subscriptions", path: "/creator?tab=subscriptions", icon: CreditCard, creatorOnly: true },
      { label: "Lab Profile", path: "/creator?tab=lab-owner&ownerTab=lab-profile", icon: Building2, ownerOnly: true },
      { label: "Team & Roles", path: "/creator?tab=lab-owner&ownerTab=team", icon: Users, ownerOnly: true },
      { label: "Lab Revenue Reports", path: "/creator?tab=lab-owner&ownerTab=revenue", icon: BarChart3, ownerOnly: true },
      { label: "Billing", path: "/billing", icon: CreditCard, ownerOnly: true },
      { label: "Danger Zone", path: "/creator?tab=lab-owner&ownerTab=danger-zone", icon: AlertTriangle, ownerOnly: true },
    ],
  },
  { label: "Download Desktop App", path: "/download", icon: MonitorDown },
];

interface Props {
  children: ReactNode;
}

type Notification = {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  dataJson?: unknown;
  readAt: string | null;
  createdAt: string;
};

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const SECURITY_REASONS = new Set([
  "refresh_token_reuse_detected",
  "suspicious_login",
  "suspicious_signin",
]);

export function getNotificationDestination(notif: Notification): string | null {
  const data = notif.dataJson as Record<string, unknown> | null | undefined;

  if (
    notif.type === "case_created" ||
    notif.type === "rush_case_created" ||
    notif.type === "case_exception_created" ||
    notif.type === "case_imported_from_itero" ||
    (notif.type === "alert" && data?.caseId)
  ) {
    const caseId = data?.caseId as string | undefined;
    if (caseId) return `/cases?caseId=${encodeURIComponent(caseId)}`;
  }

  if (
    notif.type === "security_session_revoked" ||
    notif.type === "suspicious_signin" ||
    (data?.reason && SECURITY_REASONS.has(String(data.reason))) ||
    (data?.alertReason && String(data.alertReason).toLowerCase().includes("security"))
  ) {
    return "/settings?tab=sessions";
  }

  if (
    notif.type === "join_request_approved" ||
    notif.type === "join_request_rejected"
  ) {
    return "/";
  }

  if (notif.type === "join_request_pending") {
    return "/settings?tab=profile";
  }

  if (notif.type === "backup_local_error" || notif.type === "backup_offsite_failure") {
    return "/settings?tab=backup";
  }

  if (notif.type === "provider_payment_received" || notif.type === "payment_reversed") {
    const providerOrganizationId = data?.providerOrganizationId as string | undefined;
    return providerOrganizationId
      ? `/accounts?providerOrganizationId=${encodeURIComponent(providerOrganizationId)}`
      : "/accounts";
  }

  if (
    notif.type === "provider_note_added" ||
    notif.type === "provider_attachment_added" ||
    notif.type === "shared_note_added" ||
    notif.type === "shared_attachment_added"
  ) {
    const caseId = data?.caseId as string | undefined;
    if (caseId) return `/cases?caseId=${encodeURIComponent(caseId)}`;
  }

  return null;
}

export function getProviderCaseActivityId(notif: Notification): string | null {
  if (
    notif.type !== "provider_note_added" &&
    notif.type !== "provider_attachment_added"
  ) {
    return null;
  }
  const data = notif.dataJson as Record<string, unknown> | null | undefined;
  return typeof data?.caseId === "string" && data.caseId.length > 0
    ? data.caseId
    : null;
}

const POLL_INTERVAL_MS = 60_000;

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const IDLE_LOGOUT_FLAG = "labtrax_idle_logout_v1";

const IDLE_EVENTS = ["mousemove", "mousedown", "keydown", "touchstart"] as const;

export function AppLayout({ children }: Props) {
  const [location, setLocation] = useLocation();
  const { user, logout, updateProfilePhoto } = useAuth();
  const isAdmin = user?.role === "admin";
  const [menuOpen, setMenuOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => { setNavOpen(false); }, [location]);
  const [uploadsOpen, setUploadsOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiPanelCases, setAiPanelCases] = useState<AiCaseContext[]>([]);

  // Local-folder scheduled backups are executed by this desktop app while it
  // is open (the server cannot reach the local disk). The scheduler no-ops in
  // plain browsers and for non-local schedules, and backs off on 403.
  useEffect(() => {
    if (!isAdmin) return;
    const electronAPI = (window as unknown as {
      electronAPI?: {
        downloadBackupToFolder?: unknown;
        onBackupRunId?: (callback: (runId: string) => void) => () => void;
        saveBackupToFolder?: (
          buffer: Uint8Array,
          fileName: string,
          folderPath: string,
        ) => Promise<{ ok: boolean; path?: string; error?: string }>;
      };
    }).electronAPI;
    if (!electronAPI?.saveBackupToFolder && !electronAPI?.downloadBackupToFolder) return;
    return startLocalBackupScheduler({
      apiFetch,
      apiFetchArrayBuffer,
      saveBackupToFolder: electronAPI.saveBackupToFolder,
      downloadBackupToFolder: electronAPI.downloadBackupToFolder ? apiDownloadBackupToFolder : undefined,
      onDownloadRunId: electronAPI.onBackupRunId,
      getLiveStatus: (runId) =>
        apiFetch<LocalBackupLiveStatus>(`/admin/backup/status/${encodeURIComponent(runId)}`),
      onProgress: setScheduledLocalBackupProgress,
      storage: window.localStorage,
    });
  }, [isAdmin]);

  const openAiPanel = useCallback(
    (ctx?: AiCaseContext | AiCaseContext[]) => {
      if (Array.isArray(ctx)) {
        setAiPanelCases(ctx);
      } else {
        setAiPanelCases(ctx ? [ctx] : []);
      }
      setAiPanelOpen(true);
    },
    [],
  );
  const [notificationItems, setNotificationItems] = useState<Notification[]>([]);
  const [notifLoading, setNotifLoading] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);
  const markReadInflight = useRef(false);
  // Notification ids already observed by the poller. `null` until the first
  // poll seeds it, so we don't toast pre-existing notifications on mount.
  const seenNotifIdsRef = useRef<Set<string> | null>(null);
  const notificationRead = useRef(createSingleFlight<Notification[]>());
  const notificationUser = useRef(user?.id);
  notificationUser.current = user?.id;
  const loadNotifications = useCallback(() => notificationRead.current(
    user?.id ?? "",
    () => apiFetch<Notification[]>("/notifications"),
  ), [user?.id]);
  useEffect(() => {
    seenNotifIdsRef.current = null;
    setNotificationItems([]);
    setHasUnread(false);
  }, [user?.id]);
  const [selectedNotif, setSelectedNotif] = useState<Notification | null>(null);
  const queryClient = useQueryClient();

  // Freshness of the archive actually confirmed off-site, from the lab-admin
  // endpoint (no platform-admin session needed): this drives both the nav dot
  // and the persistent banner, so an outage cannot be visible only to someone
  // who happens to open Settings.
  const backupFreshness = useBackupFreshness(isAdmin);
  const backupOverdue = isAdmin && backupFreshness.stale;

  const { entries, activeCount, removeEntry, cancelEntry } = useUploads();
  const meQuery = useQuery({
    queryKey: ["auth", "me", user?.id],
    queryFn: () => apiFetch<MeResponse>("/auth/me"),
    enabled: !!user,
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
  });
  const recoveryBillingAccessQuery = useQuery({
    queryKey: ["billing-recovery", "access", user?.id],
    queryFn: () => apiFetch<{ available: boolean; role?: "admin" | "staff" }>("/billing-recovery/access"),
    enabled: !!user,
    retry: false,
  });
  const refetchMe = meQuery.refetch;
  const requestLabs = customerRequestLabs(meQuery.data);
  const requestQueries = useCustomerRequestCounts(user?.id, requestLabs.map((m) => m.organizationId));
  const pendingRequestCount = requestQueries.reduce((sum, query) => sum + (query.data?.length ?? 0), 0);
  const requestCountError = requestQueries.some((query) => query.isError);
  const firstPendingLabId = requestLabs[requestQueries.findIndex((query) => (query.data?.length ?? 0) > 0)]?.organizationId;
  const requestHref = `/accounts?view=requests${firstPendingLabId ? `&requestLabId=${encodeURIComponent(firstPendingLabId)}` : ""}`;
  useEffect(() => {
    if (!user) return;
    const refreshRequests = () => {
      void queryClient.invalidateQueries({ queryKey: ["lab-team", "customer-requests", user.id] });
    };
    window.addEventListener("focus", refreshRequests);
    return () => window.removeEventListener("focus", refreshRequests);
  }, [queryClient, user?.id]);
  useEffect(() => {
    if (meQuery.data && meQuery.data.user.id === user?.id && user &&
      meQuery.data.user.profilePhotoUrl !== user.profilePhotoUrl) {
      updateProfilePhoto?.(user.id, meQuery.data.user.profilePhotoUrl ?? null);
    }
  }, [meQuery.data, user, updateProfilePhoto]);
  // Electron windows can regain focus without a document visibility change.
  useEffect(() => {
    if (!user) return;
    const onFocus = () => { void refetchMe({ cancelRefetch: false }); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [user?.id, refetchMe]);
  const hasBillingLab = useMemo(
    () =>
      (meQuery.data?.memberships ?? []).some(
        (m) =>
          m.status === "active" &&
          m.organization?.type === "lab" &&
          BILLING_ROLES.has(m.role),
      ),
    [meQuery.data],
  );
  const hasActiveLabMembership = useMemo(
    () =>
      (meQuery.data?.memberships ?? []).some(
        (m) => m.status === "active" && m.organization?.type === "lab",
      ),
    [meQuery.data],
  );
  const creatorAccess = useCreatorAccess();
  const isCreator = creatorAccess.data?.isCreator === true;
  const isOwnerOfLab = useMemo(
    () =>
      (meQuery.data?.memberships ?? []).some(
        (m) =>
          m.status === "active" &&
          m.organization?.type === "lab" &&
          m.role === "owner",
      ),
    [meQuery.data],
  );
  const canReportLabIssue = useMemo(
    () =>
      (meQuery.data?.memberships ?? []).some(
        (m) =>
          m.status === "active" &&
          m.organization?.type === "lab" &&
          m.organization.isActive !== false &&
          !m.organization.deletedAt &&
          canReportIssueRole(m.role),
      ),
    [meQuery.data],
  );
  // Hide lab-only navigation (case lists) for users who have signed up but are
  // not yet a member of any active lab. Only once /auth/me has loaded, so
  // members never see the nav flicker during the initial fetch.
  const noActiveLabMembership = meQuery.isSuccess && !hasActiveLabMembership;

  const dupClustersQuery = useGetDoctorDuplicateClusters({
    query: {
      queryKey: getGetDoctorDuplicateClustersQueryKey(),
      enabled: !!user,
      refetchInterval: POLL_INTERVAL_MS,
      staleTime: 30_000,
    },
  });
  const dupClusterCount = dupClustersQuery.data?.data?.totalGroups ?? 0;

  // Messenger unread count — polled every 10 s, drives the red dot on Messages nav
  const messengerUnreadQuery = useQuery<{ total: number }>({
    queryKey: ["provider-messenger", "unread-count"],
    queryFn: () => apiFetch<{ total: number }>("/provider-messenger/unread-count"),
    enabled: !!user && hasActiveLabMembership,
    refetchInterval: 10_000,
    staleTime: 0,
    retry: false,
  });
  const messengerUnreadCount = messengerUnreadQuery.data?.total ?? 0;

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const successCount = entries.filter((e) => e.status === "success").length;
  const errorCount = entries.filter((e) => e.status === "error").length;
  const interruptedCount = entries.filter((e) => e.status === "interrupted").length;
  const hasAnyUploads = entries.length > 0;

  const initials = useMemo(() => {
    if (user?.initials) return user.initials.slice(0, 2).toUpperCase();
    const first = user?.firstName?.[0] || user?.username?.[0] || "?";
    const last = user?.lastName?.[0] || "";
    return (first + last).toUpperCase();
  }, [user]);
  // A successful profile response may intentionally clear the photo; in that
  // case don't resurrect the older image from the initial session snapshot.
  const profilePhoto =
    meQuery.isSuccess && meQuery.data?.user.id === user?.id
      ? meQuery.data.user.profilePhotoUrl
      : user?.profilePhotoUrl;
  let avatarUrl: string | null = null;
  try { avatarUrl = profilePhoto ? serverAssetUrl(profilePhoto) : null; } catch { /* initials */ }

  const headerLabMemberships = (meQuery.data?.memberships ?? []).filter(
    (m) => m.status === "active" && m.organization?.type === "lab",
  );
  const headerLab = (
    headerLabMemberships.find((m) => m.organizationId === user?.practiceOrganizationId) ??
    headerLabMemberships[0]
  )?.organization;
  const headerLabName =
    headerLab?.displayName ||
    headerLab?.name ||
    user?.practiceName ||
    "";

  const fullName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
    user?.username ||
    "Guest";

  // Team settings' names for the user's real lab role (Billing and Read Only
  // included), not the collapsed admin/user authorization role.
  const role = headerRoleLabel(user);

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      try { sessionStorage.setItem(IDLE_LOGOUT_FLAG, "1"); } catch {}
      void logout();
    }, IDLE_TIMEOUT_MS);
  }, [logout]);

  useEffect(() => {
    if (!user) return;
    resetIdleTimer();
    const handler = () => resetIdleTimer();
    for (const evt of IDLE_EVENTS) window.addEventListener(evt, handler, { passive: true });
    return () => {
      for (const evt of IDLE_EVENTS) window.removeEventListener(evt, handler);
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
    };
  }, [user, resetIdleTimer]);

  const fetchUnreadCount = useCallback(async () => {
    if (!user) return;
    try {
      const items = await loadNotifications();
      if (notificationUser.current !== user.id) return;
      const unread = items.some((n) => !n.readAt);
      setHasUnread(unread);

      // Pop a proactive toast the moment a join-request decision lands, so the
      // user doesn't have to open the bell to learn they were approved or
      // declined. On the first poll we seed the seen-set without toasting to
      // avoid replaying pre-existing notifications on mount.
      const seen = seenNotifIdsRef.current;
      if (seen === null) {
        seenNotifIdsRef.current = new Set(items.map((n) => n.id));
      } else {
        for (const n of items) {
          if (seen.has(n.id)) continue;
          seen.add(n.id);
          if (n.readAt) continue;
          if (
            n.type === "join_request_approved" ||
            n.type === "join_request_rejected"
          ) {
            toast({
              title: n.title,
              description: n.body,
              variant:
                n.type === "join_request_rejected" ? "destructive" : "default",
              duration: 6000,
            });
          }
          if (n.type === "backup_local_error" || n.type === "backup_offsite_failure") {
            toast({
              title: n.title,
              description: n.body,
              // Off-site protection lapsing is the one alert that must not be
              // missed, so it stays on screen until it is dismissed.
              variant: "destructive",
              duration: n.type === "backup_offsite_failure" ? Infinity : 8000,
            });
          }
        }
      }
    } catch {
      /* ignore */
    }
  }, [user?.id, loadNotifications]);

  useEffect(() => {
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchUnreadCount]);

  async function openNotifications() {
    const userId = user?.id;
    setNotificationsOpen(true);
    setNotifLoading(true);
    try {
      const items = await loadNotifications();
      if (notificationUser.current !== userId) return;
      setNotificationItems(items);
      setHasUnread(items.some((n) => !n.readAt));
    } catch {
      /* ignore */
    } finally {
      setNotifLoading(false);
    }
  }

  async function closeNotifications() {
    setNotificationsOpen(false);
    if (markReadInflight.current) return;
    markReadInflight.current = true;
    try {
      await apiFetch("/notifications/mark-all-read", { method: "POST" });
      setNotificationItems((prev) =>
        prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() }))
      );
      setHasUnread(false);
    } catch {
      /* ignore */
    } finally {
      markReadInflight.current = false;
    }
  }

  async function handleNotificationClick(notif: Notification) {
    setNotificationsOpen(false);

    // Provider notes and attachments are written by another client. Refresh the
    // open case drawer immediately when its notification is selected instead of
    // waiting for the drawer's normal polling interval or a full page reload.
    const providerCaseId = getProviderCaseActivityId(notif);
    if (providerCaseId) {
      void queryClient.invalidateQueries({ queryKey: ["case", providerCaseId] });
    }

    if (!notif.readAt) {
      const now = new Date().toISOString();
      setNotificationItems((prev) =>
        prev.map((n) => (n.id === notif.id ? { ...n, readAt: now } : n))
      );
      setHasUnread((prev) => {
        if (!prev) return false;
        return notificationItems.some((n) => n.id !== notif.id && !n.readAt);
      });
      apiFetch(`/notifications/${notif.id}/read`, { method: "PATCH" }).catch(() => {/* ignore */});
    }

    // Always open the detail dialog so the user can read the full message.
    setSelectedNotif(notif);
  }

  function renderNavItem(item: NavItem, depth = 0) {
    if (item.billingOnly && !hasBillingLab) return null;
    if (item.recoveryBillingOnly && recoveryBillingAccessQuery.data?.available !== true) return null;
    if (item.labId && !(meQuery.data?.memberships ?? []).some((m) => m.status === "active" && m.organization?.id === item.labId && BILLING_ROLES.has(m.role))) return null;
    if (item.adminOnly && user?.role !== "admin") return null;
    if (item.ownerOnly && !(isCreator && isOwnerOfLab)) return null;
    if (item.creatorOnly && !isCreator) return null;
    // Case lists require an active lab membership.
    if (item.path === "/cases" && noActiveLabMembership) return null;
    // Messages page requires an active lab membership.
    if (item.path === "/messages" && noActiveLabMembership) return null;
    const active = navPathActive(item.path, location);
    const Icon = item.icon;
    const indent = depth > 0;
    const showBackupDot = backupOverdue && item.path === "/settings";
    const showDupBadge = item.path === "/accounts" && dupClusterCount > 0;
    const showMessengerDot = item.path === "/messages" && messengerUnreadCount > 0;
    const href = showDupBadge ? "/accounts?view=duplicates" : item.path;
    return (
      <li key={item.path}>
        <div className="flex items-center">
        <Link
          href={href}
          title={
            showBackupDot
              ? "Backup overdue — visit Settings → Backup"
              : showDupBadge
                ? `${dupClusterCount} possible duplicate doctor ${
                    dupClusterCount === 1 ? "group" : "groups"
                  } — review and merge`
                : showMessengerDot
                  ? `${messengerUnreadCount} unread message${messengerUnreadCount === 1 ? "" : "s"}`
                  : undefined
          }
          className={`flex flex-1 min-w-0 items-center gap-3 rounded-md text-sm font-medium transition-colors ${
            indent ? "py-1.5" : "px-3 py-2"
          } ${
            active
              ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
              : "text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          }`}
          style={indent ? { paddingLeft: 24 + depth * 12, paddingRight: 12 } : undefined}
        >
          <span className="relative shrink-0">
            <Icon size={indent ? 14 : 16} strokeWidth={2.2} />
          </span>
          <span className="flex-1">{item.label}</span>
          {showMessengerDot && (
            <span
              className="shrink-0 inline-flex items-center justify-center rounded-full bg-red-500 px-1.5 text-[10px] font-semibold leading-none text-white"
              style={{ minWidth: 18, height: 18 }}
              aria-label={`${messengerUnreadCount} unread message${messengerUnreadCount === 1 ? "" : "s"}`}
            >
              {messengerUnreadCount > 99 ? "99+" : messengerUnreadCount}
            </span>
          )}
          {showDupBadge && <DuplicateCountBadge count={dupClusterCount} />}
          {item.badge && (
            <span className="text-[10px] bg-sidebar-accent text-sidebar-accent-foreground px-1.5 py-0.5 rounded-full">
              {item.badge}
            </span>
          )}
          {showBackupDot && (
            <AlertTriangle
              size={13}
              className="shrink-0 text-amber-400"
              aria-label="Backup overdue"
            />
          )}
        </Link>
        {item.path === "/accounts" && (pendingRequestCount > 0 || requestCountError) && (
          <Link
            href={requestHref}
            aria-label={requestCountError ? "Request count unavailable — review requests" : `${pendingRequestCount} requests awaiting review`}
            title={requestCountError ? "Unable to refresh requests" : "Requests awaiting review"}
            className="mr-2 shrink-0 rounded-full bg-sky-600 px-2 py-1 text-[10px] font-semibold text-white hover:bg-sky-700"
          >
            Requests {pendingRequestCount > 99 ? "99+" : pendingRequestCount || "!"}
          </Link>
        )}
        </div>
      </li>
    );
  }

  function renderNavGroup(group: NavGroup, depth = 0) {
    if (group.billingOnly && !hasBillingLab) return null;
    if (group.adminOnly && user?.role !== "admin") return null;
    if (group.ownerOnly && !(isCreator && isOwnerOfLab)) return null;
    if (group.creatorOnly && !isCreator) return null;
    const open = openGroups[group.label] ?? groupContainsActive(group, location);
    const Icon = group.icon;
    const indent = depth > 0;
    const toggle = () =>
      setOpenGroups((prev) => ({ ...prev, [group.label]: !open }));
    const chevron = open ? (
      <ChevronDown size={14} className="shrink-0 opacity-60" />
    ) : (
      <ChevronRight size={14} className="shrink-0 opacity-60" />
    );
    const childList = open ? (
      <ul className="mt-0.5 space-y-0.5">
        {group.children.map((child) => renderNavNode(child, depth + 1))}
      </ul>
    ) : null;

    if (group.path) {
      const headerActive =
        navPathActive(group.path, location) ||
        (!open && groupContainsActive(group, location));
      const showBackupDot = backupOverdue && group.path === "/settings";
      const showGroupDupBadge =
        !open && dupClusterCount > 0 && groupContainsPath(group, "/accounts");
      return (
        <li key={group.label}>
          <div className="flex items-center gap-1">
            <Link
              href={group.path}
              title={showBackupDot ? "Backup overdue — visit Settings → Backup" : undefined}
              className={`flex flex-1 items-center gap-3 rounded-md text-sm font-medium transition-colors ${
                indent ? "py-1.5" : "px-3 py-2"
              } ${
                headerActive
                  ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
                  : "text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              }`}
              style={indent ? { paddingLeft: 24 + depth * 12 } : undefined}
            >
              <Icon size={indent ? 14 : 16} strokeWidth={2.2} />
              <span className="flex-1">{group.label}</span>
              {showGroupDupBadge && <DuplicateCountBadge count={dupClusterCount} />}
              {showBackupDot && (
                <AlertTriangle
                  size={13}
                  className="shrink-0 text-amber-400"
                  aria-label="Backup overdue"
                />
              )}
            </Link>
            {!open && groupContainsPath(group, "/accounts") && (pendingRequestCount > 0 || requestCountError) && (
              <Link
                href={requestHref}
                aria-label={requestCountError ? "Request count unavailable — review requests" : `${pendingRequestCount} requests awaiting review`}
                className="shrink-0 rounded-full bg-sky-600 px-2 py-1 text-[10px] font-semibold text-white hover:bg-sky-700"
              >
                Requests {pendingRequestCount > 99 ? "99+" : pendingRequestCount || "!"}
              </Link>
            )}
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              aria-label={open ? `Collapse ${group.label}` : `Expand ${group.label}`}
              className="shrink-0 rounded-md p-2 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              {chevron}
            </button>
          </div>
          {childList}
        </li>
      );
    }

    const headerActive = groupContainsActive(group, location) && !open;
    return (
      <li key={group.label}>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className={`w-full flex items-center gap-3 rounded-md text-sm font-medium transition-colors ${
            indent ? "py-1.5" : "px-3 py-2"
          } ${
            headerActive
              ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
              : "text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          }`}
          style={indent ? { paddingLeft: 24 + depth * 12, paddingRight: 12 } : undefined}
        >
          <Icon size={indent ? 14 : 16} strokeWidth={2.2} />
          <span className="flex-1 text-left">{group.label}</span>
          {chevron}
        </button>
        {childList}
      </li>
    );
  }

  function renderNavNode(node: NavItem | NavGroup, depth = 0) {
    return isGroup(node)
      ? renderNavGroup(node, depth)
      : renderNavItem(node, depth);
  }

  return (
    <AiPanelContext.Provider value={{ openPanel: openAiPanel }}>
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background text-foreground" data-testid="app-shell">
      {navOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/50 md:hidden"
          data-testid="nav-drawer-backdrop"
          onClick={() => setNavOpen(false)}
        />
      )}
      {/* Sidebar — fixed drawer below md, static column from md up */}
      <aside
        id="app-nav"
        data-testid="app-sidebar"
        data-open={navOpen}
        style={{ "--sidebar": "222 62% 12%", "--sidebar-primary": "217 82% 48%", "--sidebar-primary-foreground": "0 0% 100%" } as React.CSSProperties}
        className={`fixed inset-y-0 left-0 z-50 w-[240px] max-w-[85vw] md:static md:z-auto md:translate-x-0 ${location === "/" ? "md:w-[160px]" : ""} transition-transform duration-200 shrink-0 bg-sidebar text-sidebar-foreground flex flex-col border-r border-sidebar-border ${navOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="px-5 py-4 border-b border-sidebar-border flex items-center justify-between">
          <Logo size={34} variant="dark" />
          <button
            type="button"
            aria-label="Close navigation"
            data-testid="button-close-nav"
            className="md:hidden p-2 -mr-2 rounded-md hover:bg-sidebar-accent"
            onClick={() => setNavOpen(false)}
          >
            <X size={18} />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto py-3 px-3 scrollbar-thin">
          <div className="text-[10px] uppercase tracking-[0.2em] text-sidebar-foreground/45 px-3 py-2">
            Workspace
          </div>
          <ul className="space-y-0.5">
            {NAV.map((item) => renderNavNode(item, 0))}
          </ul>

          <div className="text-[10px] uppercase tracking-[0.2em] text-sidebar-foreground/45 px-3 pt-6 pb-2">
            System
          </div>
          <ul className="space-y-0.5">
            {SECONDARY.map((item) => renderNavNode(item, 0))}
          </ul>
        </nav>
        <div className="px-3 pb-3">
          {canReportLabIssue && <ReportIssueAction portal="lab" />}
          {!noActiveLabMembership && <FeedbackAction portal="lab" />}
          <a
            href="/"
            className="flex items-center gap-2 px-3 py-2 rounded-md text-xs text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <Wrench size={14} />
            Open mobile app
          </a>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-[60px] shrink-0 border-b border-border bg-card flex items-center gap-2 sm:gap-4 px-3 sm:px-6" data-testid="app-header">
          <button
            type="button"
            aria-label="Open navigation"
            aria-controls="app-nav"
            aria-expanded={navOpen}
            data-testid="button-open-nav"
            className="md:hidden h-10 w-10 inline-flex items-center justify-center rounded-md hover:bg-secondary"
            onClick={() => setNavOpen(true)}
          >
            <Menu size={20} />
          </button>
          <div className="flex-1 min-w-0 flex items-center gap-2">
            {headerLabName && (
              <span data-testid="text-header-lab-name" className="truncate text-sm font-semibold text-[#0f1f4a]">
                {headerLabName}
              </span>
            )}
            {isAdmin && <ScheduledBackupIndicator />}
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={() => setUploadsOpen((v) => !v)}
              disabled={!hasAnyUploads}
              className="relative h-9 px-2.5 rounded-md hover:bg-secondary flex items-center gap-1.5 text-muted-foreground disabled:opacity-50 disabled:cursor-default"
              aria-label={
                activeCount > 0
                  ? `${activeCount} upload${activeCount === 1 ? "" : "s"} in progress`
                  : "Uploads"
              }
            >
              {activeCount > 0 ? (
                <Loader2 size={16} className="animate-spin text-primary" />
              ) : errorCount > 0 || interruptedCount > 0 ? (
                <XCircle size={16} className="text-destructive" />
              ) : (
                <Upload size={16} />
              )}
              {hasAnyUploads && (
                <span className="text-xs font-medium tabular-nums">
                  {activeCount > 0 ? activeCount : entries.length}
                </span>
              )}
            </button>
            {uploadsOpen && hasAnyUploads && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setUploadsOpen(false)}
                />
                <div className="absolute right-0 top-[calc(100%+6px)] w-80 z-50 bg-card border border-border rounded-md shadow-lg text-sm overflow-hidden">
                  <div className="px-3 py-2 border-b border-border flex items-center justify-between">
                    <span className="font-medium text-xs">Uploads</span>
                    <span className="text-[11px] text-muted-foreground">
                      {activeCount > 0
                        ? `${activeCount} in progress`
                        : `${successCount} done${errorCount > 0 ? ` · ${errorCount} failed` : ""}${interruptedCount > 0 ? ` · ${interruptedCount} interrupted` : ""}`}
                    </span>
                  </div>
                  <ul className="max-h-72 overflow-y-auto scrollbar-thin">
                    {entries.map((entry) => {
                      const inFlight =
                        entry.status === "uploading" || entry.status === "queued";
                      return (
                        <li
                          key={entry.id}
                          className="flex items-start gap-2 px-3 py-2 border-b border-border last:border-b-0"
                        >
                          <div className="shrink-0 mt-0.5">
                            {inFlight ? (
                              <Upload size={14} className="text-primary" />
                            ) : entry.status === "success" ? (
                              <CheckCircle size={14} className="text-success" />
                            ) : (
                              <XCircle size={14} className="text-destructive" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <div className="text-xs font-medium truncate">
                                {entry.fileName}
                              </div>
                              {inFlight && (
                                <div className="text-[11px] tabular-nums text-muted-foreground shrink-0">
                                  {entry.progress}%
                                </div>
                              )}
                            </div>
                            {inFlight ? (
                              <div
                                role="progressbar"
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={entry.progress}
                                aria-label={`Upload progress for ${entry.fileName}`}
                                className="mt-1 h-1 w-full rounded-full bg-secondary overflow-hidden"
                              >
                                <div
                                  className="h-full bg-primary transition-[width] duration-150 ease-out"
                                  style={{ width: `${entry.progress}%` }}
                                />
                              </div>
                            ) : (
                              <div className="text-[11px] text-muted-foreground truncate">
                                {entry.status === "success"
                                  ? "Added to shared inbox"
                                  : entry.status === "interrupted"
                                    ? "Interrupted — re-pick file in inbox"
                                    : (entry.errorMessage ?? "Upload failed")}
                              </div>
                            )}
                          </div>
                          {inFlight ? (
                            <button
                              type="button"
                              onClick={() => cancelEntry(entry.id)}
                              className="shrink-0 mt-0.5 text-xs font-medium text-primary hover:underline focus:outline-none focus:ring-1 focus:ring-primary rounded-sm px-1"
                              aria-label={`Cancel upload of ${entry.fileName}`}
                            >
                              Cancel
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => removeEntry(entry.id)}
                              className="shrink-0 mt-0.5 text-muted-foreground hover:text-foreground"
                              aria-label={`Remove ${entry.fileName}`}
                            >
                              <XCircle size={13} />
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </>
            )}
          </div>

          {/* AI Assistant */}
          <button
            type="button"
            onClick={() => openAiPanel()}
            className={`relative h-9 w-9 rounded-md flex items-center justify-center transition-colors ${
              aiPanelOpen
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground"
            }`}
            aria-label="AI Assistant"
            title="AI Assistant"
          >
            <Sparkles size={17} />
          </button>

          {/* Notification Bell */}
          <div className="relative">
            <button
              type="button"
              onClick={notificationsOpen ? closeNotifications : openNotifications}
              className="relative h-9 w-9 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground"
              aria-label="Notifications"
            >
              <Bell size={17} />
              {hasUnread && (
                <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-destructive" />
              )}
            </button>
            {notificationsOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={closeNotifications}
                />
                <div className="absolute right-0 top-[calc(100%+6px)] w-80 z-50 bg-card border border-border rounded-md shadow-lg text-sm overflow-hidden">
                  <div className="px-3 py-2 border-b border-border flex items-center justify-between">
                    <span className="font-medium text-xs">Notifications</span>
                    {notifLoading && (
                      <Loader2 size={12} className="animate-spin text-muted-foreground" />
                    )}
                  </div>
                  {!notifLoading && notificationItems.length === 0 ? (
                    <div className="px-3 py-6 text-center text-muted-foreground text-xs">
                      No new alerts
                    </div>
                  ) : (
                    <ul className="max-h-80 overflow-y-auto scrollbar-thin divide-y divide-border">
                      {notificationItems.map((notif) => {
                        const dest = getNotificationDestination(notif);
                        return (
                          <li key={notif.id}>
                            <button
                              type="button"
                              onClick={() => handleNotificationClick(notif)}
                              className={`w-full text-left px-3 py-2.5 transition-colors cursor-pointer hover:bg-accent active:bg-accent/80 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary ${
                                !notif.readAt ? "bg-primary/5 hover:bg-primary/10" : ""
                              }`}
                            >
                              <div className="flex items-start gap-2">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    {!notif.readAt && (
                                      <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-primary mt-0.5" />
                                    )}
                                    <p className="text-xs font-medium leading-snug truncate">
                                      {notif.title}
                                    </p>
                                  </div>
                                  <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2 leading-snug">
                                    {notif.body}
                                  </p>
                                </div>
                                <div className="shrink-0 flex flex-col items-end gap-1 mt-0.5">
                                  <span className="text-[10px] text-muted-foreground/60 whitespace-nowrap">
                                    {relativeTime(notif.createdAt)}
                                  </span>
                                  {dest && (
                                    <ExternalLink size={11} className="text-muted-foreground/40" />
                                  )}
                                </div>
                              </div>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="flex items-center gap-2.5 pl-1.5 pr-2 py-1.5 rounded-md hover:bg-secondary"
            >
              <Avatar key={`${user?.id}:${avatarUrl ?? ""}`} className="h-8 w-8 bg-primary text-primary-foreground text-xs font-semibold">
                {avatarUrl && <AvatarImage src={avatarUrl} alt={`${fullName}'s profile photo`} className="object-cover" data-testid="img-profile-avatar" />}
                <AvatarFallback className="bg-primary text-primary-foreground" data-testid="text-profile-initials">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="hidden md:flex flex-col items-start leading-tight">
                <span className="text-sm font-medium">{fullName}</span>
                <span className="text-[11px] text-muted-foreground">
                  {role}
                  {user?.practiceName ? ` · ${user.practiceName}` : ""}
                </span>
              </div>
              <ChevronDown size={14} className="text-muted-foreground" />
            </button>
            {menuOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setMenuOpen(false)}
                />
                <div className="absolute right-0 top-[calc(100%+6px)] w-56 z-50 bg-card border border-border rounded-md shadow-lg py-1 text-sm">
                  <div className="px-3 py-2 border-b border-border">
                    <div className="font-medium">{fullName}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {user?.email || user?.username}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 hover:bg-secondary flex items-center gap-2 text-destructive"
                    onClick={async () => {
                      setMenuOpen(false);
                      await logout();
                    }}
                  >
                    <LogOut size={14} />
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </header>
        <UpdateBanner />
        {isAdmin && <BackupStalenessBanner view={backupFreshness} />}
        <main className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin">{children}</main>
      </div>
      {aiPanelOpen && (
        <AiChatPanel
          initialCases={aiPanelCases}
          labOrganizationId={user?.practiceOrganizationId}
          isAdmin={isAdmin}
          onClose={() => {
            setAiPanelOpen(false);
            setAiPanelCases([]);
          }}
        />
      )}

      {/* Notification detail dialog */}
      <Dialog open={!!selectedNotif} onOpenChange={(open) => { if (!open) setSelectedNotif(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base leading-snug pr-6">
              {selectedNotif?.title}
            </DialogTitle>
            <p className="text-[11px] text-muted-foreground pt-0.5">
              {selectedNotif ? relativeTime(selectedNotif.createdAt) : ""}
            </p>
          </DialogHeader>
          <p className="text-sm text-foreground/80 leading-relaxed whitespace-pre-wrap">
            {selectedNotif?.body}
          </p>
          {selectedNotif && getNotificationDestination(selectedNotif) && (
            <DialogFooter>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                onClick={() => {
                  const dest = getNotificationDestination(selectedNotif);
                  setSelectedNotif(null);
                  if (dest) setLocation(dest);
                }}
              >
                <ExternalLink size={14} />
                View
              </button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
    </AiPanelContext.Provider>
  );
}
