// Lightweight inbox for files shared to LabTrax via the iOS/Android share sheet.
// Root layout writes incoming file URLs here. As of the Phase 1 read-only reset
// there is no consumer of these entries; a share-target consumer returns in Phase 2.
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "@labtrax_shared_file_inbox";

export interface InboxEntry {
  url: string;
  receivedAt: number;
}

// Lightweight pub/sub kept for the future Phase 2 share-target consumer, so it
// can react to new inbox entries even when its focus state hasn't changed —
// e.g. a share intent arriving while the user is already in the app.
type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeSharedFileInbox(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyInboxChanged(): void {
  for (const l of listeners) {
    try { l(); } catch {}
  }
}

export async function pushSharedFile(url: string): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const list: InboxEntry[] = raw ? JSON.parse(raw) : [];
    list.push({ url, receivedAt: Date.now() });
    await AsyncStorage.setItem(KEY, JSON.stringify(list));
    notifyInboxChanged();
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
