// Lightweight inbox for files shared to LabTrax via the iOS/Android share sheet.
// Root layout writes incoming file URLs here; LabFileDropZone reads and clears them.
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "@labtrax_shared_file_inbox";

export interface InboxEntry {
  url: string;
  receivedAt: number;
}

export async function pushSharedFile(url: string): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const list: InboxEntry[] = raw ? JSON.parse(raw) : [];
    list.push({ url, receivedAt: Date.now() });
    await AsyncStorage.setItem(KEY, JSON.stringify(list));
  } catch {}
}

export async function popSharedFiles(): Promise<InboxEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const list: InboxEntry[] = JSON.parse(raw);
    await AsyncStorage.removeItem(KEY);
    return list;
  } catch {
    return [];
  }
}
