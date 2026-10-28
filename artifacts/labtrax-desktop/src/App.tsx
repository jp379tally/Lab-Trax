import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  setBaseUrl as setApiClientBaseUrl,
  setAuthTokenGetter as setApiClientAuthTokenGetter,
} from "@workspace/api-client-react";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { getApiOrigin, getAccessToken } from "@/lib/api";
import { guardNavigation } from "@/lib/nav-guard";
import { describeAuthRestoreStatus } from "@/lib/auth-restore-status";
import { UploadsProvider } from "@/lib/uploads-context";
import LoginPage from "@/pages/login";
import { AppLayout } from "@/components/AppLayout";
import { OfflineBanner } from "@/components/OfflineBanner";
import { canReceivePayments, LabFinanceRoute } from "@/components/finance/FinanceShell";
import PlanPickerOnboarding from "@/components/PlanPickerOnboarding";
import { CreatorGate } from "@/lib/creator";
import { Toaster } from "@/components/ui/toaster";

const DashboardPage = lazy(() => import("@/pages/dashboard"));
const CasesPage = lazy(() => import("@/pages/cases"));
const ProviderCasesPage = lazy(() => import("@/pages/provider-cases"));
const InvoicesPage = lazy(() => import("@/pages/invoices"));
const AccountsPage = lazy(() => import("@/pages/accounts"));
const StatementsPage = lazy(() => import("@/pages/statements"));
const PricingPage = lazy(() => import("@/pages/pricing"));
const ReportsPage = lazy(() => import("@/pages/reports"));
const SettingsPage = lazy(() => import("@/pages/settings"));
const MaintenancePage = lazy(() => import("@/pages/maintenance"));
const RegisterPage = lazy(() => import("@/pages/finance/register"));
const ReconcilePage = lazy(() => import("@/pages/finance/reconcile"));
const CashFlowPage = lazy(() => import("@/pages/finance/cash-flow"));
const RecurringPage = lazy(() => import("@/pages/finance/recurring"));
const ReceivePaymentsPage = lazy(() => import("@/pages/finance/receive-payments"));
const MakeDepositsPage = lazy(() => import("@/pages/finance/make-deposits"));
const PayeesPage = lazy(() => import("@/pages/finance/payees"));
const BillsPage = lazy(() => import("@/pages/finance/bills"));
const PayBillsPage = lazy(() => import("@/pages/finance/pay-bills"));
const AgingPage = lazy(() => import("@/pages/finance/aging"));
const ListsPage = lazy(() => import("@/pages/lists"));
const DownloadPage = lazy(() => import("@/pages/download"));
const BillingPage = lazy(() => import("@/pages/billing"));
const CreatorPage = lazy(() => import("@/pages/creator/CreatorPage"));
const OwnerPage = lazy(() => import("@/pages/owner/OwnerPage"));
const MessagesPage = lazy(() => import("@/pages/messages"));
const NotFound = lazy(() => import("@/pages/not-found"));
const AcceptInvitePage = lazy(() => import("@/pages/accept-invite"));
const ResetPasswordPage = lazy(() => import("@/pages/reset-password"));
const ViewUsernamePage = lazy(() => import("@/pages/view-username"));

// Wire the generated react-query hooks (`@workspace/api-client-react`) up
// to the same bearer-token + base-URL machinery the legacy `apiFetch`
// helper uses, so call sites that opt into the generated hooks (e.g.
// `useMergeDoctors` on the doctors page) authenticate correctly.
setApiClientBaseUrl(getApiOrigin() || null);
setApiClientAuthTokenGetter(() => getAccessToken());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function AuthedRoutes() {
  return (
    <UploadsProvider>
      <AppLayoutWithUploads />
    </UploadsProvider>
  );
}

function AppLayoutWithUploads() {
  return (
    <AppLayout>
      <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">Loading…</div>}>
        <Switch>
          <Route path="/" component={DashboardPage} />
          <Route path="/cases" component={CasesPage} />
          <Route path="/invoices" component={InvoicesPage} />
          <Route path="/accounts" component={AccountsPage} />
          <Route path="/doctors" component={() => <Redirect to="/accounts" />} />
          <Route path="/practices" component={() => <Redirect to="/accounts" />} />
          <Route path="/statements" component={StatementsPage} />
          <Route path="/pricing" component={PricingPage} />
          <Route path="/reports" component={ReportsPage} />
          {/* Stats now lives as a tab inside Reports; keep old bookmarks working. */}
          <Route path="/stats" component={() => <Redirect to="/reports?tab=stats" />} />
          <Route path="/settings" component={SettingsPage} />
          <Route path="/maintenance" component={MaintenancePage} />
          <Route path="/finance" component={() => <Redirect to="/finance/register" />} />
          <Route path="/finance/register" component={RegisterPage} />
          <Route path="/finance/reconcile" component={ReconcilePage} />
          <Route path="/finance/cash-flow" component={CashFlowPage} />
          <Route path="/finance/recurring" component={RecurringPage} />
          {/* Lab members reach these pages, which gate on their role in the lab
              selected in the Financial header (the server's rule) and name that
              role when a screen is not available to them. */}
          <Route path="/finance/receive-payments">
            {() => <LabFinanceRoute><ReceivePaymentsPage /></LabFinanceRoute>}
          </Route>
          <Route path="/finance/make-deposits">
            {() => <LabFinanceRoute><MakeDepositsPage /></LabFinanceRoute>}
          </Route>
          <Route path="/finance/payees" component={PayeesPage} />
          <Route path="/finance/bills" component={BillsGuard} />
          <Route path="/finance/pay-bills" component={PayBillsGuard} />
          <Route path="/finance/aging">
            {() => <LabFinanceRoute><AgingPage /></LabFinanceRoute>}
          </Route>
          <Route path="/lists" component={ListsPage} />
          <Route path="/customer-center" component={() => <Redirect to="/accounts" />} />
          <Route path="/download" component={DownloadPage} />
          <Route path="/billing" component={BillingPage} />
          <Route path="/creator" component={CreatorPage} />
          <Route path="/admin/subscriptions" component={CreatorPage} />
          <Route path="/admin/provider-subscriptions" component={CreatorPage} />
          <Route path="/owner">{() => <CreatorGate><OwnerPage /></CreatorGate>}</Route>
          <Route path="/messages" component={MessagesPage} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </AppLayout>
  );
}

// The API is the real gate on every AP route; these guards only keep the
// navigation honest for members who would be refused anyway.
function BillsGuard() {
  const { user } = useAuth();
  if (!canReceivePayments(user)) return <Redirect to="/finance/register" />;
  return <BillsPage />;
}

function PayBillsGuard() {
  const { user } = useAuth();
  if (!canReceivePayments(user)) return <Redirect to="/finance/register" />;
  return <PayBillsPage />;
}

function AuthRestoreBanner() {
  const { restoreStatus } = useAuth();
  const notice = describeAuthRestoreStatus(restoreStatus);
  if (!notice || notice.kind !== "banner") return null;
  return (
    <div
      role="status"
      data-testid="auth-restore-banner"
      className="w-full bg-amber-100 text-amber-900 border-b border-amber-200 px-4 py-2 text-xs"
    >
      {notice.message}
    </div>
  );
}

function readInviteToken(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const legacy = params.get("invite");
    if (legacy && legacy.trim()) return legacy.trim();
    const tokenParam = params.get("token");
    if (tokenParam && tokenParam.trim()) return tokenParam.trim();
    return null;
  } catch {
    return null;
  }
}

function readResetToken(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (token && token.trim()) return token.trim();
    return null;
  } catch {
    return null;
  }
}

function readUsernameRecoveryToken(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("username_token");
    if (token && token.trim()) return token.trim();
    return null;
  } catch {
    return null;
  }
}

function ProviderPortal() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      }
    >
      <ProviderCasesPage />
    </Suspense>
  );
}

function Gate() {
  const { status, user } = useAuth();
  const lastUserId = useRef<string | number | null | undefined>(user?.id);
  useEffect(() => {
    if (lastUserId.current === user?.id) return;
    lastUserId.current = user?.id;
    // Logout or account switch: drop every Creator capability/data cache.
    queryClient.removeQueries({
      predicate: (q) => {
        const k = String(q.queryKey[0]);
        return k === "creator" || k.startsWith("admin-subscription");
      },
    });
  }, [user?.id]);
  const [inviteToken, setInviteToken] = useState<string | null>(() =>
    readInviteToken(),
  );
  const [resetToken] = useState<string | null>(() => readResetToken());
  const [usernameRecoveryToken] = useState<string | null>(() =>
    readUsernameRecoveryToken(),
  );

  if (usernameRecoveryToken) {
    return (
      <>
        <OfflineBanner />
        <Suspense
          fallback={
            <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
              Loading…
            </div>
          }
        >
          <ViewUsernamePage token={usernameRecoveryToken} />
        </Suspense>
      </>
    );
  }

  if (resetToken) {
    return (
      <>
        <OfflineBanner />
        <Suspense
          fallback={
            <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
              Loading…
            </div>
          }
        >
          <ResetPasswordPage
            token={resetToken}
          />
        </Suspense>
      </>
    );
  }

  if (inviteToken) {
    return (
      <>
        <OfflineBanner />
        <Suspense
          fallback={
            <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
              Loading…
            </div>
          }
        >
          <AcceptInvitePage
            token={inviteToken}
            onDone={() => {
              try {
                const url = new URL(window.location.href);
                url.searchParams.delete("invite");
                url.searchParams.delete("token");
                const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
                if (url.pathname === `${base}/accept-invite`) {
                  url.pathname = `${base}/`;
                }
                window.history.replaceState({}, "", url.toString());
              } catch {
                /* ignore */
              }
              setInviteToken(null);
            }}
          />
        </Suspense>
      </>
    );
  }

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (status === "anonymous") {
    return (
      <>
        <OfflineBanner />
        <AuthRestoreBanner />
        <LoginPage />
      </>
    );
  }
  if (user?.userType === "provider") {
    return (
      <>
        <OfflineBanner />
        <AuthRestoreBanner />
        <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
          <Switch>
            <Route path="/creator" component={CreatorPage} />
            <Route path="/owner"><CreatorGate><OwnerPage /></CreatorGate></Route>
            <Route path="/settings/subscriptions"><Redirect to="/creator?tab=subscriptions" /></Route>
            <Route path="/admin/subscriptions"><Redirect to="/creator?tab=subscriptions" /></Route>
            <Route><ProviderPortal /></Route>
          </Switch>
        </Suspense>
        <PlanPickerOnboarding />
      </>
    );
  }
  return (
    <>
      <OfflineBanner />
      <AuthRestoreBanner />
      <AuthedRoutes />
      <PlanPickerOnboarding />
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <WouterRouter
          base={import.meta.env.BASE_URL === "./" ? "" : import.meta.env.BASE_URL.replace(/\/$/, "")}
          aroundNav={(navigate, to, options) => {
            // Let an active navigation guard (e.g. a dirty invoice editor)
            // intercept and defer the navigation; otherwise proceed normally.
            if (guardNavigation(() => navigate(to, options))) return;
            navigate(to, options);
          }}
        >
          <Gate />
        </WouterRouter>
      </AuthProvider>
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;
