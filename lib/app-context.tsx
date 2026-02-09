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
  Client,
  LabUser,
  Invoice,
  generateId,
  SAMPLE_CASES,
  SAMPLE_NOTIFICATIONS,
  SAMPLE_CLIENTS,
  SAMPLE_USERS,
  SAMPLE_INVOICES,
} from "./data";

interface AppContextValue {
  role: UserRole;
  setRole: (r: UserRole) => void;
  adminUnlocked: boolean;
  setAdminUnlocked: (v: boolean) => void;
  cases: LabCase[];
  addCase: (c: Omit<LabCase, "id" | "createdAt" | "updatedAt" | "routeHistory">) => void;
  updateCaseStatus: (caseId: string, newStatus: CaseStatus) => void;
  notifications: Notification[];
  markNotificationRead: (id: string) => void;
  unreadCount: number;
  activeCaseCount: number;
  rushCaseCount: number;
  isLoading: boolean;
  clients: Client[];
  addClient: (c: Omit<Client, "id" | "createdAt">) => void;
  updateClient: (id: string, c: Partial<Client>) => void;
  users: LabUser[];
  addUser: (u: Omit<LabUser, "id" | "createdAt">) => void;
  updateUser: (id: string, u: Partial<LabUser>) => void;
  invoices: Invoice[];
  addInvoice: (inv: Omit<Invoice, "id">) => void;
  updateInvoice: (id: string, inv: Partial<Invoice>) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

const CASES_KEY = "@drivesync_cases";
const ROLE_KEY = "@drivesync_role";
const NOTIFS_KEY = "@drivesync_notifs";
const CLIENTS_KEY = "@drivesync_clients";
const USERS_KEY = "@drivesync_users";
const INVOICES_KEY = "@drivesync_invoices";

export function AppProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<UserRole>("tech");
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [cases, setCases] = useState<LabCase[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [users, setUsers] = useState<LabUser[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const [savedCases, savedRole, savedNotifs, savedClients, savedUsers, savedInvoices] = await Promise.all([
        AsyncStorage.getItem(CASES_KEY),
        AsyncStorage.getItem(ROLE_KEY),
        AsyncStorage.getItem(NOTIFS_KEY),
        AsyncStorage.getItem(CLIENTS_KEY),
        AsyncStorage.getItem(USERS_KEY),
        AsyncStorage.getItem(INVOICES_KEY),
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
    } catch (e) {
      setCases(SAMPLE_CASES);
      setNotifications(SAMPLE_NOTIFICATIONS);
      setClients(SAMPLE_CLIENTS);
      setUsers(SAMPLE_USERS);
      setInvoices(SAMPLE_INVOICES);
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
    const newCase: LabCase = {
      ...c,
      id: generateId(),
      createdAt: now,
      updatedAt: now,
      routeHistory: [{ station: c.status, timestamp: now }],
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
    const updated = cases.map((c) => {
      if (c.id === caseId) {
        return {
          ...c,
          status: newStatus,
          updatedAt: now,
          routeHistory: [
            ...c.routeHistory,
            { station: newStatus, timestamp: now },
          ],
        };
      }
      return c;
    });
    setCases(updated);
    AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));

    const caseInfo = cases.find((c) => c.id === caseId);
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
      const updatedNotifs = [newNotif, ...notifications];
      setNotifications(updatedNotifs);
      AsyncStorage.setItem(NOTIFS_KEY, JSON.stringify(updatedNotifs));
    }
  }

  function markNotificationRead(id: string) {
    const updated = notifications.map((n) =>
      n.id === id ? { ...n, read: true } : n,
    );
    setNotifications(updated);
    AsyncStorage.setItem(NOTIFS_KEY, JSON.stringify(updated));
  }

  function addClient(c: Omit<Client, "id" | "createdAt">) {
    const newClient: Client = { ...c, id: generateId(), createdAt: Date.now() };
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

  const value = useMemo(
    () => ({
      role,
      setRole,
      adminUnlocked,
      setAdminUnlocked,
      cases,
      addCase,
      updateCaseStatus,
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
      invoices,
      addInvoice,
      updateInvoice,
    }),
    [role, adminUnlocked, cases, notifications, unreadCount, activeCaseCount, rushCaseCount, isLoading, clients, users, invoices],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
