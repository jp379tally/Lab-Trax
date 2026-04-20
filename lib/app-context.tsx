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
import { getApiUrl, resilientFetch, getAccessToken } from "./query-client";
import { Platform } from "react-native";
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
  activeLabAffiliationKey: string | null;
  activeLabAffiliationName: string | null;
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
  updateWorkStatus: (status: "available" | "break" | "out_of_office") => Promise<{ success: boolean; error?: string }>;
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

  const currentUserProfile = useMemo(() => {
    if (!currentUser) return null;
    return registeredUsers.find(u => u.username?.toLowerCase() === currentUser.toLowerCase()) || null;
  }, [currentUser, registeredUsers]);
  const [activeLabAffiliationKey, setActiveLabAffiliationKey] = useState<string | null>(null);
  const [activeLabAffiliationName, setActiveLabAffiliationName] = useState<string | null>(null);
  const [hasActiveLabMembership, setHasActiveLabMembership] = useState(false);
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

    if (activeLabAffiliationKey) {
      keys.add(activeLabAffiliationKey);
    }

    const legacyLabAffiliationKey = hasActiveLabMembership
      ? buildLegacyLabAffiliationKey(activeLabAffiliationName)
      : null;
    if (legacyLabAffiliationKey) {
      keys.add(legacyLabAffiliationKey);
    }

    return keys;
  }, [activeLabAffiliationKey, activeLabAffiliationName, currentUserId, hasActiveLabMembership]);
  const visibleCaseAffiliationScope = useMemo(
    () => Array.from(visibleCaseAffiliationKeys).sort(),
    [visibleCaseAffiliationKeys]
  );

  const cases = useMemo(() => {
    if (!currentUserId) return [];
    return [...allCases]
      .filter((labCase) =>
        resolveCaseAffiliationKeys(labCase).some((key) =>
          visibleCaseAffiliationKeys.has(key)
        )
      )
      .sort(
        (a, b) =>
          (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
      );
  }, [allCases, currentUserId, visibleCaseAffiliationKeys]);

  function setCases(updater: LabCase[] | ((prev: LabCase[]) => LabCase[])) {
    setAllCases(updater);
  }

  async function syncCaseToServer(labCase: LabCase) {
    try {
      const normalizedCase: LabCase = {
        ...labCase,
        ownerId: labCase.ownerId || currentUserId || undefined,
        affiliationName: labCase.affiliationName ?? null,
      };
      await resilientFetch("/api/legacy/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: normalizedCase.id,
          ownerId: normalizedCase.ownerId || currentUserId,
          caseData: JSON.stringify(normalizedCase),
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

  async function fetchCasesFromServer(
    scopeKeys: string[],
    viewerUserId?: string | null
  ): Promise<LabCase[]> {
    try {
      const normalizedScopeKeys = Array.from(
        new Set(scopeKeys.filter((value): value is string => !!value))
      );
      if (!viewerUserId || normalizedScopeKeys.length === 0) return [];

      const params = new URLSearchParams({
        viewerUserId,
        scopeKeys: normalizedScopeKeys.join(","),
      });
      const res = await resilientFetch(`/api/legacy/cases?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        return data.cases || [];
      }
    } catch (e) {
      console.log("Could not fetch cases from server:", e);
    }
    return [];
  }

  async function readApiError(response: Response): Promise<string> {
    try {
      const payload = await response.json();
      return payload?.message || payload?.error || "Request failed.";
    } catch {
      return "Request failed.";
    }
  }

  async function fetchMyMemberships(): Promise<ServerMembership[]> {
    if (!currentUserId) {
      return [];
    }

    try {
      const response = await resilientFetch("/api/auth/me");
      if (!response.ok) {
        return [];
      }

      const payload = await response.json();
      return Array.isArray(payload.memberships) ? payload.memberships : [];
    } catch {
      return [];
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
      const uploadUrl = new URL("/api/media/upload", getApiUrl()).toString();
      const token = getAccessToken();
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const formData = new FormData();
      if (fileBlob) {
        formData.append("file", fileBlob, filename);
      } else if (nativeUri) {
        formData.append("file", {
          uri: nativeUri,
          type: mimeType,
          name: filename,
        } as any);
      } else {
        return null;
      }

      const globalFetch = globalThis.fetch;
      const response = await globalFetch(uploadUrl, {
        method: "POST",
        headers,
        body: formData,
      });

      if (!response.ok) return null;
      const data = await response.json();
      return data?.url || null;
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

  async function findCurrentLabMembership(): Promise<ServerMembership | null> {
    const memberships = await fetchMyMemberships();
    return (
      memberships.find(
        (membership) =>
          membership.status === "active" &&
          membership.organization?.type === "lab"
      ) || null
    );
  }

  async function findCurrentLabAdminMembership(): Promise<ServerMembership | null> {
    const memberships = await fetchMyMemberships();
    return (
      memberships.find(
        (membership) =>
          membership.status === "active" &&
          membership.organization?.type === "lab" &&
          (membership.role === "owner" || membership.role === "admin")
      ) || null
    );
  }

  useEffect(() => {
    let cancelled = false;

    async function syncActiveLabAffiliationState() {
      if (!currentUserId) {
        if (!cancelled) {
          setHasActiveLabMembership(false);
          setActiveLabAffiliationKey(null);
          setActiveLabAffiliationName(null);
        }
        return;
      }

      const activeMembership = await findCurrentLabMembership();
      if (cancelled) {
        return;
      }

      if (activeMembership?.organizationId) {
        setHasActiveLabMembership(true);
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
      setActiveLabAffiliationKey(null);
      setActiveLabAffiliationName(null);
    }

    syncActiveLabAffiliationState().catch(() => {
      if (cancelled) {
        return;
      }
      setHasActiveLabMembership(false);
      setActiveLabAffiliationKey(null);
      setActiveLabAffiliationName(null);
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

  const prevActiveLabKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const prevKey = prevActiveLabKeyRef.current;
    prevActiveLabKeyRef.current = activeLabAffiliationKey;

    if (prevKey && !activeLabAffiliationKey) {
      setAllCases((prev) => {
        const filtered = prev.filter(
          (c) => !resolveCaseAffiliationKeys(c).includes(prevKey)
        );
        AsyncStorage.setItem(CASES_KEY, JSON.stringify(filtered));
        return filtered;
      });
    }
  }, [activeLabAffiliationKey]);

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
            .filter((request) => request.status === "pending");

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
          .filter((invite) => invite.status === "pending");

        setLabInvitations(mappedInvites);
      } catch {
        // Preserve the current invite list if the refresh fails.
      }
      return;
    }

    // Preserve the current invite list if the refresh fails.
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
  const syncReadyRef = useRef(false);
  const fetchingRef = useRef(false);

  async function refreshCases() {
    if (fetchingRef.current || !currentUserId || visibleCaseAffiliationScope.length === 0) {
      return;
    }
    fetchingRef.current = true;
    try {
      const serverCases = await fetchCasesFromServer(
        visibleCaseAffiliationScope,
        currentUserId
      );
      mergeServerCases(serverCases);
    } catch (e) {
      console.log("Could not refresh cases:", e);
    } finally {
      fetchingRef.current = false;
    }
  }

  async function fullRefreshCases() {
    if (!currentUserId || visibleCaseAffiliationScope.length === 0) {
      return;
    }
    try {
      const serverCases = await fetchCasesFromServer(visibleCaseAffiliationScope, currentUserId);
      setAllCases(serverCases);
      AsyncStorage.setItem(CASES_KEY, JSON.stringify(serverCases));
      prevCasesRef.current = serverCases;
    } catch (e) {
      console.log("Could not full-refresh cases:", e);
    }
  }

  async function hardRefresh() {
    await Promise.all([
      fullRefreshCases(),
      refreshCollaborationState(),
      refreshUsers(),
    ]);
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
    if (!currentUserId || visibleCaseAffiliationScope.length === 0) {
      syncReadyRef.current = false;
      return;
    }

    let cancelled = false;
    const localCasesSnapshot = allCases;
    syncReadyRef.current = false;
    fetchingRef.current = true;

    fetchCasesFromServer(visibleCaseAffiliationScope, currentUserId)
      .then((serverCases) => {
        if (cancelled) {
          return;
        }

        if (serverCases.length > 0) {
          mergeServerCases(serverCases);
        } else {
          prevCasesRef.current = localCasesSnapshot;
        }
      })
      .finally(() => {
        if (cancelled) {
          return;
        }
        fetchingRef.current = false;
        syncReadyRef.current = true;
      });

    return () => {
      cancelled = true;
      fetchingRef.current = false;
    };
  }, [currentUserId, visibleCaseAffiliationScope]);

  useEffect(() => {
    if (!currentUserId || visibleCaseAffiliationScope.length === 0) {
      return;
    }

    const interval = setInterval(() => {
      if (fetchingRef.current) return;
      fetchingRef.current = true;
      fetchCasesFromServer(visibleCaseAffiliationScope, currentUserId)
        .then((serverCases) => {
          mergeServerCases(serverCases);
        })
        .catch(() => null)
        .finally(() => {
          fetchingRef.current = false;
        });
    }, 15000);

    return () => clearInterval(interval);
  }, [currentUserId, visibleCaseAffiliationScope]);

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
        AsyncStorage.getItem(conversationsStorageKey),
        AsyncStorage.getItem(chatMessagesStorageKey),
        AsyncStorage.getItem(PRICING_TIERS_KEY),
      ]);

      if (savedCases) {
        const parsedCases: LabCase[] = JSON.parse(savedCases);
        setAllCases(parsedCases);
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
      const perUnitPrice = MATERIAL_PRICES[materialStr] ?? 250;
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

  async function addCasePhoto(caseId: string, photoUri: string, user?: string) {
    const sharedPhotoUri = (await normalizeSharedImageUri(photoUri)) || photoUri;
    const now = Date.now();
    const isVid = isVideoUri(sharedPhotoUri);
    const photoEntry: ActivityEntry = {
      id: generateId(),
      type: isVid ? "video" : "photo",
      timestamp: now,
      description: isVid ? "Video added to case" : "Photo added to case",
      imageUri: sharedPhotoUri,
      user: user || undefined,
    };
    setCases((prevCases) => {
      const updated = prevCases.map((c) => {
        if (c.id === caseId) {
          const updatedCase = {
            ...c,
            updatedAt: now,
            photos: [...(c.photos || []), sharedPhotoUri],
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
    const normalizedUris = await Promise.all(
      photoUris.map(async (uri) => (await normalizeSharedImageUri(uri)) || uri)
    );

    const photoEntries: ActivityEntry[] = normalizedUris.map((uri, i) => {
      const isVid = isVideoUri(uri);
      return {
        id: generateId(),
        type: (isVid ? "video" : "photo") as ActivityEntryType,
        timestamp: now + i,
        description: isVid ? "Video added to case" : "Photo added to case",
        imageUri: uri,
        user: user || undefined,
      };
    });

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
          return updatedCase;
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
      activeLabAffiliationKey,
      activeLabAffiliationName,
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
      hardRefresh,
      updateWorkStatus,
    }),
    [role, adminUnlocked, cases, notifications, unreadCount, activeCaseCount, rushCaseCount, isLoading, clients, pricingTiers, users, invoices, shippingAccounts, conversations, chatMessages, totalUnreadMessages, groupJoinRequests, labInvitations, inventory, customStationLabels, userIsAffiliated, isLabCreator, deletedClientInvoices, currentUser, currentUserId, currentUserProfile, registeredUsers],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
