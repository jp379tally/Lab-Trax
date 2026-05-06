import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { UploadsProvider } from "@/lib/uploads-context";
import LoginPage from "@/pages/login";
import DashboardPage from "@/pages/dashboard";
import CasesPage from "@/pages/cases";
import InvoicesPage from "@/pages/invoices";
import DoctorsPage from "@/pages/doctors";
import PracticesPage from "@/pages/practices";
import StatementsPage from "@/pages/statements";
import PricingPage from "@/pages/pricing";
import ReportsPage from "@/pages/reports";
import SettingsPage from "@/pages/settings";
import MaintenancePage from "@/pages/maintenance";
import RegisterPage from "@/pages/finance/register";
import ReconcilePage from "@/pages/finance/reconcile";
import CashFlowPage from "@/pages/finance/cash-flow";
import RecurringPage from "@/pages/finance/recurring";
import NotFound from "@/pages/not-found";
import { AppLayout } from "@/components/AppLayout";

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
        <Route path="/doctors" component={DoctorsPage} />
        <Route path="/practices" component={PracticesPage} />
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
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
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
  if (status === "anonymous") return <LoginPage />;
  return <AuthedRoutes />;
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
