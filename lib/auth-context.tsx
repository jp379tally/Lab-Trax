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
import { logAudit } from "./audit";
import { getApiUrl, resilientFetch, saveTokens, clearTokens, loadTokens } from "./query-client";

interface StoredUser {
  id?: string;
  username: string;
  password?: string;
  email?: string;
  phone?: string;
  wantsUpdates?: boolean;
  userType?: "provider" | "lab" | "master_admin";
  licenseNumber?: string;
  practiceName?: string;
  doctorName?: string;
  practiceAddress?: string;
  practicePhone?: string;
  phoneContactName?: string;
  role?: "user" | "admin";
  accountNumber?: string;
}

interface AuthContextValue {
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  currentUser: string | null;
  currentUserId: string | null;
  userType: "provider" | "lab" | "master_admin" | null;
  profilePicUri: string | null;
  setProfilePicUri: (uri: string | null) => void;
  login: (username: string, password: string) => Promise<{ success: boolean; error?: string }>;
  loginWithBiometric: () => Promise<{ success: boolean; error?: string }>;
  register: (data: { username: string; password: string; email: string; phone?: string; wantsUpdates?: boolean; userType?: "provider" | "lab"; licenseNumber?: string; practiceName?: string; doctorName?: string; practiceAddress?: string; practicePhone?: string; phoneContactName?: string; role?: "user" | "admin"; accountNumber?: string }) => Promise<{ success: boolean; error?: string }>;
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
}

const AuthContext = createContext<AuthContextValue | null>(null);

const AUTH_KEY = "@drivesync_auth";
const PROFILE_PIC_KEY = "@drivesync_profile_pic";
const BIOMETRIC_USER_KEY = "@drivesync_biometric_user";

const INACTIVITY_TIMEOUT_MS = 3 * 60 * 1000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [userType, setUserType] = useState<"provider" | "lab" | "master_admin" | null>(null);
  const [registeredUsers, setRegisteredUsers] = useState<StoredUser[]>([]);
  const [profilePicUri, setProfilePicUriState] = useState<string | null>(null);
  const [isLocked, setIsLocked] = useState(false);
  const [currentPassword, setCurrentPassword] = useState<string | null>(null);
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  const resetInactivityTimer = useCallback(() => {
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
    }
    inactivityTimerRef.current = setTimeout(() => {
      setIsLocked(true);
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
          setIsLocked(true);
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
      const savedAuth = await AsyncStorage.getItem(AUTH_KEY);

      await fetchAllUsers();

      if (savedAuth) {
        const auth = JSON.parse(savedAuth);
        if (auth.loggedIn && auth.username) {
          try {
            const meRes = await resilientFetch("/api/auth/me");
            if (meRes.ok) {
              const meData = await meRes.json();
              const user = meData.user;
              setIsAuthenticated(true);
              setCurrentUser(user.username);
              setCurrentUserId(user.id);
              setUserType(user.userType || "lab");
              setCurrentPassword(auth.password || null);
              setIsLocked(true);
              const userPicKey = `${PROFILE_PIC_KEY}_${user.id || user.username}`;
              const savedPic = await AsyncStorage.getItem(userPicKey);
              setProfilePicUriState(savedPic);
            } else {
              setIsAuthenticated(true);
              setCurrentUser(auth.username);
              setCurrentUserId(auth.userId || null);
              setUserType(auth.userType || "lab");
              setCurrentPassword(auth.password || null);
              setIsLocked(true);
              const userPicKey = `${PROFILE_PIC_KEY}_${auth.userId || auth.username}`;
              const savedPic = await AsyncStorage.getItem(userPicKey);
              setProfilePicUriState(savedPic);
            }
          } catch {
            setIsAuthenticated(true);
            setCurrentUser(auth.username);
            setCurrentUserId(auth.userId || null);
            setUserType(auth.userType || "lab");
            setCurrentPassword(auth.password || null);
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

  async function setProfilePicUri(uri: string | null) {
    setProfilePicUriState(uri);
    const picKey = `${PROFILE_PIC_KEY}_${currentUserId || currentUser}`;
    if (uri) {
      await AsyncStorage.setItem(picKey, uri);
    } else {
      await AsyncStorage.removeItem(picKey);
    }
  }

  async function login(username: string, password: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await resilientFetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        return { success: false, error: data.message || data.error || "Invalid username or password." };
      }

      if (data.accessToken && data.refreshToken) {
        await saveTokens(data.accessToken, data.refreshToken);
      }

      const user = data.user;
      setIsAuthenticated(true);
      setCurrentUser(user.username);
      setCurrentUserId(user.id);
      setUserType(user.userType || "lab");
      setCurrentPassword(password);
      await AsyncStorage.setItem(
        AUTH_KEY,
        JSON.stringify({ loggedIn: true, username: user.username, userId: user.id, userType: user.userType || "lab", password }),
      );
      await AsyncStorage.setItem(
        BIOMETRIC_USER_KEY,
        JSON.stringify({ username: user.username, password }),
      );
      await fetchAllUsers();
      if (user.role) {
        await AsyncStorage.setItem("@drivesync_role", user.role);
      }
      const userPicKey = `${PROFILE_PIC_KEY}_${user.id || user.username}`;
      const savedPic = await AsyncStorage.getItem(userPicKey);
      setProfilePicUriState(savedPic);
      logAudit("LOGIN", username, "User authenticated");
      return { success: true };
    } catch (e: any) {
      console.error("Login error:", e);
      const apiUrl = getApiUrl();
      return { success: false, error: `Connection error: ${e?.message || "Network request failed"}. Server: ${apiUrl}` };
    }
  }

  async function loginWithBiometric(): Promise<{ success: boolean; error?: string }> {
    try {
      const stored = await AsyncStorage.getItem(BIOMETRIC_USER_KEY);
      if (!stored) {
        return { success: false, error: "No saved credentials. Please sign in with your password first." };
      }
      const { username, password } = JSON.parse(stored);
      return await login(username, password);
    } catch {
      return { success: false, error: "Could not retrieve saved credentials." };
    }
  }

  async function register(data: { username: string; password: string; email: string; phone?: string; wantsUpdates?: boolean; userType?: "provider" | "lab" | "master_admin"; licenseNumber?: string; practiceName?: string; doctorName?: string; practiceAddress?: string; practicePhone?: string; phoneContactName?: string; role?: "user" | "admin"; accountNumber?: string; joinOrganizationId?: string; createOrganization?: boolean }): Promise<{ success: boolean; error?: string; message?: string; pendingJoinRequest?: boolean }> {
    try {
      const res = await resilientFetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      const result = await res.json();

      if (!res.ok || !result.success) {
        return { success: false, error: result.message || result.error || "Registration failed." };
      }

      if (result.accessToken && result.refreshToken) {
        await saveTokens(result.accessToken, result.refreshToken);
      }

      const user = result.user;
      setIsAuthenticated(true);
      setCurrentUser(user.username);
      setCurrentUserId(user.id);
      setUserType(user.userType || data.userType || "lab");
      setCurrentPassword(data.password);
      await AsyncStorage.setItem(
        AUTH_KEY,
        JSON.stringify({ loggedIn: true, username: user.username, userId: user.id, userType: user.userType || data.userType || "lab", password: data.password }),
      );
      if (data.role) {
        await AsyncStorage.setItem("@drivesync_role", data.role);
      }
      await fetchAllUsers();
      return { success: true, message: result.message, pendingJoinRequest: result.pendingJoinRequest };
    } catch (e: any) {
      console.error("Register error:", e);
      const apiUrl = getApiUrl();
      return { success: false, error: `Connection error: ${e?.message || "Network request failed"}. Server: ${apiUrl}` };
    }
  }

  async function logout() {
    logAudit("LOGOUT", currentUser || "unknown", "User signed out");
    try {
      await resilientFetch("/api/auth/logout", { method: "POST" });
    } catch {}
    await clearTokens();
    setIsAuthenticated(false);
    setCurrentUser(null);
    setCurrentUserId(null);
    setUserType(null);
    setIsLocked(false);
    setCurrentPassword(null);
    setProfilePicUriState(null);
    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    AsyncStorage.removeItem(AUTH_KEY);
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
        setIsAuthenticated(false);
        setCurrentUser(null);
        setCurrentUserId(null);
        setUserType(null);
        setIsLocked(false);
        setCurrentPassword(null);
        if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
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
      await AsyncStorage.setItem(
        BIOMETRIC_USER_KEY,
        JSON.stringify({ username: currentUser, password: newPassword }),
      );
      const savedAuth = await AsyncStorage.getItem(AUTH_KEY);
      if (savedAuth) {
        const auth = JSON.parse(savedAuth);
        auth.password = newPassword;
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
    }),
    [isAuthenticated, isAuthLoading, currentUser, userType, registeredUsers, profilePicUri, isLocked, resetInactivityTimer, currentPassword, currentUserId],
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
