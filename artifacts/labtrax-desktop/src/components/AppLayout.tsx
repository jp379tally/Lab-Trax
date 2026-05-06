import { useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  Bell,
  ChevronDown,
  CreditCard,
  FileBarChart2,
  FileText,
  LayoutDashboard,
  LogOut,
  Receipt,
  Search,
  Settings,
  Stethoscope,
  Tag,
  Users,
  Wallet,
  Wrench,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { Logo } from "./Logo";

interface NavItem {
  label: string;
  path: string;
  icon: typeof LayoutDashboard;
  badge?: string;
}

const NAV: NavItem[] = [
  { label: "Dashboard", path: "/", icon: LayoutDashboard },
  { label: "Cases", path: "/cases", icon: FileText },
  { label: "Doctors", path: "/doctors", icon: Stethoscope },
  { label: "Practices", path: "/practices", icon: Users },
  { label: "Invoices", path: "/invoices", icon: Receipt },
  { label: "Financial", path: "/finance", icon: Wallet },
  { label: "Statements", path: "/statements", icon: CreditCard },
  { label: "Pricing", path: "/pricing", icon: Tag },
  { label: "Reports", path: "/reports", icon: FileBarChart2 },
];

const SECONDARY: NavItem[] = [
  { label: "Admin Settings", path: "/settings", icon: Settings },
];

interface Props {
  children: ReactNode;
}

export function AppLayout({ children }: Props) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  const initials = useMemo(() => {
    if (user?.initials) return user.initials.slice(0, 2).toUpperCase();
    const first = user?.firstName?.[0] || user?.username?.[0] || "?";
    const last = user?.lastName?.[0] || "";
    return (first + last).toUpperCase();
  }, [user]);

  const fullName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
    user?.username ||
    "Guest";

  const role = user?.role === "admin" ? "Admin" : user?.role === "user" ? "User" : "Member";

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      {/* Sidebar */}
      <aside className="w-[240px] shrink-0 bg-sidebar text-sidebar-foreground flex flex-col border-r border-sidebar-border">
        <div className="px-5 py-4 border-b border-sidebar-border">
          <Logo size={34} variant="dark" />
        </div>
        <nav className="flex-1 overflow-y-auto py-3 px-3 scrollbar-thin">
          <div className="text-[10px] uppercase tracking-[0.2em] text-sidebar-foreground/45 px-3 py-2">
            Workspace
          </div>
          <ul className="space-y-0.5">
            {NAV.map((item) => {
              const active =
                item.path === "/"
                  ? location === "/" || location === ""
                  : location.startsWith(item.path);
              const Icon = item.icon;
              return (
                <li key={item.path}>
                  <Link
                    href={item.path}
                    className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                      active
                        ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
                        : "text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                    }`}
                  >
                    <Icon size={16} strokeWidth={2.2} />
                    <span className="flex-1">{item.label}</span>
                    {item.badge && (
                      <span className="text-[10px] bg-sidebar-accent text-sidebar-accent-foreground px-1.5 py-0.5 rounded-full">
                        {item.badge}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>

          <div className="text-[10px] uppercase tracking-[0.2em] text-sidebar-foreground/45 px-3 pt-6 pb-2">
            System
          </div>
          <ul className="space-y-0.5">
            {SECONDARY.map((item) => {
              const active = location.startsWith(item.path);
              const Icon = item.icon;
              return (
                <li key={item.path}>
                  <Link
                    href={item.path}
                    className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                      active
                        ? "bg-sidebar-primary text-sidebar-primary-foreground"
                        : "text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                    }`}
                  >
                    <Icon size={16} strokeWidth={2.2} />
                    <span>{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="px-3 pb-3">
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
        <header className="h-[60px] shrink-0 border-b border-border bg-card flex items-center gap-4 px-6">
          <div className="flex-1 max-w-xl relative">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              placeholder="Search cases, invoices, doctors…"
              className="w-full h-9 pl-9 pr-3 rounded-md bg-secondary text-sm placeholder:text-muted-foreground/70 border border-transparent focus:bg-card focus:border-border focus:outline-none"
            />
          </div>
          <button
            type="button"
            className="relative h-9 w-9 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground"
            aria-label="Notifications"
          >
            <Bell size={17} />
            <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-destructive" />
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="flex items-center gap-2.5 pl-1.5 pr-2 py-1.5 rounded-md hover:bg-secondary"
            >
              <div className="h-8 w-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-semibold">
                {initials}
              </div>
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
        <main className="flex-1 overflow-y-auto scrollbar-thin">{children}</main>
      </div>
    </div>
  );
}
