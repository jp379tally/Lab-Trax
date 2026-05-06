// Persistent storage for File System Access API handles, keyed by upload
// entry id. We keep handles in IndexedDB (not localStorage) because they are
// non-serializable host objects that survive structured clone but not JSON.
//
// This is what lets the desktop pending-file inbox resume an upload after a
// page refresh without asking the user to re-pick the file: the handle is
// persisted, then on startup we re-bind it to the persisted upload session
// and continue from the server-confirmed offset.

const DB_NAME = "labtrax-desktop-uploads";
const STORE_NAME = "handles";
const DB_VERSION = 1;

export interface PersistedHandle {
  queryPermission?: (opts: { mode: "read" }) => Promise<PermissionState>;
  requestPermission?: (opts: { mode: "read" }) => Promise<PermissionState>;
  getFile: () => Promise<File>;
  kind?: string;
  name?: string;
}

function isAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isAvailable()) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

function runRequest<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        try {
          const tx = db.transaction(STORE_NAME, mode);
          const store = tx.objectStore(STORE_NAME);
          const req = fn(store);
          req.onsuccess = () => resolve(req.result as T);
          req.onerror = () => reject(req.error);
        } catch (err) {
          reject(err);
        }
      }),
  );
}

export async function saveHandle(id: string, handle: PersistedHandle): Promise<void> {
  try {
    await runRequest<unknown>("readwrite", (store) => store.put(handle, id));
  } catch {
    /* ignore — fallback flow still works */
  }
}

export async function loadHandle(id: string): Promise<PersistedHandle | null> {
  try {
    const value = await runRequest<PersistedHandle | undefined>("readonly", (store) =>
      store.get(id),
    );
    return value ?? null;
  } catch {
    return null;
  }
}

export async function deleteHandle(id: string): Promise<void> {
  try {
    await runRequest<unknown>("readwrite", (store) => store.delete(id));
  } catch {
    /* ignore */
  }
}

export async function deleteAllHandles(): Promise<void> {
  try {
    await runRequest<unknown>("readwrite", (store) => store.clear());
  } catch {
    /* ignore */
  }
}

/** True if the browser exposes the File System Access API for showOpenFilePicker. */
export function supportsFilePicker(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as any).showOpenFilePicker === "function"
  );
}

/** True if a DataTransferItem can yield a FileSystemFileHandle (Chromium only). */
export function supportsDropHandles(): boolean {
  if (typeof DataTransferItem === "undefined") return false;
  return typeof (DataTransferItem.prototype as any).getAsFileSystemHandle === "function";
}
