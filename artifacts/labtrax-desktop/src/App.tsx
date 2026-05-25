import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  setBaseUrl as setApiClientBaseUrl,
  setAuthTokenGetter as setApiClientAuthTokenGetter,
} from "@workspace/api-client-react";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { getApiOrigin, getAccessToken } from "@/lib/api";
import { describeAuthRestoreStatus } from "@/lib/auth-restore-status";
import { UploadsProvider } from "@/lib/uploads-context";
import LoginPage from "@/pages/login";
import DashboardPage from "@/pages/dashboard";
import CasesPage from "@/pages/cases";
import InvoicesPage from "@/pages/invoices";
import AccountsPage from "@/pages/accounts";
import StatementsPage from "@/pages/statements";
import PricingPage from "@/pages/pricing";
import ReportsPage from "@/pages/reports";
import SettingsPage from "@/pages/settings";
import MaintenancePage from "@/pages/maintenance";
import RegisterPage from "@/pages/finance/register";
import ReconcilePage from "@/pages/finance/reconcile";
import CashFlowPage from "@/pages/finance/cash-flow";
import RecurringPage from "@/pages/finance/recurring";
import ReceivePaymentsPage from "@/pages/finance/receive-payments";
import PayeesPage from "@/pages/finance/payees";
import ListsPage from "@/pages/lists";
import { canReceivePayments } from "@/components/finance/FinanceShell";
import DownloadPage from "@/pages/download";
import BillingPage from "@/pages/billing";
import CustomerCenterPage from "@/pages/customer-center";
import NotFound from "@/pages/not-found";
import { AppLayout } from "@/components/AppLayout";
import { OfflineBanner } from "@/components/OfflineBanner";

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
        <Route path="/finance/payees" component={PayeesPage} />
        <Route path="/lists" component={ListsPage} />
        <Route path="/customer-center" component={CustomerCenterPage} />
        <Route path="/download" component={DownloadPage} />
        <Route path="/billing" component={BillingPage} />
        <Route component={NotFound} />
      </Switch>
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

function Gate() {
  const { status } = useAuth();
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
  return (
    <>
      <OfflineBanner />
      <AuthRestoreBanner />
      <AuthedRoutes />
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Gate />
        </WouterRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
