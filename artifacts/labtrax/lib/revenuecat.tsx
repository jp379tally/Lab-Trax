import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
} from "react";
import { Platform } from "react-native";
import Purchases, {
  PurchasesOffering,
  PurchasesPackage,
  CustomerInfo,
  LOG_LEVEL,
} from "react-native-purchases";
import { resilientFetch } from "./query-client";

const IOS_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY ?? "";
const ANDROID_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY ?? "";

export function isRevenueCatAvailable(): boolean {
  if (Platform.OS === "web") return false;
  const key = Platform.OS === "ios" ? IOS_API_KEY : ANDROID_API_KEY;
  return key.length > 0;
}

let _initialized = false;

export function initRevenueCat(userId: string): void {
  if (Platform.OS === "web") return;
  const apiKey = Platform.OS === "ios" ? IOS_API_KEY : ANDROID_API_KEY;
  if (!apiKey) return;

  if (__DEV__) {
    Purchases.setLogLevel(LOG_LEVEL.DEBUG);
  }

  if (!_initialized) {
    Purchases.configure({ apiKey, appUserID: userId });
    _initialized = true;
  } else {
    Purchases.logIn(userId).catch(() => {});
  }
}

export async function getOfferings(): Promise<PurchasesOffering | null> {
  if (!isRevenueCatAvailable()) return null;
  try {
    const offerings = await Purchases.getOfferings();
    return offerings.current ?? null;
  } catch {
    return null;
  }
}

export async function getCustomerInfo(): Promise<CustomerInfo | null> {
  if (!isRevenueCatAvailable()) return null;
  try {
    return await Purchases.getCustomerInfo();
  } catch {
    return null;
  }
}

export async function purchasePackage(
  pkg: PurchasesPackage
): Promise<{ success: boolean; customerInfo?: CustomerInfo; error?: string; cancelled?: boolean }> {
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    await linkRevenueCatUserToServer();
    return { success: true, customerInfo };
  } catch (err: any) {
    if (err?.userCancelled) {
      return { success: false, cancelled: true };
    }
    return { success: false, error: err?.message ?? "Purchase failed" };
  }
}

export async function restorePurchases(): Promise<{
  success: boolean;
  customerInfo?: CustomerInfo;
  error?: string;
}> {
  try {
    const customerInfo = await Purchases.restorePurchases();
    await linkRevenueCatUserToServer();
    return { success: true, customerInfo };
  } catch (err: any) {
    return { success: false, error: err?.message ?? "Restore failed" };
  }
}

async function linkRevenueCatUserToServer(): Promise<void> {
  try {
    const info = await Purchases.getCustomerInfo();
    const appUserId = info.originalAppUserId;
    await resilientFetch("/api/billing/link-revenuecat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appUserId }),
    });
  } catch {
  }
}

interface RevenueCatContextValue {
  offering: PurchasesOffering | null;
  customerInfo: CustomerInfo | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const RevenueCatContext = createContext<RevenueCatContextValue>({
  offering: null,
  customerInfo: null,
  loading: false,
  refresh: async () => {},
});

export function RevenueCatProvider({
  children,
  userId,
}: {
  children: ReactNode;
  userId: string | null;
}) {
  const [offering, setOffering] = useState<PurchasesOffering | null>(null);
  const [customerInfo, setCustomerInfo] = useState<CustomerInfo | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!isRevenueCatAvailable()) return;
    setLoading(true);
    try {
      const [off, info] = await Promise.all([getOfferings(), getCustomerInfo()]);
      setOffering(off);
      setCustomerInfo(info);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (userId && isRevenueCatAvailable()) {
      initRevenueCat(userId);
      refresh();
    }
  }, [userId, refresh]);

  return (
    <RevenueCatContext.Provider value={{ offering, customerInfo, loading, refresh }}>
      {children}
    </RevenueCatContext.Provider>
  );
}

export function useRevenueCat(): RevenueCatContextValue {
  return useContext(RevenueCatContext);
}

export function hasActiveEntitlement(customerInfo: CustomerInfo | null): boolean {
  if (!customerInfo) return false;
  const entitlements = customerInfo.entitlements.active;
  return Object.keys(entitlements).length > 0;
}
