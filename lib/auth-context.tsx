import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  ReactNode,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

interface StoredUser {
  username: string;
  password: string;
  email?: string;
  phone?: string;
  wantsUpdates?: boolean;
  userType?: "provider" | "lab";
  licenseNumber?: string;
  practiceName?: string;
  doctorName?: string;
  practiceAddress?: string;
  practicePhone?: string;
  phoneContactName?: string;
  role?: "tech" | "admin";
  accountNumber?: string;
}

interface AuthContextValue {
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  currentUser: string | null;
  profilePicUri: string | null;
  setProfilePicUri: (uri: string | null) => void;
  login: (username: string, password: string) => Promise<{ success: boolean; error?: string }>;
  loginWithBiometric: () => Promise<{ success: boolean; error?: string }>;
  register: (data: { username: string; password: string; email: string; phone?: string; wantsUpdates?: boolean; userType?: "provider" | "lab"; licenseNumber?: string; practiceName?: string; doctorName?: string; practiceAddress?: string; practicePhone?: string; phoneContactName?: string; role?: "tech" | "admin"; accountNumber?: string }) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
  registeredUsers: StoredUser[];
}

const AuthContext = createContext<AuthContextValue | null>(null);

const AUTH_KEY = "@drivesync_auth";
const USERS_STORE_KEY = "@drivesync_auth_users";
const PROFILE_PIC_KEY = "@drivesync_profile_pic";
const BIOMETRIC_USER_KEY = "@drivesync_biometric_user";

const DEFAULT_USERS: StoredUser[] = [
  { username: "admin", password: "123" },
  { username: "tech", password: "tech123" },
];

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [registeredUsers, setRegisteredUsers] = useState<StoredUser[]>([]);
  const [profilePicUri, setProfilePicUriState] = useState<string | null>(null);

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

  async function register(data: { username: string; password: string; email: string; phone?: string; wantsUpdates?: boolean; userType?: "provider" | "lab"; licenseNumber?: string; practiceName?: string; doctorName?: string; practiceAddress?: string; practicePhone?: string; phoneContactName?: string; role?: "tech" | "admin"; accountNumber?: string }): Promise<{ success: boolean; error?: string }> {
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
    await AsyncStorage.setItem(
      AUTH_KEY,
      JSON.stringify({ loggedIn: true, username: data.username }),
    );
    return { success: true };
  }

  function logout() {
    setIsAuthenticated(false);
    setCurrentUser(null);
    AsyncStorage.removeItem(AUTH_KEY);
  }

  const value = useMemo(
    () => ({
      isAuthenticated,
      isAuthLoading,
      currentUser,
      profilePicUri,
      setProfilePicUri,
      login,
      loginWithBiometric,
      register,
      logout,
      registeredUsers,
    }),
    [isAuthenticated, isAuthLoading, currentUser, registeredUsers, profilePicUri],
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
