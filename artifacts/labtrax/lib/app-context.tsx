import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  useRef,
  ReactNode,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system";
import { getApiUrl, resilientFetch, getAccessToken, uploadCaseMedia, logDebugEvent } from "./query-client";
import {
  enqueuePhoto,
  enqueueNote,
  enqueueStatus,
  drainQueue,
  subscribeToQueueSummary,
  retryItem,
  retryAllStuck,
  discardItem,
  isSyncSuccess,
  syncFailureFromStatus,
  type StuckQueueItem,
  type SyncResult,
} from "./offline-queue";
import { Alert, AppState, Platform } from "react-native";
import {
  UserRole,
  LabCase,
  Notification,
  CaseStatus,
  ActivityEntry,
  ActivityEntryType,
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
} from "@/lib/data";
import { resolvePriceForCase } from "@/lib/pricing";
import {
  generateId,
  isCanonicalCase,
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
  InvoiceLineItem,
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
  addCasePhoto: (caseId: string, photoUri: string, user?: string) => Promise<void>;
  addCaseNote: (caseId: string, note: string, user?: string) => void;
  addCasePhotosWithNote: (caseId: string, photoUris: string[], note: string, user?: string) => Promise<void>;
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
  addClient: (c: Omit<Client, "id" | "clientNumber" | "createdAt" | "accountNumber">) => Client;
  updateClient: (id: string, c: Partial<Client>) => void;
  pricingTiers: PricingTier[];
  updateTierPricing: (tierId: string, prices: Record<string, number>) => void;
  addPricingTier: (name: string) => void;
  users: LabUser[];
  addUser: (u: Omit<LabUser, "id" | "createdAt">) => void;
  updateUser: (id: string, u: Partial<LabUser>) => void;
  removeUser: (id: string) => void;
  invoices: Invoice[];
  addInvoice: (inv: Omit<Invoice, "id">) => string;
  updateInvoice: (id: string, inv: Partial<Invoice>) => void;
  pendingInvoiceEditId: string | null;
  setPendingInvoiceEditId: (id: string | null) => void;
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
  fetchLabDirectory: () => Promise<LabDirectoryGroup[]>;
  sendGroupJoinRequest: (targetAdminUsername: string, requestingUsername: string, message?: string) => Promise<{ success: boolean; error?: string }>;
  respondToGroupJoinRequest: (requestId: string, accept: boolean, role?: "admin" | "user") => Promise<{ success: boolean; error?: string }>;
  labInvitations: LabInvitation[];
  sendLabInvite: (targetUsername: string, targetEmail: string, role: "admin" | "user") => Promise<{ success: boolean; error?: string }>;
  respondToLabInvite: (inviteId: string, accept: boolean) => Promise<{ success: boolean; error?: string }>;
  addConversation: (conv: Conversation) => void;
  removeConversation: (conversationId: string) => void;
  addNotification: (notif: Omit<Notification, "id" | "read" | "timestamp">) => void;
  customStationLabels: Record<string, string>;
  updateStationLabel: (stationId: CaseStatus, label: string) => void;
  userIsAffiliated: boolean;
  labAffiliationReady: boolean;
  activeLabAffiliationKey: string | null;
  activeLabAffiliationName: string | null;
  // Org IDs for EVERY active lab the current user belongs to (not just the
  // singular "active" one). Consumers that need to fetch or display data
  // shared across all of the user's labs (e.g. the lab-shared file inbox)
  // should iterate this list rather than relying on the single
  // activeLabAffiliationKey.
  allLabOrganizationIds: string[];
  // Affiliation keys ("org:<id>") for every active lab the user belongs to.
  // Use this to check membership without relying on practiceName strings.
  allLabAffiliationKeysList: string[];
  leaveLab: () => Promise<{ success: boolean; error?: string }>;
  deleteLab: () => Promise<{ success: boolean; error?: string }>;
  isLabCreator: boolean;
  removeClient: (clientId: string) => void;
  deactivateClient: (clientId: string) => void;
  reactivateClient: (clientId: string) => void;
  deletedClientInvoices: DeletedClientInvoice[];
  inactiveClients: Client[];
  refreshCases: () => Promise<void>;
  fullRefreshCases: () => Promise<void>;
  hardRefresh: () => Promise<void>;
  hydrateInvoiceFromServer: (invoiceId: string) => Promise<void>;
  updateWorkStatus: (status: "available" | "break" | "out_of_office") => Promise<{ success: boolean; error?: string }>;
  invoiceTemplate: { customTexts: any[]; defaultTextBlocks: any[] } | null;
  fetchInvoiceTemplate: () => Promise<void>;
  // Number of offline changes (photos, notes, status moves) still queued and
  // waiting to sync to the server. 0 when everything is up to date.
  pendingSyncCount: number;
  // Offline changes that have repeatedly failed to sync and are no longer
  // retried automatically. Surfaced to the user so they can manually retry or
  // discard them. Empty when nothing is stuck.
  stuckSyncItems: StuckQueueItem[];
  // Reset stuck items so the next drain retries them. Pass an id to retry a
  // single item, or omit to retry all stuck items. Triggers a drain.
  retrySync: (id?: string) => void;
  // Permanently drop a stuck offline change so it stops blocking the queue.
  discardSync: (id: string) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

const CASES_KEY = "@drivesync_cases";
const ROLE_KEY = "@drivesync_role";
const LAB_AFFILIATED_CACHE_KEY = "@drivesync_lab_affiliated";
const NOTIFS_KEY = "@drivesync_notifs";
const CLIENTS_KEY = "@drivesync_clients";
const USERS_KEY = "@drivesync_users";
const INVOICES_KEY = "@drivesync_invoices";
const SHIPPING_KEY = "@drivesync_shipping";
const CONVERSATIONS_KEY = "@drivesync_conversations";
const CHAT_MESSAGES_KEY = "@drivesync_chat_messages";
const PRICING_TIERS_KEY = "@drivesync_pricing_tiers";
const BARCODE_ASSIGNMENTS_KEY = "@drivesync_barcode_assignments";
const STATION_LABELS_KEY = "@drivesync_station_labels";
const DELETED_CLIENT_INVOICES_KEY = "@drivesync_deleted_client_invoices";

type LabDirectoryGroup = {
  organizationId: string;
  practiceName: string;
  username: string;
  practiceAddress?: string;
  memberCount?: number;
};

type ServerMembership = {
  id: string;
  role: string;
  status: string;
  organizationId: string;
  organization?: {
    id: string;
    type?: string;
    name?: string;
    displayName?: string | null;
  } | null;
};

function normalizeAffiliationName(name?: string | null) {
  return name?.trim().toLowerCase() || "";
}

function buildPrivateAffiliationKey(userId?: string | null) {
  return userId ? `private:${userId}` : null;
}

function buildOrganizationAffiliationKey(organizationId?: string | null) {
  return organizationId ? `org:${organizationId}` : null;
}

function buildLegacyLabAffiliationKey(practiceName?: string | null) {
  const normalizedName = normalizeAffiliationName(practiceName);
  return normalizedName ? `lab:${normalizedName}` : null;
}

function resolveCaseAffiliationKeys(labCase: LabCase) {
  const keys = new Set<string>();

  if (labCase.affiliationKey) {
    keys.add(labCase.affiliationKey);
  }

  const legacyLabKey = buildLegacyLabAffiliationKey(labCase.affiliationName);
  if (legacyLabKey) {
    keys.add(legacyLabKey);
  }

  if (keys.size === 0) {
    const privateKey = buildPrivateAffiliationKey(labCase.ownerId);
    if (privateKey) {
      keys.add(privateKey);
    }
  }

  return Array.from(keys);
}

function buildDirectConversationId(usernameA?: string | null, usernameB?: string | null) {
  const normalizedUsers = [usernameA, usernameB]
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => !!value)
    .sort();

  if (normalizedUsers.length < 2) {
    return null;
  }

  return `dm:${normalizedUsers.join("::")}`;
}

function isVideoUri(uri: string): boolean {
  const lower = uri.toLowerCase();
  return lower.includes(".mp4") || lower.includes(".mov") || lower.includes(".m4v") || lower.includes(".avi") || lower.includes(".webm") || lower.includes(".mkv");
}

function inferImageMimeType(imageUri: string) {
  const normalizedUri = imageUri.toLowerCase();
  if (normalizedUri.endsWith(".png")) return "image/png";
  if (normalizedUri.endsWith(".webp")) return "image/webp";
  if (normalizedUri.endsWith(".gif")) return "image/gif";
  if (normalizedUri.endsWith(".heic")) return "image/heic";
  if (normalizedUri.endsWith(".heif")) return "image/heif";
  return "image/jpeg";
}

export function AppProvider({ children }: { children: ReactNode }) {
  const { currentUserId, currentUser, userType, registeredUsers, refreshUsers } = useAuth();
  const [role, setRoleState] = useState<UserRole>("user");
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [allCases, setAllCases] = useState<LabCase[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [users, setUsers] = useState<LabUser[]>([]);
  const invoicesRef = useRef<Invoice[]>([]);
  const [invoices, _setInvoices] = useState<Invoice[]>([]);
  const setInvoices: typeof _setInvoices = (updater) => {
    _setInvoices((prev) => {
      const next =
        typeof updater === "function"
          ? (updater as (p: Invoice[]) => Invoice[])(prev)
          : updater;
      invoicesRef.current = next;
      return next;
    });
  };
  const [pendingInvoiceEditId, setPendingInvoiceEditId] = useState<string | null>(null);
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
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [stuckSyncItems, setStuckSyncItems] = useState<StuckQueueItem[]>([]);
  const [invoiceTemplate, setInvoiceTemplate] = useState<{ customTexts: any[]; defaultTextBlocks: any[] } | null>(null);
  const invoiceTemplateFetchedAtRef = useRef<number>(0);
  const INVOICE_TEMPLATE_TTL_MS = 10 * 60 * 1000;

  const currentUserProfile = useMemo(() => {
    if (!currentUser) return null;
    return registeredUsers.find(u => u.username?.toLowerCase() === currentUser.toLowerCase()) || null;
  }, [currentUser, registeredUsers]);
  const [activeLabAffiliationKey, setActiveLabAffiliationKey] = useState<string | null>(null);
  const [activeLabAffiliationName, setActiveLabAffiliationName] = useState<string | null>(null);
  const [hasActiveLabMembership, setHasActiveLabMembership] = useState(false);
  // True once the first lab-affiliation check (cache or API) has resolved.
  // Banners conditioned on !userIsAffiliated must wait for this to avoid
  // false-positive flashes on every app start for users who belong to a lab.
  const [labAffiliationReady, setLabAffiliationReady] = useState(false);
  const [allLabAffiliationKeysList, setAllLabAffiliationKeysList] = useState<string[]>([]);
  const [allLabAffiliationNamesList, setAllLabAffiliationNamesList] = useState<string[]>([]);
  const [membershipVersion, setMembershipVersion] = useState(0);
  const conversationsStorageKey = useMemo(
    () => (currentUserId ? `${CONVERSATIONS_KEY}:${currentUserId}` : CONVERSATIONS_KEY),
    [currentUserId]
  );
  const chatMessagesStorageKey = useMemo(
    () => (currentUserId ? `${CHAT_MESSAGES_KEY}:${currentUserId}` : CHAT_MESSAGES_KEY),
    [currentUserId]
  );

  const userIsAffiliated = useMemo(() => {
    return hasActiveLabMembership;
  }, [hasActiveLabMembership]);

  const visibleCaseAffiliationKeys = useMemo(() => {
    const keys = new Set<string>();
    const privateAffiliationKey = buildPrivateAffiliationKey(currentUserId);
    if (privateAffiliationKey) {
      keys.add(privateAffiliationKey);
    }

    // Include scope keys for EVERY lab the user is an active member of, not
    // just the singular "active" one. A user added to a lab must see every
    // case in that lab regardless of which device or owner created it, and
    // users who belong to multiple labs (e.g. owners of two practices) should
    // see cases from all of their labs simultaneously. This also avoids a
    // race where a non-deterministic ordering of memberships caused the app
    // to flip between labs and intermittently hide cases.
    for (const labKey of allLabAffiliationKeysList) {
      if (labKey) keys.add(labKey);
    }
    if (activeLabAffiliationKey) {
      keys.add(activeLabAffiliationKey);
    }

    if (hasActiveLabMembership) {
      for (const labName of allLabAffiliationNamesList) {
        const legacyKey = buildLegacyLabAffiliationKey(labName);
        if (legacyKey) keys.add(legacyKey);
      }
      const activeLegacyKey = buildLegacyLabAffiliationKey(activeLabAffiliationName);
      if (activeLegacyKey) keys.add(activeLegacyKey);
    }

    return keys;
  }, [
    activeLabAffiliationKey,
    activeLabAffiliationName,
    allLabAffiliationKeysList,
    allLabAffiliationNamesList,
    currentUserId,
    hasActiveLabMembership,
  ]);
  const visibleCaseAffiliationScope = useMemo(
    () => Array.from(visibleCaseAffiliationKeys).sort(),
    [visibleCaseAffiliationKeys]
  );

  // Bare organization IDs (no "org:" prefix) for every lab the current user
  // belongs to. Used by the lab-shared inbox so files surface from every lab
  // the user is a member of, not just the singular "active" one.
  const allLabOrganizationIds = useMemo(() => {
    const ids: string[] = [];
    for (const labKey of allLabAffiliationKeysList) {
      if (labKey?.startsWith("org:")) {
        ids.push(labKey.slice(4));
      }
    }
    return ids;
  }, [allLabAffiliationKeysList]);

  // The server is the single source of truth for case visibility (see
  // GET /api/legacy/cases — visibility is derived from lab_memberships
  // server-side and the client cannot influence it). The client must NOT
  // re-check lab membership locally, because the local membership snapshot
  // can lag the server (fresh device, network blip, racy load order on
  // app boot, just-joined lab). Re-checking would hide cases the server
  // already authorized, which is the bug we keep getting bitten by.
  //
  // Rules:
  //   • Cases tagged with a lab (affiliationKey "org:<UUID>") are shown
  //     unconditionally — if it lives in our local cache it's because the
  //     server returned it to us, OR we just created it and the server has
  //     accepted it (POST is membership-gated, so it can't enter local with
  //     a lab tag we aren't authorized for).
  //   • Private cases (no "org:" tag) are filtered by ownership so a stale
  //     case left over from a previously-signed-in user on this device does
  //     not leak across accounts.
  const cases = useMemo(() => {
    if (!currentUserId) return [];
    return [...allCases]
      .filter((labCase) => {
        const key =
          typeof labCase.affiliationKey === "string"
            ? labCase.affiliationKey.trim()
            : "";
        if (key.startsWith("org:")) {
          return true;
        }
        return labCase.ownerId === currentUserId;
      })
      .sort(
        (a, b) =>
          (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
      );
  }, [allCases, currentUserId]);

  function setCases(updater: LabCase[] | ((prev: LabCase[]) => LabCase[])) {
    setAllCases(updater);
  }

  async function syncCaseToServer(labCase: LabCase): Promise<SyncResult> {
    const isCanon = isCanonicalCase(labCase as any);
    void logDebugEvent("SYNC_START", { caseId: labCase.id, isCanon, status: labCase.status ?? null, sourceTable: (labCase as any)._sourceTable ?? null });
    try {
      // Canonical (desktop) cases live in the `cases` table, not `lab_cases`.
      // Syncing them via the legacy POST endpoint would try to create a
      // duplicate row in lab_cases and fail with a 403. Use PATCH instead,
      // converting the mobile status token back to the desktop enum value.
      if (isCanon) {
        const MOBILE_TO_DESKTOP_STATUS: Record<string, string> = {
          INTAKE: "received",
          DESIGN: "in_design",
          SCAN: "scan",
          MILL: "in_milling",
          MILLING: "in_milling",
          POST_MILL: "post_mill",
          SINTERING_FURNACE: "sintering_furnace",
          MODEL_ROOM: "model_room",
          PORCELAIN: "in_porcelain",
          QC_CHECK: "qc",
          QC: "qc",
          COMPLETE: "complete",
          SHIP: "shipped",
          DELIVERY: "shipped",
          HOLD: "on_hold",
          ON_HOLD: "on_hold",
          REMAKE: "remake",
        };
        const desktopStatus = labCase.status
          ? MOBILE_TO_DESKTOP_STATUS[labCase.status]
          : undefined;
        if (!desktopStatus) {
          void logDebugEvent("SYNC_CANON_NO_STATUS", { caseId: labCase.id, status: labCase.status ?? null });
          return false;
        }
        const res = await resilientFetch(
          `/api/cases/${encodeURIComponent(labCase.id)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: desktopStatus }),
          }
        );
        void logDebugEvent("SYNC_CANON_PATCH_DONE", { caseId: labCase.id, httpStatus: res?.status ?? -1, ok: res?.ok ?? false });
        return res?.ok ? true : syncFailureFromStatus(res?.status ?? 0);
      }

      const normalizedCase: LabCase = {
        ...labCase,
        ownerId: labCase.ownerId || currentUserId || undefined,
        affiliationName: labCase.affiliationName ?? null,
      };

      let bodyStr: string;
      try {
        bodyStr = JSON.stringify({
          id: normalizedCase.id,
          ownerId: normalizedCase.ownerId || currentUserId,
          caseData: JSON.stringify(normalizedCase),
        });
      } catch (jsonErr) {
        void logDebugEvent("SYNC_JSON_FAIL", { caseId: labCase.id, err: String(jsonErr) });
        return false;
      }

      void logDebugEvent("SYNC_FETCH_START", { caseId: labCase.id, bodySize: bodyStr.length, ownerId: normalizedCase.ownerId ?? null, hasToken: !!getAccessToken() });
      const res = await resilientFetch("/api/legacy/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyStr,
      });
      void logDebugEvent("SYNC_FETCH_DONE", { caseId: labCase.id, httpStatus: res?.status ?? -1, ok: res?.ok ?? false });
      return res?.ok ? true : syncFailureFromStatus(res?.status ?? 0);
    } catch (e) {
      void logDebugEvent("SYNC_CATCH", { caseId: labCase.id, err: String(e) });
      console.log("Could not sync case to server:", e);
      // Thrown fetch — never reached the server (transient network failure).
      return false;
    }
  }

  async function deleteCaseFromServer(caseId: string) {
    try {
      await resilientFetch(`/api/legacy/cases/${caseId}`, { method: "DELETE" });
    } catch (e) {
      console.log("Could not delete case from server:", e);
    }
  }

  // Server decides visibility purely from the authenticated user's lab
  // memberships. The client passes nothing — no scope keys, no viewer id —
  // so a stale UI state can never hide a case that the user is actually
  // entitled to see. We return a discriminated result so the caller can
  // tell "you genuinely have zero cases" (ok=true, cases=[]) apart from
  // "fetch failed, preserve local cache" (ok=false). The previous shape
  // (always returning []) caused us to silently wipe-or-not-wipe based on
  // an ambiguous signal.
  type FetchCasesResult =
    | { ok: true; cases: LabCase[] }
    | { ok: false };

  async function fetchCasesFromServer(): Promise<FetchCasesResult> {
    try {
      const res = await resilientFetch(`/api/legacy/cases`);
      lastFetchStatusRef.current = res.status;
      if (res.ok) {
        try {
          const data = await res.json();
          lastFetchErrRef.current = "";
          return { ok: true, cases: Array.isArray(data?.cases) ? data.cases : [] };
        } catch (parseErr: any) {
          lastFetchErrRef.current = `parse:${String(parseErr?.message || parseErr).slice(0, 60)}`;
          return { ok: false };
        }
      }
      lastFetchErrRef.current = `http:${res.status}`;
      return { ok: false };
    } catch (e: any) {
      lastFetchStatusRef.current = -1;
      lastFetchErrRef.current = `throw:${String(e?.message || e).slice(0, 60)}`;
      console.log("Could not fetch cases from server:", e);
      return { ok: false };
    }
  }

  async function readApiError(response: Response): Promise<string> {
    try {
      const payload = await response.json();
      return payload?.message || payload?.error || "Request failed.";
    } catch {
      return "Request failed.";
    }
  }

  async function fetchMyMemberships(): Promise<ServerMembership[] | null> {
    if (!currentUserId) {
      return [];
    }

    try {
      const response = await resilientFetch("/api/auth/me");
      if (!response.ok) {
        return null;
      }

      const payload = await response.json();
      return Array.isArray(payload.memberships) ? payload.memberships : [];
    } catch {
      return null;
    }
  }

  async function fetchLabDirectory(): Promise<LabDirectoryGroup[]> {
    try {
      const response = await resilientFetch("/api/labs/groups");
      if (!response.ok) {
        return [];
      }

      const payload = await response.json();
      return Array.isArray(payload.groups) ? payload.groups : [];
    } catch {
      return [];
    }
  }

  async function uploadMediaToServer(
    fileBlob: Blob | null,
    nativeUri: string | null,
    filename: string,
    mimeType: string
  ): Promise<string | null> {
    try {
      // Web: materialize the Blob into an object URL so the shared uploader
      // (XHR-based) can stream it. Native: pass the file:// uri directly.
      let fileUri: string | null = nativeUri;
      let objectUrl: string | null = null;
      if (!fileUri && fileBlob && typeof URL?.createObjectURL === "function") {
        objectUrl = URL.createObjectURL(fileBlob);
        fileUri = objectUrl;
      }
      if (!fileUri) return null;

      try {
        const res = await uploadCaseMedia("/api/media/upload", fileUri, filename, mimeType);
        if (!res.ok) return null;
        const data = await res.json();
        return data?.url || null;
      } finally {
        if (objectUrl) {
          try {
            URL.revokeObjectURL(objectUrl);
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      return null;
    }
  }

  async function normalizeSharedImageUri(imageUri?: string | null) {
    if (!imageUri?.trim()) {
      return undefined;
    }

    const normalizedUri = imageUri.trim();

    if (
      normalizedUri.startsWith("http://") ||
      normalizedUri.startsWith("https://")
    ) {
      return normalizedUri;
    }

    if (normalizedUri.startsWith("blob:") && Platform.OS === "web") {
      try {
        const blobResponse = await globalThis.fetch(normalizedUri);
        const blob = await blobResponse.blob();
        const ext = blob.type.split("/")[1] || "jpg";
        const filename = `media-${Date.now()}.${ext}`;
        const uploaded = await uploadMediaToServer(blob, null, filename, blob.type || "image/jpeg");
        if (uploaded) return uploaded;
      } catch {}
      return normalizedUri;
    }

    if (normalizedUri.startsWith("data:") && Platform.OS === "web") {
      try {
        const dataFetch = await globalThis.fetch(normalizedUri);
        const blob = await dataFetch.blob();
        const ext = blob.type.split("/")[1] || "jpg";
        const filename = `media-${Date.now()}.${ext}`;
        const uploaded = await uploadMediaToServer(blob, null, filename, blob.type || "image/jpeg");
        if (uploaded) return uploaded;
      } catch {}
      return normalizedUri;
    }

    if (Platform.OS !== "web") {
      const localUri = normalizedUri.startsWith("file://")
        ? normalizedUri
        : `file://${normalizedUri}`;
      const uriLower = normalizedUri.toLowerCase();
      const isVideo =
        uriLower.endsWith(".mp4") ||
        uriLower.endsWith(".mov") ||
        uriLower.endsWith(".m4v") ||
        uriLower.endsWith(".avi");
      const mimeType = isVideo
        ? uriLower.endsWith(".mov") ? "video/quicktime" : "video/mp4"
        : inferImageMimeType(normalizedUri);
      const extMatch = normalizedUri.match(/\.([a-zA-Z0-9]+)(\?|$)/);
      const ext = extMatch ? extMatch[1] : isVideo ? "mp4" : "jpg";
      const filename = `media-${Date.now()}.${ext}`;
      const uploaded = await uploadMediaToServer(null, localUri, filename, mimeType);
      if (uploaded) return uploaded;
      if (!isVideo) {
        try {
          const base64 = await FileSystem.readAsStringAsync(normalizedUri, {
            encoding: "base64" as any,
          });
          return `data:${inferImageMimeType(normalizedUri)};base64,${base64}`;
        } catch {}
      }
      return normalizedUri;
    }

    return normalizedUri;
  }

  async function fetchChatStateFromServer() {
    if (!currentUserId || !currentUser) {
      return;
    }

    try {
      const response = await resilientFetch("/api/legacy/chat");
      if (!response.ok) {
        return;
      }

      const payload = await response.json();
      const nextConversations = Array.isArray(payload?.conversations)
        ? payload.conversations
        : [];
      const nextMessages = Array.isArray(payload?.messages) ? payload.messages : [];

      setConversations(nextConversations);
      setChatMessages(nextMessages);
      await AsyncStorage.setItem(
        conversationsStorageKey,
        JSON.stringify(nextConversations)
      );
      await AsyncStorage.setItem(chatMessagesStorageKey, JSON.stringify(nextMessages));
    } catch {
      // Keep the last known local chat state on transient failures.
    }
  }

  async function fetchPendingLabJoinRequests() {
    try {
      const response = await resilientFetch("/api/organizations/join-requests/mine/pending");
      if (!response.ok) {
        return [];
      }

      const payload = await response.json();
      return Array.isArray(payload?.data) ? payload.data : [];
    } catch {
      return [];
    }
  }

  function sortMembershipsDeterministically(
    memberships: ServerMembership[]
  ): ServerMembership[] {
    // Stable, deterministic ordering so a user with multiple lab memberships
    // (e.g. an owner of two labs) always picks the SAME lab as their
    // "primary active" lab across reloads and devices. Without this the
    // first-found membership flipped between requests, which silently hid
    // cases from a user whose only lab was not the one picked that round.
    return [...memberships].sort((a, b) => {
      const aId = a.organizationId || "";
      const bId = b.organizationId || "";
      if (aId < bId) return -1;
      if (aId > bId) return 1;
      return 0;
    });
  }

  async function findCurrentLabMembership(): Promise<ServerMembership | null> {
    const memberships = sortMembershipsDeterministically(await fetchMyMemberships() ?? []);
    return (
      memberships.find(
        (membership) =>
          membership.status === "active" &&
          membership.organization?.type === "lab"
      ) || null
    );
  }

  async function findCurrentLabAdminMembership(): Promise<ServerMembership | null> {
    const memberships = sortMembershipsDeterministically(await fetchMyMemberships() ?? []);
    return (
      memberships.find(
        (membership) =>
          membership.status === "active" &&
          membership.organization?.type === "lab" &&
          (membership.role === "owner" || membership.role === "admin")
      ) || null
    );
  }

  // Immediately hydrate membership banner from cache before the API resolves.
  // This prevents the "Join a lab" flash every time the app starts.
  // We also mark labAffiliationReady here so the banner is never shown during
  // the async gap — it only renders once we know the answer (cached or live).
  useEffect(() => {
    if (!currentUserId) return;
    AsyncStorage.getItem(`${LAB_AFFILIATED_CACHE_KEY}:${currentUserId}`)
      .then((cached) => {
        if (cached === "1") setHasActiveLabMembership(true);
        // Cache resolved (either direction) — safe to show/hide the banner.
        setLabAffiliationReady(true);
      })
      .catch(() => {
        // AsyncStorage unavailable — still mark ready so the live-sync result
        // can render when it arrives.
        setLabAffiliationReady(true);
      });
  }, [currentUserId]);

  useEffect(() => {
    let cancelled = false;

    async function syncActiveLabAffiliationState() {
      if (!currentUserId) {
        if (!cancelled) {
          setHasActiveLabMembership(false);
          setActiveLabAffiliationKey(null);
          setActiveLabAffiliationName(null);
          setAllLabAffiliationKeysList([]);
          setAllLabAffiliationNamesList([]);
        }
        return;
      }

      const fetchedMemberships = await fetchMyMemberships();
      if (cancelled) return;
      if (fetchedMemberships === null) {
        return;
      }
      const memberships = sortMembershipsDeterministically(fetchedMemberships);

      const activeLabMemberships = memberships.filter(
        (membership) =>
          membership.status === "active" &&
          membership.organization?.type === "lab"
      );

      const labKeys: string[] = [];
      const labNames: string[] = [];
      for (const membership of activeLabMemberships) {
        const labKey = buildOrganizationAffiliationKey(membership.organizationId);
        if (labKey) labKeys.push(labKey);
        const labName =
          membership.organization?.displayName ||
          membership.organization?.name ||
          null;
        if (labName) labNames.push(labName);
      }

      setAllLabAffiliationKeysList(labKeys);
      setAllLabAffiliationNamesList(labNames);

      const activeMembership = activeLabMemberships[0] || null;

      if (activeMembership?.organizationId) {
        setHasActiveLabMembership(true);
        setLabAffiliationReady(true);
        AsyncStorage.setItem(`${LAB_AFFILIATED_CACHE_KEY}:${currentUserId}`, "1").catch(() => {});
        setActiveLabAffiliationKey(
          buildOrganizationAffiliationKey(activeMembership.organizationId)
        );
        setActiveLabAffiliationName(
          activeMembership.organization?.displayName ||
            activeMembership.organization?.name ||
            null
        );
        return;
      }

      setHasActiveLabMembership(false);
      setLabAffiliationReady(true);
      AsyncStorage.removeItem(`${LAB_AFFILIATED_CACHE_KEY}:${currentUserId}`).catch(() => {});
      setActiveLabAffiliationKey(null);
      setActiveLabAffiliationName(null);
    }

    syncActiveLabAffiliationState().catch(() => {
      if (cancelled) {
        return;
      }
      // Do NOT reset hasActiveLabMembership on network errors — the cache-hydrated
      // value is more reliable than a transient failure. The banner should only
      // show if the API *confirms* no membership, not if it couldn't be reached.
      setActiveLabAffiliationKey(null);
      setActiveLabAffiliationName(null);
      setAllLabAffiliationKeysList([]);
      setAllLabAffiliationNamesList([]);
    });

    return () => {
      cancelled = true;
    };
  }, [
    currentUserId,
    currentUserProfile?.email,
    currentUserProfile?.role,
    currentUserProfile?.practiceName,
    membershipVersion,
  ]);

  // (Removed: legacy "purge cases when active lab clears" effect.)
  //
  // Visibility is now decided by the server from the user's lab memberships
  // and mirrored on the client by the `cases` filter above. Mutating
  // AsyncStorage here based on transient UI state (e.g. switching active
  // labs) was the root cause of cases disappearing across devices: the
  // purge would run on one device, push the deletion-by-omission to the
  // server on the next sync pass, and silently strip the lab's cases for
  // every member. The filter approach achieves the same UX without ever
  // mutating persisted state.

  // ──────────────────────────────────────────────────────────────────────────
  // Cross-device membership sync.
  //
  // When a lab admin (e.g. SDR1's owner) adds or removes a member from another
  // device, that change is invisible to the affected user's app until it
  // re-fetches /api/auth/me. Without an explicit trigger, the app only
  // re-fetches on login, profile change, or in-app accept/leave actions. This
  // means a user who was just added to a lab won't see the lab's cases until
  // they kill and re-open the app.
  //
  // To fix this, we (1) bump membershipVersion every time the app comes back
  // to the foreground, and (2) bump it on a 60-second timer while the app is
  // active. Both are cheap (a single GET /api/auth/me) and resolve the
  // "added/removed remotely" problem within seconds.
  // ──────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!currentUserId) return;

    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        setMembershipVersion((v) => v + 1);
      }
    });

    const intervalMs = 60_000;
    const intervalId = setInterval(() => {
      setMembershipVersion((v) => v + 1);
    }, intervalMs);

    return () => {
      subscription.remove();
      clearInterval(intervalId);
    };
  }, [currentUserId]);

  // ─── Offline queue drain ──────────────────────────────────────────────────
  // Drain any pending photo/note uploads queued while offline.
  //
  // Three triggers:
  //  1. Mount — picks up items left over from a previous session that was
  //     interrupted before the queue was fully drained.
  //  2. AppState "active" — fires when the user brings the app to the
  //     foreground after a background-or-closed stint during which network
  //     may have been unavailable.
  //  3. 30-second interval while the app is foregrounded — handles the
  //     common case where the device regains connectivity while the app
  //     stays open (e.g. Wi-Fi dropping and reconnecting), without
  //     requiring a background/foreground transition.
  useEffect(() => {
    if (!currentUserId) return;

    void drainQueue(rawUploadPhotoToCase, rawPostNoteToCase, rawSyncCaseStatus);

    const appStateSubscription = AppState.addEventListener(
      "change",
      (nextState) => {
        if (nextState === "active") {
          void drainQueue(rawUploadPhotoToCase, rawPostNoteToCase, rawSyncCaseStatus);
        }
      }
    );

    const DRAIN_INTERVAL_MS = 30_000;
    const intervalId = setInterval(() => {
      if (AppState.currentState === "active") {
        void drainQueue(rawUploadPhotoToCase, rawPostNoteToCase, rawSyncCaseStatus);
      }
    }, DRAIN_INTERVAL_MS);

    return () => {
      appStateSubscription.remove();
      clearInterval(intervalId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId]);

  // ─── Pending-sync indicator ────────────────────────────────────────────────
  // Mirror the offline queue's state into React state so the UI can show a
  // "waiting to sync" indicator and, when changes repeatedly fail, a
  // "couldn't sync — tap to retry" prompt. subscribeToQueueSummary fires
  // immediately with the current summary and again after every enqueue, drain,
  // retry, or discard mutation.
  useEffect(() => {
    const unsubscribe = subscribeToQueueSummary((summary) => {
      setPendingSyncCount(summary.total);
      setStuckSyncItems(summary.stuckItems);
    });
    return unsubscribe;
  }, []);

  // Reset stuck items (one or all) and kick off a drain so they retry now.
  function retrySync(id?: string) {
    void (async () => {
      if (id) {
        await retryItem(id);
      } else {
        await retryAllStuck();
      }
      triggerQueueDrain();
    })();
  }

  // Permanently discard a stuck offline change so it stops blocking the queue.
  function discardSync(id: string) {
    void (async () => {
      await discardItem(id);
      // Discarding the wedged head item may unblock the rest of the queue.
      triggerQueueDrain();
    })();
  }

  function mapJoinRequestStatus(status?: string): GroupJoinRequest["status"] {
    if (status === "approved" || status === "accepted") {
      return "accepted";
    }
    if (status === "rejected" || status === "declined") {
      return "declined";
    }
    return "pending";
  }

  function mapInviteStatus(status?: string): LabInvitation["status"] {
    if (status === "accepted") {
      return "accepted";
    }
    if (status === "rejected" || status === "declined") {
      return "declined";
    }
    return "pending";
  }

  async function refreshCollaborationState() {
    if (!currentUserId) {
      setGroupJoinRequests([]);
      setLabInvitations([]);
      return;
    }

    const [adminMembership, pendingInvitesResponse] = await Promise.all([
      findCurrentLabAdminMembership(),
      resilientFetch("/api/organizations/invites/pending-for-me").catch(() => null),
    ]);

    const shouldExpectAdminRequests =
      hasActiveLabMembership && currentUserProfile?.role === "admin";

    if (!adminMembership?.organizationId) {
      if (!shouldExpectAdminRequests) {
        setGroupJoinRequests([]);
      }
    } else {
      try {
        const response = await resilientFetch(
          `/api/organizations/${adminMembership.organizationId}/join-requests`
        );

        if (response.ok) {
          const payload = await response.json();
          const rawRequests = Array.isArray(payload?.data) ? payload.data : [];

          const mappedRequests: GroupJoinRequest[] = rawRequests
            .map((request: any) => {
              const requestingUser = registeredUsers.find(
                (user) => user.id === request.requestedByUserId
              );
              const organizationName =
                adminMembership.organization?.displayName ||
                adminMembership.organization?.name ||
                activeLabAffiliationName ||
                "your lab";

              return {
                id: request.id,
                organizationId: request.organizationId,
                requestingUserId: request.requestedByUserId,
                requestingUsername:
                  requestingUser?.username || request.requestedByUserId || "Unknown User",
                targetAdminUsername: currentUser || "",
                message:
                  request.message ||
                  `${requestingUser?.username || "A user"} would like to join ${organizationName}.`,
                status: mapJoinRequestStatus(request.status),
                createdAt: request.createdAt
                  ? new Date(request.createdAt).getTime()
                  : Date.now(),
              };
            })
            .filter((request: GroupJoinRequest) => request.status === "pending");

          setGroupJoinRequests(mappedRequests);
        }
      } catch {
        // Preserve the current alert list if the refresh fails.
      }
    }

    if (pendingInvitesResponse?.ok) {
      try {
        const payload = await pendingInvitesResponse.json();
        const rawInvites = Array.isArray(payload?.data) ? payload.data : [];
        const mappedInvites: LabInvitation[] = rawInvites
          .map((invite: any) => ({
            id: invite.id,
            organizationId: invite.organizationId,
            token: invite.token,
            adminUsername:
              invite.invitedByUser?.username ||
              invite.organization?.createdByUserId ||
              "Lab Admin",
            adminLabName:
              invite.organization?.displayName ||
              invite.organization?.name ||
              "Lab",
            targetUsername: currentUser || "",
            targetEmail: invite.email || currentUserProfile?.email || "",
            role:
              invite.roleToAssign === "owner" || invite.roleToAssign === "admin"
                ? "admin"
                : "user",
            status: mapInviteStatus(invite.status),
            createdAt: invite.createdAt ? new Date(invite.createdAt).getTime() : Date.now(),
          }))
          .filter((invite: LabInvitation) => invite.status === "pending");

        setLabInvitations(mappedInvites);
      } catch {
        // Preserve the current invite list if the refresh fails.
      }
      return;
    }

    // Preserve the current invite list if the refresh fails.
  }

  // NOTE: admin mode is opt-in. Do NOT auto-promote role to "admin" just
  // because the profile says role==="admin". The previous auto-promote
  // effect created an infinite loop where tapping the Dashboard tab
  // (which resets role to "user") was immediately undone, sending the
  // user back to the Admin Vault lock screen. Admins enter admin mode
  // by tapping "Admin" from the side drawer.

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

  useEffect(() => {
    if (!currentUserId) {
      setGroupJoinRequests([]);
      setLabInvitations([]);
      return;
    }

    refreshCollaborationState();

    const interval = setInterval(() => {
      refreshCollaborationState();
    }, 15000);

    return () => clearInterval(interval);
  }, [
    currentUserId,
    currentUser,
    currentUserProfile?.practiceName,
    currentUserProfile?.email,
    currentUserProfile?.role,
    hasActiveLabMembership,
    activeLabAffiliationName,
    registeredUsers,
  ]);

  useEffect(() => {
    if (!activeLabAffiliationKey || !currentUserId) return;
    setAllCases((prev) => {
      let changed = false;
      const updated = prev.map((c) => {
        if (
          c.ownerId === currentUserId &&
          typeof c.affiliationKey === "string" &&
          c.affiliationKey.startsWith("private:")
        ) {
          changed = true;
          return {
            ...c,
            affiliationKey: activeLabAffiliationKey,
            affiliationName: activeLabAffiliationName ?? c.affiliationName,
            updatedAt: Date.now(),
          };
        }
        return c;
      });
      if (!changed) return prev;
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
      return updated;
    });
  }, [activeLabAffiliationKey, currentUserId]);

  useEffect(() => {
    if (!currentUserId || !currentUser) {
      setConversations([]);
      setChatMessages([]);
      return;
    }

    void fetchChatStateFromServer();

    const interval = setInterval(() => {
      void fetchChatStateFromServer();
    }, 10000);

    return () => clearInterval(interval);
  }, [currentUserId, currentUser, conversationsStorageKey, chatMessagesStorageKey]);

  const prevCasesRef = useRef<LabCase[]>([]);
  // Always mirrors the latest `allCases` so the offline status-drain executor
  // (which is captured by long-lived AppState/interval handlers) can sync the
  // freshest local state of a case rather than a stale closure snapshot.
  const allCasesRef = useRef<LabCase[]>([]);
  // Flips true once loadData() has finished hydrating cases from the local
  // cache. Until then, a case "not found" in allCasesRef means the cache simply
  // hasn't loaded yet (cold-boot race with the offline drain) — NOT that the
  // case was deleted. The status drain uses this to avoid discarding a queued
  // station change before its case has hydrated.
  const casesHydratedRef = useRef(false);
  const syncReadyRef = useRef(false);
  const fetchingRef = useRef(false);
  const inFlightSyncIdsRef = useRef<Set<string>>(new Set());
  const inFlightInvoiceGenIdsRef = useRef<Set<string>>(new Set());
  // One-shot per signed-in session: after the initial server fetch lands, push
  // every local invoice that has no serverId but whose linked case is on the
  // server. This catches invoices stranded on devices because their cases
  // were synced before the invoice-sync work landed (#19, #21, #22, #58),
  // so the desktop web app eventually sees the same invoices the device
  // already shows. Safe to re-run: generateServerInvoiceForCase short-
  // circuits on serverId and the server endpoint is idempotent on case
  // number.
  const invoiceBackfillSweepRanRef = useRef(false);
  // Set to true once the initial server cases fetch has completed for the
  // current session (success OR empty). The sweep effect depends on this
  // state value so it re-runs deterministically once boot finishes,
  // instead of waiting for an unrelated `cases` change.
  const [initialCasesFetchComplete, setInitialCasesFetchComplete] =
    useState(false);

  function pushCaseToServerOnce(c: LabCase) {
    if (!c.ownerId) return;
    if (inFlightSyncIdsRef.current.has(c.id)) return;
    inFlightSyncIdsRef.current.add(c.id);
    void (async () => {
      try {
        const ok = isSyncSuccess(await syncCaseToServer(c));
        if (!ok) return;
        const localInvoice = invoicesRef.current.find((inv) =>
          inv.caseIds?.includes(c.id)
        );
        if (localInvoice && !localInvoice.serverId) {
          await generateServerInvoiceForCase(c.id, localInvoice.id);
        }
      } finally {
        inFlightSyncIdsRef.current.delete(c.id);
      }
    })();
  }

  function mapServerInvoiceStatus(
    s: string | null | undefined
  ): "open" | "sent" | "paid" | "overdue" {
    switch (s) {
      case "paid":
        return "paid";
      case "draft":
      case "open":
      case "partially_paid":
      case "void":
      default:
        return "open";
    }
  }

  function mapMobileInvoiceStatusToServer(
    s: string | null | undefined
  ): "draft" | "open" | "partially_paid" | "paid" | "void" | null {
    switch (s) {
      case "paid":
        return "paid";
      case "open":
      case "sent":
      case "overdue":
        return "open";
      default:
        return null;
    }
  }

  type ServerInvoiceLineItem = {
    id?: string;
    description?: string | null;
    quantity?: string | number | null;
    unitPrice?: string | number | null;
    lineTotal?: string | number | null;
    sortOrder?: number | null;
  };

  type ServerInvoiceRow = {
    id: string;
    invoiceNumber?: string | null;
    status?: string | null;
    notes?: string | null;
    total?: string | number | null;
    balanceDue?: string | number | null;
    issuedAt?: string | null;
    dueAt?: string | null;
    createdAt?: string | null;
    caseId?: string | null;
    providerOrganization?: { id: string; name: string } | null;
    displayMetadata?: Record<string, any> | null;
    displayMetadataJson?: Record<string, any> | null;
    items?: ServerInvoiceLineItem[];
    practiceEmail?: string | null;
    practicePhone?: string | null;
  };

  function readServerDisplayMetadata(
    server: ServerInvoiceRow
  ): Record<string, any> | null {
    return (server.displayMetadata ?? server.displayMetadataJson ?? null) as
      | Record<string, any>
      | null;
  }

  function lineItemsFromServer(
    server: ServerInvoiceRow
  ): InvoiceLineItem[] | null {
    if (!Array.isArray(server.items)) return null;
    const meta = readServerDisplayMetadata(server);
    const metaItems = Array.isArray(meta?.lineItems)
      ? (meta!.lineItems as InvoiceLineItem[])
      : [];
    return server.items.map((it, idx) => {
      const qty = Math.max(0, Math.round(Number(it.quantity ?? 0)));
      const rate = Number(it.unitPrice ?? 0) || 0;
      const amount =
        it.lineTotal !== null && it.lineTotal !== undefined
          ? Number(it.lineTotal) || 0
          : qty * rate;
      const meta = metaItems[idx];
      const description = String(it.description ?? "");
      const metaSubItems = Array.isArray((meta as any)?.subItems) ? (meta as any).subItems as any[] : [];
      const subItems: InvoiceLineItem[] = Array.isArray((it as any).subItems)
        ? (it as any).subItems.map((sub: any, sidx: number) => {
            const subQty = Math.max(0, Math.round(Number(sub.quantity ?? 0)));
            const subRate = Number(sub.unitPrice ?? 0) || 0;
            const subAmount =
              sub.lineTotal !== null && sub.lineTotal !== undefined
                ? Number(sub.lineTotal) || 0
                : subQty * subRate;
            const subDesc = String(sub.description ?? "");
            const subMeta = metaSubItems[sidx];
            return {
              qty: subQty,
              item: subMeta?.item || subDesc || "Item",
              description: subMeta?.description ?? subDesc,
              rate: subRate,
              amount: subAmount,
            };
          })
        : [];
      return {
        qty,
        item: meta?.item || description || "Item",
        description: meta?.description ?? description,
        rate,
        amount,
        subItems: subItems.length ? subItems : undefined,
      };
    });
  }

  function applyServerDisplayMetadata(
    target: Invoice,
    meta: Record<string, any> | null | undefined
  ): Invoice {
    if (!meta || typeof meta !== "object") return target;
    const next = { ...target };
    if (typeof meta.billTo === "string") next.billTo = meta.billTo;
    if (typeof meta.patientName === "string")
      next.patientName = meta.patientName;
    if (typeof meta.teeth === "string") next.teeth = meta.teeth;
    if (typeof meta.shade === "string") next.shade = meta.shade;
    if (typeof meta.caseNotes === "string") next.caseNotes = meta.caseNotes;
    if (typeof meta.caseType === "string") next.caseType = meta.caseType;
    if (typeof meta.clientName === "string") next.clientName = meta.clientName;
    if (typeof meta.credits === "number") next.credits = meta.credits;
    return next;
  }

  function buildDisplayMetadataPayload(inv: Invoice): Record<string, any> {
    return {
      billTo: inv.billTo ?? "",
      patientName: inv.patientName ?? "",
      teeth: inv.teeth ?? "",
      shade: inv.shade ?? "",
      caseNotes: inv.caseNotes ?? "",
      caseType: inv.caseType ?? "",
      clientName: inv.clientName ?? "",
      credits: Number(inv.credits) || 0,
      lineItems: (inv.lineItems || []).map((li) => ({
        item: li.item,
        description: li.description,
        subItems: (li.subItems ?? []).map((sub) => ({
          item: sub.item,
          description: sub.description,
        })),
      })),
    };
  }

  function applyServerInvoiceToLocal(
    local: Invoice,
    server: ServerInvoiceRow
  ): Invoice {
    const totalNum =
      server.total !== null && server.total !== undefined
        ? Number(server.total)
        : NaN;
    let merged: Invoice = {
      ...local,
      serverId: server.id,
      serverUpdatedAt: Date.now(),
      notes: server.notes ?? local.notes,
      status: mapServerInvoiceStatus(server.status) || local.status,
      invoiceNumber: server.invoiceNumber || local.invoiceNumber,
    };
    if (Number.isFinite(totalNum) && totalNum > 0) {
      merged.amount = totalNum;
    }
    if (server.issuedAt) {
      const t = Date.parse(server.issuedAt);
      if (!Number.isNaN(t)) merged.issuedAt = t;
    }
    if (server.dueAt) {
      const t = Date.parse(server.dueAt);
      if (!Number.isNaN(t)) merged.dueAt = t;
    }
    merged = applyServerDisplayMetadata(merged, readServerDisplayMetadata(server));
    const serverItems = lineItemsFromServer(server);
    if (serverItems) {
      merged.lineItems = serverItems;
    }
    if (server.practiceEmail !== undefined) {
      merged.practiceEmail = server.practiceEmail ?? null;
    }
    if (server.practicePhone !== undefined) {
      merged.practicePhone = server.practicePhone ?? null;
    }
    return merged;
  }

  function synthesizeLocalInvoiceFromServer(server: ServerInvoiceRow): Invoice {
    const totalNum =
      server.total !== null && server.total !== undefined
        ? Number(server.total)
        : 0;
    const issuedAt = server.issuedAt
      ? Date.parse(server.issuedAt) || Date.now()
      : server.createdAt
        ? Date.parse(server.createdAt) || Date.now()
        : Date.now();
    const dueAt = server.dueAt
      ? Date.parse(server.dueAt) || issuedAt + 30 * 24 * 60 * 60 * 1000
      : issuedAt + 30 * 24 * 60 * 60 * 1000;
    const base: Invoice = {
      id: generateId(),
      invoiceNumber: server.invoiceNumber || "",
      clientId: "",
      clientName: server.providerOrganization?.name || "",
      caseIds: server.caseId ? [server.caseId] : [],
      amount: Number.isFinite(totalNum) ? totalNum : 0,
      credits: 0,
      status: mapServerInvoiceStatus(server.status),
      issuedAt,
      dueAt,
      billTo: "",
      patientName: "",
      caseType: "",
      teeth: "",
      shade: "",
      caseNotes: "",
      notes: server.notes ?? undefined,
      lineItems: [],
      serverId: server.id,
      serverUpdatedAt: Date.now(),
    };
    const withMeta = applyServerDisplayMetadata(
      base,
      readServerDisplayMetadata(server)
    );
    const serverItems = lineItemsFromServer(server);
    if (serverItems && serverItems.length > 0) withMeta.lineItems = serverItems;
    withMeta.practiceEmail = server.practiceEmail ?? null;
    withMeta.practicePhone = server.practicePhone ?? null;
    return withMeta;
  }

  function mergeServerInvoices(serverRows: ServerInvoiceRow[]) {
    setInvoices((prev) => {
      let changed = false;
      const next = [...prev];
      const byServerId = new Map<string, number>();
      const byInvoiceNumber = new Map<string, number>();
      next.forEach((inv, idx) => {
        if (inv.serverId) byServerId.set(inv.serverId, idx);
        if (inv.invoiceNumber) byInvoiceNumber.set(inv.invoiceNumber, idx);
      });

      for (const server of serverRows) {
        if (!server?.id) continue;
        let idx = byServerId.get(server.id);
        if (idx === undefined && server.invoiceNumber) {
          idx = byInvoiceNumber.get(server.invoiceNumber);
        }
        if (idx !== undefined) {
          const merged = applyServerInvoiceToLocal(next[idx], server);
          const cur = next[idx];
          const lineItemsChanged =
            JSON.stringify(merged.lineItems || []) !==
            JSON.stringify(cur.lineItems || []);
          if (
            merged.notes !== cur.notes ||
            merged.status !== cur.status ||
            merged.amount !== cur.amount ||
            merged.serverId !== cur.serverId ||
            merged.invoiceNumber !== cur.invoiceNumber ||
            merged.issuedAt !== cur.issuedAt ||
            merged.dueAt !== cur.dueAt ||
            merged.billTo !== cur.billTo ||
            merged.patientName !== cur.patientName ||
            merged.teeth !== cur.teeth ||
            merged.shade !== cur.shade ||
            merged.caseNotes !== cur.caseNotes ||
            merged.caseType !== cur.caseType ||
            merged.clientName !== cur.clientName ||
            merged.credits !== cur.credits ||
            merged.practiceEmail !== cur.practiceEmail ||
            merged.practicePhone !== cur.practicePhone ||
            lineItemsChanged
          ) {
            next[idx] = merged;
            changed = true;
          }
        } else {
          const synthesized = synthesizeLocalInvoiceFromServer(server);
          next.unshift(synthesized);
          changed = true;
        }
      }

      if (!changed) return prev;
      AsyncStorage.setItem(INVOICES_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function fetchInvoicesFromServer(): Promise<ServerInvoiceRow[] | null> {
    try {
      const res = await resilientFetch("/api/invoices");
      if (!res.ok) return null;
      const data = await res.json();
      const rows = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data)
          ? data
          : [];
      return rows as ServerInvoiceRow[];
    } catch (e) {
      console.log("Could not fetch invoices from server:", e);
      return null;
    }
  }

  async function refreshInvoicesFromServer() {
    if (!currentUserId) return;
    const rows = await fetchInvoicesFromServer();
    if (rows) mergeServerInvoices(rows);
  }

  async function generateServerInvoiceForCase(
    caseId: string,
    localInvoiceId: string
  ) {
    const existing = invoicesRef.current.find((inv) => inv.id === localInvoiceId);
    if (existing?.serverId) return;
    if (inFlightInvoiceGenIdsRef.current.has(localInvoiceId)) return;
    inFlightInvoiceGenIdsRef.current.add(localInvoiceId);
    try {
      const res = await resilientFetch(
        `/api/invoices/cases/${caseId}/generate-invoice`,
        { method: "POST" }
      );
      if (!res.ok) {
        console.log(
          "Generate invoice failed:",
          caseId,
          res.status,
          await res.text().catch(() => "")
        );
        return;
      }
      const payload = await res.json().catch(() => null);
      const serverInvoice = payload?.data ?? payload;
      const serverInvoiceId: string | undefined = serverInvoice?.id;
      if (!serverInvoiceId) return;
      setInvoices((prev) => {
        let changed = false;
        const next = prev.map((inv) => {
          if (inv.id !== localInvoiceId) return inv;
          if (inv.serverId === serverInvoiceId) return inv;
          changed = true;
          return { ...inv, serverId: serverInvoiceId };
        });
        if (!changed) return prev;
        AsyncStorage.setItem(INVOICES_KEY, JSON.stringify(next));
        return next;
      });
    } catch (e) {
      console.log("Could not generate server invoice:", e);
    } finally {
      inFlightInvoiceGenIdsRef.current.delete(localInvoiceId);
    }
  }

  async function hydrateInvoiceFromServer(invoiceId: string) {
    const target = invoicesRef.current.find((i) => i.id === invoiceId);
    if (!target?.serverId) return;
    try {
      const res = await resilientFetch(`/api/invoices/${target.serverId}`);
      if (!res.ok) return;
      const payload = await res.json();
      const row = (payload?.data ?? payload) as ServerInvoiceRow | null;
      if (!row?.id) return;
      mergeServerInvoices([row]);
    } catch (e) {
      console.log("Could not hydrate invoice from server:", e);
    }
  }

  async function patchInvoiceOnServer(
    serverId: string,
    body: Record<string, any>
  ) {
    try {
      const res = await resilientFetch(`/api/invoices/${serverId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.log(
          "Invoice PATCH failed:",
          serverId,
          res.status,
          await res.text().catch(() => "")
        );
      }
    } catch (e) {
      console.log("Could not PATCH invoice:", e);
    }
  }

  async function refreshCases() {
    if (fetchingRef.current || !currentUserId) {
      return;
    }
    fetchingRef.current = true;
    try {
      const result = await fetchCasesFromServer();
      if (result.ok) {
        mergeServerCases(result.cases);
      }
    } catch (e) {
      console.log("Could not refresh cases:", e);
    } finally {
      fetchingRef.current = false;
    }
  }

  async function fullRefreshCases() {
    if (!currentUserId) {
      return;
    }
    try {
      const result = await fetchCasesFromServer();
      if (!result.ok) {
        // Fetch failed (network/auth blip). Preserve local cache untouched —
        // do not reconcile, do not push, just bail out and let the next
        // poll try again. This avoids wiping legitimate cases on a transient
        // failure.
        return;
      }
      // Server response is authoritative. mergeServerCases reconciles:
      // adopts server payloads, drops local lab-tagged ghosts the server
      // no longer authorizes, preserves local-only private cases.
      mergeServerCases(result.cases);
      // Push any local-only private cases the server may not have yet
      // (e.g. scans created offline). We deliberately do NOT re-push
      // lab-tagged cases that disappeared from the server response —
      // mergeServerCases just dropped them because the server says we
      // can't see them, so re-pushing would only cause a 403/strip cycle.
      const localSnapshot = [...allCases];
      const serverIds = new Set(result.cases.map((s) => s.id));
      for (const c of localSnapshot) {
        if (!c.ownerId) continue;
        if (serverIds.has(c.id)) continue;
        const key =
          typeof c.affiliationKey === "string" ? c.affiliationKey.trim() : "";
        if (key.startsWith("org:")) continue;
        pushCaseToServerOnce(c);
      }
    } catch (e) {
      console.log("Could not full-refresh cases:", e);
    }
  }

  async function hardRefresh() {
    await Promise.all([
      fullRefreshCases(),
      refreshCollaborationState(),
      refreshUsers(),
      refreshInvoicesFromServer(),
    ]);
  }

  async function fetchInvoiceTemplate(): Promise<void> {
    const orgId = allLabOrganizationIds[0];
    if (!orgId) return;
    const now = Date.now();
    if (invoiceTemplate && now - invoiceTemplateFetchedAtRef.current < INVOICE_TEMPLATE_TTL_MS) {
      return;
    }
    try {
      const res = await resilientFetch(`/api/organizations/${encodeURIComponent(orgId)}/invoice-template`);
      const payload = await res.json();
      const template = (payload as any)?.data?.template;
      if (template && Array.isArray(template.customTexts) && Array.isArray(template.defaultTextBlocks)) {
        setInvoiceTemplate({ customTexts: template.customTexts, defaultTextBlocks: template.defaultTextBlocks });
        invoiceTemplateFetchedAtRef.current = Date.now();
      }
    } catch {}
  }

  async function updateWorkStatus(
    status: "available" | "break" | "out_of_office"
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await resilientFetch("/api/auth/me/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workStatus: status }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        return { success: false, error: payload?.message || "Failed to update status." };
      }
      return { success: true };
    } catch {
      return { success: false, error: "Network error updating status." };
    }
  }

  // Update local case state with the authoritative server response.
  // Server payloads win on id matches. Local-only cases (those without an
  // "org:" affiliationKey — private cases not yet synced to any lab) that the
  // server didn't return are preserved so offline-created work isn't lost.
  // Lab-tagged cases not in the server response are dropped (server is
  // authoritative for org cases).
  function mergeServerCases(serverCases: LabCase[]) {
    setAllCases((prev) => {
      const serverIds = new Set(serverCases.map((c) => c.id));
      const localPrivate = prev.filter((c) => {
        if (serverIds.has(c.id)) return false;
        const key = typeof c.affiliationKey === "string" ? c.affiliationKey.trim() : "";
        return !key.startsWith("org:");
      });
      const next = [...serverCases, ...localPrivate];
      const changed =
        next.length !== prev.length ||
        next.some((c, i) => c.id !== prev[i]?.id || c.updatedAt !== prev[i]?.updatedAt);
      if (!changed) return prev;
      void AsyncStorage.setItem(CASES_KEY, JSON.stringify(next));
      prevCasesRef.current = next;
      return next;
    });
  }

  const lastFetchOkRef = useRef<boolean | null>(null);
  const lastFetchCountRef = useRef<number>(-1);
  const lastFetchSampleRef = useRef<string[]>([]);
  const lastFetchStatusRef = useRef<number>(0);
  const lastFetchErrRef = useRef<string>("");

  useEffect(() => {
    if (!currentUserId) {
      syncReadyRef.current = false;
      invoiceBackfillSweepRanRef.current = false;
      return;
    }

    let cancelled = false;
    const localCasesSnapshot = allCases;
    syncReadyRef.current = false;
    fetchingRef.current = true;
    // New session — let the one-shot invoice sweep run again.
    invoiceBackfillSweepRanRef.current = false;
    setInitialCasesFetchComplete(false);

    fetchCasesFromServer()
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result.ok) {
          lastFetchOkRef.current = true;
          lastFetchCountRef.current = result.cases.length;
          lastFetchSampleRef.current = result.cases
            .slice(0, 3)
            .map(
              (c) =>
                `${c.id?.slice(0, 8) || "?"}|${
                  typeof c.affiliationKey === "string"
                    ? c.affiliationKey.slice(0, 40)
                    : "null"
                }|owner=${(c.ownerId || "").slice(0, 8)}`
            );
          // mergeServerCases handles both populated and empty responses
          // correctly: lab-tagged ghosts get reconciled away, private
          // local-only cases are preserved, server payloads win.
          mergeServerCases(result.cases);
        } else {
          lastFetchOkRef.current = false;
          // Fetch failed — keep whatever was loaded from AsyncStorage so
          // the user still sees their previously-synced cases until the
          // next poll succeeds.
          prevCasesRef.current = localCasesSnapshot;
        }
      })
      .finally(() => {
        if (cancelled) {
          return;
        }
        fetchingRef.current = false;
        syncReadyRef.current = true;
        setInitialCasesFetchComplete(true);
      });

    return () => {
      cancelled = true;
      fetchingRef.current = false;
    };
  }, [currentUserId]);

  // One-shot invoice backfill sweep. After cases are reconciled with the
  // server (i.e. once `cases` includes lab-tagged rows the server returned),
  // walk every local invoice that has no serverId and call the existing
  // generate-invoice endpoint for any whose linked case is now on the
  // server. This pushes invoices that were stranded on devices because
  // their cases were synced before the invoice-sync work landed, so the
  // desktop web app picks them up. Runs at most once per signed-in
  // session, batched, and silent on success.
  useEffect(() => {
    if (!currentUserId) return;
    if (invoiceBackfillSweepRanRef.current) return;
    if (!initialCasesFetchComplete) return;

    // Build the set of case ids the server has authorized for us. A
    // lab-tagged case in our local cache is one the server returned, so
    // we know calling generate-invoice for it will succeed (or no-op).
    const syncedCaseIds = new Set<string>();
    for (const c of cases) {
      const key =
        typeof c.affiliationKey === "string" ? c.affiliationKey.trim() : "";
      if (key.startsWith("org:")) {
        syncedCaseIds.add(c.id);
      }
    }
    if (syncedCaseIds.size === 0) {
      // Nothing on the server yet to sweep against; try again next session.
      return;
    }

    invoiceBackfillSweepRanRef.current = true;

    void (async () => {
      const targets: { invoiceId: string; caseId: string }[] = [];
      for (const inv of invoicesRef.current) {
        if (inv.serverId) continue;
        const caseId = inv.caseIds?.find((id) => syncedCaseIds.has(id));
        if (!caseId) continue;
        targets.push({ invoiceId: inv.id, caseId });
      }
      if (targets.length === 0) return;
      // Batch sequentially to avoid spamming the API in one burst when a
      // device has hundreds of stranded invoices.
      for (const t of targets) {
        try {
          await generateServerInvoiceForCase(t.caseId, t.invoiceId);
        } catch {
          // ignore per-invoice failures; the next session's sweep will retry
        }
      }
    })();
  }, [cases, currentUserId, initialCasesFetchComplete]);

  // TEMP DIAGNOSTIC: posts a snapshot of the device's React state to the
  // server so we can read it from deployment logs and find where the
  // 0-cases bug is hiding. Fires 6 s and 30 s after sign-in. Remove once
  // jpp's missing-cases issue is resolved.
  useEffect(() => {
    if (!currentUserId) return;
    let cancelled = false;
    const fire = async (marker: string) => {
      if (cancelled) return;
      try {
        const cached = await AsyncStorage.getItem(CASES_KEY);
        let cacheLen: number | string = "null";
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            cacheLen = Array.isArray(parsed) ? parsed.length : "not-array";
          } catch {
            cacheLen = "parse-error";
          }
        }
        // Inline raw probe — perform our OWN fetch right now from the
        // diagnostic effect, bypassing fetchCasesFromServer entirely, so we
        // can see exactly what the device sees: HTTP status, body byte
        // length, JSON parse success, and the "cases" array length.
        let probeStatus = 0;
        let probeBytes = -1;
        let probeParseOk = false;
        let probeCount = -1;
        let probeErr = "";
        try {
          const probeRes = await resilientFetch("/api/legacy/cases");
          probeStatus = probeRes.status;
          try {
            const text = await probeRes.text();
            probeBytes = text.length;
            try {
              const parsed = JSON.parse(text);
              probeParseOk = true;
              probeCount = Array.isArray(parsed?.cases)
                ? parsed.cases.length
                : -2;
            } catch (pe: any) {
              probeErr = `parse:${String(pe?.message || pe).slice(0, 50)}`;
            }
          } catch (te: any) {
            probeErr = `text:${String(te?.message || te).slice(0, 50)}`;
          }
        } catch (fe: any) {
          probeErr = `throw:${String(fe?.message || fe).slice(0, 50)}`;
        }
        await resilientFetch("/api/_debug/client-state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            marker,
            username: currentUser || "",
            build: "96",
            fetchOk: lastFetchOkRef.current,
            fetchStatus: lastFetchStatusRef.current,
            fetchErr: lastFetchErrRef.current,
            serverCount: lastFetchCountRef.current,
            probeStatus,
            probeBytes,
            probeParseOk,
            probeCount,
            probeErr,
            cacheLen,
            note: "post-signin diagnostic w/ raw probe",
          }),
        });
      } catch {
        // ignore — diagnostic only
      }
    };
    const t1 = setTimeout(() => void fire("T+6s"), 6000);
    const t2 = setTimeout(() => void fire("T+30s"), 30000);
    return () => {
      cancelled = true;
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [currentUserId]);

  useEffect(() => {
    if (!currentUserId) {
      return;
    }

    const interval = setInterval(() => {
      if (fetchingRef.current) return;
      fetchingRef.current = true;
      fetchCasesFromServer()
        .then((result) => {
          if (result.ok) {
            mergeServerCases(result.cases);
          }
        })
        .catch(() => null)
        .finally(() => {
          fetchingRef.current = false;
        });
      void refreshInvoicesFromServer();
    }, 15000);

    void refreshInvoicesFromServer();

    return () => clearInterval(interval);
  }, [currentUserId]);

  // Keep the latest-cases mirror current on every cases change so the offline
  // status drain always syncs the freshest local state of a case.
  useEffect(() => {
    allCasesRef.current = allCases;
  }, [allCases]);

  useEffect(() => {
    if (!syncReadyRef.current || fetchingRef.current || !currentUserId) return;
    const prev = prevCasesRef.current;
    // Only push additions/updates here. Do NOT auto-delete server cases when
    // they go missing from local state — "missing locally" can mean many
    // benign things (refresh returned a partial list, user switched lab/org,
    // affiliation scope changed, server briefly unavailable). Explicit user
    // deletes already call deleteCaseFromServer() inline from removeCase(),
    // so a separate auto-delete pass here would only ever cause data loss.
    for (const c of allCases) {
      if (!c.ownerId) continue;
      const old = prev.find(p => p.id === c.id);
      if (!old || old.updatedAt !== c.updatedAt) {
        pushCaseToServerOnce(c);
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
        AsyncStorage.getItem(conversationsStorageKey),
        AsyncStorage.getItem(chatMessagesStorageKey),
        AsyncStorage.getItem(PRICING_TIERS_KEY),
      ]);

      // CRITICAL: never stomp non-empty state from the local cache. The
      // server fetch (mount effect) runs in parallel with this load and is
      // the authoritative source. If the network response wins the race
      // and populates state with the lab's full case list, blindly calling
      // setAllCases(parsedCases) here would overwrite 46 fresh cases with
      // (possibly stale) cached data. Equally, the empty-cache branch
      // calling setAllCases([]) on a freshly-cleared cache (post-logout
      // sign-in) would wipe the server's response. Always guard with a
      // functional setState that only hydrates from cache when state is
      // empty — the server fetch's reconcileCases handles everything else.
      if (savedCases) {
        try {
          const parsedCases: LabCase[] = JSON.parse(savedCases);
          setAllCases((prev) => {
            const next = prev.length === 0 ? parsedCases : prev;
            // Keep the drain executor's mirror in lockstep so a drain that
            // wins the race against the post-render allCasesRef effect still
            // sees the hydrated case the moment casesHydratedRef flips below.
            allCasesRef.current = next;
            return next;
          });
        } catch {
          // Corrupted cache — leave state alone; the server fetch will
          // populate it.
        }
      }

      // Cache hydration for cases is complete (whether or not anything was
      // cached). From here on, a status item whose case is absent from
      // allCasesRef refers to a genuinely deleted case and may be dropped;
      // before this point it could just be the cold-boot hydration race.
      casesHydratedRef.current = true;

      if (savedRole && savedRole !== "admin") {
        setRoleState(savedRole as UserRole);
      } else if (savedRole === "admin") {
        // Admin vault must always be explicitly re-unlocked — never
        // auto-restore from storage. Clear the stale value so it
        // doesn't affect future boots either.
        AsyncStorage.removeItem(ROLE_KEY).catch(() => {});
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

      setGroupJoinRequests([]);
      setLabInvitations([]);

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
      // Same rule as above: never wipe state from a load error. The server
      // fetch reconciles authoritatively; clearing here can race-stomp a
      // freshly-fetched lab case list.
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
    const privateAffiliationKey = buildPrivateAffiliationKey(currentUserId);
    const fallbackLabAffiliationName = hasActiveLabMembership
      ? activeLabAffiliationName
      : null;
    const fallbackLegacyLabAffiliationKey = hasActiveLabMembership
      ? buildLegacyLabAffiliationKey(fallbackLabAffiliationName)
      : null;
    const caseAffiliationKey =
      activeLabAffiliationKey || fallbackLegacyLabAffiliationKey || privateAffiliationKey;
    const caseAffiliationName =
      caseAffiliationKey && caseAffiliationKey !== privateAffiliationKey
        ? fallbackLabAffiliationName
        : null;
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
      affiliationKey: caseAffiliationKey,
      affiliationName: caseAffiliationName,
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
      const perUnitPrice = resolvePriceForCase(materialStr, c.caseType, c.doctorName, clients, pricingTiers);
      const totalPrice = c.price || (toothCount * perUnitPrice);
      const subtypeMatch = c.notes?.match(/^\[([^\]]+)\]/);
      const subtypeLabel = subtypeMatch ? ` - ${subtypeMatch[1]}` : "";
      lineItems.push({
        qty: toothCount,
        item: materialStr,
        description: `${c.caseType || "Restorative"}${subtypeLabel} - ${toothStr || "N/A"}`,
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
    void logDebugEvent("ADD_CASE_QUEUED", { caseId: newCase.id, affiliationKey: caseAffiliationKey ?? null, ownerId: currentUserId ?? null });
    void (async () => {
      void logDebugEvent("SYNC_IIFE_ENTERED", { caseId: newCase.id });
      const syncResult = await syncCaseToServer(newCase);
      const ok = isSyncSuccess(syncResult);
      void logDebugEvent("SYNC_IIFE_DONE", { caseId: newCase.id, syncResult: String(syncResult), ok });
      if (!ok) {
        // Case is already saved locally and the offline queue will retry the
        // sync once connectivity / authentication is restored. The "offline
        // changes waiting to sync" banner at the top of the screen already
        // surfaces the pending state — a blocking alert here fires mid-form
        // and misleadingly implies data loss when there is none.
        return;
      }
      await generateServerInvoiceForCase(newCase.id, newInvoice.id);
    })();

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
          const shouldFreeBarcode = newStatus === "COMPLETE" && !!c.assignedBarcode;
          const extraEntries: ActivityEntry[] = [stationEntry];
          if (shouldFreeBarcode) {
            extraEntries.push({
              id: generateId(),
              type: "barcode_unassigned",
              timestamp: now,
              description: `Barcode ${c.assignedBarcode} removed from case`,
              user: user || undefined,
            });
          }
          const updatedCase = {
            ...c,
            status: newStatus,
            updatedAt: now,
            assignedBarcode: newStatus === "COMPLETE" ? undefined : c.assignedBarcode,
            routeHistory: [
              ...(c.routeHistory || []),
              { station: newStatus, timestamp: now },
            ],
            activityLog: [...(c.activityLog || []), ...extraEntries],
          };
          // Attempt the status sync immediately; if it fails (offline or a
          // transient error) enqueue it so the offline drain retries it on
          // reconnect — mirroring how photos/notes already drain. Without this
          // the local UI would update but the station change could be silently
          // lost, leaving web/desktop on the old station.
          void (async () => {
            const ok = isSyncSuccess(await syncCaseToServer(updatedCase));
            if (!ok) {
              await enqueueStatus(caseId);
            }
          })();
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

  // ─── Raw executors used by both the hot-path and the offline drain ──────────

  async function rawUploadPhotoToCase(
    caseId: string,
    photoUri: string,
    fileName: string,
    mimeType: string
  ): Promise<SyncResult> {
    try {
      // Use uploadCaseMedia (XHR), NOT resilientFetch — expo/fetch rejects the
      // native { uri, name, type } file descriptor.
      const uploadRes = await uploadCaseMedia("/api/media/upload", photoUri, fileName, mimeType);
      if (!uploadRes?.ok) return syncFailureFromStatus(uploadRes?.status ?? 0);
      const { url } = await uploadRes.json();
      const attachRes = await resilientFetch(
        `/api/cases/${encodeURIComponent(caseId)}/attachments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ storageKey: url, fileName, fileType: mimeType }),
        }
      );
      return attachRes?.ok ? true : syncFailureFromStatus(attachRes?.status ?? 0);
    } catch {
      // Thrown fetch — never reached the server (transient network failure).
      return false;
    }
  }

  async function rawPostNoteToCase(caseId: string, noteText: string): Promise<SyncResult> {
    try {
      const res = await resilientFetch(
        `/api/cases/${encodeURIComponent(caseId)}/notes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ noteText }),
        }
      );
      return res?.ok ? true : syncFailureFromStatus(res?.status ?? 0);
    } catch {
      // Thrown fetch — never reached the server (transient network failure).
      return false;
    }
  }

  // Sync a queued case status/station change. Re-reads the case's latest local
  // state (via the ref so long-lived drain handlers aren't stuck on a stale
  // closure) and pushes it through the same canonical/legacy path as the
  // hot-path.
  //
  // Crucially, "case not found in allCasesRef" is ambiguous on a cold boot: it
  // can mean the case was deleted, OR that loadData() simply hasn't hydrated the
  // cache yet (the mount drain effect can win the race against case loading). We
  // must NOT drop the queued item in the latter case, or an offline station
  // change made before a restart vanishes silently. So:
  //   - case found            → sync it.
  //   - not found, not hydrated → return false (keep it queued; a later drain
  //                               trigger retries once the cache has loaded).
  //   - not found, hydrated    → the case is genuinely gone (deleted); return
  //                               true so the item doesn't wedge the queue.
  async function rawSyncCaseStatus(caseId: string): Promise<SyncResult> {
    const labCase = allCasesRef.current.find((c) => c.id === caseId);
    if (!labCase) return casesHydratedRef.current ? true : false;
    return syncCaseToServer(labCase);
  }

  function triggerQueueDrain() {
    void drainQueue(rawUploadPhotoToCase, rawPostNoteToCase, rawSyncCaseStatus);
  }

  // ─── Public wrappers: attempt immediately, enqueue on failure ────────────

  async function addNoteToCanonicalCase(caseId: string, noteText: string): Promise<void> {
    const itemId = `note-${caseId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const succeeded = isSyncSuccess(await rawPostNoteToCase(caseId, noteText));
    if (!succeeded) {
      await enqueueNote(itemId, caseId, noteText);
    }
  }

  // Upload a local photo/video and create its caseAttachments row in a SINGLE
  // round-trip, returning a URL the app can actually render. This is critical:
  // the bare /api/media/upload endpoint stores a file but creates NO attachment
  // row, and the auth-gated file-serving routes only serve files that have a
  // matching caseAttachments record — so a bare media URL renders blank (404).
  // We therefore upload, create the attachment, and return the canonical
  // id-based serving URL (/api/cases/:caseId/attachments/:id/file), which is
  // same-origin and so receives the bearer token via caseMediaSource. Returns
  // null on any failure so callers can fall back to the local uri + retry queue.
  async function uploadPhotoAndCreateAttachment(
    caseId: string,
    photoUri: string,
  ): Promise<string | null> {
    const uriClean = photoUri.toLowerCase().split("?")[0] ?? "";
    const isVid = isVideoUri(photoUri);
    const ext = uriClean.split(".").pop() || (isVid ? "mp4" : "jpg");
    const mimeType = isVid
      ? ext === "mov" ? "video/quicktime" : `video/${ext}`
      : ext === "pdf" ? "application/pdf"
      : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    const fileName = `case-media-${Date.now()}.${ext}`;
    try {
      const uploadRes = await uploadCaseMedia("/api/media/upload", photoUri, fileName, mimeType);
      if (!uploadRes?.ok) return null;
      const { url } = await uploadRes.json();
      if (!url) return null;
      const attachRes = await resilientFetch(
        `/api/cases/${encodeURIComponent(caseId)}/attachments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ storageKey: url, fileName, fileType: mimeType }),
        }
      );
      if (!attachRes?.ok) return null;
      const body = await attachRes.json();
      const attachmentId = body?.data?.id ?? body?.id;
      if (!attachmentId) {
        // Attachment row was created with storageKey === url, so the
        // filename-based serving route can now resolve it; fall back to that.
        return url;
      }
      const base = getApiUrl().replace(/\/+$/, "");
      return `${base}/api/cases/${encodeURIComponent(caseId)}/attachments/${encodeURIComponent(String(attachmentId))}/file`;
    } catch {
      return null;
    }
  }

  async function addCasePhoto(caseId: string, photoUri: string, user?: string) {
    const now = Date.now();
    const isVid = isVideoUri(photoUri);
    const targetCase = cases.find((c) => c.id === caseId);
    const isCanonical = isCanonicalCase(targetCase as any);

    // Decide what URI to persist. For canonical server cases we MUST store a
    // URL backed by a real caseAttachments row (see uploadPhotoAndCreateAttachment),
    // otherwise the auth-gated serving route 404s and the photo renders blank.
    let storedUri = photoUri;
    let enqueueForRetry = false;
    if (isCanonical) {
      const canonicalUrl = await uploadPhotoAndCreateAttachment(caseId, photoUri);
      if (canonicalUrl) {
        storedUri = canonicalUrl;
      } else {
        // Offline / upload failed: keep the local uri for on-device preview and
        // queue the upload so it syncs once connectivity returns.
        enqueueForRetry = true;
      }
    } else {
      // The /api/cases/:caseId/attachments endpoint handles both canonical case
      // IDs (caseId FK) and legacy lab_cases IDs (labCaseId FK). Try the proper
      // server upload path so the photo appears in the web/desktop Files tab for
      // the same Case ID; fall back to a normalized local URI only on failure.
      const serverUrl = await uploadPhotoAndCreateAttachment(caseId, photoUri);
      if (serverUrl) {
        storedUri = serverUrl;
      } else {
        storedUri = (await normalizeSharedImageUri(photoUri)) || photoUri;
        enqueueForRetry = true;
      }
    }

    const photoEntry: ActivityEntry = {
      id: generateId(),
      type: isVid ? "video" : "photo",
      timestamp: now,
      description: isVid ? "Video added to case" : "Photo added to case",
      imageUri: storedUri,
      user: user || undefined,
    };
    setCases((prevCases) => {
      const updated = prevCases.map((c) => {
        if (c.id === caseId) {
          const updatedCase = {
            ...c,
            updatedAt: now,
            photos: [...(c.photos || []), storedUri],
            activityLog: [...(c.activityLog || []), photoEntry],
          };
          void syncCaseToServer(updatedCase);
          return updatedCase;
        }
        return c;
      });
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
      return updated;
    });

    if (enqueueForRetry) {
      const uriClean = photoUri.toLowerCase().split("?")[0] ?? "";
      const ext = uriClean.split(".").pop() || (isVid ? "mp4" : "jpg");
      const mimeType = isVid
        ? ext === "mov" ? "video/quicktime" : `video/${ext}`
        : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      const fileName = `case-media-${Date.now()}.${ext}`;
      const itemId = `photo-${caseId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await enqueuePhoto(itemId, caseId, photoUri, fileName, mimeType);
    }
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
          const updatedCase = {
            ...c,
            updatedAt: now,
            notes: c.notes ? `${c.notes}\n${note}` : note,
            activityLog: [...(c.activityLog || []), noteEntry],
          };
          void syncCaseToServer(updatedCase);
          if (isCanonicalCase(c as any)) {
            void addNoteToCanonicalCase(caseId, note);
          }
          return updatedCase;
        }
        return c;
      });
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  async function addCasePhotosWithNote(caseId: string, photoUris: string[], note: string, user?: string) {
    const now = Date.now();
    const targetCase = cases.find((c) => c.id === caseId);
    const isCanonical = isCanonicalCase(targetCase as any);

    // Resolve each local uri to a renderable, persistable uri. For canonical
    // server cases this uploads + creates the attachment row so the serving
    // route can actually return the file (otherwise it 404s → blank). isVid is
    // derived from the ORIGINAL uri because the canonical serving URL has no
    // file extension to sniff.
    const resolved = await Promise.all(
      photoUris.map(async (originalUri) => {
        const isVid = isVideoUri(originalUri);
        if (isCanonical) {
          const canonicalUrl = await uploadPhotoAndCreateAttachment(caseId, originalUri);
          if (canonicalUrl) return { storedUri: canonicalUrl, isVid, retry: false, originalUri };
          return { storedUri: originalUri, isVid, retry: true, originalUri };
        }
        const shared = (await normalizeSharedImageUri(originalUri)) || originalUri;
        return { storedUri: shared, isVid, retry: false, originalUri };
      })
    );

    const normalizedUris = resolved.map((r) => r.storedUri);

    const photoEntries: ActivityEntry[] = resolved.map((r, i) => ({
      id: generateId(),
      type: (r.isVid ? "video" : "photo") as ActivityEntryType,
      timestamp: now + i,
      description: r.isVid ? "Video added to case" : "Photo added to case",
      imageUri: r.storedUri,
      user: user || undefined,
    }));

    const noteEntry: ActivityEntry | null = note.trim()
      ? {
          id: generateId(),
          type: "note" as const,
          timestamp: now,
          description: note.trim(),
          user: user || undefined,
        }
      : null;

    setCases((prevCases) => {
      const updated = prevCases.map((c) => {
        if (c.id === caseId) {
          const updatedCase = {
            ...c,
            updatedAt: now,
            photos: [...(c.photos || []), ...normalizedUris],
            activityLog: [
              ...(c.activityLog || []),
              ...photoEntries,
              ...(noteEntry ? [noteEntry] : []),
            ],
          };
          void syncCaseToServer(updatedCase);
          if (isCanonical && noteEntry) {
            void addNoteToCanonicalCase(caseId, noteEntry.description);
          }
          return updatedCase;
        }
        return c;
      });
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
      return updated;
    });

    // Queue any uploads that failed (offline) so they sync when back online.
    for (const r of resolved) {
      if (!r.retry) continue;
      const uriClean = r.originalUri.toLowerCase().split("?")[0] ?? "";
      const ext = uriClean.split(".").pop() || (r.isVid ? "mp4" : "jpg");
      const mimeType = r.isVid
        ? ext === "mov" ? "video/quicktime" : `video/${ext}`
        : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      const fileName = `case-media-${Date.now()}.${ext}`;
      const itemId = `photo-${caseId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await enqueuePhoto(itemId, caseId, r.originalUri, fileName, mimeType);
    }
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
          const caseForPrice = cases.find(cc => cc.id === caseId);
          const unitPrice = resolvePriceForCase(mat, caseType, caseForPrice?.doctorName || "", clients, pricingTiers);
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
            activityLog: [...(c.activityLog || []), newActivity],
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

  function addClient(c: Omit<Client, "id" | "clientNumber" | "createdAt" | "accountNumber">): Client {
    const maxNum = clients.reduce((max, cl) => Math.max(max, cl.clientNumber || 0), 0);
    const newClient: Client = { ...c, id: generateId(), clientNumber: maxNum + 1, accountNumber: "DS-" + Date.now().toString().slice(-6), createdAt: Date.now() };
    const updated = [newClient, ...clients];
    setClients(updated);
    AsyncStorage.setItem(CLIENTS_KEY, JSON.stringify(updated));
    return newClient;
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

  function addInvoice(inv: Omit<Invoice, "id">): string {
    const newInv: Invoice = { ...inv, id: generateId() };
    const updated = [newInv, ...invoices];
    setInvoices(updated);
    AsyncStorage.setItem(INVOICES_KEY, JSON.stringify(updated));
    return newInv.id;
  }

  function updateInvoice(id: string, inv: Partial<Invoice>) {
    setInvoices((prev) => {
      const updated = prev.map((i) => (i.id === id ? { ...i, ...inv } : i));
      AsyncStorage.setItem(INVOICES_KEY, JSON.stringify(updated));

      const target = updated.find((i) => i.id === id);
      if (target?.serverId) {
        const body: Record<string, any> = {};
        if (Object.prototype.hasOwnProperty.call(inv, "notes")) {
          body.notes = inv.notes ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(inv, "status")) {
          const mapped = mapMobileInvoiceStatusToServer(inv.status);
          if (mapped) body.status = mapped;
        }
        if (Object.prototype.hasOwnProperty.call(inv, "invoiceNumber") && inv.invoiceNumber) {
          body.invoiceNumber = inv.invoiceNumber;
        }
        if (Object.prototype.hasOwnProperty.call(inv, "issuedAt") && typeof inv.issuedAt === "number") {
          body.issuedAt = new Date(inv.issuedAt).toISOString();
        }
        if (Object.prototype.hasOwnProperty.call(inv, "dueAt") && typeof inv.dueAt === "number") {
          body.dueAt = new Date(inv.dueAt).toISOString();
        }
        if (Object.prototype.hasOwnProperty.call(inv, "lineItems") && Array.isArray(inv.lineItems)) {
          body.items = inv.lineItems.map((li, idx) => ({
            description:
              (li.description && li.description.trim()) ||
              li.item ||
              "Item",
            quantity: Math.max(0, Math.round(Number(li.qty) || 0)),
            unitPrice: Number(li.rate) || 0,
            sortOrder: idx,
            subItems: (li.subItems ?? []).map((sub, sidx) => ({
              description:
                (sub.description && sub.description.trim()) ||
                sub.item ||
                "Item",
              quantity: Math.max(0, Math.round(Number(sub.qty) || 0)),
              unitPrice: Number(sub.rate) || 0,
              sortOrder: sidx,
            })),
          }));
        }
        const metaTouchKeys = [
          "lineItems",
          "credits",
          "billTo",
          "patientName",
          "teeth",
          "shade",
          "caseNotes",
          "caseType",
          "clientName",
        ];
        const metaTouched = metaTouchKeys.some((k) =>
          Object.prototype.hasOwnProperty.call(inv, k)
        );
        if (metaTouched) {
          body.displayMetadata = buildDisplayMetadataPayload(target);
        }
        if (Object.keys(body).length > 0) {
          void patchInvoiceOnServer(target.serverId, body);
        }
      }

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
    if (!currentUser) {
      return;
    }

    const trimmedContent = content.trim();
    if (!trimmedContent && !imageUri) {
      return;
    }

    const isLabChannel = conversationId.startsWith("lab:");
    const targetConversation =
      conversations.find((conversation) => conversation.id === conversationId) || null;
    const targetUsername = isLabChannel ? null : targetConversation?.clientName?.trim();
    const resolvedConversationId = isLabChannel
      ? conversationId
      : buildDirectConversationId(currentUser, targetUsername) || conversationId;

    if (!isLabChannel && !targetUsername) {
      return;
    }

    const timestamp = Date.now();
    const optimisticMessage: ChatMessage = {
      id: generateId(),
      conversationId: resolvedConversationId,
      senderId: currentUser,
      senderType: "lab",
      content: trimmedContent,
      imageUri,
      timestamp,
      read: true,
    };

    setChatMessages((prev) => {
      const updated = [...prev, optimisticMessage];
      AsyncStorage.setItem(chatMessagesStorageKey, JSON.stringify(updated));
      return updated;
    });
    setConversations((prev) => {
      const nextConversation: Conversation =
        targetConversation || {
          id: resolvedConversationId,
          clientId: resolvedConversationId,
          clientName: targetUsername ?? "",
          lastMessage: imageUri ? "Photo" : trimmedContent,
          lastMessageTime: timestamp,
          unreadCount: 0,
        };
      const updatedConversation = {
        ...nextConversation,
        lastMessage: imageUri ? "Photo" : trimmedContent,
        lastMessageTime: timestamp,
        unreadCount: 0,
      };
      const updated = [
        updatedConversation,
        ...prev.filter((conversation) => conversation.id !== updatedConversation.id),
      ];
      AsyncStorage.setItem(conversationsStorageKey, JSON.stringify(updated));
      return updated;
    });

    void (async () => {
      try {
        const sharedImageUri = imageUri
          ? await normalizeSharedImageUri(imageUri)
          : undefined;
        const isLabChannel = resolvedConversationId.startsWith("lab:");
        const response = await resilientFetch("/api/legacy/chat/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: resolvedConversationId,
            ...(isLabChannel
              ? { labChannelId: resolvedConversationId }
              : { targetUsername }),
            content: trimmedContent,
            imageUri: sharedImageUri,
          }),
        });

        if (response.ok) {
          await fetchChatStateFromServer();
        }
      } catch {
        // Preserve the optimistic local message until the next successful sync.
      }
    })();
  }

  async function sendGroupJoinRequest(
    targetAdminUsername: string,
    requestingUsername: string,
    message?: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!currentUserId) {
      return { success: false, error: "You must be signed in to send a request." };
    }

    const labGroups = await fetchLabDirectory();
    const normalizedTarget = targetAdminUsername.trim().toLowerCase();
    const targetGroup = labGroups.find(
      (group) => group.username.toLowerCase() === normalizedTarget
    );

    if (!targetGroup) {
      return { success: false, error: "That lab administrator could not be found." };
    }

    try {
      const response = await resilientFetch(
        `/api/organizations/${targetGroup.organizationId}/join-requests`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestedRole: currentUserProfile?.role === "admin" ? "admin" : "user",
            message:
              message || `${requestingUsername} would like to join ${targetGroup.practiceName}.`,
          }),
        }
      );

      if (!response.ok) {
        return { success: false, error: await readApiError(response) };
      }

      await refreshCollaborationState();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message || "Could not send the join request." };
    }
  }

  async function respondToGroupJoinRequest(
    requestId: string,
    accept: boolean,
    role?: "admin" | "user"
  ): Promise<{ success: boolean; error?: string }> {
    const request = groupJoinRequests.find((entry) => entry.id === requestId);
    if (!request) {
      return { success: false, error: "Join request not found." };
    }

    try {
      const endpoint = accept
        ? `/api/organizations/join-requests/${requestId}/approve`
        : `/api/organizations/join-requests/${requestId}/reject`;
      const response = await resilientFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(accept ? { role: role || "user" } : {}),
      });

      if (!response.ok) {
        return { success: false, error: await readApiError(response) };
      }

      const requestingUser = registeredUsers.find(
        (user) =>
          user.id === request.requestingUserId ||
          user.username.toLowerCase() === request.requestingUsername.toLowerCase()
      );

      if (accept && requestingUser?.userType === "provider") {
        const doctorLabel = requestingUser.doctorName
          ? requestingUser.accountNumber
            ? `Dr. ${requestingUser.doctorName} ${formatAcctNum(requestingUser.accountNumber)}`
            : `Dr. ${requestingUser.doctorName}`
          : `Dr. ${requestingUser.username}`;
        const alreadyClient = clients.some(
          (client) =>
            client.leadDoctor.toLowerCase() === doctorLabel.toLowerCase() ||
            (requestingUser.doctorName &&
              client.leadDoctor
                .toLowerCase()
                .includes(requestingUser.doctorName.toLowerCase())) ||
            (requestingUser.practiceName &&
              client.practiceName.toLowerCase() ===
                requestingUser.practiceName.toLowerCase())
        );

        if (!alreadyClient) {
          addClient({
            practiceName:
              requestingUser.practiceName ||
              `${requestingUser.doctorName || requestingUser.username}'s Practice`,
            leadDoctor: doctorLabel,
            phone: requestingUser.practicePhone || requestingUser.phone || "",
            email: requestingUser.email || "",
            address: requestingUser.practiceAddress || "",
            tier: "Standard",
            discountRate: 0,
          });
        }
      }

      await refreshUsers();
      await refreshCollaborationState();

      addNotification({
        title: accept ? "Lab Join Request Accepted" : "Lab Join Request Declined",
        message: accept
          ? `${request.requestingUsername} has been added to ${currentUserProfile?.practiceName || "your lab"} as ${role === "admin" ? "an admin" : "a user"}.`
          : `${request.requestingUsername}'s request to join ${currentUserProfile?.practiceName || "your lab"} was declined.`,
        type: accept ? "update" : "alert",
      });

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message || "Could not update the join request." };
    }
  }

  async function sendLabInvite(
    targetUsername: string,
    targetEmail: string,
    role: "admin" | "user"
  ): Promise<{ success: boolean; error?: string }> {
    const activeLabAdminMembership = await findCurrentLabAdminMembership();
    if (!currentUser || !activeLabAdminMembership?.organizationId) {
      return { success: false, error: "You must be a lab admin to send invitations." };
    }

    const targetUser = registeredUsers.find(
      (user) =>
        user.username.toLowerCase() === targetUsername.toLowerCase() &&
        user.email?.toLowerCase() === targetEmail.toLowerCase()
    );

    if (!targetUser) {
      return {
        success: false,
        error: "No user found with that username and email combination.",
      };
    }

    try {
      const response = await resilientFetch(
        `/api/organizations/${activeLabAdminMembership.organizationId}/invites`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: targetUser.email || targetEmail,
            roleToAssign: role === "admin" ? "admin" : "user",
            expiresInDays: 7,
          }),
        }
      );

      if (!response.ok) {
        return { success: false, error: await readApiError(response) };
      }

      addNotification({
        title: "Lab Invitation Sent",
        message: `Invitation sent to ${targetUser.username} to join ${currentUserProfile?.practiceName || "your lab"} as ${role === "admin" ? "an admin" : "a user"}.`,
        type: "update",
      });

      await refreshCollaborationState();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message || "Could not send the invitation." };
    }
  }

  async function respondToLabInvite(
    inviteId: string,
    accept: boolean
  ): Promise<{ success: boolean; error?: string }> {
    const invite = labInvitations.find((entry) => entry.id === inviteId);
    if (!invite) {
      return { success: false, error: "Invitation not found." };
    }

    if (accept && !invite.token) {
      return { success: false, error: "This invitation is missing its acceptance token." };
    }

    try {
      const endpoint = accept
        ? `/api/organizations/invites/${invite.token}/accept`
        : `/api/organizations/invites/${invite.id}/decline`;
      const response = await resilientFetch(endpoint, { method: "POST" });

      if (!response.ok) {
        return { success: false, error: await readApiError(response) };
      }

      await refreshUsers();
      await refreshCollaborationState();

      if (accept) {
        setMembershipVersion((v) => v + 1);
      }

      addNotification({
        title: accept ? "Lab Invitation Accepted" : "Lab Invitation Declined",
        message: accept
          ? `You joined ${invite.adminLabName} as ${invite.role === "admin" ? "an admin" : "a user"}.`
          : `You declined the invitation to join ${invite.adminLabName}.`,
        type: accept ? "update" : "alert",
      });

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message || "Could not update the invitation." };
    }
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
      const activeLabMembership = await findCurrentLabMembership();
      const departingLabKey = activeLabAffiliationKey;

      if (activeLabMembership?.id) {
        const response = await resilientFetch(
          `/api/organizations/memberships/${activeLabMembership.id}`,
          { method: "DELETE" }
        );
        if (!response.ok) {
          return { success: false, error: await readApiError(response) };
        }
      } else {
        const pendingJoinRequests = await fetchPendingLabJoinRequests();

        for (const request of pendingJoinRequests) {
          if (!request?.id) {
            continue;
          }

          const cancelResponse = await resilientFetch(
            `/api/organizations/join-requests/${request.id}`,
            { method: "DELETE" }
          );
          if (!cancelResponse.ok) {
            return { success: false, error: await readApiError(cancelResponse) };
          }
        }

        const profileResponse = await resilientFetch(
          `/api/auth/users/${currentUserId}/profile`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ practiceName: "", role: "user" }),
          }
        );

        if (!profileResponse.ok) {
          return { success: false, error: await readApiError(profileResponse) };
        }
      }

      setHasActiveLabMembership(false);
      setActiveLabAffiliationKey(null);
      setActiveLabAffiliationName(null);
      setMembershipVersion((v) => v + 1);

      if (departingLabKey) {
        setAllCases((prev) => {
          const filtered = prev.filter(
            (c) => !resolveCaseAffiliationKeys(c).includes(departingLabKey)
          );
          AsyncStorage.setItem(CASES_KEY, JSON.stringify(filtered));
          return filtered;
        });
      }

      await refreshUsers();
      await refreshCollaborationState();
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || "Failed to leave lab" };
    }
  }

  async function deleteLab(): Promise<{ success: boolean; error?: string }> {
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
      await refreshUsers();
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || "Failed to delete lab" };
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
    if (!barcode) return undefined;
    const q = barcode.trim();
    // Match by assigned barcode first, then fall back to case number so that
    // scanning a QR code printed with the case number also works.
    return (
      cases.find((c) => c.assignedBarcode === q && c.status !== "COMPLETE") ??
      cases.find((c) => (c.caseNumber || "").trim() === q && c.status !== "COMPLETE")
    );
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
          const updatedCase = {
            ...c,
            status: newStatus,
            assignedBarcode: c.assignedBarcode,
            updatedAt: now,
            routeHistory: [...(c.routeHistory || []), { station: newStatus, timestamp: now }],
            activityLog: [...(c.activityLog || []), stationEntry],
          };
          // Sync to server so web/desktop see the updated location.
          // Mirrors updateCaseStatus: attempt immediately and fall back to
          // the offline queue if the request fails, so the change is never
          // silently lost on a transient network error.
          void (async () => {
            const ok = isSyncSuccess(await syncCaseToServer(updatedCase));
            if (!ok) {
              await enqueueStatus(c.id);
            }
          })();
          return updatedCase;
        }
        return c;
      });
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  function addConversation(conv: Conversation) {
    setConversations(prev => {
      const updated = [conv, ...prev.filter((existing) => existing.id !== conv.id)];
      AsyncStorage.setItem(conversationsStorageKey, JSON.stringify(updated));
      return updated;
    });
  }

  function removeConversation(conversationId: string) {
    setConversations(prev => {
      const updated = prev.filter(c => c.id !== conversationId);
      AsyncStorage.setItem(conversationsStorageKey, JSON.stringify(updated));
      return updated;
    });
    setChatMessages(prev => {
      const updated = prev.filter(m => m.conversationId !== conversationId);
      AsyncStorage.setItem(chatMessagesStorageKey, JSON.stringify(updated));
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
      AsyncStorage.setItem(chatMessagesStorageKey, JSON.stringify(updated));
      return updated;
    });
    setConversations(prev => {
      const updated = prev.map(c => {
        if (c.id === conversationId) {
          return { ...c, unreadCount: 0 };
        }
        return c;
      });
      AsyncStorage.setItem(conversationsStorageKey, JSON.stringify(updated));
      return updated;
    });
    void resilientFetch("/api/legacy/chat/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId }),
    }).then(() => fetchChatStateFromServer()).catch(() => null);
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
      addCasePhotosWithNote,
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
      pendingInvoiceEditId,
      setPendingInvoiceEditId,
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
      fetchLabDirectory,
      sendGroupJoinRequest,
      respondToGroupJoinRequest,
      labInvitations,
      sendLabInvite,
      respondToLabInvite,
      addConversation,
      removeConversation,
      addNotification,
      customStationLabels,
      updateStationLabel,
      userIsAffiliated,
      labAffiliationReady,
      activeLabAffiliationKey,
      activeLabAffiliationName,
      allLabOrganizationIds,
      allLabAffiliationKeysList,
      leaveLab,
      deleteLab,
      isLabCreator,
      removeClient,
      deactivateClient,
      reactivateClient,
      deletedClientInvoices,
      inactiveClients: clients.filter(c => c.status === "inactive"),
      refreshCases,
      fullRefreshCases,
      hydrateInvoiceFromServer,
      hardRefresh,
      updateWorkStatus,
      invoiceTemplate,
      fetchInvoiceTemplate,
      pendingSyncCount,
      stuckSyncItems,
      retrySync,
      discardSync,
    }),
    [role, adminUnlocked, cases, notifications, unreadCount, activeCaseCount, rushCaseCount, isLoading, clients, pricingTiers, users, invoices, pendingInvoiceEditId, shippingAccounts, conversations, chatMessages, totalUnreadMessages, groupJoinRequests, labInvitations, inventory, customStationLabels, userIsAffiliated, labAffiliationReady, isLabCreator, deletedClientInvoices, currentUser, currentUserId, currentUserProfile, registeredUsers, allLabOrganizationIds, activeLabAffiliationKey, activeLabAffiliationName, allLabAffiliationKeysList, invoiceTemplate, pendingSyncCount, stuckSyncItems],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
