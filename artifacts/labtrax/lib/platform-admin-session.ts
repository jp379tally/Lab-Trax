import * as SecureStore from "expo-secure-store";

const STORAGE_KEY = "labtrax_padmin_session_v1";

export async function storePlatformAdminSession(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, token);
  } catch {}
}

export async function clearPlatformAdminSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
  } catch {}
}

export async function getPlatformAdminSessionHeaders(): Promise<Record<string, string>> {
  try {
    const token = await SecureStore.getItemAsync(STORAGE_KEY);
    if (token) return { "X-Platform-Admin-Session": token };
  } catch {}
  return {};
}
