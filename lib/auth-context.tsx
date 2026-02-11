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

interface StoredUser {
  username: string;
  password: string;
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
  userType: "provider" | "lab" | "master_admin" | null;
  profilePicUri: string | null;
  setProfilePicUri: (uri: string | null) => void;
  login: (username: string, password: string) => Promise<{ success: boolean; error?: string }>;
  loginWithBiometric: () => Promise<{ success: boolean; error?: string }>;
  register: (data: { username: string; password: string; email: string; phone?: string; wantsUpdates?: boolean; userType?: "provider" | "lab"; licenseNumber?: string; practiceName?: string; doctorName?: string; practiceAddress?: string; practicePhone?: string; phoneContactName?: string; role?: "user" | "admin"; accountNumber?: string }) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
  registeredUsers: StoredUser[];
  isLocked: boolean;
  unlockWithBiometric: () => Promise<{ success: boolean; error?: string }>;
  unlockWithPassword: (password: string) => { success: boolean; error?: string };
  changePassword: (currentPassword: string, newPassword: string) => { success: boolean; error?: string };
  resetInactivityTimer: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const AUTH_KEY = "@drivesync_auth";
const USERS_STORE_KEY = "@drivesync_auth_users";
const PROFILE_PIC_KEY = "@drivesync_profile_pic";
const BIOMETRIC_USER_KEY = "@drivesync_biometric_user";

const DEFAULT_USERS: StoredUser[] = [
  { username: "admin", password: "123" },
  { username: "tech", password: "tech123" },
  { username: "JPPhillips", password: "Master1!", email: "john.phillips3@yahoo.com", phone: "850-363-3336", userType: "master_admin", role: "admin", accountNumber: "MA-001" },
];

const INACTIVITY_TIMEOUT_MS = 3 * 60 * 1000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [userType, setUserType] = useState<"provider" | "lab" | "master_admin" | null>(null);
  const [registeredUsers, setRegisteredUsers] = useState<StoredUser[]>([]);
  const [profilePicUri, setProfilePicUriState] = useState<string | null>(null);
  const [isLocked, setIsLocked] = useState(false);
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

  async function loadAuth() {
    try {
      const [savedAuth, savedUsers, savedPic] = await Promise.all([
        AsyncStorage.getItem(AUTH_KEY),
        AsyncStorage.getItem(USERS_STORE_KEY),
        AsyncStorage.getItem(PROFILE_PIC_KEY),
      ]);

      const mergedUsers = [...DEFAULT_USERS];
      if (savedUsers) {
        const parsed: StoredUser[] = JSON.parse(savedUsers);
        for (const pu of parsed) {
          const isDefault = DEFAULT_USERS.some(
            (d) => d.username.toLowerCase() === pu.username.toLowerCase(),
          );
          if (!isDefault) {
            mergedUsers.push(pu);
          }
        }
      }
      setRegisteredUsers(mergedUsers);
      await AsyncStorage.setItem(USERS_STORE_KEY, JSON.stringify(mergedUsers));

      if (savedPic) {
        setProfilePicUriState(savedPic);
      }

      if (savedAuth) {
        const auth = JSON.parse(savedAuth);
        if (auth.loggedIn && auth.username) {
          setIsAuthenticated(true);
          setCurrentUser(auth.username);
          const matchedUser = mergedUsers.find(
            (u) => u.username.toLowerCase() === auth.username.toLowerCase(),
          );
          setUserType(matchedUser?.userType || "lab");
        }
      }
    } catch (e) {
      setRegisteredUsers(DEFAULT_USERS);
    } finally {
      setIsAuthLoading(false);
    }
  }

  async function setProfilePicUri(uri: string | null) {
    setProfilePicUriState(uri);
    if (uri) {
      await AsyncStorage.setItem(PROFILE_PIC_KEY, uri);
    } else {
      await AsyncStorage.removeItem(PROFILE_PIC_KEY);
    }
  }

  async function login(username: string, password: string): Promise<{ success: boolean; error?: string }> {
    const savedRaw = await AsyncStorage.getItem(USERS_STORE_KEY);
    let allUsers = [...DEFAULT_USERS];
    if (savedRaw) {
      try {
        const saved: StoredUser[] = JSON.parse(savedRaw);
        for (const su of saved) {
          const isDefault = DEFAULT_USERS.some(
            (d) => d.username.toLowerCase() === su.username.toLowerCase(),
          );
          if (!isDefault) {
            allUsers.push(su);
          }
        }
      } catch {}
    }
    const found = allUsers.find(
      (u) => u.username.toLowerCase() === username.toLowerCase() && u.password === password,
    );

    if (!found) {
      return { success: false, error: "Invalid username or password." };
    }

    setIsAuthenticated(true);
    setCurrentUser(found.username);
    setUserType(found.userType || "lab");
    await AsyncStorage.setItem(
      AUTH_KEY,
      JSON.stringify({ loggedIn: true, username: found.username }),
    );
    await AsyncStorage.setItem(
      BIOMETRIC_USER_KEY,
      JSON.stringify({ username: found.username, password: found.password }),
    );
    return { success: true };
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

  async function register(data: { username: string; password: string; email: string; phone?: string; wantsUpdates?: boolean; userType?: "provider" | "lab" | "master_admin"; licenseNumber?: string; practiceName?: string; doctorName?: string; practiceAddress?: string; practicePhone?: string; phoneContactName?: string; role?: "user" | "admin"; accountNumber?: string }): Promise<{ success: boolean; error?: string }> {
    const savedRaw = await AsyncStorage.getItem(USERS_STORE_KEY);
    let allUsers = [...DEFAULT_USERS];
    if (savedRaw) {
      try {
        const saved: StoredUser[] = JSON.parse(savedRaw);
        for (const su of saved) {
          const isDefault = DEFAULT_USERS.some(
            (d) => d.username.toLowerCase() === su.username.toLowerCase(),
          );
          if (!isDefault) {
            allUsers.push(su);
          }
        }
      } catch {}
    }

    const exists = allUsers.some(
      (u) => u.username.toLowerCase() === data.username.toLowerCase(),
    );
    if (exists) {
      return { success: false, error: "Username already taken." };
    }

    const newUser: StoredUser = {
      username: data.username,
      password: data.password,
      email: data.email,
      phone: data.phone,
      wantsUpdates: data.wantsUpdates,
      userType: data.userType,
      licenseNumber: data.licenseNumber,
      practiceName: data.practiceName,
      doctorName: data.doctorName,
      practiceAddress: data.practiceAddress,
      practicePhone: data.practicePhone,
      phoneContactName: data.phoneContactName,
      role: data.role,
      accountNumber: data.accountNumber,
    };
    allUsers.push(newUser);
    setRegisteredUsers(allUsers);
    await AsyncStorage.setItem(USERS_STORE_KEY, JSON.stringify(allUsers));

    setIsAuthenticated(true);
    setCurrentUser(data.username);
    setUserType(data.userType || "lab");
    await AsyncStorage.setItem(
      AUTH_KEY,
      JSON.stringify({ loggedIn: true, username: data.username }),
    );
    return { success: true };
  }

  function logout() {
    setIsAuthenticated(false);
    setCurrentUser(null);
    setUserType(null);
    setIsLocked(false);
    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    AsyncStorage.removeItem(AUTH_KEY);
  }

  async function unlockWithBiometric(): Promise<{ success: boolean; error?: string }> {
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      if (!hasHardware) {
        return { success: false, error: "Biometric authentication not available on this device." };
      }
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Authenticate to unlock DriveSync Lab",
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

  function changePassword(currentPassword: string, newPassword: string): { success: boolean; error?: string } {
    if (!currentUser) return { success: false, error: "Not logged in" };
    const user = registeredUsers.find(u => u.username.toLowerCase() === currentUser.toLowerCase());
    if (!user) return { success: false, error: "User not found." };
    if (user.password !== currentPassword) {
      return { success: false, error: "Current password is incorrect" };
    }
    user.password = newPassword;
    const updated = registeredUsers.map(u =>
      u.username.toLowerCase() === currentUser.toLowerCase() ? { ...u, password: newPassword } : u
    );
    setRegisteredUsers(updated);
    AsyncStorage.setItem(USERS_STORE_KEY, JSON.stringify(updated));
    AsyncStorage.setItem(
      BIOMETRIC_USER_KEY,
      JSON.stringify({ username: currentUser, password: newPassword }),
    );
    return { success: true };
  }

  function unlockWithPassword(password: string): { success: boolean; error?: string } {
    if (!currentUser) return { success: false, error: "No user session found." };
    const user = registeredUsers.find(u => u.username.toLowerCase() === currentUser.toLowerCase());
    if (!user) return { success: false, error: "User not found." };
    if (user.password !== password) return { success: false, error: "Incorrect password." };
    setIsLocked(false);
    resetInactivityTimer();
    return { success: true };
  }

  const value = useMemo(
    () => ({
      isAuthenticated,
      isAuthLoading,
      currentUser,
      userType,
      profilePicUri,
      setProfilePicUri,
      login,
      loginWithBiometric,
      register,
      logout,
      registeredUsers,
      isLocked,
      unlockWithBiometric,
      unlockWithPassword,
      changePassword,
      resetInactivityTimer,
    }),
    [isAuthenticated, isAuthLoading, currentUser, userType, registeredUsers, profilePicUri, isLocked, resetInactivityTimer],
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
