import {
  followManualBackup,
  type ManualBackupStatus,
  type DatabaseProtectionRetentionSchedule,
} from "@workspace/api-client-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useLocation, useSearch, Redirect } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowDown, ArrowUp, Ban, BookOpen, Calendar, CalendarOff, Check, ChevronDown, ChevronRight, Clock, Copy, CreditCard, Download, ExternalLink, FileDown, FileText, Github, History, KeyRound, LayoutList, Loader2, LogOut, Mail, Monitor, Pencil, Play, Plus, RotateCcw, RefreshCcw, Search, ShieldCheck, Smartphone, Sparkles, Trash2, Upload, User as UserIcon, UserMinus, UserPlus, Wrench, X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { apiFetch, apiFetchArrayBuffer, apiDownloadBackupToFolder, apiFetchDownloadResponse, readBoundedBackupBuffer, apiUploadWithProgress, ApiError, notifySessionCleared, createRestoreUploadSession, sendRestoreUploadChunk } from "@/lib/api";
import {
  executeLocalBackup,
  streamVerifiedBackupToWritable,
  verifyRequestedBackupHeaders,
  verifyStreamedBackup,
  watchBackupLiveStatus,
  type LocalBackupLiveStatus,
  type BrowserBackupSaveHandle,
} from "@/lib/local-backup-execution";
import {
  getScheduledLocalBackupProgress,
  subscribeScheduledLocalBackupProgress,
  backupLiveMediaText,
  backupLivePhaseLabel,
  backupLiveProgressText,
  formatBackupSize,
} from "@/lib/local-backup-progress";
import {
  applyManualBackupLiveStatus,
  getManualBackupProgress,
  loadManualBackupIdentity,
  resetManualBackupProgress,
  saveManualBackupIdentity,
  subscribeManualBackupProgress,
  updateManualBackupProgress,
} from "@/lib/manual-backup-progress";
import { toast } from "@/hooks/use-toast";
import { AuthedImage } from "@/components/AuthedMedia";
import { ProfilePhotoControl } from "@/components/ProfilePhotoControl";
import {
  DEFAULT_DUP_SIMILARITY_THRESHOLD,
  buildDuplicateClusters,
  resolveLabDupThreshold,
  type DoctorRow,
} from "@/pages/doctors";
import {
  DEFAULT_PRACTICE_DUP_SIMILARITY_THRESHOLD,
  buildPracticeDuplicateClusters,
} from "@/pages/practices";
import type { LabCase, Invoice, Organization } from "@/lib/types";
import { usePlatformAdminGate, PlatformAdminSetupNotice } from "@/lib/platform-admin-gate";
import { AdminSettingsPinGate, requiresAdminSettingsPin } from "@/lib/admin-settings-gate";
import { haltPollingIfForbidden, retryUnlessForbidden } from "@/lib/platform-admin-query";
import { getSessionSecret, clearSessionSecret, useSessionSecretVersion } from "@/lib/platform-admin-session";
import { formatPhone, formatDate, formatDateTime } from "@/lib/format";
import {
  computeShiftClickRange,
  shiftKeyFromChangeEvent,
  suppressShiftClickTextSelection,
} from "@/lib/shift-click-range";
import { useAuth } from "@/lib/auth-context";
import type { MeResponse } from "@/lib/types";
import { PracticeOwnershipAction } from "@/components/PracticeOwnershipAction";
import { InvoiceLayoutPanel } from "@/pages/invoice-layout-panel";
import { StatementLayoutPanel } from "@/pages/statement-layout-panel";
import { CorrespondenceLayoutPanel } from "@/pages/correspondence-layout-panel";
import { formatAccountNumberForDisplay } from "@workspace/account-number";
import { UpdateSettingsPanel } from "@/components/UpdateSettingsPanel";
import {
  formatBackupAge,
  type BackupAlertAttempt,
} from "@/components/BackupStalenessBanner";
import type { GoogleDriveBackupStatusResult } from "@workspace/api-client-react";

interface AdminUser {
  id: string;
  username: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  role?: string | null;
  isActive?: boolean;
  practiceName?: string | null;
  lastLoginAt?: string | null;
}
type TabKey = "profile" | "password" | "sessions" | "users" | "backup" | "mobile" | "itero" | "platform-admin" | "subscriptions" | "notifications" | "templates" | "statement-layout" | "statement-email" | "payment-receipt" | "card-authorization" | "autopay-authorization" | "correspondence-layout" | "invoice-layout" | "deleted-cases" | "deletion-audit" | "vocabulary" | "ai-assistant" | "doctor-practice-memory" | "closed-days" | "employee-hours" | "permission-outline" | "lab-preferences" | "updates";

// NOTE: "users" is intentionally omitted here so the old `?tab=users` deep link
// falls back to the default Profile section instead of opening the now-hidden
// Users panel. The "users" TabKey + UsersPanel are kept intact for easy restore.
// "desktop" is also omitted: the Settings → Desktop app section was removed in
// favour of the standalone /download page, so the stale deep link lands on Profile.
const VALID_TAB_KEYS: TabKey[] = ["profile", "password", "sessions", "backup", "mobile", "itero", "platform-admin", "subscriptions", "notifications", "templates", "statement-layout", "statement-email", "payment-receipt", "card-authorization", "autopay-authorization", "correspondence-layout", "invoice-layout", "deleted-cases", "deletion-audit", "vocabulary", "ai-assistant", "doctor-practice-memory", "closed-days", "employee-hours", "permission-outline", "lab-preferences", "updates"];

function hasDesktopUpdateBridge() {
  if (typeof window === "undefined") return false;
  const api = (window as Window & {
    electronAPI?: {
      getAppVersion?: unknown;
      getUpdateState?: unknown;
      checkForUpdates?: unknown;
      installUpdate?: unknown;
      onUpdateState?: unknown;
    };
  }).electronAPI;
  return Boolean(
    api?.getAppVersion &&
      api.getUpdateState &&
      api.checkForUpdates &&
      api.installUpdate &&
      api.onUpdateState,
  );
}

function readInitialTab(): TabKey {
  if (typeof window === "undefined") return "profile";
  try {
    const search = new URLSearchParams(window.location.search);
    const requested = search.get("tab") as TabKey | null;
    if (requested === "updates" && !hasDesktopUpdateBridge()) return "profile";
    if (requested && VALID_TAB_KEYS.includes(requested)) return requested;
  } catch {
    /* ignore */
  }
  return "profile";
}

export default function SettingsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  useSessionSecretVersion();
  const settingsPinUnlocked = !!getSessionSecret();
  const isOwner = user?.role === "owner";
  const backupMembershipsQuery = useQuery<MeResponse>({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch<MeResponse>("/auth/me"),
    enabled: !!user,
    staleTime: 60_000,
  });
  const canManageScopedBackup = (backupMembershipsQuery.data?.memberships ?? []).some((membership) =>
    membership.status === "active" &&
    (membership.role === "owner" || membership.role === "admin") &&
    membership.organization?.type === "lab" &&
    membership.organization.isActive === true &&
    !membership.organization.deletedAt,
  );
  const canAccessBackup = isAdmin || canManageScopedBackup;
  // `parentKey` builds the nav tree. It nests up to two levels deep:
  // Lab Preferences → Templates → Invoice layout.
  // `groupOnly` marks a parent that has no panel of its own, so clicking it
  // selects its first child instead of rendering an empty pane.
  const tabs: Array<{ key: TabKey; label: string; icon: typeof UserIcon; show: boolean; parentKey?: TabKey; groupOnly?: boolean }> = [
    { key: "profile", label: "Profile", icon: UserIcon, show: true },
    { key: "updates", label: "Software updates", icon: Download, show: hasDesktopUpdateBridge() },
    { key: "password", label: "Password", icon: KeyRound, show: true, parentKey: "profile" },
    { key: "sessions", label: "Active sessions", icon: Monitor, show: true, parentKey: "profile" },
    { key: "notifications", label: "Notifications", icon: Monitor, show: true, parentKey: "profile" },
    { key: "lab-preferences", label: "Lab Preferences", icon: Wrench, show: true },
    // Hidden from navigation: customers live in Customer Center and the internal
    // lab team lives under Profile → Lab team status. Set back to `isAdmin` to restore.
    { key: "users", label: "Users", icon: ShieldCheck, show: false },
    { key: "backup", label: "Backup", icon: ShieldCheck, show: canAccessBackup, parentKey: "lab-preferences" },
    { key: "vocabulary", label: "Lab Catalog", icon: BookOpen, show: isAdmin, parentKey: "lab-preferences" },
    { key: "doctor-practice-memory", label: "Remembered doctor practices", icon: Sparkles, show: isAdmin, parentKey: "lab-preferences" },
    { key: "closed-days", label: "Closed Days", icon: CalendarOff, show: isAdmin, parentKey: "lab-preferences" },
    { key: "permission-outline", label: "Permission Outline", icon: ShieldCheck, show: isAdmin || isOwner, parentKey: "lab-preferences" },
    { key: "templates", label: "Templates", icon: LayoutList, show: isAdmin, parentKey: "lab-preferences", groupOnly: true },
    { key: "invoice-layout", label: "Invoice layout", icon: LayoutList, show: isAdmin, parentKey: "templates" },
    { key: "statement-layout", label: "Statement layout", icon: LayoutList, show: isAdmin, parentKey: "templates" },
    { key: "statement-email", label: "Statement email", icon: Mail, show: isAdmin, parentKey: "templates" },
    { key: "payment-receipt", label: "Payment receipt", icon: Mail, show: isAdmin, parentKey: "templates" },
    { key: "card-authorization", label: "Card on File authorization", icon: FileText, show: isAdmin, parentKey: "templates" },
    { key: "autopay-authorization", label: "Auto-Pay authorization", icon: FileText, show: isAdmin, parentKey: "templates" },
    { key: "correspondence-layout", label: "Correspondence layout", icon: LayoutList, show: isAdmin, parentKey: "templates" },
    { key: "deleted-cases", label: "Deleted Cases", icon: Trash2, show: isAdmin },
    { key: "deletion-audit", label: "Deletion Audit Log", icon: History, show: isAdmin },
    { key: "ai-assistant", label: "AI Assistant", icon: Sparkles, show: isAdmin },
    { key: "employee-hours", label: "Employee Hours", icon: Calendar, show: isAdmin },
    { key: "mobile", label: "Mobile app", icon: Smartphone, show: isAdmin },
    { key: "itero", label: "iTero auto-import", icon: Sparkles, show: isAdmin && typeof window !== "undefined" && !!(window as { electronAPI?: { itero?: unknown } }).electronAPI?.itero },
    { key: "platform-admin", label: "Platform admin", icon: Wrench, show: isAdmin },
    { key: "subscriptions", label: "Subscriptions", icon: CreditCard, show: false },
  ];
  const [tab, setTab] = useState<TabKey>(readInitialTab);

  const backupScheduleQuery = useQuery<{ lastSuccessfulBackupAt?: string | null; staleAfterDays?: number }>({
    enabled: isAdmin && settingsPinUnlocked,
    queryKey: ["admin", "backup-schedule-v2"],
    queryFn: () => apiFetch("/admin/backup/schedule"),
    retry: retryUnlessForbidden,
    staleTime: 5 * 60 * 1000,
  });
  const backupOverdue = isAdmin && backupScheduleQuery.isSuccess && (() => {
    const last = backupScheduleQuery.data?.lastSuccessfulBackupAt;
    if (!last) return true;
    const t = new Date(last).getTime();
    const staleDays = backupScheduleQuery.data?.staleAfterDays ?? 7;
    return Number.isNaN(t) ? true : Date.now() - t > staleDays * 24 * 60 * 60 * 1000;
  })();

  type TabDef = (typeof tabs)[number];
  const childrenOf = (key: TabKey): TabDef[] => tabs.filter((c) => c.show && c.parentKey === key);
  // True when this entry, or anything nested beneath it, is the selected tab.
  // Drives which ancestor groups stay expanded + highlighted.
  const subtreeActive = (key: TabKey): boolean =>
    tab === key || childrenOf(key).some((c) => subtreeActive(c.key));
  // Backup lives under Lab Preferences now, so surface the overdue warning on
  // the parent too — otherwise it is invisible while the group is collapsed.
  const showsBackupWarning = (key: TabKey) =>
    !!backupOverdue && (key === "backup" || (key === "lab-preferences" && !subtreeActive("lab-preferences")));

  function renderNavEntry(t: TabDef, depth: number) {
    const Icon = t.icon;
    const children = childrenOf(t.key);
    const active = tab === t.key;
    const descendantActive = children.some((c) => subtreeActive(c.key));
    const expanded = children.length > 0 && (active || descendantActive);
    const warn = showsBackupWarning(t.key);
    return (
      <li key={t.key}>
        <button
          type="button"
          onClick={() => setTab(t.groupOnly && children.length > 0 ? children[0].key : t.key)}
          aria-expanded={children.length > 0 ? expanded : undefined}
          title={warn ? "Backup overdue — check backup settings" : undefined}
          className={
            depth === 0
              ? `w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  active
                    ? "bg-primary/10 text-primary"
                    : descendantActive
                      ? "text-foreground"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                }`
              : `w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  active
                    ? "bg-primary/10 text-primary"
                    : descendantActive
                      ? "text-foreground"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                }`
          }
        >
          {depth === 0 && <Icon size={14} />}
          <span className="flex-1 text-left">{t.label}</span>
          {warn && (
            <AlertTriangle size={13} className="shrink-0 text-amber-400" aria-label="Backup overdue" />
          )}
        </button>
        {expanded && (
          <ul className="mt-0.5 ml-3 border-l border-border/50 space-y-0.5 pl-2">
            {children.map((c) => renderNavEntry(c, depth + 1))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <div className={`${tab === "backup" ? "px-4 sm:px-8" : "px-8"} py-7 max-w-[1100px] mx-auto`}>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Admin Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your profile, password, and lab workspace.
        </p>
      </div>

      <div
        className={tab === "backup"
          ? "flex min-w-0 flex-col gap-4 md:flex-row md:gap-6"
          : "flex gap-6"}
        data-testid="settings-layout"
      >
        <nav className={tab === "backup" ? "w-full min-w-0 md:w-48 md:shrink-0" : "w-48 shrink-0"}>
          <ul className="space-y-1">
            {tabs.filter((t) => t.show && !t.parentKey).map((t) => renderNavEntry(t, 0))}
          </ul>
        </nav>
        <div className="flex-1 min-w-0 bg-card border border-border rounded-xl">
          {requiresAdminSettingsPin(tab, isAdmin) && !settingsPinUnlocked ? (
            <AdminSettingsPinGate />
          ) : (
          <>
          {tab === "profile" && <ProfilePanel />}
          {tab === "updates" && <UpdateSettingsPanel />}
          {tab === "password" && <PasswordPanel />}
          {tab === "sessions" && <SessionsPanel />}
          {tab === "users" && isAdmin && <UsersPanel />}
          {tab === "backup" && canAccessBackup && <BackupPanel labOnly={!isAdmin} />}
          {tab === "invoice-layout" && isAdmin && <InvoiceLayoutPanel />}
          {tab === "statement-layout" && isAdmin && <StatementLayoutPanel />}
          {tab === "statement-email" && isAdmin && <StatementEmailPanel />}
          {tab === "payment-receipt" && isAdmin && <PaymentReceiptTemplatePanel />}
          {tab === "card-authorization" && isAdmin && <AuthorizationTemplatePanel templateType="card_on_file" />}
          {tab === "autopay-authorization" && isAdmin && <AuthorizationTemplatePanel templateType="autopay" />}
          {tab === "correspondence-layout" && isAdmin && <CorrespondenceLayoutPanel />}
          {tab === "mobile" && isAdmin && <MobileBuildPanel />}
          {tab === "itero" && isAdmin && <IteroPanel />}
          {tab === "platform-admin" && isAdmin && (
            <PlatformAdminPanel
            />
          )}
          {tab === "subscriptions" && <Redirect to="/creator?tab=subscriptions" />}
          {tab === "notifications" && <NotificationsPanel isAdmin={isAdmin} />}
          {tab === "lab-preferences" && <LabPreferencesPanel />}
          {tab === "deleted-cases" && isAdmin && <DeletedCasesPanel />}
          {tab === "deletion-audit" && isAdmin && <DeletionAuditPanel />}
          {tab === "vocabulary" && isAdmin && <VocabularyPanel />}
          {tab === "ai-assistant" && isAdmin && <AiAssistantPanel />}
          {tab === "doctor-practice-memory" && isAdmin && <DoctorPracticeMemoryPanel />}
          {tab === "closed-days" && isAdmin && <ClosedDaysPanel />}
          {tab === "employee-hours" && isAdmin && <EmployeeHoursPanel />}
          {tab === "permission-outline" && (isAdmin || isOwner) && <PermissionOutlinePanel />}
          </>
          )}
        </div>
      </div>
    </div>
  );
}

// Work-status presence values used by the API. UI labels them as
// "At work" / "On break" / "On lunch" / "Out of office".
const WORK_STATUS_OPTIONS: Array<{
  value: "available" | "break" | "lunch" | "out_of_office";
  label: string;
  dot: string;
}> = [
  { value: "available", label: "At work", dot: "bg-emerald-500" },
  { value: "break", label: "On break", dot: "bg-amber-500" },
  { value: "lunch", label: "On lunch", dot: "bg-orange-500" },
  { value: "out_of_office", label: "Out of office", dot: "bg-slate-400" },
];

function workStatusMeta(status: string | null | undefined) {
  return (
    WORK_STATUS_OPTIONS.find((s) => s.value === status) ??
    WORK_STATUS_OPTIONS[0]
  );
}

interface LabTeamMember {
  id: string;
  username: string;
  firstName?: string | null;
  lastName?: string | null;
  initials?: string | null;
  email?: string | null;
  phone?: string | null;
  role?: string | null;
  membershipId?: string | null;
  isOwner?: boolean;
  workStatus: string;
  labNames: string[];
  isSelf: boolean;
  status?: string | null;
}

interface InviteEmailDelivery {
  sent: boolean;
  status: "sent" | "failed" | "skipped";
  reason?: string | null;
}

interface PendingInvite {
  id: string;
  email: string | null;
  roleToAssign: string | null;
  createdAt: string | Date | null;
  expiresAt: string | Date | null;
  lastEmailAttemptAt?: string | Date | null;
  lastEmailStatus?: string | null;
  lastEmailError?: string | null;
}

/**
 * Message shown when the mail server rejected the SMTP login (reason
 * `auth_failed`) — actionable, unlike the generic "failed to send".
 */
export const SMTP_AUTH_FAILED_MESSAGE =
  "Email provider rejected the login — update the SMTP credentials in Secrets.";

/** Human-readable label for a failed/skipped invite email delivery. */
export function inviteDeliveryProblem(
  inv: Pick<PendingInvite, "lastEmailStatus" | "lastEmailError">
): string | null {
  if (inv.lastEmailStatus === "failed") {
    if (inv.lastEmailError === "recipient_opted_out") {
      return "Recipient opted out of invite emails";
    }
    if (inv.lastEmailError === "auth_failed") {
      return SMTP_AUTH_FAILED_MESSAGE;
    }
    return "Invite email failed to send";
  }
  if (inv.lastEmailStatus === "skipped") {
    return "Email skipped — recipient opted out";
  }
  return null;
}

interface PendingJoinRequest {
  id: string;
  organizationId: string;
  labName: string | null;
  // "lab" for lab join requests, "provider" for practice join requests
  // (providers asking to join an existing practice during sign-up).
  organizationType?: string | null;
  requestedByUserId: string;
  requestedRole: string | null;
  message: string | null;
  createdAt: string | Date | null;
  requesterName: string | null;
  requesterUsername: string | null;
  requesterEmail: string | null;
}

const LOGO_PLACEMENT_OPTIONS = [
  { key: "invoices", label: "Invoices", desc: "Show logo on invoice PDFs sent to practices" },
  { key: "statements", label: "Statements", desc: "Show logo on monthly billing statement PDFs" },
  { key: "emails", label: "General emails", desc: "Include logo in outgoing email headers" },
  { key: "welcome_emails", label: "Invite & welcome emails", desc: "Show logo in team invitation emails" },
  { key: "payment_receipts", label: "Payment receipts", desc: "Show logo in payment confirmation emails" },
  { key: "case_exports", label: "Case export PDFs", desc: "Show logo on work order and case summary exports" },
  { key: "quotes", label: "Quotes & estimates", desc: "Show logo on quote documents" },
  { key: "sms", label: "SMS (text messages)", desc: "Include logo reference in text notifications" },
] as const;

function ProfilePanel() {
  const { user, refresh } = useAuth();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const requestSearch = useSearch();
  const highlightedRequestId = new URLSearchParams(requestSearch).get("joinRequestId");
  const [firstName, setFirstName] = useState(user?.firstName ?? "");
  const [lastName, setLastName] = useState(user?.lastName ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [practiceName, setPracticeName] = useState(user?.practiceName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [showPlacementsModal, setShowPlacementsModal] = useState(false);
  const [placementsSelection, setPlacementsSelection] = useState<string[]>([]);
  const [placementsError, setPlacementsError] = useState<string | null>(null);
  const profileTopRef = useRef<HTMLDivElement | null>(null);

  const [labDueDays, setLabDueDays] = useState("");
  const [labDueDaysSaved, setLabDueDaysSaved] = useState(false);
  const [labInvoiceDay, setLabInvoiceDay] = useState("");
  const [labInvoiceDaySaved, setLabInvoiceDaySaved] = useState(false);
  const [labRevenueLow, setLabRevenueLow] = useState("");
  const [labRevenueHigh, setLabRevenueHigh] = useState("");
  const [labRevenueSaved, setLabRevenueSaved] = useState(false);

  const [phoneVerifyStep, setPhoneVerifyStep] = useState<"idle" | "sending" | "otp">("idle");
  const [resending, setResending] = useState(false);
  const [phoneBeingVerified, setPhoneBeingVerified] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpError, setOtpError] = useState<string | null>(null);
  const [smsUnavailable, setSmsUnavailable] = useState(false);
  const [resendCountdown, setResendCountdown] = useState(0);
  const resendTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (resendTimerRef.current) clearInterval(resendTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setFirstName(user?.firstName ?? "");
    setLastName(user?.lastName ?? "");
    setEmail(user?.email ?? "");
    setPhone(user?.phone ?? "");
    setPracticeName(user?.practiceName ?? "");
    setPhoneVerifyStep("idle");
    setOtpCode("");
    setOtpError(null);
  }, [user?.id]);

  const isPhoneVerified = !!(
    user?.phoneVerifiedAt &&
    user?.phone &&
    phone.trim() !== "" &&
    phone === user.phone
  );

  function startResendTimer(seconds = 60) {
    setResendCountdown(seconds);
    if (resendTimerRef.current) clearInterval(resendTimerRef.current);
    resendTimerRef.current = setInterval(() => {
      setResendCountdown((c) => {
        if (c <= 1) {
          clearInterval(resendTimerRef.current!);
          resendTimerRef.current = null;
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }

  async function handleSendVerificationCode() {
    const phoneToVerify = phone.trim();
    if (!phoneToVerify || !user?.id) return;

    const isResend = phoneVerifyStep === "otp";

    if (isResend) {
      setResending(true);
    } else {
      setPhoneVerifyStep("sending");
    }
    setOtpError(null);

    try {
      if (!isResend && phone !== (user?.phone ?? "")) {
        await apiFetch(`/auth/users/${user.id}/profile`, {
          method: "PUT",
          body: JSON.stringify({ firstName, lastName, email, phone, practiceName }),
        });
        await refresh();
      }
      // phoneToVerify is the canonical trimmed value sent to the API; store it in
      // state so the OTP panel displays the exact number that was passed to the provider.
      await apiFetch("/send-phone-code", {
        method: "POST",
        body: JSON.stringify({ phone: phoneToVerify }),
      });
      setPhoneBeingVerified(phoneToVerify);
      if (isResend) {
        setResending(false);
        setOtpCode("");
        startResendTimer();
      } else {
        setPhoneVerifyStep("otp");
        setOtpCode("");
        startResendTimer();
      }
    } catch (err: unknown) {
      const msg = (err as Error).message || "Failed to send verification code.";
      const is503 = err instanceof ApiError && err.status === 503 && msg.toLowerCase().includes("sms delivery");
      const is429 = err instanceof ApiError && err.status === 429;
      if (is503) {
        setSmsUnavailable(true);
        setOtpError(null);
      } else if (is429) {
        const waitSecs = (err as ApiError).retryAfter ?? 30;
        startResendTimer(waitSecs);
        setOtpError(null);
      } else {
        setOtpError(msg);
      }
      if (isResend) {
        setResending(false);
      } else {
        setPhoneVerifyStep("idle");
      }
    }
  }

  async function handleVerifyOtp() {
    setOtpError(null);
    try {
      const result = await apiFetch<{ verified: boolean; error?: string }>("/verify-phone-code", {
        method: "POST",
        body: JSON.stringify({ phone: phone.trim(), code: otpCode }),
      });
      if (!result.verified) {
        setOtpError(result.error || "Incorrect code. Please try again.");
        return;
      }
      setPhoneVerifyStep("idle");
      setOtpCode("");
      if (resendTimerRef.current) {
        clearInterval(resendTimerRef.current);
        resendTimerRef.current = null;
      }
      await refresh();
    } catch (err: unknown) {
      setOtpError((err as Error).message || "Verification failed. Please try again.");
    }
  }

  function cancelPhoneVerify() {
    setPhoneVerifyStep("idle");
    setResending(false);
    setPhoneBeingVerified("");
    setOtpCode("");
    setOtpError(null);
    setSmsUnavailable(false);
    if (resendTimerRef.current) {
      clearInterval(resendTimerRef.current);
      resendTimerRef.current = null;
    }
  }

  const mutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error("Not signed in.");
      return apiFetch(`/auth/users/${user.id}/profile`, {
        method: "PUT",
        body: JSON.stringify({
          firstName,
          lastName,
          email,
          phone,
          practiceName,
        }),
      });
    },
    onSuccess: async () => {
      setSuccess(true);
      setError(null);
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      profileTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      const phoneChanged = phone !== (user?.phone ?? "");
      await refresh();
      setTimeout(() => setSuccess(false), 2500);
      // If the phone number changed, auto-start the SMS verification flow so
      // the admin can verify the new number without a separate "Verify" click.
      if (phoneChanged && phone.trim()) {
        const phoneToVerify = phone.trim();
        setPhoneVerifyStep("sending");
        setOtpError(null);
        try {
          await apiFetch("/send-phone-code", {
            method: "POST",
            body: JSON.stringify({ phone: phoneToVerify }),
          });
          setPhoneBeingVerified(phoneToVerify);
          setPhoneVerifyStep("otp");
          setOtpCode("");
          startResendTimer();
        } catch (err: unknown) {
          const msg = (err as Error).message || "Failed to send verification code.";
          const is503 = err instanceof ApiError && err.status === 503 && msg.toLowerCase().includes("sms delivery");
          if (is503) {
            setSmsUnavailable(true);
          } else {
            setOtpError(msg);
          }
          setPhoneVerifyStep("idle");
        }
      }
    },
    onError: (err: Error) => {
      setSuccess(false);
      setError(err.message || "Could not save profile.");
    },
  });

  const isLabAdmin =
    user?.role === "admin" || user?.role === "owner";

  // Non-admin/owner lab members can view their own custom permission grants.
  const selfPermissionsQuery = useQuery<{
    membershipId: string;
    permissions: { id: string; name: string; description?: string | null; capabilityKey: string }[];
  }>({
    queryKey: ["self-permissions", user?.practiceOrganizationId],
    queryFn: () =>
      apiFetch(`/organizations/${user!.practiceOrganizationId}/members/self/permissions`),
    enabled: !isLabAdmin && !!user?.practiceOrganizationId,
    staleTime: 60_000,
  });

  const labOrgQuery = useQuery<{ id: string; defaultCaseDueDays?: number | null; invoiceDueDayOfMonth?: number | null; revenueTargetLow?: number | null; revenueTargetHigh?: number | null }>({
    queryKey: ["lab-org-settings", user?.practiceOrganizationId],
    queryFn: () => apiFetch(`/organizations/${user!.practiceOrganizationId}`),
    enabled: !!(user?.practiceOrganizationId) && isLabAdmin,
  });

  useEffect(() => {
    if (labOrgQuery.data) {
      setLabDueDays(
        labOrgQuery.data.defaultCaseDueDays != null
          ? String(labOrgQuery.data.defaultCaseDueDays)
          : ""
      );
      setLabInvoiceDay(
        labOrgQuery.data.invoiceDueDayOfMonth != null
          ? String(labOrgQuery.data.invoiceDueDayOfMonth)
          : ""
      );
      setLabRevenueLow(
        labOrgQuery.data.revenueTargetLow != null
          ? String(labOrgQuery.data.revenueTargetLow)
          : ""
      );
      setLabRevenueHigh(
        labOrgQuery.data.revenueTargetHigh != null
          ? String(labOrgQuery.data.revenueTargetHigh)
          : ""
      );
    }
  }, [labOrgQuery.data?.defaultCaseDueDays, labOrgQuery.data?.invoiceDueDayOfMonth, labOrgQuery.data?.revenueTargetLow, labOrgQuery.data?.revenueTargetHigh]);

  const labDueDaysMutation = useMutation({
    mutationFn: (days: number | null) =>
      apiFetch(`/organizations/${user!.practiceOrganizationId}`, {
        method: "PATCH",
        body: JSON.stringify({ defaultCaseDueDays: days }),
      }),
    onSuccess: () => {
      setLabDueDaysSaved(true);
      void queryClient.invalidateQueries({ queryKey: ["lab-org-settings", user?.practiceOrganizationId] });
      setTimeout(() => setLabDueDaysSaved(false), 2000);
    },
    onError: (err: Error) => {
      toast({ title: "Could not save turnaround", description: err.message, variant: "destructive", duration: 4000 });
    },
  });

  const labInvoiceDayMutation = useMutation({
    mutationFn: (day: number | null) =>
      apiFetch(`/organizations/${user!.practiceOrganizationId}`, {
        method: "PATCH",
        body: JSON.stringify({ invoiceDueDayOfMonth: day }),
      }),
    onSuccess: () => {
      setLabInvoiceDaySaved(true);
      void queryClient.invalidateQueries({ queryKey: ["lab-org-settings", user?.practiceOrganizationId] });
      setTimeout(() => setLabInvoiceDaySaved(false), 2000);
    },
    onError: (err: Error) => {
      toast({ title: "Could not save invoice due day", description: err.message, variant: "destructive", duration: 4000 });
    },
  });

  const labRevenueMutation = useMutation({
    mutationFn: (values: { revenueTargetLow: number | null; revenueTargetHigh: number | null }) =>
      apiFetch(`/organizations/${user!.practiceOrganizationId}`, {
        method: "PATCH",
        body: JSON.stringify(values),
      }),
    onSuccess: () => {
      setLabRevenueSaved(true);
      void queryClient.invalidateQueries({ queryKey: ["lab-org-settings", user?.practiceOrganizationId] });
      setTimeout(() => setLabRevenueSaved(false), 2000);
    },
    onError: (err: Error) => {
      toast({ title: "Could not save revenue targets", description: err.message, variant: "destructive", duration: 4000 });
    },
  });

  // Status selector — fires on click, no Save needed. Other lab
  // teammates see the new status the next time they re-fetch.
  const statusMutation = useMutation({
    mutationFn: async (next: (typeof WORK_STATUS_OPTIONS)[number]["value"]) => {
      return apiFetch(`/auth/me/status`, {
        method: "PATCH",
        body: JSON.stringify({ workStatus: next }),
      });
    },
    onSuccess: async () => {
      await refresh();
      void queryClient.invalidateQueries({ queryKey: ["lab-team"] });
    },
  });

  const teamQuery = useQuery<{ team: LabTeamMember[]; callerRole: string | null; pendingInvites: PendingInvite[]; pendingJoinRequests?: PendingJoinRequest[] }>({
    queryKey: ["lab-team"],
    queryFn: () => apiFetch("/auth/lab-team"),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (!highlightedRequestId) return;
    const row = document.getElementById(`join-request-${highlightedRequestId}`);
    row?.scrollIntoView({ behavior: "smooth", block: "center" });
    row?.focus({ preventScroll: true });
  }, [highlightedRequestId, teamQuery.data]);

  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"user" | "billing" | "admin">("user");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState(false);
  const [existingInviteId, setExistingInviteId] = useState<string | null>(null);
  const [confirmRemoveMemberId, setConfirmRemoveMemberId] = useState<string | null>(null);
  const [confirmRemoveName, setConfirmRemoveName] = useState<string>("");
  const [transferTarget, setTransferTarget] = useState<{ membershipId: string; name: string } | null>(null);
  const [transferPhrase, setTransferPhrase] = useState("");

  const isTeamAdmin =
    teamQuery.data?.callerRole === "admin" ||
    teamQuery.data?.callerRole === "owner";

  const inviteMutation = useMutation({
    mutationFn: async () => {
      if (!user?.practiceOrganizationId) throw new Error("No lab linked.");
      return apiFetch<{ emailDelivery?: InviteEmailDelivery }>(
        `/organizations/${user.practiceOrganizationId}/invites`,
        {
          method: "POST",
          body: JSON.stringify({ email: inviteEmail, roleToAssign: inviteRole }),
        }
      );
    },
    onSuccess: (created) => {
      setInviteSuccess(true);
      setInviteError(null);
      setInviteEmail("");
      setInviteRole("user");
      void queryClient.invalidateQueries({ queryKey: ["lab-team"] });
      const delivery = created?.emailDelivery;
      if (delivery && !delivery.sent) {
        if (delivery.status === "skipped") {
          toast({
            title: "Invite saved — email not sent",
            description: `${inviteEmail} has opted out of invite emails. Share the invite with them directly.`,
            variant: "destructive",
            duration: 8000,
          });
        } else if (delivery.reason === "auth_failed") {
          toast({
            title: "Invite saved, but the email could not be sent",
            description: SMTP_AUTH_FAILED_MESSAGE,
            variant: "destructive",
            duration: 8000,
          });
        } else {
          toast({
            title: "Invite saved, but the email could not be sent",
            description: `The invite for ${inviteEmail} was created, but the email failed to send. Use Resend to try again.`,
            variant: "destructive",
            duration: 8000,
          });
        }
      } else {
        toast({ title: "Invite sent", description: `An invite was sent to ${inviteEmail}.`, duration: 4000 });
      }
      setTimeout(() => {
        setInviteSuccess(false);
        setShowInviteModal(false);
      }, 1800);
    },
    onError: (err: Error) => {
      const message = err.message || "Could not send invite.";
      if (err instanceof ApiError && err.status === 409) {
        // A pending invite already exists — find it in the current list so we
        // can offer a one-tap resend instead of a dead-end error.
        const existing = (teamQuery.data?.pendingInvites ?? []).find(
          (inv) => inv.email?.toLowerCase() === inviteEmail.toLowerCase().trim()
        );
        if (existing) {
          setExistingInviteId(existing.id);
          setInviteError("A pending invite already exists for this email address. Resend it instead?");
          return;
        }
      }
      setInviteError(message);
      setExistingInviteId(null);
    },
  });

  const resendInviteMutation = useMutation({
    mutationFn: async (inviteId: string) => {
      return apiFetch<{
        id: string;
        email: string | null;
        emailDelivery?: InviteEmailDelivery;
      }>(`/organizations/invites/${inviteId}/resend`, {
        method: "POST",
      });
    },
    // Resend is non-fatal: it returns 200 with an `emailDelivery` outcome even
    // when the email fails or is skipped. Read that outcome here and render a
    // truthful state instead of treating a non-delivery as a thrown error.
    onSuccess: (invite) => {
      setInviteSuccess(true);
      setInviteError(null);
      setInviteEmail("");
      setInviteRole("user");
      void queryClient.invalidateQueries({ queryKey: ["lab-team"] });
      const to = invite.email ?? "that address";
      const delivery = invite?.emailDelivery;
      if (delivery && !delivery.sent) {
        if (delivery.status === "skipped") {
          toast({
            title: "Invite link refreshed — email not sent",
            description: `${to} has opted out of invite emails. Share the invite with them directly.`,
            variant: "destructive",
            duration: 8000,
          });
        } else if (delivery.reason === "auth_failed") {
          toast({
            title: "Invite link refreshed, but the email was not sent",
            description: SMTP_AUTH_FAILED_MESSAGE,
            variant: "destructive",
            duration: 8000,
          });
        } else {
          toast({
            title: "Invite link refreshed, but the email was not sent",
            description: `The invite for ${to} was refreshed, but the email failed to send. Try again or contact them directly.`,
            variant: "destructive",
            duration: 8000,
          });
        }
      } else {
        toast({ title: "Invite resent", description: `An invite was resent to ${to}.`, duration: 4000 });
      }
      setTimeout(() => {
        setInviteSuccess(false);
        setShowInviteModal(false);
      }, 1800);
    },
    onError: (err: Error) => {
      const message = err.message || "Could not resend invite.";
      setInviteError(message);
      // The resend button also lives on the pending-invite list (outside the
      // modal), so surface the failure as a toast too.
      toast({
        title: "Invite email not sent",
        description: message,
        variant: "destructive",
        duration: 8000,
      });
      void queryClient.invalidateQueries({ queryKey: ["lab-team"] });
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: async (membershipId: string) => {
      return apiFetch(`/organizations/memberships/${membershipId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      const name = confirmRemoveName;
      setConfirmRemoveMemberId(null);
      void queryClient.invalidateQueries({ queryKey: ["lab-team"] });
      toast({ title: "Member removed", description: name ? `${name} has been removed from the lab.` : "Member removed from the lab.", duration: 4000 });
    },
  });

  const revokeInviteMutation = useMutation({
    mutationFn: async (inviteId: string) => {
      return apiFetch(`/organizations/invites/${inviteId}/cancel`, {
        method: "POST",
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["lab-team"] });
      toast({ title: "Invite revoked", duration: 3000 });
    },
  });

  const approveJoinRequestMutation = useMutation({
    mutationFn: async (joinRequestId: string) => {
      return apiFetch(`/organizations/join-requests/${joinRequestId}/approve`, {
        method: "POST",
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["lab-team"] });
      toast({ title: "Request approved", description: "They now have access to the lab.", duration: 4000 });
    },
    onError: (err: Error) => {
      toast({ title: "Could not approve request", description: err.message, variant: "destructive", duration: 4000 });
    },
  });

  const rejectJoinRequestMutation = useMutation({
    mutationFn: async (joinRequestId: string) => {
      return apiFetch(`/organizations/join-requests/${joinRequestId}/reject`, {
        method: "POST",
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["lab-team"] });
      toast({ title: "Request declined", duration: 3000 });
    },
    onError: (err: Error) => {
      toast({ title: "Could not decline request", description: err.message, variant: "destructive", duration: 4000 });
    },
  });

  const changeRoleMutation = useMutation({
    mutationFn: async ({ membershipId, role }: { membershipId: string; role: string }) => {
      return apiFetch(`/organizations/memberships/${membershipId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["lab-team"] });
      toast({ title: "Role updated", duration: 3000 });
    },
    onError: (err: Error) => {
      toast({ title: "Could not update role", description: err.message, variant: "destructive", duration: 4000 });
    },
  });

  const suspendMutation = useMutation({
    mutationFn: async ({ membershipId, status }: { membershipId: string; status: "active" | "suspended" }) => {
      return apiFetch(`/organizations/memberships/${membershipId}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
    },
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: ["lab-team"] });
      toast({ title: vars.status === "suspended" ? "Member suspended" : "Member reactivated", duration: 3000 });
    },
    onError: (err: Error) => {
      toast({ title: "Could not update member status", description: err.message, variant: "destructive", duration: 4000 });
    },
  });

  const transferOwnershipMutation = useMutation({
    mutationFn: async ({ targetMembershipId }: { targetMembershipId: string }) => {
      const target = teamQuery.data?.team.find((m) => m.membershipId === targetMembershipId && m.status === "active");
      if (!target || !user?.practiceOrganizationId) throw new Error("Select an active member of this organization.");
      await apiFetch("/owner/transfer-ownership", {
        method: "POST",
        body: JSON.stringify({
          organizationId: user.practiceOrganizationId,
          newOwnerUserId: target.id,
          confirmationPhrase: transferPhrase,
        }),
      });
    },
    onSuccess: () => {
      setTransferTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["lab-team"] });
      void queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      void queryClient.invalidateQueries({ queryKey: ["owner"] });
      void refresh().catch(() => toast({ title: "Ownership transferred", description: "Roles could not refresh. Reload to see your confirmed access.", duration: 5000 }));
      toast({ title: "Ownership transferred", duration: 4000 });
    },
    onError: (err: Error) => {
      toast({ title: "Could not transfer ownership", description: err.message, variant: "destructive", duration: 4000 });
    },
  });

  // ── Member-permissions sheet (owner views / revokes per-member grants) ─────
  const memberPermSheetOrgId = user?.practiceOrganizationId ?? "";
  const isCallerOwnerForSheet = teamQuery.data?.callerRole === "owner";

  const [memberPermSheetTarget, setMemberPermSheetTarget] = useState<{
    membershipId: string;
    name: string;
  } | null>(null);

  const memberPermDefsQuery = useQuery<PermissionDef[]>({
    queryKey: ["permission-definitions", memberPermSheetOrgId],
    queryFn: () =>
      apiFetch<PermissionDef[]>(
        `/organizations/${memberPermSheetOrgId}/permission-definitions`
      ),
    enabled: isCallerOwnerForSheet && !!memberPermSheetOrgId,
    staleTime: 30_000,
  });

  const memberPermGrantsQuery = useQuery<MemberPermissionGrants>({
    queryKey: [
      "member-permissions",
      memberPermSheetOrgId,
      memberPermSheetTarget?.membershipId,
    ],
    queryFn: () =>
      apiFetch<MemberPermissionGrants>(
        `/organizations/${memberPermSheetOrgId}/members/${memberPermSheetTarget!.membershipId}/permissions`
      ),
    enabled: !!memberPermSheetTarget?.membershipId && !!memberPermSheetOrgId,
    staleTime: 0,
  });

  const revokePermMutation = useMutation({
    mutationFn: ({ membershipId, defId }: { membershipId: string; defId: string }) =>
      apiFetch(
        `/organizations/${memberPermSheetOrgId}/members/${membershipId}/permissions/${defId}`,
        { method: "DELETE" }
      ),
    onSuccess: (_, { membershipId }) => {
      void queryClient.invalidateQueries({
        queryKey: ["member-permissions", memberPermSheetOrgId, membershipId],
      });
      toast({ title: "Permission revoked", duration: 3000 });
    },
    onError: (e: Error) =>
      toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  // ──────────────────────────────────────────────────────────────────────────

  const placementsMutation = useMutation({
    mutationFn: async (placements: string[]) => {
      if (!user?.practiceOrganizationId) throw new Error("No lab organization linked.");
      return apiFetch(
        `/organizations/${user.practiceOrganizationId}/logo-placements`,
        { method: "PATCH", body: JSON.stringify({ placements }) }
      );
    },
    onSuccess: async () => {
      setPlacementsError(null);
      await refresh();
      setShowPlacementsModal(false);
    },
    onError: (err: Error) => {
      setPlacementsError(err.message || "Could not save logo placement preferences.");
    },
  });

  const logoSizeMutation = useMutation({
    mutationFn: async (size: "small" | "medium" | "large") => {
      if (!user?.practiceOrganizationId) throw new Error("No lab organization linked.");
      const allPlacements = user?.practiceLogoplacements ?? ["invoices","statements","sms","emails","case_exports","quotes","welcome_emails","payment_receipts"];
      return apiFetch(
        `/organizations/${user.practiceOrganizationId}/logo-placements`,
        { method: "PATCH", body: JSON.stringify({ placements: allPlacements, logoPdfSize: size }) }
      );
    },
    onSuccess: async () => {
      await refresh();
    },
  });

  async function handleLogoFile(file: File) {
    setLogoError(null);
    if (!user?.practiceOrganizationId) {
      setLogoError("No lab organization linked to your profile yet.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setLogoError("Logo must be 5 MB or smaller.");
      return;
    }
    setLogoUploading(true);
    // Guard the upload with a hard timeout/abort. The XHR-based uploader
    // (apiUploadWithProgress) always fires a terminal event — onload / onerror
    // / onabort — so the "Uploading…" state can never spin forever the way a
    // hung fetch() can. The timeout abort covers the remaining case where the
    // request stalls at the proxy with no response at all.
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 60_000);
    try {
      const fd = new FormData();
      fd.append("file", file);
      await apiUploadWithProgress(
        `/organizations/${user.practiceOrganizationId}/logo`,
        fd,
        { signal: controller.signal },
      );
      // Pull the freshly-stamped practiceLogoUrl (with its new ?v= cache
      // buster) so the preview and downstream documents pick up the replacement
      // without a manual reload. refresh() is bounded by the refresh-token
      // timeout in api.ts, so it can't hang the uploading state.
      await refresh();
    } catch (err) {
      setLogoError(
        timedOut
          ? "The upload timed out. Check your connection and try again."
          : err instanceof ApiError
          ? (err.body as any)?.error || err.message
          : (err as Error).message || "Could not upload logo.",
      );
    } finally {
      clearTimeout(timeout);
      setLogoUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const currentStatus = workStatusMeta(user?.workStatus);

  return (
    <>
    <PanelShell title="Profile" subtitle="Your personal info shown across LabTrax.">
      <div ref={profileTopRef} data-testid="profile-panel-top" />
      {error && <Alert tone="danger">{error}</Alert>}
      {success && <Alert tone="success">Profile saved.</Alert>}

      {/* Lab logo */}
      <ProfilePhotoControl />
      <div className="rounded-lg border border-border bg-secondary/20 p-4 mb-2">
        <div className="flex items-center gap-4">
          <div className="w-20 h-20 rounded-lg bg-background border border-border overflow-hidden flex items-center justify-center text-xs text-muted-foreground">
            {user?.practiceLogoUrl ? (
              // The logo endpoint is bearer-auth-gated, so a plain <img> can't
              // authenticate from the cross-origin Electron renderer (and is
              // fragile after a session change). AuthedImage fetches it with the
              // access token and renders the result via an object URL. The ?v=
              // cache buster in practiceLogoUrl changes on every replace, so the
              // new logo is re-fetched automatically.
              <AuthedImage
                url={user.practiceLogoUrl}
                alt="Lab logo"
                className="max-w-full max-h-full object-contain"
              />
            ) : (
              "No logo"
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold">Lab logo</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Shown on invoices, statements, and the desktop header. PNG,
              JPG, SVG, or WebP, up to 5 MB.
            </p>
            {logoError && (
              <p className="text-xs text-destructive mt-1">{logoError}</p>
            )}
            <div className="mt-2 flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleLogoFile(f);
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={logoUploading || !user?.practiceOrganizationId}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-60"
              >
                <Upload size={12} />
                {logoUploading
                  ? "Uploading…"
                  : user?.practiceLogoUrl
                  ? "Replace logo"
                  : "Add a logo"}
              </button>
              <button
                type="button"
                onClick={() => {
                  const allPlacements = ["invoices","statements","sms","emails","case_exports","quotes","welcome_emails","payment_receipts"];
                  setPlacementsSelection(
                    user?.practiceLogoplacements ??
                    (user?.practiceLogoUrl ? allPlacements : [])
                  );
                  setPlacementsError(null);
                  setShowPlacementsModal(true);
                }}
                disabled={!user?.practiceLogoUrl || !user?.practiceOrganizationId}
                title={!user?.practiceLogoUrl ? "Upload a logo first to set placement preferences" : "Choose where the lab logo appears"}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-input bg-background text-xs font-semibold hover:bg-secondary disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <LayoutList size={12} />
                Add logo to documents
              </button>
            </div>
            {user?.practiceLogoUrl && (
              <div className="mt-3 flex items-center gap-2">
                <span className="text-xs text-muted-foreground">PDF logo size:</span>
                {(["small", "medium", "large"] as const).map((size) => {
                  const active = (user?.practiceLogoSize ?? "medium") === size;
                  return (
                    <button
                      key={size}
                      type="button"
                      onClick={() => logoSizeMutation.mutate(size)}
                      disabled={logoSizeMutation.isPending || !user?.practiceOrganizationId}
                      className={`h-7 px-3 rounded-md text-xs font-medium border transition-colors disabled:opacity-60 capitalize ${
                        active
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background border-input hover:bg-secondary"
                      }`}
                    >
                      {size}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Status pills */}
      <div className="rounded-lg border border-border bg-secondary/20 p-4 mb-2">
        <div className="flex items-center justify-between mb-2">
          <div>
            <div className="text-sm font-semibold">Status</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Visible to everyone in your lab.
            </p>
          </div>
          <div className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${currentStatus.dot}`} />
            {currentStatus.label}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {WORK_STATUS_OPTIONS.map((opt) => {
            const active = (user?.workStatus ?? "available") === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => statusMutation.mutate(opt.value)}
                disabled={statusMutation.isPending}
                className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-medium border transition-colors disabled:opacity-60 ${
                  active
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background border-input hover:bg-secondary"
                }`}
              >
                <span className={`w-2 h-2 rounded-full ${opt.dot}`} />
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Editable profile fields */}
      <div className="grid grid-cols-2 gap-4">
        <Field label="First name">
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Last name">
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Email">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Phone">
          <div className="space-y-1.5">
            <input
              type="tel"
              value={phone}
              onChange={(e) => {
                const newVal = formatPhone(e.target.value);
                setPhone(newVal);
                setSmsUnavailable(false);
                if (phoneVerifyStep !== "idle" && newVal !== phone) cancelPhoneVerify();
              }}
              placeholder="000-000-0000"
              className={inputCls}
            />
            {phone.trim() && (
              <div className="space-y-1">
                <div className="flex items-center gap-2 min-h-[20px]">
                  {isPhoneVerified ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                      <Check size={12} />
                      Verified
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleSendVerificationCode()}
                      disabled={phoneVerifyStep === "sending" || phoneVerifyStep === "otp" || resendCountdown > 0}
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 disabled:opacity-60 transition-colors"
                    >
                      {phoneVerifyStep === "sending" ? (
                        <><Loader2 size={12} className="animate-spin" />Sending…</>
                      ) : phoneVerifyStep === "otp" ? (
                        "Verify"
                      ) : resendCountdown > 0 ? (
                        `Try again in ${resendCountdown}s`
                      ) : (
                        "Verify"
                      )}
                    </button>
                  )}
                </div>
                {phoneVerifyStep === "idle" && smsUnavailable && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 px-3 py-2 flex items-start gap-2 mt-1">
                    <AlertTriangle size={13} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                    <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                      Phone verification is not available on this server — SMS delivery has not been configured. Contact your platform administrator to enable it.
                    </p>
                  </div>
                )}
                {phoneVerifyStep === "idle" && !smsUnavailable && otpError && (
                  <p className="text-xs text-destructive">{otpError}</p>
                )}
              </div>
            )}
          </div>
        </Field>
        {(user?.role === "admin" || user?.role === "owner") && phone.trim() && !isPhoneVerified && !smsUnavailable && (
          <div className="col-span-2">
            <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 px-3 py-2.5 flex items-start gap-2.5">
              <AlertTriangle size={15} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                Your phone number isn&apos;t verified yet. Verify it to receive SMS notifications. Click <strong>Verify</strong> above to complete verification.
              </p>
            </div>
          </div>
        )}
        {phoneVerifyStep === "otp" && (
          <div className="col-span-2">
            <div className="rounded-lg border border-border bg-secondary/20 p-4">
              <p className="text-sm font-medium mb-1">Enter verification code</p>
              <p className="text-xs text-muted-foreground mb-3">
                We sent a 6-digit code to {phoneBeingVerified}. Enter it below to verify your number.
              </p>
              {otpError && (
                <p className="text-xs text-destructive mb-2">{otpError}</p>
              )}
              <div className="flex items-center gap-3 flex-wrap">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  onKeyDown={(e) => { if (e.key === "Enter" && otpCode.length === 6) void handleVerifyOtp(); }}
                  placeholder="000000"
                  className={`${inputCls} w-28 font-mono tracking-widest text-center`}
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => void handleVerifyOtp()}
                  disabled={otpCode.length < 6}
                  className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => void handleSendVerificationCode()}
                  disabled={resendCountdown > 0 || resending}
                  className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1"
                >
                  {resending ? (
                    <><Loader2 size={12} className="animate-spin" />Sending…</>
                  ) : resendCountdown > 0 ? (
                    `Resend in ${resendCountdown}s`
                  ) : (
                    "Resend code"
                  )}
                </button>
                <button
                  type="button"
                  onClick={cancelPhoneVerify}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors ml-auto"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
        <Field label="Practice / lab name" full>
          <input value={practiceName} onChange={(e) => setPracticeName(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Username">
          <input value={user?.username ?? ""} disabled className={`${inputCls} bg-secondary/40 text-muted-foreground cursor-not-allowed`} />
        </Field>
        <Field label="Role">
          <input value={user?.role ?? ""} disabled className={`${inputCls} bg-secondary/40 text-muted-foreground cursor-not-allowed capitalize`} />
        </Field>
        {user?.platformAccountNumber && (
          <Field label="Account number">
            <input value={formatAccountNumberForDisplay(user.platformAccountNumber)} disabled className={`${inputCls} bg-secondary/40 text-muted-foreground cursor-not-allowed font-mono`} />
          </Field>
        )}
      </div>
      <div className="flex justify-end pt-1">
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
          className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
        >
          {mutation.isPending ? "Saving…" : "Save profile"}
        </button>
      </div>

      {/* ── Security status summary ─────────────────────────────────────
          Shows the account's phone-verification state in plain language.
          There is no authenticator-app / TOTP two-factor feature — LabTrax
          uses phone (SMS) verification only. This card is the canonical
          reference that keeps the desktop settings consistent with the web
          app's representation of security state.
      ────────────────────────────────────────────────────────────────── */}
      <div
        className="rounded-lg border border-border bg-secondary/20 p-4 mt-4"
        data-testid="security-status-card"
      >
        <div className="text-sm font-semibold mb-2">Security</div>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Phone verification</span>
            {isPhoneVerified ? (
              <span
                className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600"
                data-testid="phone-verified-badge"
              >
                <Check size={12} />
                Verified
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1 text-xs font-medium text-amber-600"
                data-testid="phone-not-verified-badge"
              >
                <AlertTriangle size={12} />
                {user?.phone ? "Not verified" : "No phone on file"}
              </span>
            )}
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Active sign-ins</span>
            <button
              type="button"
              onClick={() => {
                try {
                  const event = new CustomEvent("labtrax:settings:nav", { detail: "sessions" });
                  window.dispatchEvent(event);
                } catch { /* ignore */ }
              }}
              className="text-xs text-primary hover:text-primary/80 transition-colors"
              data-testid="view-sessions-link"
            >
              View sessions →
            </button>
          </div>
        </div>
      </div>

      {/* Lab defaults — admin / owner of a lab org only */}
      {isLabAdmin && user?.practiceOrganizationId && (
        <div className="mt-6">
          <div className="mb-2">
            <h2 className="text-base font-semibold tracking-tight">Lab defaults</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Defaults applied when creating cases and invoices for this lab.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-secondary/20 p-4 space-y-4">
            {/* Case turnaround */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium">Case turnaround (days)</label>
                {labDueDaysSaved && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                    <Check size={11} />
                    Saved
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mb-2">
                Days after the created date to set as due date on new cases. Leave blank for no default.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={labDueDays}
                  onChange={(e) => setLabDueDays(e.target.value)}
                  placeholder="e.g. 7"
                  className="h-8 w-24 px-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <span className="text-xs text-muted-foreground">days</span>
                <button
                  type="button"
                  onClick={() => {
                    const val = labDueDays.trim();
                    const num = val === "" ? null : parseInt(val, 10);
                    if (num !== null && (isNaN(num) || num < 1 || num > 365)) return;
                    labDueDaysMutation.mutate(num);
                  }}
                  disabled={labDueDaysMutation.isPending}
                  className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-60"
                >
                  {labDueDaysMutation.isPending ? "Saving…" : "Save"}
                </button>
              </div>
            </div>

            {/* Invoice due day of month */}
            <div className="pt-3 border-t border-border">
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium">Invoice due day of month</label>
                {labInvoiceDaySaved && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                    <Check size={11} />
                    Saved
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mb-2">
                Day of the month (1–28) on which new invoices become due. Leave blank to use the default (10th).
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={28}
                  value={labInvoiceDay}
                  onChange={(e) => setLabInvoiceDay(e.target.value)}
                  placeholder="e.g. 10"
                  className="h-8 w-24 px-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <span className="text-xs text-muted-foreground">of month</span>
                <button
                  type="button"
                  onClick={() => {
                    const val = labInvoiceDay.trim();
                    const num = val === "" ? null : parseInt(val, 10);
                    if (num !== null && (isNaN(num) || num < 1 || num > 28)) return;
                    labInvoiceDayMutation.mutate(num);
                  }}
                  disabled={labInvoiceDayMutation.isPending}
                  className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-60"
                >
                  {labInvoiceDayMutation.isPending ? "Saving…" : "Save"}
                </button>
              </div>
            </div>

            {/* Revenue targets */}
            <div className="pt-3 border-t border-border">
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium">Monthly revenue targets</label>
                {labRevenueSaved && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                    <Check size={11} />
                    Saved
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mb-2">
                Monthly revenue thresholds for the red/yellow/green chart coloring. Leave blank to use the defaults ($85k / $95k).
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: "#eab308" }} />
                  <span className="text-xs text-muted-foreground">Low ($)</span>
                  <input
                    type="number"
                    min={0}
                    value={labRevenueLow}
                    onChange={(e) => setLabRevenueLow(e.target.value)}
                    placeholder="85000"
                    data-testid="revenue-target-low-input"
                    className="h-8 w-28 px-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: "#22c55e" }} />
                  <span className="text-xs text-muted-foreground">High ($)</span>
                  <input
                    type="number"
                    min={0}
                    value={labRevenueHigh}
                    onChange={(e) => setLabRevenueHigh(e.target.value)}
                    placeholder="95000"
                    data-testid="revenue-target-high-input"
                    className="h-8 w-28 px-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <button
                  type="button"
                  data-testid="revenue-target-save-btn"
                  onClick={() => {
                    const lo = labRevenueLow.trim();
                    const hi = labRevenueHigh.trim();
                    const numLo = lo === "" ? null : parseInt(lo, 10);
                    const numHi = hi === "" ? null : parseInt(hi, 10);
                    if (numLo !== null && (isNaN(numLo) || numLo < 0)) return;
                    if (numHi !== null && (isNaN(numHi) || numHi < 0)) return;
                    if (numLo !== null && numHi !== null && numLo >= numHi) return;
                    labRevenueMutation.mutate({ revenueTargetLow: numLo, revenueTargetHigh: numHi });
                  }}
                  disabled={labRevenueMutation.isPending}
                  className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-60"
                >
                  {labRevenueMutation.isPending ? "Saving…" : "Save"}
                </button>
              </div>
              {(() => {
                const lo = labRevenueLow.trim();
                const hi = labRevenueHigh.trim();
                const numLo = lo === "" ? null : parseInt(lo, 10);
                const numHi = hi === "" ? null : parseInt(hi, 10);
                if (numLo !== null && numHi !== null && !isNaN(numLo) && !isNaN(numHi) && numLo >= numHi) {
                  return (
                    <p className="mt-1 text-xs text-destructive">
                      Low threshold must be less than the high threshold.
                    </p>
                  );
                }
                return null;
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Current lab / environment name — sourced from the signed-in member's
          lab from the lab-team data, falling back to the profile practice name,
          then a neutral label. */}
      <div className="mt-6 mb-1">
        <PracticeOwnershipAction
          preferredOrganizationId={user?.practiceOrganizationId}
          onTransfer={(organizationId) => navigate(`/owner?transferOnly=1&organizationId=${encodeURIComponent(organizationId)}`)}
        />
        <h2 className="text-base font-semibold tracking-tight">
          {(teamQuery.data?.team.find((m) => m.isSelf)?.labNames?.[0]?.trim()
            || user?.practiceName?.trim()
            || "Lab")}{" "}Environment
        </h2>
      </div>

      {/* Team status list */}
      <div className="rounded-lg border border-border mt-2">
        <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
          <div className="text-sm font-semibold">Lab team status</div>
          <div className="flex items-center gap-3">
            <div className="text-xs text-muted-foreground">
              {teamQuery.data?.team.length ?? 0} member
              {(teamQuery.data?.team.length ?? 0) === 1 ? "" : "s"}
            </div>
            {isTeamAdmin && (
              <button
                type="button"
                onClick={() => {
                  setInviteEmail("");
                  setInviteRole("user");
                  setInviteError(null);
                  setInviteSuccess(false);
                  setExistingInviteId(null);
                  setShowInviteModal(true);
                }}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
              >
                <UserPlus className="w-3.5 h-3.5" />
                Invite member
              </button>
            )}
          </div>
        </div>
        <ul className="divide-y divide-border">
          {teamQuery.isLoading && (
            <li className="px-4 py-3 text-xs text-muted-foreground">Loading…</li>
          )}
          {teamQuery.data?.team.map((m) => {
            const meta = workStatusMeta(m.workStatus);
            const name =
              [m.firstName, m.lastName].filter(Boolean).join(" ") || m.username;
            const isSuspended = m.status === "suspended";
            const isCallerOwner = teamQuery.data?.callerRole === "owner";
            const canChangeRole =
              isTeamAdmin &&
              !m.isSelf &&
              !!m.membershipId &&
              !(m.isOwner && !isCallerOwner);
            const canSuspend =
              isTeamAdmin && !m.isSelf && !m.isOwner && !!m.membershipId;
            const canRemove =
              isTeamAdmin && !m.isSelf && !m.isOwner && m.membershipId;
            return (
              <li
                key={m.id}
                className={`px-4 py-2.5 flex items-center justify-between text-sm${isSuspended ? " opacity-60" : ""}`}
              >
                <div className="min-w-0">
                  <div className="font-medium truncate flex items-center gap-1.5">
                    {name}
                    {m.isSelf && (
                      <span className="text-xs text-muted-foreground font-normal">(you)</span>
                    )}
                    {isSuspended && (
                      <span className="text-xs text-amber-600 font-medium">suspended</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
                    {canChangeRole ? (
                      <select
                        value={m.role ?? "user"}
                        onChange={(e) => {
                          const newRole = e.target.value;
                          if (newRole === "owner") {
                            setTransferPhrase("");
                            setTransferTarget({ membershipId: m.membershipId!, name });
                          } else {
                            changeRoleMutation.mutate({ membershipId: m.membershipId!, role: newRole });
                          }
                        }}
                        disabled={changeRoleMutation.isPending || transferOwnershipMutation.isPending}
                        className="h-5 text-xs border border-border rounded px-1 bg-background text-foreground cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                      >
                        {isCallerOwner && m.status === "active" && <option value="owner">Owner</option>}
                        <option value="admin">Admin</option>
                        <option value="billing">Billing</option>
                        <option value="user">User</option>
                        <option value="read_only">Read-Only</option>
                      </select>
                    ) : (
                      <span className="capitalize">{(m.role ?? "user").replace("_", " ")}</span>
                    )}
                    {m.email && <span className="text-muted-foreground/60">· {m.email}</span>}
                  </div>
                </div>
                <div className="inline-flex items-center gap-2 shrink-0 ml-3">
                  {!isSuspended && (
                    <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
                      {meta.label}
                    </div>
                  )}
                  {isCallerOwner && !m.isOwner && !!m.membershipId && (
                    <button
                      type="button"
                      onClick={() =>
                        setMemberPermSheetTarget({
                          membershipId: m.membershipId!,
                          name,
                        })
                      }
                      title="View permissions"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {canSuspend && (
                    <button
                      type="button"
                      onClick={() =>
                        suspendMutation.mutate({
                          membershipId: m.membershipId!,
                          status: isSuspended ? "active" : "suspended",
                        })
                      }
                      disabled={suspendMutation.isPending}
                      title={isSuspended ? `Reactivate ${name}` : `Suspend ${name}`}
                      className="text-muted-foreground hover:text-amber-600 transition-colors disabled:opacity-50"
                    >
                      {isSuspended ? (
                        <UserPlus className="w-3.5 h-3.5" />
                      ) : (
                        <UserMinus className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}
                  {canRemove && (
                    confirmRemoveMemberId === m.membershipId ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">Remove?</span>
                        <button
                          type="button"
                          onClick={() => removeMemberMutation.mutate(m.membershipId!)}
                          disabled={removeMemberMutation.isPending}
                          className="text-xs font-medium text-destructive hover:text-destructive/80 disabled:opacity-50"
                        >
                          Yes
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRemoveMemberId(null)}
                          className="text-xs text-muted-foreground hover:text-foreground"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmRemoveMemberId(m.membershipId!);
                          setConfirmRemoveName(name);
                        }}
                        title={`Remove ${name} from the lab`}
                        className="text-muted-foreground hover:text-destructive transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )
                  )}
                </div>
              </li>
            );
          })}
          {/* Pending invites */}
          {isTeamAdmin && (teamQuery.data?.pendingInvites ?? []).map((inv) => (
            <li
              key={inv.id}
              className="px-4 py-2.5 flex items-center justify-between text-sm"
            >
              <div className="min-w-0">
                <div className="font-medium truncate text-muted-foreground">
                  {inv.email ?? "—"}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {inv.roleToAssign || "user"} · <span className="text-amber-500 font-medium">Pending invite</span>
                </div>
                {inviteDeliveryProblem(inv) && (
                  <div
                    className="text-xs text-destructive truncate"
                    title={
                      inv.lastEmailAttemptAt
                        ? `Last attempt: ${formatDateTime(String(inv.lastEmailAttemptAt))}`
                        : undefined
                    }
                  >
                    {inviteDeliveryProblem(inv)}
                  </div>
                )}
              </div>
              <div className="inline-flex items-center gap-3 shrink-0">
                <button
                  type="button"
                  onClick={() => resendInviteMutation.mutate(inv.id)}
                  disabled={resendInviteMutation.isPending || revokeInviteMutation.isPending}
                  title="Resend invite email"
                  className="text-xs text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
                >
                  <Mail className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => revokeInviteMutation.mutate(inv.id)}
                  disabled={revokeInviteMutation.isPending || resendInviteMutation.isPending}
                  title="Revoke invite"
                  className="text-xs text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </li>
          ))}
          {/* Pending join requests (self-serve requests from waiting users) */}
          {isTeamAdmin && (teamQuery.data?.pendingJoinRequests ?? []).map((reqItem) => {
            const requesterLabel =
              reqItem.requesterName || reqItem.requesterUsername || "Someone";
            const isPracticeRequest = reqItem.organizationType === "provider";
            return (
              <li
                key={reqItem.id}
                id={`join-request-${reqItem.id}`}
                tabIndex={-1}
                className={`px-4 py-2.5 flex items-center justify-between text-sm ${highlightedRequestId === reqItem.id ? "bg-sky-500/10 ring-2 ring-inset ring-sky-500" : ""}`}
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">{requesterLabel}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {reqItem.requestedRole || "user"} ·{" "}
                    <span className="text-sky-500 font-medium">
                      {isPracticeRequest
                        ? `Wants to join practice${reqItem.labName ? ` ${reqItem.labName}` : ""}`
                        : "Wants to join"}
                    </span>
                    {reqItem.requesterEmail && (
                      <span className="text-muted-foreground/60"> · {reqItem.requesterEmail}</span>
                    )}
                  </div>
                </div>
                <div className="inline-flex items-center gap-2 shrink-0 ml-3">
                  <button
                    type="button"
                    onClick={() => approveJoinRequestMutation.mutate(reqItem.id)}
                    disabled={
                      approveJoinRequestMutation.isPending ||
                      rejectJoinRequestMutation.isPending
                    }
                    className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 hover:text-emerald-500 transition-colors disabled:opacity-50"
                  >
                    <Check className="w-3.5 h-3.5" />
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => rejectJoinRequestMutation.mutate(reqItem.id)}
                    disabled={
                      approveJoinRequestMutation.isPending ||
                      rejectJoinRequestMutation.isPending
                    }
                    title="Decline request"
                    className="text-xs text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </li>
            );
          })}
          {!teamQuery.isLoading &&
            (teamQuery.data?.team.length ?? 0) === 0 &&
            (teamQuery.data?.pendingInvites?.length ?? 0) === 0 &&
            (teamQuery.data?.pendingJoinRequests?.length ?? 0) === 0 && (
              <li className="px-4 py-3 text-xs text-muted-foreground">
                No teammates found.
              </li>
            )}
        </ul>
      </div>

      {/* My Permissions — shown to non-admin/non-owner lab members only */}
      {!isLabAdmin && !!user?.practiceOrganizationId && (
        <div className="mt-6">
          <div className="mb-2">
            <h2 className="text-base font-semibold tracking-tight">My permissions</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Custom capabilities your lab owner has granted to your account.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-secondary/20 p-4">
            {selfPermissionsQuery.isLoading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 size={12} className="animate-spin" />
                Loading…
              </div>
            )}
            {selfPermissionsQuery.isError && (
              <p className="text-xs text-destructive">Could not load your permissions.</p>
            )}
            {selfPermissionsQuery.isSuccess && (
              selfPermissionsQuery.data.permissions.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No custom permissions assigned to your account.
                </p>
              ) : (
                <ul className="space-y-2">
                  {selfPermissionsQuery.data.permissions.map((perm) => (
                    <li key={perm.id} className="flex items-start gap-2">
                      <ShieldCheck size={13} className="text-primary mt-0.5 shrink-0" />
                      <div>
                        <div className="text-sm font-medium leading-tight">{perm.name}</div>
                        {perm.description && (
                          <div className="text-xs text-muted-foreground mt-0.5">{perm.description}</div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )
            )}
          </div>
        </div>
      )}

      {/* Member permissions sheet — owner views & revokes individual grants */}
      <Sheet
        open={!!memberPermSheetTarget}
        onOpenChange={(open) => {
          if (!open) setMemberPermSheetTarget(null);
        }}
      >
        <SheetContent side="right" className="w-[360px]">
          <SheetHeader>
            <SheetTitle className="text-base">
              Permissions — {memberPermSheetTarget?.name}
            </SheetTitle>
            <SheetDescription className="text-xs">
              Custom capabilities granted to this team member. Click{" "}
              <strong>Revoke</strong> to remove an individual permission. Full
              editing is available in the Permission Outline settings tab.
            </SheetDescription>
          </SheetHeader>
          <div className="mt-5 space-y-3">
            {(memberPermGrantsQuery.isLoading ||
              memberPermDefsQuery.isLoading) && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 size={12} className="animate-spin" />
                Loading…
              </div>
            )}
            {memberPermGrantsQuery.isSuccess &&
              memberPermDefsQuery.isSuccess &&
              (() => {
                const grantedIds = new Set(
                  memberPermGrantsQuery.data?.permissionDefinitionIds ?? []
                );
                const grantedDefs = (memberPermDefsQuery.data ?? []).filter(
                  (d) => grantedIds.has(d.id)
                );
                return grantedDefs.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">
                    No custom permissions assigned to this member.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {grantedDefs.map((def) => (
                      <li
                        key={def.id}
                        className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2.5"
                      >
                        <div className="flex items-start gap-2 min-w-0">
                          <ShieldCheck
                            size={13}
                            className="text-primary mt-0.5 shrink-0"
                          />
                          <div className="min-w-0">
                            <p className="text-sm font-medium leading-tight truncate">
                              {def.name}
                            </p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {CAPABILITY_LABELS_DESKTOP[def.capabilityKey] ??
                                def.capabilityKey}
                            </p>
                            {def.description && (
                              <p className="text-xs text-muted-foreground/70 mt-0.5 truncate">
                                {def.description}
                              </p>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            revokePermMutation.mutate({
                              membershipId:
                                memberPermSheetTarget!.membershipId,
                              defId: def.id,
                            })
                          }
                          disabled={revokePermMutation.isPending}
                          title={`Revoke "${def.name}"`}
                          className="shrink-0 text-xs font-medium text-destructive hover:text-destructive/80 disabled:opacity-50 transition-colors"
                        >
                          Revoke
                        </button>
                      </li>
                    ))}
                  </ul>
                );
              })()}
          </div>
        </SheetContent>
      </Sheet>

      {/* Invite member modal */}
      {showInviteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setShowInviteModal(false)}
        >
          <div
            className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-sm mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b border-border flex items-center justify-between">
              <div className="font-semibold text-sm">Invite team member</div>
              <button
                type="button"
                onClick={() => setShowInviteModal(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              {inviteSuccess ? (
                <div className="flex items-center gap-2 text-sm text-emerald-600">
                  <Check className="w-4 h-4" />
                  Invite sent!
                </div>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">
                      Email address
                    </label>
                    <input
                      type="email"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="colleague@example.com"
                      className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">
                      Role
                    </label>
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as "user" | "billing" | "admin")}
                      className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      <option value="user">User</option>
                      <option value="billing">Billing</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                  {inviteError && (
                    <div className="text-xs text-destructive space-y-1">
                      <p>{inviteError}</p>
                      {existingInviteId && (
                        <button
                          type="button"
                          onClick={() => resendInviteMutation.mutate(existingInviteId)}
                          disabled={resendInviteMutation.isPending}
                          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
                        >
                          <Mail className="w-3.5 h-3.5" />
                          {resendInviteMutation.isPending ? "Resending…" : "Resend invite"}
                        </button>
                      )}
                    </div>
                  )}
                  <div className="flex justify-end pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setExistingInviteId(null);
                        inviteMutation.mutate();
                      }}
                      disabled={!inviteEmail.trim() || inviteMutation.isPending || resendInviteMutation.isPending}
                      className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
                    >
                      {inviteMutation.isPending ? "Sending…" : existingInviteId ? "Send invite anyway" : "Send invite"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </PanelShell>

    {/* Transfer-ownership confirmation dialog */}
    <AlertDialog
      open={!!transferTarget}
      onOpenChange={(open) => {
        if (!open && !transferOwnershipMutation.isPending) setTransferTarget(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Transfer ownership to {transferTarget?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {transferTarget?.name} will become the new owner of this lab. Your role will change to Admin.
            This action cannot be undone by you once confirmed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="text-sm">
          Type {user?.practiceName} to confirm
          <input
            aria-label="Organization name confirmation"
            className="w-full h-10 px-3 mt-2 rounded-md border border-input bg-background"
            value={transferPhrase}
            onChange={(e) => setTransferPhrase(e.target.value)}
            disabled={transferOwnershipMutation.isPending}
          />
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={transferOwnershipMutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              if (transferTarget) {
                transferOwnershipMutation.mutate({ targetMembershipId: transferTarget.membershipId });
              }
            }}
            disabled={!transferPhrase.trim() || transferOwnershipMutation.isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {transferOwnershipMutation.isPending ? (
              <><Loader2 size={13} className="animate-spin mr-1.5" />Transferring…</>
            ) : (
              "Transfer ownership"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    {showPlacementsModal && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        onClick={() => setShowPlacementsModal(false)}
      >
        <div
          className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-sm mx-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-5 border-b border-border">
            <div className="font-semibold text-sm">Logo placement</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Choose where the lab logo appears on documents and communications.
            </p>
          </div>
          <div className="p-5 space-y-3 max-h-72 overflow-y-auto">
            {LOGO_PLACEMENT_OPTIONS.map((opt) => {
              const checked = placementsSelection.includes(opt.key);
              return (
                <label key={opt.key} className="flex items-start gap-3 cursor-pointer">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() =>
                      setPlacementsSelection((prev) =>
                        checked ? prev.filter((k) => k !== opt.key) : [...prev, opt.key]
                      )
                    }
                    className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center mt-0.5 transition-colors ${
                      checked
                        ? "bg-primary border-primary"
                        : "bg-background border-input hover:border-primary/50"
                    }`}
                  >
                    {checked && <Check size={10} className="text-primary-foreground" />}
                  </button>
                  <div>
                    <div className="text-sm font-medium leading-tight">{opt.label}</div>
                    <div className="text-xs text-muted-foreground">{opt.desc}</div>
                  </div>
                </label>
              );
            })}
          </div>
          {placementsError && (
            <div className="px-5 pb-1">
              <p className="text-xs text-destructive">{placementsError}</p>
            </div>
          )}
          <div className="p-5 border-t border-border flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowPlacementsModal(false)}
              className="h-8 px-3 rounded-md border border-input bg-background text-xs font-semibold hover:bg-secondary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => placementsMutation.mutate(placementsSelection)}
              disabled={placementsMutation.isPending}
              className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-60"
            >
              {placementsMutation.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

function PasswordPanel() {
  const { user } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error("Not signed in.");
      if (newPassword.length < 8) throw new Error("Password must be at least 8 characters.");
      if (newPassword !== confirm) throw new Error("New passwords do not match.");
      return apiFetch(`/auth/users/${user.id}/password`, {
        method: "PUT",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
    },
    onSuccess: () => {
      setSuccess(true);
      setError(null);
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
      setTimeout(() => setSuccess(false), 2500);
    },
    onError: (err: Error) => {
      setSuccess(false);
      setError(err.message || "Could not change password.");
    },
  });

  return (
    <PanelShell title="Password" subtitle="Change the password you use to sign in.">
      {error && <Alert tone="danger">{error}</Alert>}
      {success && <Alert tone="success">Password updated.</Alert>}
      <div className="grid grid-cols-1 gap-4 max-w-md">
        <Field label="Current password">
          <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className={inputCls} autoComplete="current-password" />
        </Field>
        <Field label="New password">
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className={inputCls} autoComplete="new-password" />
        </Field>
        <Field label="Confirm new password">
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputCls} autoComplete="new-password" />
        </Field>
      </div>
      <div className="flex justify-end pt-1">
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending || !currentPassword || !newPassword}
          className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
        >
          {mutation.isPending ? "Updating…" : "Update password"}
        </button>
      </div>
    </PanelShell>
  );
}

function UsersPanel() {
  const usersQuery = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => apiFetch<{ users: AdminUser[] } | AdminUser[]>("/auth/users"),
  });
  const list: AdminUser[] = useMemo(() => {
    const d = usersQuery.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    return d.users ?? [];
  }, [usersQuery.data]);

  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return list
      .filter((u) => {
        if (!q) return true;
        return (
          u.username.toLowerCase().includes(q) ||
          (u.email || "").toLowerCase().includes(q) ||
          [u.firstName, u.lastName].filter(Boolean).join(" ").toLowerCase().includes(q) ||
          (u.practiceName || "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => a.username.localeCompare(b.username));
  }, [list, search]);

  return (
    <PanelShell
      title="Users"
      subtitle="Everyone in your lab and the provider practices under it."
    >
      <div className="flex items-center gap-3 mb-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search users…"
          className="h-9 px-3 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none flex-1 max-w-sm"
        />
        <div className="text-xs text-muted-foreground">
          {filtered.length} of {list.length}
        </div>
      </div>
      <div className="border border-border rounded-md overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="text-left font-medium px-3 py-2">User</th>
              <th className="text-left font-medium py-2">Email</th>
              <th className="text-left font-medium py-2">Practice</th>
              <th className="text-left font-medium py-2">Role</th>
              <th className="text-left font-medium px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {usersQuery.isLoading && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                  <Loader2 size={14} className="inline animate-spin mr-2" />
                  Loading…
                </td>
              </tr>
            )}
            {usersQuery.error && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-destructive">
                  {(usersQuery.error as Error).message}
                </td>
              </tr>
            )}
            {!usersQuery.isLoading && filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                  No users match.
                </td>
              </tr>
            )}
            {filtered.map((u) => (
              <tr key={u.id} className="border-t border-border">
                <td className="px-3 py-2.5">
                  <div className="font-medium">
                    {[u.firstName, u.lastName].filter(Boolean).join(" ") || u.username}
                  </div>
                  <div className="text-xs text-muted-foreground">@{u.username}</div>
                </td>
                <td className="py-2.5 text-muted-foreground text-xs">{u.email || "—"}</td>
                <td className="py-2.5 text-muted-foreground text-xs">{u.practiceName || "—"}</td>
                <td className="py-2.5">
                  <span className="text-[11px] uppercase tracking-wide bg-secondary text-secondary-foreground rounded-full px-2 py-0.5">
                    {u.role || "user"}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <span className={`text-[11px] px-2 py-0.5 rounded-full ${u.isActive === false ? "bg-warning/20 text-warning" : "bg-success/15 text-success"}`}>
                    {u.isActive === false ? "Inactive" : "Active"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PanelShell>
  );
}

type BackupDestinationType = "local" | "network" | "onedrive" | "google-drive";

interface OneDriveStatusData {
  ok: boolean;
  connected: boolean;
  accountName: string | null;
  accountEmail: string | null;
  folder: string;
  error: string | null;
  userMessage?: string | null;
  diagnostic?: string | null;
  manageUrl: string | null;
}

type GoogleDriveStatusData = GoogleDriveBackupStatusResult;
type BackupIntervalUnit = "minutes" | "hours";

interface BackupScheduleData {
  sourceEnvironment?: "development" | "production";
  allowedScheduleIntervalsMinutes?: number[];
  interval: number | null;
  unit: BackupIntervalUnit | null;
  destination: BackupDestinationType | null;
  path: string | null;
  enabled: boolean;
  lastSuccessfulBackupAt: string | null;
  staleAlertThresholdDays: number;
  staleAlertRateLimitDays: number;
  staleAfterDays: number;
  /** What the server is actually running, not what this form has unsaved. */
  effectiveIntervalMinutes?: number | null;
  effectiveDestination?: BackupDestinationType | null;
  /** The editable schedule row's own interval, which may be slower. */
  scheduleIntervalMinutes?: number | null;
  databaseRetention?: DatabaseProtectionRetentionSchedule;
  /** The independent off-site protection job on the deployed server. */
  offsite?: {
    databaseProtection?: {
      mode: "incremental-storage-fresh-export" | "incremental-records-and-media";
      scope: "production-database-and-media";
      coverage: "complete" | "partial";
      mediaFiles: number;
      mediaBytes: number;
      missingFiles: number;
      state: "not_started" | "running" | "verified" | "partial" | "skipped_busy" | "failed";
      stage: string;
      lastVerifiedAt: string | null;
      lastDestinationCheckAt: string | null;
      dumpBytes: number;
      newChunks: number;
      newBytes: number;
      reusedChunks: number;
      error: string | null;
    };
    enabled: boolean;
    running: boolean;
    intervalMinutes: number;
    lastVerifiedAt: string | null;
    /** Judged from the archive confirmed off-site, not the DB watermark. */
    stale?: boolean;
    ageMinutes?: number | null;
    windowMinutes?: number;
    source?: "onedrive" | "google-drive" | "database" | "none";
    reason?: string | null;
    destinationUnreadable?: boolean;
  } | null;
  /** Alert attempts and whether anyone could actually be told. */
  alertDelivery?: {
    undelivered: BackupAlertAttempt | null;
    recent: BackupAlertAttempt[];
  } | null;
  fullArchiveIntervalMinutes?: number | null;
  nextDueAt?: string | null;
  lastAttemptAt?: string | null;
  /** Newest archive actually present at the destination. */
  newestArchive?: {
    name: string;
    createdAt: string;
    sizeBytes: number;
    ageMinutes: number;
  } | null;
  newestArchiveError?: string | null;
  newestArchiveErrorMessage?: string | null;
  newestArchiveErrorDiagnostic?: string | null;
  archiveCount?: number | null;
}

const DEFAULT_BACKUP_STALE_DAYS = 7;

/** "every 15 minutes" / "every 2 hours" from a minute count. */
function describeIntervalMinutes(minutes: number | null | undefined): string | null {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? "every 24 hours" : `every ${days} days`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "every hour" : `every ${hours} hours`;
  }
  return `every ${minutes} minutes`;
}

/** Human name for a destination the server reports it is writing to. */
function describeBackupDestination(
  destination: BackupDestinationType | null | undefined,
): string {
  if (destination === "onedrive") return "OneDrive";
  if (destination === "google-drive") return "Google Drive";
  if (destination === "network") return "Network (SFTP)";
  if (destination === "local") return "Local folder / USB";
  return "not configured";
}

/** "4 minutes ago" / "3 hours ago" from an age in minutes. */
function describeAgeMinutes(ageMinutes: number): string {
  if (ageMinutes < 1) return "just now";
  if (ageMinutes < 60) return `${ageMinutes} minute${ageMinutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(ageMinutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Open the hosting-workspace page where a managed backup connector is linked.
 * The account handshake completes there; the admin returns here to check it.
 */
function openBackupConnectorManagePage(manageUrl: string | null): void {
  if (!manageUrl) return;
  window.open(manageUrl, "_blank", "noopener,noreferrer");
}
function isBackupStale(lastSuccessfulBackupAt: string | null, staleDays: number = DEFAULT_BACKUP_STALE_DAYS): boolean {
  if (!lastSuccessfulBackupAt) return true;
  const last = new Date(lastSuccessfulBackupAt).getTime();
  if (Number.isNaN(last)) return true;
  return Date.now() - last > staleDays * 24 * 60 * 60 * 1000;
}

const INTERVAL_OPTIONS: Array<{ interval: number; unit: BackupIntervalUnit; label: string }> = [
  { interval: 5, unit: "minutes", label: "Every 5 minutes" },
  { interval: 15, unit: "minutes", label: "Every 15 minutes" },
  { interval: 20, unit: "minutes", label: "Every 20 minutes" },
  { interval: 30, unit: "minutes", label: "Every 30 minutes" },
  { interval: 1, unit: "hours", label: "Every hour" },
  { interval: 6, unit: "hours", label: "Every 6 hours" },
  { interval: 24, unit: "hours", label: "Every 24 hours" },
];

function scheduleIntervalOptions(
  sourceEnvironment?: BackupScheduleData["sourceEnvironment"],
  allowedMinutes?: number[],
): Array<{ interval: number; unit: BackupIntervalUnit; label: string }> {
  const intervals = allowedMinutes?.length
    ? allowedMinutes
    : sourceEnvironment === "production"
      ? [5, 15, 20, 30, 60, 360, 1440]
      : sourceEnvironment === "development"
        ? [5, 15, 20, 30, 60, 360, 1440, 48 * 60, 72 * 60]
        : null;
  if (!intervals) return INTERVAL_OPTIONS;
  return intervals.map((minutes) => {
    const unit: BackupIntervalUnit = minutes % 60 === 0 ? "hours" : "minutes";
    const interval = unit === "hours" ? minutes / 60 : minutes;
    return {
      interval,
      unit,
      label: minutes === 60 ? "Every hour" : `Every ${interval} ${unit === "hours"
        ? interval === 1 ? "hour" : "hours"
        : interval === 1 ? "minute" : "minutes"}`,
    };
  });
}

function defaultScheduleIntervalKey(
  sourceEnvironment?: BackupScheduleData["sourceEnvironment"],
): string {
  return sourceEnvironment === "development"
    ? intervalKey(48, "hours")
    : intervalKey(15, "minutes");
}

function intervalKey(interval: number, unit: BackupIntervalUnit): string {
  return `${interval}_${unit}`;
}

function parseIntervalKey(key: string): { interval: number; unit: BackupIntervalUnit } | null {
  const [iv, u] = key.split("_");
  const n = parseInt(iv ?? "", 10);
  if (!Number.isFinite(n) || (u !== "minutes" && u !== "hours")) return null;
  return { interval: n, unit: u };
}

interface BackupRunRow {
  id: number;
  triggeredBy: string;
  destination: string;
  path: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  status: string;
  error: string | null;
  userMessage?: string | null;
  completedAt: string;
  mediaFileCount: number | null;
  attachmentRowCount: number | null;
  partialFailure: boolean | null;
  warnings: string | null;
  /**
   * "full" (database + media) or "database-only". Database-only archives are
   * taken on the fast schedule and cannot be used as a restore source — the
   * server rejects them, and the Restore action below refuses them up front so
   * an admin is not told only after a multi-hundred-megabyte download.
   */
  archiveKind?: string | null;
}

/** Database-only archives are not a restore source: they carry no media. */
function isDatabaseOnlyRun(run: Pick<BackupRunRow, "archiveKind">): boolean {
  return run.archiveKind === "database-only";
}

function LabScopedBackupCard() {
  const meQuery = useQuery<MeResponse>({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch<MeResponse>("/auth/me"),
    staleTime: 60_000,
  });
  const eligibleLabs = (meQuery.data?.memberships ?? []).filter((membership) =>
    membership.status === "active" &&
    (membership.role === "owner" || membership.role === "admin") &&
    membership.organization?.type === "lab" &&
    membership.organization.isActive === true &&
    !membership.organization.deletedAt,
  );
  const { user } = useAuth();
  const [selectedLabId, setSelectedLabId] = useState("");
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadMessage, setDownloadMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!selectedLabId && eligibleLabs.length === 1) {
      setSelectedLabId(eligibleLabs[0]!.organizationId);
    } else if (
      !selectedLabId &&
      user?.practiceOrganizationId &&
      eligibleLabs.some((membership) => membership.organizationId === user.practiceOrganizationId)
    ) {
      setSelectedLabId(user.practiceOrganizationId);
    }
  }, [eligibleLabs, selectedLabId, user?.practiceOrganizationId]);

  async function downloadLabBackup() {
    const membership = eligibleLabs.find((item) => item.organizationId === selectedLabId);
    if (!membership || isDownloading) return;
    setDownloadMessage(null);
    setIsDownloading(true);
    let fileHandle: { createWritable: () => Promise<WritableStream<Uint8Array>> } | null = null;
    try {
      const suggestedName = `labtrax-${membership.organization?.name || "lab"}-backup.zip.enc`
        .replace(/[^a-zA-Z0-9._-]+/g, "-");
      const picker = (window as Window & {
        showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{
          createWritable: () => Promise<WritableStream<Uint8Array>>;
        }>;
      }).showSaveFilePicker;
      // Open the save picker while the user gesture is still active. The file
      // body then streams directly to disk on browsers that support this API.
      if (picker) fileHandle = await picker({ suggestedName });

      const response = await apiFetchDownloadResponse(
        `/lab/backup/generate?labOrganizationId=${encodeURIComponent(selectedLabId)}`,
      );
      if (!response.ok) {
        let message = `Backup download failed (${response.status}).`;
        try {
          const body = await response.json() as { error?: string; message?: string };
          message = body.error || body.message || message;
        } catch {
          /* Keep the status-based message when the server did not return JSON. */
        }
        throw new Error(message);
      }
      if (!response.body) throw new Error("The server returned an empty backup download.");

      if (fileHandle) {
        const writable = await fileHandle.createWritable();
        await response.body.pipeTo(writable);
      } else {
        // Blob download is the compatibility path for browsers without the
        // File System Access API; the server still creates and sends the
        // encrypted archive as a stream.
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = response.headers.get("content-disposition")
          ?.match(/filename="([^"]+)"/)?.[1] ?? suggestedName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
      }
      setDownloadMessage({
        kind: "success",
        text: `Backup downloaded for ${membership.organization?.name ?? "the selected lab"}. Recovery instructions are included in the archive.`,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setDownloadMessage({
        kind: "error",
        text: error instanceof Error
          ? error.message
          : "Could not download the backup. Check your connection and try again.",
      });
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-3" data-testid="lab-scoped-backup">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary">
          <ShieldCheck size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Download a lab backup</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Creates an encrypted archive of one lab&rsquo;s records and referenced case media.
            Recovery instructions are included; restore it only into a new, isolated database.
          </p>
        </div>
      </div>

      {meQuery.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={13} className="animate-spin" /> Checking lab access…
        </div>
      ) : meQuery.isError ? (
        <p className="text-xs text-destructive" role="alert">
          Could not check your lab access. Refresh the page and try again.
        </p>
      ) : eligibleLabs.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          An active owner or admin membership is required to download a lab backup.
        </p>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          {eligibleLabs.length > 1 && (
            <label className="flex-1 space-y-1 text-xs">
              <span className="font-medium">Lab</span>
              <select
                aria-label="Lab for backup"
                data-testid="lab-backup-lab-select"
                value={selectedLabId}
                onChange={(event) => setSelectedLabId(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                disabled={isDownloading}
              >
                <option value="">Choose a lab</option>
                {eligibleLabs.map((membership) => (
                  <option key={membership.organizationId} value={membership.organizationId}>
                    {membership.organization?.name ?? "Lab"}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            data-testid="download-lab-backup"
            onClick={() => void downloadLabBackup()}
            disabled={isDownloading || !eligibleLabs.some((item) => item.organizationId === selectedLabId)}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isDownloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {isDownloading ? "Preparing backup…" : "Download lab backup"}
          </button>
        </div>
      )}

      {downloadMessage && (
        <p
          className={`text-xs ${downloadMessage.kind === "success" ? "text-green-700 dark:text-green-400" : "text-destructive"}`}
          role={downloadMessage.kind === "error" ? "alert" : "status"}
          data-testid={`lab-backup-${downloadMessage.kind}`}
        >
          {downloadMessage.text}
        </p>
      )}
    </section>
  );
}

function BackupPanel({ labOnly }: { labOnly: boolean }) {
  if (labOnly) {
    return (
      <PanelShell title="Backup" subtitle="Download an encrypted backup of a lab you administer.">
        <LabScopedBackupCard />
      </PanelShell>
    );
  }
  return <PlatformBackupPanel />;
}

function PlatformBackupPanel() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  function backupSourceHeaders(): Record<string, string> {
    return scheduleQuery.data?.sourceEnvironment
      ? { "X-LabTrax-Backup-Source": scheduleQuery.data.sourceEnvironment } : {};
  }
  const scheduledBackupProgress = useSyncExternalStore(
    subscribeScheduledLocalBackupProgress,
    getScheduledLocalBackupProgress,
    getScheduledLocalBackupProgress,
  );
  const manualProgress = useSyncExternalStore(
    subscribeManualBackupProgress,
    getManualBackupProgress,
    getManualBackupProgress,
  );
  const [scheduledElapsedSeconds, setScheduledElapsedSeconds] = useState(0);
  const [nowDest, setNowDest] = useState<BackupDestinationType>("local");
  const [nowArchiveKind, setNowArchiveKind] = useState<"full" | "database-only">("full");
  const [nowPath, setNowPath] = useState("");
  const [backupResult, setBackupResult] = useState<{ size: number; completedAt: string; fileName: string; savedTo?: string | null; viaBrowser?: boolean; partialFailure?: boolean; warnings?: string | null; warningMessage?: string | null; databaseOnly?: boolean } | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupPhase, setBackupPhase] = useState("");
  const [backupElapsedSeconds, setBackupElapsedSeconds] = useState(0);
  const [backupLiveStatus, setBackupLiveStatus] = useState<LocalBackupLiveStatus | null>(null);
  const [cancelPending, setCancelPending] = useState(false);
  const [resumeDeliveryPending, setResumeDeliveryPending] = useState(false);
  const [manualReconnectUnconfirmed, setManualReconnectUnconfirmed] = useState(false);
  const rehydratedManualRunRef = useRef<string | null>(null);

  const [schedIntervalKey, setSchedIntervalKey] = useState<string>(intervalKey(15, "minutes"));
  const [schedDest, setSchedDest] = useState<BackupDestinationType>("local");
  const [schedPath, setSchedPath] = useState("");
  const [schedEnabled, setSchedEnabled] = useState(false);
  const [staleThresholdDays, setStaleThresholdDays] = useState(7);
  const [staleRateLimitDays, setStaleRateLimitDays] = useState(3);
  const [schedStaleDays, setSchedStaleDays] = useState<number>(DEFAULT_BACKUP_STALE_DAYS);
  const [schedError, setSchedError] = useState<string | null>(null);
  const [schedSuccess, setSchedSuccess] = useState(false);
  const [schedRunNowResult, setSchedRunNowResult] = useState<{ size: number; completedAt: string; fileName: string; partialFailure?: boolean; warnings?: string | null; warningMessage?: string | null } | null>(null);
  const [schedRunNowError, setSchedRunNowError] = useState<string | null>(null);
  const [retentionApprovalOpen, setRetentionApprovalOpen] = useState(false);

  const [selectedRestoreRunId, setSelectedRestoreRunId] = useState<number | null>(null);
  const [restoreFromHistoryLoading, setRestoreFromHistoryLoading] = useState(false);
  const [restoreFromHistoryError, setRestoreFromHistoryError] = useState<string | null>(null);
  const [preloadedFile, setPreloadedFile] = useState<File | null>(null);

  const scheduleQuery = useQuery<BackupScheduleData>({
    queryKey: ["admin", "backup-schedule-v2"],
    queryFn: () => apiFetch("/admin/backup/schedule"),
    retry: retryUnlessForbidden,
    refetchInterval: query => query.state.data?.sourceEnvironment === "production" ? 5000 : false,
  });

  useEffect(() => {
    if (!user?.id || manualProgress.runId) return;
    const identity = loadManualBackupIdentity(user.id);
    const identityKey = identity ? `${user.id}:${identity.runId}` : null;
    if (!identity || !identityKey || rehydratedManualRunRef.current === identityKey) return;
    rehydratedManualRunRef.current = identityKey;
    setManualReconnectUnconfirmed(true);
    setNowDest(identity.destination);
    setNowArchiveKind(identity.archiveKind);
    setNowPath(identity.path);
    resetManualBackupProgress(identity.runId, "Reconnecting to your manual backup", identity.startedAt);
    void apiFetch<LocalBackupLiveStatus & ManualBackupStatus>(
      `/admin/backup/status/${encodeURIComponent(identity.runId)}`,
    ).then(status => {
      if (status.runId !== identity.runId) throw new Error("The saved run identity did not match the server response.");
      applyManualBackupLiveStatus(status);
      setManualReconnectUnconfirmed(false);
    }).catch(() => {
      updateManualBackupProgress({
        state: "running",
        error: "Could not reconnect to this backup. Sign in again if needed and retry reconnection. Check Recent backups before starting another run.",
      });
    });
  }, [user?.id, manualProgress.runId]);

  // Where the server says archives are actually being written, which is not
  // necessarily the destination saved in this form: off-site protection keeps
  // uploading to OneDrive even when the editable schedule points elsewhere.
  const serverDestination: BackupDestinationType | null =
    scheduleQuery.data?.effectiveDestination ?? scheduleQuery.data?.destination ?? null;

  const historyQuery = useQuery<{ ok: boolean; runs: BackupRunRow[] }>({
    queryKey: ["admin", "backup-history"],
    queryFn: () => apiFetch("/admin/backup/history"),
    staleTime: 30_000,
  });

  const oneDriveStatusEnabled = nowDest === "onedrive" || schedDest === "onedrive";
  const oneDriveStatusQuery = useQuery<OneDriveStatusData>({
    queryKey: ["admin", "backup-onedrive-status"],
    queryFn: async () => {
      const status = await apiFetch<OneDriveStatusData>("/admin/backup/onedrive-status");
      if (typeof status?.connected !== "boolean" || typeof status.folder !== "string") {
        throw new Error("The server did not return a OneDrive connection status. Check the Desktop connection settings or update LabTrax.");
      }
      return status;
    },
    staleTime: 60_000,
    retry: retryUnlessForbidden,
    refetchInterval: haltPollingIfForbidden(60_000),
    enabled: oneDriveStatusEnabled,
  });
  const googleDriveStatusEnabled =
    nowDest === "google-drive" || schedDest === "google-drive";
  const googleDriveStatusQuery = useQuery<GoogleDriveStatusData>({
    queryKey: ["admin", "backup-google-drive-status"],
    queryFn: async () => {
      const status = await apiFetch<GoogleDriveStatusData>(
        "/admin/backup/google-drive-status",
      );
      if (typeof status?.connected !== "boolean" || typeof status.folder !== "string") {
        throw new Error(
          "The server did not return a Google Drive connection status. Check the Desktop connection settings or update LabTrax.",
        );
      }
      return status;
    },
    staleTime: 60_000,
    retry: retryUnlessForbidden,
    refetchInterval: haltPollingIfForbidden(60_000),
    enabled: googleDriveStatusEnabled,
  });
  const { refetch: refetchOneDriveStatus } = oneDriveStatusQuery;
  useEffect(() => {
    if (!oneDriveStatusEnabled) return;
    // OAuth completes in an external browser. Electron can regain focus
    // without a visibilitychange, so don't rely on Query's visibility listener.
    const refresh = () => { void refetchOneDriveStatus({ cancelRefetch: false }); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [oneDriveStatusEnabled, refetchOneDriveStatus]);
  const { refetch: refetchGoogleDriveStatus } = googleDriveStatusQuery;
  useEffect(() => {
    if (!googleDriveStatusEnabled) return;
    // Google account linking completes in the hosting workspace. Refresh the
    // status when the admin returns from that browser window.
    const refresh = () => { void refetchGoogleDriveStatus({ cancelRefetch: false }); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [googleDriveStatusEnabled, refetchGoogleDriveStatus]);

  const retentionQuery = useQuery<{
    ok: boolean;
    retentionDays: number;
    dbRetentionDays: number | null;
    envRetentionDays: number;
    maxRows: number;
    dbMaxRows: number | null;
    envMaxRows: number;
  }>({
    queryKey: ["admin", "backup-history-retention"],
    queryFn: () => apiFetch("/admin/backup/history-retention"),
    staleTime: 60_000,
  });

  const [retentionDaysInput, setRetentionDaysInput] = useState<string>("");
  const [maxRowsInput, setMaxRowsInput] = useState<string>("");
  const [retentionSaved, setRetentionSaved] = useState(false);

  useEffect(() => {
    if (retentionQuery.data) {
      setRetentionDaysInput(String(retentionQuery.data.retentionDays));
      setMaxRowsInput(String(retentionQuery.data.maxRows));
    }
  }, [retentionQuery.data]);

  const saveRetentionMutation = useMutation({
    mutationFn: () =>
      apiFetch("/admin/backup/history-retention", {
        method: "PUT",
        body: JSON.stringify({
          retentionDays: parseInt(retentionDaysInput, 10),
          maxRows: parseInt(maxRowsInput, 10),
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "backup-history-retention"] });
      setRetentionSaved(true);
      setTimeout(() => setRetentionSaved(false), 3000);
    },
  });

  useEffect(() => {
    if (scheduleQuery.data) {
      const { interval, unit } = scheduleQuery.data;
      if (interval !== null && unit !== null) {
        setSchedIntervalKey(intervalKey(interval, unit));
      } else {
        setSchedIntervalKey(defaultScheduleIntervalKey(scheduleQuery.data.sourceEnvironment));
      }
      setSchedDest(scheduleQuery.data.sourceEnvironment === "production"
        ? "onedrive" : (scheduleQuery.data.destination as BackupDestinationType | null) ?? "local");
      setSchedPath(scheduleQuery.data.path ?? "");
      setSchedEnabled(scheduleQuery.data.enabled);
      setStaleThresholdDays(scheduleQuery.data.staleAlertThresholdDays ?? 7);
      setStaleRateLimitDays(scheduleQuery.data.staleAlertRateLimitDays ?? 3);
      setSchedStaleDays(scheduleQuery.data.staleAfterDays ?? DEFAULT_BACKUP_STALE_DAYS);
    }
  }, [scheduleQuery.data]);

  async function deliverStagedManualBackup(
    runId: string,
    archiveKind: "full" | "database-only",
    browserSaveHandle?: BrowserBackupSaveHandle,
  ) {
    const response = await apiFetchDownloadResponse(
      `/admin/backup/download/${encodeURIComponent(runId)}`,
      { method: "GET", headers: backupSourceHeaders() },
    );
    if (!response.ok) {
      let message = `Backup download failed (${response.status}).`;
      try {
        const body = await response.json() as { error?: string; message?: string };
        message = body.error ?? body.message ?? message;
      } catch { /* Keep the status-based message. */ }
      throw new Error(message);
    }
    verifyRequestedBackupHeaders(response.headers, archiveKind);
    const fileName = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1]
      ?? "labtrax-backup.zip.enc";
    const missingFileCount = Number(response.headers.get("x-backup-missing-file-count") ?? 0);
    let size: number;
    let savedTo: string | null = null;
    let viaBrowser = false;
    if (browserSaveHandle) {
      const writable = await browserSaveHandle.createWritable();
      size = await streamVerifiedBackupToWritable(response, writable, archiveKind);
      savedTo = browserSaveHandle.name ?? fileName;
    } else {
      const buffer = await readBoundedBackupBuffer(response);
      verifyStreamedBackup(buffer, response.headers);
      size = buffer.byteLength;
      const url = URL.createObjectURL(new Blob([buffer], { type: "application/octet-stream" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      viaBrowser = true;
    }
    const report = await apiFetch<{ rejected?: boolean; warning?: string; completedAt?: string }>(
      "/admin/backup/desktop-run-report",
      {
        method: "POST",
        headers: backupSourceHeaders(),
        body: JSON.stringify({
          status: "success",
          source: "manual",
          fileName,
          sizeBytes: size,
          path: savedTo ?? fileName,
          downloadRunId: runId,
        }),
      },
    );
    if (report.rejected) throw new Error(report.warning ?? "The server rejected the saved backup.");
    return {
      size,
      completedAt: report.completedAt ?? new Date().toISOString(),
      fileName,
      savedTo,
      viaBrowser,
      partialFailure: missingFileCount > 0,
      warnings: missingFileCount > 0
        ? `${missingFileCount} original files unavailable; see missing-files.json. Not a complete recovery point.`
        : null,
    };
  }

  const backupNowMutation = useMutation({
    mutationFn: async (browserSaveHandle?: BrowserBackupSaveHandle): Promise<{ size: number; completedAt: string; fileName: string; savedTo: string | null; viaBrowser: boolean; partialFailure?: boolean; warnings?: string | null; warningMessage?: string | null }> => {
      const startedAt = Date.now();
      setBackupElapsedSeconds(0);
      setBackupLiveStatus(null);
      const initialPhase =
        nowArchiveKind === "database-only" ? "Preparing an encrypted database-only backup — media is excluded" : nowDest === "onedrive"
          ? "Preparing, uploading and verifying the full archive in OneDrive"
          : nowDest === "google-drive"
            ? "Preparing, uploading and verifying the encrypted archive in Google Drive"
            : "Generating and downloading the full archive";
      const runId = crypto.randomUUID();
      resetManualBackupProgress(runId, initialPhase, startedAt);
      if (user?.id) {
        saveManualBackupIdentity(user.id, {
          runId,
          destination: nowDest,
          archiveKind: nowArchiveKind,
          path: nowPath,
          startedAt,
        });
      }
      setBackupPhase(initialPhase);
      if (nowDest === "onedrive" || nowDest === "google-drive") {
        const provider = nowDest === "onedrive" ? "OneDrive" : "Google Drive";
        let pendingStatus: Promise<LocalBackupLiveStatus & ManualBackupStatus> | null = null;
        const readStatus = () => pendingStatus ??= apiFetch<LocalBackupLiveStatus & ManualBackupStatus>(
          `/admin/backup/status/${encodeURIComponent(runId)}`, { headers: backupSourceHeaders() },
        ).finally(() => { pendingStatus = null; });
        const updateStatus = (status: ManualBackupStatus) => applyManualBackupLiveStatus({
          ...status,
          state: status.state as LocalBackupLiveStatus["state"],
          elapsedMs: status.elapsedMs ?? 0,
          metrics: status.metrics ?? {},
        });
        // Older installed servers hold the POST open. Keep their progress
        // observer alive until acknowledgement too, without duplicate reads.
        const stopWatching = watchBackupLiveStatus(runId, readStatus, updateStatus);
        try {
        const res = await followManualBackup(
          runId,
          () => apiFetch("/admin/backup/run", {
            method: "POST",
            headers: backupSourceHeaders(),
            body: JSON.stringify({ destination: nowDest, runId, respondAsync: true,
              ...(nowArchiveKind === "database-only" ? { archiveKind: nowArchiveKind } : {}) }),
          }),
          readStatus, updateStatus,
        );
          if (nowArchiveKind === "database-only" && res.archiveKind !== "database-only") {
            throw new Error("The server did not confirm a database-only backup. No complete recovery is claimed; update the server before using this option.");
          }
          return { ...res, savedTo: provider, viaBrowser: false };
        } finally {
          stopWatching();
        }
      }
      const isNetworkSftp = nowDest === "network" && nowPath.trim().startsWith("sftp://");
      if (isNetworkSftp && nowArchiveKind === "database-only") {
        throw new Error("Database-only backups support download/local USB, OneDrive or Google Drive. SFTP requires a complete backup.");
      }
      if (isNetworkSftp) {
        let pendingStatus: Promise<LocalBackupLiveStatus & ManualBackupStatus> | null = null;
        const readStatus = () => pendingStatus ??= apiFetch<LocalBackupLiveStatus & ManualBackupStatus>(
          `/admin/backup/status/${encodeURIComponent(runId)}`, { headers: backupSourceHeaders() },
        ).finally(() => { pendingStatus = null; });
        const updateStatus = (status: ManualBackupStatus) => applyManualBackupLiveStatus({
          ...status,
          state: status.state as LocalBackupLiveStatus["state"],
          elapsedMs: status.elapsedMs ?? 0,
          metrics: status.metrics ?? {},
        });
        const stopWatching = watchBackupLiveStatus(
          runId,
          () => readStatus(),
          updateStatus,
        );
        try {
          const res = await followManualBackup(
            runId,
            () => apiFetch("/admin/backup/run", {
              method: "POST",
              body: JSON.stringify({ destination: nowDest, path: nowPath.trim(), runId, respondAsync: true }),
              headers: backupSourceHeaders(),
            }),
            readStatus,
            updateStatus,
          );
          return { ...res, savedTo: nowPath.trim(), viaBrowser: false };
        } finally {
          stopWatching();
        }
      }
      const electronAPI = (window as ElectronWindow).electronAPI;
      const wantsPath = !!nowPath.trim() && (nowDest !== "local" || !!electronAPI);
      if (wantsPath && !electronAPI?.saveBackupToFolder && !electronAPI?.downloadBackupToFolder) {
        // Running in a regular browser — we cannot write to an arbitrary
        // filesystem path. Refuse instead of silently downloading to the
        // browser's default Downloads folder while pretending we saved to
        // the user's E:\… path.
        throw new Error(
          `This browser cannot save directly to "${nowPath.trim()}". Install and open the LabTrax Desktop app to back up to a specific folder, or clear the folder path to download the backup file through your browser instead.`,
        );
      }
      if (wantsPath && (electronAPI?.saveBackupToFolder || electronAPI?.downloadBackupToFolder)) {
        const result = await executeLocalBackup({
          apiFetch, apiFetchArrayBuffer,
          sourceHeaders: backupSourceHeaders(),
          saveBackupToFolder: electronAPI.saveBackupToFolder,
          downloadBackupToFolder: electronAPI.downloadBackupToFolder ? apiDownloadBackupToFolder : undefined,
          runId,
          onDownloadRunId: electronAPI.onBackupRunId,
          getLiveStatus: (id) => apiFetch<LocalBackupLiveStatus>(`/admin/backup/status/${encodeURIComponent(id)}`),
          onLiveStatus: applyManualBackupLiveStatus,
          onPhase: (phase) => updateManualBackupProgress({ phase }),
        }, nowPath.trim(), "manual", nowArchiveKind);
        return { size: result.sizeBytes, completedAt: result.completedAt, fileName: result.fileName, savedTo: result.path, viaBrowser: false,
          partialFailure: result.partialFailure, warnings: result.warnings };
      }
      const readStatus = (id: string) => apiFetch<LocalBackupLiveStatus & ManualBackupStatus>(
        `/admin/backup/status/${encodeURIComponent(id)}`,
        { headers: backupSourceHeaders() },
      );
      const updateStatus = (status: ManualBackupStatus) => applyManualBackupLiveStatus({
        ...status,
        state: status.state as LocalBackupLiveStatus["state"],
        elapsedMs: status.elapsedMs ?? 0,
        metrics: status.metrics ?? {},
      });
      const stopWatching = watchBackupLiveStatus(runId, readStatus, updateStatus);
      try {
        await apiFetch("/admin/backup/run", {
          method: "POST",
          headers: backupSourceHeaders(),
          body: JSON.stringify({
            destination: "browser",
            runId,
            archiveKind: nowArchiveKind,
            respondAsync: true,
          }),
        });
        const until = Date.now() + (6 * 60 + 5) * 60 * 1000;
        while (Date.now() < until) {
          const status = await readStatus(runId);
          updateStatus(status);
          if (status.delivery) return deliverStagedManualBackup(runId, nowArchiveKind, browserSaveHandle);
          if (status.state === "cancelled") throw new Error(status.error ?? "Backup cancelled. Incomplete output was discarded.");
          if (status.state === "failed" || status.state === "stale") {
            throw new Error(status.error ?? "Backup generation failed. Check Recent backups.");
          }
          await new Promise(resolve => window.setTimeout(resolve, 1500));
        }
        throw new Error("Backup generation is still running. Return to this section to reconnect before starting another backup.");
      } finally {
        stopWatching();
      }
    },
    onSuccess: (data) => {
      const result = { ...data, databaseOnly: nowArchiveKind === "database-only" };
      setBackupResult(result);
      setBackupError(null);
      updateManualBackupProgress({
        state: "completed",
        phase: "backup complete",
        result,
        liveStatus: getManualBackupProgress().liveStatus
          ? { ...getManualBackupProgress().liveStatus!, state: "completed", phase: "backup complete", overallProgress: 100 }
          : null,
      });
      queryClient.invalidateQueries({ queryKey: ["admin", "backup-history"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "backup-schedule-v2"] });
    },
    onError: (err: Error) => {
      setBackupResult(null);
      setBackupError(err.message || "Backup failed.");
      const current = getManualBackupProgress();
      if (current.state === "cancelled") return;
      if (current.liveStatus?.delivery && current.liveStatus.state === "awaiting_verification") {
        // Delivery is retryable from the staged archive; do not convert a
        // transport interruption into a failed backup run.
        updateManualBackupProgress({ state: "running", error: err.message || "Download interrupted. Retry from the same backup run." });
        return;
      }
      const httpStatus = (err as Error & { status?: number }).status;
      const connectionUncertain = err instanceof TypeError || [401, 403, 502, 503, 504].includes(httpStatus ?? 0);
      if ((current.liveStatus && !["failed", "stale", "cancelled"].includes(current.liveStatus.state)) ||
          (!current.liveStatus && connectionUncertain)) {
        // A lost session or network error cannot establish server job failure.
        setManualReconnectUnconfirmed(true);
        updateManualBackupProgress({ state: "running", error:
          "Live progress is unavailable. Sign in again if needed, then retry backup reconnection. Do not start another backup; the server run may still be active." });
        return;
      }
      updateManualBackupProgress({ state: (current.liveStatus?.state ?? "failed") as "failed" | "stale" | "cancelled",
        error: err.message || "Backup failed." });
      queryClient.invalidateQueries({ queryKey: ["admin", "backup-history"] });
    },
  });

  useEffect(() => {
    setBackupPhase(manualProgress.liveStatus
      ? backupLivePhaseLabel(manualProgress.liveStatus.phase)
      : manualProgress.phase);
    setBackupLiveStatus(manualProgress.liveStatus);
    if (manualProgress.result) setBackupResult(manualProgress.result);
    else if (manualProgress.state === "running" || manualProgress.state === "failed") setBackupResult(null);
    setBackupError(manualProgress.error);
  }, [manualProgress]);

  // The external store is module-scoped, so Settings can unmount while a run
  // continues. A later visit resumes polling that same opaque run identity.
  useEffect(() => {
    if (manualProgress.state !== "running" || !manualProgress.runId || backupNowMutation.isPending) return;
    return watchBackupLiveStatus(
      manualProgress.runId,
      (runId) => apiFetch<LocalBackupLiveStatus>(`/admin/backup/status/${encodeURIComponent(runId)}`, {
        headers: backupSourceHeaders(),
      }),
      (status) => {
        applyManualBackupLiveStatus(status);
        setManualReconnectUnconfirmed(false);
      },
      1200,
      () => {
        setManualReconnectUnconfirmed(true);
        updateManualBackupProgress({ error:
          "Live progress is unavailable. Sign in again if needed, then retry backup reconnection. The backup may still be running; do not start a duplicate." });
      },
    );
  }, [manualProgress.runId, manualProgress.state, backupNowMutation.isPending]);

  async function resumeStagedDelivery() {
    if (!manualProgress.runId || !manualProgress.liveStatus?.delivery || resumeDeliveryPending) return;
    setResumeDeliveryPending(true);
    setBackupError(null);
    try {
      const result = await deliverStagedManualBackup(manualProgress.runId, nowArchiveKind);
      const completed = { ...result, databaseOnly: nowArchiveKind === "database-only" };
      setBackupResult(completed);
      updateManualBackupProgress({
        state: "completed",
        phase: "backup complete",
        result: completed,
        liveStatus: { ...manualProgress.liveStatus, state: "completed", phase: "backup complete", overallProgress: 100 },
        error: null,
      });
      queryClient.invalidateQueries({ queryKey: ["admin", "backup-history"] });
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : "Could not download the staged backup. Retry this run.");
    } finally {
      setResumeDeliveryPending(false);
    }
  }

  async function retryManualBackupReconnect() {
    const runId = manualProgress.runId;
    if (!runId || !user?.id) return;
    setManualReconnectUnconfirmed(true);
    try {
      const status = await apiFetch<LocalBackupLiveStatus & ManualBackupStatus>(
        `/admin/backup/status/${encodeURIComponent(runId)}`,
        { headers: backupSourceHeaders() },
      );
      if (status.runId !== runId) throw new Error("The saved run identity did not match the server response.");
      applyManualBackupLiveStatus(status);
      setManualReconnectUnconfirmed(false);
      setBackupError(null);
    } catch {
      setBackupError("Could not reconnect to this backup. Check your connection and retry before starting another run.");
    }
  }

  async function cancelManualBackup() {
    const runId = manualProgress.runId;
    if (!runId || cancelPending || manualProgress.state !== "running") return;
    setCancelPending(true);
    try {
      await apiFetch(`/admin/backup/cancel/${encodeURIComponent(runId)}`, {
        method: "POST",
        headers: backupSourceHeaders(),
      });
      updateManualBackupProgress({
        state: "cancelled",
        phase: "backup cancelled",
        error: "Backup cancelled. Incomplete output was discarded; no successful backup was recorded.",
        liveStatus: manualProgress.liveStatus
          ? { ...manualProgress.liveStatus, state: "cancelled", phase: "backup cancelled" }
          : null,
      });
      setManualReconnectUnconfirmed(false);
      setBackupResult(null);
      setBackupError(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "backup-history"] });
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : "This backup could not be cancelled.");
      void apiFetch<LocalBackupLiveStatus>(`/admin/backup/status/${encodeURIComponent(runId)}`, {
        headers: backupSourceHeaders(),
      }).then(applyManualBackupLiveStatus).catch(() => {});
    } finally {
      setCancelPending(false);
    }
  }

  const choosingBackupFile = useRef(false);
  async function runManualBackup() {
    if (user?.id && !manualProgress.runId && loadManualBackupIdentity(user.id)) return;
    if (backupNowMutation.isPending || getManualBackupProgress().state === "running" ||
        choosingBackupFile.current || gate.blocked) return;
    const picker = (window as Window & {
      showSaveFilePicker?: (options: { suggestedName: string }) => Promise<BrowserBackupSaveHandle>;
    }).showSaveFilePicker;
    if (nowDest !== "local" || electron?.saveBackupToFolder || electron?.downloadBackupToFolder || !picker) {
      backupNowMutation.mutate(undefined);
      return;
    }
    choosingBackupFile.current = true;
    try {
      const handle = await picker.call(window, { suggestedName: "labtrax-backup.zip.enc" });
      backupNowMutation.mutate(handle);
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        setBackupError(error instanceof Error ? error.message : "Could not select a backup file.");
      }
    } finally {
      choosingBackupFile.current = false;
    }
  }

  useEffect(() => {
    if (manualProgress.state !== "running" || !manualProgress.startedAt) return;
    const timer = window.setInterval(() =>
      setBackupElapsedSeconds(Math.floor((Date.now() - manualProgress.startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [manualProgress.state, manualProgress.startedAt]);

  useEffect(() => {
    if (!scheduledBackupProgress) {
      setScheduledElapsedSeconds(0);
      return;
    }
    const updateElapsed = () =>
      setScheduledElapsedSeconds(Math.floor((Date.now() - scheduledBackupProgress.startedAt) / 1000));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [scheduledBackupProgress?.startedAt]);

  const saveScheduleMutation = useMutation({
    mutationFn: () => {
      const parsed = parseIntervalKey(schedIntervalKey) ?? { interval: 1, unit: "hours" as BackupIntervalUnit };
      return apiFetch("/admin/backup/schedule", {
        method: "PUT",
        headers: scheduleQuery.data?.sourceEnvironment
          ? { "X-LabTrax-Backup-Source": scheduleQuery.data.sourceEnvironment } : {},
        body: JSON.stringify({
          interval: parsed.interval,
          unit: parsed.unit,
          destination: schedDest,
          path: needsPath(schedDest) ? schedPath.trim() || null : null,
          enabled: schedEnabled,
          staleAlertThresholdDays: staleThresholdDays,
          staleAlertRateLimitDays: staleRateLimitDays,
          staleAfterDays: schedStaleDays,
        }),
      });
    },
    onSuccess: () => {
      setSchedError(null);
      setSchedSuccess(true);
      queryClient.invalidateQueries({ queryKey: ["admin", "backup-schedule-v2"] });
      setTimeout(() => setSchedSuccess(false), 2500);
    },
    onError: (err: Error) => {
      setSchedError(err.message || "Failed to save schedule.");
    },
  });

  const disableScheduleMutation = useMutation({
    mutationFn: () => apiFetch("/admin/backup/schedule", { method: "DELETE", headers: backupSourceHeaders() }),
    onSuccess: () => {
      setSchedEnabled(false);
      setSchedError(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "backup-schedule-v2"] });
    },
    onError: (err: Error) => {
      setSchedError(err.message || "Failed to disable schedule.");
    },
  });

  const databaseRetentionMutation = useMutation({
    mutationFn: (enabled: boolean) => {
      const policy = scheduleQuery.data?.databaseRetention;
      return apiFetch("/admin/backup/database-retention", {
        method: "PUT",
        headers: backupSourceHeaders(),
        body: JSON.stringify({
          enabled,
          keepAllWithinHours: policy?.keepAllWithinHours ?? 24,
          keepHourlyWithinDays: policy?.keepHourlyWithinDays ?? 7,
          keepDailyWithinDays: policy?.keepDailyWithinDays ?? 30,
          safetyGraceHours: policy?.safetyGraceHours ?? 48,
          ...(enabled ? { confirmation: "APPROVE_DATABASE_RETENTION" } : {}),
        }),
      });
    },
    onSuccess: (_result, enabled) => {
      setRetentionApprovalOpen(false);
      toast({
        title: enabled ? "Database retention approved" : "Database retention paused",
        description: enabled ? "Old unreferenced objects will be removed after a fresh safety scan." : "No further database objects will be removed.",
      });
      queryClient.invalidateQueries({ queryKey: ["admin", "backup-schedule-v2"] });
    },
  });

  const schedRunNowMutation = useMutation({
    mutationFn: () => apiFetch("/admin/backup/schedule/run-now", { method: "POST", headers: backupSourceHeaders() }),
    onSuccess: (data: {
      accepted?: boolean;
      size: number;
      completedAt: string;
      fileName: string;
      partialFailure?: boolean;
      warnings?: string | null;
      warningMessage?: string | null;
    }) => {
      if (data.accepted) {
        setSchedRunNowResult(null);
        setSchedRunNowError(null);
        toast({ title: "Production records and media protection requested", description: "Watch its status for verified coverage or missing-original warnings." });
        queryClient.invalidateQueries({ queryKey: ["admin", "backup-schedule-v2"] });
        return;
      }
      setSchedRunNowResult(data);
      setSchedRunNowError(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "backup-history"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "backup-schedule-v2"] });
    },
    onError: (err: Error) => {
      setSchedRunNowResult(null);
      setSchedRunNowError(err.message || "Backup run failed.");
    },
  });

  const electron = typeof window !== "undefined"
    ? (window as ElectronWindow).electronAPI
    : null;

  async function pickFolderFor(setter: (v: string) => void) {
    if (electron?.showFolderDialog) {
      const p = await electron.showFolderDialog();
      if (p) setter(p);
    }
  }

  const gate = usePlatformAdminGate([
    scheduleQuery.error,
    oneDriveStatusQuery.error,
    googleDriveStatusQuery.error,
    backupNowMutation.error,
    saveScheduleMutation.error,
    disableScheduleMutation.error,
    schedRunNowMutation.error,
    databaseRetentionMutation.error,
  ]);

  const needsPath = (d: BackupDestinationType) => d === "local" || d === "network";
  const manualBackupRunning = backupNowMutation.isPending || manualProgress.state === "running";
  const scheduleIntervalChoices = scheduleIntervalOptions(
    scheduleQuery.data?.sourceEnvironment,
    scheduleQuery.data?.allowedScheduleIntervalsMinutes,
  );
  const hasCurrentIntervalChoice = scheduleIntervalChoices.some(
    (option) => intervalKey(option.interval, option.unit) === schedIntervalKey,
  );
  const legacyIntervalChoice = !hasCurrentIntervalChoice
    ? parseIntervalKey(schedIntervalKey)
    : null;
  const legacyIntervalLabel = legacyIntervalChoice
    ? `Current: every ${legacyIntervalChoice.interval} ${
        legacyIntervalChoice.unit === "minutes"
          ? legacyIntervalChoice.interval === 1 ? "minute" : "minutes"
          : legacyIntervalChoice.interval === 1 ? "hour" : "hours"
      } (legacy)`
    : null;

  const oneDriveRefreshButton = (
    <button
      type="button"
      data-testid="onedrive-check-again-button"
      onClick={() => refetchOneDriveStatus()}
      disabled={oneDriveStatusQuery.isFetching}
      className="inline-flex items-center gap-1 text-[11px] font-semibold underline disabled:opacity-60"
    >
      {oneDriveStatusQuery.isFetching ? "Checking…" : "Check again"}
    </button>
  );

  const oneDriveNotice = oneDriveStatusQuery.isPending ? (
    <div className="flex min-w-0 items-center gap-2 break-words text-[11px] text-muted-foreground">
      <Loader2 size={11} className="animate-spin" />
      Checking OneDrive connection…
    </div>
  ) : oneDriveStatusQuery.isError ? (
    <div className="break-words rounded-md border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[11px] leading-snug text-amber-800 dark:text-amber-300" data-testid="onedrive-status-error">
      <p className="font-semibold mb-0.5">Could not check OneDrive</p>
      <p>
        {oneDriveStatusQuery.error instanceof Error
          ? oneDriveStatusQuery.error.message
          : "The connection-status request failed."}{" "}
        This does not mean the Microsoft account is disconnected.
      </p>
      <div className="mt-1.5">{oneDriveRefreshButton}</div>
    </div>
  ) : oneDriveStatusQuery.data?.connected ? (
    <div className="break-words rounded-md border border-success/40 bg-success/10 px-3 py-2 text-[11px] leading-snug text-success" data-testid="onedrive-status-connected">
      OneDrive connected
      {oneDriveStatusQuery.data.accountName || oneDriveStatusQuery.data.accountEmail
        ? ` as ${oneDriveStatusQuery.data.accountName ?? ""}${oneDriveStatusQuery.data.accountEmail ? ` (${oneDriveStatusQuery.data.accountEmail})` : ""}`
        : ""}
      . Backups are saved to <span className="font-mono">{oneDriveStatusQuery.data.folder}</span> in that account.
      {oneDriveStatusQuery.data.manageUrl && (
        <button
          type="button"
          data-testid="onedrive-reconnect-button"
          onClick={() => openBackupConnectorManagePage(oneDriveStatusQuery.data?.manageUrl ?? null)}
          className="ml-1.5 inline-flex items-center gap-1 text-[11px] font-semibold underline"
        >
          Reconnect a different account
        </button>
      )}
      <div className="mt-1.5">{oneDriveRefreshButton}</div>
    </div>
  ) : (
    <div className="break-words rounded-md border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[11px] leading-snug text-amber-800 dark:text-amber-300" data-testid="onedrive-status-disconnected">
      <p className="font-semibold mb-0.5">OneDrive is not connected</p>
      <p>
        {oneDriveStatusQuery.data?.userMessage ?? "OneDrive is not connected. Connect the Microsoft integration or reconnect the account, then check again."}{" "}
        {oneDriveStatusQuery.data?.manageUrl
          ? "Use Connect OneDrive to open the LabTrax hosting workspace and link a Microsoft account (Integrations \u2192 OneDrive), then check again here."
          : "Connect the Microsoft OneDrive integration in the LabTrax hosting workspace (Replit \u2192 Integrations \u2192 OneDrive), then check again."}
      </p>
      {oneDriveStatusQuery.data?.diagnostic && (
        <details className="mt-1 text-[11px]">
          <summary className="cursor-pointer">Connection details</summary>
          <p className="mt-1 whitespace-pre-wrap break-words">{oneDriveStatusQuery.data.diagnostic}</p>
        </details>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-3">
        {oneDriveStatusQuery.data?.manageUrl && (
          <button
            type="button"
            data-testid="onedrive-connect-button"
            onClick={() => openBackupConnectorManagePage(oneDriveStatusQuery.data?.manageUrl ?? null)}
            className="inline-flex items-center gap-1 rounded border border-amber-500/60 bg-amber-100 dark:bg-amber-900/40 px-2 py-1 text-[11px] font-semibold"
          >
            Connect OneDrive
          </button>
        )}
        {oneDriveRefreshButton}
      </div>
    </div>
  );

  const googleDriveRefreshButton = (
    <button
      type="button"
      data-testid="google-drive-check-again-button"
      onClick={() => refetchGoogleDriveStatus()}
      disabled={googleDriveStatusQuery.isFetching}
      className="inline-flex items-center gap-1 text-[11px] font-semibold underline disabled:opacity-60"
    >
      {googleDriveStatusQuery.isFetching ? "Checking…" : "Check again"}
    </button>
  );

  const googleDriveNotice = googleDriveStatusQuery.isPending ? (
    <div className="flex min-w-0 items-center gap-2 break-words text-[11px] text-muted-foreground">
      <Loader2 size={11} className="animate-spin" />
      Checking Google Drive connection…
    </div>
  ) : googleDriveStatusQuery.isError ? (
    <div
      className="break-words rounded-md border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[11px] leading-snug text-amber-800 dark:text-amber-300"
      data-testid="google-drive-status-error"
    >
      <p className="font-semibold mb-0.5">Could not check Google Drive</p>
      <p>
        {googleDriveStatusQuery.error instanceof Error
          ? googleDriveStatusQuery.error.message
          : "The connection-status request failed."}{" "}
        This does not mean the Google account is disconnected.
      </p>
      <div className="mt-1.5">{googleDriveRefreshButton}</div>
    </div>
  ) : googleDriveStatusQuery.data?.connected ? (
    <div
      className="break-words rounded-md border border-success/40 bg-success/10 px-3 py-2 text-[11px] leading-snug text-success"
      data-testid="google-drive-status-connected"
    >
      Google Drive connected
      {googleDriveStatusQuery.data.accountName || googleDriveStatusQuery.data.accountEmail
        ? ` as ${googleDriveStatusQuery.data.accountName ?? ""}${googleDriveStatusQuery.data.accountEmail ? ` (${googleDriveStatusQuery.data.accountEmail})` : ""}`
        : ""}
      . Backups are saved to <span className="font-mono">{googleDriveStatusQuery.data.folder}</span> in that account.
      {googleDriveStatusQuery.data.manageUrl && (
        <button
          type="button"
          data-testid="google-drive-reconnect-button"
          onClick={() => openBackupConnectorManagePage(googleDriveStatusQuery.data?.manageUrl ?? null)}
          className="ml-1.5 inline-flex items-center gap-1 text-[11px] font-semibold underline"
        >
          Reconnect a different account
        </button>
      )}
      <div className="mt-1.5">{googleDriveRefreshButton}</div>
    </div>
  ) : (
    <div
      className="break-words rounded-md border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[11px] leading-snug text-amber-800 dark:text-amber-300"
      data-testid="google-drive-status-disconnected"
    >
      <p className="font-semibold mb-0.5">Google Drive is not connected</p>
      <p>
        {googleDriveStatusQuery.data?.error ??
          "No usable Google Drive connection was reported by the server."}{" "}
        {googleDriveStatusQuery.data?.manageUrl
          ? "Use Connect Google Drive to open the LabTrax hosting workspace and link a Google account (Integrations → Google Drive), then check again here. A desktop browser may not complete account linking."
          : "Connect the Google Drive integration in the LabTrax hosting workspace (Replit → Integrations → Google Drive), then check again."}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-3">
        {googleDriveStatusQuery.data?.manageUrl && (
          <button
            type="button"
            data-testid="google-drive-connect-button"
            onClick={() => openBackupConnectorManagePage(googleDriveStatusQuery.data?.manageUrl ?? null)}
            className="inline-flex items-center gap-1 rounded border border-amber-500/60 bg-amber-100 dark:bg-amber-900/40 px-2 py-1 text-[11px] font-semibold"
          >
            Connect Google Drive
          </button>
        )}
        {googleDriveRefreshButton}
      </div>
    </div>
  );

  // Freshness follows the archive confirmed present off-site. The database
  // watermark is only consulted when off-site protection is switched off:
  // during the eighteen-day outage the watermark was the figure shown here,
  // and it said nothing was wrong.
  const offsiteFreshness = scheduleQuery.data?.offsite ?? null;
  const offsiteWatched = offsiteFreshness?.enabled === true;
  const stale = offsiteWatched
    ? offsiteFreshness?.stale === true
    : isBackupStale(scheduleQuery.data?.lastSuccessfulBackupAt ?? null, scheduleQuery.data?.staleAfterDays ?? DEFAULT_BACKUP_STALE_DAYS);
  const lastBackupAt = scheduleQuery.data?.lastSuccessfulBackupAt ?? null;
  const confirmedArchiveAgeMinutes = offsiteWatched
    ? (offsiteFreshness?.ageMinutes ?? null)
    : lastBackupAt
      ? Math.round((Date.now() - new Date(lastBackupAt).getTime()) / 60000)
      : null;
  const undeliveredAlert: BackupAlertAttempt | null =
    scheduleQuery.data?.alertDelivery?.undelivered ?? null;

  // Most recent local-folder run — if it's an error and there's no newer success,
  // surface a targeted banner so the admin knows why backups are failing.
  const lastLocalRun = historyQuery.data?.runs?.find((r) => r.destination === "local") ?? null;
  const lastLocalError = lastLocalRun?.status === "error" ? lastLocalRun : null;

  return (
    <PanelShell title="Backup & Recovery" subtitle="Manage encrypted backups and recovery destinations.">
      <div data-testid="backup-page-content" className="flex min-w-0 flex-col gap-3">
      {!gate.blocked && (
        <section
          data-testid="backup-summary"
          aria-label="Backup status summary"
          className="rounded-lg border border-border bg-card p-3"
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Recovery readiness</p>
              <p data-testid="backup-source-label" className="mt-1 text-sm font-semibold">
                Database source: {scheduleQuery.data?.sourceEnvironment === "production" ? "Production" :
                  scheduleQuery.data?.sourceEnvironment === "development" ? "Development" : "Not confirmed by this server"}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Backups use this server's database and files. Changing destinations does not switch the source.
              </p>
            </div>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
              (scheduleQuery.data?.enabled || scheduleQuery.data?.offsite?.enabled) && !stale
                ? "bg-success/10 text-success"
                : "bg-warning/15 text-amber-800 dark:text-amber-300"
            } max-w-full flex-wrap whitespace-normal`} data-testid="backup-summary-health">
              <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${(scheduleQuery.data?.enabled || scheduleQuery.data?.offsite?.enabled) && !stale ? "bg-success" : "bg-warning"}`} />
              {scheduleQuery.isLoading
                ? "Checking status"
                : stale
                  ? "Recovery point needs attention"
                  : scheduleQuery.data?.enabled
                    ? "Automatic backups active"
                    : scheduleQuery.data?.offsite?.enabled
                      ? "Off-site protection active"
                      : "Automatic backups paused"}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="min-w-0 rounded-md border border-border/70 bg-muted/25 px-3 py-2.5" data-testid="backup-summary-latest">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Latest confirmed backup</p>
              <p className="mt-1 truncate text-sm font-semibold text-foreground">
                {scheduleQuery.isLoading
                  ? "Checking…"
                  : offsiteWatched
                    ? offsiteFreshness?.lastVerifiedAt
                      ? formatDateTime(offsiteFreshness.lastVerifiedAt)
                      : "No confirmed off-site backup"
                    : lastBackupAt
                      ? formatDateTime(lastBackupAt)
                      : "No successful complete backup"}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {confirmedArchiveAgeMinutes == null
                  ? (scheduleQuery.data?.offsite?.databaseProtection ? "No production records/media point confirmed" : "No complete recovery point confirmed")
                  : `${scheduleQuery.data?.offsite?.databaseProtection ? "Production point verified (check coverage)" : "Confirmed"} ${formatBackupAge(confirmedArchiveAgeMinutes)} ago`}
              </p>
            </div>
            <div className="min-w-0 rounded-md border border-border/70 bg-muted/25 px-3 py-2.5" data-testid="backup-summary-upcoming">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Next scheduled backup</p>
              <p className="mt-1 truncate text-sm font-semibold text-foreground">
                {scheduleQuery.isLoading
                  ? "Checking…"
                  : scheduleQuery.data?.enabled
                    ? scheduleQuery.data.nextDueAt
                      ? formatDateTime(scheduleQuery.data.nextDueAt)
                      : "Runs automatically"
                    : scheduleQuery.data?.offsite?.enabled
                      ? "Off-site protection active"
                      : "Not scheduled"}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {scheduleQuery.data?.enabled
                  ? describeIntervalMinutes(scheduleQuery.data.effectiveIntervalMinutes) ?? "Automatic schedule enabled"
                  : scheduleQuery.data?.offsite?.enabled
                    ? describeIntervalMinutes(scheduleQuery.data.offsite.intervalMinutes) ?? "Automatic off-site protection"
                    : "Enable a schedule below to protect new work"}
              </p>
            </div>
            <div className="min-w-0 rounded-md border border-border/70 bg-muted/25 px-3 py-2.5" data-testid="backup-summary-destination">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Backup destination</p>
              <p className="mt-1 break-words text-sm font-semibold text-foreground">
                {scheduleQuery.isLoading ? "Checking…" : describeBackupDestination(serverDestination)}
              </p>
              <p className="mt-0.5 break-words text-[11px] text-muted-foreground" title={scheduleQuery.data?.path ?? undefined}>
                {scheduleQuery.data?.path || (serverDestination === "onedrive" ? "Off-site recovery storage" : serverDestination === "google-drive" ? "Connected Google Drive storage" : "Destination path not configured")}
              </p>
            </div>
          </div>
          {!scheduleQuery.isLoading && stale && (
            <div className="mt-2 flex flex-wrap items-start gap-2 rounded-md border border-amber-400/40 bg-amber-50 px-3 py-2 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1 text-xs leading-snug space-y-0.5">
                <p className="font-semibold" data-testid="backup-stale-headline">
                  {confirmedArchiveAgeMinutes === null
                    ? "No backup archive has been confirmed"
                    : `No backup confirmed for ${formatBackupAge(confirmedArchiveAgeMinutes)}`}
                </p>
                <p className="text-amber-700 dark:text-amber-400">
                  {offsiteFreshness?.reason ??
                    (lastBackupAt
                      ? "The last successful backup on record is older than the allowed window."
                      : "A successful backup has never been run for this lab.")}
                </p>
                {offsiteWatched && offsiteFreshness?.source === "database" && (
                  <p className="text-amber-700/80 dark:text-amber-400/80">
                    This is based on the last run recorded here — the backup folder itself could not
                    be read.
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => void runManualBackup()}
                disabled={manualBackupRunning || (needsPath(nowDest) && !nowPath.trim() && !!electron?.saveBackupToFolder)}
                className="shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs font-semibold bg-amber-200 hover:bg-amber-300 text-amber-900 dark:bg-amber-800 dark:hover:bg-amber-700 dark:text-amber-100 disabled:opacity-60 transition-colors"
              >
                {backupNowMutation.isPending
                  ? <><Loader2 size={11} className="animate-spin" />Backing up…</>
                  : <><Download size={11} />Run backup now</>}
              </button>
            </div>
          )}
        </section>
      )}

      {scheduleQuery.data?.offsite?.databaseProtection && (
        <section className="rounded-md border bg-card p-4 space-y-2" data-testid="database-protection-status">
          <h3 className="font-semibold text-sm">Production records and media · OneDrive · every 15 minutes</h3>
          <p className="text-xs text-muted-foreground">
            {scheduleQuery.data.offsite.databaseProtection.mode === "incremental-records-and-media"
              ? "Protects changed records and files after a verified baseline, retaining previous versions."
              : "Fresh consistent database exports plus encrypted content reuse for pictures, attachments, videos and other production files."}
            No development database or application source is uploaded. A long verification skips overlapping intervals.
          </p>
          <p className="text-sm font-medium">
            {scheduleQuery.data.offsite.stale && scheduleQuery.data.offsite.databaseProtection.state === "verified"
              ? "Overdue — prior point verified" : scheduleQuery.data.offsite.databaseProtection.state.replaceAll("_", " ")}
            {" · "}{scheduleQuery.data.offsite.databaseProtection.stage}
            {" · "}{scheduleQuery.data.offsite.databaseProtection.coverage === "partial" ? "Partial protection — missing originals" : "Complete coverage"}
          </p>
          <p className="text-xs">
            Last verified production point: {scheduleQuery.data.offsite.databaseProtection.lastVerifiedAt
              ? formatDateTime(scheduleQuery.data.offsite.databaseProtection.lastVerifiedAt) : "None"}.
            {" "}Last dependency check: {scheduleQuery.data.offsite.databaseProtection.lastDestinationCheckAt
              ? formatDateTime(scheduleQuery.data.offsite.databaseProtection.lastDestinationCheckAt) : "Not confirmed"}.
            {" "}New chunks: {scheduleQuery.data.offsite.databaseProtection.newChunks};
            {" "}reused chunks: {scheduleQuery.data.offsite.databaseProtection.reusedChunks};
            {" "}new encrypted bytes: {scheduleQuery.data.offsite.databaseProtection.newBytes.toLocaleString()}.
            {" "}Media files: {scheduleQuery.data.offsite.databaseProtection.mediaFiles};
            {" "}missing originals: {scheduleQuery.data.offsite.databaseProtection.missingFiles}.
          </p>
          {scheduleQuery.data.offsite.databaseProtection.error && (
            <p role="alert" className="text-xs text-destructive">{scheduleQuery.data.offsite.databaseProtection.error}</p>
          )}
          <p className="text-xs text-amber-700 dark:text-amber-400">
            A verified partial point preserves records and readable files but is not complete recovery.
            Missing-original inventories remain inside the encrypted recovery point. Full records/media recovery points and their dependencies remain retained.
            Approved database-only retention applies to legacy standalone database points, preserving the newest two verified points, every chunk referenced by retained manifests,
            {` ${scheduleQuery.data.databaseRetention?.keepAllWithinHours ?? 24} hours of points, hourly points for ${scheduleQuery.data.databaseRetention?.keepHourlyWithinDays ?? 7} days, daily points for ${scheduleQuery.data.databaseRetention?.keepDailyWithinDays ?? 30} days, and all objects inside a ${scheduleQuery.data.databaseRetention?.safetyGraceHours ?? 48}-hour safety grace period.`}
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-xs text-muted-foreground" data-testid="database-retention-status">
              Retention cleanup: <strong>{scheduleQuery.data.databaseRetention?.enabled ? "approved and enabled" : "disabled"}</strong>
              {scheduleQuery.data.databaseRetention?.status && (
                <> · {scheduleQuery.data.databaseRetention.status.state.replaceAll("_", " ")}
                  {scheduleQuery.data.databaseRetention.status.pendingObjects > 0
                    ? ` · ${scheduleQuery.data.databaseRetention.status.pendingObjects} objects remaining`
                    : ""}
                </>
              )}
            </span>
            {scheduleQuery.data.databaseRetention?.enabled ? (
              <button
                type="button"
                onClick={() => databaseRetentionMutation.mutate(false)}
                disabled={databaseRetentionMutation.isPending || gate.blocked}
                className="h-8 rounded-md border border-border px-3 text-xs font-medium hover:bg-muted disabled:opacity-60"
                data-testid="button-pause-database-retention"
              >
                {databaseRetentionMutation.isPending ? "Pausing…" : "Pause cleanup"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setRetentionApprovalOpen(true)}
                disabled={databaseRetentionMutation.isPending || gate.blocked}
                className="h-8 rounded-md border border-amber-500/50 px-3 text-xs font-medium text-amber-800 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950/30 disabled:opacity-60"
                data-testid="button-enable-database-retention"
              >
                Approve and enable cleanup
              </button>
            )}
            {databaseRetentionMutation.error && (
              <span role="alert" className="text-xs text-destructive">
                {databaseRetentionMutation.error.message}
              </span>
            )}
            {scheduleQuery.data.databaseRetention?.status?.error && (
              <span role="alert" className="text-xs text-destructive">
                {scheduleQuery.data.databaseRetention.status.error}
              </span>
            )}
          </div>
          <AlertDialog open={retentionApprovalOpen} onOpenChange={setRetentionApprovalOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Approve database retention cleanup?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes only old objects not referenced by retained verified database points. It keeps the newest two points,
                  {` ${scheduleQuery.data.databaseRetention?.keepAllWithinHours ?? 24} hours of points, hourly history for ${scheduleQuery.data.databaseRetention?.keepHourlyWithinDays ?? 7} days, daily history for ${scheduleQuery.data.databaseRetention?.keepDailyWithinDays ?? 30} days, and objects younger than ${scheduleQuery.data.databaseRetention?.safetyGraceHours ?? 48} hours.`}
                  {" "}This does not change ZIP backup retention or media backups.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={databaseRetentionMutation.isPending}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(event) => { event.preventDefault(); databaseRetentionMutation.mutate(true); }}
                  disabled={databaseRetentionMutation.isPending || gate.blocked}
                  className="bg-amber-700 text-white hover:bg-amber-800"
                  data-testid="button-confirm-database-retention"
                >
                  {databaseRetentionMutation.isPending ? "Approving…" : "Approve and enable"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </section>
      )}

      {!gate.blocked && lastLocalError && (
        <div
          className="flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/5 px-3.5 py-3 text-destructive dark:text-red-400"
          data-testid="local-backup-error-banner"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
          <div className="min-w-0 flex-1 break-words text-xs leading-snug space-y-0.5">
            <p className="font-semibold">Local folder backup failed</p>
            {lastLocalError.path && (
              <p className="text-[11px] opacity-80">
                Path: <code className="break-words font-mono">{lastLocalError.path}</code>
              </p>
            )}
            <p className="text-[11px] opacity-80 mt-0.5">
              {lastLocalError.userMessage ?? "The backup did not complete, so no new complete recovery point was created. Check the destination and failure details."}
            </p>
            {lastLocalError.error && (
              <details className="text-[11px] mt-1">
                <summary className="cursor-pointer">Failure details</summary>
                <p className="whitespace-pre-wrap break-words mt-1">{lastLocalError.error}</p>
              </details>
            )}
            <p className="text-[10px] opacity-60 mt-0.5">
              {formatDateTime(lastLocalError.completedAt)}
            </p>
          </div>
        </div>
      )}

      {/* An alert nobody could receive is its own failure — show it here
          rather than leaving it in the server log, where the last one sat. */}
      {!gate.blocked && undeliveredAlert && (
        <div
          className="flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/5 px-3.5 py-3 text-destructive dark:text-red-400"
          data-testid="backup-alert-undelivered-notice"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5"><path d="M8.7 3A6 6 0 0 1 18 8c0 2.3.4 4 1 5"/><path d="M6 8a6 6 0 0 1 .5-2.5"/><path d="M4 19h12"/><path d="m2 2 20 20"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
          <div className="min-w-0 flex-1 break-words text-xs leading-snug space-y-0.5">
            <p className="font-semibold">A backup alert could not be delivered</p>
            <p className="text-[11px] opacity-80">
              The {undeliveredAlert.channel === "email" ? "email" : "in-app"} alert raised by{" "}
              {undeliveredAlert.source} failed
              {undeliveredAlert.detail ? `: ${undeliveredAlert.detail}` : "."} Until this is fixed,
              a backup outage may go unreported.
            </p>
            <p className="text-[10px] opacity-60">{formatDateTime(undeliveredAlert.at)}</p>
          </div>
        </div>
      )}

      {gate.blocked && <PlatformAdminSetupNotice />}

      <div className="grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-2">
      {/* ── Schedule ── */}
      <div data-testid="backup-schedule-section" className="min-w-0 border border-border rounded-lg p-3.5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Clock size={14} className="shrink-0 text-muted-foreground" />
            <h3 className="min-w-0 break-words text-base font-bold">Schedule Automatic Backups</h3>
          </div>
          {scheduleQuery.data?.enabled && (
            <span className="text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded-full bg-success/15 text-success">
              Active
            </span>
          )}
        </div>
        <p className="break-words text-xs text-muted-foreground" data-testid="backup-schedule-cadence-guidance">
          {scheduleQuery.data?.sourceEnvironment === "production"
            ? "Choose the destination and interval for production backups. Google Drive and OneDrive run on the server and reuse verified encrypted records and media. Local folder / USB uses LabTrax Desktop on the selected computer; network server uses SFTP. A busy run finishes before one coalesced catch-up starts."
            : scheduleQuery.data?.sourceEnvironment === "development"
              ? "This schedule protects the Development database only. Choose its destination and interval independently of Production; Development files stay in their separate backup folder."
              : "The server has not confirmed which database this schedule would affect. Confirm the environment before changing its cadence."}
          {scheduleQuery.data?.sourceEnvironment === "production" && (
            <> Only a complete, authenticated database-and-media recovery point advances complete protection. Missing-file warnings remain visible.</>
          )}
        </p>
        {legacyIntervalChoice && (
          <p
            className="break-words rounded-md border border-amber-400/40 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
            data-testid="backup-schedule-legacy-cadence"
          >
            {scheduleQuery.data?.enabled
              ? "The enabled schedule is still set to "
              : "The saved interval is still set to "}
            {legacyIntervalChoice.interval} {legacyIntervalChoice.unit}. Select a cadence allowed for this database
            {scheduleQuery.data?.enabled ? " and save to update it. The current schedule continues until then." : " before enabling it."}
          </p>
        )}

        {/*
          Read back from the server rather than from this form's state: the
          form shows what is about to be saved, which is not evidence that any
          backup is running. The archive age comes from the destination's own
          listing, so an empty folder cannot look healthy.
        */}
        {!scheduleQuery.isLoading && scheduleQuery.data && (
          <div
            className="break-words rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-[11px] leading-relaxed"
            data-testid="backup-server-status"
          >
            <div className="flex flex-wrap gap-x-4 gap-y-0.5">
              <span data-testid="backup-effective-interval">
                <span className="text-muted-foreground">Server cadence: </span>
                <span className="font-semibold">
                  {describeIntervalMinutes(scheduleQuery.data.effectiveIntervalMinutes) ??
                    (scheduleQuery.data.enabled ? "not configured" : "paused")}
                </span>
                {scheduleQuery.data.offsite?.running && scheduleQuery.data.offsite.enabled && (
                  <span className="text-muted-foreground"> (off-site protection)</span>
                )}
              </span>
              <span data-testid="backup-effective-destination">
                <span className="text-muted-foreground">Destination: </span>
                <span className="font-semibold">
                  {describeBackupDestination(
                    scheduleQuery.data.effectiveDestination ?? scheduleQuery.data.destination,
                  )}
                </span>
              </span>
              {!scheduleQuery.data.offsite?.databaseProtection && serverDestination === "onedrive" &&
                describeIntervalMinutes(scheduleQuery.data.fullArchiveIntervalMinutes) && (
                  <span data-testid="backup-full-archive-interval">
                    <span className="text-muted-foreground">Full backup (with media): </span>
                    <span className="font-semibold">
                      every scheduled run (all durable files)
                    </span>
                  </span>
                )}
            </div>
            {(serverDestination === "onedrive" || serverDestination === "google-drive") && (
              <div className="mt-1" data-testid="backup-newest-archive">
                {scheduleQuery.data.newestArchiveError ? (
                  <div className="text-destructive dark:text-red-400">
                    <span>{scheduleQuery.data.newestArchiveErrorMessage ?? `LabTrax could not verify ${describeBackupDestination(serverDestination)}. A complete recovery point could not be confirmed.`}</span>
                    {scheduleQuery.data.newestArchiveErrorDiagnostic && (
                      <details className="mt-1">
                        <summary className="cursor-pointer">Failure details</summary>
                        <span className="block whitespace-pre-wrap">{scheduleQuery.data.newestArchiveErrorDiagnostic}</span>
                      </details>
                    )}
                  </div>
                ) : scheduleQuery.data.newestArchive ? (
                  <>
                    <span className="text-muted-foreground">Newest recovery point in {describeBackupDestination(serverDestination)}: </span>
                    <span className="font-semibold">
                      {describeAgeMinutes(scheduleQuery.data.newestArchive.ageMinutes)}
                    </span>
                    <span className="text-muted-foreground">
                      {" "}
                      ({scheduleQuery.data.newestArchive.name}
                      {scheduleQuery.data.archiveCount
                        ? `, ${scheduleQuery.data.archiveCount} kept`
                        : ""}
                      )
                    </span>
                  </>
                ) : (
                  <span className="text-destructive dark:text-red-400">
                    No complete recovery point confirmed in {describeBackupDestination(serverDestination)}.
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {schedError && !gate.blocked && <Alert tone="danger">{schedError}</Alert>}
        {schedSuccess && <Alert tone="success">Schedule saved.</Alert>}

        {scheduleQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={13} className="animate-spin" />
            Loading…
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Interval">
                <select
                  value={schedIntervalKey}
                  onChange={(e) => setSchedIntervalKey(e.target.value)}
                  disabled={!scheduleQuery.data?.sourceEnvironment}
                  className={inputCls}
                  data-testid="backup-schedule-interval"
                >
                  {legacyIntervalChoice && legacyIntervalLabel && (
                    <option value={schedIntervalKey}>{legacyIntervalLabel}</option>
                  )}
                  {scheduleIntervalChoices.map((opt) => (
                    <option key={intervalKey(opt.interval, opt.unit)} value={intervalKey(opt.interval, opt.unit)}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Destination">
                <select
                  value={schedDest}
                  data-testid="backup-schedule-destination"
                  onChange={(e) => setSchedDest(e.target.value as BackupDestinationType)}
                  className={inputCls}
                >
                  <option value="local">Local folder / USB</option>
                  <option value="network">Local server / network (SFTP)</option>
                  <option value="onedrive">OneDrive</option>
                  <option value="google-drive">Google Drive</option>
                </select>
              </Field>
            </div>

            {needsPath(schedDest) && (
              <div className="space-y-1.5">
                <div className="flex min-w-0 gap-2 items-end">
                  <div className="min-w-0 flex-1">
                    <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                      {schedDest === "local" ? "Folder path" : "Network path (SFTP URL)"}
                    </label>
                    <input
                      value={schedPath}
                      onChange={(e) => setSchedPath(e.target.value)}
                      placeholder={schedDest === "local" ? "C:\\Backups\\LabTrax" : "sftp://user@host/backups/LabTrax"}
                      className={inputCls}
                    />
                  </div>
                  {electron?.showFolderDialog && schedDest === "local" && (
                    <button
                      type="button"
                      onClick={() => pickFolderFor(setSchedPath)}
                      className="h-9 px-3 rounded-md border border-border bg-secondary text-foreground text-xs font-medium hover:bg-secondary/80 shrink-0"
                    >
                      Browse…
                    </button>
                  )}
                </div>
                {schedDest === "network" && schedPath.trim() && !schedPath.trim().startsWith("sftp://") && (
                  <div className="flex items-start gap-1.5 rounded-md border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-amber-800 dark:text-amber-300">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
                    <p className="text-[11px] leading-snug">
                      UNC/SMB paths can't be used for scheduled backups — the server runs on Linux and can't access Windows network shares. Use an SFTP URL (<span className="font-mono">sftp://user@host/path</span>) for scheduled network backups. For UNC shares, use <strong>Back up now</strong> instead.
                    </p>
                  </div>
                )}
                {schedDest === "network" && !schedPath.trim() && (
                  <p className="text-[11px] text-muted-foreground leading-snug">
                    Only SFTP URLs are supported for scheduled backups. Use <span className="font-mono">sftp://user@host/path</span>.
                  </p>
                )}
              </div>
            )}

            {/* Local-folder schedules run from the per-user Desktop companion */}
            {schedDest === "local" && (
              <div className="flex min-w-0 items-start gap-2.5 rounded-md border border-border bg-secondary/50 px-3.5 py-3" data-testid="sched-local-desktop-notice">
                <ShieldCheck size={13} className="shrink-0 mt-0.5 text-muted-foreground" />
                <div className="min-w-0 break-words text-xs leading-snug space-y-1">
                  <p className="font-semibold">Runs from this computer's backup companion</p>
                  <p className="text-muted-foreground">
                    Local folder / USB backups are written by LabTrax Desktop on this computer. When this schedule is
                    enabled, Desktop stays in the system tray after its window closes and can start with your laptop
                    account. Runs pause while the laptop is asleep, shut down, signed out, or the selected folder is
                    missing or not writable. Create and connect the destination folder before the scheduled time.
                  </p>
                </div>
              </div>
            )}

            {/* Warn when the scheduled destination can't be reached from the server */}
            {schedDest === "network" && !!schedPath.trim() && !schedPath.trim().startsWith("sftp://") && (
              <div className="flex min-w-0 items-start gap-2.5 rounded-md border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 px-3.5 py-3 text-amber-800 dark:text-amber-300">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
                <div className="min-w-0 break-words text-xs leading-snug space-y-1">
                  <p className="font-semibold">Scheduled backups can't write to this destination</p>
                  <p className="text-amber-700 dark:text-amber-400">
                    UNC/SMB network paths (\\server\share) exist on your Windows network, but scheduled backups run on the server (Linux) where those paths aren't mounted.
                    {" "}Use an <strong>SFTP URL</strong> (<code className="font-mono">sftp://user@host/path</code>), <strong>OneDrive</strong>, <strong>Google Drive</strong>, or a <strong>local folder</strong> (written by this desktop app while it is open).
                  </p>
                </div>
              </div>
            )}

            {schedDest === "onedrive" && oneDriveNotice}
            {schedDest === "google-drive" && googleDriveNotice}

            {/* Warn when network destination path looks like SFTP but is missing required fields */}
            {schedDest === "network" && schedPath.trim().startsWith("sftp://") && (
              <p className="text-[11px] text-muted-foreground">
                SFTP: authenticate via SSH key. Embedded passwords are not supported.
              </p>
            )}

            <div>
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Warn me if backup is older than (days)
              </label>
              <input
                type="number"
                min={1}
                max={365}
                value={schedStaleDays}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (Number.isFinite(v) && v >= 1) setSchedStaleDays(v);
                }}
                className={inputCls + " w-28"}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Alert after (days without backup)">
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={staleThresholdDays}
                  onChange={(e) => setStaleThresholdDays(Math.max(1, Math.min(365, parseInt(e.target.value, 10) || 7)))}
                  className={inputCls}
                />
              </Field>
              <Field label="Re-alert at most every (days)">
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={staleRateLimitDays}
                  onChange={(e) => setStaleRateLimitDays(Math.max(1, Math.min(365, parseInt(e.target.value, 10) || 3)))}
                  className={inputCls}
                />
              </Field>
            </div>

            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={schedEnabled}
                onChange={(e) => setSchedEnabled(e.target.checked)}
                className="accent-primary"
              />
              Enable automatic backups
            </label>
          </div>
        )}

        <div className="flex items-center gap-2 pt-1 flex-wrap">
          <button
            type="button"
            onClick={() => saveScheduleMutation.mutate()}
            disabled={
              saveScheduleMutation.isPending ||
              scheduleQuery.isLoading ||
              gate.blocked ||
              (schedEnabled && needsPath(schedDest) && !schedPath.trim()) ||
              (schedEnabled && schedDest === "google-drive" && !googleDriveStatusQuery.data?.connected) ||
              (schedEnabled && schedDest === "network" && !!schedPath.trim() && !schedPath.trim().startsWith("sftp://"))
            }
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-2"
          >
            {saveScheduleMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : null}
            {saveScheduleMutation.isPending ? "Saving…" : "Save schedule"}
          </button>
          {scheduleQuery.data?.enabled && (
            <button
              type="button"
              onClick={() => disableScheduleMutation.mutate()}
              disabled={disableScheduleMutation.isPending || gate.blocked}
              className="h-9 px-3 rounded-md border border-border text-sm text-muted-foreground hover:text-foreground disabled:opacity-60"
            >
              Disable
            </button>
          )}
          {scheduleQuery.data?.enabled &&
            (scheduleQuery.data?.destination === "onedrive" ||
              scheduleQuery.data?.destination === "google-drive" ||
              (scheduleQuery.data?.destination === "network" &&
                !!scheduleQuery.data?.path?.startsWith("sftp://"))) && (
              <button
                type="button"
                onClick={() => {
                  setSchedRunNowResult(null);
                  setSchedRunNowError(null);
                  schedRunNowMutation.mutate();
                }}
                disabled={
                  schedRunNowMutation.isPending ||
                  gate.blocked ||
                  (scheduleQuery.data?.destination === "google-drive" && (
                    googleDriveStatusQuery.isError ||
                    googleDriveStatusQuery.isPending ||
                    !googleDriveStatusQuery.data?.connected
                  ))
                }
                className="h-9 px-3 rounded-md border border-border text-sm text-muted-foreground hover:text-foreground disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {schedRunNowMutation.isPending
                  ? <><Loader2 size={13} className="animate-spin" />Running…</>
                  : <><Play size={13} />Run now</>}
              </button>
            )}
        </div>

        {schedRunNowResult && !gate.blocked && (
          <Alert tone={schedRunNowResult.partialFailure ? "warning" : "success"}>
            {schedRunNowResult.partialFailure
              ? "Schedule test completed with warnings"
              : "Schedule test complete"}{" "}
            — {formatBackupSize(schedRunNowResult.size)} saved as{" "}
            <code className="font-mono text-xs">{schedRunNowResult.fileName}</code>.
            {schedRunNowResult.partialFailure && (
              <span className="block mt-1 text-xs">
                {schedRunNowResult.warningMessage ?? "The backup finished, but some content was left out. This is not a complete recovery point, and restoring it will not recover the missing content."}
                {schedRunNowResult.warnings && (
                  <details className="mt-1">
                    <summary className="cursor-pointer">Failure details</summary>
                    <span className="block whitespace-pre-wrap">{schedRunNowResult.warnings}</span>
                  </details>
                )}
              </span>
            )}
          </Alert>
        )}
        {schedRunNowError && !gate.blocked && (
          <Alert tone="danger">{schedRunNowError}</Alert>
        )}
      </div>

      {/* ── Back up now ── */}
      <div data-testid="backup-manual-section" className="min-w-0 border border-border rounded-lg p-3.5 space-y-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ShieldCheck size={14} className="text-muted-foreground" />
          <h3 className="min-w-0 break-words text-base font-bold">Production Data Backup</h3>
          <span className="ml-auto inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 text-[10px] font-semibold text-success">
            <ShieldCheck size={11} />
            Encrypted archive
          </span>
        </div>
        <p className="break-words text-xs text-muted-foreground">
          Saves your live lab records and original files: cases, notes, patients, doctors, invoices, payments, pictures, videos, documents, and other lab uploads. Application code and UI changes are managed separately in GitHub.
        </p>

        {scheduledBackupProgress && !gate.blocked && (
          <div
            role="status"
            className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground space-y-1"
            data-testid="scheduled-backup-live-progress"
          >
            <p>
              <span className="font-semibold text-foreground">Scheduled Desktop backup</span>
              {" — "}
              {scheduledBackupProgress.liveStatus &&
              (scheduledBackupProgress.liveStatus.state === "running" ||
                scheduledBackupProgress.liveStatus.state === "awaiting_verification")
                ? backupLivePhaseLabel(scheduledBackupProgress.liveStatus.phase)
                : scheduledBackupProgress.phase}
              {" — "}
              {scheduledElapsedSeconds}s elapsed. Keep this window open.
            </p>
            {scheduledBackupProgress.liveStatus && (
              <p className="flex flex-wrap gap-x-3 gap-y-1" data-testid="scheduled-backup-live-metrics">
                {backupLiveProgressText(scheduledBackupProgress.liveStatus)}
                {backupLiveMediaText(scheduledBackupProgress.liveStatus)}
              </p>
            )}
          </div>
        )}
        <label className="block text-xs font-medium">
          Backup contents
          <select aria-label="Backup contents" value={nowArchiveKind}
            disabled={manualBackupRunning}
            onChange={(event) => { setNowArchiveKind(event.target.value as "full" | "database-only"); setBackupResult(null); }}
            className="mt-1 block h-9 w-full rounded-md border border-border bg-background px-2">
            <option value="full">Production records + original files (recommended)</option>
            <option value="database-only">Advanced: records only — excludes pictures, videos and files</option>
          </select>
        </label>
        {nowArchiveKind === "full" && (
          <p role="note" className="break-words text-xs text-muted-foreground">
            Includes the database and original media stored outside it. Large backups can take several hours. Missing originals are listed in the encrypted archive and make the backup incomplete; a warning is not a complete recovery point.
          </p>
        )}
        {nowArchiveKind === "database-only" && (
          <p role="note" className="break-words text-xs text-amber-700">
            Preserves database records and file references, but excludes file bytes. Missing originals remain unresolved.
            This does not establish complete recovery or reset complete-backup freshness. Normal in-app restore refuses database-only archives.
          </p>
        )}
        {backupResult?.databaseOnly && (
          <Alert tone="warning">Database-only backup delivered. Media is excluded; complete recovery is not verified.</Alert>
        )}
        {manualProgress.state === "cancelled" && !gate.blocked && (
          <Alert tone="warning">Backup cancelled. Incomplete output was discarded; no successful backup was recorded.</Alert>
        )}
        {backupError && manualProgress.state !== "cancelled" && !gate.blocked && <Alert tone="danger">{backupError}</Alert>}
        {manualReconnectUnconfirmed && manualProgress.runId && !gate.blocked && (
          <button
            type="button"
            onClick={() => void retryManualBackupReconnect()}
            className="h-8 px-3 rounded-md border border-border text-xs font-medium hover:bg-muted/50"
          >
            Retry backup reconnection
          </button>
        )}
        {manualBackupRunning && (
          <div role="status" className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground space-y-1" data-testid="backup-live-progress">
            <div className="flex items-center justify-between font-medium text-foreground">
              <span>Overall progress</span>
              <span data-testid="backup-overall-percent">
                {backupLiveStatus?.state === "completed"
                  ? 100
                  : Math.max(0, Math.min(99, backupLiveStatus?.overallProgress ?? 0))}%
              </span>
            </div>
            <BackupProgressBar status={backupLiveStatus} />
            <p>{backupPhase || "Processing backup"} — {backupElapsedSeconds}s elapsed.</p>
            {backupLiveStatus && (
              <p className="flex flex-wrap gap-x-3 gap-y-1" data-testid="backup-live-metrics">
                {backupLiveProgressText(backupLiveStatus)}
                {backupLiveMediaText(backupLiveStatus)}
              </p>
            )}
          </div>
        )}
        {manualProgress.state === "running" && manualProgress.liveStatus?.delivery && !gate.blocked && (
          <button
            type="button"
            onClick={() => void resumeStagedDelivery()}
            disabled={resumeDeliveryPending || backupNowMutation.isPending}
            className="h-9 px-3 rounded-md border border-primary/40 bg-primary/5 text-primary text-xs font-medium hover:bg-primary/10 disabled:opacity-60"
            data-testid="resume-manual-backup-download"
          >
            {resumeDeliveryPending ? "Preparing download…" : "Download this backup"}
          </button>
        )}
        {manualBackupRunning && manualProgress.liveStatus?.state !== "finalizing" && !gate.blocked && (
          <button
            type="button"
            onClick={() => void cancelManualBackup()}
            disabled={cancelPending}
            className="h-9 px-3 rounded-md border border-destructive/40 text-destructive text-xs font-medium hover:bg-destructive/5 disabled:opacity-60"
            data-testid="cancel-manual-backup"
          >
            {cancelPending ? "Cancelling…" : "Cancel backup"}
          </button>
        )}
        {backupResult && (
          <Alert tone={backupResult.partialFailure ? "warning" : "success"}>
            {backupResult.databaseOnly ? "Database-only backup delivered; media excluded." : backupResult.partialFailure ? "Incomplete backup — original files are missing" : "Backup complete."} —{" "}
            {formatBackupSize(backupResult.size)}{" "}
            {backupResult.viaBrowser ? (
              <>
                downloaded by your browser as{" "}
                <code className="font-mono text-xs">{backupResult.fileName}</code>. Check your
                browser's downloads folder.
              </>
            ) : backupResult.savedTo ? (
              <>
                saved to{" "}
                <code className="font-mono text-xs">{backupResult.savedTo}</code>.
              </>
            ) : (
              <>
                saved as{" "}
                <code className="font-mono text-xs">{backupResult.fileName}</code>.
              </>
            )}{" "}
            <span className="opacity-70">{formatDateTime(backupResult.completedAt)}</span>
            {backupResult.partialFailure && (
              <span className="block mt-1 text-xs">
                {backupResult.warningMessage ?? "The backup finished, but some content was left out. This is not a complete recovery point, and restoring it will not recover the missing content."}
                {backupResult.warnings && (
                  <details className="mt-1">
                    <summary className="cursor-pointer">Failure details</summary>
                    <span className="block whitespace-pre-wrap">{backupResult.warnings}</span>
                  </details>
                )}
              </span>
            )}
          </Alert>
        )}

        <div className="space-y-3">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-2">Destination</div>
            <div className="grid min-w-0 grid-cols-2 gap-2 2xl:grid-cols-4" data-testid="backup-destination-choices">
              {(["local", "network", "onedrive", "google-drive"] as const).map((d) => (
                <label key={d} className={`flex min-h-10 min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-xs font-medium cursor-pointer transition-colors ${
                  nowDest === d ? "border-primary bg-primary/5 text-foreground ring-1 ring-primary/20" : "border-border bg-background text-muted-foreground hover:bg-muted/40"
                }`}>
                  <input
                    type="radio"
                    name="now-destination"
                    value={d}
                    checked={nowDest === d}
                    onChange={() => { setNowDest(d); setBackupResult(null); setBackupError(null); }}
                    className="shrink-0 accent-primary"
                  />
                  <span className="min-w-0 break-words">{d === "local"
                    ? "Local folder / USB"
                    : d === "network"
                      ? "Network server"
                      : d === "onedrive"
                        ? "OneDrive"
                        : "Google Drive"}</span>
                </label>
              ))}
            </div>
          </div>

          {nowDest === "local" && !electron?.saveBackupToFolder && !electron?.downloadBackupToFolder && (
            <p className="text-xs text-muted-foreground">
              Choose your USB drive in the browser's save dialog. If that dialog is unavailable,
              the file downloads through your browser. Scheduled USB backups require the signed-in Desktop app.
            </p>
          )}
          {needsPath(nowDest) && (nowDest !== "local" || !!electron?.saveBackupToFolder || !!electron?.downloadBackupToFolder) && (
            <div className="space-y-1.5">
              {!electron?.saveBackupToFolder && nowDest === "local" && (
                <div className="rounded-md border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[11px] leading-snug text-amber-800 dark:text-amber-300">
                  You're using LabTrax in a web browser. Browsers can't save files
                  to a specific folder like <span className="font-mono">E:\Lab Software\LabTrax Backup</span>.
                  Either install and open the LabTrax Desktop app to save to a chosen
                  folder, or clear the folder path below to download the backup file
                  through your browser instead.
                </div>
              )}
              <div className="flex min-w-0 gap-2 items-end">
                <div className="min-w-0 flex-1">
                  <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                    {nowDest === "local" ? "Folder path" : "Network path (UNC/SMB or SFTP URL)"}
                  </label>
                  <input
                    value={nowPath}
                    onChange={(e) => setNowPath(e.target.value)}
                    placeholder={nowDest === "local" ? "C:\\Backups\\LabTrax" : "\\\\server\\share\\LabTrax  or  sftp://user@host/backups"}
                    className={inputCls}
                  />
                </div>
                {electron?.showFolderDialog && nowDest === "local" && (
                  <button
                    type="button"
                    onClick={() => pickFolderFor(setNowPath)}
                    className="h-9 px-3 rounded-md border border-border bg-secondary text-foreground text-xs font-medium hover:bg-secondary/80 shrink-0"
                  >
                    Browse…
                  </button>
                )}
              </div>
              {nowDest === "network" && nowPath.trim() && (
                <p className="text-[11px] text-muted-foreground leading-snug">
                  {nowPath.trim().startsWith("sftp://")
                    ? "SFTP — the file will be uploaded by the server directly to this location."
                    : "UNC/SMB — the file will be saved by this desktop app directly. The app must be open when you click Back up now."}
                </p>
              )}
              {nowDest === "network" && !nowPath.trim() && (
                <p className="text-[11px] text-muted-foreground leading-snug">
                  Use <span className="font-mono">\\server\share\LabTrax</span> for a network share (saved by this app) or <span className="font-mono">sftp://user@host/path</span> for SFTP (saved by the server).
                </p>
              )}
            </div>
          )}

          {nowDest === "onedrive" && oneDriveNotice}
          {nowDest === "google-drive" && googleDriveNotice}
        </div>

        <button
          type="button"
          onClick={() => void runManualBackup()}
          disabled={
            manualBackupRunning ||
            manualReconnectUnconfirmed ||
            (!!user?.id && !manualProgress.runId && !!loadManualBackupIdentity(user.id)) ||
            gate.blocked ||
            (needsPath(nowDest) && !nowPath.trim() && !!electron?.saveBackupToFolder) ||
            (nowDest === "onedrive" && (
              oneDriveStatusQuery.isError ||
              oneDriveStatusQuery.isPending ||
              !oneDriveStatusQuery.data?.connected
            )) ||
            (nowDest === "google-drive" && (
              googleDriveStatusQuery.isError ||
              googleDriveStatusQuery.isPending ||
              !googleDriveStatusQuery.data?.connected
            ))
          }
          className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-2"
        >
          {manualBackupRunning ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          {manualBackupRunning ? "Backing up…" : "Back up now"}
        </button>
      </div>

      </div>

      {/* ── Recent backups ── */}
      <div data-testid="backup-history-section" className="min-w-0 border border-border rounded-lg p-3.5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <History size={14} className="text-muted-foreground" />
            <h3 className="text-base font-bold">Recent Backups</h3>
          </div>
          <button
            type="button"
            onClick={() => historyQuery.refetch()}
            disabled={historyQuery.isFetching}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {historyQuery.isFetching ? <Loader2 size={11} className="animate-spin inline" /> : "Refresh"}
          </button>
        </div>

        {/* Retention policy */}
        <div className="border border-border/60 rounded-md p-3 bg-muted/20 space-y-2">
          <p className="text-xs font-medium text-muted-foreground">History retention</p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Keep for (days)</label>
              <input
                type="number"
                min={1}
                value={retentionDaysInput}
                onChange={(e) => setRetentionDaysInput(e.target.value)}
                disabled={retentionQuery.isLoading || gate.blocked}
                className="w-24 h-8 rounded-md border border-border bg-background px-2 text-xs disabled:opacity-50"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Max rows</label>
              <input
                type="number"
                min={1}
                value={maxRowsInput}
                onChange={(e) => setMaxRowsInput(e.target.value)}
                disabled={retentionQuery.isLoading || gate.blocked}
                className="w-24 h-8 rounded-md border border-border bg-background px-2 text-xs disabled:opacity-50"
              />
            </div>
            <button
              type="button"
              onClick={() => saveRetentionMutation.mutate()}
              disabled={
                saveRetentionMutation.isPending ||
                retentionQuery.isLoading ||
                gate.blocked ||
                !retentionDaysInput ||
                !maxRowsInput ||
                isNaN(parseInt(retentionDaysInput, 10)) ||
                isNaN(parseInt(maxRowsInput, 10)) ||
                parseInt(retentionDaysInput, 10) < 1 ||
                parseInt(maxRowsInput, 10) < 1
              }
              className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
            >
              {saveRetentionMutation.isPending ? <Loader2 size={11} className="animate-spin" /> : null}
              {saveRetentionMutation.isPending ? "Saving…" : "Save"}
            </button>
            {retentionSaved && (
              <span className="text-xs text-success flex items-center gap-1">
                <Check size={11} />
                Saved
              </span>
            )}
          </div>
          {saveRetentionMutation.isError && (
            <p className="text-xs text-destructive">
              {saveRetentionMutation.error instanceof Error
                ? saveRetentionMutation.error.message
                : "Failed to save retention settings."}
            </p>
          )}
          <p className="text-[10px] text-muted-foreground">
            Older entries are pruned automatically after each backup run. Whichever limit removes more rows wins.
          </p>
        </div>

        {historyQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={13} className="animate-spin" />
            Loading…
          </div>
        ) : historyQuery.isError ? (
          <p className="text-xs text-destructive">Could not load backup history.</p>
        ) : !historyQuery.data?.runs?.length ? (
          <p className="text-xs text-muted-foreground">No backups recorded yet. Run your first backup above.</p>
        ) : (
          <>
          <div
            className="max-w-full overflow-x-auto rounded-md border border-border/70"
            role="region"
            aria-label="Recent backup history"
            tabIndex={0}
            data-testid="backup-history-scroll-region"
          >
            <table className="w-full min-w-[920px] text-xs border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-1.5 pr-2 font-medium text-muted-foreground">Select for restore</th>
                  <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground">Status</th>
                  <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground">When</th>
                  <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground">Destination</th>
                  <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground">Size</th>
                  <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground">File</th>
                  <th className="text-left py-1.5 font-medium text-muted-foreground">Triggered by</th>
                </tr>
              </thead>
              <tbody>
                {historyQuery.data.runs.map((run) => {
                  const isSftp = run.destination === "sftp";
                  const isGoogleDrive = run.destination === "google-drive";
                  const isChecked = selectedRestoreRunId === run.id;
                  return (
                    <tr key={run.id} className="border-b border-border/50 last:border-0 hover:bg-muted/30">
                      <td className="py-1.5 pr-2 align-top">
                        <span
                          title={
                            isSftp
                              ? "SFTP backups must be restored via the file picker below."
                              : isGoogleDrive
                                ? "Google Drive backups cannot be restored directly from history yet."
                                : undefined
                          }
                        >
                          <input
                            type="checkbox"
                            disabled={isSftp || isGoogleDrive}
                            checked={isChecked}
                            onChange={() => {
                              setRestoreFromHistoryError(null);
                              setSelectedRestoreRunId(isChecked ? null : run.id);
                            }}
                            aria-label={`Select backup from ${formatDateTime(run.completedAt)}`}
                            className="accent-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                          />
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 align-top">
                        <div className="flex flex-col gap-0.5 items-start">
                          {run.status === "success" ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-success/15 text-success">
                              <Check size={9} />
                              OK
                            </span>
                          ) : run.error?.includes("unreachable from the server") ? (
                            <span
                              className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 cursor-help"
                              title={
                                (run.userMessage ?? "This backup was skipped.") +
                                "\n\nTo fix this, update the scheduled destination in the Schedule section above."
                              }
                            >
                              Skipped
                            </span>
                          ) : (
                            <span
                              className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-destructive/15 text-destructive cursor-help"
                              title={run.userMessage ?? "The backup did not complete. Open Failure details for more information."}
                            >
                              Error
                            </span>
                          )}
                          {run.status === "error" && run.error && (
                            <div className="max-w-sm text-[11px] text-destructive">
                              <p>{run.userMessage ?? "The backup did not complete, so no new complete recovery point was created."}</p>
                              <details className="mt-1">
                                <summary className="cursor-pointer">Failure details</summary>
                                <p className="whitespace-pre-wrap break-words mt-1">{run.error}</p>
                              </details>
                            </div>
                          )}
                          {run.status === "success" &&
                            run.attachmentRowCount != null &&
                            run.attachmentRowCount > 0 &&
                            run.mediaFileCount != null &&
                            run.mediaFileCount === 0 && (
                            <span
                              className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 cursor-help"
                              title={`This backup has ${run.attachmentRowCount} live attachment row(s) recorded in the database but no media files were found in uploads/case-media at backup time.`}
                            >
                              No media
                            </span>
                          )}
                          {run.status === "success" && run.partialFailure && (
                            <span
                              className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 cursor-help"
                              title={
                                run.warnings ??
                                "This backup completed but had to drop part of the payload — check the server logs for details."
                              }
                            >
                              Partial
                            </span>
                          )}
                          {run.status === "success" &&
                            run.mediaFileCount == null &&
                            run.attachmentRowCount == null && (
                            <span
                              className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground cursor-help"
                              title="This backup was created before media-file tracking was added. Media content cannot be verified from this record alone."
                            >
                              No metrics
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-1.5 pr-3 align-top whitespace-nowrap text-muted-foreground">
                        {formatDateTime(run.completedAt)}
                      </td>
                      <td className="py-1.5 pr-3 align-top capitalize">
                        {run.destination === "google-drive" ? "Google Drive" : run.destination}
                        {run.path && (
                          <span className="block max-w-[240px] break-words whitespace-normal text-[10px] text-muted-foreground font-mono" title={run.path}>
                            {run.path}
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 align-top whitespace-nowrap">
                        {run.sizeBytes != null ? formatBackupSize(run.sizeBytes) : "—"}
                      </td>
                      <td className="py-1.5 pr-3 align-top max-w-[160px]" title={run.fileName ?? undefined}>
                        <span className="block font-mono truncate">{run.fileName ?? "—"}</span>
                        {isDatabaseOnlyRun(run) && (
                          <span
                            className="mt-0.5 inline-block rounded bg-amber-500/15 px-1 py-px text-[10px] font-semibold text-amber-700 dark:text-amber-400"
                            data-testid="backup-run-database-only"
                          >
                            Database only — no media
                          </span>
                        )}
                        {!isDatabaseOnlyRun(run) && (
                          <span
                            className="mt-0.5 inline-block rounded bg-muted px-1 py-px text-[10px] font-semibold"
                            data-testid="backup-run-coverage"
                          >
                            {run.partialFailure ? "Partial — not complete protection" :
                              run.archiveKind === "complete-production" ? "Complete production database + all files" :
                              run.archiveKind === "complete-non-production" ? "Complete non-production — not production protection" :
                              "Historical full — narrower/unverified coverage"}
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 align-top text-muted-foreground">
                        {run.triggeredBy}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ── Restore from This Point button ── */}
          {(() => {
            const selectedRun = selectedRestoreRunId != null
              ? historyQuery.data.runs.find((r) => r.id === selectedRestoreRunId) ?? null
              : null;
            const isWarning = selectedRun != null && selectedRun.status !== "success";
            const isDatabaseOnly = selectedRun != null && isDatabaseOnlyRun(selectedRun);
            return (
              <div className="pt-3 space-y-1.5">
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    type="button"
                    disabled={selectedRestoreRunId == null || restoreFromHistoryLoading || isDatabaseOnly}
                    onClick={async () => {
                      if (selectedRun == null) return;
                      if (isDatabaseOnlyRun(selectedRun)) {
                        // Restoring one of these would replace the database and
                        // leave every case photo behind. The server refuses it
                        // too; refusing here avoids a pointless download first.
                        setRestoreFromHistoryError(
                          "This is a database-only archive — it contains no case media. Choose a full backup to restore from.",
                        );
                        return;
                      }
                      setRestoreFromHistoryError(null);
                      setRestoreFromHistoryLoading(true);
                      try {
                        let file: File;
                        if (selectedRun.destination === "local" || selectedRun.destination === "network") {
                          const electron = typeof window !== "undefined"
                            ? (window as ElectronWindow).electronAPI
                            : null;
                          if (!electron?.readLocalFile) {
                            throw new Error("File reading is not supported in this version of LabTrax Desktop.");
                          }
                          if (!selectedRun.path) {
                            throw new Error("This backup run has no local file path recorded.");
                          }
                          const result = await electron.readLocalFile(selectedRun.path);
                          if (!result.ok || !result.buffer) {
                            throw new Error(result.error || "Could not read the backup file from disk.");
                          }
                          const name = selectedRun.fileName ?? selectedRun.path.replace(/\\/g, "/").split("/").pop() ?? "backup.zip.enc";
                          file = new File([new Uint8Array(result.buffer)], name, { type: "application/octet-stream" });
                        } else if (selectedRun.destination === "onedrive") {
                          const { buffer } = await apiFetchArrayBuffer(
                            `/admin/backup/history/${selectedRun.id}/download`,
                          );
                          const name = selectedRun.fileName ?? "backup.zip.enc";
                          file = new File([new Uint8Array(buffer)], name, { type: "application/octet-stream" });
                        } else {
                          throw new Error("This backup type cannot be restored directly.");
                        }
                        setPreloadedFile(file);
                      } catch (err: unknown) {
                        setRestoreFromHistoryError(
                          err instanceof Error ? err.message : "Failed to load the backup file.",
                        );
                      } finally {
                        setRestoreFromHistoryLoading(false);
                      }
                    }}
                    className="h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
                  >
                    {restoreFromHistoryLoading ? (
                      <><Loader2 size={13} className="animate-spin" />Loading…</>
                    ) : (
                      <><RotateCcw size={13} />Restore from This Point</>
                    )}
                  </button>
                  {isDatabaseOnly ? (
                    <span className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                      <AlertTriangle size={11} />
                      Database-only archive — contains no case media. Pick a full backup to restore.
                    </span>
                  ) : isWarning ? (
                    <span className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                      <AlertTriangle size={11} />
                      This backup ended with an error — restore may be incomplete.
                    </span>
                  ) : null}
                </div>
                {restoreFromHistoryError && (
                  <p className="text-xs text-destructive">{restoreFromHistoryError}</p>
                )}
              </div>
            );
          })()}
          </>
        )}
      </div>

      {/* ── Restore from backup ── */}
      <div data-testid="backup-restore-section" className="min-w-0">
        <RestoreSection
          gate={gate}
          scheduleData={scheduleQuery.data ?? null}
          queryClient={queryClient}
          preloadedFile={preloadedFile}
          onPreloadConsumed={() => setPreloadedFile(null)}
        />
      </div>
      <LabScopedBackupCard />
      </div>
    </PanelShell>
  );
}

type RestorePhase = "idle" | "uploading" | "validating" | "decrypting" | "restoring_db" | "clearing_sessions" | "restoring_media" | "done" | "error";

const RESTORE_PHASE_LABELS: Record<RestorePhase, string> = {
  idle: "Idle",
  uploading: "Uploading…",
  validating: "Validating…",
  decrypting: "Decrypting…",
  restoring_db: "Restoring database…",
  clearing_sessions: "Clearing sessions…",
  restoring_media: "Restoring media files…",
  done: "Done",
  error: "Error",
};

const RESTORE_PHASE_STEP: Record<RestorePhase, number> = {
  idle: 0,
  uploading: 1,
  validating: 2,
  decrypting: 3,
  restoring_db: 4,
  clearing_sessions: 5,
  restoring_media: 6,
  done: 7,
  error: 0,
};

function RestoreSection({
  gate,
  scheduleData,
  queryClient,
  preloadedFile,
  onPreloadConsumed,
}: {
  gate: { blocked: boolean };
  scheduleData: { destination?: string | null; enabled?: boolean } | null;
  queryClient: ReturnType<typeof useQueryClient>;
  preloadedFile?: File | null;
  onPreloadConsumed?: () => void;
}) {
  const electron = typeof window !== "undefined"
    ? (window as ElectronWindow).electronAPI
    : null;

  const [open, setOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmStep, setConfirmStep] = useState<1 | 2>(1);
  const [restorePhase, setRestorePhase] = useState<RestorePhase>("idle");
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreDiagnostic, setRestoreDiagnostic] = useState<string | null>(null);
  const [restoreSuccess, setRestoreSuccess] = useState(false);
  const [relaunchCountdown, setRelaunchCountdown] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const openConfirm = useCallback(() => {
    setConfirmStep(1);
    setRestoreError(null);
    setRestoreDiagnostic(null);
    setRestoreSuccess(false);
    setShowConfirm(true);
  }, []);

  useEffect(() => {
    if (!preloadedFile) return;
    setSelectedFile(preloadedFile);
    openConfirm();
    onPreloadConsumed?.();
  }, [preloadedFile, openConfirm, onPreloadConsumed]);

  const cancelRelaunch = useCallback(() => {
    if (countdownTimerRef.current !== null) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setRelaunchCountdown(null);
  }, []);

  useEffect(() => {
    if (!restoreSuccess || typeof electron?.relaunch !== "function") return;
    setRelaunchCountdown(3);
    const tick = setInterval(() => {
      setRelaunchCountdown((c) => {
        if (c === null) return null;
        if (c <= 1) {
          clearInterval(tick);
          countdownTimerRef.current = null;
          electron!.relaunch!();
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    countdownTimerRef.current = tick;
    return () => {
      clearInterval(tick);
      countdownTimerRef.current = null;
    };
  }, [restoreSuccess, electron]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res = await apiFetch<{ phase: RestorePhase; message: string | null; diagnosticMessage?: string | null }>("/admin/backup/restore/status");
        setRestorePhase(res.phase);
        setRestoreMessage(res.message);
        if (res.phase === "done") {
          stopPolling();
          setRestoreSuccess(true);
          queryClient.invalidateQueries({ queryKey: ["admin", "backup-history"] });
        } else if (res.phase === "error") {
          stopPolling();
          setRestoreError(res.message || "Restore failed.");
          setRestoreDiagnostic(res.diagnosticMessage ?? null);
        }
      } catch {
        // polling errors are transient; keep trying
      }
    }, 1500);
  }, [stopPolling, queryClient]);

  async function pickFileElectron() {
    if (!electron?.showOpenDialog) return;
    const filePaths = await electron.showOpenDialog({
      title: "Choose backup file",
      filters: [{ name: "LabTrax Backup", extensions: ["zip.enc", "enc"] }],
      properties: ["openFile"],
    });
    if (!filePaths || filePaths.length === 0) return;
    const filePath = filePaths[0];
    // Read the file via IPC — renderer security policy blocks file:// reads.
    if (!electron?.readLocalFile) {
      setRestoreError("File reading is not supported in this version of LabTrax Desktop. Please update the app.");
      return;
    }
    const result = await electron.readLocalFile(filePath);
    if (!result.ok || !result.buffer) {
      setRestoreError(result.error || "Could not read the selected file.");
      return;
    }
    const name = filePath.replace(/\\/g, "/").split("/").pop() ?? "backup.zip.enc";
    // Copy into a new Uint8Array to ensure a concrete ArrayBuffer (the IPC
    // channel may return a Uint8Array backed by a SharedArrayBuffer, which
    // File() doesn't accept in strict TS targets).
    const file = new File([new Uint8Array(result.buffer)], name, { type: "application/octet-stream" });
    setSelectedFile(file);
  }

  function handleNativeFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    if (f) {
      setSelectedFile(f);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }


  async function runRestore() {
    if (!selectedFile) return;
    setShowConfirm(false);
    setRestorePhase("uploading");
    setRestoreMessage("Uploading backup file…");
    setRestoreError(null);
    setRestoreSuccess(false);
    const CHUNK_SIZE = 1 * 1024 * 1024; // 1 MB — proven safe through the Replit proxy
    try {
      // Create a restore upload session on the server.
      const session = await createRestoreUploadSession({
        fileName: selectedFile.name,
        fileSize: selectedFile.size,
      });
      const { sessionId } = session;
      // Upload the file in 1 MB chunks.
      let offset = 0;
      while (offset < selectedFile.size) {
        const chunk = selectedFile.slice(offset, offset + CHUNK_SIZE);
        const result = await sendRestoreUploadChunk(sessionId, chunk, offset);
        offset = result.uploadedBytes;
        if (result.complete) break;
      }
      // Final chunk sent — server has received the file and started the restore
      // pipeline asynchronously (202). Begin polling for progress.
      startPolling();
    } catch (err: unknown) {
      stopPolling();
      const msg = err instanceof Error ? err.message : "Restore failed.";
      setRestorePhase("error");
      setRestoreError(msg);
    }
  }

  const isRunning = restorePhase !== "idle" && restorePhase !== "done" && restorePhase !== "error";
  const stepCount = 6;
  const step = RESTORE_PHASE_STEP[restorePhase];

  return (
    <>
      <div className="border border-border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-foreground hover:bg-muted/30 transition-colors"
        >
          <div className="flex items-center gap-2">
            <RotateCcw size={14} className="text-muted-foreground" />
            Restore from backup
          </div>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {open && (
          <div className="px-4 pb-4 space-y-4 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              Restore all lab data from a LabTrax <code className="font-mono">.zip.enc</code> backup file.{" "}
              <strong className="text-destructive">All current data and media will be replaced.</strong>
            </p>
            <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-300/50 rounded px-2 py-1.5">
              ⚠ All users currently signed in will be logged out after restore completes.
            </p>

            {restoreSuccess && (
              <div className="rounded-md bg-success/10 border border-success/30 px-3 py-2 text-xs text-success font-medium space-y-2">
                <div>
                  Restore complete. Please sign in again.
                  {relaunchCountdown !== null && relaunchCountdown > 0 && (
                    <span className="ml-1">(Relaunching in {relaunchCountdown}…)</span>
                  )}
                  {relaunchCountdown === null && typeof electron?.relaunch !== "function" && (
                    <span className="ml-1">Please restart the app manually.</span>
                  )}
                </div>
                {typeof electron?.relaunch === "function" && (
                  <div className="flex items-center gap-2">
                    {relaunchCountdown !== null && relaunchCountdown > 0 && (
                      <button
                        type="button"
                        onClick={cancelRelaunch}
                        className="rounded px-2 py-0.5 text-xs font-semibold border border-success/40 bg-success/10 hover:bg-success/20 text-success transition-colors"
                      >
                        Cancel relaunch
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => electron!.relaunch!()}
                      className="rounded px-2 py-0.5 text-xs font-semibold border border-success/40 bg-success/20 hover:bg-success/30 text-success transition-colors"
                    >
                      Relaunch now
                    </button>
                  </div>
                )}
              </div>
            )}
            {restoreError && (
              <Alert tone="danger">
                {restoreError}
                {restoreDiagnostic && (
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer">Failure details</summary>
                    <p className="mt-1 whitespace-pre-wrap break-words">{restoreDiagnostic}</p>
                  </details>
                )}
              </Alert>
            )}

            {isRunning && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground font-medium">{RESTORE_PHASE_LABELS[restorePhase]}</span>
                  <span className="text-muted-foreground">{step}/{stepCount}</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-500 rounded-full"
                    style={{ width: `${Math.min(100, (step / stepCount) * 100)}%` }}
                  />
                </div>
                {restoreMessage && (
                  <p className="text-[11px] text-muted-foreground">{restoreMessage}</p>
                )}
              </div>
            )}

            {!isRunning && !restoreSuccess && (
              <div className="space-y-3">
                {/* File source */}
                <div className="space-y-2">
                  {/* Local file */}
                  <div className="flex items-center gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".enc,.zip.enc"
                      className="hidden"
                      onChange={handleNativeFileChange}
                    />
                    <button
                      type="button"
                      disabled={gate.blocked}
                      onClick={() => {
                        if (electron?.showOpenDialog) {
                          void pickFileElectron();
                        } else {
                          fileInputRef.current?.click();
                        }
                      }}
                      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border bg-background text-xs font-medium hover:bg-secondary disabled:opacity-60"
                    >
                      <Upload size={12} />
                      Choose backup file…
                    </button>
                    {selectedFile && (
                      <span className="text-xs text-muted-foreground font-mono truncate max-w-[180px]" title={selectedFile.name}>
                        {selectedFile.name}
                      </span>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  disabled={gate.blocked || !selectedFile || isRunning}
                  onClick={() => openConfirm()}
                  className="h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 disabled:opacity-60 inline-flex items-center gap-2"
                >
                  <RotateCcw size={13} />
                  Restore
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Confirmation modal ── */}
      {showConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowConfirm(false)}
        >
          <div
            className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            {confirmStep === 1 ? (
              <>
                <div className="space-y-1">
                  <h3 className="text-base font-semibold text-destructive">⚠ Replace all data?</h3>
                  <p className="text-sm text-muted-foreground">
                    Restoring this backup will <strong>permanently overwrite</strong> all current lab data, including:
                  </p>
                </div>
                <ul className="text-sm text-muted-foreground list-disc list-inside space-y-0.5">
                  <li>All cases, patients, and doctors</li>
                  <li>All invoices and financial records</li>
                  <li>All media file attachments</li>
                  <li>All users and organization settings</li>
                </ul>
                <p className="text-xs text-muted-foreground border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 rounded px-2 py-1.5">
                  Source: <strong>{selectedFile?.name ?? "selected file"}</strong>
                </p>
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowConfirm(false)}
                    className="h-9 px-4 rounded-md border border-border text-sm hover:bg-secondary"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmStep(2)}
                    className="h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90"
                  >
                    I understand — continue
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1">
                  <h3 className="text-base font-semibold text-destructive">Final confirmation</h3>
                  <p className="text-sm text-muted-foreground">
                    Are you absolutely sure? This action cannot be undone. All current data will be replaced.
                  </p>
                </div>
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowConfirm(false)}
                    className="h-9 px-4 rounded-md border border-border text-sm hover:bg-secondary"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void runRestore()}
                    className="h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90"
                  >
                    Yes, restore now
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

interface MobileBuildInfo {
  iosBuildNumber: string | null;
  androidVersionCode: number | null;
  expoVersion: string | null;
  appJsonError: string | null;
  repoUrl: string | null;
  repoOwner: string | null;
  repoName: string | null;
  tokenConfigured: boolean;
  lastTrigger: {
    platform: string;
    profile: string;
    triggeredAt: string;
    triggeredByUsername: string;
  } | null;
  latestRun: {
    id: number;
    status: string;
    conclusion: string | null;
    html_url: string;
    created_at: string;
  } | null;
  versionHistory: {
    version: string;
    changedByUsername: string;
    changedAt: string;
  }[];
}

type BuildRunStatus = "pending" | "queued" | "running" | "success" | "failed" | "cancelled" | "unknown";

function getBuildRunStatus(run: MobileBuildInfo["latestRun"], hasTrigger: boolean): BuildRunStatus {
  if (!run) return hasTrigger ? "pending" : "unknown";
  if (run.status === "queued") return "queued";
  if (run.status === "in_progress") return "running";
  if (run.status === "completed") {
    if (run.conclusion === "success") return "success";
    if (run.conclusion === "cancelled") return "cancelled";
    return "failed";
  }
  return "unknown";
}

function isTerminalRunStatus(status: BuildRunStatus): boolean {
  return status === "success" || status === "failed" || status === "cancelled";
}

function BuildRunStatusBadge({ run, hasTrigger }: { run: MobileBuildInfo["latestRun"]; hasTrigger: boolean }) {
  const status = getBuildRunStatus(run, hasTrigger);
  const configs: Record<BuildRunStatus, { label: string; cls: string; icon: React.ReactNode }> = {
    pending: {
      label: "Pending",
      cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
      icon: <Loader2 size={11} className="shrink-0 animate-spin" />,
    },
    queued: {
      label: "Queued",
      cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
      icon: <Clock size={11} className="shrink-0" />,
    },
    running: {
      label: "Running",
      cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
      icon: <Loader2 size={11} className="shrink-0 animate-spin" />,
    },
    success: {
      label: "Success",
      cls: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400",
      icon: <Check size={11} className="shrink-0" />,
    },
    failed: {
      label: "Failed",
      cls: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
      icon: <RefreshCcw size={11} className="shrink-0" />,
    },
    cancelled: {
      label: "Cancelled",
      cls: "bg-secondary text-muted-foreground",
      icon: <Clock size={11} className="shrink-0" />,
    },
    unknown: {
      label: "Unknown",
      cls: "bg-secondary text-muted-foreground",
      icon: <Clock size={11} className="shrink-0" />,
    },
  };
  if (status === "unknown") return null;
  const { label, cls, icon } = configs[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {icon}
      {label}
    </span>
  );
}

interface MobileBuildRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

interface MobileBuildStatus {
  run: MobileBuildRun | null;
}

function isTerminalState(run: MobileBuildRun | null | undefined): boolean {
  return run?.status === "completed";
}

function BuildStatusBadge({ run }: { run: MobileBuildRun | null }) {
  if (!run) return null;

  const { status, conclusion } = run;

  let label: string;
  let cls: string;
  let dotCls: string;

  if (status === "queued") {
    label = "Queued";
    cls = "bg-yellow-50 text-yellow-700 border-yellow-200";
    dotCls = "bg-yellow-400";
  } else if (status === "in_progress") {
    label = "In progress";
    cls = "bg-blue-50 text-blue-700 border-blue-200";
    dotCls = "bg-blue-500 animate-pulse";
  } else if (status === "completed") {
    if (conclusion === "success") {
      label = "Success";
      cls = "bg-green-50 text-green-700 border-green-200";
      dotCls = "bg-green-500";
    } else if (conclusion === "failure") {
      label = "Failed";
      cls = "bg-red-50 text-red-700 border-red-200";
      dotCls = "bg-red-500";
    } else if (conclusion === "cancelled") {
      label = "Cancelled";
      cls = "bg-gray-50 text-gray-600 border-gray-200";
      dotCls = "bg-gray-400";
    } else {
      label = conclusion ?? "Completed";
      cls = "bg-gray-50 text-gray-600 border-gray-200";
      dotCls = "bg-gray-400";
    }
  } else {
    label = status;
    cls = "bg-gray-50 text-gray-600 border-gray-200";
    dotCls = "bg-gray-400";
  }

  return (
    <a
      href={run.htmlUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border ${cls} hover:opacity-80 transition-opacity`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dotCls}`} />
      {label}
      <ExternalLink size={9} className="opacity-60" />
    </a>
  );
}

function MobileBuildPanel() {
  const queryClient = useQueryClient();
  const [platform, setPlatform] = useState<"all" | "ios" | "android">("all");
  const [profile, setProfile] = useState<"production" | "preview" | "development">("production");
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [triggerSuccess, setTriggerSuccess] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [versionDraft, setVersionDraft] = useState<string | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [versionSuccess, setVersionSuccess] = useState(false);
  // ISO timestamp set when the user triggers a build; null when not polling.
  // Polling stays active until we observe a run whose createdAt is >= this
  // timestamp AND that run has reached a terminal state, so a pre-existing
  // completed run never prematurely stops the poll.
  const [triggerTimestamp, setTriggerTimestamp] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["admin", "mobile-build", "info"],
    queryFn: () => apiFetch<MobileBuildInfo>("/admin/mobile-build/info"),
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return false;
      const hasTrigger = data.lastTrigger !== null;
      const status = getBuildRunStatus(data.latestRun ?? null, hasTrigger);
      // Keep polling while pending (run not yet created), queued, or running.
      // Stop once a terminal state is reached (success, failed, cancelled).
      if (!hasTrigger) return false;
      return isTerminalRunStatus(status) ? false : 30_000;
    },
  });

  const versionMutation = useMutation({
    mutationFn: (version: string) =>
      apiFetch<{ ok: boolean; expoVersion: string }>("/admin/mobile-build/app-version", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      }),
    onSuccess: () => {
      setVersionError(null);
      setVersionSuccess(true);
      setVersionDraft(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "mobile-build", "info"] });
      setTimeout(() => setVersionSuccess(false), 4000);
    },
    onError: (err: Error) => {
      setVersionSuccess(false);
      setVersionError(err.message || "Failed to save version.");
    },
  });

  const isPolling = triggerTimestamp !== null;

  // Returns true when the run is for the current trigger and is in a terminal state.
  function isNewRunTerminal(run: MobileBuildRun | null | undefined, ts: string | null): boolean {
    if (!run || !ts) return false;
    return new Date(run.createdAt) >= new Date(ts) && isTerminalState(run);
  }

  const statusQuery = useQuery({
    queryKey: ["admin", "mobile-build", "status"],
    queryFn: () => apiFetch<MobileBuildStatus>("/admin/mobile-build/status"),
    enabled: !!(query.data?.tokenConfigured && query.data?.repoOwner && query.data?.repoName),
    refetchInterval: (q) => {
      if (!isPolling) return false;
      const run = q.state.data?.run;
      // Keep polling while the new run hasn't appeared yet or isn't terminal.
      if (!isNewRunTerminal(run, triggerTimestamp)) return 30_000;
      return false;
    },
  });

  const clearHistoryMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean }>("/admin/mobile-build/version-history", { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "mobile-build", "info"] });
    },
  });

  const triggerMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean; trigger: MobileBuildInfo["lastTrigger"] }>("/admin/mobile-build/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, profile }),
      }),
    onSuccess: () => {
      const ts = new Date().toISOString();
      setTriggerError(null);
      setTriggerSuccess(true);
      setTriggerTimestamp(ts);
      queryClient.invalidateQueries({ queryKey: ["admin", "mobile-build", "info"] });
      // Small delay so GitHub has time to register the new run.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["admin", "mobile-build", "status"] });
      }, 5_000);
      setTimeout(() => setTriggerSuccess(false), 4000);
    },
    onError: (err: Error) => {
      setTriggerSuccess(false);
      setTriggerError(err.message || "Failed to trigger build.");
    },
  });

  // Stop polling only once we've confirmed a run created after our trigger is terminal.
  useEffect(() => {
    if (isPolling && isNewRunTerminal(statusQuery.data?.run, triggerTimestamp)) {
      setTriggerTimestamp(null);
    }
  }, [isPolling, statusQuery.data, triggerTimestamp]);

  const mobileBuildGate = usePlatformAdminGate([
    query.error,
    versionMutation.error,
    triggerMutation.error,
  ]);

  const info = query.data;
  const repoBase = info?.repoUrl ? info.repoUrl.replace(/\/$/, "") : null;
  const actionsUrl = repoBase ? `${repoBase}/actions/workflows/eas-build.yml` : null;

  function formatTriggerTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const yyyy = d.getFullYear();
    const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `${mm}/${dd}/${yyyy}, ${timeStr}`;
  }

  const platformLabels: Record<string, string> = { all: "All (iOS + Android)", ios: "iOS only", android: "Android only" };
  const profileLabels: Record<string, string> = { production: "Production", preview: "Preview", development: "Development" };

  return (
    <PanelShell
      title="Mobile app"
      subtitle="Trigger an EAS cloud build for iOS or Android straight from this settings panel."
    >
      {mobileBuildGate.blocked && <PlatformAdminSetupNotice />}
      {query.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={13} className="animate-spin" />
          Loading…
        </div>
      )}
      {query.error && !mobileBuildGate.blocked && (
        <Alert tone="danger">{(query.error as Error).message}</Alert>
      )}
      {info && (
        <div className="space-y-5">
          {/* Build number info */}
          <div className="rounded-lg border border-border bg-secondary/30 px-5 py-4 space-y-3">
            <div className="text-sm font-semibold">Current build numbers</div>
            {info.appJsonError ? (
              <Alert tone="warning">Could not read app.json: {info.appJsonError}</Alert>
            ) : (
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">iOS build number</div>
                  <div className="text-sm font-mono font-semibold">{info.iosBuildNumber ?? "—"}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">Android version code</div>
                  <div className="text-sm font-mono font-semibold">{info.androidVersionCode ?? "—"}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">App store version</div>
                  <div className="text-sm font-mono font-semibold">{info.expoVersion ?? "—"}</div>
                </div>
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              The EAS build workflow automatically bumps iOS build number and Android version code before each build and commits the result back to{" "}
              <code className="font-mono">main</code>.
            </p>
          </div>

          {/* App store version editor */}
          {!info.appJsonError && (
            <div className="rounded-lg border border-border px-5 py-4 space-y-3">
              <div className="text-sm font-semibold">App store version string</div>
              <p className="text-[11px] text-muted-foreground">
                This is the user-visible version shown in the App Store and Google Play (e.g. <code className="font-mono">2.1.0</code>). Must be x.y.z format.
              </p>
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={versionDraft ?? info.expoVersion ?? ""}
                  onChange={(e) => setVersionDraft(e.target.value)}
                  placeholder="e.g. 2.1.0"
                  className={`${inputCls} w-36 font-mono`}
                />
                <button
                  type="button"
                  onClick={() => {
                    const v = (versionDraft ?? "").trim();
                    if (!/^\d+\.\d+\.\d+$/.test(v)) {
                      setVersionError("Version must be x.y.z (e.g. 2.1.0).");
                      return;
                    }
                    setVersionError(null);
                    versionMutation.mutate(v);
                  }}
                  disabled={versionMutation.isPending || versionDraft === null || versionDraft.trim() === "" || versionDraft.trim() === (info.expoVersion ?? "")}
                  className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
                >
                  {versionMutation.isPending ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : null}
                  {versionMutation.isPending ? "Saving…" : "Save version"}
                </button>
              </div>
              {versionError && <Alert tone="danger">{versionError}</Alert>}
              {versionSuccess && <Alert tone="success">Version updated and committed to app.json.</Alert>}
            </div>
          )}

          {/* Version change history */}
          {!info.appJsonError && info.versionHistory && info.versionHistory.length > 0 && (
            <div className="rounded-lg border border-border px-5 py-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">Version change history</div>
                <button
                  onClick={() => clearHistoryMutation.mutate()}
                  disabled={clearHistoryMutation.isPending}
                  className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md border border-border text-xs text-muted-foreground hover:text-destructive hover:border-destructive disabled:opacity-50 transition-colors"
                >
                  {clearHistoryMutation.isPending ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : null}
                  Clear history
                </button>
              </div>
              <div className="divide-y divide-border">
                {info.versionHistory.map((entry, i) => (
                  <div key={i} className="flex items-center justify-between py-2 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-semibold text-primary">{entry.version}</span>
                      <span className="text-muted-foreground text-xs">by {entry.changedByUsername}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <Clock size={10} className="inline mr-1 -mt-px" />
                      {formatTriggerTime(entry.changedAt)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Setup warnings */}
          {!info.tokenConfigured && (
            <Alert tone="warning">
              <strong>GITHUB_ACTIONS_TOKEN is not set.</strong> Add a fine-grained GitHub PAT with <em>Actions: Read and write</em> access as the <code className="font-mono">GITHUB_ACTIONS_TOKEN</code> environment secret to enable build triggering.
            </Alert>
          )}
          {(!info.repoOwner || !info.repoName) && (
            <Alert tone="warning">
              <strong>GITHUB_REPO_URL is not set or invalid.</strong> Set it to your repository URL (e.g.{" "}
              <code className="font-mono">https://github.com/your-org/your-repo</code>) so the panel knows where to dispatch the workflow.
            </Alert>
          )}

          {/* Trigger form */}
          <div className="rounded-lg border border-border px-5 py-4 space-y-4">
            <div className="text-sm font-semibold">Trigger EAS build</div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                  Platform
                </label>
                <select
                  value={platform}
                  onChange={(e) => setPlatform(e.target.value as "all" | "ios" | "android")}
                  className={inputCls}
                >
                  <option value="all">All (iOS + Android)</option>
                  <option value="ios">iOS only</option>
                  <option value="android">Android only</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                  Profile
                </label>
                <select
                  value={profile}
                  onChange={(e) => setProfile(e.target.value as "production" | "preview" | "development")}
                  className={inputCls}
                >
                  <option value="production">Production</option>
                  <option value="preview">Preview</option>
                  <option value="development">Development</option>
                </select>
              </div>
            </div>
            {triggerError && <Alert tone="danger">{triggerError}</Alert>}
            {triggerSuccess && (
              <Alert tone="success">
                Build triggered successfully. Check{" "}
                {actionsUrl ? (
                  <a href={actionsUrl} target="_blank" rel="noopener noreferrer" className="underline font-medium">
                    GitHub Actions
                  </a>
                ) : (
                  "GitHub Actions"
                )}{" "}
                to monitor progress.
              </Alert>
            )}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={triggerMutation.isPending || !info.tokenConfigured || !info.repoOwner}
                className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
              >
                {triggerMutation.isPending ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Play size={14} />
                )}
                {triggerMutation.isPending ? "Triggering…" : "Trigger EAS build"}
              </button>
              {actionsUrl && (
                <a
                  href={actionsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-input bg-background text-xs font-medium hover:bg-secondary"
                >
                  <Github size={13} />
                  View on GitHub
                  <ExternalLink size={11} className="text-muted-foreground" />
                </a>
              )}
            </div>
          </div>

          {/* Latest GitHub Actions run status */}
          {info.tokenConfigured && info.repoOwner && info.repoName && (
            <div className="rounded-lg border border-border px-5 py-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">Latest run status</div>
                <button
                  type="button"
                  onClick={() => {
                    queryClient.invalidateQueries({ queryKey: ["admin", "mobile-build", "status"] });
                  }}
                  disabled={statusQuery.isFetching}
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  <RefreshCcw size={12} className={statusQuery.isFetching ? "animate-spin" : ""} />
                  Refresh
                </button>
              </div>
              {statusQuery.isLoading && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 size={12} className="animate-spin" />
                  Loading…
                </div>
              )}
              {statusQuery.error && (
                <p className="text-xs text-muted-foreground">Could not load run status.</p>
              )}
              {statusQuery.data && !statusQuery.isLoading && (
                statusQuery.data.run ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-3">
                      <BuildStatusBadge run={statusQuery.data.run} />
                      {isPolling && !isTerminalState(statusQuery.data.run) && (
                        <span className="text-[11px] text-muted-foreground">Auto-refreshing every 30 s…</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <Clock size={11} className="inline mr-1 -mt-px" />
                      Started {formatTriggerTime(statusQuery.data.run.createdAt)}
                      {statusQuery.data.run.status === "completed" && (
                        <> · Updated {formatTriggerTime(statusQuery.data.run.updatedAt)}</>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No runs found for <code className="font-mono">eas-build.yml</code>.</p>
                )
              )}
            </div>
          )}

          {/* Build counter recovery */}
          <MobileBuildCounterRecovery repoUrl={info.repoUrl} onApplied={() => queryClient.invalidateQueries({ queryKey: ["admin", "mobile-build", "info"] })} />

          {/* Last triggered build */}
          {info.lastTrigger && (
            <div className="rounded-lg border border-border px-5 py-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold">Last triggered build</div>
                <div className="flex items-center gap-2">
                  <BuildRunStatusBadge run={info.latestRun} hasTrigger={info.lastTrigger !== null} />
                  {query.isFetching && !query.isLoading && (
                    <Loader2 size={11} className="animate-spin text-muted-foreground" />
                  )}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">Platform</div>
                  <div className="font-medium">{platformLabels[info.lastTrigger.platform] ?? info.lastTrigger.platform}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">Profile</div>
                  <div className="font-medium">{profileLabels[info.lastTrigger.profile] ?? info.lastTrigger.profile}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">Triggered by</div>
                  <div className="font-medium">{info.lastTrigger.triggeredByUsername}</div>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs text-muted-foreground">
                  <Clock size={11} className="inline mr-1 -mt-px" />
                  {formatTriggerTime(info.lastTrigger.triggeredAt)}
                </div>
                {info.latestRun && (
                  <a
                    href={info.latestRun.html_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    <Github size={11} />
                    View run
                    <ExternalLink size={10} className="text-muted-foreground" />
                  </a>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Trigger EAS build?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>This will dispatch a paid EAS cloud build with the following settings:</p>
                <div className="rounded-md border border-border bg-secondary/40 px-4 py-3 text-sm space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground w-20 shrink-0">Platform</span>
                    <span className="font-medium">{platformLabels[platform]}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground w-20 shrink-0">Profile</span>
                    <span className="font-medium">{profileLabels[profile]}</span>
                    {profile !== "production" && (
                      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                        Non-production
                      </span>
                    )}
                  </div>
                </div>
                {profile !== "production" && (
                  <p className="text-amber-600 dark:text-amber-400 text-sm">
                    You are about to start a <strong>{profileLabels[profile].toLowerCase()}</strong> build. These still consume build minutes. Make sure this is intentional.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                triggerMutation.mutate();
              }}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Yes, trigger build
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PanelShell>
  );
}

function MobileBuildCounterRecovery({
  repoUrl,
  onApplied,
}: {
  repoUrl: string | null;
  onApplied?: () => void;
}) {
  const [buildNumberInput, setBuildNumberInput] = useState("");
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applySuccess, setApplySuccess] = useState<{
    buildNumber: number;
    commitUrl: string | null;
  } | null>(null);

  const applyMutation = useMutation({
    mutationFn: (buildNumber: number) =>
      apiFetch<{
        ok: boolean;
        buildNumber: number;
        commitSha: string | null;
        commitUrl: string | null;
      }>("/admin/settings/build-counter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "mobile", buildNumber }),
      }),
    onSuccess: (data) => {
      setApplyError(null);
      setApplySuccess({ buildNumber: data.buildNumber, commitUrl: data.commitUrl });
      setBuildNumberInput("");
      onApplied?.();
      setTimeout(() => setApplySuccess(null), 8000);
    },
    onError: (err: Error) => {
      setApplySuccess(null);
      setApplyError(err.message || "Failed to apply build counter.");
    },
  });

  function handleApply() {
    const n = parseInt(buildNumberInput.trim(), 10);
    if (!buildNumberInput.trim() || Number.isNaN(n) || n < 1) {
      setApplyError("Enter a valid positive integer build number.");
      return;
    }
    setApplyError(null);
    setApplySuccess(null);
    applyMutation.mutate(n);
  }

  return (
    <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/40 dark:bg-amber-950/20 px-5 py-4 space-y-3">
      <div className="flex items-start gap-2">
        <RotateCcw size={14} className="mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
        <div>
          <div className="text-sm font-semibold">Build counter recovery</div>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
            If an EAS build exited with a warning that the counter wasn't persisted, paste the build number from the <code className="font-mono bg-secondary px-0.5 rounded">build-counter-fallback</code> artifact here. Both <code className="font-mono bg-secondary px-0.5 rounded">expo.ios.buildNumber</code> and <code className="font-mono bg-secondary px-0.5 rounded">expo.android.versionCode</code> in <code className="font-mono bg-secondary px-0.5 rounded">app.json</code> will be set to this value and committed to <code className="font-mono bg-secondary px-0.5 rounded">main</code>.
          </p>
        </div>
      </div>
      {applyError && <Alert tone="danger">{applyError}</Alert>}
      {applySuccess && (
        <Alert tone="success">
          Build counter set to <strong>{applySuccess.buildNumber}</strong> and committed to main.
          {applySuccess.commitUrl && (
            <>
              {" "}
              <a
                href={applySuccess.commitUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline font-medium"
              >
                View commit
              </a>
            </>
          )}
        </Alert>
      )}
      <div className="flex items-center gap-3">
        <input
          type="number"
          min={1}
          step={1}
          value={buildNumberInput}
          onChange={(e) => setBuildNumberInput(e.target.value)}
          placeholder="e.g. 134"
          className={`${inputCls} w-36 font-mono`}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleApply();
          }}
        />
        <button
          type="button"
          onClick={handleApply}
          disabled={applyMutation.isPending || !buildNumberInput.trim()}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700 disabled:opacity-50"
        >
          {applyMutation.isPending ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <RotateCcw size={13} />
          )}
          {applyMutation.isPending ? "Applying…" : "Apply counter"}
        </button>
        {repoUrl && (
          <a
            href={`${repoUrl.replace(/\/$/, "")}/actions`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink size={11} />
            Actions
          </a>
        )}
      </div>
    </div>
  );
}

interface SessionRow {
  id: string;
  deviceName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string | null;
  expiresAt: string;
  current: boolean;
}

function describeUserAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Safari\//.test(ua) && !/Chrome\//.test(ua)
        ? "Safari"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : "Browser";
  const os = /Windows NT/.test(ua)
    ? "Windows"
    : /Mac OS X/.test(ua)
      ? "macOS"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad|iOS/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = t - Date.now();
  const future = diff > 0;
  const absMs = Math.abs(diff);
  const min = Math.round(absMs / 60000);
  const suffix = (label: string) => (future ? `in ${label}` : `${label} ago`);
  if (min < 1) return future ? "in a moment" : "just now";
  if (min < 60) return suffix(`${min} min`);
  const hr = Math.round(min / 60);
  if (hr < 24) return suffix(`${hr} hr`);
  const day = Math.round(hr / 24);
  if (day < 30) return suffix(`${day} day${day === 1 ? "" : "s"}`);
  return formatDate(iso);
}

function SessionsPanel() {
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const sessionsQuery = useQuery({
    queryKey: ["auth", "sessions"],
    queryFn: () =>
      apiFetch<{ success: boolean; sessions: SessionRow[] } | SessionRow[]>(
        "/auth/sessions",
      ),
  });
  const list: SessionRow[] = useMemo(() => {
    const d = sessionsQuery.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    return d.sessions ?? [];
  }, [sessionsQuery.data]);

  const revokeOne = useMutation({
    mutationFn: async (id: string) => {
      return apiFetch<{ success: boolean; revokedCurrent?: boolean }>(
        `/auth/sessions/${id}`,
        { method: "DELETE" },
      );
    },
    onSuccess: async (data) => {
      setError(null);
      setInfo("Sign-in revoked.");
      if (data?.revokedCurrent) {
        notifySessionCleared();
        return;
      }
      await sessionsQuery.refetch();
      setTimeout(() => setInfo(null), 2500);
    },
    onError: (err: Error) => {
      setInfo(null);
      setError(err.message || "Could not revoke that sign-in.");
    },
  });

  const revokeOthers = useMutation({
    mutationFn: async () => {
      return apiFetch<{ success: boolean; revokedCount: number }>(
        "/auth/sessions/revoke-others",
        { method: "POST" },
      );
    },
    onSuccess: async (data) => {
      setError(null);
      setInfo(
        data?.revokedCount
          ? `Signed out of ${data.revokedCount} other ${data.revokedCount === 1 ? "device" : "devices"}.`
          : "No other sign-ins to revoke.",
      );
      await sessionsQuery.refetch();
      setTimeout(() => setInfo(null), 2500);
    },
    onError: (err: Error) => {
      setInfo(null);
      setError(err.message || "Could not sign out of other devices.");
    },
  });

  const otherCount = list.filter((s) => !s.current).length;

  return (
    <PanelShell
      title="Active sign-ins"
      subtitle="Devices currently signed in to your LabTrax account."
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {sessionsQuery.isLoading ? (
            <>
              <Loader2 size={12} className="inline animate-spin mr-2" />
              Loading…
            </>
          ) : (
            <>
              {list.length} active {list.length === 1 ? "session" : "sessions"}
            </>
          )}
        </div>
        <button
          type="button"
          onClick={() => revokeOthers.mutate()}
          disabled={revokeOthers.isPending || otherCount === 0}
          className="h-9 px-3 rounded-md bg-destructive/10 text-destructive text-xs font-semibold hover:bg-destructive/20 disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          <LogOut size={12} />
          {revokeOthers.isPending ? "Signing out…" : "Sign out everywhere else"}
        </button>
      </div>
      <div className="border border-border rounded-md divide-y divide-border">
        {!sessionsQuery.isLoading && list.length === 0 && (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            No active sign-ins.
          </div>
        )}
        {list.map((s) => (
          <div
            key={s.id}
            className="px-3 py-3 flex items-center justify-between gap-3 text-sm"
          >
            <div className="min-w-0">
              <div className="font-medium flex items-center gap-2">
                {s.deviceName || describeUserAgent(s.userAgent)}
                {s.current && (
                  <span className="text-[10px] uppercase tracking-wide bg-success/15 text-success rounded-full px-2 py-0.5">
                    This device
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 truncate">
                {describeUserAgent(s.userAgent)} · {s.ipAddress || "unknown IP"}
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                Signed in {formatRelative(s.createdAt)} · expires {formatRelative(s.expiresAt)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                if (s.current) {
                  if (!window.confirm("This is the device you're using right now. Revoking it will sign you out. Continue?")) return;
                }
                revokeOne.mutate(s.id);
              }}
              disabled={revokeOne.isPending}
              className="h-8 px-3 rounded-md text-xs font-semibold border border-border hover:bg-destructive/10 hover:text-destructive hover:border-destructive/40 disabled:opacity-50"
            >
              {s.current ? "Sign out" : "Revoke"}
            </button>
          </div>
        ))}
      </div>
    </PanelShell>
  );
}

const inputCls = "w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm";

type IteroRecentImport = {
  iteroOrderId: string;
  caseId: string | null;
  caseNumber: string | null;
  importedAt: string;
};

type IteroStatus = {
  available: boolean;
  configured: boolean;
  enabled: boolean;
  intervalMin: number;
  apiBaseUrl: string;
  labOrganizationId: string;
  providerOrganizationId: string;
  lastPollAt: string | null;
  lastError: string | null;
  importedCount: number;
  importedToday: number;
  recentImports: IteroRecentImport[];
  polling: boolean;
  authActive: boolean;
};

type IteroSetCredentialsPayload = { username: string; password: string };
type IteroSetApiConfigPayload = { apiBaseUrl?: string; labOrganizationId?: string; providerOrganizationId?: string; intervalMin?: number };
type IteroSetEnabledPayload = { enabled: boolean; intervalMin?: number };
type IteroPollResult = { ok: boolean; imported?: number; skipped?: number; total?: number; error?: string };
type IteroAPI = {
  getStatus: () => Promise<IteroStatus>;
  setCredentials: (payload: IteroSetCredentialsPayload) => Promise<IteroStatus>;
  clearCredentials: () => Promise<IteroStatus>;
  setApiConfig: (payload: IteroSetApiConfigPayload) => Promise<IteroStatus>;
  setEnabled: (payload: IteroSetEnabledPayload) => Promise<IteroStatus>;
  testLogin: () => Promise<{ ok: boolean; error?: string }>;
  pollNow: () => Promise<IteroPollResult>;
  onStatus: (cb: (s: IteroStatus) => void) => () => void;
};
type PlatformAdminStatus = {
  available: boolean;
  configured: boolean;
  savedAt: number | null;
};
type PlatformAdminTestResult = { ok: boolean; status: number; message?: string };
type PlatformAdminAPI = {
  getStatus: () => Promise<PlatformAdminStatus>;
  getSecret: () => Promise<string | null>;
  setSecret: (payload: string | { secret: string }) => Promise<PlatformAdminStatus>;
  clearSecret: () => Promise<PlatformAdminStatus>;
  testSecret: (payload: string | { apiBaseUrl: string }) => Promise<PlatformAdminTestResult>;
  onChanged: (cb: (s: PlatformAdminStatus) => void) => () => void;
};
type ElectronWindow = Window & { electronAPI?: { showFolderDialog?: () => Promise<string | null>; showOpenDialog?: (opts: { title?: string; filters?: Array<{ name: string; extensions: string[] }>; properties?: string[] }) => Promise<string[] | null>; readLocalFile?: (path: string) => Promise<{ ok: boolean; buffer?: Uint8Array; error?: string }>; relaunch?: () => void; openExternal?: (url: string) => Promise<boolean>; saveBackupToFolder?: (buffer: Uint8Array, fileName: string, folderPath: string) => Promise<{ ok: boolean; path?: string; error?: string }>; downloadBackupToFolder?: unknown; onBackupRunId?: (callback: (runId: string) => void) => () => void; itero?: IteroAPI; platformAdmin?: PlatformAdminAPI } };

function CaseDeletionPinStatus({
  securityConfigQuery,
}: {
  securityConfigQuery: ReturnType<typeof useQuery<{ ok: boolean; adminPinConfigured: boolean; adminPinIsDefault: boolean }>>;
}) {
  const data = securityConfigQuery.data;
  if (!data) return null;

  if (!data.adminPinConfigured) {
    return (
      <div className="rounded-md border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 px-3.5 py-3 text-xs">
        <div className="flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="space-y-1 text-amber-800 dark:text-amber-300">
            <p className="font-medium">Case deletion PIN not configured</p>
            <p className="leading-relaxed">
              <code className="font-mono">PLATFORM_ADMIN_PIN</code> is not set on this server.
              Admins will be unable to delete cases until it is configured.
              Add it to your Replit environment secrets and redeploy, or set a custom PIN via{" "}
              <a href="/settings?tab=platform-admin" className="underline hover:no-underline">
                Settings → Platform Admin
              </a>
              .
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (data.adminPinIsDefault) {
    return (
      <div className="rounded-md border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 px-3.5 py-3 text-xs">
        <div className="flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="space-y-1 text-amber-800 dark:text-amber-300">
            <p className="font-medium">Case deletion PIN is the insecure default</p>
            <p className="leading-relaxed">
              The admin PIN is set to the default value used in development. Set a unique{" "}
              <code className="font-mono">PLATFORM_ADMIN_PIN</code> in Replit environment secrets
              before publishing to production. The server will refuse to start with the default PIN
              in production.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-md border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30 px-3.5 py-2.5 text-xs text-green-800 dark:text-green-300">
      <ShieldCheck size={13} className="shrink-0" />
      <span>Case deletion PIN is configured.</span>
    </div>
  );
}

function PlatformAdminPanel({
  showCreatorUnlock = false,
}: {
  showCreatorUnlock?: boolean;
}) {
  const electron = typeof window !== "undefined" ? (window as ElectronWindow).electronAPI : null;
  const platformAdmin = electron?.platformAdmin;

  const [status, setStatus] = useState<PlatformAdminStatus | null>(null);
  const [secret, setSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const securityConfigQuery = useQuery({
    queryKey: ["admin-security-config"],
    queryFn: () =>
      apiFetch<{ ok: boolean; adminPinConfigured: boolean; adminPinIsDefault: boolean }>(
        "/admin/security/config",
      ),
    staleTime: 60_000,
    retry: 1,
  });

  useEffect(() => {
    if (!platformAdmin) return;
    let cancelled = false;
    platformAdmin.getStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    const off = platformAdmin.onChanged((s) => setStatus(s));
    return () => {
      cancelled = true;
      off?.();
    };
  }, [platformAdmin]);

  // Re-render when the web-view session secret changes so the panel updates
  // immediately after unlock (or after the secret is cleared).
  useSessionSecretVersion();
  const sessionSecret = getSessionSecret();

  if (!platformAdmin) {
    // Web view: the OS keychain is not available, but the admin can still
    // unlock all admin tools for this session via the in-memory secret prompt.
    // Show the unlock notice if not yet unlocked, or a confirmation + clear
    // button if already unlocked.
    return (
      <PanelShell
        title="Platform admin"
        subtitle="Unlock platform-wide admin tools for this browser session."
      >
        <div className="space-y-4">
          {sessionSecret ? (
            <div className="rounded-md border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/40 px-4 py-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="font-medium text-green-800 dark:text-green-300">
                    Admin tools unlocked for this session
                  </p>
                  <p className="text-xs text-green-700 dark:text-green-400">
                    The secret is held only in memory and will be forgotten when
                    you refresh the page. To manage the OS-keychain copy,{" "}
                    open this panel from the LabTrax Desktop app.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => clearSessionSecret()}
                  className="shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs font-medium border border-green-300 dark:border-green-700 bg-green-100 dark:bg-green-900 hover:bg-green-200 dark:hover:bg-green-800 text-green-800 dark:text-green-200 transition-colors"
                >
                  Lock
                </button>
              </div>
            </div>
          ) : (
            <PlatformAdminSetupNotice />
          )}
          <CaseDeletionPinStatus securityConfigQuery={securityConfigQuery} />
          <p className="text-xs text-muted-foreground">
            In the LabTrax Desktop app, the{" "}
            <code className="font-mono">PLATFORM_ADMIN_SECRET</code> is saved to
            the OS keychain and injected automatically. In the web view it is
            held in memory only for the current session.
          </p>
        </div>
      </PanelShell>
    );
  }

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setMessage(null);
    try {
      return await fn();
    } catch (err: any) {
      setMessage({ tone: "err", text: err?.message || String(err) });
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  const fmt = (n: number | null | undefined) => {
    if (!n) return "Never";
    const d = new Date(n);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const yyyy = d.getFullYear();
    const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `${mm}/${dd}/${yyyy}, ${timeStr}`;
  };

  return (
    <PanelShell
      title="Platform admin secret"
      subtitle="Required to call platform-wide maintenance endpoints (Media Cleanup, Backup schedule, Cleanup alerts). The secret is encrypted on this machine via the OS keychain and attached as the X-Platform-Admin-Secret header on /admin/* requests."
    >
      <div className="px-6 py-5 space-y-6">
        {showCreatorUnlock && (
          <PlatformAdminSetupNotice purpose="creator" />
        )}
        {!status?.available && (
          <Alert tone="danger">
            OS keychain is unavailable on this machine — the secret cannot be stored securely. On Linux this requires gnome-keyring or kwallet.
          </Alert>
        )}

        {message && (
          <Alert tone={message.tone === "ok" ? "success" : "danger"}>{message.text}</Alert>
        )}

        <section className="space-y-3">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Secret</h3>
          <label className="block text-sm">
            <div className="text-muted-foreground mb-1">PLATFORM_ADMIN_SECRET</div>
            <div className="relative">
              <input
                type={showSecret ? "text" : "password"}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={status?.configured ? "(saved — type to replace)" : "Paste the value of PLATFORM_ADMIN_SECRET from the API server"}
                className={`${inputCls} pr-14`}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
              >
                {showSecret ? "Hide" : "Show"}
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">
              Must exactly match the API server's <code className="font-mono">PLATFORM_ADMIN_SECRET</code> environment variable. Without it, admin maintenance panels return 403.
            </p>
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!secret.trim() || !!busy || !status?.available}
              onClick={() => run("save", async () => {
                const s = await platformAdmin.setSecret(secret.trim());
                setStatus(s);
                setSecret("");
                setShowSecret(false);
                setMessage({ tone: "ok", text: "Secret saved on this machine." });
              })}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-60"
            >
              {busy === "save" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save secret
            </button>
            <button
              type="button"
              disabled={!status?.configured || !!busy}
              onClick={() => run("test", async () => {
                const apiBase = (import.meta.env?.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "")
                  || `${window.location.origin}/api`;
                const r = await platformAdmin.testSecret({ apiBaseUrl: apiBase });
                if (r?.ok) {
                  setMessage({ tone: "ok", text: "Server accepted the secret." });
                } else {
                  setMessage({ tone: "err", text: r?.message || `Test failed (HTTP ${r?.status ?? 0}).` });
                }
              })}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-secondary text-foreground text-xs disabled:opacity-60"
            >
              {busy === "test" ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />} Test against server
            </button>
            {status?.configured && (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => run("clear", async () => {
                  const s = await platformAdmin.clearSecret();
                  setStatus(s);
                  setMessage({ tone: "ok", text: "Secret removed from this machine." });
                })}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-secondary text-foreground text-xs"
              >
                <Trash2 size={12} /> Forget secret
              </button>
            )}
          </div>
        </section>

        <section className="space-y-2 border-t border-border pt-4">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Status</h3>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
            <div className="text-muted-foreground">Stored on this machine</div>
            <div>{status?.configured ? "Yes (encrypted)" : "No"}</div>
            <div className="text-muted-foreground">Saved at</div>
            <div>{fmt(status?.savedAt)}</div>
            <div className="text-muted-foreground">OS keychain</div>
            <div>{status?.available ? "Available" : "Unavailable"}</div>
          </div>
          <p className="text-xs text-muted-foreground pt-2">
            The encrypted blob lives next to the app's other settings (under <code className="font-mono">userData/platform-admin-secret.bin</code>). Signing out clears the in-memory copy but keeps the on-disk blob, so the next sign-in still works.
          </p>
        </section>

        <section className="space-y-2 border-t border-border pt-4">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Case deletion PIN</h3>
          <CaseDeletionPinStatus securityConfigQuery={securityConfigQuery} />
          <p className="text-xs text-muted-foreground">
            Case deletion requires a separate admin PIN (<code className="font-mono">PLATFORM_ADMIN_PIN</code>).
            This is distinct from the platform admin secret above.
          </p>
        </section>
      </div>
    </PanelShell>
  );
}

interface IteroImportSession {
  batchId: string;
  importedAt: string;
  importedByUserId: string | null;
  importedByUsername: string | null;
  importedByName: string | null;
  createdCount: number;
  dedupedCount: number;
  erroredCount: number;
  totalCount: number;
  caseIds: string[];
}

function IteroAutoLinkToggle({ labOrgId }: { labOrgId: string }) {
  const qc = useQueryClient();
  const settingQuery = useQuery({
    queryKey: ["itero-auto-link-setting", labOrgId],
    queryFn: () => apiFetch<{ labOrganizationId: string; autoLinkSuggestedPractice: boolean }>(
      `/cases/itero-settings/${encodeURIComponent(labOrgId)}`,
    ),
    enabled: !!labOrgId,
  });
  const mutation = useMutation({
    mutationFn: (next: boolean) =>
      apiFetch(`/cases/itero-settings/${encodeURIComponent(labOrgId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoLinkSuggestedPractice: next }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["itero-auto-link-setting", labOrgId] });
    },
  });

  if (!labOrgId) return null;
  const enabled = !!settingQuery.data?.autoLinkSuggestedPractice;

  return (
    <label className="mt-1 flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={enabled}
        disabled={settingQuery.isLoading || mutation.isPending}
        onChange={(e) => mutation.mutate(e.target.checked)}
      />
      <span className="text-muted-foreground">
        Auto-link AI-suggested practice when the suggestion differs from the default above. Manual review is still possible — the case will show the link source as &ldquo;AI suggestion&rdquo; in the audit log.
      </span>
    </label>
  );
}

function IteroPanel() {
  const electron = (typeof window !== "undefined" ? (window as ElectronWindow).electronAPI : null);
  const itero = electron?.itero;
  const { user } = useAuth();
  const meQuery = useQuery({
    queryKey: ["me-for-itero"],
    queryFn: () => apiFetch<MeResponse>("/auth/me"),
  });

  const [status, setStatus] = useState<IteroStatus | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [labOrgId, setLabOrgId] = useState("");
  const [providerOrgId, setProviderOrgId] = useState("");
  const [intervalMin, setIntervalMin] = useState(5);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const historyQuery = useQuery<{ ok: boolean; data: { sessions: IteroImportSession[]; total: number } }>({
    queryKey: ["itero-import-history", labOrgId],
    queryFn: () => apiFetch(`/cases/itero-import-history?labOrganizationId=${encodeURIComponent(labOrgId)}&limit=25`),
    enabled: !!labOrgId,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!itero) return;
    let cancelled = false;
    itero.getStatus().then((s) => {
      if (cancelled) return;
      setStatus(s);
      setLabOrgId(s.labOrganizationId || "");
      setProviderOrgId(s.providerOrganizationId || "");
      setIntervalMin(s.intervalMin || 5);
    });
    const off = itero.onStatus((s) => setStatus(s));
    return () => { cancelled = true; off?.(); };
  }, [itero]);

  // Auto-set the API base URL to the same origin the renderer uses
  useEffect(() => {
    if (!itero || !status) return;
    const apiBase = (import.meta.env?.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "")
      || `${window.location.origin}/api`;
    if (!status.apiBaseUrl || status.apiBaseUrl !== apiBase) {
      itero.setApiConfig({ apiBaseUrl: apiBase });
    }
  }, [itero, status?.apiBaseUrl]);

  const labMemberships = useMemo(
    () => (meQuery.data?.memberships ?? []).filter((m) => m.organization?.type === "lab"),
    [meQuery.data],
  );
  const providerMemberships = useMemo(
    () => (meQuery.data?.memberships ?? []).filter((m) => m.organization?.type === "provider"),
    [meQuery.data],
  );

  if (!itero) {
    return (
      <PanelShell title="iTero auto-import" subtitle="Available in the desktop app only.">
        <div className="px-6 py-4 text-sm text-muted-foreground">
          The iTero "Lab Review" auto-import runs inside the LabTrax Desktop app. Open this panel from the desktop client to configure it.
        </div>
      </PanelShell>
    );
  }

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setMessage(null);
    try {
      const r = await fn();
      return r;
    } catch (err: any) {
      setMessage({ tone: "err", text: err?.message || String(err) });
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  const fmt = (iso?: string | null) => (iso ? formatDateTime(iso) : "Never");

  return (
    <PanelShell
      title="iTero auto-import"
      subtitle="Auto-create LabTrax cases from iTero Lab-Review orders. Credentials are encrypted on this machine via the OS keychain."
    >
      <div className="px-6 py-5 space-y-6">
        {!status?.available && (
          <div className="text-sm rounded-md px-3 py-2 bg-destructive/10 text-destructive">
            OS keychain is unavailable on this machine — credentials cannot be stored securely. On Linux this requires gnome-keyring or kwallet.
          </div>
        )}

        {message && (
          <div className={`text-sm rounded-md px-3 py-2 ${message.tone === "ok" ? "bg-success/15 text-success" : "bg-destructive/10 text-destructive"}`}>
            {message.text}
          </div>
        )}

        <section className="space-y-3">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Shared iTero account</h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              <div className="text-muted-foreground mb-1">Username / email</div>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={status?.configured ? "(saved — type to replace)" : "lab@example.com"}
                className="w-full h-9 px-3 rounded-md border border-border bg-background text-sm"
              />
            </label>
            <label className="text-sm">
              <div className="text-muted-foreground mb-1">Password</div>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={status?.configured ? "(saved — type to replace)" : ""}
                  className="w-full h-9 px-3 pr-9 rounded-md border border-border bg-background text-sm"
                />
                <button type="button" onClick={() => setShowPassword((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground">
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
            </label>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!username || !password || !!busy}
              onClick={() => run("save-creds", async () => {
                const s = await itero.setCredentials({ username, password });
                setStatus(s);
                setUsername("");
                setPassword("");
                setMessage({ tone: "ok", text: "iTero credentials saved." });
              })}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-60"
            >
              {busy === "save-creds" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save credentials
            </button>
            {status?.configured && (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => run("clear-creds", async () => {
                  const s = await itero.clearCredentials();
                  setStatus(s);
                  setMessage({ tone: "ok", text: "iTero credentials removed." });
                })}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-secondary text-foreground text-xs"
              >
                <Trash2 size={12} /> Forget
              </button>
            )}
            <button
              type="button"
              disabled={!status?.configured || !!busy}
              onClick={() => run("test-login", async () => {
                const r = await itero.testLogin();
                setMessage(r?.ok
                  ? { tone: "ok", text: "Logged into iTero successfully." }
                  : { tone: "err", text: r?.error || "Login failed." });
              })}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-secondary text-foreground text-xs disabled:opacity-60"
            >
              {busy === "test-login" ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />} Test login
            </button>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Imported case routing</h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              <div className="text-muted-foreground mb-1">Lab organization</div>
              <select
                value={labOrgId}
                onChange={(e) => { setLabOrgId(e.target.value); itero.setApiConfig({ labOrganizationId: e.target.value }); }}
                className="w-full h-9 px-2 rounded-md border border-border bg-background text-sm"
              >
                <option value="">Select a lab…</option>
                {labMemberships.map((m) => (
                  <option key={m.organizationId} value={m.organizationId}>
                    {m.organization?.name || m.organizationId}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <div className="text-muted-foreground mb-1">Default provider (practice)</div>
              <select
                value={providerOrgId}
                onChange={(e) => { setProviderOrgId(e.target.value); itero.setApiConfig({ providerOrganizationId: e.target.value }); }}
                className="w-full h-9 px-2 rounded-md border border-border bg-background text-sm"
              >
                <option value="">Select a provider…</option>
                {providerMemberships.map((m) => (
                  <option key={m.organizationId} value={m.organizationId}>
                    {m.organization?.name || m.organizationId}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Imported cases are created under this lab and assigned to the chosen provider. You can re-route any case after it&rsquo;s reviewed.
          </p>
          <IteroAutoLinkToggle labOrgId={labOrgId} />
        </section>

        <section className="space-y-3">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Polling</h3>
          <div className="flex items-end gap-3 flex-wrap">
            <label className="text-sm">
              <div className="text-muted-foreground mb-1">Interval (minutes)</div>
              <input
                type="number"
                min={5}
                max={240}
                value={intervalMin}
                onChange={(e) => setIntervalMin(Number(e.target.value) || 5)}
                className="w-28 h-9 px-3 rounded-md border border-border bg-background text-sm"
              />
            </label>
            <button
              type="button"
              disabled={!status?.configured || !labOrgId || !providerOrgId || !!busy}
              onClick={() => run("toggle", async () => {
                const s = await itero.setEnabled({ enabled: !status?.enabled, intervalMin });
                setStatus(s);
              })}
              className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-xs font-medium ${status?.enabled ? "bg-destructive/10 text-destructive" : "bg-primary text-primary-foreground"} disabled:opacity-60`}
            >
              {status?.enabled ? "Pause auto-import" : "Enable auto-import"}
            </button>
            <button
              type="button"
              disabled={!status?.configured || !labOrgId || !providerOrgId || !!busy}
              onClick={() => run("poll", async () => {
                const r = await itero.pollNow();
                setMessage(r?.ok
                  ? { tone: "ok", text: `Poll complete — imported ${r.imported}, skipped ${r.skipped} of ${r.total}.` }
                  : { tone: "err", text: r?.error || "Poll failed." });
              })}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-secondary text-foreground text-xs disabled:opacity-60"
            >
              {busy === "poll" || status?.polling ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} Poll now
            </button>
          </div>
        </section>

        <section className="space-y-2 border-t border-border pt-4">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Status</h3>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
            <div className="text-muted-foreground">Credentials</div>
            <div>{status?.configured ? "Saved (encrypted)" : "Not set"}</div>
            <div className="text-muted-foreground">Auto-poll</div>
            <div>{status?.enabled ? `On — every ${status.intervalMin} min` : "Off"}</div>
            <div className="text-muted-foreground">Last poll</div>
            <div>{fmt(status?.lastPollAt)}</div>
            <div className="text-muted-foreground">Imported today</div>
            <div>{status?.importedToday ?? 0}</div>
            <div className="text-muted-foreground">Imported total</div>
            <div>{status?.importedCount ?? 0}</div>
            <div className="text-muted-foreground">Last error</div>
            <div className={status?.lastError ? "text-destructive" : ""}>{status?.lastError || "None"}</div>
            <div className="text-muted-foreground">Signed in as</div>
            <div className="truncate">{user?.username}{status?.authActive === false && <span className="text-destructive ml-2">(poller paused — sign in required)</span>}</div>
          </div>

        </section>

        <section className="space-y-2 border-t border-border pt-4">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium flex items-center gap-1.5">
            <History size={11} />
            Import history
          </h3>
          {!labOrgId ? (
            <p className="text-xs text-muted-foreground">Select a lab above to see import history.</p>
          ) : historyQuery.isLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </div>
          ) : historyQuery.isError ? (
            <p className="text-xs text-destructive">Could not load history.</p>
          ) : !historyQuery.data?.data?.sessions?.length ? (
            <p className="text-xs text-muted-foreground">No import sessions recorded yet.</p>
          ) : (
            <div>
              <p className="text-xs text-muted-foreground mb-2">Click a session to view those cases.</p>
              <ul className="text-sm divide-y divide-border rounded-md border border-border">
                {historyQuery.data.data.sessions.map((session) => {
                  const operator = session.importedByName || session.importedByUsername || "Unknown user";
                  const label = `${session.totalCount} order${session.totalCount !== 1 ? "s" : ""} by ${operator}`;
                  return (
                    <li key={session.batchId} className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-secondary/40 transition-colors">
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium truncate">{fmt(session.importedAt)}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {operator} ·{" "}
                          <span className="text-emerald-600 dark:text-emerald-400">{session.createdCount} new</span>
                          {session.dedupedCount > 0 && (
                            <span className="text-muted-foreground"> · {session.dedupedCount} skipped</span>
                          )}
                          {session.erroredCount > 0 && (
                            <span className="text-destructive"> · {session.erroredCount} failed</span>
                          )}
                        </div>
                      </div>
                      {session.caseIds.length > 0 && (
                        <a
                          href="#/cases"
                          className="text-xs font-medium text-primary hover:underline whitespace-nowrap"
                          onClick={() => {
                            try {
                              sessionStorage.setItem(
                                "cases_itero_batch_v1",
                                JSON.stringify({ batchId: session.batchId, caseIds: session.caseIds, importedAt: session.importedAt, label })
                              );
                            } catch {}
                          }}
                        >
                          View {session.caseIds.length} case{session.caseIds.length !== 1 ? "s" : ""}
                        </a>
                      )}
                      {session.caseIds.length === 0 && (
                        <span className="text-xs text-muted-foreground">All skipped</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
      </div>
    </PanelShell>
  );
}


type EmailPrefsData = {
  caseNoteNotifications: boolean;
  orgInviteNotifications: boolean;
  statementEmails: boolean;
  billingReminders: boolean;
  installerAlerts: boolean;
  backupAlerts: boolean;
  cleanupAlerts: boolean;
  caseCreatedNotifications: boolean;
  messageReceivedNotifications: boolean;
  rushCaseNotifications: boolean;
  providerNoteNotifications: boolean;
};

type SmsPrefsData = {
  accountLinkInvites: boolean;
  caseNoteNotifications: boolean;
  billingReminders: boolean;
};

type InAppPrefsData = {
  inAppNewCase: boolean;
  inAppTeammateMessage: boolean;
  inAppDoctorPracticeMessage: boolean;
  inAppExceptionCase: boolean;
  inAppRushCase: boolean;
};

type InAppPrefsResponse = {
  preferences?: Partial<InAppPrefsData>;
  hasActiveOwnerOrAdminLabMembership?: boolean;
};

function NotificationsPanel({ isAdmin }: { isAdmin: boolean }) {
  const [prefs, setPrefs] = useState<EmailPrefsData>({
    caseNoteNotifications: true,
    orgInviteNotifications: true,
    statementEmails: true,
    billingReminders: true,
    installerAlerts: true,
    backupAlerts: true,
    cleanupAlerts: true,
    caseCreatedNotifications: true,
    messageReceivedNotifications: true,
    rushCaseNotifications: true,
    providerNoteNotifications: true,
  });
  const [smsPrefs, setSmsPrefs] = useState<SmsPrefsData>({
    accountLinkInvites: true,
    caseNoteNotifications: true,
    billingReminders: true,
  });
  const [saving, setSaving] = useState<Partial<Record<keyof EmailPrefsData, boolean>>>({});
  const [smsSaving, setSmsSaving] = useState<Partial<Record<keyof SmsPrefsData, boolean>>>({});
  const [inAppPrefs, setInAppPrefs] = useState<InAppPrefsData>({
    inAppNewCase: true,
    inAppTeammateMessage: true,
    inAppDoctorPracticeMessage: true,
    inAppExceptionCase: true,
    inAppRushCase: true,
  });
  const [inAppSaving, setInAppSaving] = useState<
    Partial<Record<keyof InAppPrefsData, boolean>>
  >({});
  const [inAppEligible, setInAppEligible] = useState<boolean | null>(null);
  const [inAppLoadError, setInAppLoadError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<{ tone: "success" | "danger"; message: string } | null>(null);
  const saveStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    apiFetch("/users/me/email-preferences")
      .then((data: EmailPrefsData) => setPrefs(data))
      .catch((err: Error) => setLoadError(err.message || "Could not load preferences."));
    apiFetch("/users/me/sms-preferences")
      .then((data: SmsPrefsData) => setSmsPrefs(data))
      .catch(() => {});
    apiFetch("/auth/notification-preferences")
      .then((data: InAppPrefsResponse) => {
        setInAppEligible(!!data.hasActiveOwnerOrAdminLabMembership);
        setInAppPrefs((current) => ({ ...current, ...(data.preferences ?? {}) }));
      })
      .catch((err: Error) => {
        setInAppEligible(false);
        setInAppLoadError(err.message || "Could not load in-app notification preferences.");
      });
  }, []);

  useEffect(() => {
    return () => {
      if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current);
    };
  }, []);

  function showSaveStatus(tone: "success" | "danger", message: string) {
    if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current);
    setSaveStatus({ tone, message });
    saveStatusTimer.current = setTimeout(() => setSaveStatus(null), 2500);
  }

  async function toggle(key: keyof EmailPrefsData, value: boolean) {
    setPrefs((p) => ({ ...p, [key]: value }));
    setSaving((s) => ({ ...s, [key]: true }));
    try {
      await apiFetch("/users/me/email-preferences", {
        method: "PATCH",
        body: JSON.stringify({ [key]: value }),
      });
      showSaveStatus("success", "Preference saved.");
    } catch (err) {
      setPrefs((p) => ({ ...p, [key]: !value }));
      showSaveStatus("danger", (err instanceof Error ? err.message : null) || "Could not save preference.");
    } finally {
      setSaving((s) => ({ ...s, [key]: false }));
    }
  }

  async function toggleSms(key: keyof SmsPrefsData, value: boolean) {
    setSmsPrefs((p) => ({ ...p, [key]: value }));
    setSmsSaving((s) => ({ ...s, [key]: true }));
    try {
      await apiFetch("/users/me/sms-preferences", {
        method: "PATCH",
        body: JSON.stringify({ [key]: value }),
      });
      showSaveStatus("success", "Preference saved.");
    } catch (err) {
      setSmsPrefs((p) => ({ ...p, [key]: !value }));
      showSaveStatus("danger", (err instanceof Error ? err.message : null) || "Could not save preference.");
    } finally {
      setSmsSaving((s) => ({ ...s, [key]: false }));
    }
  }

  async function toggleInApp(key: keyof InAppPrefsData, value: boolean) {
    setInAppPrefs((current) => ({ ...current, [key]: value }));
    setInAppSaving((current) => ({ ...current, [key]: true }));
    try {
      const result = await apiFetch<InAppPrefsResponse>("/auth/notification-preferences", {
        method: "PATCH",
        body: JSON.stringify({ [key]: value }),
      });
      if (result.preferences) {
        setInAppPrefs((current) => ({ ...current, ...result.preferences }));
      }
      showSaveStatus("success", "Preference saved.");
    } catch (err) {
      setInAppPrefs((current) => ({ ...current, [key]: !value }));
      showSaveStatus(
        "danger",
        (err instanceof Error ? err.message : null) || "Could not save preference.",
      );
    } finally {
      setInAppSaving((current) => ({ ...current, [key]: false }));
    }
  }

  const accountRows: Array<{ prefKey: keyof EmailPrefsData; label: string; desc: string }> = [
    {
      prefKey: "providerNoteNotifications",
      label: "Provider adds a note or file",
      desc: "Receive an email when a provider adds a note or attachment to a case",
    },
    {
      prefKey: "caseNoteNotifications",
      label: "Case note alerts",
      desc: "Receive an email when a note is added to one of your cases",
    },
    {
      prefKey: "orgInviteNotifications",
      label: "Lab invitations",
      desc: "Receive invitation emails when you are added to a lab or organization",
    },
    {
      prefKey: "statementEmails",
      label: "Monthly statements",
      desc: "Receive monthly billing statement PDFs by email",
    },
    {
      prefKey: "billingReminders",
      label: "Billing & subscription reminders",
      desc: "Trial expiry countdowns, payment-due notices, and account lock warnings",
    },
  ];

  const systemAlertRows: Array<{ prefKey: keyof EmailPrefsData; label: string; desc: string }> = [
    {
      prefKey: "backupAlerts",
      label: "Backup reports",
      desc: "Backup success and failure summaries",
    },
    {
      prefKey: "cleanupAlerts",
      label: "Media cleanup reports",
      desc: "Nightly orphaned case-media cleanup summaries and interrupted-run recovery notices",
    },
    {
      prefKey: "installerAlerts",
      label: "Desktop installer alerts",
      desc: "Auto-publish failures, nightly health-check warnings, and download-reachability errors",
    },
  ];

  const smsRows: Array<{ prefKey: keyof SmsPrefsData; label: string; desc: string }> = [
    {
      prefKey: "accountLinkInvites",
      label: "Lab link invites (SMS)",
      desc: "Receive a text when another lab adds you as a doctor and wants to link your accounts",
    },
    {
      prefKey: "caseNoteNotifications",
      label: "Case note alerts (SMS)",
      desc: "Receive a text when a note is added to one of your cases",
    },
    {
      prefKey: "billingReminders",
      label: "Billing reminders (SMS)",
      desc: "Trial expiry countdowns, payment-due notices, and account lock warnings via text",
    },
  ];

  const inAppRows: Array<{
    prefKey: keyof InAppPrefsData;
    label: string;
    desc: string;
  }> = [
    {
      prefKey: "inAppNewCase",
      label: "New cases",
      desc: "Bell alerts when a standard case is created",
    },
    {
      prefKey: "inAppTeammateMessage",
      label: "Teammate messages",
      desc: "Bell alerts for internal teammate messages when available",
    },
    {
      prefKey: "inAppDoctorPracticeMessage",
      label: "Doctor and practice messages",
      desc: "Bell alerts for provider messages, notes, and uploads",
    },
    {
      prefKey: "inAppExceptionCase",
      label: "Exception cases",
      desc: "Bell alerts when a case is flagged for lab review",
    },
    {
      prefKey: "inAppRushCase",
      label: "Rush cases",
      desc: "Bell alerts when a rush case is created",
    },
  ];

  function ToggleRow({ prefKey, label, desc }: { prefKey: keyof EmailPrefsData; label: string; desc: string }) {
    return (
      <div className="flex items-center justify-between px-4 py-3 bg-card">
        <div className="min-w-0 mr-6">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={prefs[prefKey]}
          disabled={!!saving[prefKey]}
          onClick={() => toggle(prefKey, !prefs[prefKey])}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${prefs[prefKey] ? "bg-primary" : "bg-input"}`}
        >
          <span
            className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${prefs[prefKey] ? "translate-x-5" : "translate-x-0"}`}
          />
        </button>
      </div>
    );
  }

  function SmsToggleRow({ prefKey, label, desc }: { prefKey: keyof SmsPrefsData; label: string; desc: string }) {
    return (
      <div className="flex items-center justify-between px-4 py-3 bg-card">
        <div className="min-w-0 mr-6">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={smsPrefs[prefKey]}
          disabled={!!smsSaving[prefKey]}
          onClick={() => toggleSms(prefKey, !smsPrefs[prefKey])}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${smsPrefs[prefKey] ? "bg-primary" : "bg-input"}`}
        >
          <span
            className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${smsPrefs[prefKey] ? "translate-x-5" : "translate-x-0"}`}
          />
        </button>
      </div>
    );
  }

  function InAppToggleRow({
    prefKey,
    label,
    desc,
  }: {
    prefKey: keyof InAppPrefsData;
    label: string;
    desc: string;
  }) {
    return (
      <div className="flex items-center justify-between px-4 py-3 bg-card">
        <div className="min-w-0 mr-6">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={inAppPrefs[prefKey]}
          disabled={!!inAppSaving[prefKey]}
          onClick={() => toggleInApp(prefKey, !inAppPrefs[prefKey])}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${inAppPrefs[prefKey] ? "bg-primary" : "bg-input"}`}
        >
          <span
            className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${inAppPrefs[prefKey] ? "translate-x-5" : "translate-x-0"}`}
          />
        </button>
      </div>
    );
  }

  return (
    <PanelShell
      title="Notifications"
      subtitle="Choose which emails and texts LabTrax sends to you. Transactional messages (password resets, verification codes) are always sent."
    >
      {loadError && <Alert tone="danger">{loadError}</Alert>}
      {saveStatus && <Alert tone={saveStatus.tone}>{saveStatus.message}</Alert>}

      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-0.5">Email</p>
      </div>
      <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
        {accountRows.map((row) => (
          <ToggleRow key={row.prefKey} {...row} />
        ))}
      </div>

      {inAppLoadError && (
        <div className="space-y-1 pt-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-0.5">
            In-app notifications
          </p>
          <Alert tone="danger">{inAppLoadError}</Alert>
        </div>
      )}
      {inAppEligible === null && !inAppLoadError && (
        <div className="space-y-1 pt-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-0.5">
            In-app notifications
          </p>
          <p className="text-xs text-muted-foreground">Loading in-app notification controls…</p>
        </div>
      )}
      {inAppEligible && (
        <div className="space-y-2 pt-2">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-0.5">
              In-app notifications
            </p>
            <p className="text-xs text-muted-foreground">
              Control operational alerts in the LabTrax notification bell. Email, text, and push settings are unchanged.
            </p>
          </div>
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
            {inAppRows.map((row) => (
              <InAppToggleRow key={row.prefKey} {...row} />
            ))}
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="space-y-2 pt-2">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-0.5">System alerts</p>
            <p className="text-xs text-muted-foreground">These alerts are only sent to admin accounts.</p>
          </div>
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
            {systemAlertRows.map((row) => (
              <ToggleRow key={row.prefKey} {...row} />
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2 pt-2">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-0.5">Text messages</p>
        </div>
        <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
          {smsRows.map((row) => (
            <SmsToggleRow key={row.prefKey} {...row} />
          ))}
        </div>
      </div>
    </PanelShell>
  );
}

interface DeletedCase {
  id: string;
  caseNumber: string;
  patientFirstName: string;
  patientLastName: string;
  doctorName: string;
  labOrganizationId: string;
  deletedAt: string;
  deletedByUserId?: string | null;
  createdAt: string;
}

function DeletedCasesPanel() {
  const qc = useQueryClient();
  const [, setLocation] = useLocation();

  const meQuery = useQuery<MeResponse>({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch("/auth/me"),
    staleTime: 60_000,
  });

  const adminLabs = useMemo(() => {
    return (meQuery.data?.memberships ?? []).filter(
      (m) =>
        m.organization?.type === "lab" &&
        m.status === "active" &&
        (m.role === "admin" || m.role === "owner"),
    );
  }, [meQuery.data]);

  const [selectedLabId, setSelectedLabId] = useState<string | null>(null);
  const effectiveLabId = selectedLabId ?? adminLabs[0]?.organizationId ?? null;

  const deletedQuery = useQuery<{ cases: DeletedCase[] }>({
    enabled: !!effectiveLabId,
    queryKey: ["cases", "deleted", effectiveLabId],
    queryFn: () =>
      apiFetch(`/cases/deleted?labOrganizationId=${encodeURIComponent(effectiveLabId!)}`),
    staleTime: 30_000,
  });

  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkRestoring, setBulkRestoring] = useState(false);

  async function handleRestore(caseId: string) {
    setRestoringId(caseId);
    setRestoreError(null);
    try {
      await apiFetch(`/cases/${caseId}/restore`, { method: "POST" });
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["cases", "deleted", effectiveLabId] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      setLocation(`/cases?caseId=${encodeURIComponent(caseId)}`);
    } catch (err: unknown) {
      setRestoreError(
        err instanceof Error ? err.message : "Could not restore case.",
      );
    } finally {
      setRestoringId(null);
    }
  }

  async function handleBulkRestore() {
    if (!effectiveLabId || selectedIds.size === 0) return;
    setBulkRestoring(true);
    setRestoreError(null);
    try {
      const result = await apiFetch("/cases/bulk-restore", {
        method: "POST",
        body: JSON.stringify({ caseIds: Array.from(selectedIds), labOrganizationId: effectiveLabId }),
      }) as { restored: string[]; failed: { id: string; reason: string }[] };
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["cases", "deleted", effectiveLabId] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      setSelectedIds(new Set());
      const restoredCount = result.restored?.length ?? 0;
      const failedCount = result.failed?.length ?? 0;
      if (failedCount > 0) {
        const reasons = (result.failed ?? []).map((f) => f.reason).join("; ");
        toast({
          title: `${restoredCount} case${restoredCount !== 1 ? "s" : ""} restored`,
          description: `${failedCount} could not be restored: ${reasons}`,
          variant: "destructive",
        });
      } else {
        toast({
          title: `${restoredCount} case${restoredCount !== 1 ? "s" : ""} restored`,
          description: "All selected cases have been restored.",
        });
      }
    } catch (err: unknown) {
      setRestoreError(
        err instanceof Error ? err.message : "Could not restore cases.",
      );
    } finally {
      setBulkRestoring(false);
    }
  }

  const deletedList = useMemo(() => {
    const raw = deletedQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw as DeletedCase[];
    return (raw as { cases?: DeletedCase[] }).cases ?? [];
  }, [deletedQuery.data]);

  const allSelected = deletedList.length > 0 && deletedList.every((c) => selectedIds.has(c.id));
  const someSelected = selectedIds.size > 0;

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(deletedList.map((c) => c.id)));
    }
  }

  function toggleRow(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Shift-click range selection for the row checkboxes. Same semantics as
  // the Cases list: normal click toggles + moves the anchor; shift-click
  // with a valid anchor adds every row between the anchor and the clicked
  // row (in the current visible order) to the selection; a stale anchor
  // falls back to a single toggle and resets.
  const selectionAnchorIdRef = useRef<string | null>(null);
  function handleRowCheckboxChange(id: string, shiftKey: boolean) {
    if (shiftKey) {
      const rangeIds = computeShiftClickRange(
        deletedList.map((c) => c.id),
        selectionAnchorIdRef.current,
        id,
      );
      if (rangeIds) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (const rid of rangeIds) next.add(rid);
          return next;
        });
        return;
      }
      selectionAnchorIdRef.current = null;
    }
    toggleRow(id);
    selectionAnchorIdRef.current = id;
  }

  return (
    <PanelShell
      title="Deleted Cases"
      subtitle="Soft-deleted cases for this lab. Restoring a case will also unfreeze any linked invoices."
    >
      {adminLabs.length > 1 && (
        <div className="mb-4">
          <select
            value={effectiveLabId ?? ""}
            onChange={(e) => { setSelectedLabId(e.target.value || null); setSelectedIds(new Set()); }}
            className="h-9 px-3 rounded-md bg-secondary text-sm border border-border focus:outline-none"
          >
            {adminLabs.map((m) => (
              <option key={m.organizationId} value={m.organizationId}>
                {m.organization?.name ?? m.organizationId}
              </option>
            ))}
          </select>
        </div>
      )}

      {restoreError && (
        <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2 mb-3">
          {restoreError}
        </div>
      )}

      {someSelected && (
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-3 py-2 mb-2 rounded-md bg-primary/10 border border-primary/30 backdrop-blur-sm">
          <span className="text-xs font-medium text-foreground">
            {selectedIds.size} case{selectedIds.size !== 1 ? "s" : ""} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Clear
            </button>
            <button
              type="button"
              disabled={bulkRestoring}
              onClick={handleBulkRestore}
              className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-60"
            >
              {bulkRestoring ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <RotateCcw size={11} />
              )}
              Restore selected
            </button>
          </div>
        </div>
      )}

      {deletedQuery.isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-8 justify-center">
          <Loader2 size={14} className="animate-spin" />
          Loading…
        </div>
      )}

      {deletedQuery.isError && (
        <div className="text-sm text-destructive py-6 text-center">
          Failed to load deleted cases.
        </div>
      )}

      {!deletedQuery.isLoading && !deletedQuery.isError && (
        <>
          {deletedList.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-10">
              No deleted cases.
            </div>
          ) : (
            <div className="border border-border rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 w-8">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleSelectAll}
                        className="h-3.5 w-3.5 rounded cursor-pointer"
                        aria-label="Select all"
                      />
                    </th>
                    <th className="text-left font-medium py-2">Case #</th>
                    <th className="text-left font-medium py-2">Patient</th>
                    <th className="text-left font-medium py-2">Doctor</th>
                    <th className="text-left font-medium py-2">Deleted</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {deletedList.map((c, i) => (
                    <tr
                      key={c.id}
                      className={`${i % 2 === 0 ? "" : "bg-secondary/20"} ${selectedIds.has(c.id) ? "bg-primary/5" : ""}`}
                    >
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(c.id)}
                          onMouseDown={suppressShiftClickTextSelection}
                          onChange={(e) => handleRowCheckboxChange(c.id, shiftKeyFromChangeEvent(e))}
                          className="h-3.5 w-3.5 rounded cursor-pointer"
                          aria-label={`Select case ${c.caseNumber}`}
                        />
                      </td>
                      <td className="py-2.5 font-medium text-foreground whitespace-nowrap pr-4">
                        <div className="flex items-center gap-1.5">
                          <span>{c.caseNumber}</span>
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 uppercase tracking-wide">
                            Deleted
                          </span>
                        </div>
                      </td>
                      <td className="py-2.5 text-foreground pr-4">
                        {c.patientFirstName} {c.patientLastName}
                      </td>
                      <td className="py-2.5 text-muted-foreground pr-4">
                        {c.doctorName}
                      </td>
                      <td className="py-2.5 text-muted-foreground text-xs whitespace-nowrap pr-4">
                        {c.deletedAt
                          ? formatDate(c.deletedAt)
                          : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <button
                          type="button"
                          disabled={restoringId === c.id || bulkRestoring}
                          onClick={() => handleRestore(c.id)}
                          className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-60"
                        >
                          {restoringId === c.id ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : (
                            <RotateCcw size={11} />
                          )}
                          Restore
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </PanelShell>
  );
}

interface DeletionAuditCaseDetail {
  caseId: string;
  caseNumber: string;
  patientName: string;
}

interface DeletionAuditEntry {
  id: string;
  action: string;
  actorName: string;
  actorAccount: string | null;
  cases: DeletionAuditCaseDetail[];
  createdAt: string | null;
}

const DELETION_ACTION_LABELS: Record<string, { label: string; color: string }> = {
  case_delete_initiated: { label: "Delete initiated", color: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300" },
  case_delete_wrong_pin: { label: "Wrong PIN", color: "bg-destructive/10 text-destructive" },
  case_delete_initiate_rate_limited: { label: "Rate limited", color: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300" },
  case_soft_deleted: { label: "Deleted", color: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300" },
  cases_bulk_deleted: { label: "Bulk deleted", color: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300" },
};

function DeletionAuditDetailDrawer({
  entry,
  onClose,
}: {
  entry: DeletionAuditEntry;
  onClose: () => void;
}) {
  const def = DELETION_ACTION_LABELS[entry.action] ?? {
    label: entry.action,
    color: "bg-secondary text-muted-foreground",
  };

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="flex-1 bg-black/30" />
      <div
        className="w-full max-w-md bg-background border-l border-border shadow-xl flex flex-col h-full overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="font-semibold text-sm">Audit Event Detail</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-5 flex-1">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide w-20">Event</span>
              <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${def.color}`}>
                {def.label}
              </span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide w-20 shrink-0 pt-0.5">Actor</span>
              <span className="text-sm text-foreground">
                {entry.actorName}
                {entry.actorAccount && entry.actorAccount !== entry.actorName && (
                  <span className="ml-1.5 text-xs text-muted-foreground">({entry.actorAccount})</span>
                )}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide w-20">Time</span>
              <span className="text-sm text-foreground">
                {entry.createdAt ? formatDateTime(entry.createdAt) : "—"}
              </span>
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Affected Cases ({entry.cases.length})
            </p>
            {entry.cases.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No case details recorded.</p>
            ) : (
              <div className="border border-border rounded-md divide-y divide-border">
                {entry.cases.map((c) => (
                  <div key={c.caseId} className="px-3 py-2.5 flex items-baseline gap-2">
                    <span className="text-sm font-medium text-foreground whitespace-nowrap">
                      #{c.caseNumber}
                    </span>
                    <span className="text-sm text-muted-foreground truncate">
                      {c.patientName || "—"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DeletionAuditCasesCell({ cases }: { cases: DeletionAuditCaseDetail[] }) {
  const [expanded, setExpanded] = useState(false);

  if (cases.length === 0) {
    return <span className="text-muted-foreground/50">—</span>;
  }

  if (cases.length === 1) {
    const c = cases[0];
    return (
      <span className="text-foreground">
        <span className="font-medium">#{c.caseNumber}</span>
        {c.patientName ? <span className="text-muted-foreground"> — {c.patientName}</span> : null}
      </span>
    );
  }

  return (
    <span>
      <button
        type="button"
        className="text-xs underline underline-offset-2 text-muted-foreground hover:text-foreground transition-colors"
        onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
      >
        {cases.length} cases {expanded ? "▲" : "▼"}
      </button>
      {expanded && (
        <ul className="mt-1 space-y-0.5">
          {cases.map((c) => (
            <li key={c.caseId} className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">#{c.caseNumber}</span>
              {c.patientName ? ` — ${c.patientName}` : ""}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

function DeletionAuditPanel() {
  const meQuery = useQuery<MeResponse>({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch("/auth/me"),
    staleTime: 60_000,
  });

  const adminLabs = useMemo(() => {
    return (meQuery.data?.memberships ?? []).filter(
      (m) =>
        m.organization?.type === "lab" &&
        m.status === "active" &&
        (m.role === "admin" || m.role === "owner"),
    );
  }, [meQuery.data]);

  const [selectedLabId, setSelectedLabId] = useState<string | null>(null);
  const effectiveLabId = selectedLabId ?? adminLabs[0]?.organizationId ?? null;
  const [selectedEntry, setSelectedEntry] = useState<DeletionAuditEntry | null>(null);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [textFilter, setTextFilter] = useState("");

  const fromIso = useMemo(() => {
    if (!dateFrom) return "";
    const [y, m, d] = dateFrom.split("-").map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
  }, [dateFrom]);

  const toIso = useMemo(() => {
    if (!dateTo) return "";
    const [y, m, d] = dateTo.split("-").map(Number);
    return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
  }, [dateTo]);

  const auditQuery = useQuery<{ entries: DeletionAuditEntry[] }>({
    enabled: !!effectiveLabId,
    queryKey: ["cases", "deletion-audit-log", effectiveLabId, fromIso, toIso],
    queryFn: () => {
      const params = new URLSearchParams({ labOrganizationId: effectiveLabId!, limit: "100" });
      if (fromIso) params.set("from", fromIso);
      if (toIso) params.set("to", toIso);
      return apiFetch(`/cases/deletion-audit-log?${params.toString()}`);
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const needle = textFilter.trim().toLowerCase();
  const entries = useMemo(() => {
    const all = auditQuery.data?.entries ?? [];
    if (!needle) return all;
    return all.filter((e) => {
      if (e.actorName?.toLowerCase().includes(needle)) return true;
      if (e.actorAccount?.toLowerCase().includes(needle)) return true;
      return e.cases.some(
        (c) => c.caseNumber?.toLowerCase().includes(needle) || c.patientName?.toLowerCase().includes(needle),
      );
    });
  }, [auditQuery.data, needle]);

  const hasFilters = dateFrom || dateTo || textFilter.trim();

  function exportAuditCsv() {
    function escapeCsv(value: string) {
      return `"${String(value).replace(/"/g, '""')}"`;
    }
    const headers = ["Event", "Actor", "Actor Account", "Cases", "Timestamp"];
    const rows = entries.map((entry) => {
      const eventLabel = DELETION_ACTION_LABELS[entry.action]?.label ?? entry.action;
      const actor = entry.actorName ?? "";
      const actorAccount = entry.actorAccount ?? "";
      const casesText = entry.cases
        .map((c) => [c.caseNumber ? `#${c.caseNumber}` : "", c.patientName].filter(Boolean).join(" "))
        .join("; ");
      const timestamp = entry.createdAt ? formatDateTime(entry.createdAt) : "";
      return [eventLabel, actor, actorAccount, casesText, timestamp].map(escapeCsv).join(",");
    });
    const csv = [headers.map(escapeCsv).join(","), ...rows].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `deletion-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <PanelShell
      title="Deletion Audit Log"
      subtitle="A record of who deleted cases, when, and any failed PIN attempts. Click a row to inspect details. Updates every 60 seconds."
    >
      {selectedEntry && (
        <DeletionAuditDetailDrawer
          entry={selectedEntry}
          onClose={() => setSelectedEntry(null)}
        />
      )}

      {/* Top bar: lab selector + refresh */}
      <div className="flex items-center justify-between mb-3">
        {adminLabs.length > 1 && (
          <select
            value={effectiveLabId ?? ""}
            onChange={(e) => setSelectedLabId(e.target.value || null)}
            className="h-9 px-3 rounded-md bg-secondary text-sm border border-border focus:outline-none"
          >
            {adminLabs.map((m) => (
              <option key={m.organizationId} value={m.organizationId}>
                {m.organization?.name ?? m.organizationId}
              </option>
            ))}
          </select>
        )}
        {adminLabs.length <= 1 && <span />}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={exportAuditCsv}
            disabled={entries.length === 0}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-secondary text-xs font-medium hover:bg-secondary/80 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <FileDown size={11} />
            Export CSV
          </button>
          <button
            type="button"
            onClick={() => auditQuery.refetch()}
            disabled={auditQuery.isFetching}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-secondary text-xs font-medium hover:bg-secondary/80 disabled:opacity-60"
          >
            {auditQuery.isFetching ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <RefreshCcw size={11} />
            )}
            Refresh
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-muted-foreground whitespace-nowrap">From</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-8 px-2 rounded-md bg-secondary text-sm border border-border focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-muted-foreground whitespace-nowrap">To</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-8 px-2 rounded-md bg-secondary text-sm border border-border focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="relative flex-1 min-w-[160px]">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Actor or case number…"
            value={textFilter}
            onChange={(e) => setTextFilter(e.target.value)}
            className="h-8 w-full pl-7 pr-2 rounded-md bg-secondary text-sm border border-border focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        {hasFilters && (
          <button
            type="button"
            onClick={() => { setDateFrom(""); setDateTo(""); setTextFilter(""); }}
            className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md text-xs text-muted-foreground hover:bg-secondary/80 border border-border"
          >
            <X size={11} />
            Clear
          </button>
        )}
        {hasFilters && !auditQuery.isLoading && auditQuery.data && (
          <span className="ml-auto text-xs text-muted-foreground">
            {entries.length === 1 ? "1 result" : `${entries.length} results`}
          </span>
        )}
      </div>

      {/* Limit-reached notice */}
      {(auditQuery.data?.entries?.length ?? 0) === 100 && (
        <div className="flex items-center gap-2 rounded-md border border-amber-300/60 bg-amber-50/60 dark:bg-amber-950/30 dark:border-amber-700/50 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 mb-3">
          <span>Showing first 100 results — narrow your date range to see more.</span>
        </div>
      )}

      {auditQuery.isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-8 justify-center">
          <Loader2 size={14} className="animate-spin" />
          Loading…
        </div>
      )}

      {auditQuery.isError && (
        <div className="text-sm text-destructive py-6 text-center">
          Failed to load audit log.
        </div>
      )}

      {!effectiveLabId && !auditQuery.isLoading && (
        <div className="text-sm text-muted-foreground text-center py-10">
          No lab selected.
        </div>
      )}

      {!auditQuery.isLoading && !auditQuery.isError && effectiveLabId && (
        <>
          {entries.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-10">
              {hasFilters
                ? "No results match your filters."
                : "No case deletion events recorded yet."}
            </div>
          ) : (
            <div className="border border-border rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="text-left font-medium px-3 py-2">Event</th>
                    <th className="text-left font-medium py-2">Actor</th>
                    <th className="text-left font-medium py-2">Cases</th>
                    <th className="text-left font-medium py-2 pr-3">When</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, i) => {
                    const def = DELETION_ACTION_LABELS[entry.action] ?? {
                      label: entry.action,
                      color: "bg-secondary text-muted-foreground",
                    };
                    return (
                      <tr
                        key={entry.id}
                        onClick={() => setSelectedEntry(entry)}
                        className={`cursor-pointer transition-colors hover:bg-accent/50 ${i % 2 === 0 ? "" : "bg-secondary/20"}`}
                      >
                        <td className="px-3 py-2.5">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${def.color}`}>
                            {def.label}
                          </span>
                        </td>
                        <td className="py-2.5 text-foreground pr-4 whitespace-nowrap">
                          {entry.actorName}
                        </td>
                        <td className="py-2.5 pr-4">
                          <DeletionAuditCasesCell cases={entry.cases} />
                        </td>
                        <td className="py-2.5 text-muted-foreground text-xs whitespace-nowrap pr-3">
                          {entry.createdAt
                            ? formatDateTime(entry.createdAt)
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </PanelShell>
  );
}

// ---------------------------------------------------------------------------
// VocabularyPanel — manage custom vocabulary items per lab
// ---------------------------------------------------------------------------

const VOCAB_KIND_LABELS: Record<string, string> = {
  material: "Materials",
  shade: "Shades",
  restoration_type: "Restoration Types",
};

const VOCAB_KIND_DESCRIPTIONS: Record<string, string> = {
  material: "Appears as selectable options when your team adds restorations to a case (e.g. Zirconia, Lithium Disilicate).",
  shade: "Appears when entering shade information on case restorations and invoices (e.g. A2, BL1).",
  restoration_type: "Appears when choosing the type of restoration on a case (e.g. Crown, Bridge, Veneer).",
};

const VOCAB_BUILTIN_DEFAULTS: Record<string, string[]> = {
  material: ["Zirconia", "PFM", "Lithium Disilicate (Emax)", "Full Cast", "Composite", "Acrylic", "Metal", "PMMA", "Other"],
  shade: ["A1", "A2", "A3", "A3.5", "A4", "B1", "B2", "B3", "B4", "C1", "C2", "C3", "C4", "D2", "D3", "D4", "BL1", "BL2", "BL3", "BL4"],
  restoration_type: ["Crown", "Bridge", "Veneer", "Implant Crown", "Inlay", "Onlay", "Full Denture", "Partial Denture", "Night Guard", "Retainer", "Sports Guard", "Snore Guard", "Other"],
};
const VOCAB_KINDS = ["material", "shade", "restoration_type"] as const;
type VocabKind = (typeof VOCAB_KINDS)[number];

const AI_MEMORY_KINDS = ["glossary", "preference", "fact"] as const;
type AiMemoryKind = (typeof AI_MEMORY_KINDS)[number];

interface AiMemoryItem {
  id: string;
  labOrganizationId: string;
  kind: AiMemoryKind;
  key: string;
  value: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

interface AiMemoryCandidate {
  id: string;
  labOrganizationId: string;
  kind: AiMemoryKind;
  key: string;
  value: string;
  status: string;
  sourceUserId: string | null;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const AI_MEMORY_KIND_META: Record<
  AiMemoryKind,
  { label: string; description: string; keyLabel: string; valueLabel: string }
> = {
  glossary: {
    label: "Glossary",
    description:
      "Lab-specific terms or abbreviations the AI should understand (e.g. \"PFZ\" → \"Porcelain fused to zirconia\").",
    keyLabel: "Term",
    valueLabel: "Definition",
  },
  preference: {
    label: "Preferences",
    description:
      "How this lab likes things done — tone, defaults, or conventions the AI should follow.",
    keyLabel: "Name",
    valueLabel: "Preference",
  },
  fact: {
    label: "Facts",
    description: "Durable facts about this lab the AI should always know.",
    keyLabel: "Name",
    valueLabel: "Fact",
  },
};

function AiAssistantPanel() {
  const qc = useQueryClient();

  const meQuery = useQuery<MeResponse>({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch("/auth/me"),
    staleTime: 60_000,
  });

  const adminLabs = useMemo(() => {
    return (meQuery.data?.memberships ?? []).filter(
      (m) =>
        m.organization?.type === "lab" &&
        m.status === "active" &&
        (m.role === "admin" || m.role === "owner"),
    );
  }, [meQuery.data]);

  const [selectedLabId, setSelectedLabId] = useState<string | null>(null);
  const effectiveLabId = selectedLabId ?? adminLabs[0]?.organizationId ?? null;

  const memoryQuery = useQuery<AiMemoryItem[]>({
    enabled: !!effectiveLabId,
    queryKey: ["ai-memory", effectiveLabId],
    queryFn: () =>
      apiFetch<AiMemoryItem[]>(
        `/ai-memory?labOrganizationId=${encodeURIComponent(effectiveLabId!)}`,
      ),
    staleTime: 30_000,
  });

  const candidatesQuery = useQuery<AiMemoryCandidate[]>({
    enabled: !!effectiveLabId,
    queryKey: ["ai-memory-candidates", effectiveLabId],
    queryFn: () =>
      apiFetch<AiMemoryCandidate[]>(
        `/ai-memory/candidates?labOrganizationId=${encodeURIComponent(effectiveLabId!)}`,
      ),
    staleTime: 30_000,
  });

  const [candidateActionId, setCandidateActionId] = useState<string | null>(null);
  const [candidateError, setCandidateError] = useState<string | null>(null);

  async function approveCandidate(candidate: AiMemoryCandidate) {
    setCandidateActionId(candidate.id);
    setCandidateError(null);
    try {
      await apiFetch(`/ai-memory/candidates/${encodeURIComponent(candidate.id)}/approve`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["ai-memory", effectiveLabId] }),
        qc.invalidateQueries({ queryKey: ["ai-memory-candidates", effectiveLabId] }),
      ]);
    } catch (err: unknown) {
      setCandidateError(err instanceof Error ? err.message : "Could not approve suggestion.");
    } finally {
      setCandidateActionId(null);
    }
  }

  async function rejectCandidate(candidate: AiMemoryCandidate) {
    setCandidateActionId(candidate.id);
    setCandidateError(null);
    try {
      await apiFetch(`/ai-memory/candidates/${encodeURIComponent(candidate.id)}/reject`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await qc.invalidateQueries({ queryKey: ["ai-memory-candidates", effectiveLabId] });
    } catch (err: unknown) {
      setCandidateError(err instanceof Error ? err.message : "Could not reject suggestion.");
    } finally {
      setCandidateActionId(null);
    }
  }

  // Add-new form state, keyed per kind.
  const [addKind, setAddKind] = useState<AiMemoryKind>("glossary");
  const [addKey, setAddKey] = useState("");
  const [addValue, setAddValue] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Edit state.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editKey, setEditKey] = useState("");
  const [editValue, setEditValue] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  // Delete state.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function addEntry() {
    const key = addKey.trim();
    const value = addValue.trim();
    if (!key || !value) {
      setAddError("Both fields are required.");
      return;
    }
    if (!effectiveLabId) return;
    setAdding(true);
    setAddError(null);
    try {
      await apiFetch("/ai-memory", {
        method: "POST",
        body: JSON.stringify({
          labOrganizationId: effectiveLabId,
          kind: addKind,
          key,
          value,
        }),
      });
      await qc.invalidateQueries({ queryKey: ["ai-memory", effectiveLabId] });
      setAddKey("");
      setAddValue("");
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409) {
        setAddError("An entry with that key already exists.");
      } else {
        setAddError(err instanceof Error ? err.message : "Could not add entry.");
      }
    } finally {
      setAdding(false);
    }
  }

  function startEdit(item: AiMemoryItem) {
    setEditingId(item.id);
    setEditKey(item.key);
    setEditValue(item.value);
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditKey("");
    setEditValue("");
    setEditError(null);
  }

  async function saveEdit(item: AiMemoryItem) {
    const key = editKey.trim();
    const value = editValue.trim();
    if (!key || !value) {
      setEditError("Both fields are required.");
      return;
    }
    setSavingId(item.id);
    setEditError(null);
    try {
      await apiFetch(`/ai-memory/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ key, value }),
      });
      await qc.invalidateQueries({ queryKey: ["ai-memory", effectiveLabId] });
      cancelEdit();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409) {
        setEditError("An entry with that key already exists.");
      } else {
        setEditError(err instanceof Error ? err.message : "Could not save entry.");
      }
    } finally {
      setSavingId(null);
    }
  }

  async function deleteEntry(item: AiMemoryItem) {
    setDeletingId(item.id);
    setDeleteError(null);
    try {
      await apiFetch(`/ai-memory/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      await qc.invalidateQueries({ queryKey: ["ai-memory", effectiveLabId] });
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : "Could not delete entry.");
    } finally {
      setDeletingId(null);
    }
  }

  const itemsByKind = useMemo(() => {
    const map: Record<AiMemoryKind, AiMemoryItem[]> = {
      glossary: [],
      preference: [],
      fact: [],
    };
    for (const item of memoryQuery.data ?? []) {
      if (map[item.kind]) map[item.kind].push(item);
    }
    return map;
  }, [memoryQuery.data]);

  const addMeta = AI_MEMORY_KIND_META[addKind];

  return (
    <PanelShell
      title="AI Assistant"
      subtitle="Teach LabTrax Assistant about your lab. Glossary terms, preferences, and facts you add here are included in the assistant's context so its answers match how your lab works."
    >
      {adminLabs.length > 1 && (
        <div className="mb-2">
          <select
            value={effectiveLabId ?? ""}
            onChange={(e) => setSelectedLabId(e.target.value || null)}
            className="h-9 px-3 rounded-md bg-secondary text-sm border border-border focus:outline-none"
          >
            {adminLabs.map((m) => (
              <option key={m.organizationId} value={m.organizationId}>
                {m.organization?.name ?? m.organizationId}
              </option>
            ))}
          </select>
        </div>
      )}

      {!effectiveLabId && !meQuery.isLoading && (
        <p className="text-sm text-muted-foreground text-center py-10">No lab available.</p>
      )}

      {effectiveLabId && (
        <>
          <div className="rounded-lg border border-border p-4 space-y-3">
            <h3 className="text-sm font-semibold">Add memory entry</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type">
                <select
                  value={addKind}
                  onChange={(e) => {
                    setAddKind(e.target.value as AiMemoryKind);
                    setAddError(null);
                  }}
                  className="w-full h-9 px-3 rounded-md bg-secondary text-sm border border-border focus:outline-none"
                >
                  {AI_MEMORY_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {AI_MEMORY_KIND_META[k].label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={addMeta.keyLabel}>
                <input
                  value={addKey}
                  onChange={(e) => setAddKey(e.target.value)}
                  maxLength={200}
                  className="w-full h-9 px-3 rounded-md bg-secondary text-sm border border-border focus:outline-none"
                  placeholder={addMeta.keyLabel}
                />
              </Field>
              <Field label={addMeta.valueLabel} full>
                <textarea
                  value={addValue}
                  onChange={(e) => setAddValue(e.target.value)}
                  maxLength={2000}
                  rows={2}
                  className="w-full px-3 py-2 rounded-md bg-secondary text-sm border border-border focus:outline-none resize-y"
                  placeholder={addMeta.valueLabel}
                />
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">{addMeta.description}</p>
            {addError && <Alert tone="danger">{addError}</Alert>}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void addEntry()}
                disabled={adding}
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
              >
                {adding ? <Loader2 size={14} className="animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
                Add entry
              </button>
            </div>
          </div>

          {deleteError && <Alert tone="danger">{deleteError}</Alert>}

          {(candidatesQuery.data?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-amber-300/60 bg-amber-50/50 dark:bg-amber-500/5 p-4 space-y-3">
              <div>
                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                  <Sparkles size={14} className="text-amber-500" />
                  Suggested by AI
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  The AI noticed these from recent chats. Approve to add them to your lab's memory, or dismiss.
                </p>
              </div>
              {candidateError && <Alert tone="danger">{candidateError}</Alert>}
              <ul className="space-y-1.5">
                {candidatesQuery.data!.map((candidate) => {
                  const meta = AI_MEMORY_KIND_META[candidate.kind];
                  const busy = candidateActionId === candidate.id;
                  return (
                    <li
                      key={candidate.id}
                      className="rounded-md border border-border bg-background px-3 py-2"
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground">
                              {meta.label}
                            </span>
                          </div>
                          <div className="text-sm font-medium break-words">{candidate.key}</div>
                          <div className="text-sm text-muted-foreground break-words whitespace-pre-wrap">
                            {candidate.value}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => void approveCandidate(candidate)}
                            disabled={busy}
                            className="inline-flex items-center gap-1 h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
                            title="Approve"
                          >
                            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={14} />}
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => void rejectCandidate(candidate)}
                            disabled={busy}
                            className="inline-flex items-center gap-1 h-8 px-3 rounded-md bg-secondary text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                            title="Dismiss"
                          >
                            <X size={14} />
                            Dismiss
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {memoryQuery.isLoading && (
            <div className="flex items-center gap-2 text-muted-foreground text-sm py-8 justify-center">
              <Loader2 size={14} className="animate-spin" />
              Loading…
            </div>
          )}

          {!memoryQuery.isLoading && (
            <div className="space-y-8">
              {AI_MEMORY_KINDS.map((kind) => {
                const meta = AI_MEMORY_KIND_META[kind];
                const items = itemsByKind[kind];
                return (
                  <div key={kind}>
                    <h3 className="text-sm font-semibold mb-0.5">{meta.label}</h3>
                    <p className="text-xs text-muted-foreground mb-2">{meta.description}</p>
                    {items.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-3">No {meta.label.toLowerCase()} yet.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {items.map((item) => {
                          const isEditing = editingId === item.id;
                          return (
                            <li
                              key={item.id}
                              className="rounded-md border border-border px-3 py-2"
                            >
                              {isEditing ? (
                                <div className="space-y-2">
                                  <input
                                    value={editKey}
                                    onChange={(e) => setEditKey(e.target.value)}
                                    maxLength={200}
                                    className="w-full h-9 px-3 rounded-md bg-secondary text-sm border border-border focus:outline-none"
                                    placeholder={meta.keyLabel}
                                  />
                                  <textarea
                                    value={editValue}
                                    onChange={(e) => setEditValue(e.target.value)}
                                    maxLength={2000}
                                    rows={2}
                                    className="w-full px-3 py-2 rounded-md bg-secondary text-sm border border-border focus:outline-none resize-y"
                                    placeholder={meta.valueLabel}
                                  />
                                  {editError && <Alert tone="danger">{editError}</Alert>}
                                  <div className="flex gap-2 justify-end">
                                    <button
                                      type="button"
                                      onClick={cancelEdit}
                                      className="h-8 px-3 rounded-md bg-secondary text-sm font-medium"
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => void saveEdit(item)}
                                      disabled={savingId === item.id}
                                      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
                                    >
                                      {savingId === item.id && <Loader2 size={13} className="animate-spin" />}
                                      Save
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div className="flex items-start gap-3">
                                  <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium break-words">{item.key}</div>
                                    <div className="text-sm text-muted-foreground break-words whitespace-pre-wrap">
                                      {item.value}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-1 shrink-0">
                                    <button
                                      type="button"
                                      onClick={() => startEdit(item)}
                                      className="p-1.5 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
                                      title="Edit"
                                    >
                                      <Pencil size={14} />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => void deleteEntry(item)}
                                      disabled={deletingId === item.id}
                                      className="p-1.5 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                                      title="Delete"
                                    >
                                      {deletingId === item.id ? (
                                        <Loader2 size={14} className="animate-spin" />
                                      ) : (
                                        <Trash2 size={14} />
                                      )}
                                    </button>
                                  </div>
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </PanelShell>
  );
}

interface VocabItem {
  id: string;
  kind: string;
  value: string;
  isDefault: boolean;
}

type CatalogEntryType = "subtype" | "material";
type ShadeMaterialGapStatus = "fully_fixable" | "partially_fixable" | "not_fixable";

interface ShadeMaterialGapRow {
  invoiceId: string;
  invoiceNumber: string;
  caseId: string | null;
  caseNumber: string | null;
  practiceName: string | null;
  patientName: string;
  currentShade: string;
  currentMaterial: string;
  shadeMissing: boolean;
  materialMissing: boolean;
  derivedShade: string | null;
  derivedMaterial: string | null;
  status: ShadeMaterialGapStatus;
}

interface ShadeMaterialGapsData {
  labOrganizationId: string;
  totalCaseLinked: number;
  gapCount: number;
  rows: ShadeMaterialGapRow[];
  rowsTruncated: boolean;
}

interface ShadeMaterialBackfillResult {
  labOrganizationId: string;
  gapInvoicesFound: number;
  updated: number;
  skippedNoDerivable: number;
  remainingGapCount: number;
  remainingRows: ShadeMaterialGapRow[];
  remainingRowsTruncated: boolean;
}

function CatalogInlineForm({
  action,
  value: initialValue,
  onSave,
  onCancel,
  saving,
}: {
  action: string;
  value?: string;
  onSave: (value: string) => void;
  onCancel: () => void;
  saving?: boolean;
}) {
  const [value, setValue] = useState(initialValue ?? "");
  return (
    <div className="flex items-center gap-2 px-2 py-2 bg-primary/5 border-t border-border">
      <span className="text-xs font-medium shrink-0">{action}</span>
      <input
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSave(value);
          if (event.key === "Escape") onCancel();
        }}
        disabled={saving}
        className="flex-1 min-w-0 h-7 px-2 rounded bg-background border border-border text-sm focus:outline-none focus:ring-1 focus:ring-primary"
      />
      <button type="button" onClick={() => onSave(value)} disabled={saving} className="inline-flex items-center gap-1 h-7 px-2 rounded bg-primary text-primary-foreground text-xs font-medium disabled:opacity-60">
        {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Save
      </button>
      <button type="button" onClick={onCancel} disabled={saving} className="h-7 px-2 rounded bg-secondary text-xs">
        <X size={11} />
      </button>
    </div>
  );
}
function ShadeMaterialGapStatusBadge({ status }: { status: ShadeMaterialGapStatus }) {
  if (status === "not_fixable") {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium whitespace-nowrap bg-destructive/10 text-destructive">
        Needs manual entry
      </span>
    );
  }
  if (status === "partially_fixable") {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium whitespace-nowrap bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
        Partial fix only
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium whitespace-nowrap bg-success/15 text-success">
      Fully fixable
    </span>
  );
}

// Dense admin table shared by the pre-run "missing shade or material" list
// and the post-run "Still needs review" list — same columns, same row
// shape, just a different source array. Rows needing manual attention sort
// first (see the server's SHADE_MATERIAL_GAP_STATUS_ORDER).
function ShadeMaterialGapRowsTable({
  rows,
  onOpenCase,
  onOpenInvoice,
}: {
  rows: ShadeMaterialGapRow[];
  onOpenCase: (caseId: string) => void;
  onOpenInvoice: (invoiceId: string) => void;
}) {
  return (
    <div className="border border-border rounded-md overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-secondary/40 text-muted-foreground">
            <th className="text-left font-medium px-2.5 py-1.5 whitespace-nowrap">Invoice</th>
            <th className="text-left font-medium px-2.5 py-1.5 whitespace-nowrap">Patient</th>
            <th className="text-left font-medium px-2.5 py-1.5 whitespace-nowrap">Practice</th>
            <th className="text-left font-medium px-2.5 py-1.5 whitespace-nowrap">Case</th>
            <th className="text-left font-medium px-2.5 py-1.5">Missing</th>
            <th className="text-left font-medium px-2.5 py-1.5">Would fill in</th>
            <th className="text-left font-medium px-2.5 py-1.5 whitespace-nowrap">Status</th>
            <th className="px-2.5 py-1.5" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const missingParts = [
              row.shadeMissing ? "Shade" : null,
              row.materialMissing ? "Material" : null,
            ].filter((v): v is string => !!v);
            const fillParts = [
              row.derivedShade ? `Shade: ${row.derivedShade}` : null,
              row.derivedMaterial ? `Material: ${row.derivedMaterial}` : null,
            ].filter((v): v is string => !!v);
            return (
              <tr
                key={row.invoiceId}
                data-testid={`shade-material-gap-row-${row.invoiceId}`}
                className={`border-t border-border ${i % 2 === 1 ? "bg-secondary/20" : ""}`}
              >
                <td className="px-2.5 py-1.5 font-medium whitespace-nowrap">{row.invoiceNumber}</td>
                <td className="px-2.5 py-1.5">{row.patientName || "—"}</td>
                <td className="px-2.5 py-1.5">{row.practiceName || "—"}</td>
                <td className="px-2.5 py-1.5 whitespace-nowrap">{row.caseNumber || "—"}</td>
                <td className="px-2.5 py-1.5 whitespace-nowrap">{missingParts.join(" & ") || "—"}</td>
                <td className="px-2.5 py-1.5 text-muted-foreground">
                  {fillParts.length > 0 ? fillParts.join("; ") : "—"}
                </td>
                <td className="px-2.5 py-1.5">
                  <ShadeMaterialGapStatusBadge status={row.status} />
                </td>
                <td className="px-2.5 py-1.5">
                  <div className="flex items-center gap-2.5 justify-end">
                    {row.caseId && (
                      <button
                        type="button"
                        onClick={() => onOpenCase(row.caseId!)}
                        data-testid={`shade-material-gap-open-case-${row.invoiceId}`}
                        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground whitespace-nowrap"
                        title="Open case"
                      >
                        Case <ExternalLink size={10} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpenInvoice(row.invoiceId)}
                      data-testid={`shade-material-gap-open-invoice-${row.invoiceId}`}
                      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground whitespace-nowrap"
                      title="Open invoice"
                    >
                      Invoice <ExternalLink size={10} />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const DEFAULT_STMT_EMAIL_SUBJECT = "Statement for {{practiceName}} — {{periodLabel}}";
const DEFAULT_STMT_EMAIL_BODY =
  "Hello {{practiceName}},\n\nPlease find attached the statement for {{practiceName}} covering {{periodLabel}}.\n\nThank you,\n{{labName}}";

function StatementEmailPanel() {
  const qc = useQueryClient();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  const query = useQuery<{ emailSubject: string | null; emailBody: string | null }>({
    queryKey: ["admin", "templates", "statement-email"],
    queryFn: () => apiFetch("/admin/templates/statement-email"),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (query.data) {
      setSubject(query.data.emailSubject ?? DEFAULT_STMT_EMAIL_SUBJECT);
      setBody(query.data.emailBody ?? DEFAULT_STMT_EMAIL_BODY);
      setDirty(false);
    }
  }, [query.data]);

  async function handleSave() {
    setSaveStatus("saving");
    setSaveError(null);
    try {
      await apiFetch("/admin/templates/statement-email", {
        method: "PATCH",
        body: JSON.stringify({ emailSubject: subject.trim() || null, emailBody: body.trim() || null }),
      });
      await qc.invalidateQueries({ queryKey: ["admin", "templates", "statement-email"] });
      setDirty(false);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2500);
    } catch (err: any) {
      setSaveError(err?.message || "Failed to save.");
      setSaveStatus("error");
    }
  }

  function handleReset() {
    setSubject(DEFAULT_STMT_EMAIL_SUBJECT);
    setBody(DEFAULT_STMT_EMAIL_BODY);
    setDirty(true);
  }

  if (query.isLoading) {
    return (
      <PanelShell title="Statement email template">
        <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      </PanelShell>
    );
  }

  return (
    <PanelShell
      title="Statement email template"
      subtitle="Default subject line and message pre-filled when emailing statements. Admins can still override per send."
    >
      <div className="space-y-5">
        <div className="text-xs text-muted-foreground bg-secondary/60 rounded-md px-3 py-2">
          Available placeholders: <code className="text-foreground">{"{{practiceName}}"}</code>, <code className="text-foreground">{"{{doctorName}}"}</code>, <code className="text-foreground">{"{{labName}}"}</code>, <code className="text-foreground">{"{{periodLabel}}"}</code>
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor="statement-email-subject" className="block text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Subject line</label>
            <input
              id="statement-email-subject"
              type="text"
              value={subject}
              onChange={(e) => { setSubject(e.target.value); setDirty(true); }}
              className="w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
            />
          </div>

          <div>
            <label htmlFor="statement-email-body" className="block text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Message body</label>
            <textarea
              id="statement-email-body"
              value={body}
              onChange={(e) => { setBody(e.target.value); setDirty(true); }}
              rows={8}
              className="w-full px-3 py-2 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary resize-y font-mono"
            />
          </div>
        </div>

        {saveError && (
          <div className="text-sm text-destructive border border-destructive/30 bg-destructive/10 rounded-md px-3 py-2">{saveError}</div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || saveStatus === "saving"}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saveStatus === "saving" ? <Loader2 size={13} className="animate-spin" /> : null}
            {saveStatus === "saved" ? <Check size={13} /> : null}
            {saveStatus === "saved" ? "Saved" : "Save template"}
          </button>
          <button
            type="button"
            onClick={handleReset}
            disabled={saveStatus === "saving"}
            className="inline-flex items-center gap-2 h-9 px-3 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/70 border border-border disabled:opacity-50"
          >
            <RotateCcw size={13} /> Reset to system default
          </button>
        </div>
      </div>
    </PanelShell>
  );
}

type AuthorizationTemplateType = "card_on_file" | "autopay";

function AuthorizationTemplatePanel({ templateType }: { templateType: AuthorizationTemplateType }) {
  const qc = useQueryClient();
  const meQuery = useQuery<MeResponse>({ queryKey: ["auth", "me"], queryFn: () => apiFetch("/auth/me"), staleTime: 60_000 });
  const adminLabs = useMemo(
    () => (meQuery.data?.memberships ?? []).filter(
      (m) => m.organization?.type === "lab" && m.status === "active" &&
        (m.role === "admin" || m.role === "owner"),
    ),
    [meQuery.data],
  );
  const [selectedLabId, setSelectedLabId] = useState<string | null>(null);
  const labId = selectedLabId ?? adminLabs[0]?.organizationId ?? null;
  useEffect(() => {
    if (selectedLabId && !adminLabs.some((membership) => membership.organizationId === selectedLabId)) {
      setSelectedLabId(null);
    }
  }, [adminLabs, selectedLabId]);
  const label = templateType === "card_on_file" ? "Card on File Authorization" : "Auto-Pay Authorization";
  const defaultText = templateType === "card_on_file"
    ? "Card on File Authorization\nI authorize {{labName}} to securely retain and charge the payment card on file for services and invoices issued to {{practiceName}}."
    : "Auto-Pay Authorization\nI authorize {{labName}} to automatically charge the payment method on file for invoices issued to {{practiceName}} on the agreed payment schedule.";
  const query = useQuery<Array<{ templateType: AuthorizationTemplateType; content: string; placeholders?: string[] }>>({
    queryKey: ["authorization-template", labId, templateType],
    enabled: !!labId,
    queryFn: () => apiFetch(`/admin/authorization-templates?labOrganizationId=${encodeURIComponent(labId!)}`),
  });
  const [content, setContent] = useState(defaultText);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const matching = query.data?.find((template) => template.templateType === templateType);
    if (matching) { setContent(matching.content); setDirty(false); }
  }, [query.data]);
  useEffect(() => {
    setContent(defaultText);
    setDirty(false);
    setNotice(null);
  }, [labId, templateType]);
  const save = useMutation({
    mutationFn: () => apiFetch(`/admin/authorization-templates/${templateType}`, { method: "PUT", body: JSON.stringify({ labOrganizationId: labId, content }) }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["authorization-template", labId, templateType] }); setDirty(false); setNotice("Template saved."); },
    onError: (e: Error) => setNotice(e.message || "Unable to save template."),
  });
  async function exportBlank() {
    try {
      const { buffer } = await apiFetchArrayBuffer(`/admin/authorization-templates/${templateType}/pdf?labOrganizationId=${encodeURIComponent(labId ?? "")}`);
      const url = URL.createObjectURL(new Blob([buffer], { type: "application/pdf" }));
      const a = document.createElement("a"); a.href = url; a.download = `${templateType}-authorization.pdf`; a.click(); URL.revokeObjectURL(url);
    } catch (e) { setNotice(e instanceof Error ? e.message : "Unable to export blank PDF."); }
  }
  return <PanelShell title={label} subtitle="Edit the blank form used outside the practice record. Completed authorizations must be uploaded as PDFs from the practice Card on File tab.">
    {adminLabs.length > 1 && <div className="mb-4 max-w-md"><label htmlFor={`authorization-template-lab-${templateType}`} className="block text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Lab</label><select id={`authorization-template-lab-${templateType}`} aria-label="Authorization template lab" value={labId ?? ""} onChange={(e) => setSelectedLabId(e.target.value || null)} className="h-9 w-full rounded-md border border-border bg-secondary px-2 text-sm"><option value="" disabled>Select a lab</option>{adminLabs.map((membership) => <option key={membership.organizationId} value={membership.organizationId}>{membership.organization?.displayName || membership.organization?.name || membership.organizationId}</option>)}</select></div>}
    {query.isLoading ? <div className="text-sm text-muted-foreground"><Loader2 size={14} className="inline animate-spin mr-2" />Loading template…</div> :
      query.isError ? <div className="text-sm text-destructive">Unable to load this template. {(query.error as Error).message}</div> :
      <div className="space-y-4">
        <div><label htmlFor={`authorization-template-${templateType}`} className="block text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Authorization content</label>
          <textarea id={`authorization-template-${templateType}`} data-testid={`authorization-template-${templateType}`} value={content} onChange={(e) => { setContent(e.target.value); setDirty(true); }} rows={12} className="w-full px-3 py-2 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary resize-y" />
        </div>
        <p className="text-xs text-muted-foreground">Placeholders: <code>{"{{labName}}"}</code>, <code>{"{{practiceName}}"}</code>, <code>{"{{signerName}}"}</code>, <code>{"{{date}}"}</code></p>
        {notice && <p role="status" className={notice.includes("saved") ? "text-sm text-emerald-600" : "text-sm text-destructive"}>{notice}</p>}
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => save.mutate()} disabled={!dirty || save.isPending || !labId} className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">{save.isPending && <Loader2 size={13} className="animate-spin" />}{save.isPending ? "Saving…" : "Save template"}</button>
          <button type="button" onClick={() => { setContent(defaultText); setDirty(true); setNotice(null); }} disabled={save.isPending} className="inline-flex items-center gap-2 h-9 px-3 rounded-md bg-secondary text-sm border border-border disabled:opacity-50"><RotateCcw size={13} />Reset to system default</button>
          <button type="button" onClick={() => void exportBlank()} disabled={!labId} className="inline-flex items-center gap-2 h-9 px-3 rounded-md bg-secondary text-sm border border-border disabled:opacity-50"><FileDown size={13} />Export blank PDF</button>
        </div>
      </div>}
  </PanelShell>;
}

const DEFAULT_PAYMENT_RECEIPT_SUBJECT =
  "Payment receipt from {{labName}} — {{receiptNumber}}";
const DEFAULT_PAYMENT_RECEIPT_BODY = `Hello {{customerName}},

Thank you for your payment to {{labName}}.
Receipt: {{receiptNumber}}
Payment date: {{paymentDate}}
Amount received: {{amountReceived}}
Amount applied: {{amountApplied}}
Account credit: {{customerCredit}}
Remaining account balance: {{openBalance}}
Payment method: {{paymentMethod}}
{{referenceLine}}

Thank you,
{{labName}}`;
const PAYMENT_RECEIPT_PLACEHOLDERS = [
  "{{receiptNumber}}", "{{labName}}", "{{customerName}}", "{{paymentDate}}",
  "{{amountReceived}}", "{{amountApplied}}", "{{customerCredit}}",
  "{{openBalance}}", "{{paymentMethod}}", "{{referenceNumber}}", "{{referenceLine}}",
];

function PaymentReceiptTemplatePanel() {
  const qc = useQueryClient();
  const meQuery = useQuery<MeResponse>({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch("/auth/me"),
    staleTime: 60_000,
  });
  const adminLabs = useMemo(
    () => (meQuery.data?.memberships ?? []).filter(
      (m) => m.organization?.type === "lab" && m.status === "active" &&
        (m.role === "admin" || m.role === "owner"),
    ),
    [meQuery.data],
  );
  const [selectedLabId, setSelectedLabId] = useState<string | null>(null);
  const labOrganizationId = selectedLabId ?? adminLabs[0]?.organizationId ?? null;
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const templateQuery = useQuery<{
    emailSubject: string;
    emailBody: string;
    placeholders: string[];
  }>({
    queryKey: ["billing", "payment-receipt-template", labOrganizationId],
    enabled: !!labOrganizationId,
    queryFn: () => apiFetch(`/billing/${encodeURIComponent(labOrganizationId!)}/payment-receipt-template`),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (templateQuery.data) {
      setSubject(templateQuery.data.emailSubject);
      setBody(templateQuery.data.emailBody);
      setDirty(false);
      setError(null);
    }
  }, [templateQuery.data]);

  const saveTemplate = useMutation({
    mutationFn: () => {
      const emailSubject = subject.trim();
      const emailBody = body.trim();
      if (!emailSubject) throw new Error("Subject line cannot be blank.");
      if (!emailBody) throw new Error("Message body cannot be blank.");
      if (emailSubject.length > 998) throw new Error("Subject line must be 998 characters or fewer.");
      if (emailBody.length > 20_000) throw new Error("Message body must be 20,000 characters or fewer.");
      return apiFetch(`/billing/${encodeURIComponent(labOrganizationId!)}/payment-receipt-template`, {
        method: "PATCH",
        body: JSON.stringify({ emailSubject, emailBody }),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["billing", "payment-receipt-template", labOrganizationId] });
      setDirty(false);
      toast({ title: "Payment receipt template saved" });
    },
    onError: (err: Error) => setError(err.message || "Could not save payment receipt template."),
  });

  return (
    <PanelShell
      title="Payment receipt template"
      subtitle="Set the default subject and message used for statement-led payment receipts."
    >
      {!labOrganizationId ? (
        <div className="text-sm text-muted-foreground">No lab organization is available.</div>
      ) : templateQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : (
        <div className="space-y-5">
          {adminLabs.length > 1 && (
            <select
              aria-label="Lab organization"
              value={labOrganizationId}
              onChange={(e) => setSelectedLabId(e.target.value || null)}
              className="h-9 px-3 rounded-md bg-secondary text-sm border border-border focus:outline-none"
            >
              {adminLabs.map((m) => <option key={m.organizationId} value={m.organizationId}>{m.organization?.name ?? m.organizationId}</option>)}
            </select>
          )}
          <div className="text-xs text-muted-foreground bg-secondary/60 rounded-md px-3 py-2">
            Available placeholders: {PAYMENT_RECEIPT_PLACEHOLDERS.map((placeholder, index) => (
              <span key={placeholder}><code className="text-foreground">{placeholder}</code>{index < PAYMENT_RECEIPT_PLACEHOLDERS.length - 1 ? ", " : ""}</span>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Edits made while sending an individual receipt do not change this saved default.</p>
          <div>
            <label className="block text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Subject line</label>
            <input aria-label="Subject line" value={subject} maxLength={998} onChange={(e) => { setSubject(e.target.value); setDirty(true); }} className="w-full h-9 px-3 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary" />
            <p className="text-[11px] text-muted-foreground mt-1">{subject.length}/998 characters</p>
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Message body</label>
            <textarea aria-label="Message body" value={body} maxLength={20_000} rows={12} onChange={(e) => { setBody(e.target.value); setDirty(true); }} className="w-full px-3 py-2 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary resize-y font-mono" />
            <p className="text-[11px] text-muted-foreground mt-1">{body.length}/20,000 characters</p>
          </div>
          {error && <div className="text-sm text-destructive border border-destructive/30 bg-destructive/10 rounded-md px-3 py-2">{error}</div>}
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => { setError(null); saveTemplate.mutate(); }} disabled={!dirty || saveTemplate.isPending} className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
              {saveTemplate.isPending && <Loader2 size={13} className="animate-spin" />} Save template
            </button>
            <button type="button" onClick={() => { setSubject(DEFAULT_PAYMENT_RECEIPT_SUBJECT); setBody(DEFAULT_PAYMENT_RECEIPT_BODY); setDirty(true); setError(null); }} disabled={saveTemplate.isPending} className="inline-flex items-center gap-2 h-9 px-3 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/70 border border-border disabled:opacity-50">
              <RotateCcw size={13} /> Restore system default
            </button>
          </div>
        </div>
      )}
    </PanelShell>
  );
}

function VocabularyPanel() {
  const qc = useQueryClient();
  const [, setLocation] = useLocation();

  const meQuery = useQuery<MeResponse>({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch("/auth/me"),
    staleTime: 60_000,
  });

  const adminLabs = useMemo(() => {
    return (meQuery.data?.memberships ?? []).filter(
      (m) =>
        m.organization?.type === "lab" &&
        m.status === "active" &&
        (m.role === "admin" || m.role === "owner"),
    );
  }, [meQuery.data]);

  const [selectedLabId, setSelectedLabId] = useState<string | null>(null);
  const effectiveLabId = selectedLabId ?? adminLabs[0]?.organizationId ?? null;

  const gapsQuery = useQuery<ShadeMaterialGapsData>({
    enabled: !!effectiveLabId,
    queryKey: ["invoices", "shade-material-gaps", effectiveLabId],
    queryFn: () =>
      apiFetch(
        `/invoices/admin/shade-material-gaps?labOrganizationId=${encodeURIComponent(effectiveLabId!)}`,
      ),
    staleTime: 60_000,
  });

  const [backfillResult, setBackfillResult] = useState<ShadeMaterialBackfillResult | null>(null);
  const [backfillError, setBackfillError] = useState<string | null>(null);

  const backfillMutation = useMutation({
    mutationFn: () =>
      apiFetch<ShadeMaterialBackfillResult>("/invoices/admin/shade-material-backfill", {
        method: "POST",
        body: JSON.stringify({ labOrganizationId: effectiveLabId }),
      }),
    onSuccess: (data) => {
      setBackfillResult(data);
      setBackfillError(null);
      void qc.invalidateQueries({ queryKey: ["invoices", "shade-material-gaps", effectiveLabId] });
    },
    onError: (err: unknown) => {
      setBackfillError(err instanceof Error ? err.message : "Backfill failed.");
      setBackfillResult(null);
    },
  });

  // One query per kind
  const queryForKind = (kind: VocabKind) =>
    ({
      enabled: !!effectiveLabId,
      queryKey: ["vocabulary", kind, effectiveLabId],
      queryFn: () =>
        apiFetch<VocabItem[]>(
          `/vocabulary?kind=${kind}&labOrganizationId=${encodeURIComponent(effectiveLabId!)}`,
        ),
      staleTime: 30_000,
    }) as const;

  const shadeQ = useQuery(queryForKind("shade"));

  // Editing state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  // Delete confirm
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ item: VocabItem; usageCount: number } | null>(null);

  function startEdit(item: VocabItem) {
    setEditingId(item.id);
    setEditValue(item.value);
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditValue("");
    setEditError(null);
  }

  async function saveEdit(item: VocabItem) {
    const trimmed = editValue.trim();
    if (!trimmed) {
      setEditError("Value must not be blank.");
      return;
    }
    setSavingId(item.id);
    setEditError(null);
    try {
      await apiFetch(`/vocabulary/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ value: trimmed }),
      });
      await qc.invalidateQueries({ queryKey: ["vocabulary", item.kind, effectiveLabId] });
      setEditingId(null);
    } catch (err: unknown) {
      setEditError(err instanceof Error ? err.message : "Could not rename item.");
    } finally {
      setSavingId(null);
    }
  }

  async function initiateDelete(item: VocabItem) {
    setDeletingId(item.id);
    setDeleteError(null);
    try {
      await apiFetch(`/vocabulary/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      await qc.invalidateQueries({ queryKey: ["vocabulary", item.kind, effectiveLabId] });
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as { usageCount?: number } | null;
        const usageCount = typeof body?.usageCount === "number" ? body.usageCount : 1;
        setPendingDelete({ item, usageCount });
      } else {
        setDeleteError(err instanceof Error ? err.message : "Could not delete item.");
      }
    } finally {
      setDeletingId(null);
    }
  }

  async function forceDelete() {
    if (!pendingDelete) return;
    const { item } = pendingDelete;
    setPendingDelete(null);
    setDeletingId(item.id);
    setDeleteError(null);
    try {
      await apiFetch(`/vocabulary/${encodeURIComponent(item.id)}?force=true`, { method: "DELETE" });
      await qc.invalidateQueries({ queryKey: ["vocabulary", item.kind, effectiveLabId] });
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : "Could not delete item.");
    } finally {
      setDeletingId(null);
    }
  }

  const isLoading = shadeQ.isLoading;

  return (
    <PanelShell
      title="Lab Catalog"
      subtitle="Define the materials, shades, and restoration types your lab uses — these appear as selectable options when creating cases and invoices."
    >
      {adminLabs.length > 1 && (
        <div className="mb-2">
          <select
            value={effectiveLabId ?? ""}
            onChange={(e) => setSelectedLabId(e.target.value || null)}
            className="h-9 px-3 rounded-md bg-secondary text-sm border border-border focus:outline-none"
          >
            {adminLabs.map((m) => (
              <option key={m.organizationId} value={m.organizationId}>
                {m.organization?.name ?? m.organizationId}
              </option>
            ))}
          </select>
        </div>
      )}

      {!effectiveLabId && !meQuery.isLoading && (
        <p className="text-sm text-muted-foreground text-center py-10">No lab available.</p>
      )}

      {isLoading && effectiveLabId && (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-8 justify-center">
          <Loader2 size={14} className="animate-spin" />
          Loading…
        </div>
      )}

      {deleteError && (
        <Alert tone="danger">{deleteError}</Alert>
      )}

      {!isLoading && effectiveLabId && (
        <div className="space-y-8">
          <CatalogTreeEditor labOrganizationId={effectiveLabId} />
          <LegacyVocabularyReviewSection labOrganizationId={effectiveLabId} />
          <div className="border-t border-border pt-5">
            <h3 className="text-sm font-semibold mb-0.5">Shades</h3>
            <p className="text-xs text-muted-foreground mb-3">{VOCAB_KIND_DESCRIPTIONS.shade}</p>
            {shadeQ.isError && <p className="text-sm text-destructive py-2">Failed to load.</p>}
            {!shadeQ.isError && (shadeQ.data ?? []).filter((item) => !item.isDefault).length === 0 && (
              <div className="rounded-md border border-border bg-secondary/20 px-3 py-2.5">
                <p className="text-xs text-muted-foreground mb-2">No custom shades yet — your team will see the built-in defaults:</p>
                <div className="flex flex-wrap gap-1.5">
                  {(VOCAB_BUILTIN_DEFAULTS.shade ?? []).map((value) => <span key={value} className="inline-block px-2 py-0.5 rounded bg-secondary text-xs text-muted-foreground border border-border/60">{value}</span>)}
                </div>
              </div>
            )}
            {!shadeQ.isError && (shadeQ.data ?? []).filter((item) => !item.isDefault).length > 0 && (
              <div className="border border-border rounded-md overflow-hidden">
                {(shadeQ.data ?? []).filter((item) => !item.isDefault).map((item, index) => {
                  const isEditing = editingId === item.id;
                  const isSaving = savingId === item.id;
                  const isBeingDeleted = deletingId === item.id;
                  return <div key={item.id} className={`flex items-center gap-2 px-3 py-2 ${index > 0 ? "border-t border-border" : ""} ${index % 2 === 0 ? "" : "bg-secondary/20"}`}>
                    {isEditing ? <>
                      <input autoFocus type="text" value={editValue} onChange={(event) => { setEditValue(event.target.value); setEditError(null); }} onKeyDown={(event) => { if (event.key === "Enter") void saveEdit(item); if (event.key === "Escape") cancelEdit(); }} disabled={isSaving} className="flex-1 h-7 px-2 rounded bg-background border border-border text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60" />
                      {editError && <span className="text-xs text-destructive shrink-0">{editError}</span>}
                      <button type="button" onClick={() => void saveEdit(item)} disabled={isSaving} className="inline-flex items-center gap-1 h-7 px-2 rounded bg-primary text-primary-foreground text-xs font-medium disabled:opacity-60">{isSaving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Save</button>
                      <button type="button" onClick={cancelEdit} disabled={isSaving} className="inline-flex items-center h-7 px-2 rounded bg-secondary text-xs"><X size={11} /></button>
                    </> : <>
                      <span className="flex-1 text-sm truncate">{item.value}</span>
                      <button type="button" onClick={() => startEdit(item)} disabled={isBeingDeleted || !!editingId} title="Rename" className="text-muted-foreground hover:text-foreground disabled:opacity-40 p-1 rounded"><Pencil size={13} /></button>
                      <button type="button" onClick={() => void initiateDelete(item)} disabled={isBeingDeleted || !!editingId} title="Delete" className="text-muted-foreground hover:text-destructive disabled:opacity-40 p-1 rounded">{isBeingDeleted ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}</button>
                    </>}
                  </div>;
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {effectiveLabId && (
        <div className="border-t border-border pt-5 mt-2">
          <details className="group">
            <summary className="flex items-center gap-2 cursor-pointer list-none select-none">
              <ChevronRight size={14} className="text-muted-foreground group-open:rotate-90 transition-transform shrink-0" />
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Advanced</span>
            </summary>
            <div className="mt-4 space-y-3 pl-5">
              <div>
                <h4 className="text-sm font-medium mb-1">Fill in missing shade &amp; material info</h4>
                <p className="text-sm text-muted-foreground">
                  Some older invoices may be missing shade or material information. Run this tool to fill them in automatically without overwriting values you've already edited.
                </p>
              </div>

              {gapsQuery.isLoading && (
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Loader2 size={13} className="animate-spin" /> Checking…
                </div>
              )}

              {gapsQuery.isError && (
                <p className="text-sm text-destructive">Failed to load.</p>
              )}

              {gapsQuery.data && (
                <div className="rounded-md border border-border bg-secondary/30 px-4 py-3 text-sm">
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                    <span className="text-muted-foreground">Case-linked invoices</span>
                    <span>{gapsQuery.data.totalCaseLinked.toLocaleString()}</span>
                    <span className="text-muted-foreground">Missing shade or material</span>
                    <span className={gapsQuery.data.gapCount > 0 ? "font-semibold text-amber-600 dark:text-amber-400" : ""}>
                      {gapsQuery.data.gapCount.toLocaleString()}
                      {gapsQuery.data.gapCount === 0 && " — all up to date"}
                    </span>
                  </div>
                </div>
              )}

              {gapsQuery.data && gapsQuery.data.rows.length > 0 && (
                <div className="space-y-1.5" data-testid="shade-material-gaps-list">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Invoices missing shade or material
                    </p>
                    {gapsQuery.data.rowsTruncated && (
                      <p className="text-[11px] text-muted-foreground shrink-0">
                        Showing {gapsQuery.data.rows.length.toLocaleString()} of{" "}
                        {gapsQuery.data.gapCount.toLocaleString()}
                      </p>
                    )}
                  </div>
                  <ShadeMaterialGapRowsTable
                    rows={gapsQuery.data.rows}
                    onOpenCase={(caseId) => setLocation(`/cases?caseId=${encodeURIComponent(caseId)}`)}
                    onOpenInvoice={(invoiceId) => setLocation(`/invoices?invoiceId=${encodeURIComponent(invoiceId)}`)}
                  />
                </div>
              )}

              {backfillError && (
                <Alert tone="danger">{backfillError}</Alert>
              )}

              {backfillResult && (
                <>
                  <Alert tone="success">
                    Done — {backfillResult.updated} invoice{backfillResult.updated === 1 ? "" : "s"} updated
                    {backfillResult.skippedNoDerivable > 0
                      ? `, ${backfillResult.skippedNoDerivable} skipped (no restoration data to draw from).`
                      : "."}
                  </Alert>
                  {backfillResult.remainingRows.length > 0 ? (
                    <div className="space-y-1.5" data-testid="shade-material-remaining-list">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Still needs review
                        </p>
                        {backfillResult.remainingRowsTruncated && (
                          <p className="text-[11px] text-muted-foreground shrink-0">
                            Showing {backfillResult.remainingRows.length.toLocaleString()} of{" "}
                            {backfillResult.remainingGapCount.toLocaleString()}
                          </p>
                        )}
                      </div>
                      <ShadeMaterialGapRowsTable
                        rows={backfillResult.remainingRows}
                        onOpenCase={(caseId) => setLocation(`/cases?caseId=${encodeURIComponent(caseId)}`)}
                        onOpenInvoice={(invoiceId) => setLocation(`/invoices?invoiceId=${encodeURIComponent(invoiceId)}`)}
                      />
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground" data-testid="shade-material-remaining-empty">
                      Nothing left to review — every case-linked invoice has shade and material filled in.
                    </p>
                  )}
                </>
              )}

              <button
                type="button"
                data-testid="shade-material-backfill-run-btn"
                disabled={!effectiveLabId || backfillMutation.isPending || (gapsQuery.data?.gapCount === 0)}
                onClick={() => {
                  setBackfillResult(null);
                  setBackfillError(null);
                  backfillMutation.mutate();
                }}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-60"
              >
                {backfillMutation.isPending
                  ? <><Loader2 size={12} className="animate-spin" /> Running…</>
                  : <><Play size={12} /> Fill in now</>}
              </button>
            </div>
          </details>
        </div>
      )}

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{pendingDelete?.item.value}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This term is used in {pendingDelete?.usageCount} existing case{pendingDelete?.usageCount === 1 ? "" : "s"}. Cases will keep their current text, but the term will no longer appear in the suggestions list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void forceDelete()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PanelShell>
  );
}

// ── US Federal Holiday helpers (client-side mirror of the server lib) ─────────

function _dateToYmd(d: Date): string {
  return (
    `${d.getUTCFullYear()}-` +
    `${String(d.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getUTCDate()).padStart(2, "0")}`
  );
}

function _observed(yr: number, mo1: number, day: number): string {
  const d = new Date(Date.UTC(yr, mo1 - 1, day));
  const dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
  return _dateToYmd(d);
}

function _nthWeekday(yr: number, mo1: number, n: number, weekday: number): string {
  const first = new Date(Date.UTC(yr, mo1 - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return _dateToYmd(new Date(Date.UTC(yr, mo1 - 1, day)));
}

function _lastWeekday(yr: number, mo1: number, weekday: number): string {
  const last = new Date(Date.UTC(yr, mo1, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  const day = last.getUTCDate() - offset;
  return _dateToYmd(new Date(Date.UTC(yr, mo1 - 1, day)));
}

function usFederalHolidaysForYear(yr: number): Array<{ date: string; name: string }> {
  return [
    { date: _observed(yr, 1, 1),          name: "New Year's Day" },
    { date: _nthWeekday(yr, 1, 3, 1),     name: "Martin Luther King Jr. Day" },
    { date: _nthWeekday(yr, 2, 3, 1),     name: "Presidents' Day" },
    { date: _lastWeekday(yr, 5, 1),       name: "Memorial Day" },
    { date: _observed(yr, 6, 19),         name: "Juneteenth" },
    { date: _observed(yr, 7, 4),          name: "Independence Day" },
    { date: _nthWeekday(yr, 9, 1, 1),     name: "Labor Day" },
    { date: _nthWeekday(yr, 10, 2, 1),    name: "Columbus Day" },
    { date: _observed(yr, 11, 11),        name: "Veterans Day" },
    { date: _nthWeekday(yr, 11, 4, 4),    name: "Thanksgiving Day" },
    { date: _observed(yr, 12, 25),        name: "Christmas Day" },
  ];
}

/** Build a name lookup map for all US federal holidays across the given years. */
function buildFederalHolidayNames(years: number[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const yr of years) {
    for (const h of usFederalHolidaysForYear(yr)) {
      map[h.date] = h.name;
    }
  }
  return map;
}

interface ClosedDay {
  id: string;
  date: string;
  note: string | null;
  createdAt: string;
}

function formatClosedDate(dateStr: string): string {
  const [yr, mo, day] = dateStr.split("-").map(Number);
  const d = new Date(Date.UTC(yr, mo - 1, day));
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

function ClosedDaysPanel() {
  const qc = useQueryClient();

  const meQuery = useQuery<MeResponse>({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch("/auth/me"),
    staleTime: 60_000,
  });

  const adminLabs = useMemo(() => {
    return (meQuery.data?.memberships ?? []).filter(
      (m) =>
        m.organization?.type === "lab" &&
        m.status === "active" &&
        (m.role === "admin" || m.role === "owner"),
    );
  }, [meQuery.data]);

  const [selectedLabId, setSelectedLabId] = useState<string | null>(null);
  const effectiveLabId = selectedLabId ?? adminLabs[0]?.organizationId ?? null;

  const closedDaysQuery = useQuery<{ closedDays: ClosedDay[] }>({
    enabled: !!effectiveLabId,
    queryKey: ["closed-days", effectiveLabId],
    queryFn: () => apiFetch(`/organizations/${encodeURIComponent(effectiveLabId!)}/settings/closed-days`),
    staleTime: 30_000,
  });

  // Compute US federal holidays for this year and next two years.
  const federalHolidayNames = useMemo(() => {
    const thisYear = new Date().getFullYear();
    return buildFederalHolidayNames([thisYear - 1, thisYear, thisYear + 1, thisYear + 2]);
  }, []);

  // Build a merged list sorted by date: custom days + upcoming federal holidays.
  const customDays = closedDaysQuery.data?.closedDays ?? [];
  const customDayDates = useMemo(() => new Set(customDays.map((d) => d.date)), [customDays]);

  // Upcoming federal holidays (this year + next 2 years, not already in custom days).
  const upcomingFederalDays = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return Object.entries(federalHolidayNames)
      .filter(([date]) => date >= today)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 20);
  }, [federalHolidayNames]);

  // Add form state.
  const [newDate, setNewDate] = useState("");
  const [newNote, setNewNote] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const addMutation = useMutation({
    mutationFn: async () => {
      if (!effectiveLabId) throw new Error("No lab selected.");
      if (!newDate) throw new Error("Date is required.");
      return apiFetch(`/organizations/${encodeURIComponent(effectiveLabId)}/settings/closed-days`, {
        method: "POST",
        body: JSON.stringify({ date: newDate, note: newNote.trim() || undefined }),
      });
    },
    onSuccess: () => {
      setNewDate("");
      setNewNote("");
      setAddError(null);
      void qc.invalidateQueries({ queryKey: ["closed-days", effectiveLabId] });
    },
    onError: (err: Error) => {
      setAddError(err.message || "Could not add closed day.");
    },
  });

  const [deletingDate, setDeletingDate] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete(date: string) {
    if (!effectiveLabId) return;
    setDeletingDate(date);
    setDeleteError(null);
    try {
      await apiFetch(
        `/organizations/${encodeURIComponent(effectiveLabId)}/settings/closed-days/${encodeURIComponent(date)}`,
        { method: "DELETE" },
      );
      void qc.invalidateQueries({ queryKey: ["closed-days", effectiveLabId] });
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : "Could not delete entry.");
    } finally {
      setDeletingDate(null);
    }
  }

  return (
    <PanelShell
      title="Closed Days"
      subtitle="Custom dates when your lab is closed. These are excluded from business-day calculations in Stats."
    >
      {adminLabs.length > 1 && (
        <div className="mb-2">
          <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">Lab</label>
          <select
            value={effectiveLabId ?? ""}
            onChange={(e) => setSelectedLabId(e.target.value || null)}
            className="h-9 px-2 rounded-md border border-border bg-background text-sm"
          >
            {adminLabs.map((m) => (
              <option key={m.organizationId} value={m.organizationId}>
                {m.organization?.name ?? m.organizationId}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Add new closed day */}
      <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
        <p className="text-xs font-medium text-foreground">Add a custom closed day</p>
        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">Date</label>
            <input
              type="date"
              value={newDate}
              onChange={(e) => { setNewDate(e.target.value); setAddError(null); }}
              className="h-9 px-2 rounded-md border border-border bg-background text-sm w-44"
            />
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">Note (optional)</label>
            <input
              type="text"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              placeholder="e.g. Studio closed for renovation"
              maxLength={200}
              className="h-9 px-2 rounded-md border border-border bg-background text-sm w-full"
            />
          </div>
          <button
            type="button"
            disabled={!newDate || addMutation.isPending || !effectiveLabId}
            onClick={() => void addMutation.mutate()}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-60 shrink-0"
          >
            {addMutation.isPending
              ? <><Loader2 size={12} className="animate-spin" /> Adding…</>
              : <><Calendar size={12} /> Add</>}
          </button>
        </div>
        {addError && <Alert tone="danger">{addError}</Alert>}
      </div>

      {deleteError && <Alert tone="danger">{deleteError}</Alert>}

      {/* Custom closed days list */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-foreground">Custom closed days</p>
        {closedDaysQuery.isPending && !closedDaysQuery.data && (
          <p className="text-xs text-muted-foreground py-2">Loading…</p>
        )}
        {closedDaysQuery.isError && (
          <Alert tone="danger">Could not load closed days.</Alert>
        )}
        {closedDaysQuery.isSuccess && customDays.length === 0 && (
          <p className="text-xs text-muted-foreground py-2 italic">No custom closed days yet.</p>
        )}
        {customDays.map((day) => {
          const isFederal = !!federalHolidayNames[day.date];
          return (
            <div
              key={day.id}
              className="flex items-start justify-between gap-3 rounded-md border border-border bg-background px-3 py-2.5"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <CalendarOff size={13} className="text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium">{formatClosedDate(day.date)}</span>
                  {isFederal && (
                    <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                      US holiday
                    </span>
                  )}
                </div>
                {day.note && (
                  <p className="text-xs text-muted-foreground mt-0.5 ml-5">{day.note}</p>
                )}
              </div>
              <button
                type="button"
                disabled={deletingDate === day.date}
                onClick={() => void handleDelete(day.date)}
                className="shrink-0 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive disabled:opacity-50 transition-colors"
                title="Remove this closed day"
              >
                {deletingDate === day.date ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
              </button>
            </div>
          );
        })}
      </div>

      {/* US Federal Holidays (read-only reference) */}
      <div className="space-y-2 pt-1">
        <div>
          <p className="text-xs font-semibold text-foreground">US Federal Holidays</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            These are automatically excluded from business-day calculations. They cannot be removed.
          </p>
        </div>
        <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
          {upcomingFederalDays.map(([date, name]) => (
            <div
              key={date}
              className={`flex items-center justify-between px-3 py-2 text-xs gap-3 ${
                customDayDates.has(date) ? "bg-amber-50 dark:bg-amber-900/10" : "bg-background"
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <Calendar size={12} className="text-muted-foreground shrink-0" />
                <span className="font-medium truncate">{name}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-muted-foreground">{formatClosedDate(date)}</span>
                {customDayDates.has(date) && (
                  <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                    + custom note
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </PanelShell>
  );
}

// ──────────────────────────── Permission Outline Panel ───────────────────────

const CAPABILITY_LABELS_DESKTOP: Record<string, string> = {
  delete_cases: "Delete Cases",
  manage_pricing: "Manage Pricing",
  view_financial_reports: "View Financial Reports",
  export_data: "Export Data",
  manage_team_members: "Manage Team Members",
  configure_integrations: "Configure Integrations",
  approve_invoices: "Approve Invoices",
};

const CAPABILITY_KEYS_DESKTOP = Object.keys(CAPABILITY_LABELS_DESKTOP);

interface PermissionDef {
  id: string;
  labId: string;
  name: string;
  description?: string | null;
  capabilityKey: string;
  createdAt: string;
  updatedAt: string;
}

interface MemberPermissionGrants {
  membershipId: string;
  permissionDefinitionIds: string[];
}

function PermissionOutlinePanel() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const orgId = user?.practiceOrganizationId ?? "";

  const [showDefForm, setShowDefForm] = useState(false);
  const [editingDef, setEditingDef] = useState<PermissionDef | null>(null);
  const [defName, setDefName] = useState("");
  const [defDesc, setDefDesc] = useState("");
  const [defCapKey, setDefCapKey] = useState(CAPABILITY_KEYS_DESKTOP[0]);

  const [memberPermsTarget, setMemberPermsTarget] = useState<{
    membershipId: string;
    name: string;
  } | null>(null);
  const [memberGrantIds, setMemberGrantIds] = useState<string[]>([]);
  const [savingMemberPerms, setSavingMemberPerms] = useState(false);

  const defsQuery = useQuery<PermissionDef[]>({
    queryKey: ["permission-definitions", orgId],
    queryFn: () => apiFetch<PermissionDef[]>(`/organizations/${orgId}/permission-definitions`),
    enabled: !!orgId,
    staleTime: 30_000,
  });

  const teamQuery = useQuery<{ team: LabTeamMember[]; callerRole: string | null }>({
    queryKey: ["lab-team"],
    queryFn: () => apiFetch("/auth/lab-team"),
    staleTime: 30_000,
  });

  const createDefMutation = useMutation({
    mutationFn: (input: { name: string; description?: string; capabilityKey: string }) =>
      apiFetch(`/organizations/${orgId}/permission-definitions`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["permission-definitions", orgId] });
      closeDefForm();
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const updateDefMutation = useMutation({
    mutationFn: ({ id, ...input }: { id: string; name: string; description?: string; capabilityKey: string }) =>
      apiFetch(`/organizations/${orgId}/permission-definitions/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["permission-definitions", orgId] });
      closeDefForm();
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteDefMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/organizations/${orgId}/permission-definitions/${id}`, { method: "DELETE" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["permission-definitions", orgId] }),
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const defs = defsQuery.data ?? [];
  const callerRole = teamQuery.data?.callerRole;
  const isCallerOwner = callerRole === "owner";
  const members = (teamQuery.data?.team ?? []).filter((m) => !m.isOwner && !!m.membershipId);

  function openCreateDef() {
    setEditingDef(null);
    setDefName("");
    setDefDesc("");
    setDefCapKey(CAPABILITY_KEYS_DESKTOP[0]);
    setShowDefForm(true);
  }

  function openEditDef(def: PermissionDef) {
    setEditingDef(def);
    setDefName(def.name);
    setDefDesc(def.description ?? "");
    setDefCapKey(def.capabilityKey);
    setShowDefForm(true);
  }

  function closeDefForm() {
    setShowDefForm(false);
    setEditingDef(null);
    setDefName("");
    setDefDesc("");
    setDefCapKey(CAPABILITY_KEYS_DESKTOP[0]);
  }

  function saveDefForm() {
    if (!defName.trim()) return;
    const input = {
      name: defName.trim(),
      description: defDesc.trim() || undefined,
      capabilityKey: defCapKey,
    };
    if (editingDef) {
      updateDefMutation.mutate({ id: editingDef.id, ...input });
    } else {
      createDefMutation.mutate(input);
    }
  }

  async function openMemberPerms(membershipId: string, name: string) {
    setMemberPermsTarget({ membershipId, name });
    setMemberGrantIds([]);
    try {
      const r = await apiFetch<MemberPermissionGrants>(
        `/organizations/${orgId}/members/${membershipId}/permissions`
      );
      setMemberGrantIds((r as MemberPermissionGrants).permissionDefinitionIds ?? []);
    } catch {
      setMemberGrantIds([]);
    }
  }

  async function saveMemberPerms() {
    if (!memberPermsTarget) return;
    setSavingMemberPerms(true);
    try {
      await apiFetch(`/organizations/${orgId}/members/${memberPermsTarget.membershipId}/permissions`, {
        method: "PUT",
        body: JSON.stringify({ permissionDefinitionIds: memberGrantIds }),
      });
      setMemberPermsTarget(null);
      toast({ title: "Permissions updated", duration: 3000 });
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSavingMemberPerms(false);
    }
  }

  return (
    <PanelShell
      title="Permission Outline"
      subtitle="Define custom permissions and assign them to lab team members. Owners and admins always have full access."
    >
      {!isCallerOwner && !teamQuery.isLoading && (
        <div className="rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-800/40">
          Only the lab owner can manage permission definitions and assignments.
        </div>
      )}

      {/* Permission Definitions */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Permission Definitions</h3>
          {isCallerOwner && (
            <button
              type="button"
              onClick={openCreateDef}
              className="text-xs px-2.5 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 font-medium"
            >
              + New definition
            </button>
          )}
        </div>

        {defsQuery.isLoading && (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
        {defs.length === 0 && !defsQuery.isLoading && (
          <p className="text-sm text-muted-foreground italic">
            No permission definitions yet.{isCallerOwner ? " Click \"+ New definition\" to create one." : ""}
          </p>
        )}

        <ul className="divide-y divide-border rounded-lg border border-border overflow-hidden">
          {defs.map((def) => (
            <li key={def.id} className="px-4 py-3 flex items-start justify-between gap-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium truncate">{def.name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {CAPABILITY_LABELS_DESKTOP[def.capabilityKey] ?? def.capabilityKey}
                </p>
                {def.description && (
                  <p className="text-xs text-muted-foreground/70 mt-0.5 truncate">{def.description}</p>
                )}
              </div>
              {isCallerOwner && (
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => openEditDef(def)}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    title="Edit"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`Delete "${def.name}" and remove all grants?`)) {
                        deleteDefMutation.mutate(def.id);
                      }
                    }}
                    disabled={deleteDefMutation.isPending}
                    className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                    title="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* Create / Edit Definition Form */}
      {showDefForm && (
        <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
          <h4 className="text-sm font-semibold">{editingDef ? "Edit permission" : "New permission"}</h4>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">
                Name *
              </label>
              <input
                className="h-8 w-full px-2 rounded border border-border bg-background text-sm"
                value={defName}
                onChange={(e) => setDefName(e.target.value)}
                placeholder="e.g. Finance Viewer"
                autoFocus
              />
            </div>
            <div className="col-span-2">
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">
                Description
              </label>
              <input
                className="h-8 w-full px-2 rounded border border-border bg-background text-sm"
                value={defDesc}
                onChange={(e) => setDefDesc(e.target.value)}
                placeholder="Optional description"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">
                Capability
              </label>
              <select
                value={defCapKey}
                onChange={(e) => setDefCapKey(e.target.value)}
                className="h-8 w-full px-2 rounded border border-border bg-background text-sm"
              >
                {CAPABILITY_KEYS_DESKTOP.map((k) => (
                  <option key={k} value={k}>{CAPABILITY_LABELS_DESKTOP[k]}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={closeDefForm}
              className="h-8 px-3 rounded border border-border bg-background text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveDefForm}
              disabled={!defName.trim() || createDefMutation.isPending || updateDefMutation.isPending}
              className="h-8 px-3 rounded bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
            >
              {createDefMutation.isPending || updateDefMutation.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}

      {/* Member Permissions */}
      {defs.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-3">Member Permissions</h3>
          <p className="text-xs text-muted-foreground mb-3">
            Click a member to assign or revoke custom permissions.
          </p>

          {teamQuery.isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
          {members.length === 0 && !teamQuery.isLoading && (
            <p className="text-sm text-muted-foreground italic">No team members found.</p>
          )}

          <ul className="divide-y divide-border rounded-lg border border-border overflow-hidden">
            {members.map((m) => {
              const name = [m.firstName, m.lastName].filter(Boolean).join(" ") || m.username;
              return (
                <li key={m.id} className="px-4 py-2.5 flex items-center justify-between text-sm">
                  <div>
                    <p className="font-medium">{name}</p>
                    <p className="text-xs text-muted-foreground capitalize">{(m.role ?? "user").replace("_", " ")}</p>
                  </div>
                  {isCallerOwner && (
                    <button
                      type="button"
                      onClick={() => void openMemberPerms(m.membershipId!, name)}
                      className="text-xs text-primary hover:underline"
                    >
                      Manage permissions →
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Member permissions sheet */}
      <Sheet open={!!memberPermsTarget} onOpenChange={(open) => { if (!open) setMemberPermsTarget(null); }}>
        <SheetContent side="right" className="w-[360px]">
          <SheetHeader>
            <SheetTitle className="text-base">Permissions for {memberPermsTarget?.name}</SheetTitle>
            <SheetDescription className="text-xs">
              Owners and admins always have full access. These extra permissions apply to non-admin members only.
            </SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-2">
            {defs.map((def) => {
              const granted = memberGrantIds.includes(def.id);
              return (
                <label
                  key={def.id}
                  className="flex items-start gap-3 rounded-md border border-border px-3 py-2.5 cursor-pointer hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    checked={granted}
                    onChange={(e) =>
                      setMemberGrantIds((prev) =>
                        e.target.checked ? [...prev, def.id] : prev.filter((id) => id !== def.id)
                      )
                    }
                    className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
                  />
                  <div>
                    <p className="text-sm font-medium">{def.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {CAPABILITY_LABELS_DESKTOP[def.capabilityKey] ?? def.capabilityKey}
                    </p>
                  </div>
                </label>
              );
            })}
          </div>
          <div className="mt-6 flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setMemberPermsTarget(null)}
              className="h-8 px-3 rounded border border-border bg-background text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void saveMemberPerms()}
              disabled={savingMemberPerms}
              className="h-8 px-3 rounded bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
            >
              {savingMemberPerms ? "Saving…" : "Save"}
            </button>
          </div>
        </SheetContent>
      </Sheet>
    </PanelShell>
  );
}

export function PanelShell({ title, subtitle, children, actions }: { title: string; subtitle?: React.ReactNode; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

interface RememberedDoctorPracticeMapping {
  id: string;
  doctorName: string;
  providerOrganizationId: string;
  practiceName: string;
  practiceAvailable: boolean;
  updatedAt: string;
}
function Field({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return (
    <div className={full ? "col-span-2" : ""}>
      <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}

// ─────────────────────────── Employee Hours Panel ────────────────────────────

interface VacationRequestDay {
  id: string;
  date: string;
  isAllDay: boolean;
  startTime?: string | null;
  endTime?: string | null;
}

interface VacationRequest {
  id: string;
  userId: string;
  totalRequestedHours: string;
  reason?: string | null;
  status: "pending" | "approved" | "denied" | "cancelled";
  adminDecisionNote?: string | null;
  createdAt: string;
  days: VacationRequestDay[];
  employeeName?: string | null;
}

interface VacationBalance {
  id?: string | null;
  labId: string;
  userId: string;
  year: number;
  annualVacationHours: string;
  usedVacationHours: string;
  pendingVacationHours: string;
  membershipRole?: string | null;
  employeeName?: string | null;
  employeeInitials?: string | null;
}

function fmtVacHours(h: string | number): string {
  const n = Number(h);
  return Number.isNaN(n) ? "—" : `${n.toFixed(1)} h`;
}

function formatVacDate(d: string): string {
  try {
    const dt = new Date(d + "T00:00:00");
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    const yyyy = dt.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
  } catch {
    return d;
  }
}

const VAC_STATUS_COLOR: Record<string, string> = {
  pending: "text-amber-600 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800",
  approved: "text-green-700 bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800",
  denied: "text-destructive bg-destructive/10 border-destructive/30",
  cancelled: "text-muted-foreground bg-muted border-border",
};

type VacTab = "requests" | "balances";

function EmployeeHoursPanel() {
  const qc = useQueryClient();

  const meQuery = useQuery<MeResponse>({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch("/auth/me"),
    staleTime: 60_000,
  });

  const adminLabs = useMemo(() => {
    return (meQuery.data?.memberships ?? []).filter(
      (m) =>
        m.organization?.type === "lab" &&
        (m.role === "owner" || m.role === "admin")
    );
  }, [meQuery.data]);

  const [selectedLabId, setSelectedLabId] = useState<string | null>(null);
  const labId = selectedLabId ?? adminLabs[0]?.organizationId ?? null;

  const [vacTab, setVacTab] = useState<VacTab>("requests");
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [denyNotes, setDenyNotes] = useState<Record<string, string>>({});
  const [showDenyFor, setShowDenyFor] = useState<string | null>(null);
  const [editingBalanceId, setEditingBalanceId] = useState<string | null>(null);
  const [balanceInputs, setBalanceInputs] = useState<Record<string, string>>({});

  const requestsQuery = useQuery<VacationRequest[]>({
    enabled: !!labId && vacTab === "requests",
    queryKey: ["vacation-requests-admin", labId, statusFilter],
    queryFn: () =>
      apiFetch<VacationRequest[]>(
        `/vacation/requests?organizationId=${encodeURIComponent(labId!)}&status=${statusFilter}`
      ),
    staleTime: 30_000,
  });

  const balancesQuery = useQuery<VacationBalance[]>({
    enabled: !!labId && vacTab === "balances",
    queryKey: ["vacation-balances-admin", labId],
    queryFn: () =>
      apiFetch<VacationBalance[]>(`/vacation/balances?organizationId=${encodeURIComponent(labId!)}`),
    staleTime: 30_000,
  });

  const approveMutation = useMutation({
    mutationFn: (requestId: string) =>
      apiFetch(`/vacation/requests/${requestId}/approve`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["vacation-requests-admin", labId] });
      toast({ title: "Request approved." });
    },
    onError: (err: Error) => {
      toast({ title: "Could not approve", description: err.message, variant: "destructive" });
    },
  });

  const denyMutation = useMutation({
    mutationFn: ({ requestId, note }: { requestId: string; note: string }) =>
      apiFetch(`/vacation/requests/${requestId}/deny`, {
        method: "POST",
        body: JSON.stringify({ adminDecisionNote: note || null }),
        headers: { "Content-Type": "application/json" },
      }),
    onSuccess: (_data, vars) => {
      setShowDenyFor(null);
      setDenyNotes((p) => ({ ...p, [vars.requestId]: "" }));
      void qc.invalidateQueries({ queryKey: ["vacation-requests-admin", labId] });
      toast({ title: "Request denied." });
    },
    onError: (err: Error) => {
      toast({ title: "Could not deny", description: err.message, variant: "destructive" });
    },
  });

  const updateBalanceMutation = useMutation({
    mutationFn: ({ userId, hours }: { userId: string; hours: number }) =>
      apiFetch(
        `/vacation/balances/${userId}?organizationId=${encodeURIComponent(labId!)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ annualVacationHours: hours }),
          headers: { "Content-Type": "application/json" },
        }
      ),
    onSuccess: (_data, vars) => {
      setEditingBalanceId(null);
      setBalanceInputs((p) => ({ ...p, [vars.userId]: "" }));
      void qc.invalidateQueries({ queryKey: ["vacation-balances-admin", labId] });
      toast({ title: "Balance updated." });
    },
    onError: (err: Error) => {
      toast({ title: "Could not update balance", description: err.message, variant: "destructive" });
    },
  });

  const requests = requestsQuery.data ?? [];
  const balances = balancesQuery.data ?? [];

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h2 className="text-base font-semibold">Employee Hours</h2>
        <p className="text-sm text-muted-foreground">
          Manage vacation requests and annual hour allocations for lab members.
        </p>
      </div>

      {/* Lab selector */}
      {adminLabs.length > 1 && (
        <select
          className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-border"
          value={labId ?? ""}
          onChange={(e) => setSelectedLabId(e.target.value)}
        >
          {adminLabs.map((m) => (
            <option key={m.organizationId} value={m.organizationId}>
              {m.organization?.name ?? m.organizationId}
            </option>
          ))}
        </select>
      )}

      {/* Tab bar */}
      <div className="flex border-b border-border">
        {(["requests", "balances"] as VacTab[]).map((t) => (
          <button
            key={t}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              vacTab === t
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setVacTab(t)}
          >
            {t === "requests" ? "Requests" : "Balances"}
          </button>
        ))}
      </div>

      {/* ── Requests tab ── */}
      {vacTab === "requests" && (
        <div className="space-y-3">
          {/* Status filter */}
          <div className="flex gap-2">
            {["pending", "approved", "denied", "all"].map((s) => (
              <button
                key={s}
                className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                  statusFilter === s
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:bg-secondary"
                }`}
                onClick={() => setStatusFilter(s)}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>

          {requestsQuery.isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          )}

          {!requestsQuery.isLoading && requests.length === 0 && (
            <p className="text-sm text-muted-foreground">No {statusFilter} requests.</p>
          )}

          {requests.map((req) => (
            <div key={req.id} className="rounded-lg border border-border bg-card overflow-hidden">
              <div className="px-4 py-3 flex items-start gap-3">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                  <span className="text-xs font-bold text-primary">
                    {(req.employeeName ?? "?").slice(0, 2).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{req.employeeName ?? "Employee"}</span>
                    <span
                      className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${VAC_STATUS_COLOR[req.status] ?? VAC_STATUS_COLOR.cancelled}`}
                    >
                      {req.status.toUpperCase()}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {fmtVacHours(req.totalRequestedHours)} · {req.days.length} day{req.days.length !== 1 ? "s" : ""}
                  </p>
                  {req.days.slice(0, 3).map((d) => (
                    <p key={d.id} className="text-xs text-muted-foreground">
                      {formatVacDate(d.date)}{d.isAllDay ? " (all day)" : ` ${d.startTime}–${d.endTime}`}
                    </p>
                  ))}
                  {req.days.length > 3 && (
                    <p className="text-xs text-muted-foreground">+{req.days.length - 3} more days</p>
                  )}
                  {req.reason && <p className="text-xs text-muted-foreground mt-0.5">{req.reason}</p>}
                  {req.adminDecisionNote && (
                    <p className="text-xs text-muted-foreground mt-0.5">Note: {req.adminDecisionNote}</p>
                  )}
                </div>
              </div>

              {req.status === "pending" && (
                <div className="px-4 py-3 border-t border-border bg-muted/30 flex flex-col gap-2">
                  {showDenyFor === req.id ? (
                    <>
                      <input
                        className="h-8 px-2 rounded border border-border bg-background text-sm w-full"
                        placeholder="Optional note to employee…"
                        value={denyNotes[req.id] ?? ""}
                        onChange={(e) =>
                          setDenyNotes((p) => ({ ...p, [req.id]: e.target.value }))
                        }
                      />
                      <div className="flex gap-2">
                        <button
                          className="flex-1 h-8 rounded border border-border bg-background text-sm"
                          onClick={() => setShowDenyFor(null)}
                        >
                          Cancel
                        </button>
                        <button
                          className="flex-1 h-8 rounded bg-destructive text-destructive-foreground text-sm font-medium"
                          onClick={() =>
                            denyMutation.mutate({
                              requestId: req.id,
                              note: denyNotes[req.id] ?? "",
                            })
                          }
                          disabled={denyMutation.isPending}
                        >
                          Confirm deny
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        className="flex-1 h-8 rounded border border-border text-sm hover:bg-secondary"
                        onClick={() => setShowDenyFor(req.id)}
                      >
                        Deny
                      </button>
                      <button
                        className="flex-1 h-8 rounded bg-primary text-primary-foreground text-sm font-medium"
                        onClick={() => approveMutation.mutate(req.id)}
                        disabled={approveMutation.isPending}
                      >
                        Approve
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Balances tab ── */}
      {vacTab === "balances" && (
        <div className="space-y-3">
          {balancesQuery.isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          )}

          {!balancesQuery.isLoading && balances.length === 0 && (
            <p className="text-sm text-muted-foreground">No team members found.</p>
          )}

          {balances.map((b) => {
            const remaining = Math.max(
              0,
              Number(b.annualVacationHours) -
                Number(b.usedVacationHours) -
                Number(b.pendingVacationHours)
            );
            return (
              <div key={b.userId} className="rounded-lg border border-border bg-card overflow-hidden">
                <div className="px-4 py-3 flex items-center gap-3">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                    <span className="text-xs font-bold text-primary">
                      {(b.employeeInitials ?? b.employeeName ?? "?").slice(0, 2).toUpperCase()}
                    </span>
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-sm">{b.employeeName ?? b.userId}</p>
                    <p className="text-xs text-muted-foreground">{b.membershipRole ?? "member"} · {b.year}</p>
                  </div>
                  <div className="flex gap-3 text-right">
                    {[
                      { label: "Annual", val: b.annualVacationHours },
                      { label: "Used", val: b.usedVacationHours },
                      { label: "Pending", val: b.pendingVacationHours },
                      { label: "Left", val: remaining, color: "text-primary" },
                    ].map(({ label, val, color }) => (
                      <div key={label} className="text-center">
                        <p className="text-[10px] text-muted-foreground">{label}</p>
                        <p className={`text-sm font-semibold ${color ?? ""}`}>{fmtVacHours(val)}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="px-4 py-3 border-t border-border bg-muted/30">
                  {editingBalanceId === b.userId ? (
                    <div className="flex gap-2">
                      <input
                        className="h-8 flex-1 px-2 rounded border border-border bg-background text-sm"
                        type="number"
                        min={0}
                        max={10000}
                        step={0.5}
                        placeholder="Annual hours (e.g. 80)"
                        value={balanceInputs[b.userId] ?? ""}
                        onChange={(e) =>
                          setBalanceInputs((p) => ({ ...p, [b.userId]: e.target.value }))
                        }
                      />
                      <button
                        className="h-8 px-3 rounded bg-primary text-primary-foreground text-sm font-medium"
                        onClick={() => {
                          const hours = Number(balanceInputs[b.userId] ?? "");
                          if (Number.isNaN(hours) || hours < 0) {
                            toast({ title: "Enter a valid number of hours.", variant: "destructive" });
                            return;
                          }
                          updateBalanceMutation.mutate({ userId: b.userId, hours });
                        }}
                        disabled={updateBalanceMutation.isPending}
                      >
                        Save
                      </button>
                      <button
                        className="h-8 px-3 rounded border border-border bg-background text-sm"
                        onClick={() => setEditingBalanceId(null)}
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      className="text-sm text-primary hover:underline flex items-center gap-1"
                      onClick={() => {
                        setBalanceInputs((p) => ({ ...p, [b.userId]: b.annualVacationHours }));
                        setEditingBalanceId(b.userId);
                      }}
                    >
                      <Pencil size={12} /> Edit annual hours
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Lab Preferences Panel ────────────────────────────────────────────────────
// Reusable quick reference note templates for the Add Note composer.
// Available to all lab roles (owner / admin / user).
interface QRNote {
  id: string;
  organizationId: string;
  body: string;
  label: string | null;
  isActive: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

function LabPreferencesPanel() {
  const { user } = useAuth();
  const orgId = user?.practiceOrganizationId;
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["quick-reference-notes", orgId] });

  // ── Org settings (default turnaround days) ──────────────────────────────
  const orgQuery = useQuery<{
    defaultCaseDueDays?: number | null;
    printProviderPreferencesOnLabSlips?: boolean | null;
  }>({
    queryKey: ["lab-org-settings", orgId],
    enabled: !!orgId,
    queryFn: () => apiFetch(`/organizations/${orgId}`),
  });
  const [dueDays, setDueDays] = useState("");
  const [dueDaysSaved, setDueDaysSaved] = useState(false);
  const [printProviderPreferences, setPrintProviderPreferences] = useState(false);
  useEffect(() => {
    if (orgQuery.data) {
      setDueDays(orgQuery.data.defaultCaseDueDays != null ? String(orgQuery.data.defaultCaseDueDays) : "");
    }
  }, [orgQuery.data?.defaultCaseDueDays]);
  useEffect(() => {
    if (orgQuery.data) {
      setPrintProviderPreferences(
        orgQuery.data.printProviderPreferencesOnLabSlips === true,
      );
    }
  }, [orgQuery.data?.printProviderPreferencesOnLabSlips]);

  const dueDaysMutation = useMutation({
    mutationFn: (days: number | null) =>
      apiFetch(`/organizations/${orgId}`, {
        method: "PATCH",
        body: JSON.stringify({ defaultCaseDueDays: days }),
      }),
    onSuccess: () => {
      setDueDaysSaved(true);
      void qc.invalidateQueries({ queryKey: ["lab-org-settings", orgId] });
      setTimeout(() => setDueDaysSaved(false), 2000);
    },
    onError: () => toast({ title: "Could not save turnaround days", variant: "destructive" }),
  });

  const printProviderPreferencesMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      apiFetch(`/organizations/${orgId}`, {
        method: "PATCH",
        body: JSON.stringify({ printProviderPreferencesOnLabSlips: enabled }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["lab-org-settings", orgId] });
    },
    onError: (err: Error) => {
      setPrintProviderPreferences(
        orgQuery.data?.printProviderPreferencesOnLabSlips === true,
      );
      toast({
        title: "Could not save lab-slip preferences",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const handleSaveDueDays = () => {
    const val = dueDays.trim();
    const num = val === "" ? null : parseInt(val, 10);
    if (num !== null && (isNaN(num) || num < 1 || num > 365)) {
      toast({ title: "Invalid value", description: "Enter a number between 1 and 365.", variant: "destructive" });
      return;
    }
    dueDaysMutation.mutate(num);
  };

  // ── Quick Reference Notes ───────────────────────────────────────────────
  const qrnQuery = useQuery<QRNote[]>({
    queryKey: ["quick-reference-notes", orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const r = await apiFetch<{ notes: QRNote[] }>(`/organizations/${orgId}/quick-reference-notes`);
      return r?.notes ?? [];
    },
  });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [editLabel, setEditLabel] = useState("");
  const [newBody, setNewBody] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [addingNew, setAddingNew] = useState(false);
  const [seedLoading, setSeedLoading] = useState(false);

  const handleSeed = async () => {
    if (!orgId) return;
    setSeedLoading(true);
    try {
      const r = await apiFetch<{ seeded: boolean; message?: string }>(`/organizations/${orgId}/quick-reference-notes/seed-defaults`, { method: "POST" });
      if (!r?.seeded) {
        toast({ title: "Templates already exist", description: "Your lab already has note templates.", variant: "default" });
      } else {
        toast({ title: "Default templates loaded" });
        invalidate();
      }
    } catch (err) {
      toast({ title: "Error seeding templates", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally { setSeedLoading(false); }
  };

  const handleCreate = async () => {
    if (!orgId || !newBody.trim()) return;
    const notes = qrnQuery.data ?? [];
    try {
      await apiFetch<QRNote>(`/organizations/${orgId}/quick-reference-notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: newBody.trim(), label: newLabel.trim() || null, displayOrder: notes.length }),
      });
      setNewBody(""); setNewLabel(""); setAddingNew(false); invalidate();
    } catch (err) {
      toast({ title: "Error creating template", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  };

  const handleUpdate = async (id: string) => {
    if (!orgId || !editBody.trim()) return;
    try {
      await apiFetch<QRNote>(`/organizations/${orgId}/quick-reference-notes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: editBody.trim(), label: editLabel.trim() || null }),
      });
      setEditingId(null); invalidate();
    } catch (err) {
      toast({ title: "Error saving template", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  };

  const handleToggle = async (note: QRNote) => {
    if (!orgId) return;
    try {
      await apiFetch<QRNote>(`/organizations/${orgId}/quick-reference-notes/${note.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !note.isActive }),
      });
      invalidate();
    } catch (err) {
      toast({ title: "Error updating template", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  };

  const handleDelete = async (id: string) => {
    if (!orgId) return;
    try {
      await apiFetch<null>(`/organizations/${orgId}/quick-reference-notes/${id}`, { method: "DELETE" });
      invalidate();
    } catch (err) {
      toast({ title: "Error deleting template", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  };

  const handleReorder = async (note: QRNote, direction: "up" | "down") => {
    if (!orgId) return;
    const sorted = [...(qrnQuery.data ?? [])].sort((a, b) => a.displayOrder - b.displayOrder);
    const idx = sorted.findIndex((n) => n.id === note.id);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const other = sorted[swapIdx];
    const o1 = other.displayOrder === note.displayOrder
      ? note.displayOrder + (direction === "up" ? -1 : 1)
      : other.displayOrder;
    try {
      await Promise.all([
        apiFetch<QRNote>(`/organizations/${orgId}/quick-reference-notes/${note.id}/order`, {
          method: "PATCH", body: JSON.stringify({ displayOrder: o1 }),
        }),
        apiFetch<QRNote>(`/organizations/${orgId}/quick-reference-notes/${other.id}/order`, {
          method: "PATCH", body: JSON.stringify({ displayOrder: note.displayOrder }),
        }),
      ]);
      invalidate();
    } catch (err) {
      toast({ title: "Could not reorder templates", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  };

  const notes = qrnQuery.data ?? [];
  const activeNotes = [...notes].filter((n) => n.isActive).sort((a, b) => a.displayOrder - b.displayOrder);
  const inactiveNotes = notes.filter((n) => !n.isActive);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Lab Preferences</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Lab-wide defaults for case workflow and the note template library.
        </p>
      </div>

      {/* Default turnaround days */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div>
          <h3 className="text-sm font-medium">Default case turnaround (days)</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            New cases will default to this many days from the created date. Leave blank to let staff set the due date manually.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={365}
            className="w-24 border border-border rounded px-3 py-1.5 text-sm bg-background"
            placeholder="—"
            value={dueDays}
            onChange={(e) => setDueDays(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSaveDueDays()}
          />
          <button
            className="h-8 px-3 rounded bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
            onClick={handleSaveDueDays}
            disabled={dueDaysMutation.isPending}
          >
            {dueDaysMutation.isPending ? "Saving…" : dueDaysSaved ? "✓ Saved" : "Save"}
          </button>
          {dueDays && (
            <button
              className="h-8 px-3 rounded border border-border bg-background text-sm text-muted-foreground hover:bg-accent"
              onClick={() => { setDueDays(""); dueDaysMutation.mutate(null); }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={printProviderPreferences}
            disabled={printProviderPreferencesMutation.isPending || orgQuery.isLoading}
            onChange={(event) => {
              const enabled = event.target.checked;
              setPrintProviderPreferences(enabled);
              printProviderPreferencesMutation.mutate(enabled);
            }}
          />
          <span>
            <span className="text-sm font-medium">Print provider preferences on lab slips</span>
            <span className="block text-xs text-muted-foreground mt-0.5">
              Include the provider&apos;s structured clinical preferences on desktop lab slips and compact labels.
            </span>
          </span>
        </label>
      </div>

      {/* Quick Reference Notes */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-medium">Quick Reference Notes</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Staff can insert these templates into the Add Note field while working on a case.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!qrnQuery.isError && notes.length === 0 && (
              <button
                className="text-sm px-3 py-1.5 rounded border border-border bg-background hover:bg-accent transition-colors"
                onClick={handleSeed}
                disabled={seedLoading}
              >
                {seedLoading ? "Loading…" : "Load default templates"}
              </button>
            )}
            <button
              className="text-sm px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              onClick={() => setAddingNew(true)}
            >
              + New template
            </button>
          </div>
        </div>

        {qrnQuery.isLoading && <div className="text-sm text-muted-foreground py-4">Loading templates…</div>}

        {qrnQuery.isError && (
          <div className="flex items-center justify-between gap-3 py-2">
            <Alert tone="danger">
              {qrnQuery.error instanceof Error ? qrnQuery.error.message : "Couldn't load your note templates."}
            </Alert>
            <button
              className="text-sm px-3 py-1.5 rounded border border-border bg-background hover:bg-accent transition-colors shrink-0"
              onClick={() => qrnQuery.refetch()}
            >
              Retry
            </button>
          </div>
        )}

        {!qrnQuery.isLoading && !qrnQuery.isError && notes.length === 0 && (
          <div className="text-sm text-muted-foreground py-8 text-center border border-dashed border-border rounded-lg">
            No templates yet. Add one above or load the default set.
          </div>
        )}

        {addingNew && (
          <div className="rounded-lg border border-primary/40 bg-card p-4 space-y-3">
            <div className="text-sm font-medium">New template</div>
            <input
              className="w-full border border-border rounded px-3 py-1.5 text-sm bg-background"
              placeholder="Short label (optional)"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
            />
            <textarea
              className="w-full border border-border rounded px-3 py-1.5 text-sm bg-background min-h-[60px]"
              placeholder="Template body (required)"
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                className="h-8 px-3 rounded bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
                onClick={handleCreate}
                disabled={!newBody.trim()}
              >
                Save
              </button>
              <button
                className="h-8 px-3 rounded border border-border bg-background text-sm"
                onClick={() => { setAddingNew(false); setNewBody(""); setNewLabel(""); }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {activeNotes.map((note, idx) => (
            <div key={note.id} className="rounded-lg border border-border bg-card p-3 space-y-1">
              {editingId === note.id ? (
                <div className="space-y-2">
                  <input
                    className="w-full border border-border rounded px-3 py-1.5 text-sm bg-background"
                    placeholder="Short label (optional)"
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                  />
                  <textarea
                    className="w-full border border-border rounded px-3 py-1.5 text-sm bg-background min-h-[60px]"
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <button
                      className="h-7 px-3 rounded bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
                      onClick={() => handleUpdate(note.id)}
                      disabled={!editBody.trim()}
                    >
                      Save
                    </button>
                    <button
                      className="h-7 px-3 rounded border border-border bg-background text-sm"
                      onClick={() => setEditingId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    {note.label && <div className="text-xs font-medium text-primary">{note.label}</div>}
                    <div className="text-sm text-foreground">{note.body}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      className="h-7 px-1.5 rounded border border-border bg-background text-xs hover:bg-accent disabled:opacity-30"
                      onClick={() => handleReorder(note, "up")}
                      disabled={idx === 0}
                      title="Move up"
                    >▲</button>
                    <button
                      className="h-7 px-1.5 rounded border border-border bg-background text-xs hover:bg-accent disabled:opacity-30"
                      onClick={() => handleReorder(note, "down")}
                      disabled={idx === activeNotes.length - 1}
                      title="Move down"
                    >▼</button>
                    <button
                      className="h-7 px-2 rounded border border-border bg-background text-xs hover:bg-accent"
                      onClick={() => { setEditingId(note.id); setEditBody(note.body); setEditLabel(note.label ?? ""); }}
                    >
                      Edit
                    </button>
                    <button
                      className="h-7 px-2 rounded border border-border bg-background text-xs hover:bg-accent"
                      onClick={() => handleToggle(note)}
                      title="Deactivate"
                    >
                      Hide
                    </button>
                    <button
                      className="h-7 px-2 rounded border border-destructive/30 text-destructive text-xs hover:bg-destructive/10"
                      onClick={() => handleDelete(note.id)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        {inactiveNotes.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none py-1">
              {inactiveNotes.length} hidden template{inactiveNotes.length > 1 ? "s" : ""}
            </summary>
            <div className="mt-2 space-y-2">
              {inactiveNotes.map((note) => (
                <div key={note.id} className="rounded-lg border border-border bg-card/50 p-3 flex items-start justify-between gap-2 opacity-60">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    {note.label && <div className="text-xs font-medium text-primary">{note.label}</div>}
                    <div className="text-sm text-foreground">{note.body}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      className="h-7 px-2 rounded border border-border bg-background text-xs hover:bg-accent"
                      onClick={() => handleToggle(note)}
                    >
                      Restore
                    </button>
                    <button
                      className="h-7 px-2 rounded border border-destructive/30 text-destructive text-xs hover:bg-destructive/10"
                      onClick={() => handleDelete(note.id)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function Alert({ tone, children }: { tone: "danger" | "success" | "warning"; children: React.ReactNode }) {
  const cls =
    tone === "danger"
      ? "bg-destructive/10 text-destructive"
      : tone === "warning"
        ? "bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-800/40"
        : "bg-success/15 text-success";
  return <div className={`text-sm rounded-md px-3 py-2 ${cls}`}>{children}</div>;
}

interface CatalogCaseTypeNode {
  key: CatalogCaseType;
  label: string;
  subtypes: CatalogSubtypeNode[];
}

interface CatalogMaterialNode {
  id: string | null;
  key: string;
  label: string;
  isCustom: boolean;
  isActive: boolean;
  sortOrder: number;
  priceKey?: string | null;
}

interface CatalogSubtypeNode extends CatalogMaterialNode {
  materials: CatalogMaterialNode[];
}

function catalogTreeNodes(value: unknown): CatalogCaseTypeNode[] {
  if (!value || typeof value !== "object") return [];
  const nodes = (value as { caseTypes?: unknown }).caseTypes;
  if (!Array.isArray(nodes)) return [];
  return nodes.filter((node): node is CatalogCaseTypeNode => {
    if (!node || typeof node !== "object") return false;
    const item = node as Partial<CatalogCaseTypeNode>;
    return typeof item.key === "string" && typeof item.label === "string" && Array.isArray(item.subtypes);
  });
}

interface LegacyVocabularyReviewCandidate {
  id: string;
  value: string;
  matchedTerm: string;
  reason: string;
}

function LegacyVocabularyReviewSection({ labOrganizationId }: { labOrganizationId: string }) {
  const qc = useQueryClient();
  const reviewQuery = useQuery<LegacyVocabularyReviewCandidate[]>({
    queryKey: ["catalog", "legacy-vocabulary-review", labOrganizationId],
    queryFn: () => apiFetch<LegacyVocabularyReviewCandidate[]>(`/catalog/legacy-vocabulary-review?labOrganizationId=${encodeURIComponent(labOrganizationId)}`),
    staleTime: 30_000,
  });
  const treeQuery = useQuery<EffectiveCatalogTree>({
    queryKey: ["catalog", "tree", labOrganizationId],
    queryFn: () => apiFetch<EffectiveCatalogTree>(`/catalog/tree?labOrganizationId=${encodeURIComponent(labOrganizationId)}`),
    staleTime: 30_000,
  });
  const caseTypes = catalogTreeNodes(treeQuery.data);
  const [mappingId, setMappingId] = useState<string | null>(null);
  const [entryType, setEntryType] = useState<CatalogEntryType>("material");
  const [caseType, setCaseType] = useState<CatalogCaseType>("restorative");
  const [parentKey, setParentKey] = useState("");
  const [label, setLabel] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ candidate: LegacyVocabularyReviewCandidate; blocked: boolean; usageCount?: number } | null>(null);

  const selectedCase = caseTypes.find((item) => item.key === caseType) ?? caseTypes[0];
  const subtypeOptions = selectedCase?.subtypes ?? [];
  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ["catalog", "tree", labOrganizationId] });
    await qc.invalidateQueries({ queryKey: ["catalog", "legacy-vocabulary-review", labOrganizationId] });
  };

  const openMapping = (candidate: LegacyVocabularyReviewCandidate) => {
    const firstCase = caseTypes[0];
    setMappingId(candidate.id);
    setLabel(candidate.value);
    setEntryType("material");
    setCaseType(firstCase?.key ?? "restorative");
    setParentKey(firstCase?.subtypes[0]?.key ?? "");
    setError(null);
  };

  const markInactive = async (force: boolean) => {
    if (!pendingDelete) return;
    const state = pendingDelete;
    setBusyId(state.candidate.id);
    setError(null);
    try {
      await apiFetch(`/vocabulary/${encodeURIComponent(state.candidate.id)}${force ? "?force=true" : ""}`, { method: "DELETE" });
      setPendingDelete(null);
      setMappingId(null);
      await invalidate();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as { usageCount?: number } | null;
        setPendingDelete({ ...state, blocked: true, usageCount: typeof body?.usageCount === "number" ? body.usageCount : 1 });
      } else {
        setError(err instanceof Error ? err.message : "Could not mark this term inactive.");
      }
    } finally {
      setBusyId(null);
    }
  };

  const mapCandidate = async (candidate: LegacyVocabularyReviewCandidate) => {
    const trimmed = label.trim();
    if (!trimmed || (entryType === "material" && !parentKey)) {
      setError(entryType === "material" ? "Choose a subtype and enter a label." : "Enter a label.");
      return;
    }
    setBusyId(candidate.id);
    setError(null);
    try {
      await apiFetch("/catalog/entries", {
        method: "POST",
        body: JSON.stringify({ labOrganizationId, entryType, caseType, label: trimmed, ...(entryType === "material" ? { parentKey } : {}) }),
      });
      try {
        await apiFetch(`/vocabulary/${encodeURIComponent(candidate.id)}`, { method: "DELETE" });
        setMappingId(null);
      } catch (err: unknown) {
        if (err instanceof ApiError && err.status === 409) {
          const body = err.body as { usageCount?: number } | null;
          setPendingDelete({ candidate, blocked: true, usageCount: typeof body?.usageCount === "number" ? body.usageCount : 1 });
        } else {
          setError("Added to the catalog, but the old vocabulary term is still present.");
        }
      }
      await invalidate();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not map this vocabulary term.");
    } finally {
      setBusyId(null);
    }
  };

  if (reviewQuery.isLoading) {
    return <section className="space-y-2"><h3 className="text-sm font-semibold">Needs review</h3><div className="flex items-center gap-2 text-muted-foreground text-sm py-3"><Loader2 size={14} className="animate-spin" /> Checking legacy vocabulary…</div></section>;
  }
  if (reviewQuery.isError) {
    return <section className="space-y-2"><h3 className="text-sm font-semibold">Needs review</h3><p className="text-sm text-destructive">Failed to load legacy vocabulary review.</p></section>;
  }
  const candidates = Array.isArray(reviewQuery.data) ? reviewQuery.data : [];
  return (
    <section className="space-y-3" data-testid="catalog-legacy-review">
      <div>
        <h3 className="text-sm font-semibold">Needs review</h3>
        <p className="text-xs text-muted-foreground mt-0.5">These older terms may be mis-filed catalog entries. Review them one at a time; nothing changes automatically.</p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {candidates.length === 0 && <p className="text-sm text-muted-foreground rounded-md border border-border px-3 py-4">Nothing needs review.</p>}
      <div className="space-y-2">
        {candidates.map((candidate) => {
          const isMapping = mappingId === candidate.id;
          return (
            <div key={candidate.id} className="border border-border rounded-md px-3 py-2.5">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0"><p className="text-sm font-medium">{candidate.value}</p><p className="text-xs text-muted-foreground mt-0.5">{candidate.reason}</p></div>
                <button type="button" onClick={() => openMapping(candidate)} disabled={!!busyId} className="h-7 px-2 rounded bg-primary text-primary-foreground text-xs font-medium disabled:opacity-60">Map to catalog</button>
                <button type="button" onClick={() => setPendingDelete({ candidate, blocked: false })} disabled={!!busyId} className="h-7 px-2 rounded bg-secondary text-xs font-medium disabled:opacity-60">Mark inactive</button>
              </div>
              {isMapping && (
                <div className="mt-3 pt-3 border-t border-border grid gap-2 sm:grid-cols-2">
                  <label className="text-xs text-muted-foreground">Case type
                    <select value={caseType} onChange={(event) => { const next = event.target.value as CatalogCaseType; setCaseType(next); setParentKey(caseTypes.find((item) => item.key === next)?.subtypes[0]?.key ?? ""); }} className="mt-1 block w-full h-8 px-2 rounded bg-background border border-border text-sm text-foreground">
                      <option value="restorative">Restorative</option><option value="removable">Removable</option><option value="ortho">Ortho</option>
                    </select>
                  </label>
                  <label className="text-xs text-muted-foreground">Catalog entry
                    <select value={entryType} onChange={(event) => setEntryType(event.target.value as CatalogEntryType)} className="mt-1 block w-full h-8 px-2 rounded bg-background border border-border text-sm text-foreground"><option value="material">Material</option><option value="subtype">Subtype</option></select>
                  </label>
                  {entryType === "material" && <label className="text-xs text-muted-foreground">Parent subtype
                    <select value={parentKey} onChange={(event) => setParentKey(event.target.value)} className="mt-1 block w-full h-8 px-2 rounded bg-background border border-border text-sm text-foreground"><option value="">Choose a subtype</option>{subtypeOptions.map((subtype) => <option key={subtype.key} value={subtype.key}>{subtype.label}</option>)}</select>
                  </label>}
                  <label className="text-xs text-muted-foreground">Label<input value={label} onChange={(event) => setLabel(event.target.value)} className="mt-1 block w-full h-8 px-2 rounded bg-background border border-border text-sm text-foreground" /></label>
                  <div className="flex items-end gap-2"><button type="button" onClick={() => void mapCandidate(candidate)} disabled={busyId === candidate.id} className="h-8 px-3 rounded bg-primary text-primary-foreground text-xs font-medium disabled:opacity-60">{busyId === candidate.id ? "Saving…" : "Save mapping"}</button><button type="button" onClick={() => setMappingId(null)} disabled={!!busyId} className="h-8 px-3 rounded bg-secondary text-xs">Cancel</button></div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => { if (!open && !busyId) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingDelete?.blocked ? `Mark "${pendingDelete.candidate.value}" inactive anyway?` : `Mark "${pendingDelete?.candidate.value}" inactive?`}</AlertDialogTitle>
            <AlertDialogDescription>{pendingDelete?.blocked ? `This term is used in ${pendingDelete.usageCount ?? 1} existing case restoration(s). Existing cases keep their current text, but the term will leave suggestions.` : "This removes the legacy term from future suggestions. Existing cases keep their current text."}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel disabled={!!busyId}>Cancel</AlertDialogCancel><AlertDialogAction onClick={(event) => { event.preventDefault(); void markInactive(!!pendingDelete?.blocked); }} disabled={!!busyId} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{busyId ? <Loader2 size={13} className="animate-spin" /> : pendingDelete?.blocked ? "Mark inactive anyway" : "Mark inactive"}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

type CatalogCaseType = "restorative" | "removable" | "ortho";

function CatalogTreeEditor({ labOrganizationId }: { labOrganizationId: string }) {
  const qc = useQueryClient();
  const treeQuery = useQuery<EffectiveCatalogTree>({
    queryKey: ["catalog", "tree", labOrganizationId],
    queryFn: () => apiFetch<EffectiveCatalogTree>(`/catalog/tree?labOrganizationId=${encodeURIComponent(labOrganizationId)}`),
    staleTime: 30_000,
  });
  const caseTypes = catalogTreeNodes(treeQuery.data);
  const [expandedCases, setExpandedCases] = useState<string[]>([]);
  const [expandedSubtypes, setExpandedSubtypes] = useState<string[]>([]);
  const [adding, setAdding] = useState<{ type: CatalogEntryType; caseType: CatalogCaseType; parentKey?: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ entry: CatalogMaterialNode | CatalogSubtypeNode; type: CatalogEntryType; parentLabel?: string; blocked: boolean; usageCount?: number; childCount?: number } | null>(null);

  useEffect(() => {
    setExpandedCases(caseTypes.map((caseType) => caseType.key));
  }, [treeQuery.data]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["catalog", "tree", labOrganizationId] });

  const saveEntry = async (
    entry: CatalogMaterialNode | CatalogSubtypeNode,
    type: CatalogEntryType,
    caseType: CatalogCaseType,
    parentKey: string | undefined,
    patch: { label?: string; isActive?: boolean; sortOrder?: number },
  ) => {
    setBusyKey(entry.id ?? `${type}:${entry.key}`);
    setError(null);
    try {
      if (entry.isCustom && entry.id) {
        await apiFetch(`/catalog/entries/${encodeURIComponent(entry.id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      } else {
        await apiFetch("/catalog/builtin-overrides", {
          method: "PATCH",
          body: JSON.stringify({ labOrganizationId, entryType: type, caseType, ...(parentKey ? { parentKey } : {}), key: entry.key, ...patch }),
        });
      }
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not update the catalog.");
    } finally {
      setBusyKey(null);
    }
  };

  const addEntry = async (value: string) => {
    if (!adding) return;
    const label = value.trim();
    if (!label) {
      setError("Catalog labels must not be blank.");
      return;
    }
    setBusyKey(`new:${adding.type}:${adding.parentKey ?? adding.caseType}`);
    setError(null);
    try {
      await apiFetch("/catalog/entries", {
        method: "POST",
        body: JSON.stringify({ labOrganizationId, entryType: adding.type, caseType: adding.caseType, label, ...(adding.parentKey ? { parentKey: adding.parentKey } : {}) }),
      });
      setAdding(null);
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not add the catalog entry.");
    } finally {
      setBusyKey(null);
    }
  };

  const reorder = async (
    entries: Array<CatalogMaterialNode | CatalogSubtypeNode>,
    index: number,
    direction: -1 | 1,
    type: CatalogEntryType,
    caseType: CatalogCaseType,
    parentKey?: string,
  ) => {
    const target = index + direction;
    if (target < 0 || target >= entries.length) return;
    const reordered = [...entries];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    setBusyKey(`order:${entries[index].key}`);
    setError(null);
    try {
      await Promise.all(reordered.map((entry, nextIndex) => {
        if (entry.sortOrder === nextIndex) return Promise.resolve();
        return saveEntry(entry, type, caseType, parentKey, { sortOrder: nextIndex });
      }));
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not reorder the catalog.");
    } finally {
      setBusyKey(null);
    }
  };

  const removeEntry = async (force: boolean) => {
    if (!pendingDelete) return;
    const entry = pendingDelete.entry;
    const deleteState = pendingDelete;
    const entryId = entry.id;
    if (!entryId) return;
    setBusyKey(entryId);
    setError(null);
    try {
      await apiFetch(`/catalog/entries/${encodeURIComponent(entryId)}${force ? "?force=true" : ""}`, { method: "DELETE" });
      setPendingDelete(null);
      await refresh();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as { usageCount?: number } | null;
        setPendingDelete({ ...deleteState, blocked: true, usageCount: typeof body?.usageCount === "number" ? body.usageCount : 1 });
      } else {
        setError(err instanceof Error ? err.message : "Could not delete the catalog entry.");
      }
    } finally {
      setBusyKey(null);
    }
  };

  const toggle = (values: string[], key: string, setter: (next: string[]) => void) => {
    setter(values.includes(key) ? values.filter((item) => item !== key) : [...values, key]);
  };

  if (treeQuery.isLoading) return <div className="flex items-center gap-2 text-muted-foreground text-sm py-6"><Loader2 size={14} className="animate-spin" /> Loading catalog…</div>;
  if (treeQuery.isError) return <p className="text-sm text-destructive py-2">Failed to load the catalog.</p>;

  return (
    <section className="space-y-3" data-testid="catalog-tree-editor">
      <div>
        <h3 className="text-sm font-semibold">Case catalog</h3>
        <p className="text-xs text-muted-foreground mt-0.5">Organize restoration choices by fixed case type, subtype, and material.</p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {caseTypes.length === 0 && <p className="text-sm text-muted-foreground rounded-md border border-border px-3 py-4">No catalog entries are available yet.</p>}
      <div className="space-y-2">
        {caseTypes.map((caseType) => {
          const caseOpen = expandedCases.includes(caseType.key);
          const subtypes = [...caseType.subtypes].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
          return (
            <div key={caseType.key} className="border border-border rounded-md overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 bg-secondary/30">
                <button type="button" onClick={() => toggle(expandedCases, caseType.key, setExpandedCases)} aria-label={`${caseOpen ? "Collapse" : "Expand"} ${caseType.label}`} className="p-0.5">{caseOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
                <span className="font-semibold text-sm flex-1">{caseType.label}</span>
                <span className="text-[11px] text-muted-foreground">Fixed case type</span>
              </div>
              {caseOpen && (
                <div className="p-2 space-y-1.5">
                  {subtypes.map((subtype, subtypeIndex) => {
                    const subtypeOpen = expandedSubtypes.includes(subtype.key);
                    const subtypeBusy = busyKey === (subtype.id ?? `subtype:${subtype.key}`);
                    const materials = [...(subtype.materials ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
                    return (
                      <div key={subtype.key} className="border border-border/70 rounded-md">
                        <div className="flex items-center gap-2 px-2.5 py-2">
                          <button type="button" onClick={() => toggle(expandedSubtypes, subtype.key, setExpandedSubtypes)} aria-label={`${subtypeOpen ? "Collapse" : "Expand"} ${subtype.label}`} className="p-0.5">{subtypeOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
                          <span className={`flex-1 text-sm ${!subtype.isActive ? "line-through text-muted-foreground" : ""}`}>{subtype.label}</span>
                          {!subtype.isActive && <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Inactive</span>}
                          <button type="button" onClick={() => setAdding({ type: "material", caseType: caseType.key, parentKey: subtype.key })} title="Add material" className="p-1 text-muted-foreground hover:text-foreground"><Plus size={13} /></button>
                          <button type="button" onClick={() => void reorder(subtypes, subtypeIndex, -1, "subtype", caseType.key)} disabled={subtypeIndex === 0 || !!busyKey} title="Move up" className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"><ArrowUp size={13} /></button>
                          <button type="button" onClick={() => void reorder(subtypes, subtypeIndex, 1, "subtype", caseType.key)} disabled={subtypeIndex === subtypes.length - 1 || !!busyKey} title="Move down" className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"><ArrowDown size={13} /></button>
                          <button type="button" onClick={() => void saveEntry(subtype, "subtype", caseType.key, undefined, { isActive: !subtype.isActive })} disabled={subtypeBusy || !!editingId} title={subtype.isActive ? "Disable subtype" : "Enable subtype"} className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30">{subtypeBusy ? <Loader2 size={13} className="animate-spin" /> : <Ban size={13} />}</button>
                          {subtype.isCustom && subtype.id && <><button type="button" onClick={() => { setEditingId(subtype.id!); setEditValue(subtype.label); }} disabled={!!busyKey || !!editingId} title="Rename subtype" className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"><Pencil size={13} /></button><button type="button" onClick={() => setPendingDelete({ entry: subtype, type: "subtype", parentLabel: caseType.label, blocked: false, childCount: materials.filter((material) => material.isCustom).length })} disabled={!!busyKey || !!editingId} title="Delete subtype" className="p-1 text-muted-foreground hover:text-destructive disabled:opacity-30"><Trash2 size={13} /></button></>}
                        </div>
                        {editingId === subtype.id && <CatalogInlineForm action="Rename" value={editValue} saving={busyKey === subtype.id} onCancel={() => setEditingId(null)} onSave={(value) => { const label = value.trim(); if (!label) { setError("Catalog labels must not be blank."); return; } void saveEntry(subtype, "subtype", caseType.key, undefined, { label }).then(() => setEditingId(null)); }} />}
                        {subtypeOpen && <div className="border-t border-border/70 bg-secondary/10 p-2 pl-8 space-y-1">
                          {materials.map((material, materialIndex) => {
                            const materialWithParent = material;
                            const materialBusy = busyKey === (material.id ?? `material:${material.key}`);
                            return <div key={material.key} className="flex items-center gap-2 min-h-8">
                              <span className={`flex-1 text-sm ${!material.isActive ? "line-through text-muted-foreground" : ""}`}>{material.label}</span>
                              {!material.isActive && <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Inactive</span>}
                              <button type="button" onClick={() => void reorder(materials, materialIndex, -1, "material", caseType.key, subtype.key)} disabled={materialIndex === 0 || !!busyKey} title="Move up" className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"><ArrowUp size={12} /></button>
                              <button type="button" onClick={() => void reorder(materials, materialIndex, 1, "material", caseType.key, subtype.key)} disabled={materialIndex === materials.length - 1 || !!busyKey} title="Move down" className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"><ArrowDown size={12} /></button>
                              <button type="button" onClick={() => void saveEntry(materialWithParent, "material", caseType.key, subtype.key, { isActive: !material.isActive })} disabled={materialBusy || !!editingId} title={material.isActive ? "Disable material" : "Enable material"} className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30">{materialBusy ? <Loader2 size={12} className="animate-spin" /> : <Ban size={12} />}</button>
                              {material.isCustom && material.id && <><button type="button" onClick={() => { setEditingId(material.id!); setEditValue(material.label); }} disabled={!!busyKey || !!editingId} title="Rename material" className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"><Pencil size={12} /></button><button type="button" onClick={() => setPendingDelete({ entry: material, type: "material", parentLabel: subtype.label, blocked: false })} disabled={!!busyKey || !!editingId} title="Delete material" className="p-1 text-muted-foreground hover:text-destructive disabled:opacity-30"><Trash2 size={12} /></button></>}
                              {editingId === material.id && <CatalogInlineForm action="Rename" value={editValue} saving={busyKey === material.id} onCancel={() => setEditingId(null)} onSave={(value) => { const label = value.trim(); if (!label) { setError("Catalog labels must not be blank."); return; } void saveEntry(materialWithParent, "material", caseType.key, subtype.key, { label }).then(() => setEditingId(null)); }} />}
                            </div>;
                          })}
                          {materials.length === 0 && <p className="text-xs text-muted-foreground py-1">No materials yet.</p>}
                          {adding?.type === "material" && adding.parentKey === subtype.key && <CatalogInlineForm action="Add material" saving={busyKey === `new:material:${subtype.key}`} onCancel={() => setAdding(null)} onSave={addEntry} />}
                        </div>}
                      </div>
                    );
                  })}
                  {adding?.type === "subtype" && adding.caseType === caseType.key && <CatalogInlineForm action="Add subtype" saving={busyKey === `new:subtype:${caseType.key}`} onCancel={() => setAdding(null)} onSave={addEntry} />}
                  <button type="button" onClick={() => setAdding({ type: "subtype", caseType: caseType.key })} className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline px-1 py-1"><Plus size={13} /> Add subtype</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => { if (!open && !busyKey) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingDelete?.blocked ? `Delete "${pendingDelete.entry.label}" anyway?` : `Delete "${pendingDelete?.entry.label}"?`}</AlertDialogTitle>
            <AlertDialogDescription>{pendingDelete?.blocked ? `This ${pendingDelete.type} is used in ${pendingDelete.usageCount ?? 1} existing case restoration(s). Existing cases keep their current text, but the entry will leave the catalog.` : <>This custom {pendingDelete?.type} will be removed from the catalog.{pendingDelete?.childCount ? ` It will also remove ${pendingDelete.childCount} custom material child${pendingDelete.childCount === 1 ? "" : "ren"}.` : ""} This cannot be undone.</>}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel disabled={!!busyKey}>Cancel</AlertDialogCancel><AlertDialogAction onClick={(event) => { event.preventDefault(); void removeEntry(!!pendingDelete?.blocked); }} disabled={!!busyKey} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{busyKey ? <Loader2 size={13} className="animate-spin" /> : pendingDelete?.blocked ? "Delete anyway" : "Delete"}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

interface EffectiveCatalogTree {
  caseTypes: CatalogCaseTypeNode[];
}

function DoctorPracticeMemoryPanel() {
  const { user } = useAuth();
  const orgId = user?.practiceOrganizationId;
  const queryClient = useQueryClient();
  const queryKey = ["rx-doctor-practice-memory", orgId] as const;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedPracticeId, setSelectedPracticeId] = useState("");
  const [pendingDelete, setPendingDelete] =
    useState<RememberedDoctorPracticeMapping | null>(null);

  const mappingsQuery = useQuery<RememberedDoctorPracticeMapping[]>({
    queryKey,
    enabled: !!orgId,
    queryFn: async () => {
      const response = await apiFetch<{
        mappings?: RememberedDoctorPracticeMapping[];
      }>(
        `/rx-doctor-practice-memory?labOrganizationId=${encodeURIComponent(orgId!)}`,
      );
      return response.mappings ?? [];
    },
  });

  const practicesQuery = useQuery<Organization[]>({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
    enabled: !!orgId,
  });

  const practices = useMemo(
    () =>
      (practicesQuery.data ?? [])
        .filter(
          (practice) =>
            practice.type === "provider" &&
            practice.parentLabOrganizationId === orgId &&
            practice.isActive !== false &&
            !practice.deletedAt,
        )
        .sort((a, b) =>
          (a.displayName || a.name).localeCompare(b.displayName || b.name),
        ),
    [orgId, practicesQuery.data],
  );

  const updateMutation = useMutation({
    mutationFn: async ({
      mapping,
      providerOrganizationId,
    }: {
      mapping: RememberedDoctorPracticeMapping;
      providerOrganizationId: string;
    }) => {
      if (!orgId) throw new Error("No lab organization linked.");
      return apiFetch("/rx-doctor-practice-memory", {
        method: "POST",
        body: JSON.stringify({
          labOrganizationId: orgId,
          doctorName: mapping.doctorName,
          providerOrganizationId,
        }),
      });
    },
    onSuccess: async () => {
      setEditingId(null);
      setSelectedPracticeId("");
      await queryClient.invalidateQueries({ queryKey });
      toast({ title: "Remembered practice updated" });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not update remembered practice",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (mappingId: string) =>
      apiFetch(
        `/rx-doctor-practice-memory/${encodeURIComponent(mappingId)}`,
        { method: "DELETE" },
      ),
    onSuccess: async () => {
      setPendingDelete(null);
      await queryClient.invalidateQueries({ queryKey });
      toast({ title: "Remembered practice removed" });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not remove remembered practice",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const mappings = mappingsQuery.data ?? [];

  return (
    <PanelShell
      title="Remembered doctor practices"
      subtitle="Review the doctor-to-practice choices learned during prescription intake. Removing one makes the next prescription use the normal practice matching steps."
    >
      {mappingsQuery.isLoading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 size={15} className="animate-spin" />
          Loading remembered practices…
        </div>
      ) : mappingsQuery.isError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-sm font-medium text-destructive">
            Could not load remembered practices.
          </p>
          <button
            type="button"
            onClick={() => void mappingsQuery.refetch()}
            className="mt-2 text-xs font-semibold text-primary hover:underline"
          >
            Try again
          </button>
        </div>
      ) : mappings.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-5 py-8 text-center">
          <p className="text-sm font-medium">No remembered practices yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Mappings appear here after a practice is confirmed during prescription intake.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">Doctor</th>
                <th className="px-4 py-2.5 font-medium">Practice</th>
                <th className="px-4 py-2.5 font-medium">Last confirmed</th>
                <th className="px-4 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {mappings.map((mapping) => {
                const editing = editingId === mapping.id;
                const currentPracticeInOptions = practices.some(
                  (practice) =>
                    practice.id === mapping.providerOrganizationId,
                );
                return (
                  <tr key={mapping.id} className="align-middle">
                    <td className="px-4 py-3 font-medium">{mapping.doctorName}</td>
                    <td className="px-4 py-3">
                      {editing ? (
                        <select
                          aria-label={`Practice for ${mapping.doctorName}`}
                          value={selectedPracticeId}
                          onChange={(event) =>
                            setSelectedPracticeId(event.target.value)
                          }
                          className="h-8 w-full min-w-44 rounded-md border border-input bg-background px-2 text-xs"
                        >
                          {!currentPracticeInOptions && (
                            <option
                              value={mapping.providerOrganizationId}
                              disabled
                            >
                              {mapping.practiceName}
                            </option>
                          )}
                          {practices.map((practice) => (
                            <option key={practice.id} value={practice.id}>
                              {practice.displayName || practice.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span
                          className={
                            mapping.practiceAvailable
                              ? undefined
                              : "text-muted-foreground italic"
                          }
                        >
                          {mapping.practiceName}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                      {formatDateTime(mapping.updatedAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1.5">
                        {editing ? (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                updateMutation.mutate({
                                  mapping,
                                  providerOrganizationId: selectedPracticeId,
                                })
                              }
                              disabled={
                                !selectedPracticeId ||
                                selectedPracticeId ===
                                  mapping.providerOrganizationId ||
                                updateMutation.isPending
                              }
                              className="h-8 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground disabled:opacity-50"
                            >
                              {updateMutation.isPending ? "Saving…" : "Save"}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(null);
                                setSelectedPracticeId("");
                              }}
                              disabled={updateMutation.isPending}
                              className="h-8 rounded-md border border-input px-3 text-xs font-semibold hover:bg-secondary"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(mapping.id);
                                setSelectedPracticeId(
                                  mapping.providerOrganizationId,
                                );
                              }}
                              disabled={practices.length === 0}
                              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input px-2.5 text-xs font-semibold hover:bg-secondary disabled:opacity-50"
                            >
                              <Pencil size={13} />
                              Change
                            </button>
                            <button
                              type="button"
                              onClick={() => setPendingDelete(mapping)}
                              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-destructive/30 px-2.5 text-xs font-semibold text-destructive hover:bg-destructive/5"
                            >
                              <Trash2 size={13} />
                              Remove
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this remembered practice?</AlertDialogTitle>
            <AlertDialogDescription>
              The next prescription for {pendingDelete?.doctorName ?? "this doctor"} will
              fall back to the prescription name and normal practice matching.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                if (pendingDelete) deleteMutation.mutate(pendingDelete.id);
              }}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? "Removing…" : "Remove mapping"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PanelShell>
  );
}

function BackupProgressBar({ status }: { status: LocalBackupLiveStatus | null }) {
  const percent = status?.state === "completed"
    ? 100
    : Math.max(0, Math.min(99, Math.floor(status?.overallProgress ?? 0)));
  const description = `${percent}% of the whole backup complete.`;
  return (
    <div className="flex items-center gap-2" data-testid="manual-backup-progress">
      <div
        role="progressbar"
        aria-label="Backup progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={description}
        data-testid="manual-backup-progress-bar"
        className="h-2 flex-1 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-950/60"
      >
        <div
          className="h-full rounded-full bg-blue-600 backup-progress-stripes"
          style={{
            width: `${percent}%`,
            backgroundImage: "repeating-linear-gradient(45deg,rgba(255,255,255,.32) 0,rgba(255,255,255,.32) 6px,transparent 6px,transparent 12px)",
          }}
        />
      </div>
    </div>
  );
}
