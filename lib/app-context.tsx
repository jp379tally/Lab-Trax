import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  useRef,
  ReactNode,
} from "react";
import { Alert } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getApiUrl, resilientFetch } from "./query-client";
import {
  UserRole,
  LabCase,
  Notification,
  CaseStatus,
  ActivityEntry,
  Client,
  LabUser,
  Invoice,
  ShippingAccount,
  ChatMessage,
  Conversation,
  ToothEntry,
  ToothType,
  CaseTypeValue,
  MATERIAL_PRICES,
  generateId,
  getStationInfo,
  formatAcctNum,
  formatInvNum,
  CourtesyTextRequest,
  CourtesyTextResponse,
  InventoryItem,
  PricingTier,
  DEFAULT_PRICING_TIERS,
  GroupJoinRequest,
  LabInvitation,
  DeletedClientInvoice,
} from "./data";
import { useAuth } from "./auth-context";

interface AppContextValue {
  role: UserRole;
  setRole: (r: UserRole) => void;
  adminUnlocked: boolean;
  setAdminUnlocked: (v: boolean) => void;
  cases: LabCase[];
  addCase: (c: Omit<LabCase, "id" | "createdAt" | "updatedAt" | "routeHistory">) => LabCase;
  updateCaseStatus: (caseId: string, newStatus: CaseStatus, user?: string) => void;
  addCasePhoto: (caseId: string, photoUri: string, user?: string) => void;
  addCaseNote: (caseId: string, note: string, user?: string) => void;
  addTrackingNumber: (caseId: string, tracking: string) => void;
  addCaseItem: (caseId: string, caseType: CaseTypeValue, selectedTeeth: number[], toothTypes: Record<number, ToothType>, material: string, extras?: { subType?: string; gingivaShade?: string; customNotes?: string; applianceSubType?: string; nightGuardType?: string }) => void;
  notifications: Notification[];
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  removeNotification: (id: string) => void;
  unreadCount: number;
  activeCaseCount: number;
  rushCaseCount: number;
  isLoading: boolean;
  clients: Client[];
  addClient: (c: Omit<Client, "id" | "clientNumber" | "createdAt" | "accountNumber">) => void;
  updateClient: (id: string, c: Partial<Client>) => void;
  pricingTiers: PricingTier[];
  updateTierPricing: (tierId: string, prices: Record<string, number>) => void;
  addPricingTier: (name: string) => void;
  users: LabUser[];
  addUser: (u: Omit<LabUser, "id" | "createdAt">) => void;
  updateUser: (id: string, u: Partial<LabUser>) => void;
  removeUser: (id: string) => void;
  invoices: Invoice[];
  addInvoice: (inv: Omit<Invoice, "id">) => void;
  updateInvoice: (id: string, inv: Partial<Invoice>) => void;
  shippingAccounts: ShippingAccount[];
  addShippingAccount: (companyName: string, accountNumber: string) => void;
  removeShippingAccount: (id: string) => void;
  conversations: Conversation[];
  chatMessages: ChatMessage[];
  sendChatMessage: (conversationId: string, content: string, imageUri?: string) => void;
  markConversationRead: (conversationId: string) => void;
  totalUnreadMessages: number;
  updateCase: (caseId: string, updates: Partial<LabCase>) => void;
  removeCase: (caseId: string) => void;
  removeInvoice: (invoiceId: string) => void;
  attachCaseToInvoice: (caseId: string, invoiceId: string) => void;
  sendCourtesyText: (caseId: string, message: string, sentBy: string) => void;
  respondToCourtesyText: (caseId: string, courtesyTextId: string, wantsUpdatedDate: boolean, respondedBy: string) => void;
  proposeDeliveryDate: (caseId: string, courtesyTextId: string, proposedDate: string, proposedTime: string, proposedBy: string) => void;
  respondToProposedDate: (caseId: string, courtesyTextId: string, accept: boolean, respondedBy: string, note?: string) => void;
  inventory: InventoryItem[];
  addInventoryItem: (item: Omit<InventoryItem, "id">) => void;
  updateInventoryItem: (id: string, updates: Partial<InventoryItem>) => void;
  removeInventoryItem: (id: string) => void;
  assignBarcodeToCase: (caseId: string, barcode: string) => void;
  unassignBarcode: (caseId: string) => void;
  findCaseByBarcode: (barcode: string) => LabCase | undefined;
  findAllCasesByBarcode: (barcode: string) => LabCase[];
  batchLocateCases: (caseIds: string[], newStatus: CaseStatus) => void;
  groupJoinRequests: GroupJoinRequest[];
  sendGroupJoinRequest: (targetAdminUsername: string, requestingUsername: string, message?: string) => { success: boolean; error?: string };
  respondToGroupJoinRequest: (requestId: string, accept: boolean, role?: "admin" | "user") => Promise<void>;
  labInvitations: LabInvitation[];
  sendLabInvite: (targetUsername: string, targetEmail: string, role: "admin" | "user") => { success: boolean; error?: string };
  respondToLabInvite: (inviteId: string, accept: boolean) => Promise<void>;
  refreshJoinData: () => Promise<void>;
  addConversation: (conv: Conversation) => void;
  removeConversation: (conversationId: string) => void;
  addNotification: (notif: Omit<Notification, "id" | "read" | "timestamp">) => void;
  customStationLabels: Record<string, string>;
  updateStationLabel: (stationId: CaseStatus, label: string) => void;
  userIsAffiliated: boolean;
  leaveLab: () => Promise<{ success: boolean; error?: string }>;
  deleteLab: () => Promise<{ success: boolean; error?: string; recoverableUntil?: string }>;
  restoreLab: (labId: string) => Promise<{ success: boolean; error?: string }>;
  getDeletedLabs: () => Promise<{ id: string; name: string; deletedAt: string; recoverableUntil: string; role: string }[]>;
  createLabFromSettings: (name: string, displayName?: string, phone?: string, addressLine1?: string, city?: string, state?: string, zip?: string) => Promise<{ success: boolean; error?: string }>;
  isLabCreator: boolean;
  removeClient: (clientId: string) => void;
  deactivateClient: (clientId: string) => void;
  reactivateClient: (clientId: string) => void;
  deletedClientInvoices: DeletedClientInvoice[];
  inactiveClients: Client[];
  refreshCases: (force?: boolean) => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

const CASES_KEY = "@drivesync_cases";
const ROLE_KEY = "@drivesync_role";
const NOTIFS_KEY = "@drivesync_notifs";
const CLIENTS_KEY = "@drivesync_clients";
const USERS_KEY = "@drivesync_users";
const INVOICES_KEY = "@drivesync_invoices";
const SHIPPING_KEY = "@drivesync_shipping";
const CONVERSATIONS_KEY = "@drivesync_conversations";
const CHAT_MESSAGES_KEY = "@drivesync_chat_messages";
const PRICING_TIERS_KEY = "@drivesync_pricing_tiers";
const GROUP_JOIN_REQUESTS_KEY = "@drivesync_group_join_requests";
const LAB_INVITATIONS_KEY = "@drivesync_lab_invitations";
const BARCODE_ASSIGNMENTS_KEY = "@drivesync_barcode_assignments";
const STATION_LABELS_KEY = "@drivesync_station_labels";
const DELETED_CLIENT_INVOICES_KEY = "@drivesync_deleted_client_invoices";

export function AppProvider({ children }: { children: ReactNode }) {
  const { currentUserId, currentUser, userType, registeredUsers, refreshUsers } = useAuth();
  const [role, setRoleState] = useState<UserRole>("user");
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [allCases, setAllCases] = useState<LabCase[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [users, setUsers] = useState<LabUser[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [shippingAccounts, setShippingAccounts] = useState<ShippingAccount[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [pricingTiers, setPricingTiers] = useState<PricingTier[]>(DEFAULT_PRICING_TIERS);
  const [groupJoinRequests, setGroupJoinRequests] = useState<GroupJoinRequest[]>([]);
  const [labInvitations, setLabInvitations] = useState<LabInvitation[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [customStationLabels, setCustomStationLabels] = useState<Record<string, string>>({});
  const [deletedClientInvoices, setDeletedClientInvoices] = useState<DeletedClientInvoice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [serverOrgId, setServerOrgId] = useState<string | null>(null);
  const [serverMemberIds, setServerMemberIds] = useState<Set<string>>(new Set());

  const currentUserProfile = useMemo(() => {
    if (!currentUser) return null;
    return registeredUsers.find(u => u.username?.toLowerCase() === currentUser.toLowerCase()) || null;
  }, [currentUser, registeredUsers]);

  const userIsAffiliated = useMemo(() => {
    if (!currentUserProfile) return false;
    return !!currentUserProfile.practiceName;
  }, [currentUserProfile]);

  const labMemberIds = useMemo(() => {
    if (!currentUser || !currentUserId) return new Set<string>();
    // Prefer server-confirmed membership over fragile practiceName matching
    if (serverMemberIds.size > 0) {
      const ids = new Set(serverMemberIds);
      ids.add(currentUserId);
      return ids;
    }
    // Fallback: practiceName string match (used before first server sync)
    const ids = new Set<string>();
    ids.add(currentUserId);
    const myLabName = currentUserProfile?.practiceName?.toLowerCase()?.trim();
    if (myLabName) {
      for (const u of registeredUsers) {
        if (u.id && u.practiceName?.toLowerCase()?.trim() === myLabName) {
          ids.add(u.id);
        }
      }
    }
    return ids;
  }, [currentUser, currentUserId, currentUserProfile, registeredUsers, serverMemberIds]);

  const cases = useMemo(() => {
    if (!currentUserId) return [];
    // When org is confirmed by server, show all cases — org-based server fetch guarantees
    // they belong to this lab, and departed members' cases stay visible to the lab
    if (serverOrgId) return allCases;
    // Fallback: filter by server-confirmed (or practiceName-matched) member IDs
    return allCases.filter((c) => c.ownerId && labMemberIds.has(c.ownerId));
  }, [allCases, currentUserId, labMemberIds, serverOrgId]);

  function setCases(updater: LabCase[] | ((prev: LabCase[]) => LabCase[])) {
    setAllCases(updater);
  }

  async function syncCaseToServer(labCase: LabCase) {
    try {
      await resilientFetch("/api/legacy/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: labCase.id,
          ownerId: labCase.ownerId || currentUserId,
          organizationId: labCase.labKey || undefined,
          caseData: JSON.stringify(labCase),
        }),
      });
    } catch (e) {
      console.log("Could not sync case to server:", e);
    }
  }

  async function deleteCaseFromServer(caseId: string) {
    try {
      await resilientFetch(`/api/legacy/cases/${caseId}`, { method: "DELETE" });
    } catch (e) {
      console.log("Could not delete case from server:", e);
    }
  }

  async function fetchCasesFromServer(ownerIds: string[], orgId?: string | null): Promise<LabCase[]> {
    try {
      const effectiveOrgId = orgId ?? serverOrgId;
      let url: string;
      if (effectiveOrgId) {
        url = `/api/legacy/cases?organizationId=${encodeURIComponent(effectiveOrgId)}`;
      } else if (ownerIds.length > 0) {
        url = `/api/legacy/cases?ownerIds=${ownerIds.join(",")}`;
      } else {
        return [];
      }
      const res = await resilientFetch(url);
      if (res.ok) {
        const data = await res.json();
        return data.cases || [];
      }
    } catch (e) {
      console.log("Could not fetch cases from server:", e);
    }
    return [];
  }

  useEffect(() => {
    loadData();
  }, [currentUserId]);

  useEffect(() => {
    if (!currentUserId) return;
    const interval = setInterval(() => {
      refreshUsers();
    }, 30000);
    return () => clearInterval(interval);
  }, [currentUserId]);

  const prevCasesRef = useRef<LabCase[]>([]);
  const syncReadyRef = useRef(false);
  const fetchingRef = useRef(false);

  async function refreshCases(force = false) {
    if (!force && fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      // Refresh org membership first, using the fresh orgId for case fetch
      await refreshUsers();
      const membershipResult = await fetchServerOrgMembership();
      // null means network error → keep current serverOrgId; {orgId: null} means not in a lab
      const freshOrgId = membershipResult === null ? serverOrgId : membershipResult.orgId;
      const ownerIds = Array.from(labMemberIds);
      const serverCases = await fetchCasesFromServer(ownerIds, freshOrgId);
      mergeServerCases(serverCases);
    } catch (e) {
      console.log("Could not refresh cases:", e);
    } finally {
      fetchingRef.current = false;
    }
  }

  function mergeServerCases(serverCases: LabCase[]) {
    if (serverCases.length === 0) return;
    setAllCases(prev => {
      const localMap = new Map(prev.map(c => [c.id, c]));
      let changed = false;
      for (const sc of serverCases) {
        const local = localMap.get(sc.id);
        if (!local) {
          localMap.set(sc.id, sc);
          changed = true;
        } else if (sc.updatedAt && local.updatedAt && sc.updatedAt > local.updatedAt) {
          localMap.set(sc.id, sc);
          changed = true;
        }
      }
      if (!changed) return prev;
      const merged = Array.from(localMap.values());
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(merged));
      prevCasesRef.current = merged;
      return merged;
    });
  }

  useEffect(() => {
    if (!currentUserId || labMemberIds.size === 0) return;
    syncReadyRef.current = false;
    fetchingRef.current = true;
    const ownerIds = Array.from(labMemberIds);
    fetchCasesFromServer(ownerIds).then(serverCases => {
      if (serverCases.length > 0) {
        mergeServerCases(serverCases);
      } else {
        prevCasesRef.current = allCases;
      }
      fetchingRef.current = false;
      syncReadyRef.current = true;
    });
  }, [currentUserId, labMemberIds]);

  useEffect(() => {
    if (!currentUserId) return;
    const ownerIds = Array.from(labMemberIds);
    const interval = setInterval(() => {
      if (fetchingRef.current) return;
      fetchingRef.current = true;
      // Use serverOrgId (captured from this effect's closure) for org-based fetch
      fetchCasesFromServer(ownerIds, serverOrgId).then(serverCases => {
        mergeServerCases(serverCases);
        fetchingRef.current = false;
      }).catch(() => { fetchingRef.current = false; });
    }, 10000);
    return () => clearInterval(interval);
  }, [currentUserId, labMemberIds, serverOrgId]);

  async function fetchServerOrgMembership() {
    try {
      const meResp = await resilientFetch("/api/auth/me");
      if (!meResp.ok) return null;
      const meData = await meResp.json();
      type ServerMembership = { organizationId: string; role: string; status: string; organization?: { type?: string; displayName?: string | null; name?: string } | null };
      const memberships: ServerMembership[] = Array.isArray(meData.memberships) ? meData.memberships : [];

      const activeLabMembership = memberships.find(
        m => m.status === "active" && m.organization?.type === "lab"
      );
      if (activeLabMembership) {
        const orgId = activeLabMembership.organizationId;
        setServerOrgId(orgId);
        // Fetch current member IDs for this org
        const membersResp = await resilientFetch(`/api/organizations/${orgId}/members`).catch(() => null);
        if (membersResp?.ok) {
          const membersData = await membersResp.json();
          const members: any[] = membersData.data || membersData.members || [];
          const memberIds = new Set<string>(members.map((m: any) => m.userId || m.id).filter(Boolean));
          if (memberIds.size > 0) setServerMemberIds(memberIds);
        }
        return { orgId, memberships };
      } else {
        setServerOrgId(null);
        setServerMemberIds(new Set());
        return { orgId: null, memberships };
      }
    } catch (e) {
      console.log("Could not fetch org membership:", e);
      return null;
    }
  }

  async function fetchServerJoinRequestsAndInvites() {
    try {
      // Fetch memberships directly from server — no fragile local-state matching
      const meResp = await resilientFetch("/api/auth/me");
      if (!meResp.ok) return;
      const meData = await meResp.json();
      type ServerMembership = { organizationId: string; role: string; status: string; organization?: { type?: string; displayName?: string | null; name?: string } | null };
      const memberships: ServerMembership[] = Array.isArray(meData.memberships) ? meData.memberships : [];

      // Update serverOrgId and serverMemberIds from the active membership
      const activeLabMembership = memberships.find(m => m.status === "active" && m.organization?.type === "lab");
      if (activeLabMembership) {
        const orgId = activeLabMembership.organizationId;
        setServerOrgId(orgId);
        resilientFetch(`/api/organizations/${orgId}/members`).then(async r => {
          if (r.ok) {
            const d = await r.json();
            const members: any[] = d.data || d.members || [];
            const ids = new Set<string>(members.map((m: any) => m.userId || m.id).filter(Boolean));
            if (ids.size > 0) setServerMemberIds(ids);
          }
        }).catch(() => {});
      } else {
        setServerOrgId(null);
        setServerMemberIds(new Set());
      }

      // Admin lab orgs: where current user is owner or admin of a lab
      const adminLabOrgIds = memberships
        .filter(m => m.status === "active" && (m.role === "owner" || m.role === "admin") && m.organization?.type === "lab")
        .map(m => m.organizationId);

      for (const orgId of adminLabOrgIds) {
        const adminMembership = memberships.find(m => m.organizationId === orgId);
        const adminLabName = adminMembership?.organization?.displayName || adminMembership?.organization?.name || "";

        // Fetch join requests and invites, tracking whether each call succeeded
        const [jrResp, invResp] = await Promise.all([
          resilientFetch(`/api/organizations/${orgId}/join-requests`).catch(() => null),
          resilientFetch(`/api/organizations/${orgId}/invites`).catch(() => null),
        ]);
        const jrOk = jrResp?.ok ?? false;
        const invOk = invResp?.ok ?? false;
        const jrData = jrOk ? await jrResp!.json().catch(() => ({ data: [] })) : { data: [] };
        const invData = invOk ? await invResp!.json().catch(() => ({ data: [] })) : { data: [] };

        // Resolve the admin username from auth state — currentUser may be stale
        // in the setInterval closure, so always derive it from registeredUsers
        const adminUsername = currentUser
          || registeredUsers.find(u => u.id === currentUserId)?.username
          || "";

        const serverJoinReqs: any[] = jrData.data || [];
        const serverJoinReqIds = new Set(serverJoinReqs.map((s: any) => s.id));
        setGroupJoinRequests(prev => {
          let changed = false;
          const updated = prev.filter(r => {
            // Only purge if the server fetch actually SUCCEEDED and confirms the
            // request is gone — never purge based on a failed/empty-error response
            if (jrOk && r.serverJoinRequestId && r.status === "pending" && !serverJoinReqIds.has(r.serverJoinRequestId)) {
              changed = true;
              return false;
            }
            return true;
          });
          const mutable = [...updated];
          for (const sjr of serverJoinReqs) {
            const existing = mutable.find(r => r.serverJoinRequestId === sjr.id);
            if (!existing) {
              const requester = registeredUsers.find(u => u.id === sjr.userId);
              mutable.push({
                id: generateId(),
                serverJoinRequestId: sjr.id,
                requestingUsername: requester?.username || sjr.userId,
                targetAdminUsername: adminUsername,
                message: sjr.message || `${requester?.username || "Someone"} would like to join your lab.`,
                status: sjr.status === "approved" ? "accepted" as const : sjr.status === "rejected" ? "declined" as const : "pending" as const,
                createdAt: sjr.createdAt ? new Date(sjr.createdAt).getTime() : Date.now(),
              });
              changed = true;
            } else {
              // Heal stale-closure entries that were added with a blank admin name
              if (adminUsername && !existing.targetAdminUsername) {
                existing.targetAdminUsername = adminUsername;
                changed = true;
              }
              if (sjr.status === "approved" && existing.status === "pending") {
                existing.status = "accepted";
                changed = true;
              } else if (sjr.status === "rejected" && existing.status === "pending") {
                existing.status = "declined";
                changed = true;
              }
            }
          }
          if (!changed) return prev;
          AsyncStorage.setItem(GROUP_JOIN_REQUESTS_KEY, JSON.stringify(mutable));
          return mutable;
        });

        const serverInvites: any[] = invData.data || [];
        if (serverInvites.length > 0) {
          setLabInvitations(prev => {
            let changed = false;
            const updated = [...prev];
            for (const si of serverInvites) {
              const existing = updated.find(inv => inv.serverInviteToken === si.id);
              if (!existing) {
                const invitee = registeredUsers.find(u => u.id === si.invitedUserId);
                updated.push({
                  id: generateId(),
                  serverInviteToken: si.id,
                  invitedUsername: invitee?.username || si.invitedUserId || "",
                  invitedEmail: invitee?.email || "",
                  adminLabName,
                  adminUsername: currentUser || "",
                  role: si.role === "admin" ? "admin" as const : "user" as const,
                  status: si.status === "accepted" ? "accepted" as const : si.status === "rejected" || si.status === "expired" || si.status === "revoked" ? "declined" as const : "pending" as const,
                  createdAt: si.createdAt ? new Date(si.createdAt).getTime() : Date.now(),
                });
                changed = true;
              } else if (si.status === "accepted" && existing.status === "pending") {
                existing.status = "accepted";
                changed = true;
              }
            }
            if (!changed) return prev;
            AsyncStorage.setItem(LAB_INVITATIONS_KEY, JSON.stringify(updated));
            return updated;
          });
        }
      }

      // Pending invites sent TO the current user (as invitee)
      const myInvitesResp = await resilientFetch("/api/organizations/my-invites").then(r => r.json()).catch(() => ({ data: [] }));
      const myInvites: any[] = myInvitesResp.data || [];
      if (myInvites.length > 0) {
        setLabInvitations(prev => {
          let changed = false;
          const updated = [...prev];
          for (const si of myInvites) {
            const existing = updated.find(inv => inv.serverInviteToken === si.id);
            if (!existing) {
              updated.push({
                id: generateId(),
                serverInviteToken: si.id,
                invitedUsername: currentUser || "",
                invitedEmail: currentUserProfile?.email || "",
                adminLabName: si.organizationName || "A Lab",
                adminUsername: si.inviterUsername || "Admin",
                role: si.role === "admin" ? "admin" as const : "user" as const,
                status: "pending" as const,
                createdAt: si.createdAt ? new Date(si.createdAt).getTime() : Date.now(),
              });
              changed = true;
            }
          }
          if (!changed) return prev;
          AsyncStorage.setItem(LAB_INVITATIONS_KEY, JSON.stringify(updated));
          return updated;
        });
      }

      // Status updates for join requests sent BY the current user (as requester)
      const myJrResp = await resilientFetch("/api/organizations/my-join-requests").then(r => r.json()).catch(() => ({ data: [] }));
      const myJoinReqs: any[] = myJrResp.data || [];
      if (myJoinReqs.length > 0) {
        setGroupJoinRequests(prev => {
          let changed = false;
          const updated = [...prev];
          for (const sjr of myJoinReqs) {
            const existing = updated.find(r => r.serverJoinRequestId === sjr.id);
            if (existing && sjr.status === "approved" && existing.status === "pending") {
              existing.status = "accepted";
              changed = true;
            } else if (existing && sjr.status === "rejected" && existing.status === "pending") {
              existing.status = "declined";
              changed = true;
            }
          }
          if (!changed) return prev;
          AsyncStorage.setItem(GROUP_JOIN_REQUESTS_KEY, JSON.stringify(updated));
          return updated;
        });
      }
    } catch (e) {
      console.log("Could not fetch join requests/invites:", e);
    }
  }

  useEffect(() => {
    if (!currentUserId) return;
    fetchServerJoinRequestsAndInvites();
    const interval = setInterval(fetchServerJoinRequestsAndInvites, 10000);
    return () => clearInterval(interval);
  }, [currentUserId]);

  useEffect(() => {
    if (!syncReadyRef.current || fetchingRef.current || !currentUserId) return;
    const prev = prevCasesRef.current;
    for (const c of allCases) {
      if (!c.ownerId) continue;
      const old = prev.find(p => p.id === c.id);
      if (!old || old.updatedAt !== c.updatedAt) {
        syncCaseToServer(c);
      }
    }
    for (const old of prev) {
      if (!allCases.find(c => c.id === old.id)) {
        deleteCaseFromServer(old.id);
      }
    }
    prevCasesRef.current = allCases;
  }, [allCases, currentUserId]);

  async function loadData() {
    try {
      const [savedCases, savedRole, savedNotifs, savedClients, savedUsers, savedInvoices, savedShipping, savedConversations, savedChatMessages, savedPricingTiers] = await Promise.all([
        AsyncStorage.getItem(CASES_KEY),
        AsyncStorage.getItem(ROLE_KEY),
        AsyncStorage.getItem(NOTIFS_KEY),
        AsyncStorage.getItem(CLIENTS_KEY),
        AsyncStorage.getItem(USERS_KEY),
        AsyncStorage.getItem(INVOICES_KEY),
        AsyncStorage.getItem(SHIPPING_KEY),
        AsyncStorage.getItem(CONVERSATIONS_KEY),
        AsyncStorage.getItem(CHAT_MESSAGES_KEY),
        AsyncStorage.getItem(PRICING_TIERS_KEY),
      ]);

      if (savedCases) {
        const parsedCases: LabCase[] = JSON.parse(savedCases);
        const cleaned = parsedCases.map((c) => {
          if (!c.activityLog || c.activityLog.length === 0) return c;
          const seen = new Set<string>();
          const deduped = c.activityLog.filter((e) => {
            if (e.type !== "barcode_assigned" && e.type !== "barcode_unassigned") return true;
            const key = `${e.type}|${e.description}|${Math.floor((e.timestamp || 0) / 60000)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          if (deduped.length !== c.activityLog.length) {
            return { ...c, activityLog: deduped };
          }
          return c;
        });
        setAllCases(cleaned);
        if (cleaned !== parsedCases) {
          AsyncStorage.setItem(CASES_KEY, JSON.stringify(cleaned));
        }
      } else {
        setAllCases([]);
      }

      if (savedRole) {
        setRoleState(savedRole as UserRole);
      }

      if (savedNotifs) {
        setNotifications(JSON.parse(savedNotifs));
      } else {
        setNotifications([]);
      }

      if (savedClients) {
        setClients(JSON.parse(savedClients));
      } else {
        setClients([]);
      }

      if (savedUsers) {
        setUsers(JSON.parse(savedUsers));
      } else {
        setUsers([]);
      }

      if (savedInvoices) {
        setInvoices(JSON.parse(savedInvoices));
      } else {
        setInvoices([]);
      }

      if (savedShipping) {
        setShippingAccounts(JSON.parse(savedShipping));
      }

      if (savedConversations) {
        setConversations(JSON.parse(savedConversations));
      } else {
        setConversations([]);
      }

      if (savedChatMessages) {
        setChatMessages(JSON.parse(savedChatMessages));
      } else {
        setChatMessages([]);
      }

      if (savedPricingTiers) {
        setPricingTiers(JSON.parse(savedPricingTiers));
      } else {
        setPricingTiers(DEFAULT_PRICING_TIERS);
        await AsyncStorage.setItem(PRICING_TIERS_KEY, JSON.stringify(DEFAULT_PRICING_TIERS));
      }

      const savedStationLabels = await AsyncStorage.getItem(STATION_LABELS_KEY);
      if (savedStationLabels) {
        setCustomStationLabels(JSON.parse(savedStationLabels));
      }

      const savedGroupJoinRequests = await AsyncStorage.getItem(GROUP_JOIN_REQUESTS_KEY);
      if (savedGroupJoinRequests) {
        setGroupJoinRequests(JSON.parse(savedGroupJoinRequests));
      }

      const savedLabInvitations = await AsyncStorage.getItem(LAB_INVITATIONS_KEY);
      if (savedLabInvitations) {
        setLabInvitations(JSON.parse(savedLabInvitations));
      }

      const savedDeletedClientInvoices = await AsyncStorage.getItem(DELETED_CLIENT_INVOICES_KEY);
      if (savedDeletedClientInvoices) {
        setDeletedClientInvoices(JSON.parse(savedDeletedClientInvoices));
      }

      const pendingClientRaw = await AsyncStorage.getItem("@drivesync_pending_client");
      if (pendingClientRaw) {
        try {
          const pc = JSON.parse(pendingClientRaw);
          const freshClients = await AsyncStorage.getItem(CLIENTS_KEY);
          const loadedClients: Client[] = freshClients ? JSON.parse(freshClients) : [];
          const alreadyExists = loadedClients.some(
            (c) => c.leadDoctor?.toLowerCase() === pc.leadDoctor?.toLowerCase() && c.practiceName?.toLowerCase() === pc.practiceName?.toLowerCase()
          );
          if (!alreadyExists) {
            const maxClientNum = loadedClients.reduce((max, c) => Math.max(max, c.clientNumber || 0), 0);
            const newClient: Client = {
              id: generateId(),
              clientNumber: maxClientNum + 1,
              accountNumber: `DS-${(maxClientNum + 1).toString().padStart(6, "0")}`,
              practiceName: pc.practiceName || "",
              leadDoctor: pc.leadDoctor || "",
              phone: pc.phone || "",
              email: pc.email || "",
              address: pc.address || "",
              tier: pc.tier || "Standard",
              discountRate: pc.discountRate || 0,
              createdAt: Date.now(),
            };
            const updatedClients = [...loadedClients, newClient];
            setClients(updatedClients);
            await AsyncStorage.setItem(CLIENTS_KEY, JSON.stringify(updatedClients));
          }
        } catch {}
        AsyncStorage.removeItem("@drivesync_pending_client");
      }
    } catch (e) {
      setAllCases([]);
      setNotifications([]);
      setClients([]);
      setUsers([]);
      setInvoices([]);
      setConversations([]);
      setChatMessages([]);
    } finally {
      setIsLoading(false);
    }
  }

  function setRole(r: UserRole) {
    setRoleState(r);
    setAdminUnlocked(false);
    AsyncStorage.setItem(ROLE_KEY, r);
  }

  function addCase(
    c: Omit<LabCase, "id" | "createdAt" | "updatedAt" | "routeHistory">,
  ): LabCase {
    const now = Date.now();
    const createdEntry: import("@/lib/data").ActivityEntry = {
      id: generateId(),
      type: "created",
      timestamp: now,
      description: "Case created and scanned in at Intake",
      station: c.status,
    };
    const caseId = generateId();
    const newCase: LabCase = {
      ...c,
      id: caseId,
      ownerId: currentUserId || undefined,
      labKey: serverOrgId || undefined,
      createdAt: now,
      updatedAt: now,
      routeHistory: [{ station: c.status, timestamp: now }],
      photos: c.photos || [],
      activityLog: [...(c.activityLog || []), createdEntry],
    };

    const clientMatch = clients.find(
      (cl) => cl.leadDoctor?.toLowerCase() === c.doctorName.toLowerCase() || cl.practiceName?.toLowerCase() === c.doctorName.toLowerCase()
    );

    const toothStr = c.toothIndices || "";
    const materialStr = c.material || "";
    const lineItems: import("@/lib/data").InvoiceLineItem[] = [];
    if (materialStr) {
      const toothCount = c.toothMap?.length || toothStr.split(",").filter(Boolean).length || 1;
      const perUnitPrice = MATERIAL_PRICES[materialStr] ?? 250;
      const totalPrice = c.price || (toothCount * perUnitPrice);
      lineItems.push({
        qty: toothCount,
        item: materialStr,
        description: `${c.caseType || "Restorative"} - ${toothStr || "N/A"}`,
        rate: perUnitPrice,
        amount: totalPrice,
      });
    }

    const invoiceNum = `INV-${c.caseNumber}`;
    const dueAt = now + 30 * 24 * 60 * 60 * 1000;

    const newInvoice: Invoice = {
      id: generateId(),
      invoiceNumber: invoiceNum,
      clientId: clientMatch?.id || "",
      clientName: clientMatch?.practiceName || c.doctorName,
      caseIds: [caseId],
      amount: c.isRemake ? 0 : (c.price || lineItems.reduce((sum, li) => sum + li.amount, 0)),
      credits: 0,
      status: "open",
      issuedAt: now,
      dueAt,
      billTo: clientMatch?.address || "",
      patientName: c.patientName,
      caseType: c.caseType || "",
      teeth: toothStr,
      shade: c.shade || "",
      caseNotes: c.notes || "",
      lineItems,
    };

    newCase.invoiceId = newInvoice.id;

    const updatedInvoices = [newInvoice, ...invoices];
    setInvoices(updatedInvoices);
    AsyncStorage.setItem(INVOICES_KEY, JSON.stringify(updatedInvoices));

    const updated = [newCase, ...allCases];
    setAllCases(updated);
    AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
    syncCaseToServer(newCase);

    const newNotif: Notification = {
      id: generateId(),
      title: "New Case Scanned",
      message: `Case ${c.caseNumber} (${c.doctorName}) has been added`,
      type: "update",
      caseId: newCase.id,
      read: false,
      timestamp: now,
    };
    const updatedNotifs = [newNotif, ...notifications];
    setNotifications(updatedNotifs);
    AsyncStorage.setItem(NOTIFS_KEY, JSON.stringify(updatedNotifs));

    return newCase;
  }

  function updateCaseStatus(caseId: string, newStatus: CaseStatus, user?: string) {
    const now = Date.now();
    const stationLabel = getStationInfo(newStatus, customStationLabels).label;
    const stationEntry: ActivityEntry = {
      id: generateId(),
      type: "station_change",
      timestamp: now,
      description: `Case moved to ${stationLabel}`,
      station: newStatus,
      user: user || undefined,
    };
    setCases((prevCases) => {
      const updated = prevCases.map((c) => {
        if (c.id === caseId) {
          const updatedCase = {
            ...c,
            status: newStatus,
            updatedAt: now,
            assignedBarcode: newStatus === "COMPLETE" ? undefined : c.assignedBarcode,
            routeHistory: [
              ...c.routeHistory,
              { station: newStatus, timestamp: now },
            ],
            activityLog: [...(c.activityLog || []), stationEntry],
          };
          syncCaseToServer(updatedCase);
          return updatedCase;
        }
        return c;
      });
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));

      const caseInfo = prevCases.find((c) => c.id === caseId);
      if (caseInfo) {
        const newNotif: Notification = {
          id: generateId(),
          title: "Station Update",
          message: `Case ${caseInfo.caseNumber} moved to ${newStatus}`,
          type: "update",
          caseId,
          read: false,
          timestamp: now,
        };
        setNotifications((prevNotifs) => {
          const updatedNotifs = [newNotif, ...prevNotifs];
          AsyncStorage.setItem(NOTIFS_KEY, JSON.stringify(updatedNotifs));
          return updatedNotifs;
        });

        if (newStatus === "INTAKE" || newStatus === "COMPLETE") {
          sendProviderCaseUpdateText(caseInfo, newStatus);
        }
      }

      return updated;
    });
  }

  async function sendProviderCaseUpdateText(caseInfo: LabCase, status: CaseStatus) {
    try {
      const usersRaw = await AsyncStorage.getItem("@drivesync_auth_users");
      if (!usersRaw) return;
      const allUsers = JSON.parse(usersRaw);
      const providerUser = allUsers.find((u: any) =>
        u.userType === "provider" &&
        u.wantsUpdates === true &&
        u.phone &&
        caseInfo.doctorName.toLowerCase().includes(u.doctorName?.toLowerCase() || u.username?.toLowerCase())
      );
      if (!providerUser) return;

      const statusLabel = status === "INTAKE" ? "received by the lab" : "completed";
      const message = `LabTrax: Hello Dr. ${providerUser.doctorName || providerUser.username}, your case ${caseInfo.caseNumber} for patient ${caseInfo.patientName} has been ${statusLabel}. Thank you for choosing LabTrax.`;

      const host = process.env.EXPO_PUBLIC_DOMAIN;
      if (!host) return;
      const apiUrl = `https://${host}`;

      await fetch(new URL("/api/send-case-update-text", apiUrl).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerName: providerUser.doctorName || providerUser.username,
          providerPhone: providerUser.phone,
          caseNumber: caseInfo.caseNumber,
          patientName: caseInfo.patientName,
          status,
          message,
        }),
      });
    } catch {}
  }

  function addCasePhoto(caseId: string, photoUri: string, user?: string) {
    const now = Date.now();
    const photoEntry: ActivityEntry = {
      id: generateId(),
      type: "photo",
      timestamp: now,
      description: "Photo added to case",
      imageUri: photoUri,
      user: user || undefined,
    };
    setCases((prevCases) => {
      const updated = prevCases.map((c) => {
        if (c.id === caseId) {
          return {
            ...c,
            updatedAt: now,
            photos: [...(c.photos || []), photoUri],
            activityLog: [...(c.activityLog || []), photoEntry],
          };
        }
        return c;
      });
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  function addCaseNote(caseId: string, note: string, user?: string) {
    const now = Date.now();
    const noteEntry: ActivityEntry = {
      id: generateId(),
      type: "note",
      timestamp: now,
      description: note,
      user: user || undefined,
    };
    setCases((prevCases) => {
      const updated = prevCases.map((c) => {
        if (c.id === caseId) {
          return {
            ...c,
            updatedAt: now,
            notes: c.notes ? `${c.notes}\n${note}` : note,
            activityLog: [...(c.activityLog || []), noteEntry],
          };
        }
        return c;
      });
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  function addTrackingNumber(caseId: string, tracking: string) {
    const now = Date.now();
    setCases((prevCases) => {
      const updated = prevCases.map((c) => {
        if (c.id === caseId) {
          const entry: ActivityEntry = {
            id: generateId(),
            type: "tracking_added",
            timestamp: now,
            description: `Tracking number added: ${tracking}`,
            user: currentUser || undefined,
          };
          return {
            ...c,
            updatedAt: now,
            trackingNumbers: [...(c.trackingNumbers || []), tracking],
            activityLog: [...(c.activityLog || []), entry],
          };
        }
        return c;
      });
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  function addCaseItem(caseId: string, caseType: CaseTypeValue, selectedTeeth: number[], toothTypesMap: Record<number, ToothType>, mat: string, extras?: { subType?: string; gingivaShade?: string; customNotes?: string; applianceSubType?: string; nightGuardType?: string }) {
    setCases((prevCases) => {
      const updated = prevCases.map((c) => {
        if (c.id === caseId) {
          const toothMapEntries: ToothEntry[] = selectedTeeth.map((num) => ({
            num,
            type: toothTypesMap[num] || "normal",
          }));
          const sorted = [...selectedTeeth].sort((a, b) => a - b);
          const parts: string[] = [];
          let i = 0;
          while (i < sorted.length) {
            const t = sorted[i];
            const tp = toothTypesMap[t] || "normal";
            if (tp === "missing") { parts.push(`X${t}`); i++; }
            else if (tp === "bridge") {
              let end = i;
              while (end + 1 < sorted.length && (toothTypesMap[sorted[end + 1]] || "normal") === "bridge") end++;
              parts.push(end > i ? `#${sorted[i]}-#${sorted[end]}` : `#${t}`);
              i = end + 1;
            } else { parts.push(`#${t}`); i++; }
          }
          const toothDisplay = parts.join(", ");
          const normalCount = selectedTeeth.filter((t) => (toothTypesMap[t] || "normal") === "normal").length;
          const hasPontic = selectedTeeth.some((t) => (toothTypesMap[t] || "normal") === "bridge");
          const billable = normalCount + (hasPontic ? 1 : 0);
          const unitPrice = MATERIAL_PRICES[mat] || 250;
          const price = unitPrice * Math.max(billable, 1);

          let descParts = [`Item added: ${caseType}`];
          if (extras?.subType) descParts.push(extras.subType);
          if (extras?.applianceSubType) descParts.push(extras.applianceSubType);
          if (extras?.nightGuardType) descParts.push(extras.nightGuardType);
          if (toothDisplay) descParts.push(toothDisplay);
          if (mat) descParts.push(`(${mat})`);
          if (extras?.gingivaShade) descParts.push(`Gingiva: ${extras.gingivaShade}`);

          const newActivity: ActivityEntry = {
            id: generateId(),
            type: "note",
            description: descParts.join(" - "),
            timestamp: Date.now(),
            user: "user",
          };

          let updatedNotes = c.notes;
          if (extras?.customNotes) {
            updatedNotes = updatedNotes ? `${updatedNotes}\n${extras.customNotes}` : extras.customNotes;
          }

          return {
            ...c,
            caseType: caseType as CaseTypeValue,
            toothIndices: toothDisplay || c.toothIndices,
            toothMap: toothMapEntries.length > 0 ? toothMapEntries : c.toothMap,
            material: mat,
            price,
            notes: updatedNotes,
            updatedAt: Date.now(),
            activityLog: [...c.activityLog, newActivity],
          };
        }
        return c;
      });
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  function updateCase(caseId: string, updates: Partial<LabCase>) {
    setCases((prevCases) => {
      const updated = prevCases.map((c) => {
        if (c.id === caseId) {
          const updatedCase = { ...c, ...updates, updatedAt: Date.now() };
          syncCaseToServer(updatedCase);
          return updatedCase;
        }
        return c;
      });
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  function removeCase(caseId: string) {
    setCases((prev) => {
      const updated = prev.filter((c) => c.id !== caseId);
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
      return updated;
    });
    deleteCaseFromServer(caseId);
  }

  function removeInvoice(invoiceId: string) {
    setInvoices((prev) => {
      const updated = prev.filter((inv) => inv.id !== invoiceId);
      AsyncStorage.setItem(INVOICES_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  function attachCaseToInvoice(caseId: string, invoiceId: string) {
    setCases((prevCases) => {
      const updated = prevCases.map((c) => {
        if (c.id === caseId) {
          const entry: ActivityEntry = {
            id: generateId(),
            type: "invoice_attached",
            timestamp: Date.now(),
            description: `Case attached to ${formatInvNum(invoiceId)}`,
            user: currentUser || undefined,
          };
          return { ...c, invoiceId, updatedAt: Date.now(), activityLog: [...(c.activityLog || []), entry] };
        }
        return c;
      });
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
      return updated;
    });
    setInvoices((prev) => {
      const updated = prev.map((inv) => {
        if (inv.id === invoiceId) {
          const caseIds = inv.caseIds.includes(caseId) ? inv.caseIds : [...inv.caseIds, caseId];
          return { ...inv, caseIds };
        }
        return inv;
      });
      AsyncStorage.setItem(INVOICES_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  function sendCourtesyText(caseId: string, message: string, sentBy: string) {
    const now = Date.now();
    const courtesyText: CourtesyTextRequest = {
      id: generateId(),
      caseId,
      message,
      sentBy,
      sentAt: now,
      status: "sent",
      wantsUpdatedDate: null,
      responseHistory: [],
    };
    const noteEntry: ActivityEntry = {
      id: generateId(),
      type: "courtesy_text",
      timestamp: now,
      description: `Courtesy text sent: "${message}"`,
      user: sentBy,
    };
    setCases((prev) => {
      const updated = prev.map((c) => {
        if (c.id === caseId) {
          return {
            ...c,
            updatedAt: now,
            courtesyTexts: [...(c.courtesyTexts || []), courtesyText],
            activityLog: [...(c.activityLog || []), noteEntry],
          };
        }
        return c;
      });
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
      return updated;
    });
    const notif: Notification = {
      id: generateId(),
      title: "Courtesy Text Sent",
      message: `A courtesy text was sent for case ${caseId.slice(0, 6)}`,
      type: "alert",
      caseId,
      read: false,
      timestamp: now,
    };
    const updNotifs = [notif, ...notifications];
    setNotifications(updNotifs);
    AsyncStorage.setItem(NOTIFS_KEY, JSON.stringify(updNotifs));
  }

  function respondToCourtesyText(caseId: string, courtesyTextId: string, wantsUpdatedDate: boolean, respondedBy: string) {
    const now = Date.now();
    const response: CourtesyTextResponse = {
      id: generateId(),
      type: "date_requested",
      by: respondedBy,
      timestamp: now,
      note: wantsUpdatedDate ? "Client requested updated delivery date" : "Client does not need updated delivery date",
    };
    const noteEntry: ActivityEntry = {
      id: generateId(),
      type: "courtesy_text",
      timestamp: now,
      description: wantsUpdatedDate
        ? `Client (${respondedBy}) requested an updated delivery date/time`
        : `Client (${respondedBy}) acknowledged delay - no updated date needed`,
      user: respondedBy,
    };
    setCases((prev) => {
      const updated = prev.map((c) => {
        if (c.id === caseId) {
          const updatedTexts = (c.courtesyTexts || []).map((ct) => {
            if (ct.id === courtesyTextId) {
              return {
                ...ct,
                status: wantsUpdatedDate ? "date_requested" as const : "accepted" as const,
                wantsUpdatedDate,
                responseHistory: [...ct.responseHistory, response],
              };
            }
            return ct;
          });
          return { ...c, updatedAt: now, courtesyTexts: updatedTexts, activityLog: [...(c.activityLog || []), noteEntry] };
        }
        return c;
      });
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
      return updated;
    });
    if (wantsUpdatedDate) {
      const notif: Notification = {
        id: generateId(),
        title: "Delivery Date Requested",
        message: `Client requested an updated delivery date for case`,
        type: "alert",
        caseId,
        read: false,
        timestamp: now,
      };
      const updNotifs = [notif, ...notifications];
      setNotifications(updNotifs);
      AsyncStorage.setItem(NOTIFS_KEY, JSON.stringify(updNotifs));
    }
  }

  function proposeDeliveryDate(caseId: string, courtesyTextId: string, proposedDate: string, proposedTime: string, proposedBy: string) {
    const now = Date.now();
    const response: CourtesyTextResponse = {
      id: generateId(),
      type: "date_proposed",
      by: proposedBy,
      timestamp: now,
      proposedDate,
      proposedTime,
    };
    const noteEntry: ActivityEntry = {
      id: generateId(),
      type: "courtesy_text",
      timestamp: now,
      description: `Lab proposed new delivery: ${proposedDate} at ${proposedTime}`,
      user: proposedBy,
    };
    setCases((prev) => {
      const updated = prev.map((c) => {
        if (c.id === caseId) {
          const updatedTexts = (c.courtesyTexts || []).map((ct) => {
            if (ct.id === courtesyTextId) {
              return {
                ...ct,
                status: "date_proposed" as const,
                proposedDate,
                proposedTime,
                responseHistory: [...ct.responseHistory, response],
              };
            }
            return ct;
          });
          return { ...c, updatedAt: now, courtesyTexts: updatedTexts, activityLog: [...(c.activityLog || []), noteEntry] };
        }
        return c;
      });
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
      return updated;
    });
    const notif: Notification = {
      id: generateId(),
      title: "New Delivery Date Proposed",
      message: `Lab proposed delivery on ${proposedDate} at ${proposedTime}`,
      type: "update",
      caseId,
      read: false,
      timestamp: now,
    };
    const updNotifs = [notif, ...notifications];
    setNotifications(updNotifs);
    AsyncStorage.setItem(NOTIFS_KEY, JSON.stringify(updNotifs));
  }

  function respondToProposedDate(caseId: string, courtesyTextId: string, accept: boolean, respondedBy: string, note?: string) {
    const now = Date.now();
    const response: CourtesyTextResponse = {
      id: generateId(),
      type: accept ? "accepted" : "declined",
      by: respondedBy,
      timestamp: now,
      note,
    };
    const noteEntry: ActivityEntry = {
      id: generateId(),
      type: "courtesy_text",
      timestamp: now,
      description: accept
        ? `Client accepted proposed delivery date`
        : `Client declined proposed delivery date${note ? `: ${note}` : ""}`,
      user: respondedBy,
    };
    setCases((prev) => {
      const updated = prev.map((c) => {
        if (c.id === caseId) {
          const updatedTexts = (c.courtesyTexts || []).map((ct) => {
            if (ct.id === courtesyTextId) {
              return {
                ...ct,
                status: accept ? "accepted" as const : "date_requested" as const,
                responseHistory: [...ct.responseHistory, response],
              };
            }
            return ct;
          });
          return { ...c, updatedAt: now, courtesyTexts: updatedTexts, activityLog: [...(c.activityLog || []), noteEntry] };
        }
        return c;
      });
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
      return updated;
    });
    const notif: Notification = {
      id: generateId(),
      title: accept ? "Delivery Date Accepted" : "Delivery Date Declined",
      message: accept
        ? `Client accepted the proposed delivery date`
        : `Client declined the proposed delivery date`,
      type: accept ? "update" : "alert",
      caseId,
      read: false,
      timestamp: now,
    };
    const updNotifs = [notif, ...notifications];
    setNotifications(updNotifs);
    AsyncStorage.setItem(NOTIFS_KEY, JSON.stringify(updNotifs));
  }

  function markNotificationRead(id: string) {
    const updated = notifications.map((n) =>
      n.id === id ? { ...n, read: true } : n,
    );
    setNotifications(updated);
    AsyncStorage.setItem(NOTIFS_KEY, JSON.stringify(updated));
  }

  function markAllNotificationsRead() {
    const hasUnread = notifications.some((n) => !n.read);
    if (!hasUnread) return;
    const updated = notifications.map((n) => ({ ...n, read: true }));
    setNotifications(updated);
    AsyncStorage.setItem(NOTIFS_KEY, JSON.stringify(updated));
  }

  function removeNotification(id: string) {
    const updated = notifications.filter((n) => n.id !== id);
    setNotifications(updated);
    AsyncStorage.setItem(NOTIFS_KEY, JSON.stringify(updated));
  }

  function addClient(c: Omit<Client, "id" | "clientNumber" | "createdAt" | "accountNumber">) {
    const maxNum = clients.reduce((max, cl) => Math.max(max, cl.clientNumber || 0), 0);
    const newClient: Client = { ...c, id: generateId(), clientNumber: maxNum + 1, accountNumber: "DS-" + Date.now().toString().slice(-6), createdAt: Date.now() };
    const updated = [newClient, ...clients];
    setClients(updated);
    AsyncStorage.setItem(CLIENTS_KEY, JSON.stringify(updated));
  }

  function updateClient(id: string, c: Partial<Client>) {
    const updated = clients.map((cl) => (cl.id === id ? { ...cl, ...c } : cl));
    setClients(updated);
    AsyncStorage.setItem(CLIENTS_KEY, JSON.stringify(updated));
  }

  function deactivateClient(clientId: string) {
    updateClient(clientId, { status: "inactive" });
  }

  function reactivateClient(clientId: string) {
    updateClient(clientId, { status: "active" });
  }

  function removeClient(clientId: string) {
    const client = clients.find(c => c.id === clientId);
    if (!client) return;
    const clientPracticeName = client.practiceName?.toLowerCase()?.trim();
    const isClientInvoice = (inv: Invoice) =>
      inv.clientId === clientId || (clientPracticeName && inv.clientName?.toLowerCase()?.trim() === clientPracticeName);
    const clientOpenInvoices = invoices.filter(
      inv => isClientInvoice(inv) && (inv.status === "open" || inv.status === "overdue")
    );
    if (clientOpenInvoices.length > 0) {
      const newDeletedInvoices: DeletedClientInvoice[] = clientOpenInvoices.map(inv => ({
        invoice: inv,
        clientName: client.practiceName,
        deletedAt: Date.now(),
      }));
      const updatedDeletedInvoices = [...deletedClientInvoices, ...newDeletedInvoices];
      setDeletedClientInvoices(updatedDeletedInvoices);
      AsyncStorage.setItem(DELETED_CLIENT_INVOICES_KEY, JSON.stringify(updatedDeletedInvoices));
      const openInvoiceIds = new Set(clientOpenInvoices.map(inv => inv.id));
      const remainingInvoices = invoices.filter(inv => !openInvoiceIds.has(inv.id));
      setInvoices(remainingInvoices);
      AsyncStorage.setItem(INVOICES_KEY, JSON.stringify(remainingInvoices));
    }
    const updatedClients = clients.filter(c => c.id !== clientId);
    setClients(updatedClients);
    AsyncStorage.setItem(CLIENTS_KEY, JSON.stringify(updatedClients));
  }

  function addUser(u: Omit<LabUser, "id" | "createdAt">) {
    const newUser: LabUser = { ...u, id: generateId(), createdAt: Date.now() };
    const updated = [newUser, ...users];
    setUsers(updated);
    AsyncStorage.setItem(USERS_KEY, JSON.stringify(updated));
  }

  function updateUser(id: string, u: Partial<LabUser>) {
    const updated = users.map((usr) => (usr.id === id ? { ...usr, ...u } : usr));
    setUsers(updated);
    AsyncStorage.setItem(USERS_KEY, JSON.stringify(updated));
  }

  function removeUser(id: string) {
    const updated = users.filter((usr) => usr.id !== id);
    setUsers(updated);
    AsyncStorage.setItem(USERS_KEY, JSON.stringify(updated));
  }

  function addInvoice(inv: Omit<Invoice, "id">) {
    const newInv: Invoice = { ...inv, id: generateId() };
    const updated = [newInv, ...invoices];
    setInvoices(updated);
    AsyncStorage.setItem(INVOICES_KEY, JSON.stringify(updated));
  }

  function updateInvoice(id: string, inv: Partial<Invoice>) {
    setInvoices((prev) => {
      const updated = prev.map((i) => (i.id === id ? { ...i, ...inv } : i));
      AsyncStorage.setItem(INVOICES_KEY, JSON.stringify(updated));

      if (inv.status === "paid") {
        const targetInvoice = prev.find(i => i.id === id);
        if (targetInvoice && targetInvoice.caseIds && targetInvoice.caseIds.length > 0) {
          const now = Date.now();
          setCases((prevCases) => {
            const alreadyLogged = prevCases.some((c) =>
              targetInvoice.caseIds.includes(c.id) &&
              (c.activityLog || []).some(e => e.type === "invoice_paid" && e.description.includes(id))
            );
            if (alreadyLogged) return prevCases;
            const updatedCases = prevCases.map((c) => {
              if (targetInvoice.caseIds.includes(c.id)) {
                const entry: ActivityEntry = {
                  id: generateId(),
                  type: "invoice_paid",
                  timestamp: now,
                  description: `${formatInvNum(targetInvoice.invoiceNumber || id)} paid — $${targetInvoice.amount.toFixed(2)}`,
                  user: currentUser || undefined,
                };
                return { ...c, updatedAt: now, activityLog: [...(c.activityLog || []), entry] };
              }
              return c;
            });
            AsyncStorage.setItem(CASES_KEY, JSON.stringify(updatedCases));
            return updatedCases;
          });
        }
      }

      return updated;
    });
  }

  function addShippingAccount(companyName: string, accountNumber: string) {
    const newAccount: ShippingAccount = {
      id: generateId(),
      companyName,
      accountNumber,
      createdAt: Date.now(),
    };
    setShippingAccounts(prev => {
      const updated = [...prev, newAccount];
      AsyncStorage.setItem(SHIPPING_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  function removeShippingAccount(id: string) {
    setShippingAccounts(prev => {
      const updated = prev.filter(a => a.id !== id);
      AsyncStorage.setItem(SHIPPING_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  function updateTierPricing(tierId: string, prices: Record<string, number>) {
    setPricingTiers(prev => {
      const updated = prev.map(t => t.id === tierId ? { ...t, prices } : t);
      AsyncStorage.setItem(PRICING_TIERS_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  function addPricingTier(name: string) {
    const newTier: PricingTier = {
      id: name.toLowerCase().replace(/\s+/g, '_') + '_' + Date.now().toString().slice(-4),
      name,
      prices: { zirconia_crown: 0, emax_crown: 0, pfm_crown: 0, denture: 0, partial: 0, implant: 0 },
    };
    setPricingTiers(prev => {
      const updated = [...prev, newTier];
      AsyncStorage.setItem(PRICING_TIERS_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  function sendChatMessage(conversationId: string, content: string, imageUri?: string) {
    const msg: ChatMessage = {
      id: generateId(),
      conversationId,
      senderId: "lab",
      senderType: "lab",
      content,
      imageUri,
      timestamp: Date.now(),
      read: true,
    };
    setChatMessages(prev => {
      const updated = [...prev, msg];
      AsyncStorage.setItem(CHAT_MESSAGES_KEY, JSON.stringify(updated));
      return updated;
    });
    setConversations(prev => {
      const updated = prev.map(c => {
        if (c.id === conversationId) {
          return { ...c, lastMessage: imageUri ? "Photo" : content, lastMessageTime: Date.now() };
        }
        return c;
      });
      AsyncStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  async function sendGroupJoinRequestAsync(targetAdminUsername: string, requestingUsername: string, message?: string): Promise<{ success: boolean; error?: string }> {
    try {
      const adminProfile = registeredUsers.find(u => u.username.toLowerCase() === targetAdminUsername.toLowerCase());
      if (!adminProfile?.practiceName) {
        return { success: false, error: "Could not find that lab admin." };
      }

      const groupsResp = await resilientFetch("/api/labs/groups");
      const groupsData = await groupsResp.json();
      const groups: Array<{ practiceName: string; organizationId: string }> = groupsData.groups || [];
      const match = groups.find(g => g.practiceName.toLowerCase().trim() === adminProfile.practiceName!.toLowerCase().trim());
      if (!match?.organizationId) {
        return { success: false, error: "Could not find this lab on the server. Please try again later." };
      }

      const resp = await resilientFetch(`/api/organizations/${match.organizationId}/join-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestedRole: "user",
          message: message || `${requestingUsername} would like to join your lab.`,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        const errMsg = data?.message || data?.error || "Failed to send join request.";
        return { success: false, error: errMsg };
      }

      if (data?.data?.id) {
        const request: GroupJoinRequest = {
          id: generateId(),
          requestingUsername,
          targetAdminUsername,
          message: message || `${requestingUsername} would like to join your lab.`,
          status: "pending",
          createdAt: Date.now(),
          serverJoinRequestId: data.data.id,
        };
        setGroupJoinRequests(prev => {
          const updated = [...prev, request];
          AsyncStorage.setItem(GROUP_JOIN_REQUESTS_KEY, JSON.stringify(updated));
          return updated;
        });
      }

      return { success: true };
    } catch (e: any) {
      console.log("sendGroupJoinRequest error:", e);
      return { success: false, error: "Network error. Please check your connection and try again." };
    }
  }

  function sendGroupJoinRequest(targetAdminUsername: string, requestingUsername: string, message?: string): { success: boolean; error?: string } {
    sendGroupJoinRequestAsync(targetAdminUsername, requestingUsername, message)
      .then(result => {
        if (!result.success && result.error) {
          Alert.alert("Unable to Send", result.error);
        } else if (result.success) {
          Alert.alert("Request Sent", "Your join request has been sent to the lab administrator.");
          fetchServerJoinRequestsAndInvites();
        }
      });
    return { success: true };
  }

  async function respondToGroupJoinRequest(requestId: string, accept: boolean, role?: "admin" | "user") {
    const request = groupJoinRequests.find(r => r.id === requestId);
    if (!request) return;

    const adminProfile = registeredUsers.find(u => u.username.toLowerCase() === request.targetAdminUsername.toLowerCase());
    const requestingUser = registeredUsers.find(u => u.username.toLowerCase() === request.requestingUsername.toLowerCase());

    const serverReqId = request.serverJoinRequestId;
    if (serverReqId) {
      try {
        const endpoint = accept
          ? `/api/organizations/join-requests/${serverReqId}/approve`
          : `/api/organizations/join-requests/${serverReqId}/reject`;
        const resp = await resilientFetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: role || "user" }),
        });
        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          Alert.alert("Error", data?.message || "Failed to update join request on server.");
          return;
        }
      } catch (e) {
        console.log("Failed to update join request on server:", e);
        Alert.alert("Error", "Network error. Please check your connection and try again.");
        return;
      }
    }

    setGroupJoinRequests(prev => {
      const updated = prev.map(r =>
        r.id === requestId ? { ...r, status: accept ? "accepted" as const : "declined" as const } : r
      );
      AsyncStorage.setItem(GROUP_JOIN_REQUESTS_KEY, JSON.stringify(updated));
      return updated;
    });

    if (accept) {
      if (requestingUser && requestingUser.userType === "provider") {
        const doctorLabel = requestingUser.doctorName
          ? (requestingUser.accountNumber ? `Dr. ${requestingUser.doctorName} ${formatAcctNum(requestingUser.accountNumber)}` : `Dr. ${requestingUser.doctorName}`)
          : `Dr. ${requestingUser.username}`;
        const alreadyClient = clients.some(c =>
          c.leadDoctor.toLowerCase() === doctorLabel.toLowerCase() ||
          (requestingUser.doctorName && c.leadDoctor.toLowerCase().includes(requestingUser.doctorName.toLowerCase())) ||
          (requestingUser.practiceName && c.practiceName.toLowerCase() === requestingUser.practiceName.toLowerCase())
        );
        if (!alreadyClient) {
          addClient({
            practiceName: requestingUser.practiceName || `${requestingUser.doctorName || requestingUser.username}'s Practice`,
            leadDoctor: doctorLabel,
            phone: requestingUser.practicePhone || requestingUser.phone || "",
            email: requestingUser.email || "",
            address: requestingUser.practiceAddress || "",
            tier: "Standard",
            discountRate: 0,
          });
        }
      }
      addNotification({
        title: "Lab Join Request Accepted",
        message: `${request.requestingUsername} has been added to ${adminProfile?.practiceName || "your lab"} as ${role === "admin" ? "an admin" : "a user"}.`,
        type: "update",
      });
    } else {
      addNotification({
        title: "Lab Join Request Declined",
        message: `The admin from ${adminProfile?.practiceName || "the lab you selected"} elected to decline ${request.requestingUsername}'s request to join their lab.`,
        type: "alert",
      });
    }

    refreshUsers();
    fetchServerJoinRequestsAndInvites();
  }

  function sendLabInvite(targetUsername: string, targetEmail: string, role: "admin" | "user"): { success: boolean; error?: string } {
    if (!currentUser || !currentUserProfile?.practiceName) {
      return { success: false, error: "You must be affiliated with a lab to send invitations." };
    }
    const targetUser = registeredUsers.find(
      u => u.username.toLowerCase() === targetUsername.toLowerCase() && u.email?.toLowerCase() === targetEmail.toLowerCase()
    );
    if (!targetUser) {
      return { success: false, error: "No user found with that username and email combination." };
    }

    (async () => {
      try {
        const groupsResp = await resilientFetch("/api/labs/groups");
        const groupsData = await groupsResp.json();
        const groups: Array<{ practiceName: string; organizationId: string }> = groupsData.groups || [];
        const myLabName = currentUserProfile!.practiceName!.toLowerCase().trim();
        const match = groups.find(g => g.practiceName.toLowerCase().trim() === myLabName);
        if (!match?.organizationId) {
          Alert.alert("Error", "Could not find your lab on the server.");
          return;
        }

        const resp = await resilientFetch(`/api/organizations/${match.organizationId}/invites`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            invitedUserId: targetUser.id,
            invitedPhone: targetUser.phone || undefined,
            role: role === "admin" ? "admin" : "user",
          }),
        });
        const data = await resp.json();
        if (!resp.ok) {
          Alert.alert("Error", data?.message || "Failed to send invitation.");
          return;
        }

        if (data?.data?.id) {
          const invite: LabInvitation = {
            id: generateId(),
            adminUsername: currentUser!,
            adminLabName: currentUserProfile!.practiceName!,
            invitedUsername: targetUser.username,
            invitedEmail: targetUser.email || targetEmail,
            role,
            status: "pending",
            createdAt: Date.now(),
            serverInviteToken: data.data.id,
          };
          setLabInvitations(prev => {
            const updated = [...prev, invite];
            AsyncStorage.setItem(LAB_INVITATIONS_KEY, JSON.stringify(updated));
            return updated;
          });
        }

        addNotification({
          title: "Lab Invitation Sent",
          message: `Invitation sent to ${targetUser.username} to join ${currentUserProfile!.practiceName} as ${role === "admin" ? "an admin" : "a user"}.`,
          type: "update",
        });
        Alert.alert("Invitation Sent", `Invitation sent to ${targetUser.username}.`);
        fetchServerJoinRequestsAndInvites();
      } catch (e) {
        console.log("Failed to create server invite:", e);
        Alert.alert("Error", "Network error. Please check your connection and try again.");
      }
    })();

    return { success: true };
  }

  async function respondToLabInvite(inviteId: string, accept: boolean) {
    const invite = labInvitations.find(i => i.id === inviteId);
    if (!invite) return;

    const invitedName = invite.invitedUsername || invite.targetUsername || "";

    if (invite.serverInviteToken) {
      try {
        const endpoint = accept
          ? `/api/organizations/invites/${invite.serverInviteToken}/accept`
          : `/api/organizations/invites/${invite.serverInviteToken}/reject`;
        const resp = await resilientFetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          Alert.alert("Error", data?.message || "Failed to update invitation on server.");
          return;
        }
      } catch (e) {
        console.log("Failed to respond to invite on server:", e);
        Alert.alert("Error", "Network error. Please check your connection and try again.");
        return;
      }
    }

    setLabInvitations(prev => {
      const updated = prev.map(i =>
        i.id === inviteId ? { ...i, status: accept ? "accepted" as const : "declined" as const } : i
      );
      AsyncStorage.setItem(LAB_INVITATIONS_KEY, JSON.stringify(updated));
      return updated;
    });

    if (accept) {
      addNotification({
        title: "Lab Invitation Accepted",
        message: `${invitedName} has joined ${invite.adminLabName} as ${invite.role === "admin" ? "an admin" : "a user"}.`,
        type: "update",
      });
    } else {
      addNotification({
        title: "Lab Invitation Declined",
        message: `${invitedName} declined the invitation to join ${invite.adminLabName}.`,
        type: "alert",
      });
    }

    refreshUsers();
    fetchServerJoinRequestsAndInvites();
  }

  const [isLabCreator, setIsLabCreator] = useState(false);

  useEffect(() => {
    if (!currentUserId || !currentUserProfile?.practiceName) {
      setIsLabCreator(false);
      return;
    }
    const apiUrl = getApiUrl();
    const url = new URL("/api/auth/lab-creator", apiUrl);
    resilientFetch(url.toString())
      .then((res) => res.json())
      .then((data) => setIsLabCreator(!!data.isLabCreator))
      .catch(() => setIsLabCreator(false));
  }, [currentUserId, currentUserProfile?.practiceName]);

  async function leaveLab(): Promise<{ success: boolean; error?: string }> {
    if (!currentUserId) return { success: false, error: "Not logged in" };
    try {
      // Use the dedicated /leave endpoint if we know the orgId, otherwise find it first
      const orgId = serverOrgId;
      if (orgId) {
        const leaveResp = await resilientFetch(`/api/organizations/${orgId}/leave`, { method: "POST" });
        if (!leaveResp.ok) {
          const d = await leaveResp.json().catch(() => ({}));
          return { success: false, error: (d as any).error || "Failed to leave lab" };
        }
      } else {
        // Fall back: find the membership ID from /api/auth/me
        const meResp = await resilientFetch("/api/auth/me");
        if (meResp.ok) {
          const meData = await meResp.json();
          const memberships: any[] = Array.isArray(meData.memberships) ? meData.memberships : [];
          const labMembership = memberships.find(m => m.status === "active" && m.organization?.type === "lab");
          if (labMembership?.id) {
            await resilientFetch(`/api/organizations/memberships/${labMembership.id}`, { method: "DELETE" });
          }
        }
      }
      // Clear local state for the leaving user
      setServerOrgId(null);
      setServerMemberIds(new Set());
      setAllCases([]);
      setClients([]);
      setInvoices([]);
      setInventory([]);
      AsyncStorage.setItem(CASES_KEY, JSON.stringify([]));
      AsyncStorage.setItem(CLIENTS_KEY, JSON.stringify([]));
      AsyncStorage.setItem(INVOICES_KEY, JSON.stringify([]));
      await refreshUsers();
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || "Failed to leave lab" };
    }
  }

  async function deleteLab(): Promise<{ success: boolean; error?: string; recoverableUntil?: string }> {
    if (!currentUserId) return { success: false, error: "Not logged in" };
    try {
      const apiUrl = getApiUrl();
      const url = new URL("/api/auth/delete-lab", apiUrl);
      const res = await resilientFetch(url.toString(), { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data.message || data.error || "Failed to delete lab" };
      }
      setIsLabCreator(false);
      setAllCases([]);
      setClients([]);
      setInvoices([]);
      setInventory([]);
      AsyncStorage.setItem(CASES_KEY, JSON.stringify([]));
      AsyncStorage.setItem(CLIENTS_KEY, JSON.stringify([]));
      AsyncStorage.setItem(INVOICES_KEY, JSON.stringify([]));
      await refreshUsers();
      return { success: true, recoverableUntil: data.recoverableUntil };
    } catch (e: any) {
      return { success: false, error: e?.message || "Failed to delete lab" };
    }
  }

  async function getDeletedLabs(): Promise<{ id: string; name: string; deletedAt: string; recoverableUntil: string; role: string }[]> {
    try {
      const apiUrl = getApiUrl();
      const url = new URL("/api/auth/deleted-labs", apiUrl);
      const res = await resilientFetch(url.toString());
      const data = await res.json();
      if (!res.ok) return [];
      return data.deletedLabs || [];
    } catch {
      return [];
    }
  }

  async function restoreLab(labId: string): Promise<{ success: boolean; error?: string }> {
    if (!currentUserId) return { success: false, error: "Not logged in" };
    try {
      const apiUrl = getApiUrl();
      const url = new URL(`/api/auth/restore-lab/${labId}`, apiUrl);
      const res = await resilientFetch(url.toString(), { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data.message || data.error || "Failed to restore lab" };
      }
      await refreshUsers();
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || "Failed to restore lab" };
    }
  }

  async function createLabFromSettings(
    name: string,
    displayName?: string,
    phone?: string,
    addressLine1?: string,
    city?: string,
    state?: string,
    zip?: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!currentUserId) return { success: false, error: "Not logged in" };
    try {
      const apiUrl = getApiUrl();
      const url = new URL("/api/organizations", apiUrl);
      const res = await resilientFetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "lab", name, displayName, phone, addressLine1, city, state, zip }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data.message || data.error || "Failed to create lab" };
      }
      await refreshUsers();
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || "Failed to create lab" };
    }
  }

  function addInventoryItem(item: Omit<InventoryItem, "id">) {
    const newItem: InventoryItem = { ...item, id: Date.now().toString() + Math.random().toString(36).substr(2, 9) };
    setInventory(prev => [...prev, newItem]);
  }

  function updateInventoryItem(id: string, updates: Partial<InventoryItem>) {
    setInventory(prev => prev.map(item => item.id === id ? { ...item, ...updates } : item));
  }

  function removeInventoryItem(id: string) {
    setInventory(prev => prev.filter(item => item.id !== id));
  }

  function updateStationLabel(stationId: CaseStatus, label: string) {
    setCustomStationLabels(prev => {
      const updated = { ...prev, [stationId]: label };
      AsyncStorage.setItem(STATION_LABELS_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  function assignBarcodeToCase(caseId: string, barcode: string) {
    const now = Date.now();
    setCases((prev) => {
      const updated = prev.map((c) => {
        if (c.id === caseId) {
          if (c.assignedBarcode === barcode) return c;
          const entry: ActivityEntry = {
            id: generateId(),
            type: "barcode_assigned",
            timestamp: now,
            description: `Barcode ${barcode} assigned to case`,
            user: currentUser || undefined,
          };
          return { ...c, assignedBarcode: barcode, updatedAt: now, activityLog: [...(c.activityLog || []), entry] };
        }
        return c;
      });
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  function unassignBarcode(caseId: string) {
    const now = Date.now();
    setCases((prev) => {
      const updated = prev.map((c) => {
        if (c.id === caseId) {
          const oldBarcode = c.assignedBarcode || "unknown";
          const entry: ActivityEntry = {
            id: generateId(),
            type: "barcode_unassigned",
            timestamp: now,
            description: `Barcode ${oldBarcode} removed from case`,
            user: currentUser || undefined,
          };
          return { ...c, assignedBarcode: undefined, updatedAt: now, activityLog: [...(c.activityLog || []), entry] };
        }
        return c;
      });
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  function findCaseByBarcode(barcode: string): LabCase | undefined {
    return cases.find((c) => c.assignedBarcode === barcode && c.status !== "COMPLETE");
  }

  function findAllCasesByBarcode(barcode: string): LabCase[] {
    return cases.filter((c) => c.assignedBarcode === barcode);
  }

  function batchLocateCases(caseIds: string[], newStatus: CaseStatus) {
    const now = Date.now();
    const stationLabel = getStationInfo(newStatus, customStationLabels).label;
    setCases((prev) => {
      const updated = prev.map((c) => {
        if (caseIds.includes(c.id)) {
          const stationEntry: ActivityEntry = {
            id: generateId(),
            type: "station_change",
            timestamp: now,
            description: `Case batch-moved to ${stationLabel}`,
            station: newStatus,
          };
          return {
            ...c,
            status: newStatus,
            assignedBarcode: c.assignedBarcode,
            updatedAt: now,
            routeHistory: [...c.routeHistory, { station: newStatus, timestamp: now }],
            activityLog: [...(c.activityLog || []), stationEntry],
          };
        }
        return c;
      });
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  function addConversation(conv: Conversation) {
    setConversations(prev => {
      const updated = [conv, ...prev];
      AsyncStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  function removeConversation(conversationId: string) {
    setConversations(prev => {
      const updated = prev.filter(c => c.id !== conversationId);
      AsyncStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(updated));
      return updated;
    });
    setChatMessages(prev => {
      const updated = prev.filter(m => m.conversationId !== conversationId);
      AsyncStorage.setItem(CHAT_MESSAGES_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  function addNotification(notif: Omit<Notification, "id" | "read" | "timestamp">) {
    const newNotif: Notification = {
      id: generateId(),
      ...notif,
      read: false,
      timestamp: Date.now(),
    };
    setNotifications(prev => {
      const updated = [newNotif, ...prev];
      AsyncStorage.setItem(NOTIFS_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  function markConversationRead(conversationId: string) {
    setChatMessages(prev => {
      const updated = prev.map(m => {
        if (m.conversationId === conversationId && !m.read) {
          return { ...m, read: true };
        }
        return m;
      });
      AsyncStorage.setItem(CHAT_MESSAGES_KEY, JSON.stringify(updated));
      return updated;
    });
    setConversations(prev => {
      const updated = prev.map(c => {
        if (c.id === conversationId) {
          return { ...c, unreadCount: 0 };
        }
        return c;
      });
      AsyncStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications],
  );
  const activeCaseCount = useMemo(
    () => cases.filter((c) => c.status !== "COMPLETE" && c.status !== "SHIP").length,
    [cases],
  );
  const rushCaseCount = useMemo(
    () =>
      cases.filter(
        (c) => c.isRush && c.status !== "COMPLETE" && c.status !== "SHIP",
      ).length,
    [cases],
  );

  const totalUnreadMessages = useMemo(
    () => conversations.reduce((sum, c) => sum + c.unreadCount, 0),
    [conversations],
  );

  const value = useMemo(
    () => ({
      role,
      setRole,
      adminUnlocked,
      setAdminUnlocked,
      cases,
      addCase,
      updateCaseStatus,
      addCasePhoto,
      addCaseNote,
      addTrackingNumber,
      addCaseItem,
      notifications,
      markNotificationRead,
      markAllNotificationsRead,
      removeNotification,
      unreadCount,
      activeCaseCount,
      rushCaseCount,
      isLoading,
      clients,
      addClient,
      updateClient,
      pricingTiers,
      updateTierPricing,
      addPricingTier,
      users,
      addUser,
      updateUser,
      removeUser,
      invoices,
      addInvoice,
      updateInvoice,
      shippingAccounts,
      addShippingAccount,
      removeShippingAccount,
      conversations,
      chatMessages,
      sendChatMessage,
      markConversationRead,
      totalUnreadMessages,
      updateCase,
      removeCase,
      removeInvoice,
      attachCaseToInvoice,
      sendCourtesyText,
      respondToCourtesyText,
      proposeDeliveryDate,
      respondToProposedDate,
      inventory,
      addInventoryItem,
      updateInventoryItem,
      removeInventoryItem,
      assignBarcodeToCase,
      unassignBarcode,
      findCaseByBarcode,
      findAllCasesByBarcode,
      batchLocateCases,
      groupJoinRequests,
      sendGroupJoinRequest,
      respondToGroupJoinRequest,
      labInvitations,
      sendLabInvite,
      respondToLabInvite,
      refreshJoinData: fetchServerJoinRequestsAndInvites,
      addConversation,
      removeConversation,
      addNotification,
      customStationLabels,
      updateStationLabel,
      userIsAffiliated,
      leaveLab,
      deleteLab,
      restoreLab,
      getDeletedLabs,
      createLabFromSettings,
      isLabCreator,
      removeClient,
      deactivateClient,
      reactivateClient,
      deletedClientInvoices,
      inactiveClients: clients.filter(c => c.status === "inactive"),
      refreshCases,
    }),
    [role, adminUnlocked, cases, notifications, unreadCount, activeCaseCount, rushCaseCount, isLoading, clients, pricingTiers, users, invoices, shippingAccounts, conversations, chatMessages, totalUnreadMessages, groupJoinRequests, labInvitations, inventory, customStationLabels, userIsAffiliated, isLabCreator, deletedClientInvoices],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
