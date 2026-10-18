import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import type { LabCase } from "@/lib/types";
import { ProviderDashboard } from "@/components/provider/ProviderDashboard";
import { ProviderMyAccount } from "@/components/provider/ProviderMyAccount";
import { ProviderBilling } from "@/components/provider/ProviderBilling";
import { ProviderMessageLab } from "@/components/provider/ProviderMessageLab";
import { ProviderStats } from "@/components/provider/ProviderStats";
import { apiFetch, setProviderOrganizationId } from "@/lib/api";
import { providerStartupRequest } from "@/lib/provider-startup-request";
import { ProviderContentBoundary } from "@/components/provider/ProviderContentBoundary";
import { FeedbackAction } from "./ReportIssueDialog";
import { Bell, Loader2, Settings } from "lucide-react";
import { ProviderDoctorPreferences } from "@/components/provider/ProviderDoctorPreferences";
import {
  canReportIssueForSelectedOrganization,
  ReportIssueAction,
} from "@/components/ReportIssueDialog";
import { Link } from "wouter";
import { useCreatorAccess } from "@/lib/creator";

type ProviderCase = LabCase & {
  restorationTypes?: string | null;
  providerAccountNumber?: string | null;
  labName?: string | null;
  openInvoiceAmount?: number | null;
};

type Tab = "dashboard" | "account" | "billing" | "message" | "stats" | "settings";

interface NavItemProps {
  tab: Tab;
  active: boolean;
  onClick: () => void;
  icon: string;
  label: string;
  badge?: number;
}

function NavItem({ active, onClick, icon, label, badge }: NavItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors text-left ${
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-muted"
      }`}
    >
      <span className="text-base leading-none">{icon}</span>
      <span className="flex-1">{label}</span>
      {badge != null && badge > 0 && (
        <span
          className="shrink-0 inline-flex items-center justify-center rounded-full bg-red-500 px-1.5 text-[10px] font-semibold leading-none text-white"
          style={{ minWidth: 18, height: 18 }}
          aria-label={`${badge} unread message${badge === 1 ? "" : "s"}`}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
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
type ProviderOrganization = { id: string; name: string; role?: string | null };
type ProviderSelectionIntent = {
  id: string;
  generation: number;
  rollback: boolean;
  errorMessage?: string;
};
interface ProviderPortalLayoutProps {
  cases: ProviderCase[] | null;
  casesError: string | null;
  onRefreshCases?: () => void;
  onProviderSwitch?: () => void;
}

export function ProviderPortalLayout({
  cases,
  casesError,
  onRefreshCases,
  onProviderSwitch,
}: ProviderPortalLayoutProps) {
  const { user, logout } = useAuth();
  const creator = useCreatorAccess();
  const [providerOrganizations, setProviderOrganizations] = useState<ProviderOrganization[]>([]);
  const [providerMembershipRoles, setProviderMembershipRoles] = useState<Record<string, string>>({});
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [providerSelectionLoading, setProviderSelectionLoading] = useState(true);
  const [providerSwitching, setProviderSwitching] = useState(false);
  const [providerSelectionError, setProviderSelectionError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const lifecycle = useRef(0);
  const callbacks = useRef({ onRefreshCases, onProviderSwitch });
  callbacks.current = { onRefreshCases, onProviderSwitch };
  const storageKey = `labtrax_provider_practice_v1:${user?.id ?? ""}`;
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;
  const selectionGeneration = useRef(0);
  const committedProviderId = useRef<string | null>(null);
  const desiredSelection = useRef<ProviderSelectionIntent | null>(null);
  const confirmedServerProviderId = useRef<string | null>(null);
  const selectionReconciler = useRef<Promise<void> | null>(null);
  const selectedProvider = providerOrganizations.find((org) => org.id === selectedProviderId);
  const selectedProviderRole =
    selectedProvider?.role ?? providerMembershipRoles[selectedProviderId ?? ""];
  const canReportIssue =
    canReportIssueForSelectedOrganization(
      Object.entries(providerMembershipRoles).map(([organizationId, role]) => ({
        organizationId,
        role,
        status: "active",
      })),
      selectedProviderId,
    ) ||
    (selectedProvider != null &&
      (selectedProviderRole === "owner" || selectedProviderRole === "admin"));
  useEffect(() => {
    let cancelled = false;
    const epoch = ++lifecycle.current;
    desiredSelection.current = null;
    committedProviderId.current = null;
    confirmedServerProviderId.current = null;
    setSelectedProviderId(null);
    setProviderOrganizationId(null);
    callbacks.current.onProviderSwitch?.();
    setProviderSelectionLoading(true);
    setProviderSwitching(false);
    setProviderSelectionError(null);
    Promise.all([
      providerStartupRequest<ProviderOrganization[]>("/provider/organizations"),
      providerStartupRequest<{
        memberships?: Array<{
          organizationId: string;
          role: string;
          status: string;
        }>;
      }>("/auth/me").catch(() => ({ memberships: [] })),
    ]).then(([orgs, me]) => {
      if (cancelled || epoch !== lifecycle.current) return;
      if (!Array.isArray(orgs)) throw new Error("Could not load practices. Please try again.");
      setProviderOrganizations(orgs);
      setProviderMembershipRoles(
        Object.fromEntries(
          (me.memberships ?? [])
            .filter((membership) => membership.status === "active")
            .map((membership) => [
              membership.organizationId,
              membership.role,
            ]),
        ),
      );
      let persisted: string | null = null;
      try { persisted = localStorage.getItem(storageKey); } catch { /* storage unavailable */ }
      const restored = orgs.find((org) => org.id === persisted)?.id;
      if (persisted && !restored) {
        try { localStorage.removeItem(storageKey); } catch { /* storage unavailable */ }
      }
      const initialId = orgs.length === 1 ? orgs[0].id : restored;
      if (initialId) selectProvider(initialId);
      setProviderSelectionLoading(false);
    }).catch((error) => {
      if (!cancelled) {
        setProviderSelectionError(error instanceof Error ? error.message : "Could not load practices.");
        setProviderSelectionLoading(false);
      }
    });
    return () => {
      cancelled = true;
      lifecycle.current += 1;
      desiredSelection.current = null;
      setProviderOrganizationId(null);
    };
  }, [reloadToken, storageKey]);

  function startSelectionReconciler() {
    if (selectionReconciler.current) return;
    const reconciler = (async () => {
      while (desiredSelection.current) {
        const intent = desiredSelection.current;
        const epoch = lifecycle.current;
        if (confirmedServerProviderId.current === intent.id) {
          if (desiredSelection.current?.generation !== intent.generation) continue;
          committedProviderId.current = intent.id;
          setProviderOrganizationId(intent.id);
          setSelectedProviderId(intent.id);
          setProviderSelectionError(intent.errorMessage ?? null);
          try { localStorage.setItem(storageKeyRef.current, intent.id); } catch { /* storage unavailable */ }
          desiredSelection.current = null;
          setProviderSwitching(false);
          callbacks.current.onRefreshCases?.();
          return;
        }

        try {
          await providerStartupRequest("/provider/selection", {
            method: "POST",
            body: JSON.stringify({ providerOrganizationId: intent.id }),
          });
          if (epoch !== lifecycle.current) continue;
          confirmedServerProviderId.current = intent.id;
        } catch (error) {
          if (epoch !== lifecycle.current) continue;
          confirmedServerProviderId.current = null;
          if (desiredSelection.current?.generation !== intent.generation) continue;
          const message = error instanceof Error ? error.message : "Could not switch practice.";
          if (intent.rollback) {
            desiredSelection.current = null;
            setProviderSwitching(false);
            setProviderSelectionError(`Could not restore the previous practice. ${message}`);
            return;
          }
          const previousId = committedProviderId.current;
          if (!previousId) {
            desiredSelection.current = null;
            setProviderSwitching(false);
            setProviderSelectionError(message);
            return;
          }
          desiredSelection.current = {
            id: previousId,
            generation: ++selectionGeneration.current,
            rollback: true,
            errorMessage: message,
          };
        }
      }
    })();
    selectionReconciler.current = reconciler;
    void reconciler.finally(() => {
      if (selectionReconciler.current === reconciler) selectionReconciler.current = null;
      if (desiredSelection.current) startSelectionReconciler();
    });
  }

  function selectProvider(id: string) {
    if (!id) return;
    desiredSelection.current = {
      id,
      generation: ++selectionGeneration.current,
      rollback: false,
    };
    confirmedServerProviderId.current = null;
    setProviderSwitching(true);
    setSelectedProviderId(null);
    setProviderOrganizationId(null);
    callbacks.current.onProviderSwitch?.();
    setProviderSelectionError(null);
    startSelectionReconciler();
  }
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("providerCardSetupSession")) return "account";
    if (params.has("providerAutopayRequest") || params.has("providerAutopayToken")) return "account";
    if (params.has("providerPaymentCheckout")) return "billing";
    return "dashboard";
  });
  const [autopayHandoff] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      request: params.get("providerAutopayRequest") ?? undefined,
      token: params.get("providerAutopayToken") ?? undefined,
    };
  });
  // caseId to auto-open in the dashboard (set when a shared_note notification is clicked)
  const [notifCaseId, setNotifCaseId] = useState<string | null>(null);

  // ── Messenger unread count ────────────────────────────────────────────────
  const [messengerUnreadCount, setMessengerUnreadCount] = useState(0);
  const messengerGeneration = useRef(0);
  // Opening Message My Lab clears the badge, because the server watermark only
  // moves once the conversation renders and marks the newest message read —
  // the badge would otherwise linger while the provider is already reading.
  // The poll keeps running behind the open section, so a count whose request
  // overlapped the visit is stale for the same reason and is dropped: the
  // badge waits for a count fetched entirely after the provider leaves.
  const messagesOpenRef = useRef(false);

  const fetchMessengerUnreadCount = useCallback(async () => {
    if (!user || !selectedProviderId) return;
    const generation = ++messengerGeneration.current;
    const requestedProviderId = selectedProviderId;
    const startedWhileReading = messagesOpenRef.current;
    try {
      const data = await apiFetch<{ total: number }>("/provider-messenger/unread-count");
      if (
        generation !== messengerGeneration.current ||
        requestedProviderId !== selectedProviderId
      ) return;
      if (startedWhileReading || messagesOpenRef.current) {
        setMessengerUnreadCount(0);
        return;
      }
      setMessengerUnreadCount(data.total ?? 0);
    } catch {
      /* ignore */
    }
  }, [user, selectedProviderId]);

  useEffect(() => {
    messengerGeneration.current += 1;
    setMessengerUnreadCount(0);
    fetchMessengerUnreadCount();
    const interval = setInterval(fetchMessengerUnreadCount, MESSENGER_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchMessengerUnreadCount]);

  // Tracks the open section for the rule above, and clears the badge for the
  // ways into Message My Lab that do not go through the sidebar button.
  useEffect(() => {
    messagesOpenRef.current = activeTab === "message";
    if (activeTab === "message") setMessengerUnreadCount(0);
  }, [activeTab]);

  // ── Notification Bell state ───────────────────────────────────────────────
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifItems, setNotifItems] = useState<Notification[]>([]);
  const [notifLoading, setNotifLoading] = useState(false);
  const [notifError, setNotifError] = useState<string | null>(null);
  const [hasUnread, setHasUnread] = useState(false);
  const markReadInflight = useRef(false);

  const fetchUnreadCount = useCallback(async () => {
    if (!user) return;
    try {
      const items = await apiFetch<Notification[]>("/notifications");
      setHasUnread(items.some((n) => !n.readAt));
    } catch {
      /* ignore */
    }
  }, [user]);

  useEffect(() => {
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchUnreadCount]);

  async function openNotifications() {
    setNotificationsOpen(true);
    setNotifLoading(true);
    setNotifError(null);
    try {
      const items = await apiFetch<Notification[]>("/notifications");
      setNotifItems(items);
      setHasUnread(items.some((n) => !n.readAt));
    } catch {
      setNotifError("Could not load notifications. Please try again.");
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
      setNotifItems((prev) =>
        prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() }))
      );
      setHasUnread(false);
    } catch {
      /* ignore */
    } finally {
      markReadInflight.current = false;
    }
  }

  function handleNotificationClick(notif: Notification) {
    setNotificationsOpen(false);

    // Mark as read locally + remotely (best-effort)
    if (!notif.readAt) {
      setNotifItems((prev) =>
        prev.map((n) =>
          n.id === notif.id ? { ...n, readAt: new Date().toISOString() } : n
        )
      );
      apiFetch(`/notifications/${notif.id}/read`, { method: "PATCH" }).catch(() => {});
    }

    if (notif.type === "lab_payment_recorded" || notif.type === "payment_reversed") {
      setActiveTab("billing");
      return;
    }

    // Deep-link: shared_note / shared_note_added / shared_attachment_added
    // notifications open the case detail in the dashboard.
    if (
      notif.type === "shared_note" ||
      notif.type === "shared_note_added" ||
      notif.type === "shared_attachment_added"
    ) {
      const data = notif.dataJson as Record<string, unknown> | null | undefined;
      const caseId = data?.caseId as string | undefined;
      if (caseId) {
        setActiveTab("dashboard");
        setNotifCaseId(caseId);
      }
    }
  }

  // ── Nav ───────────────────────────────────────────────────────────────────
  const displayAccountNumber = user?.practiceAccountNumber ?? null;

  const navItems: { tab: Tab; icon: string; label: string }[] = [
    { tab: "dashboard", icon: "📋", label: "Dashboard" },
    { tab: "account", icon: "👤", label: "My Account" },
    { tab: "billing", icon: "💳", label: "View and Pay My Bill" },
    { tab: "message", icon: "✉️", label: "Message My Lab" },
    { tab: "stats", icon: "📊", label: "Stats" },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Top header */}
      <header className="border-b border-border px-4 sm:px-6 py-4 flex flex-wrap gap-3 items-center justify-between shrink-0">
        <div>
          <h1 className="text-lg font-semibold">My Cases</h1>
          <p className="text-xs text-muted-foreground">
            {user?.firstName || user?.username || "Provider"}
            {displayAccountNumber ? ` · ${displayAccountNumber}` : ""}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {providerOrganizations.length > 1 && (
            <select
              aria-label="Active practice"
              value={selectedProviderId ?? ""}
              onChange={(event) => void selectProvider(event.target.value)}
              className="h-9 max-w-48 rounded-md border border-border bg-background px-2 text-xs"
              disabled={providerSelectionLoading}
            >
              <option value="" disabled>Select practice…</option>
              {providerOrganizations.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
            </select>
          )}
          {/* Notification Bell */}
          <div className="relative">
            <button
              type="button"
              onClick={notificationsOpen ? closeNotifications : openNotifications}
              className="relative h-9 w-9 rounded-md hover:bg-muted flex items-center justify-center text-muted-foreground transition-colors"
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
                <div className="fixed sm:absolute right-2 sm:right-0 top-24 sm:top-[calc(100%+6px)] w-80 max-w-[calc(100vw-1rem)] z-50 bg-card border border-border rounded-md shadow-lg text-sm overflow-hidden">
                  <div className="px-3 py-2 border-b border-border flex items-center justify-between">
                    <span className="font-medium text-xs">Notifications</span>
                    <button type="button" aria-label="Close notifications" onClick={() => void closeNotifications()}>Close</button>
                    {notifLoading && (
                      <Loader2 size={12} className="animate-spin text-muted-foreground" />
                    )}
                  </div>
                  {notifError ? <div role="alert" className="p-3">
                    <p>{notifError}</p>
                    <button type="button" className="underline" onClick={() => void openNotifications()}>Retry notifications</button>
                  </div> : !notifLoading && notifItems.length === 0 ? (
                    <div className="px-3 py-6 text-center text-muted-foreground text-xs">
                      No new alerts
                    </div>
                  ) : (
                    <ul className="max-h-80 overflow-y-auto divide-y divide-border">
                      {notifItems.map((notif) => (
                        <li key={notif.id}>
                          <button
                            type="button"
                            onClick={() => handleNotificationClick(notif)}
                            className={`w-full text-left px-3 py-2.5 transition-colors hover:bg-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-primary ${
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
                              <span className="text-[10px] text-muted-foreground/60 whitespace-nowrap shrink-0 mt-0.5">
                                {relativeTime(notif.createdAt)}
                              </span>
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={() => setActiveTab("settings")}
            className="h-9 w-9 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground flex items-center justify-center transition-colors"
            aria-label="Settings"
            title="Settings"
          >
            <Settings size={17} />
          </button>

          <button
            type="button"
            onClick={() => void logout()}
            className="text-sm px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>
      {providerSelectionError && (
        <div className="border-b border-destructive/20 bg-destructive/10 px-6 py-2 text-sm text-destructive">
          {providerSelectionError}
        </div>
      )}

      {/* Two-column body */}
      <div className="flex flex-col sm:flex-row flex-1 min-h-0">
        {/* Left sidebar */}
        <aside className="w-full sm:w-56 shrink-0 border-b sm:border-r border-border px-3 py-4 flex flex-col gap-1">
          {navItems.map(({ tab, icon, label }) => (
            <NavItem
              key={tab}
              tab={tab}
              active={activeTab === tab}
              onClick={() => {
                if (tab === "message") setMessengerUnreadCount(0);
                setActiveTab(tab);
              }}
              icon={icon}
              label={label}
              badge={tab === "message" ? messengerUnreadCount : undefined}
            />
          ))}
          <div className="mt-auto pt-4">
            {canReportIssue && <ReportIssueAction portal="provider" />}
            {creator.data?.isCreator && (
              <Link href="/creator" className="block rounded-md px-3 py-2 text-sm hover:bg-secondary">
                Creator
              </Link>
            )}
            <FeedbackAction portal="provider" />
          </div>
        </aside>

        {/* Main content */}
        <main
          key={activeTab === "settings" ? "account-settings" : selectedProviderId ?? "provider-selection"}
          className={
            activeTab === "message"
              ? "flex-1 flex flex-col min-h-0 overflow-hidden"
              : "flex-1 min-w-0 px-4 sm:px-8 py-6 overflow-y-auto"
          }
        >
          <ProviderContentBoundary key={activeTab}>
          {activeTab === "dashboard" && selectedProviderId && (
            <ProviderDashboard
              cases={cases}
              error={casesError}
              onViewBill={() => setActiveTab("billing")}
              initialCaseId={notifCaseId}
            />
          )}
          {activeTab === "account" && <ProviderMyAccount
            providerAutopayRequest={autopayHandoff.request}
            providerAutopayToken={autopayHandoff.token}
          />}
          {activeTab === "billing" && selectedProviderId && (
            <ProviderBilling
              cases={cases}
              casesError={casesError}
              onRefreshCases={onRefreshCases}
            />
          )}
          {activeTab === "message" && selectedProviderId && (
            <ProviderMessageLab cases={cases} casesError={casesError} />
          )}
          {activeTab === "stats" && selectedProviderId && <ProviderStats />}
          {!selectedProviderId && activeTab !== "settings" && (
            <div role="status" className="rounded-md border border-border bg-card p-6 text-sm space-y-3">
              <h2 className="font-semibold">{navItems.find((item) => item.tab === activeTab)?.label}</h2>
              {providerSelectionLoading ? <p>Loading your practices…</p> :
                providerSwitching ? <p>Opening your practice…</p> :
                providerSelectionError ? <p>Could not open your practice. {providerSelectionError}</p> :
                providerOrganizations.length === 0 ? <>
                  <h3 className="font-semibold">No active practice yet</h3>
                  <p>Practice access requests require approval from the practice administrator. If you requested access, ask them to approve it. Refresh after approval, or sign out to use another account. Optional lab partnership approvals are separate from practice membership.</p>
                </> : <p>Select a practice above to enter its provider portal.</p>}
              <button type="button" className="underline" onClick={() => setReloadToken((value) => value + 1)}>
                {providerSelectionError ? "Try again" : "Refresh practice access"}
              </button>
              {activeTab === "account" && <p>Your account is signed in as {user?.username}. Account billing and practice details will be available after practice access is confirmed.</p>}
            </div>
          )}
          {casesError && selectedProviderId && activeTab === "dashboard" && (
            <button type="button" className="underline" onClick={onRefreshCases}>Try loading cases again</button>
          )}
          {activeTab === "settings" && <ProviderSettings />}
          </ProviderContentBoundary>
        </main>
      </div>
    </div>
  );
}

type ProviderEmailPrefsData = {
  statementEmails: boolean;
  billingReminders: boolean;
  caseNoteNotifications: boolean;
};

type ProviderInAppPrefsData = {
  caseNoteNotifications: boolean;
};

function ProviderSettings() {
  const [prefs, setPrefs] = useState<ProviderEmailPrefsData>({
    statementEmails: true,
    billingReminders: true,
    caseNoteNotifications: true,
  });
  const [inAppPrefs, setInAppPrefs] = useState<ProviderInAppPrefsData>({
    caseNoteNotifications: true,
  });
  const [saving, setSaving] = useState<Partial<Record<keyof ProviderEmailPrefsData, boolean>>>({});
  const [savingInApp, setSavingInApp] = useState<Partial<Record<keyof ProviderInAppPrefsData, boolean>>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<{ tone: "success" | "danger"; message: string } | null>(null);
  const saveStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    apiFetch("/users/me/email-preferences")
      .then((data: ProviderEmailPrefsData) => setPrefs(data))
      .catch((err: Error) => setLoadError(err.message || "Could not load preferences."));
    apiFetch("/users/me/in-app-preferences")
      .then((data: ProviderInAppPrefsData) => setInAppPrefs(data))
      .catch((err: Error) => setLoadError(err.message || "Could not load preferences."));
    return () => {
      if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current);
    };
  }, []);

  function showSaveStatus(tone: "success" | "danger", message: string) {
    if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current);
    setSaveStatus({ tone, message });
    saveStatusTimer.current = setTimeout(() => setSaveStatus(null), 2500);
  }

  async function toggle(key: keyof ProviderEmailPrefsData, value: boolean) {
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

  async function toggleInApp(key: keyof ProviderInAppPrefsData, value: boolean) {
    setInAppPrefs((p) => ({ ...p, [key]: value }));
    setSavingInApp((s) => ({ ...s, [key]: true }));
    try {
      await apiFetch("/users/me/in-app-preferences", {
        method: "PATCH",
        body: JSON.stringify({ [key]: value }),
      });
      showSaveStatus("success", "Preference saved.");
    } catch (err) {
      setInAppPrefs((p) => ({ ...p, [key]: !value }));
      showSaveStatus("danger", (err instanceof Error ? err.message : null) || "Could not save preference.");
    } finally {
      setSavingInApp((s) => ({ ...s, [key]: false }));
    }
  }

  const prefRows: Array<{ prefKey: keyof ProviderEmailPrefsData; label: string; desc: string }> = [
    {
      prefKey: "statementEmails",
      label: "Monthly statements",
      desc: "Receive monthly billing statement PDFs by email",
    },
    {
      prefKey: "billingReminders",
      label: "Bill due reminders",
      desc: "Payment-due notices and account balance warnings",
    },
    {
      prefKey: "caseNoteNotifications",
      label: "Lab notes & attachments",
      desc: "Receive an email when your lab adds a note or file to one of your cases",
    },
  ];

  const inAppPrefRows: Array<{ prefKey: keyof ProviderInAppPrefsData; label: string; desc: string }> = [
    {
      prefKey: "caseNoteNotifications",
      label: "Lab notes & attachments",
      desc: "Show a bell notification when your lab adds a note or file to one of your cases",
    },
  ];

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Notification Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Choose which emails and in-app alerts LabTrax sends to you. Transactional messages (password resets, verification codes) are always sent.
        </p>
      </div>

      {loadError && (
        <div className="rounded-md bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
          {loadError}
        </div>
      )}
      {saveStatus && (
        <div
          className={`rounded-md px-4 py-3 text-sm ${
            saveStatus.tone === "success"
              ? "bg-green-50 border border-green-200 text-green-800"
              : "bg-destructive/10 border border-destructive/20 text-destructive"
          }`}
        >
          {saveStatus.message}
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Email notifications</p>
        <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
          {prefRows.map(({ prefKey, label, desc }) => (
            <div key={prefKey} className="flex items-center justify-between px-4 py-3 bg-card">
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
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">In-app notifications</p>
        <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
          {inAppPrefRows.map(({ prefKey, label, desc }) => (
            <div key={prefKey} className="flex items-center justify-between px-4 py-3 bg-card">
              <div className="min-w-0 mr-6">
                <p className="text-sm font-medium text-foreground">{label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={inAppPrefs[prefKey]}
                disabled={!!savingInApp[prefKey]}
                onClick={() => toggleInApp(prefKey, !inAppPrefs[prefKey])}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${inAppPrefs[prefKey] ? "bg-primary" : "bg-input"}`}
              >
                <span
                  className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${inAppPrefs[prefKey] ? "translate-x-5" : "translate-x-0"}`}
                />
              </button>
            </div>
          ))}
        </div>
      </div>
      <ProviderDoctorPreferences />
    </div>
  );
}

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

const POLL_INTERVAL_MS = 60_000;
const MESSENGER_POLL_INTERVAL_MS = 30_000;
