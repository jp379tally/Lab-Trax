import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  ReactNode,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
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
  CourtesyTextRequest,
  CourtesyTextResponse,
  InventoryItem,
  sampleInventory,
  SAMPLE_CASES,
  SAMPLE_NOTIFICATIONS,
  SAMPLE_CLIENTS,
  SAMPLE_USERS,
  SAMPLE_INVOICES,
  SAMPLE_CONVERSATIONS,
  SAMPLE_CHAT_MESSAGES,
  PricingTier,
  DEFAULT_PRICING_TIERS,
  Group,
  GroupMember,
  GroupInvitation,
  GroupJoinRequest,
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
  groups: Group[];
  groupInvitations: GroupInvitation[];
  createGroup: (name: string, type: "provider" | "lab", address: string, creatorUsername: string, creatorRole: "admin" | "user") => Group;
  addUserToGroup: (groupId: string, username: string, role: "admin" | "user") => void;
  removeUserFromGroup: (groupId: string, userId: string) => void;
  sendGroupInvitation: (groupId: string, invitedUsername: string, invitedBy: string) => void;
  respondToGroupInvitation: (invitationId: string, accept: boolean, userRole?: "admin" | "user") => void;
  getUserGroups: (username: string) => Group[];
  getGroupByNameAndAddress: (name: string, address: string) => Group | undefined;
  findOrCreateGroup: (name: string, type: "provider" | "lab", address: string, username: string, role: "admin" | "user") => Group;
  updateCase: (caseId: string, updates: Partial<LabCase>) => void;
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
  respondToGroupJoinRequest: (requestId: string, accept: boolean, role?: "admin" | "user") => void;
  addConversation: (conv: Conversation) => void;
  removeConversation: (conversationId: string) => void;
  addNotification: (notif: Omit<Notification, "id" | "read" | "timestamp">) => void;
  customStationLabels: Record<string, string>;
  updateStationLabel: (stationId: CaseStatus, label: string) => void;
  userIsAffiliated: boolean;
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
const GROUPS_KEY = "@drivesync_groups";
const GROUP_INVITATIONS_KEY = "@drivesync_group_invitations";
const GROUP_JOIN_REQUESTS_KEY = "@drivesync_group_join_requests";
const BARCODE_ASSIGNMENTS_KEY = "@drivesync_barcode_assignments";
const STATION_LABELS_KEY = "@drivesync_station_labels";

export function AppProvider({ children }: { children: ReactNode }) {
  const { currentUserId, currentUser, userType } = useAuth();
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
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupInvitations, setGroupInvitations] = useState<GroupInvitation[]>([]);
  const [groupJoinRequests, setGroupJoinRequests] = useState<GroupJoinRequest[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>(sampleInventory);
  const [customStationLabels, setCustomStationLabels] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);

  const userIsAffiliated = useMemo(() => {
    if (!currentUser) return false;
    return groups.some(g => g.members.some(m => m.username.toLowerCase() === currentUser.toLowerCase()));
  }, [groups, currentUser]);

  const cases = useMemo(() => {
    if (!currentUserId) return [];
    if (!userIsAffiliated) return [];
    return allCases.filter((c) => c.ownerId === currentUserId);
  }, [allCases, currentUserId, userIsAffiliated]);

  function setCases(updater: LabCase[] | ((prev: LabCase[]) => LabCase[])) {
    setAllCases(updater);
  }

  useEffect(() => {
    loadData();
  }, [currentUserId]);

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
        setAllCases(parsedCases);
      } else if (currentUserId) {
        const stampedCases = SAMPLE_CASES.map((c) => ({ ...c, ownerId: currentUserId }));
        setAllCases(stampedCases);
        await AsyncStorage.setItem(CASES_KEY, JSON.stringify(stampedCases));
      } else {
        setAllCases(SAMPLE_CASES);
        await AsyncStorage.setItem(CASES_KEY, JSON.stringify(SAMPLE_CASES));
      }

      if (savedRole) {
        setRoleState(savedRole as UserRole);
      }

      if (savedNotifs) {
        setNotifications(JSON.parse(savedNotifs));
      } else {
        setNotifications(SAMPLE_NOTIFICATIONS);
        await AsyncStorage.setItem(NOTIFS_KEY, JSON.stringify(SAMPLE_NOTIFICATIONS));
      }

      if (savedClients) {
        setClients(JSON.parse(savedClients));
      } else {
        setClients(SAMPLE_CLIENTS);
        await AsyncStorage.setItem(CLIENTS_KEY, JSON.stringify(SAMPLE_CLIENTS));
      }

      if (savedUsers) {
        setUsers(JSON.parse(savedUsers));
      } else {
        setUsers(SAMPLE_USERS);
        await AsyncStorage.setItem(USERS_KEY, JSON.stringify(SAMPLE_USERS));
      }

      if (savedInvoices) {
        setInvoices(JSON.parse(savedInvoices));
      } else {
        setInvoices(SAMPLE_INVOICES);
        await AsyncStorage.setItem(INVOICES_KEY, JSON.stringify(SAMPLE_INVOICES));
      }

      if (savedShipping) {
        setShippingAccounts(JSON.parse(savedShipping));
      }

      if (savedConversations) {
        setConversations(JSON.parse(savedConversations));
      } else {
        setConversations(SAMPLE_CONVERSATIONS);
        await AsyncStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(SAMPLE_CONVERSATIONS));
      }

      if (savedChatMessages) {
        setChatMessages(JSON.parse(savedChatMessages));
      } else {
        setChatMessages(SAMPLE_CHAT_MESSAGES);
        await AsyncStorage.setItem(CHAT_MESSAGES_KEY, JSON.stringify(SAMPLE_CHAT_MESSAGES));
      }

      if (savedPricingTiers) {
        setPricingTiers(JSON.parse(savedPricingTiers));
      } else {
        setPricingTiers(DEFAULT_PRICING_TIERS);
        await AsyncStorage.setItem(PRICING_TIERS_KEY, JSON.stringify(DEFAULT_PRICING_TIERS));
      }

      const [savedGroups, savedGroupInvitations] = await Promise.all([
        AsyncStorage.getItem(GROUPS_KEY),
        AsyncStorage.getItem(GROUP_INVITATIONS_KEY),
      ]);

      if (savedGroups) {
        setGroups(JSON.parse(savedGroups));
      }

      if (savedGroupInvitations) {
        setGroupInvitations(JSON.parse(savedGroupInvitations));
      }

      const savedStationLabels = await AsyncStorage.getItem(STATION_LABELS_KEY);
      if (savedStationLabels) {
        setCustomStationLabels(JSON.parse(savedStationLabels));
      }

      const savedGroupJoinRequests = await AsyncStorage.getItem(GROUP_JOIN_REQUESTS_KEY);
      if (savedGroupJoinRequests) {
        setGroupJoinRequests(JSON.parse(savedGroupJoinRequests));
      }
      const pendingGroupRaw = await AsyncStorage.getItem("@drivesync_pending_group");
      if (pendingGroupRaw) {
        try {
          const pg = JSON.parse(pendingGroupRaw);
          const loadedGroups: Group[] = savedGroups ? JSON.parse(savedGroups) : [];
          const existing = loadedGroups.find(g => g.name.toLowerCase() === pg.name.toLowerCase() && g.address.toLowerCase() === pg.address.toLowerCase());
          if (existing) {
            const alreadyMember = existing.members.some((m: any) => m.username === pg.username);
            if (!alreadyMember) {
              existing.members.push({ userId: Date.now().toString(), username: pg.username, role: pg.role, joinedAt: Date.now() });
              setGroups([...loadedGroups]);
              AsyncStorage.setItem(GROUPS_KEY, JSON.stringify(loadedGroups));
            }
          } else {
            const newGroup: Group = {
              id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
              name: pg.name,
              type: pg.type,
              address: pg.address,
              members: [{ userId: Date.now().toString(), username: pg.username, role: pg.role, joinedAt: Date.now() }],
              createdAt: Date.now(),
            };
            const updatedGroups = [...loadedGroups, newGroup];
            setGroups(updatedGroups);
            AsyncStorage.setItem(GROUPS_KEY, JSON.stringify(updatedGroups));
          }
        } catch {}
        AsyncStorage.removeItem("@drivesync_pending_group");
      }

      const pendingClientRaw = await AsyncStorage.getItem("@drivesync_pending_client");
      if (pendingClientRaw) {
        try {
          const pc = JSON.parse(pendingClientRaw);
          const freshClients = await AsyncStorage.getItem(CLIENTS_KEY);
          const loadedClients: Client[] = freshClients ? JSON.parse(freshClients) : SAMPLE_CLIENTS;
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
      setAllCases(currentUserId ? SAMPLE_CASES.map((c) => ({ ...c, ownerId: currentUserId })) : SAMPLE_CASES);
      setNotifications(SAMPLE_NOTIFICATIONS);
      setClients(SAMPLE_CLIENTS);
      setUsers(SAMPLE_USERS);
      setInvoices(SAMPLE_INVOICES);
      setConversations(SAMPLE_CONVERSATIONS);
      setChatMessages(SAMPLE_CHAT_MESSAGES);
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
      const unitPrice = c.price || (MATERIAL_PRICES[materialStr] ?? 0);
      lineItems.push({
        qty: 1,
        item: materialStr,
        description: `${c.caseType || "Restorative"} - ${toothStr || "N/A"}`,
        rate: unitPrice,
        amount: unitPrice,
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
          return {
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
          return { ...c, ...updates, updatedAt: Date.now() };
        }
        return c;
      });
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
      return updated;
    });
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
            description: `Case attached to invoice #${invoiceId}`,
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
                  description: `Invoice #${targetInvoice.invoiceNumber || id} paid — $${targetInvoice.amount.toFixed(2)}`,
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

  function createGroup(name: string, type: "provider" | "lab", address: string, creatorUsername: string, creatorRole: "admin" | "user"): Group {
    const now = Date.now();
    const newGroup: Group = {
      id: generateId(),
      name,
      type,
      address,
      members: [
        {
          userId: generateId(),
          username: creatorUsername,
          role: creatorRole,
          joinedAt: now,
        },
      ],
      createdAt: now,
    };
    const updated = [...groups, newGroup];
    setGroups(updated);
    AsyncStorage.setItem(GROUPS_KEY, JSON.stringify(updated));
    return newGroup;
  }

  function addUserToGroup(groupId: string, username: string, role: "admin" | "user") {
    const now = Date.now();
    const newMember: GroupMember = {
      userId: generateId(),
      username,
      role,
      joinedAt: now,
    };
    const updated = groups.map(g => {
      if (g.id === groupId) {
        const alreadyMember = g.members.some(m => m.username === username);
        if (alreadyMember) return g;
        return { ...g, members: [...g.members, newMember] };
      }
      return g;
    });
    setGroups(updated);
    AsyncStorage.setItem(GROUPS_KEY, JSON.stringify(updated));
  }

  function removeUserFromGroup(groupId: string, userId: string) {
    const updated = groups.map(g => {
      if (g.id === groupId) {
        return { ...g, members: g.members.filter(m => m.userId !== userId) };
      }
      return g;
    });
    setGroups(updated);
    AsyncStorage.setItem(GROUPS_KEY, JSON.stringify(updated));
  }

  function sendGroupInvitation(groupId: string, invitedUsername: string, invitedBy: string) {
    const group = groups.find(g => g.id === groupId);
    const invitation: GroupInvitation = {
      id: generateId(),
      groupId,
      groupName: group?.name || "",
      invitedUsername,
      invitedBy,
      status: "pending",
      createdAt: Date.now(),
    };
    const updated = [...groupInvitations, invitation];
    setGroupInvitations(updated);
    AsyncStorage.setItem(GROUP_INVITATIONS_KEY, JSON.stringify(updated));
  }

  function sendGroupJoinRequest(targetAdminUsername: string, requestingUsername: string, message?: string): { success: boolean; error?: string } {
    const existing = groupJoinRequests.find(
      r => r.requestingUsername.toLowerCase() === requestingUsername.toLowerCase()
        && r.targetAdminUsername.toLowerCase() === targetAdminUsername.toLowerCase()
        && r.status === "pending"
    );
    if (existing) {
      return { success: false, error: "You already have a pending request to this admin." };
    }

    const request: GroupJoinRequest = {
      id: generateId(),
      requestingUsername,
      targetAdminUsername,
      message: message || `${requestingUsername} would like to join your group.`,
      status: "pending",
      createdAt: Date.now(),
    };
    const updated = [...groupJoinRequests, request];
    setGroupJoinRequests(updated);
    AsyncStorage.setItem(GROUP_JOIN_REQUESTS_KEY, JSON.stringify(updated));
    return { success: true };
  }

  function respondToGroupJoinRequest(requestId: string, accept: boolean, role?: "admin" | "user") {
    const request = groupJoinRequests.find(r => r.id === requestId);
    if (!request) return;

    const updated = groupJoinRequests.map(r => {
      if (r.id === requestId) {
        return { ...r, status: accept ? "accepted" as const : "declined" as const };
      }
      return r;
    });
    setGroupJoinRequests(updated);
    AsyncStorage.setItem(GROUP_JOIN_REQUESTS_KEY, JSON.stringify(updated));

    if (accept) {
      const adminGroups = groups.filter(g => g.members.some(m => m.username.toLowerCase() === request.targetAdminUsername.toLowerCase() && m.role === "admin"));
      if (adminGroups.length > 0) {
        addUserToGroup(adminGroups[0].id, request.requestingUsername, role || "user");
      }
      if (role === "user") {
        AsyncStorage.getItem("@drivesync_auth_users").then(raw => {
          if (!raw) return;
          try {
            const allUsers = JSON.parse(raw);
            const updatedUsers = allUsers.map((u: any) => {
              if (u.username.toLowerCase() === request.requestingUsername.toLowerCase()) {
                return { ...u, role: "user" };
              }
              return u;
            });
            AsyncStorage.setItem("@drivesync_auth_users", JSON.stringify(updatedUsers));
          } catch {}
        });
      }
      AsyncStorage.getItem("@drivesync_auth_users").then(raw => {
        if (!raw) return;
        try {
          const allUsers = JSON.parse(raw);
          const userData = allUsers.find((u: any) => u.username.toLowerCase() === request.requestingUsername.toLowerCase());
          if (userData && userData.userType === "provider") {
            const doctorLabel = userData.doctorName
              ? (userData.accountNumber ? `Dr. ${userData.doctorName} (${userData.accountNumber})` : `Dr. ${userData.doctorName}`)
              : `Dr. ${userData.username}`;
            const alreadyClient = clients.some(c =>
              c.leadDoctor.toLowerCase() === doctorLabel.toLowerCase() ||
              (userData.doctorName && c.leadDoctor.toLowerCase().includes(userData.doctorName.toLowerCase())) ||
              (userData.practiceName && c.practiceName.toLowerCase() === userData.practiceName.toLowerCase())
            );
            if (!alreadyClient) {
              addClient({
                practiceName: userData.practiceName || `${userData.doctorName || userData.username}'s Practice`,
                leadDoctor: doctorLabel,
                phone: userData.practicePhone || userData.phone || "",
                email: userData.email || "",
                address: userData.practiceAddress || "",
                tier: "Standard",
                discountRate: 0,
              });
            }
          }
        } catch {}
      });
    }
  }

  function respondToGroupInvitation(invitationId: string, accept: boolean, userRole?: "admin" | "user") {
    const invitation = groupInvitations.find(inv => inv.id === invitationId);
    if (!invitation) return;

    const updatedInvitations = groupInvitations.map(inv => {
      if (inv.id === invitationId) {
        return { ...inv, status: accept ? "accepted" as const : "declined" as const };
      }
      return inv;
    });
    setGroupInvitations(updatedInvitations);
    AsyncStorage.setItem(GROUP_INVITATIONS_KEY, JSON.stringify(updatedInvitations));

    if (accept) {
      addUserToGroup(invitation.groupId, invitation.invitedUsername, userRole || "user");
    }
  }

  function getUserGroups(username: string): Group[] {
    return groups.filter(g => g.members.some(m => m.username === username));
  }

  function getGroupByNameAndAddress(name: string, address: string): Group | undefined {
    return groups.find(g => g.name === name && g.address === address);
  }

  function findOrCreateGroup(name: string, type: "provider" | "lab", address: string, username: string, role: "admin" | "user"): Group {
    const existing = getGroupByNameAndAddress(name, address);
    if (existing) {
      const alreadyMember = existing.members.some(m => m.username === username);
      if (!alreadyMember) {
        addUserToGroup(existing.id, username, role);
      }
      return existing;
    }
    return createGroup(name, type, address, username, role);
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
      groups,
      groupInvitations,
      createGroup,
      addUserToGroup,
      removeUserFromGroup,
      sendGroupInvitation,
      respondToGroupInvitation,
      getUserGroups,
      getGroupByNameAndAddress,
      findOrCreateGroup,
      updateCase,
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
      addConversation,
      removeConversation,
      addNotification,
      customStationLabels,
      updateStationLabel,
      userIsAffiliated,
    }),
    [role, adminUnlocked, cases, notifications, unreadCount, activeCaseCount, rushCaseCount, isLoading, clients, pricingTiers, users, invoices, shippingAccounts, conversations, chatMessages, totalUnreadMessages, groups, groupInvitations, groupJoinRequests, inventory, customStationLabels, userIsAffiliated],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
