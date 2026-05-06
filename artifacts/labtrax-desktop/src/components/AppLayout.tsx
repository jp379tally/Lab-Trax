import { useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  Bell,
  CheckCircle,
  ChevronDown,
  CreditCard,
  FileBarChart2,
  FileText,
  LayoutDashboard,
  Loader2,
  LogOut,
  Receipt,
  Search,
  Settings,
  Stethoscope,
  Tag,
  Upload,
  Users,
  Wallet,
  Wrench,
  XCircle,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useUploads } from "@/lib/uploads-context";
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
  const [uploadsOpen, setUploadsOpen] = useState(false);
  const { entries, activeCount, removeEntry, cancelEntry } = useUploads();
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
