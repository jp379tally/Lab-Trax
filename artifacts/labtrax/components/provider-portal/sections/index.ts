// The provider portal's navigable sections.
//
// Order and labels mirror the desktop ProviderPortalLayout sidebar exactly:
// Dashboard, My Account, View and Pay My Bill, Message My Lab, Stats. Each
// section renders its own screen module so the follow-on per-section tasks can
// fill them in without touching the shell. `settings` is not a tab — like
// desktop's gear it is a sixth destination reached from the header.
export type ProviderPortalSection =
  | "dashboard"
  | "account"
  | "billing"
  | "messages"
  | "stats"
  | "settings";

export interface ProviderPortalNavItem {
  key: ProviderPortalSection;
  label: string;
  icon: "grid-outline" | "person-outline" | "card-outline" | "chatbubbles-outline" | "stats-chart-outline";
  activeIcon: "grid" | "person" | "card" | "chatbubbles" | "stats-chart";
}

export const PROVIDER_PORTAL_NAV: ProviderPortalNavItem[] = [
  { key: "dashboard", label: "Dashboard", icon: "grid-outline", activeIcon: "grid" },
  { key: "account", label: "My Account", icon: "person-outline", activeIcon: "person" },
  { key: "billing", label: "View and Pay My Bill", icon: "card-outline", activeIcon: "card" },
  { key: "messages", label: "Message My Lab", icon: "chatbubbles-outline", activeIcon: "chatbubbles" },
  { key: "stats", label: "Stats", icon: "stats-chart-outline", activeIcon: "stats-chart" },
];

export { ProviderDashboardSection } from "./ProviderDashboardSection";
export { ProviderAccountSection } from "./ProviderAccountSection";
export { ProviderBillingSection } from "./ProviderBillingSection";
export { ProviderMessagesSection } from "./ProviderMessagesSection";
export { ProviderStatsSection } from "./ProviderStatsSection";
export { ProviderSettingsSection } from "./ProviderSettingsSection";
