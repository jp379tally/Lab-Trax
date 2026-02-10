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
  SAMPLE_CASES,
  SAMPLE_NOTIFICATIONS,
  SAMPLE_CLIENTS,
  SAMPLE_USERS,
  SAMPLE_INVOICES,
  SAMPLE_CONVERSATIONS,
  SAMPLE_CHAT_MESSAGES,
} from "./data";

interface AppContextValue {
  role: UserRole;
  setRole: (r: UserRole) => void;
  adminUnlocked: boolean;
  setAdminUnlocked: (v: boolean) => void;
  cases: LabCase[];
  addCase: (c: Omit<LabCase, "id" | "createdAt" | "updatedAt" | "routeHistory">) => void;
  updateCaseStatus: (caseId: string, newStatus: CaseStatus) => void;
  addCasePhoto: (caseId: string, photoUri: string) => void;
  addCaseNote: (caseId: string, note: string) => void;
  addTrackingNumber: (caseId: string, tracking: string) => void;
  addCaseItem: (caseId: string, caseType: CaseTypeValue, selectedTeeth: number[], toothTypes: Record<number, ToothType>, material: string) => void;
  notifications: Notification[];
  markNotificationRead: (id: string) => void;
  unreadCount: number;
  activeCaseCount: number;
  rushCaseCount: number;
  isLoading: boolean;
  clients: Client[];
  addClient: (c: Omit<Client, "id" | "clientNumber" | "createdAt">) => void;
  updateClient: (id: string, c: Partial<Client>) => void;
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

export function AppProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<UserRole>("tech");
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [cases, setCases] = useState<LabCase[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [users, setUsers] = useState<LabUser[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [shippingAccounts, setShippingAccounts] = useState<ShippingAccount[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const [savedCases, savedRole, savedNotifs, savedClients, savedUsers, savedInvoices, savedShipping, savedConversations, savedChatMessages] = await Promise.all([
        AsyncStorage.getItem(CASES_KEY),
        AsyncStorage.getItem(ROLE_KEY),
        AsyncStorage.getItem(NOTIFS_KEY),
        AsyncStorage.getItem(CLIENTS_KEY),
        AsyncStorage.getItem(USERS_KEY),
        AsyncStorage.getItem(INVOICES_KEY),
        AsyncStorage.getItem(SHIPPING_KEY),
        AsyncStorage.getItem(CONVERSATIONS_KEY),
        AsyncStorage.getItem(CHAT_MESSAGES_KEY),
      ]);

      if (savedCases) {
        setCases(JSON.parse(savedCases));
      } else {
        setCases(SAMPLE_CASES);
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
    } catch (e) {
      setCases(SAMPLE_CASES);
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
  ) {
    const now = Date.now();
    const createdEntry: import("@/lib/data").ActivityEntry = {
      id: generateId(),
      type: "created",
      timestamp: now,
      description: "Case created and scanned in at Intake",
      station: c.status,
    };
    const newCase: LabCase = {
      ...c,
      id: generateId(),
      createdAt: now,
      updatedAt: now,
      routeHistory: [{ station: c.status, timestamp: now }],
      photos: c.photos || [],
      activityLog: [...(c.activityLog || []), createdEntry],
    };
    const updated = [newCase, ...cases];
    setCases(updated);
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
  }

  function updateCaseStatus(caseId: string, newStatus: CaseStatus) {
    const now = Date.now();
    const stationLabel = getStationInfo(newStatus).label;
    const stationEntry: ActivityEntry = {
      id: generateId(),
      type: "station_change",
      timestamp: now,
      description: `Case moved to ${stationLabel}`,
      station: newStatus,
    };
    setCases((prevCases) => {
      const updated = prevCases.map((c) => {
        if (c.id === caseId) {
          return {
            ...c,
            status: newStatus,
            updatedAt: now,
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
      }

      return updated;
    });
  }

  function addCasePhoto(caseId: string, photoUri: string) {
    const now = Date.now();
    const photoEntry: ActivityEntry = {
      id: generateId(),
      type: "photo",
      timestamp: now,
      description: "Photo added to case",
      imageUri: photoUri,
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

  function addCaseNote(caseId: string, note: string) {
    const now = Date.now();
    const noteEntry: ActivityEntry = {
      id: generateId(),
      type: "note",
      timestamp: now,
      description: note,
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
    setCases((prevCases) => {
      const updated = prevCases.map((c) => {
        if (c.id === caseId) {
          return {
            ...c,
            updatedAt: Date.now(),
            trackingNumbers: [...(c.trackingNumbers || []), tracking],
          };
        }
        return c;
      });
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  function addCaseItem(caseId: string, caseType: CaseTypeValue, selectedTeeth: number[], toothTypesMap: Record<number, ToothType>, mat: string) {
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

          const newActivity: ActivityEntry = {
            id: generateId(),
            type: "note",
            description: `Item added: ${caseType} - ${toothDisplay} (${mat})`,
            timestamp: Date.now(),
            user: "tech",
          };

          return {
            ...c,
            caseType: caseType as CaseTypeValue,
            toothIndices: toothDisplay || c.toothIndices,
            toothMap: toothMapEntries.length > 0 ? toothMapEntries : c.toothMap,
            material: mat,
            price,
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

  function markNotificationRead(id: string) {
    const updated = notifications.map((n) =>
      n.id === id ? { ...n, read: true } : n,
    );
    setNotifications(updated);
    AsyncStorage.setItem(NOTIFS_KEY, JSON.stringify(updated));
  }

  function addClient(c: Omit<Client, "id" | "clientNumber" | "createdAt">) {
    const maxNum = clients.reduce((max, cl) => Math.max(max, cl.clientNumber || 0), 0);
    const newClient: Client = { ...c, id: generateId(), clientNumber: maxNum + 1, createdAt: Date.now() };
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
    const updated = invoices.map((i) => (i.id === id ? { ...i, ...inv } : i));
    setInvoices(updated);
    AsyncStorage.setItem(INVOICES_KEY, JSON.stringify(updated));
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
    }),
    [role, adminUnlocked, cases, notifications, unreadCount, activeCaseCount, rushCaseCount, isLoading, clients, users, invoices, shippingAccounts, conversations, chatMessages, totalUnreadMessages],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
