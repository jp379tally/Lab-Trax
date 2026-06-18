import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
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
import { MessengerProvider } from "@/context/MessengerContext";
import { canReceivePayments } from "@/components/finance/FinanceShell";
import PlanPickerOnboarding from "@/components/PlanPickerOnboarding";

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
const ListsPage = lazy(() => import("@/pages/lists"));
const DownloadPage = lazy(() => import("@/pages/download"));
const BillingPage = lazy(() => import("@/pages/billing"));
const CustomerCenterPage = lazy(() => import("@/pages/customer-center"));
const NotFound = lazy(() => import("@/pages/not-found"));
const AcceptInvitePage = lazy(() => import("@/pages/accept-invite"));

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
      <MessengerProvider>
        <AppLayoutWithUploads />
      </MessengerProvider>
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
          <Route path="/settings" component={SettingsPage} />
          <Route path="/maintenance" component={MaintenancePage} />
          <Route path="/finance" component={() => <Redirect to="/finance/register" />} />
          <Route path="/finance/register" component={RegisterPage} />
          <Route path="/finance/reconcile" component={ReconcilePage} />
          <Route path="/finance/cash-flow" component={CashFlowPage} />
          <Route path="/finance/recurring" component={RecurringPage} />
          <Route path="/finance/receive-payments" component={ReceivePaymentsGuard} />
          <Route path="/finance/make-deposits" component={MakeDepositsPage} />
          <Route path="/finance/payees" component={PayeesPage} />
          <Route path="/lists" component={ListsPage} />
          <Route path="/customer-center" component={CustomerCenterPage} />
          <Route path="/download" component={DownloadPage} />
          <Route path="/billing" component={BillingPage} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </AppLayout>
  );
}

function ReceivePaymentsGuard() {
  const { user } = useAuth();
  if (!canReceivePayments(user)) {
    return <Redirect to="/finance/register" />;
  }
  return <ReceivePaymentsPage />;
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
    const t = new URLSearchParams(window.location.search).get("invite");
    return t && t.trim() ? t.trim() : null;
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
  const [inviteToken, setInviteToken] = useState<string | null>(() =>
    readInviteToken(),
  );

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
        <ProviderPortal />
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
    </QueryClientProvider>
  );
}

export default App;
