import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  ReactNode,
} from "react";
import { AppState, AppStateStatus, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import { logAudit } from "./audit";
import { getApiUrl, resilientFetch, saveTokens, clearTokens, loadTokens, getHasUsableToken, uploadCaseMedia, setReconnectingListener, createReconnectingTracker, queryClient } from "./query-client";
import { normalizeProfilePhotoUrl } from "./normalize-profile-photo-url";
import { clearAuthedMediaCache } from "./authed-media-cache";
import { clearProtectedShareCache } from "./open-attachment";

interface StoredUser {
  id?: string;
  username: string;
  password?: string;
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  initials?: string;
  wantsUpdates?: boolean;
  userType?: "provider" | "lab" | "master_admin";
  licenseNumber?: string;
  practiceName?: string;
  doctorName?: string;
  practiceAddress?: string;
  practicePhone?: string;
  phoneContactName?: string;
  role?: "user" | "admin" | "billing" | "owner";
  accountNumber?: string;
  practiceAccountNumber?: string | null;
}

interface AuthContextValue {
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  currentUser: string | null;
  currentUserId: string | null;
  userType: "provider" | "lab" | "master_admin" | null;
  profilePicUri: string | null;
  setProfilePicUri: (uri: string | null, expectedUserId?: string) => void | Promise<void>;
  login: (username: string, password: string, rememberMe?: boolean) => Promise<{ success: boolean; requiresTwoFactor?: boolean; pendingToken?: string; error?: string }>;
  completeTwoFactor: (pendingToken: string, code: string, trustDevice?: boolean) => Promise<{ success: boolean; error?: string }>;
  loginWithBiometric: () => Promise<{ success: boolean; requiresTwoFactor?: boolean; pendingToken?: string; error?: string }>;
  register: (data: { providerPlan?: import("@workspace/api-client-react").ProviderSignupTier; reuseSubscriptionCard?: boolean; username: string; password: string; email: string; phone?: string; wantsUpdates?: boolean; userType?: "provider" | "lab" | "master_admin"; licenseNumber?: string; practiceName?: string; doctorName?: string; practiceAddress?: string; address?: { line1: string; city: string; state: string; zip: string }; practicePhone?: string; phoneContactName?: string; role?: "user" | "admin"; accountNumber?: string; joinOrganizationId?: string; partnerLabSelections?: string[]; createOrganization?: boolean; claimProvider?: { labId: string; accountNumber: string } }) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
  deleteAccount: () => Promise<{ success: boolean; error?: string }>;
  registeredUsers: StoredUser[];
  isLocked: boolean;
  unlockWithBiometric: () => Promise<{ success: boolean; error?: string }>;
  unlockWithPassword: (password: string) => { success: boolean; error?: string };
  changePassword: (currentPassword: string, newPassword: string) => Promise<{ success: boolean; error?: string }>;
  updateUserProfile: (updates: { practiceName?: string; practiceAddress?: string; practicePhone?: string; email?: string; phone?: string }) => Promise<{ success: boolean; error?: string }>;
  resetInactivityTimer: () => void;
  refreshUsers: () => Promise<void>;
  isReconnecting: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const AUTH_KEY = "@drivesync_auth";
const PROFILE_PIC_KEY = "@drivesync_profile_pic";
const AUTH_PASSWORD_KEY = "@drivesync_auth_password";
const BIOMETRIC_USER_KEY = "@drivesync_biometric_user";
const TRUSTED_DEVICE_KEY = "@labtrax_trusted_device_v1";
const REMEMBER_ME_KEY = "@labtrax_remember_me";
const CACHED_BUSINESS_KEYS = [
  "@drivesync_cases",
  "@drivesync_notifs",
  "@drivesync_clients",
  "@drivesync_users",
  "@drivesync_invoices",
  "@drivesync_shipping",
  "@drivesync_pricing_tiers",
  "@drivesync_role",
  "@drivesync_barcode_assignments",
  "@drivesync_station_labels",
  "@drivesync_deleted_client_invoices",
  "@drivesync_pending_client",
] as const;

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

async function purgeAuthenticatedCaches() {
  queryClient.clear();
  await Promise.all([
    AsyncStorage.multiRemove([...CACHED_BUSINESS_KEYS]),
    clearAuthedMediaCache(),
    clearProtectedShareCache(),
    import("./video-thumbnail").then(({ clearVideoThumbnailCache }) =>
      clearVideoThumbnailCache(),
    ),
  ]);
}

type SessionStore = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

function getWebSessionStorage(): SessionStore | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

async function getSensitiveItem(key: string): Promise<string | null> {
  if (Platform.OS === "web") {
    const sessionStorage = getWebSessionStorage();
    const sessionValue = sessionStorage?.getItem(key);
    if (sessionValue !== null && sessionValue !== undefined) {
      return sessionValue;
    }

    try {
      const legacyValue = await AsyncStorage.getItem(key);
      if (legacyValue !== null) {
        sessionStorage?.setItem(key, legacyValue);
        await AsyncStorage.removeItem(key);
        return legacyValue;
      }
    } catch {}

    return null;
  }

  if ((Platform.OS as string) !== "web") {
    try {
      const secureValue = await SecureStore.getItemAsync(key);
      if (secureValue !== null) {
        return secureValue;
      }
    } catch {}
  }

  try {
    return await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
}

async function setSensitiveItem(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    const sessionStorage = getWebSessionStorage();
    sessionStorage?.setItem(key, value);
    await AsyncStorage.removeItem(key);
    return;
  }

  if ((Platform.OS as string) !== "web") {
    try {
      await SecureStore.setItemAsync(key, value);
      await AsyncStorage.removeItem(key);
      return;
    } catch {}
  }

  await AsyncStorage.setItem(key, value);
}

async function removeSensitiveItem(key: string): Promise<void> {
  if (Platform.OS === "web") {
    const sessionStorage = getWebSessionStorage();
    sessionStorage?.removeItem(key);
    try {
      await AsyncStorage.removeItem(key);
    } catch {}
    return;
  }

  if ((Platform.OS as string) !== "web") {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {}
  }

  try {
    await AsyncStorage.removeItem(key);
  } catch {}
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const activeUserId = useRef(currentUserId);
  activeUserId.current = currentUserId;
  const [userType, setUserType] = useState<"provider" | "lab" | "master_admin" | null>(null);
  const [registeredUsers, setRegisteredUsers] = useState<StoredUser[]>([]);
  const [profilePicUri, setProfilePicUriState] = useState<string | null>(null);
  const [isLocked, setIsLocked] = useState(false);
  const [currentPassword, setCurrentPassword] = useState<string | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logoutRef = useRef<() => void>(() => {});
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const reconnectTrackerRef = useRef(createReconnectingTracker((v) => setIsReconnecting(v)));

  // Register the reconnecting listener for the lifetime of the provider.
  // When refreshAccessToken() starts, the tracker waits 400ms before setting
  // isReconnecting = true — suppressing the banner for fast refreshes.
  // The listener clears the indicator immediately on success or failure.
  useEffect(() => {
    reconnectTrackerRef.current = createReconnectingTracker((v) => setIsReconnecting(v));
    setReconnectingListener((active) => {
      if (active) reconnectTrackerRef.current.start();
      else reconnectTrackerRef.current.end();
    });
    return () => {
      setReconnectingListener(null);
      reconnectTrackerRef.current.end();
    };
  }, []);

  const resetInactivityTimer = useCallback(() => {
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
    }
    inactivityTimerRef.current = setTimeout(() => {
      void logoutRef.current();
    }, INACTIVITY_TIMEOUT_MS);
  }, []);

  useEffect(() => {
    if (!isAuthenticated || isLocked) return;
    resetInactivityTimer();
    return () => {
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    };
  }, [isAuthenticated, isLocked, resetInactivityTimer]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const subscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      if (appStateRef.current.match(/active/) && nextState.match(/inactive|background/)) {
        if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
        inactivityTimerRef.current = setTimeout(() => {
          void logoutRef.current();
        }, INACTIVITY_TIMEOUT_MS);
      } else if (nextState === "active" && !isLocked) {
        resetInactivityTimer();
      }
      appStateRef.current = nextState;
    });
    return () => subscription.remove();
  }, [isAuthenticated, isLocked, resetInactivityTimer]);

  useEffect(() => {
    loadAuth();
  }, []);

  async function fetchAllUsers() {
    try {
      const res = await resilientFetch("/api/auth/users");
      if (res.ok) {
        const data = await res.json();
        setRegisteredUsers(data.users || []);
        return data.users || [];
      }
    } catch (e) {
      console.log("Could not fetch users from server, using cached data");
    }
    return registeredUsers;
  }

  async function loadAuth() {
    try {
      await loadTokens();

      // If the user's last sign-in had "Remember Me" unchecked, wipe every
      // persisted credential before the auto-login attempt so the app returns
      // them to the login screen on a cold start.
      const rememberMeRaw = await AsyncStorage.getItem(REMEMBER_ME_KEY);
      const rememberedMe = rememberMeRaw === null ? true : rememberMeRaw === "true";
      if (!rememberedMe) {
        await clearTokens();
        await purgeAuthenticatedCaches();
        await AsyncStorage.removeItem(AUTH_KEY);
        await removeSensitiveItem(AUTH_PASSWORD_KEY);
        await removeSensitiveItem(BIOMETRIC_USER_KEY);
        await fetchAllUsers();
        setIsAuthLoading(false);
        return;
      }

      const savedAuth = await AsyncStorage.getItem(AUTH_KEY);

      await fetchAllUsers();

      if (savedAuth) {
        const auth = JSON.parse(savedAuth);
        const storedPassword = auth.password || await getSensitiveItem(AUTH_PASSWORD_KEY);
        if (auth.password) {
          await setSensitiveItem(AUTH_PASSWORD_KEY, auth.password);
          const migratedAuth = { ...auth };
          delete migratedAuth.password;
          await AsyncStorage.setItem(AUTH_KEY, JSON.stringify(migratedAuth));
        }

        if (auth.loggedIn && auth.username) {
          // No usable token could be loaded (e.g. upgrading from a build where
          // the bearer token was stored under a key SecureStore now rejects, so
          // it never persisted). Without a token every authenticated request
          // 401s — leaving the user "logged in" but unable to load any data,
          // because resilientFetch (/api/auth/me) throws on a missing token and
          // is swallowed by the offline-auth fallback below, while the generated
          // customFetch (/api/cases) sends unauthenticated and gets 401. Route
          // to a clean login so the next sign-in persists tokens properly. Web
          // authenticates via session cookie, so its in-memory token may be
          // empty legitimately — only gate native here.
          if (Platform.OS !== "web" && !getHasUsableToken()) {
            await clearTokens();
            await purgeAuthenticatedCaches();
            await AsyncStorage.removeItem(AUTH_KEY);
            setProfilePicUriState(null);
            return;
          }
          try {
            const meRes = await resilientFetch("/api/auth/me");
            if (meRes.ok) {
              const meData = await meRes.json();
              const user = meData.user;
              setIsAuthenticated(true);
              setCurrentUser(user.username);
              setCurrentUserId(user.id);
              setUserType(user.userType || "lab");
              setCurrentPassword(storedPassword);
              setIsLocked(true);
              const userPicKey = `${PROFILE_PIC_KEY}_${user.id || user.username}`;
              let savedPic = await AsyncStorage.getItem(userPicKey);
              // Migrate from old username-based key (set before userId was available)
              if (!savedPic && user.id && user.username) {
                const legacyKey = `${PROFILE_PIC_KEY}_${user.username}`;
                const legacyPic = await AsyncStorage.getItem(legacyKey).catch(() => null);
                if (legacyPic) {
                  savedPic = legacyPic;
                  await AsyncStorage.setItem(userPicKey, legacyPic).catch(() => {});
                  await AsyncStorage.removeItem(legacyKey).catch(() => {});
                }
              }
              // Prefer server-stored URL (survives reinstalls) over local cache.
              // Normalise the server's relative path to an absolute URL on native.
              const normalizedServerPic = normalizeProfilePhotoUrl(user.profilePhotoUrl);
              const picUri = normalizedServerPic;
              setProfilePicUriState(picUri);
              if (normalizedServerPic && savedPic !== normalizedServerPic) {
                await AsyncStorage.setItem(userPicKey, normalizedServerPic).catch(() => {});
              }
            } else if (meRes.status === 401 || meRes.status === 403) {
              // Session truly invalid — wipe credentials and route to login.
              await clearTokens();
              await purgeAuthenticatedCaches();
              await AsyncStorage.removeItem(AUTH_KEY);
              await removeSensitiveItem(AUTH_PASSWORD_KEY);
              setProfilePicUriState(null);
            } else {
              // Server hiccup (500/502/etc) — DO NOT log the user out.
              // Keep cached credentials and let them keep using the app.
              // This prevents a transient backend error or a JS reload (e.g.
              // after the Notifications ErrorBoundary "Try Again" button)
              // from forcing them to sign in again.
              setIsAuthenticated(true);
              setCurrentUser(auth.username);
              setCurrentUserId(auth.userId || null);
              setUserType(auth.userType || "lab");
              setCurrentPassword(storedPassword);
              setIsLocked(true);
            }
          } catch {
            // Network error only — allow offline auth with cached credentials
            // so the user isn't forced to log in every time they have bad signal.
            setIsAuthenticated(true);
            setCurrentUser(auth.username);
            setCurrentUserId(auth.userId || null);
            setUserType(auth.userType || "lab");
            setCurrentPassword(storedPassword);
            setIsLocked(true);
          }
        } else {
          setProfilePicUriState(null);
        }
      } else {
        setProfilePicUriState(null);
      }
    } catch (e) {
      console.error("Error loading auth:", e);
    } finally {
      setIsAuthLoading(false);
    }
  }

  async function setProfilePicUri(uri: string | null, expectedUserId?: string) {
    if (expectedUserId && activeUserId.current !== expectedUserId) return;
    setProfilePicUriState(uri);
    const picKey = `${PROFILE_PIC_KEY}_${currentUserId || currentUser}`;
    if (uri) {
      await AsyncStorage.setItem(picKey, uri).catch(() => {});
    } else {
      await AsyncStorage.removeItem(picKey).catch(() => {});
    }
    // Upload to server so the photo persists across reinstalls / devices
    if (currentUserId && uri && (uri.startsWith("file://") || uri.startsWith("content://"))) {
      try {
        const filename = uri.split("/").pop() || "photo.jpg";
        const mimeType = filename.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
        const res = await uploadCaseMedia(
          `/api/auth/users/${currentUserId}/profile-photo`,
          uri,
          filename,
          mimeType,
        );
        if (res.ok) {
          const data = await res.json();
          if (data.profilePhotoUrl && activeUserId.current === currentUserId) {
            const serverUrl = normalizeProfilePhotoUrl(data.profilePhotoUrl) ?? data.profilePhotoUrl;
            setProfilePicUriState(serverUrl);
            await AsyncStorage.setItem(picKey, serverUrl).catch(() => {});
          }
        }
      } catch {
        // Upload failure is non-fatal — local URI still shows immediately
      }
    }
  }

  async function login(username: string, password: string, rememberMe = true): Promise<{ success: boolean; requiresTwoFactor?: boolean; pendingToken?: string; error?: string }> {
    let sessionSetupStarted = false;
    try {
      // Include a stored trust token so a recognised device skips 2FA (Task #863).
      const storedTrustToken = await getSensitiveItem(TRUSTED_DEVICE_KEY).catch(() => null);
      const res = await resilientFetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          password,
          clientType: Platform.OS === "web" ? "web" : "mobile",
          deviceTrustToken: storedTrustToken ?? undefined,
        }),
      });

      const data = await res.json();

      if (res.ok && data.requiresTwoFactor && data.pendingToken) {
        // Persist the preference now so completeTwoFactor can honour it even
        // though the full login path (where it's normally written) hasn't run.
        await AsyncStorage.setItem(REMEMBER_ME_KEY, rememberMe ? "true" : "false");
        return { success: false, requiresTwoFactor: true, pendingToken: data.pendingToken };
      }

      if (!res.ok || !data.success) {
        return { success: false, error: data.message || data.error || "Invalid username or password." };
      }

      sessionSetupStarted = true;
      const user = data.user;
      if (!user || typeof user.username !== "string" || !user.username.trim()) {
        throw new Error("Login response was incomplete.");
      }

      const hasTokenPair =
        typeof data.accessToken === "string" &&
        data.accessToken.length > 0 &&
        typeof data.refreshToken === "string" &&
        data.refreshToken.length > 0;
      if (Platform.OS !== "web" && !hasTokenPair) {
        throw new Error("The server did not return a usable mobile session.");
      }

      if (hasTokenPair) {
        await saveTokens(data.accessToken, data.refreshToken);
      }

      // Persist the user's preference so the next cold launch knows whether to
      // restore the session or return them to the login screen.
      await AsyncStorage.setItem(REMEMBER_ME_KEY, rememberMe ? "true" : "false");

      if (rememberMe) {
        await setSensitiveItem(AUTH_PASSWORD_KEY, password);
        await AsyncStorage.setItem(
          AUTH_KEY,
          JSON.stringify({ loggedIn: true, username: user.username, userId: user.id, userType: user.userType || "lab" }),
        );
        await setSensitiveItem(
          BIOMETRIC_USER_KEY,
          JSON.stringify({ username: user.username, password }),
        );
      } else {
        // "Remember Me" unchecked — clear any previously persisted session so
        // the next cold launch returns the user to the login screen.
        await AsyncStorage.removeItem(AUTH_KEY);
        await removeSensitiveItem(AUTH_PASSWORD_KEY);
        await removeSensitiveItem(BIOMETRIC_USER_KEY);
      }
      await fetchAllUsers();
      const userPicKey = `${PROFILE_PIC_KEY}_${user.id || user.username}`;
      let savedPic = await AsyncStorage.getItem(userPicKey).catch(() => null);
      if (!savedPic && user.id && user.username) {
        const legacyKey = `${PROFILE_PIC_KEY}_${user.username}`;
        const legacyPic = await AsyncStorage.getItem(legacyKey).catch(() => null);
        if (legacyPic) {
          savedPic = legacyPic;
          await AsyncStorage.setItem(userPicKey, legacyPic).catch(() => {});
          await AsyncStorage.removeItem(legacyKey).catch(() => {});
        }
      }
      // Profile-photo state is optional and must not block an otherwise valid
      // login if the stored or server-provided photo path is malformed.
      let normalizedServerPic: string | null = null;
      try {
        normalizedServerPic = normalizeProfilePhotoUrl(user.profilePhotoUrl);
      } catch {
        normalizedServerPic = null;
      }
      const picUri = normalizedServerPic;
      if (normalizedServerPic && savedPic !== normalizedServerPic) {
        await AsyncStorage.setItem(userPicKey, normalizedServerPic).catch(() => {});
      }

      // Publish authenticated state only after the session and required user
      // setup above have succeeded. A navigation tree must never mount on a
      // login attempt that is still capable of returning failure.
      setProfilePicUriState(picUri);
      setCurrentUser(user.username);
      setCurrentUserId(user.id || null);
      setUserType(user.userType || "lab");
      setCurrentPassword(password);
      setIsAuthenticated(true);
      logAudit("LOGIN", username, "User authenticated");
      return { success: true };
    } catch (e: any) {
      console.error("Login error:", e);
      if (sessionSetupStarted) {
        if (Platform.OS === "web") {
          // Browser sessions are cookie-backed, so clearing native token
          // storage alone cannot undo a session created by the login endpoint.
          await resilientFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
        }
        await clearTokens().catch(() => {});
        await Promise.all([
          AsyncStorage.removeItem(AUTH_KEY).catch(() => {}),
          AsyncStorage.removeItem(REMEMBER_ME_KEY).catch(() => {}),
          removeSensitiveItem(AUTH_PASSWORD_KEY).catch(() => {}),
          removeSensitiveItem(BIOMETRIC_USER_KEY).catch(() => {}),
        ]);
      }
      setIsAuthenticated(false);
      setCurrentUser(null);
      setCurrentUserId(null);
      setUserType(null);
      setCurrentPassword(null);
      setProfilePicUriState(null);
      const apiUrl = getApiUrl();
      return { success: false, error: `Connection error: ${e?.message || "Network request failed"}. Server: ${apiUrl}` };
    }
  }

  async function completeTwoFactor(pendingToken: string, code: string, trustDevice = false): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await resilientFetch("/api/auth/2fa/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingToken, code, clientType: Platform.OS === "web" ? "web" : "mobile", trustDevice }),
      });
      const data = await res.json();
      if (!res.ok || !data?.data?.success) {
        return { success: false, error: data?.error || data?.message || "Invalid code." };
      }
      const { accessToken, refreshToken, deviceTrustToken } = data.data;
      if (accessToken && refreshToken) {
        await saveTokens(accessToken, refreshToken);
      }
      // Persist the trust token for future logins (Task #863).
      if (typeof deviceTrustToken === "string" && deviceTrustToken) {
        await setSensitiveItem(TRUSTED_DEVICE_KEY, deviceTrustToken);
      }
      // Fetch updated user info from /auth/me
      const meRes = await resilientFetch("/api/auth/me");
      const meData = await meRes.json();
      const user = meData?.user ?? meData;
      if (user?.username) {
        setIsAuthenticated(true);
        setCurrentUser(user.username);
        setCurrentUserId(user.id);
        setUserType(user.userType || "lab");
        // Read the Remember Me preference that was stored at the start of the
        // login flow (login() writes it before returning the 2FA challenge).
        const rememberMeRaw = await AsyncStorage.getItem(REMEMBER_ME_KEY);
        const rememberMe = rememberMeRaw === null ? true : rememberMeRaw === "true";
        if (rememberMe) {
          await AsyncStorage.setItem(
            AUTH_KEY,
            JSON.stringify({ loggedIn: true, username: user.username, userId: user.id, userType: user.userType || "lab" }),
          );
        } else {
          // Remember Me unchecked — ensure no persistent session is written
          // so the next cold launch returns the user to the login screen.
          await AsyncStorage.removeItem(AUTH_KEY);
          await removeSensitiveItem(AUTH_PASSWORD_KEY);
          await removeSensitiveItem(BIOMETRIC_USER_KEY);
        }
        await fetchAllUsers();
        const userPicKey = `${PROFILE_PIC_KEY}_${user.id || user.username}`;
        let savedPic = await AsyncStorage.getItem(userPicKey);
        if (!savedPic && user.id && user.username) {
          const legacyKey = `${PROFILE_PIC_KEY}_${user.username}`;
          const legacyPic = await AsyncStorage.getItem(legacyKey).catch(() => null);
          if (legacyPic) {
            savedPic = legacyPic;
            await AsyncStorage.setItem(userPicKey, legacyPic).catch(() => {});
            await AsyncStorage.removeItem(legacyKey).catch(() => {});
          }
        }
        // Normalise the server's relative path to an absolute URL on native.
        const normalizedServerPic = normalizeProfilePhotoUrl(user.profilePhotoUrl);
        const picUri = normalizedServerPic;
        setProfilePicUriState(picUri);
        if (normalizedServerPic && savedPic !== normalizedServerPic) {
          await AsyncStorage.setItem(userPicKey, normalizedServerPic).catch(() => {});
        }
        logAudit("LOGIN_2FA", user.username, "User completed 2FA challenge");
      }
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || "Verification failed." };
    }
  }

  async function loginWithBiometric(): Promise<{ success: boolean; requiresTwoFactor?: boolean; pendingToken?: string; error?: string }> {
    try {
      const stored = await getSensitiveItem(BIOMETRIC_USER_KEY);
      if (!stored) {
        return { success: false, error: "No saved credentials. Please sign in with your password first." };
      }
      const { username, password } = JSON.parse(stored);
      return await login(username, password);
    } catch {
      return { success: false, error: "Could not retrieve saved credentials." };
    }
  }

  async function register(data: { providerPlan?: import("@workspace/api-client-react").ProviderSignupTier; reuseSubscriptionCard?: boolean; username: string; password: string; email: string; phone?: string; wantsUpdates?: boolean; userType?: "provider" | "lab" | "master_admin"; licenseNumber?: string; practiceName?: string; doctorName?: string; practiceAddress?: string; address?: { line1: string; city: string; state: string; zip: string }; practicePhone?: string; phoneContactName?: string; role?: "user" | "admin"; accountNumber?: string; joinOrganizationId?: string; partnerLabSelections?: string[]; createOrganization?: boolean; claimProvider?: { labId: string; accountNumber: string } }): Promise<{ success: boolean; error?: string; message?: string; pendingJoinRequest?: boolean }> {
    try {
      const res = await resilientFetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, clientType: Platform.OS === "web" ? "web" : "mobile" }),
      });

      const result = await res.json();

      if (!res.ok || !result.success) {
        return { success: false, error: result.message || result.error || "Registration failed." };
      }

      if (result.accessToken && result.refreshToken) {
        await saveTokens(result.accessToken, result.refreshToken);
      }

      // Registration returns a server-hydrated user, not the requested role.
      // Warm the membership cache before opening the app. A failed refresh
      // must not turn a committed signup into a duplicate-registration retry.
      let user = result.user;
      try {
        const meRes = await resilientFetch("/api/auth/me");
        if (!meRes.ok) throw new Error(`Membership refresh failed (${meRes.status}).`);
        if (meRes.ok) {
          const me = await meRes.json();
          queryClient.setQueryData(["auth-me", user.id], me);
          user = me.user ?? user;
        }
      } catch (error) {
        console.warn("Account created; membership refresh will retry in the app.", error);
      }
      setRegisteredUsers((previous) => [...previous.filter((u) => u.id !== user.id), user]);
      setIsAuthenticated(true);
      setCurrentUser(user.username);
      setCurrentUserId(user.id);
      setUserType(user.userType || data.userType || "lab");
      setCurrentPassword(data.password);
      await setSensitiveItem(AUTH_PASSWORD_KEY, data.password);
      await AsyncStorage.setItem(
        AUTH_KEY,
        JSON.stringify({ loggedIn: true, username: user.username, userId: user.id, userType: user.userType || data.userType || "lab" }),
      );
      await setSensitiveItem(
        BIOMETRIC_USER_KEY,
        JSON.stringify({ username: user.username, password: data.password }),
      );
      await fetchAllUsers();
      return { success: true, message: result.message, pendingJoinRequest: result.pendingJoinRequest };
    } catch (e: any) {
      console.error("Register error:", e);
      const apiUrl = getApiUrl();
      return { success: false, error: `Connection error: ${e?.message || "Network request failed"}. Server: ${apiUrl}` };
    }
  }

  logoutRef.current = () => { void logout(); };

  async function logout() {
    // Both the server-side logout call and the audit log must complete (or
    // fail) BEFORE clearTokens() clears _accessToken from memory. Reversing
    // this order — the previous bug — caused both requests to fire with no
    // bearer token, producing spurious "[resilientFetch] No bearer token"
    // errors in the console and a 401 on /api/audit-log.
    await Promise.allSettled([
      resilientFetch("/api/auth/logout", { method: "POST" }),
      logAudit("LOGOUT", currentUser || "unknown", "User signed out"),
    ]);
    await clearTokens();
    // React Query is process-wide. Purge relationship-scoped account and card
    // projections before another user can authenticate on this device.
    await purgeAuthenticatedCaches();
    setIsAuthenticated(false);
    setCurrentUser(null);
    setCurrentUserId(null);
    setUserType(null);
    setIsLocked(false);
    setCurrentPassword(null);
    setProfilePicUriState(null);
    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    await removeSensitiveItem(AUTH_PASSWORD_KEY);
    await removeSensitiveItem(BIOMETRIC_USER_KEY);
    await AsyncStorage.removeItem(AUTH_KEY);
  }

  async function deleteAccount(): Promise<{ success: boolean; error?: string }> {
    if (!currentUserId) return { success: false, error: "No user logged in." };
    try {
      const apiUrl = getApiUrl();
      const url = new URL(`/api/auth/users/${currentUserId}`, apiUrl);
      const resp = await resilientFetch(url.toString(), { method: "DELETE" });
      const data = await resp.json();
      if (data.success) {
        logAudit("DELETE_ACCOUNT", currentUser || "unknown", "User deleted their account");
        await clearTokens();
        await purgeAuthenticatedCaches();
        setIsAuthenticated(false);
        setCurrentUser(null);
        setCurrentUserId(null);
        setUserType(null);
        setIsLocked(false);
        setCurrentPassword(null);
        if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
        await removeSensitiveItem(AUTH_PASSWORD_KEY);
        await removeSensitiveItem(BIOMETRIC_USER_KEY);
        await AsyncStorage.removeItem(AUTH_KEY);
        await AsyncStorage.removeItem("@drivesync_role");
        setRegisteredUsers((prev) => prev.filter((u) => u.id !== currentUserId));
        return { success: true };
      }
      return { success: false, error: data.error || data.message || "Failed to delete account." };
    } catch (e: any) {
      console.error("Delete account error:", e);
      return { success: false, error: `Connection error: ${e?.message || "Network request failed"}` };
    }
  }

  async function unlockWithBiometric(): Promise<{ success: boolean; error?: string }> {
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      if (!hasHardware) {
        return { success: false, error: "Biometric authentication not available on this device." };
      }
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Authenticate to unlock LabTrax",
        disableDeviceFallback: false,
      });
      if (result.success) {
        setIsLocked(false);
        resetInactivityTimer();
        return { success: true };
      }
      return { success: false, error: "Authentication failed. Try again." };
    } catch {
      return { success: false, error: "Authentication error." };
    }
  }

  async function changePassword(currentPwd: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
    if (!currentUser || !currentUserId) return { success: false, error: "Not logged in" };
    try {
      const res = await resilientFetch(`/api/auth/users/${currentUserId}/password`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: currentPwd, newPassword }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        return { success: false, error: data.error || data.message || "Failed to change password" };
      }
      setCurrentPassword(newPassword);
      await setSensitiveItem(AUTH_PASSWORD_KEY, newPassword);
      await setSensitiveItem(
        BIOMETRIC_USER_KEY,
        JSON.stringify({ username: currentUser, password: newPassword }),
      );
      const savedAuth = await AsyncStorage.getItem(AUTH_KEY);
      if (savedAuth) {
        const auth = JSON.parse(savedAuth);
        delete auth.password;
        await AsyncStorage.setItem(AUTH_KEY, JSON.stringify(auth));
      }
      return { success: true };
    } catch (e: any) {
      return { success: false, error: `Connection error: ${e?.message || "Network request failed"}` };
    }
  }

  async function updateUserProfile(updates: { practiceName?: string; practiceAddress?: string; practicePhone?: string; email?: string; phone?: string }): Promise<{ success: boolean; error?: string }> {
    if (!currentUser || !currentUserId) return { success: false, error: "Not logged in" };
    try {
      const res = await resilientFetch(`/api/auth/users/${currentUserId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        return { success: false, error: data.error || data.message || "Failed to update profile" };
      }
      setRegisteredUsers((prev) =>
        prev.map((u) =>
          u.id === currentUserId || u.username.toLowerCase() === currentUser.toLowerCase()
            ? { ...u, ...updates }
            : u,
        ),
      );
      return { success: true };
    } catch (e: any) {
      return { success: false, error: `Connection error: ${e?.message || "Network request failed"}` };
    }
  }

  function unlockWithPassword(password: string): { success: boolean; error?: string } {
    if (!currentUser) return { success: false, error: "No user session found." };
    if (!currentPassword || currentPassword !== password) {
      return { success: false, error: "Incorrect password." };
    }
    setIsLocked(false);
    resetInactivityTimer();
    return { success: true };
  }

  const value = useMemo(
    () => ({
      isAuthenticated,
      isAuthLoading,
      currentUser,
      currentUserId,
      userType,
      profilePicUri,
      setProfilePicUri,
      login,
      completeTwoFactor,
      loginWithBiometric,
      register,
      logout,
      deleteAccount,
      registeredUsers,
      isLocked,
      unlockWithBiometric,
      unlockWithPassword,
      changePassword,
      updateUserProfile,
      resetInactivityTimer,
      refreshUsers: fetchAllUsers,
      isReconnecting,
    }),
    [isAuthenticated, isAuthLoading, currentUser, userType, registeredUsers, profilePicUri, isLocked, resetInactivityTimer, currentPassword, currentUserId, isReconnecting],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
