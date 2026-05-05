import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import LoginPage from "@/pages/login";
import DashboardPage from "@/pages/dashboard";
import CasesPage from "@/pages/cases";
import InvoicesPage from "@/pages/invoices";
import ComingSoonPage from "@/pages/coming-soon";
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
    <AppLayout>
      <Switch>
        <Route path="/" component={DashboardPage} />
        <Route path="/cases" component={CasesPage} />
        <Route path="/invoices" component={InvoicesPage} />
        <Route path="/doctors">
          <ComingSoonPage
            title="Doctors"
            description="Doctor directory and per-doctor billing live here. Coming soon to the desktop view."
          />
        </Route>
        <Route path="/practices">
          <ComingSoonPage
            title="Practices"
            description="Manage practice groups and provider organizations from the desktop view. Coming soon."
          />
        </Route>
        <Route path="/statements">
          <ComingSoonPage
            title="Statements"
            description="Combined practice and group statements are on the way."
          />
        </Route>
        <Route path="/pricing">
          <ComingSoonPage
            title="Pricing"
            description="Tier and per-doctor pricing controls coming soon to the desktop."
          />
        </Route>
        <Route path="/reports">
          <ComingSoonPage
            title="Reports"
            description="Production, revenue, and turnaround reports are coming soon."
          />
        </Route>
        <Route path="/settings">
          <ComingSoonPage
            title="Admin Settings"
            description="Workspace administration is being built for the desktop view."
          />
        </Route>
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
