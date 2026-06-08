import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  Alert,
  InteractionManager,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Client, LabCase } from "@/lib/data";
import { popSharedFiles, subscribeSharedFileInbox } from "@/lib/shared-file-inbox";
import { getApiUrl, resilientFetch } from "@/lib/query-client";
import { useApp } from "@/lib/app-context";

function getStorageKey(user: string | null): string {
  const safeUser = (user || "unknown").replace(/[^a-zA-Z0-9_@.-]/g, "_");
  return `@labtrax_pending_files_${safeUser}`;
}

export interface PendingFile {
  id: string;
  uri: string;
  fileName: string;
  mimeType: string;
  uploadedBy: string;
  uploadedAt: number;
  notes?: string;
  notesUpdatedAt?: number | null;
  notesEditedByName?: string | null;
  notesEditedByUserId?: string | null;
  // When set, this file lives on the server and is shared across every member
  // of the lab identified by `serverOrganizationId`. Local-only files (no
  // active lab membership, or upload still in progress) leave these undefined
  // and persist only in the dropper's AsyncStorage.
  serverId?: string;
  serverOrganizationId?: string;
}

interface LabFileDropZoneProps {
  cases: LabCase[];
  clients: Client[];
  currentUser: string | null;
  onAddToCase: (caseId: string, fileUri: string) => void;
  isAdmin: boolean;
  isFocused?: boolean;
}

export interface LabFileDropZoneHandle {
  /** Process document picker assets through the shared intake upload flow. */
  addDocumentAssets: (assets: DocumentPicker.DocumentPickerAsset[]) => Promise<void>;
}

// Extract the org UUID from an "org:<UUID>" affiliation key.
function getActiveLabOrganizationId(
  activeLabAffiliationKey: string | null
): string | null {
  if (!activeLabAffiliationKey) return null;
  if (!activeLabAffiliationKey.startsWith("org:")) return null;
  const id = activeLabAffiliationKey.slice(4).trim();
  return id || null;
}

// Upload a binary blob to /api/media/upload and return the served URL. Works
// for both web (File from drag-drop / <input>) and native (uri from
// ImagePicker / DocumentPicker).
async function uploadBinaryToServer(
  source:
    | { kind: "web"; file: File }
    | { kind: "native"; uri: string; name: string; type: string }
): Promise<string | null> {
  try {
    const formData = new FormData();
    if (source.kind === "web") {
      formData.append("file", source.file, source.file.name);
    } else {
      // React Native FormData accepts an object with uri/name/type.
      formData.append("file", {
        uri: source.uri,
        name: source.name,
        type: source.type,
      } as any);
    }
    const response = await resilientFetch("/api/media/upload", {
      method: "POST",
      body: formData,
    });
    if (!response.ok) return null;
    const data = await response.json();
    return typeof data?.url === "string" ? data.url : null;
  } catch {
    return null;
  }
}

interface ServerPendingFileResponse {
  id: string;
  organizationId: string;
  uploaderUserId: string;
  uploaderName: string | null;
  fileUrl: string;
  fileName: string;
  mimeType: string;
  notes: string;
  notesUpdatedAt?: string | null;
  notesEditedByUserId?: string | null;
  notesEditedByName?: string | null;
  createdAt: string;
}

function serverFileToPending(file: ServerPendingFileResponse): PendingFile {
  return {
    id: `server:${file.id}`,
    serverId: file.id,
    serverOrganizationId: file.organizationId,
    uri: file.fileUrl,
    fileName: file.fileName,
    mimeType: file.mimeType,
    uploadedBy: file.uploaderName || "Lab member",
    uploadedAt: new Date(file.createdAt).getTime() || Date.now(),
    notes: file.notes || "",
    notesUpdatedAt: file.notesUpdatedAt
      ? new Date(file.notesUpdatedAt).getTime() || null
      : null,
    notesEditedByName: file.notesEditedByName || null,
    notesEditedByUserId: file.notesEditedByUserId || null,
  };
}

function formatRelativeTimeShort(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

function detectMimeKind(mimeType: string): "image" | "video" | "pdf" | "file" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType === "application/pdf") return "pdf";
  return "file";
}

export const LabFileDropZone = React.forwardRef<LabFileDropZoneHandle, LabFileDropZoneProps>(
function LabFileDropZone({
  cases,
  clients,
  currentUser,
  onAddToCase,
  isAdmin,
  isFocused = true,
}: LabFileDropZoneProps, ref) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const s = useMemo(() => makeS(colors), [colors]);
  const { activeLabAffiliationKey, activeLabAffiliationName, allLabOrganizationIds } = useApp();
  const activeLabOrgId = getActiveLabOrganizationId(activeLabAffiliationKey);
  // Memoized stable key for the *set* of labs the user belongs to. Used as
  // a dependency for the polling effect so it re-runs when the user is added
  // to or removed from a lab on another device. Sorting guarantees that two
  // arrays with the same membership produce the same key.
  const allLabOrgIdsKey = useMemo(
    () => [...allLabOrganizationIds].sort().join(","),
    [allLabOrganizationIds]
  );
  const allLabOrgIdsSet = useMemo(
    () => new Set(allLabOrganizationIds),
    [allLabOrganizationIds]
  );

  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const [selectedFile, setSelectedFile] = useState<PendingFile | null>(null);
  const [providerSearch, setProviderSearch] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<Client | null>(null);
  const [patientSearch, setPatientSearch] = useState("");
  const [selectedCase, setSelectedCase] = useState<LabCase | null>(null);
  const [providerDropdownOpen, setProviderDropdownOpen] = useState(false);
  const [patientDropdownOpen, setPatientDropdownOpen] = useState(false);

  const [noteTarget, setNoteTarget] = useState<PendingFile | null>(null);
  const [noteModalVisible, setNoteModalVisible] = useState(false);
  const [draftNote, setDraftNote] = useState("");

  const [captureModalVisible, setCaptureModalVisible] = useState(false);
  const [capturePhotoUri, setCapturePhotoUri] = useState<string | null>(null);
  const [capturePhotoMime, setCapturePhotoMime] = useState("image/jpeg");
  const [captureFileName, setCaptureFileName] = useState("");
  const [captureNote, setCaptureNote] = useState("");

  const [previewTarget, setPreviewTarget] = useState<PendingFile | null>(null);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewDraftNote, setPreviewDraftNote] = useState("");

  // Note edit history modal state. Loaded on demand for a single file.
  interface NoteEditEntry {
    id: string;
    editorUserId: string;
    editorName: string | null;
    oldNotes: string;
    newNotes: string;
    createdAt: string;
  }
  const [historyVisible, setHistoryVisible] = useState(false);
  const [historyFileName, setHistoryFileName] = useState<string>("");
  const [historyEntries, setHistoryEntries] = useState<NoteEditEntry[] | null>(
    null
  );
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const dragCounterRef = useRef(0);
  const pendingFilesRef = useRef<PendingFile[]>([]);

  useEffect(() => {
    pendingFilesRef.current = pendingFiles;
  }, [pendingFiles]);

  // Check for files shared to LabTrax via the iOS/Android share sheet.
  // Drains on focus changes AND on inbox-write notifications so files
  // that arrive while the dashboard is already focused still appear
  // immediately.
  useEffect(() => {
    if (Platform.OS === "web") return;
    let cancelled = false;

    async function processInbox() {
      const entries = await popSharedFiles();
      if (cancelled || entries.length === 0) return;

      for (const entry of entries) {
        try {
          const uri = entry.url;
          // Derive a rough mime type from the extension
          const ext = uri.split("?")[0].split(".").pop()?.toLowerCase() || "";
          let mimeType = "application/octet-stream";
          if (["jpg", "jpeg"].includes(ext)) mimeType = "image/jpeg";
          else if (ext === "png") mimeType = "image/png";
          else if (["heic", "heif"].includes(ext)) mimeType = "image/heic";
          else if (ext === "gif") mimeType = "image/gif";
          else if (ext === "webp") mimeType = "image/webp";
          else if (ext === "pdf") mimeType = "application/pdf";
          else if (["mp4", "m4v"].includes(ext)) mimeType = "video/mp4";
          else if (ext === "mov") mimeType = "video/quicktime";
          else if (uri.startsWith("file://") || uri.startsWith("content://")) mimeType = "image/jpeg";

          const fileName = uri.split("/").pop()?.split("?")[0] || "shared-file";
          const pending: PendingFile = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            uri,
            fileName,
            mimeType,
            uploadedBy: currentUser || "Unknown",
            uploadedAt: Date.now(),
            notes: "",
          };
          if (!cancelled) await addFileAndPromptNote(pending);
        } catch {}
      }
    }

    processInbox().catch(() => {});
    const unsubscribe = subscribeSharedFileInbox(() => {
      processInbox().catch(() => {});
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused]);

  const persistFiles = useCallback(
    async (files: PendingFile[]) => {
      setPendingFiles(files);
      try {
        await AsyncStorage.setItem(getStorageKey(currentUser), JSON.stringify(files));
      } catch {}
    },
    [currentUser],
  );

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(getStorageKey(currentUser))
      .then((raw) => {
        if (cancelled) return;
        if (!raw) { setPendingFiles([]); return; }
        try {
          const parsed = JSON.parse(raw);
          setPendingFiles(Array.isArray(parsed) ? parsed : []);
        } catch { setPendingFiles([]); }
      })
      .catch(() => { if (!cancelled) setPendingFiles([]); });
    return () => { cancelled = true; };
  }, [currentUser]);

  // ──────────────────────────────────────────────────────────────────────────
  // Sync the lab-shared inbox from the server.
  //
  // Whenever the active lab changes, the dashboard regains focus, or every
  // 30 seconds while focused, refresh the list of server-backed pending
  // files. We merge them with any local-only files (those that haven't been
  // uploaded yet, or ones created when no lab was active).
  // ──────────────────────────────────────────────────────────────────────────
  const refreshServerFiles = useCallback(async () => {
    // Skip when the user has no lab memberships at all — the server-backed
    // inbox is only meaningful for lab members.
    if (allLabOrganizationIds.length === 0) return;
    try {
      // Intentionally omit `organizationId` so the server returns pending
      // files for EVERY lab the caller belongs to. This is what makes
      // multi-lab users (e.g. an owner of two practices) and any user newly
      // added to an additional lab see the full set of shared files without
      // having to switch the singular "active" lab manually.
      const url = new URL("/api/lab-pending-files", getApiUrl());
      const response = await resilientFetch(url.toString());
      if (!response.ok) return;
      const data = await response.json();
      const incoming: PendingFile[] = Array.isArray(data?.files)
        ? data.files.map(serverFileToPending)
        : [];
      const incomingIds = new Set(incoming.map((f) => f.serverId));
      const merged = [
        ...incoming,
        ...pendingFilesRef.current.filter(
          (f) => !f.serverId || !incomingIds.has(f.serverId)
        ),
      ].filter(
        // Drop server entries from labs the user is no longer a member of
        // (e.g. they were removed from a lab on another device).
        (f) =>
          !f.serverId ||
          !f.serverOrganizationId ||
          allLabOrgIdsSet.has(f.serverOrganizationId)
      );
      await persistFiles(merged);
    } catch {
      // Network errors are non-fatal; we'll retry on the next interval.
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allLabOrgIdsKey, persistFiles]);

  useEffect(() => {
    if (allLabOrganizationIds.length === 0) return;
    if (!isFocused) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      refreshServerFiles().catch(() => {});
    };
    tick();
    const intervalId = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allLabOrgIdsKey, isFocused, refreshServerFiles]);

  // When the user is removed from a lab on another device, drop any
  // server entries that belong to a lab they are no longer a member of so
  // they don't continue showing in the inbox.
  const prevLabOrgIdsKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevLabOrgIdsKeyRef.current;
    prevLabOrgIdsKeyRef.current = allLabOrgIdsKey;
    if (prev !== null && prev !== allLabOrgIdsKey) {
      const filtered = pendingFilesRef.current.filter(
        (f) =>
          !f.serverOrganizationId || allLabOrgIdsSet.has(f.serverOrganizationId)
      );
      if (filtered.length !== pendingFilesRef.current.length) {
        persistFiles(filtered).catch(() => {});
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allLabOrgIdsKey, persistFiles]);

  function promptNoteForFile(file: PendingFile) {
    setNoteTarget(file);
    setDraftNote(file.notes || "");
    setNoteModalVisible(true);
  }

  async function patchServerNote(
    serverId: string,
    notes: string,
    localFileId?: string
  ) {
    try {
      const response = await resilientFetch(
        `/api/lab-pending-files/${serverId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes }),
        }
      );
      if (!response.ok) return;
      const data = await response.json().catch(() => null);
      if (!data || !data.notesUpdatedAt) return;
      const editedAt = new Date(data.notesUpdatedAt).getTime() || Date.now();
      const editorName = data.notesEditedByName || null;
      const editorId = data.notesEditedByUserId || null;
      const next = pendingFilesRef.current.map((f) => {
        const matches =
          (localFileId && f.id === localFileId) || f.serverId === serverId;
        return matches
          ? {
              ...f,
              notesUpdatedAt: editedAt,
              notesEditedByName: editorName,
              notesEditedByUserId: editorId,
            }
          : f;
      });
      persistFiles(next).catch(() => {});
    } catch {}
  }

  function saveNoteFromModal() {
    if (!noteTarget) return;
    const trimmed = draftNote.trim();
    const updated = pendingFilesRef.current.map((f) =>
      f.id === noteTarget.id ? { ...f, notes: trimmed } : f
    );
    persistFiles(updated).catch(() => {});
    if (noteTarget.serverId) {
      patchServerNote(noteTarget.serverId, trimmed, noteTarget.id);
    }
    setNoteModalVisible(false);
    setNoteTarget(null);
    setDraftNote("");
  }

  function dismissNoteModal() {
    setNoteModalVisible(false);
    setNoteTarget(null);
    setDraftNote("");
  }

  async function openNoteHistory(file: PendingFile) {
    if (!file.serverId) {
      // Local-only files don't have a server-side audit trail yet.
      setHistoryFileName(file.fileName);
      setHistoryEntries([]);
      setHistoryError(null);
      setHistoryLoading(false);
      setHistoryVisible(true);
      return;
    }
    setHistoryFileName(file.fileName);
    setHistoryEntries(null);
    setHistoryError(null);
    setHistoryLoading(true);
    setHistoryVisible(true);
    try {
      const response = await resilientFetch(
        `/api/lab-pending-files/${file.serverId}/note-history`
      );
      if (!response.ok) {
        setHistoryError("Could not load edit history.");
        setHistoryEntries([]);
        return;
      }
      const data = await response.json().catch(() => null);
      const entries: NoteEditEntry[] = Array.isArray(data?.edits)
        ? data.edits
        : [];
      setHistoryEntries(entries);
    } catch {
      setHistoryError("Could not load edit history.");
      setHistoryEntries([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  function dismissHistory() {
    setHistoryVisible(false);
    setHistoryEntries(null);
    setHistoryError(null);
    setHistoryLoading(false);
    setHistoryFileName("");
  }

  function openPreview(file: PendingFile) {
    setPreviewTarget(file);
    setPreviewDraftNote(file.notes || "");
    setPreviewVisible(true);
  }

  function savePreviewNote() {
    if (!previewTarget) return;
    const trimmed = previewDraftNote.trim();
    // Resolve against the current list defensively: if the file was promoted
    // to a server-backed entry while the preview was open, the previewTarget
    // still holds the old local id/serverId. Match by id OR by uri so we
    // always update the live entry and PATCH the server.
    const live =
      pendingFilesRef.current.find((f) => f.id === previewTarget.id) ||
      pendingFilesRef.current.find((f) => f.uri === previewTarget.uri);
    const updated = pendingFilesRef.current.map((f) =>
      f === live ? { ...f, notes: trimmed } : f
    );
    persistFiles(updated).catch(() => {});
    const serverId = live?.serverId || previewTarget.serverId;
    if (serverId) {
      patchServerNote(serverId, trimmed, live?.id || previewTarget.id);
    }
    setPreviewVisible(false);
    setPreviewTarget(null);
    setPreviewDraftNote("");
  }

  async function deleteServerFile(serverId: string) {
    try {
      await resilientFetch(`/api/lab-pending-files/${serverId}`, {
        method: "DELETE",
      });
    } catch {}
  }

  function deleteFromPreview() {
    if (!previewTarget) return;
    const live =
      pendingFilesRef.current.find((f) => f.id === previewTarget.id) ||
      pendingFilesRef.current.find((f) => f.uri === previewTarget.uri);
    const updated = pendingFilesRef.current.filter((f) => f !== live);
    persistFiles(updated).catch(() => {});
    const serverId = live?.serverId || previewTarget.serverId;
    if (serverId) {
      deleteServerFile(serverId);
    }
    if (live && selectedFile?.id === live.id) resetSelection();
    setPreviewVisible(false);
    setPreviewTarget(null);
    setPreviewDraftNote("");
  }

  // Try to publish the file to the lab-shared inbox on the server. If the
  // user has an active lab membership and the upload succeeds, we replace the
  // local-only entry with a server-backed entry that everyone in the lab can
  // see. If anything fails, we keep the local entry intact so the user
  // doesn't lose their work.
  const maybePromoteToServer = useCallback(async (
    localFile: PendingFile,
    source:
      | { kind: "web"; file: File }
      | { kind: "native"; uri: string; name: string; type: string }
  ) => {
    const orgId = activeLabOrgId;
    if (!orgId) return;
    try {
      const url = await uploadBinaryToServer(source);
      if (!url) return;
      const response = await resilientFetch("/api/lab-pending-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: orgId,
          fileUrl: url,
          fileName: localFile.fileName,
          mimeType: localFile.mimeType,
          notes: localFile.notes || "",
          uploaderName: localFile.uploadedBy,
        }),
      });
      if (!response.ok) return;
      const data = await response.json();
      if (!data?.file) return;
      const serverEntry = serverFileToPending(
        data.file as ServerPendingFileResponse
      );
      // Replace the local placeholder with the server-backed entry, keeping
      // any note edits the user just made.
      const currentLocal = pendingFilesRef.current.find(
        (f) => f.id === localFile.id
      );
      const preservedNote =
        currentLocal?.notes ?? serverEntry.notes ?? "";
      const next = pendingFilesRef.current.map((f) =>
        f.id === localFile.id ? { ...serverEntry, notes: preservedNote } : f
      );
      await persistFiles(next);
      // If the user added a note in the gap between drop and upload, push it
      // up so other lab members can see it too.
      if (
        preservedNote &&
        preservedNote.trim() &&
        preservedNote.trim() !== (serverEntry.notes || "").trim()
      ) {
        patchServerNote(serverEntry.serverId!, preservedNote.trim());
      }
      // If the user is editing this file's note right now, update the
      // pointer so future saves go to the server entry.
      setNoteTarget((current) =>
        current && current.id === localFile.id
          ? { ...serverEntry, notes: current.notes ?? serverEntry.notes }
          : current
      );
      setSelectedFile((current) =>
        current && current.id === localFile.id
          ? { ...serverEntry, notes: current.notes ?? serverEntry.notes }
          : current
      );
    } catch {
      // Leave the local entry in place and let the user retry.
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLabOrgId, persistFiles]);

  const addFileAndPromptNote = useCallback(
    async (file: PendingFile) => {
      const updated = [...pendingFilesRef.current, file];
      await persistFiles(updated);
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      }
      promptNoteForFile(file);
    },
    [persistFiles],
  );

  useImperativeHandle(ref, () => ({
    async addDocumentAssets(assets: DocumentPicker.DocumentPickerAsset[]) {
      for (const asset of assets) {
        const pending: PendingFile = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          uri: asset.uri,
          fileName: asset.name || "file",
          mimeType: asset.mimeType || "application/octet-stream",
          uploadedBy: currentUser || "Unknown",
          uploadedAt: Date.now(),
          notes: "",
        };
        await addFileAndPromptNote(pending);
        maybePromoteToServer(pending, {
          kind: "native",
          uri: asset.uri,
          name: pending.fileName,
          type: pending.mimeType,
        });
      }
    },
  }), [addFileAndPromptNote, maybePromoteToServer, currentUser]);

  const processDroppedFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      for (const file of files) {
        const isValid =
          file.type.startsWith("image/") ||
          file.type.startsWith("video/") ||
          file.type === "application/pdf";
        if (!isValid) continue;
        const maxSize = 10 * 1024 * 1024;
        if (file.size > maxSize) continue;
        try {
          const dataUri = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(new Error("Failed to read file"));
            reader.readAsDataURL(file);
          });
          const pending: PendingFile = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            uri: dataUri,
            fileName: file.name,
            mimeType: file.type,
            uploadedBy: currentUser || "Unknown",
            uploadedAt: Date.now(),
            notes: "",
          };
          await addFileAndPromptNote(pending);
          // Push to lab-shared inbox in background so other devices can see it.
          maybePromoteToServer(pending, { kind: "web", file });
        } catch {}
      }
    },
    [addFileAndPromptNote, currentUser, activeLabOrgId],
  );

  const processDroppedFilesRef = useRef(processDroppedFiles);
  useEffect(() => { processDroppedFilesRef.current = processDroppedFiles; }, [processDroppedFiles]);

  async function handlePickFromPhotos() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images", "videos"],
        allowsMultipleSelection: false,
        quality: 1,
      });
      if (result.canceled || !result.assets?.length) return;
      for (const asset of result.assets) {
        const pending: PendingFile = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          uri: asset.uri,
          fileName: asset.fileName || "photo",
          mimeType: asset.mimeType || "image/jpeg",
          uploadedBy: currentUser || "Unknown",
          uploadedAt: Date.now(),
          notes: "",
        };
        await addFileAndPromptNote(pending);
        maybePromoteToServer(pending, {
          kind: "native",
          uri: asset.uri,
          name: pending.fileName,
          type: pending.mimeType,
        });
      }
    } catch {}
  }

  // On iOS/Android: screenshots live in the Photos library (Camera Roll).
  // Use ImagePicker so screenshots are reachable via this button.
  async function handlePickFromFiles() {
    if (Platform.OS === "web") {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*,video/*,application/pdf,*/*";
      input.multiple = false;
      input.onchange = async () => {
        if (input.files) await processDroppedFiles(input.files);
      };
      input.click();
      return;
    }
    try {
      // iOS/Android: screenshots are stored in the Photos library, not the Files app.
      // ImagePicker.launchImageLibraryAsync reaches the Camera Roll including screenshots.
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images", "videos"],
        allowsMultipleSelection: false,
        quality: 1,
      });
      if (result.canceled || !result.assets?.length) return;
      for (const asset of result.assets) {
        const pending: PendingFile = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          uri: asset.uri,
          fileName: asset.fileName || "screenshot",
          mimeType: asset.mimeType || "image/jpeg",
          uploadedBy: currentUser || "Unknown",
          uploadedAt: Date.now(),
          notes: "",
        };
        await addFileAndPromptNote(pending);
        maybePromoteToServer(pending, {
          kind: "native",
          uri: asset.uri,
          name: pending.fileName,
          type: pending.mimeType,
        });
      }
    } catch {}
  }

  // Separate handler for iCloud Drive / Files app documents (PDFs, etc.)
  async function handlePickFromDocuments() {
    if (Platform.OS === "web") {
      handlePickFromFiles();
      return;
    }
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["application/pdf", "*/*"],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.length) return;
      for (const asset of result.assets) {
        const pending: PendingFile = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          uri: asset.uri,
          fileName: asset.name || "file",
          mimeType: asset.mimeType || "application/octet-stream",
          uploadedBy: currentUser || "Unknown",
          uploadedAt: Date.now(),
          notes: "",
        };
        await addFileAndPromptNote(pending);
        maybePromoteToServer(pending, {
          kind: "native",
          uri: asset.uri,
          name: pending.fileName,
          type: pending.mimeType,
        });
      }
    } catch {}
  }

  async function handleTakePhoto() {
    if (Platform.OS === "web") { handlePickFromFiles(); return; }
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Camera Access Required", "Allow camera access in Settings to take photos.");
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        quality: 0.9,
        allowsEditing: false,
      });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      const stamp = new Date().toISOString().slice(0, 10);
      const defaultName = `photo-${stamp}.jpg`;
      setCapturePhotoUri(asset.uri);
      setCapturePhotoMime(asset.mimeType || "image/jpeg");
      setCaptureFileName(defaultName);
      setCaptureNote("");
      setCaptureModalVisible(true);
    } catch (err: any) {
      console.log("Take photo failed:", err?.message);
    }
  }

  async function saveCapturedPhoto() {
    if (!capturePhotoUri) return;
    const finalName = captureFileName.trim() || `photo-${Date.now()}.jpg`;
    const pending: PendingFile = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      uri: capturePhotoUri,
      fileName: finalName,
      mimeType: capturePhotoMime,
      uploadedBy: currentUser || "Unknown",
      uploadedAt: Date.now(),
      notes: captureNote.trim(),
    };
    setCaptureModalVisible(false);
    const updated = [...pendingFilesRef.current, pending];
    await persistFiles(updated);
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }
    maybePromoteToServer(pending, {
      kind: "native",
      uri: capturePhotoUri,
      name: finalName,
      type: capturePhotoMime,
    });
    setCapturePhotoUri(null);
    setCaptureFileName("");
    setCaptureNote("");
  }

  function showPickOptions() {
    if (Platform.OS === "web") {
      handlePickFromFiles();
      return;
    }
    Alert.alert("Document Dump Zone", "Add a file or take a photo", [
      { text: "Cancel", style: "cancel" },
      { text: "Take Photo", onPress: handleTakePhoto },
      { text: "Browse Photos & Videos", onPress: handlePickFromPhotos },
      { text: "Browse Files & PDFs", onPress: handlePickFromDocuments },
    ]);
  }

  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!isFocused) { setDragOver(false); dragCounterRef.current = 0; return; }
    dragCounterRef.current = 0;

    const handleDragEnter = (event: DragEvent) => {
      if (!event.dataTransfer?.types?.includes("Files")) return;
      event.preventDefault(); event.stopPropagation();
      dragCounterRef.current += 1;
      setDragOver(true);
    };
    const handleDragOver = (event: DragEvent) => { event.preventDefault(); event.stopPropagation(); };
    const handleDragLeave = (event: DragEvent) => {
      event.preventDefault(); event.stopPropagation();
      dragCounterRef.current -= 1;
      if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setDragOver(false); }
    };
    const handleDrop = (event: DragEvent) => {
      event.preventDefault(); event.stopPropagation();
      dragCounterRef.current = 0; setDragOver(false);
      if (event.dataTransfer?.files?.length) processDroppedFilesRef.current(event.dataTransfer.files);
    };

    document.addEventListener("dragenter", handleDragEnter);
    document.addEventListener("dragover", handleDragOver);
    document.addEventListener("dragleave", handleDragLeave);
    document.addEventListener("drop", handleDrop);
    return () => {
      document.removeEventListener("dragenter", handleDragEnter);
      document.removeEventListener("dragover", handleDragOver);
      document.removeEventListener("dragleave", handleDragLeave);
      document.removeEventListener("drop", handleDrop);
    };
  }, [isFocused]);

  function resetSelection() {
    setSelectedFile(null);
    setSelectedProvider(null);
    setProviderSearch("");
    setSelectedCase(null);
    setPatientSearch("");
    setProviderDropdownOpen(false);
    setPatientDropdownOpen(false);
  }

  function removeFile(fileId: string) {
    const target = pendingFilesRef.current.find((f) => f.id === fileId);
    const updated = pendingFilesRef.current.filter((f) => f.id !== fileId);
    persistFiles(updated).catch(() => {});
    if (target?.serverId) {
      deleteServerFile(target.serverId);
    }
    if (selectedFile?.id === fileId) resetSelection();
  }

  function handleAddToCase() {
    if (!selectedFile || !selectedCase) return;
    onAddToCase(selectedCase.id, selectedFile.uri);
    removeFile(selectedFile.id);
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }
    Alert.alert("Added", `File attached to ${selectedCase.patientName}'s case.`);
  }

  function handleBarPress() {
    if (pendingFiles.length > 0) { setReviewOpen(true); return; }
    showPickOptions();
  }

  function selectProvider(client: Client) {
    setSelectedProvider(client);
    setProviderSearch(client.practiceName || client.leadDoctor || "");
    setProviderDropdownOpen(false);
    setSelectedCase(null);
    setPatientSearch("");
    setPatientDropdownOpen(false);
  }

  function selectPatient(labCase: LabCase) {
    setSelectedCase(labCase);
    setPatientSearch(labCase.patientName);
    setPatientDropdownOpen(false);
  }

  const activeClients = clients.filter((c) => c.status !== "inactive");
  const filteredProviders =
    providerSearch.trim().length > 0
      ? activeClients.filter((client) => {
          const q = providerSearch.toLowerCase().trim();
          const extra = (client.additionalProviders || []).map((p) => p.toLowerCase().trim());
          return (
            (client.practiceName || "").toLowerCase().includes(q) ||
            (client.leadDoctor || "").toLowerCase().includes(q) ||
            extra.some((p) => p.includes(q))
          );
        })
      : activeClients;

  const providerCases = selectedProvider
    ? cases.filter((labCase) => {
        const doc = (labCase.doctorName || "").toLowerCase().trim();
        const prac = (selectedProvider.practiceName || "").toLowerCase().trim();
        const lead = (selectedProvider.leadDoctor || "").toLowerCase().trim();
        const extra = (selectedProvider.additionalProviders || [])
          .map((p) => p.toLowerCase().trim())
          .filter(Boolean);
        return (
          doc === lead || doc === prac ||
          extra.includes(doc) ||
          doc.includes(lead) || lead.includes(doc)
        );
      })
    : [];

  const filteredPatients =
    patientSearch.trim().length > 0
      ? providerCases.filter((c) => c.patientName.toLowerCase().includes(patientSearch.toLowerCase()))
      : providerCases;

  const fileCount = pendingFiles.length;
  const barTitle = dragOver
    ? "Drop files here"
    : fileCount > 0
      ? `${fileCount} file${fileCount !== 1 ? "s" : ""} ready for review`
      : "Document Dump Zone";
  const barSub = dragOver
    ? "Release to add to the dump zone"
    : fileCount > 0
      ? "Open the review queue and assign files to the correct case"
      : Platform.OS === "web"
        ? "Drag files here or browse — prescriptions, photos, docs, anything"
        : "Take photos or browse files — prescriptions, docs, anything to log";
  const barActionLabel = dragOver ? "Drop Now" : fileCount > 0 ? "Review" : "Upload";

  const headerPaddingTop = Math.max(insets.top, Platform.OS === "web" ? 20 : 16) + 12;

  return (
    <>
      <Pressable
        testID="lab-file-drop-bar"
        onPress={handleBarPress}
        style={({ pressed }) => [s.bar, dragOver && s.barDragOver, pressed && s.barPressed]}
      >
        <View style={s.barContent}>
          <View style={s.barMain}>
            <View style={s.barIconWrap}>
              <Ionicons
                name={dragOver ? "arrow-down-circle" : fileCount > 0 ? "folder-open" : "cloud-upload-outline"}
                size={22}
                color={dragOver ? colors.info : fileCount > 0 ? colors.warningStrong : colors.tint}
              />
            </View>
            <View style={s.barTextWrap}>
              <Text style={s.barTitle}>{barTitle}</Text>
              <Text style={s.barSub}>{barSub}</Text>
            </View>
          </View>
          <View style={s.barAction}>
            {fileCount > 0 ? (
              <View style={s.badge}>
                <Text style={s.badgeText}>{fileCount}</Text>
              </View>
            ) : null}
            <Text style={s.barActionText}>{barActionLabel}</Text>
          </View>
        </View>
      </Pressable>

      {/* ── Immediate note prompt ── */}
      <Modal visible={noteModalVisible} transparent animationType="slide" onRequestClose={dismissNoteModal}>
        <KeyboardAvoidingView
          style={s.noteBackdrop}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={0}
        >
          {/* Tapping the dim area dismisses */}
          <Pressable style={{ flex: 1 }} onPress={dismissNoteModal} />
          <View style={[s.noteCard, { paddingBottom: Math.max(insets.bottom + 12, 28) }]}>
            <View style={s.noteHandleBar} />
            <Text style={s.noteCardTitle}>Add a note</Text>
            <Text style={s.noteCardSub}>
              Describe what this file is so it's easy to find later.
            </Text>
            <TextInput
              style={s.noteInput}
              value={draftNote}
              onChangeText={setDraftNote}
              placeholder="e.g. Bite open, prep photo, shade reference, patient screenshot..."
              placeholderTextColor={colors.textTertiary}
              multiline
              numberOfLines={3}
              autoFocus
              returnKeyType="default"
              scrollEnabled
            />
            <View style={s.noteActions}>
              <Pressable
                onPress={dismissNoteModal}
                style={({ pressed }) => [s.noteBtnSecondary, pressed && { opacity: 0.7 }]}
              >
                <Text style={s.noteBtnSecondaryText}>Skip</Text>
              </Pressable>
              <Pressable
                onPress={saveNoteFromModal}
                style={({ pressed }) => [s.noteBtnPrimary, pressed && { opacity: 0.8 }]}
              >
                <Text style={s.noteBtnPrimaryText}>Save Note</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Full-screen preview modal ── */}
      <Modal
        visible={previewVisible}
        animationType="slide"
        onRequestClose={() => { setPreviewVisible(false); setPreviewTarget(null); setPreviewDraftNote(""); }}
      >
        <View style={[s.previewScreen, { paddingTop: insets.top || (Platform.OS === "web" ? 67 : 0) }]}>
          <View style={s.previewHeader}>
            <Pressable
              onPress={() => { setPreviewVisible(false); setPreviewTarget(null); setPreviewDraftNote(""); }}
              hitSlop={12}
            >
              <Ionicons name="close" size={26} color={colors.text} />
            </Pressable>
            <Text style={s.previewTitle} numberOfLines={1}>
              {previewTarget?.fileName || "Attachment"}
            </Text>
            <Pressable onPress={deleteFromPreview} hitSlop={12}>
              <Ionicons name="trash-outline" size={22} color={colors.errorStrong} />
            </Pressable>
          </View>

          <ScrollView
            style={s.previewScroll}
            contentContainerStyle={s.previewScrollContent}
            keyboardShouldPersistTaps="handled"
          >
            {previewTarget && detectMimeKind(previewTarget.mimeType) === "image" ? (
              <Image
                source={{ uri: previewTarget.uri }}
                style={s.previewImage}
                contentFit="contain"
              />
            ) : (
              <View style={s.previewFallback}>
                <Ionicons
                  name={
                    previewTarget && detectMimeKind(previewTarget.mimeType) === "video"
                      ? "play-circle-outline"
                      : "document-text-outline"
                  }
                  size={56}
                  color={colors.textSecondary}
                />
                <Text style={s.previewFallbackText}>
                  {previewTarget?.fileName || previewTarget?.mimeType || "File"}
                </Text>
              </View>
            )}

            <Text style={s.previewNoteLabel}>Notes</Text>
            <TextInput
              style={s.previewNoteInput}
              value={previewDraftNote}
              onChangeText={setPreviewDraftNote}
              placeholder="Add notes for this attachment..."
              placeholderTextColor={colors.textTertiary}
              multiline
              numberOfLines={4}
            />

            <Pressable
              onPress={savePreviewNote}
              style={({ pressed }) => [s.previewSaveBtn, pressed && { opacity: 0.8 }]}
            >
              <Text style={s.previewSaveBtnText}>Save Changes</Text>
            </Pressable>

            <Text style={s.previewMeta}>
              Uploaded by {previewTarget?.uploadedBy} · {previewTarget ? new Date(previewTarget.uploadedAt).toLocaleDateString() : ""}
            </Text>
            {previewTarget?.notesUpdatedAt ? (
              <>
                <Text style={s.previewMetaEdited}>
                  Note edited by {previewTarget.notesEditedByName || "someone"} ·{" "}
                  {formatRelativeTimeShort(previewTarget.notesUpdatedAt)}
                </Text>
                <Pressable
                  onPress={() => previewTarget && openNoteHistory(previewTarget)}
                  style={({ pressed }) => [
                    s.historyLinkBtn,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Ionicons name="time-outline" size={14} color={colors.textSecondary} />
                  <Text style={s.historyLinkText}>View edit history</Text>
                </Pressable>
              </>
            ) : null}
          </ScrollView>
        </View>
      </Modal>

      {/* ── Capture: rename + note modal ── */}
      <Modal
        visible={captureModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setCaptureModalVisible(false)}
      >
        <KeyboardAvoidingView
          style={s.noteBackdrop}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={0}
        >
          <Pressable style={{ flex: 1 }} onPress={() => setCaptureModalVisible(false)} />
          <View style={[s.noteCard, { paddingBottom: Math.max(insets.bottom + 12, 28) }]}>
            <View style={s.noteHandleBar} />
            {capturePhotoUri ? (
              <Image source={{ uri: capturePhotoUri }} style={s.captureThumb} contentFit="cover" />
            ) : null}
            <Text style={s.noteCardTitle}>Name this photo</Text>
            <Text style={s.noteCardSub}>Give it a descriptive filename before saving.</Text>
            <TextInput
              style={s.noteInput}
              value={captureFileName}
              onChangeText={setCaptureFileName}
              placeholder="e.g. patient-rx-john-doe.jpg"
              placeholderTextColor={colors.textTertiary}
              autoFocus
              returnKeyType="next"
              selectTextOnFocus
            />
            <Text style={[s.noteCardSub, { marginTop: 8 }]}>Add a note (optional)</Text>
            <TextInput
              style={s.noteInput}
              value={captureNote}
              onChangeText={setCaptureNote}
              placeholder="e.g. Rx for crown prep, bite registration photo..."
              placeholderTextColor={colors.textTertiary}
              multiline
              numberOfLines={2}
              returnKeyType="default"
              scrollEnabled
            />
            <View style={s.noteActions}>
              <Pressable
                onPress={() => setCaptureModalVisible(false)}
                style={({ pressed }) => [s.noteBtnSecondary, pressed && { opacity: 0.7 }]}
              >
                <Text style={s.noteBtnSecondaryText}>Discard</Text>
              </Pressable>
              <Pressable
                onPress={saveCapturedPhoto}
                style={({ pressed }) => [s.noteBtnPrimary, pressed && { opacity: 0.8 }]}
              >
                <Text style={s.noteBtnPrimaryText}>Save to Dump Zone</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Note edit history modal ── */}
      <Modal
        visible={historyVisible}
        animationType="slide"
        transparent
        onRequestClose={dismissHistory}
      >
        <View style={s.historyBackdrop}>
          <View style={s.historySheet}>
            <View style={s.historyHeader}>
              <View style={s.historyHeaderText}>
                <Text style={s.historyTitle}>Note edit history</Text>
                <Text style={s.historySubtitle} numberOfLines={1}>
                  {historyFileName || "Attachment"}
                </Text>
              </View>
              <Pressable onPress={dismissHistory} hitSlop={12}>
                <Ionicons name="close" size={24} color={colors.text} />
              </Pressable>
            </View>
            <ScrollView
              style={s.historyScroll}
              contentContainerStyle={s.historyScrollContent}
            >
              {historyLoading ? (
                <Text style={s.historyEmpty}>Loading history…</Text>
              ) : historyError ? (
                <Text style={s.historyError}>{historyError}</Text>
              ) : !historyEntries || historyEntries.length === 0 ? (
                <Text style={s.historyEmpty}>No edits yet.</Text>
              ) : (
                historyEntries.map((entry) => (
                  <View key={entry.id} style={s.historyEntry}>
                    <View style={s.historyEntryHeader}>
                      <Text style={s.historyEditor}>
                        {entry.editorName || "Unknown editor"}
                      </Text>
                      <Text style={s.historyTime}>
                        {formatRelativeTimeShort(
                          new Date(entry.createdAt).getTime() || Date.now()
                        )}
                      </Text>
                    </View>
                    <Text style={s.historySectionLabel}>Before</Text>
                    <View style={[s.historyBlock, s.historyBlockBefore]}>
                      <Text
                        style={[
                          s.historyBlockText,
                          !entry.oldNotes && s.historyBlockEmpty,
                        ]}
                      >
                        {entry.oldNotes || "(empty)"}
                      </Text>
                    </View>
                    <Text style={s.historySectionLabel}>After</Text>
                    <View style={[s.historyBlock, s.historyBlockAfter]}>
                      <Text
                        style={[
                          s.historyBlockText,
                          !entry.newNotes && s.historyBlockEmpty,
                        ]}
                      >
                        {entry.newNotes || "(empty)"}
                      </Text>
                    </View>
                  </View>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ── Review queue modal ── */}
      <Modal
        visible={reviewOpen}
        animationType="slide"
        transparent={Platform.OS === "web"}
        onRequestClose={() => setReviewOpen(false)}
      >
        <View style={s.modal}>
          <View style={[s.modalHeader, { paddingTop: headerPaddingTop }]}>
            <Text style={s.modalTitle}>File Review</Text>
            <Pressable onPress={() => setReviewOpen(false)} hitSlop={12}>
              <Ionicons name="close" size={24} color={colors.text} />
            </Pressable>
          </View>

          {fileCount === 0 ? (
            <View style={s.emptyState}>
              <Ionicons name="folder-open-outline" size={48} color={colors.border} />
              <Text style={s.emptyTitle}>No pending files</Text>
              <Text style={s.emptySub}>
                Files uploaded by lab members will appear here for review.
              </Text>
              <Pressable
                onPress={showPickOptions}
                style={({ pressed }) => [s.uploadBtn, pressed && s.uploadBtnPressed]}
              >
                <Ionicons name="cloud-upload-outline" size={18} color={colors.textInverse} />
                <Text style={s.uploadBtnText}>Upload Files</Text>
              </Pressable>
            </View>
          ) : (
            <ScrollView
              style={s.modalScroll}
              contentContainerStyle={s.modalScrollContent}
              keyboardShouldPersistTaps="handled"
            >
              <View style={s.addMoreRow}>
                {Platform.OS !== "web" ? (
                  <Pressable
                    onPress={() => {
                      setReviewOpen(false);
                      InteractionManager.runAfterInteractions(() => { handleTakePhoto(); });
                    }}
                    style={({ pressed }) => [s.addMoreBtn, s.addMoreBtnCamera, pressed && { opacity: 0.8 }]}
                  >
                    <Ionicons name="camera-outline" size={16} color={colors.textInverse} />
                    <Text style={[s.addMoreBtnText, s.addMoreBtnCameraText]} numberOfLines={1}>Take Photo</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={() => {
                    setReviewOpen(false);
                    InteractionManager.runAfterInteractions(() => { handlePickFromPhotos(); });
                  }}
                  style={({ pressed }) => [s.addMoreBtn, pressed && { opacity: 0.8 }]}
                >
                  <Ionicons name="images-outline" size={16} color={colors.tint} />
                  <Text style={s.addMoreBtnText} numberOfLines={1}>Photos &amp; Videos</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setReviewOpen(false);
                    InteractionManager.runAfterInteractions(() => { handlePickFromDocuments(); });
                  }}
                  style={({ pressed }) => [s.addMoreBtn, pressed && { opacity: 0.8 }]}
                >
                  <Ionicons name="document-text-outline" size={16} color={colors.tint} />
                  <Text style={s.addMoreBtnText} numberOfLines={1}>Files &amp; PDFs</Text>
                </Pressable>
              </View>

              {pendingFiles.map((file) => {
                const isSelected = selectedFile?.id === file.id;
                const kind = detectMimeKind(file.mimeType);

                return (
                  <View key={file.id} style={[s.fileCard, isSelected && s.fileCardSelected]}>
                    {/* Row: thumbnail + meta + actions */}
                    <View style={s.fileRow}>
                      <Pressable
                        onPress={() => openPreview(file)}
                        style={s.thumbPressable}
                        hitSlop={4}
                      >
                        {kind === "image" ? (
                          <Image source={{ uri: file.uri }} style={s.fileThumb} contentFit="cover" />
                        ) : kind === "video" ? (
                          <View style={[s.fileThumb, s.videoThumb]}>
                            <Ionicons name="play-circle" size={22} color={colors.warningStrong} />
                          </View>
                        ) : kind === "pdf" ? (
                          <View style={[s.fileThumb, s.pdfThumb]}>
                            <Ionicons name="document-text" size={20} color={colors.errorStrong} />
                          </View>
                        ) : (
                          <View style={[s.fileThumb, s.fileGenericThumb]}>
                            <Ionicons name="document-outline" size={20} color={colors.textSecondary} />
                          </View>
                        )}
                      </Pressable>

                      <Pressable
                        onPress={() => {
                          if (isSelected) { resetSelection(); return; }
                          setSelectedFile(file);
                          setSelectedProvider(null);
                          setProviderSearch("");
                          setSelectedCase(null);
                          setPatientSearch("");
                          setProviderDropdownOpen(false);
                          setPatientDropdownOpen(false);
                        }}
                        style={s.fileTextWrap}
                      >
                        <Text style={s.fileName} numberOfLines={1}>{file.fileName}</Text>
                        <Text style={s.fileMeta}>
                          {file.uploadedBy} · {new Date(file.uploadedAt).toLocaleDateString()}
                        </Text>
                        {!!file.notes && (
                          <Text style={s.fileNotePreview} numberOfLines={2}>
                            {file.notes}
                          </Text>
                        )}
                        {!!file.notes && !!file.notesUpdatedAt && (
                          <Text style={s.fileNoteEdited} numberOfLines={1}>
                            edited by {file.notesEditedByName || "someone"} ·{" "}
                            {formatRelativeTimeShort(file.notesUpdatedAt)}
                          </Text>
                        )}
                        {!!file.notesUpdatedAt && (
                          <Pressable
                            onPress={(e: any) => {
                              e?.stopPropagation?.();
                              openNoteHistory(file);
                            }}
                            style={({ pressed }) => [
                              s.rowHistoryBtn,
                              pressed && { opacity: 0.7 },
                            ]}
                            hitSlop={6}
                          >
                            <Ionicons name="time-outline" size={12} color={colors.textSecondary} />
                            <Text style={s.rowHistoryText}>View history</Text>
                          </Pressable>
                        )}
                      </Pressable>

                      <View style={s.fileActions}>
                        <Pressable onPress={() => openPreview(file)} hitSlop={8} style={s.fileActionBtn}>
                          <Ionicons name="pencil-outline" size={17} color={colors.textSecondary} />
                        </Pressable>
                        <Pressable onPress={() => removeFile(file.id)} hitSlop={8} style={s.fileActionBtn}>
                          <Ionicons name="trash-outline" size={17} color={colors.error} />
                        </Pressable>
                      </View>
                    </View>

                    {/* Admin assign section */}
                    {isSelected && isAdmin ? (
                      <View style={s.assignSection}>
                        <Text style={s.assignLabel}>Assign to Case</Text>

                        <Text style={s.fieldLabel}>Provider</Text>
                        <TextInput
                          style={s.searchInput}
                          placeholder="Start typing provider name..."
                          placeholderTextColor={colors.textTertiary}
                          value={providerSearch}
                          onChangeText={(value) => {
                            setProviderSearch(value);
                            setProviderDropdownOpen(value.length > 0);
                            if (
                              selectedProvider &&
                              value.trim() !== (selectedProvider.practiceName || "").trim() &&
                              value.trim() !== (selectedProvider.leadDoctor || "").trim()
                            ) {
                              setSelectedProvider(null);
                              setSelectedCase(null);
                              setPatientSearch("");
                            }
                          }}
                          onFocus={() => setProviderDropdownOpen(true)}
                        />

                        {providerDropdownOpen && filteredProviders.length > 0 ? (
                          <View style={s.dropdown}>
                            <ScrollView style={s.dropdownScroll} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                              {filteredProviders.slice(0, 10).map((client) => (
                                <Pressable
                                  key={client.id}
                                  onPress={() => selectProvider(client)}
                                  style={({ pressed }) => [s.dropdownItem, pressed && s.dropdownItemPressed]}
                                >
                                  <Text style={s.dropdownItemText}>{client.practiceName || client.leadDoctor || "Unknown Practice"}</Text>
                                  <Text style={s.dropdownItemSub}>{client.leadDoctor || ""}</Text>
                                </Pressable>
                              ))}
                            </ScrollView>
                          </View>
                        ) : null}

                        {selectedProvider ? (
                          <>
                            <Text style={[s.fieldLabel, s.patientFieldLabel]}>Patient</Text>
                            <TextInput
                              style={s.searchInput}
                              placeholder="Start typing patient name..."
                              placeholderTextColor={colors.textTertiary}
                              value={patientSearch}
                              onChangeText={(value) => {
                                setPatientSearch(value);
                                setPatientDropdownOpen(value.length > 0);
                                if (selectedCase && value !== selectedCase.patientName) setSelectedCase(null);
                              }}
                              onFocus={() => setPatientDropdownOpen(true)}
                            />

                            {patientDropdownOpen && filteredPatients.length > 0 ? (
                              <View style={s.dropdown}>
                                <ScrollView style={s.dropdownScroll} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                                  {filteredPatients.slice(0, 10).map((labCase) => (
                                    <Pressable
                                      key={labCase.id}
                                      onPress={() => selectPatient(labCase)}
                                      style={({ pressed }) => [s.dropdownItem, pressed && s.dropdownItemPressed]}
                                    >
                                      <Text style={s.dropdownItemText}>{labCase.patientName}</Text>
                                      <Text style={s.dropdownItemSub}>Case #{labCase.caseNumber} - {labCase.doctorName}</Text>
                                    </Pressable>
                                  ))}
                                </ScrollView>
                              </View>
                            ) : null}

                            {providerCases.length === 0 ? (
                              <Text style={s.noResults}>No cases found for this provider</Text>
                            ) : null}
                          </>
                        ) : null}

                        <Pressable
                          onPress={handleAddToCase}
                          disabled={!selectedCase}
                          style={({ pressed }) => [
                            s.addToCaseBtn,
                            !selectedCase && s.addToCaseBtnDisabled,
                            pressed && selectedCase && s.uploadBtnPressed,
                          ]}
                        >
                          <Ionicons name="add-circle" size={18} color={colors.textInverse} />
                          <Text style={s.addToCaseBtnText}>Add to Case</Text>
                        </Pressable>
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </ScrollView>
          )}
        </View>
      </Modal>
    </>
  );
});

const makeS = (colors: ThemeColors) => StyleSheet.create({
  bar: {
    marginHorizontal: 20,
    marginTop: 16,
    marginBottom: 10,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
    shadowColor: colors.text,
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  barDragOver: {
    borderColor: colors.info,
    backgroundColor: colors.infoSurface,
  },
  barPressed: {
    opacity: 0.9,
  },
  barContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    paddingVertical: 16,
    paddingHorizontal: 16,
  },
  barMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  barIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: "rgba(37,99,235,0.10)",
    alignItems: "center",
    justifyContent: "center",
  },
  barTextWrap: {
    flex: 1,
    gap: 3,
  },
  barTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
    color: colors.text,
  },
  barSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 17,
  },
  barAction: {
    minWidth: 92,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: colors.infoSurface,
  },
  barActionText: {
    fontFamily: "Inter_700Bold",
    fontSize: 12,
    color: colors.infoStrong,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.error,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  badgeText: {
    fontFamily: "Inter_700Bold",
    fontSize: 11,
    color: colors.textInverse,
  },
  noteBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  noteHandleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: "center",
    marginBottom: 8,
  },
  noteCard: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingTop: 16,
    gap: 12,
  },
  noteCardTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 18,
    color: colors.text,
  },
  noteCardSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 19,
  },
  noteInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.text,
    backgroundColor: colors.canvas,
    minHeight: 90,
    textAlignVertical: "top",
    marginTop: 4,
  },
  noteActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  noteBtnSecondary: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  noteBtnSecondaryText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    color: colors.textSecondary,
  },
  noteBtnPrimary: {
    flex: 2,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: colors.tint,
  },
  noteBtnPrimaryText: {
    fontFamily: "Inter_700Bold",
    fontSize: 14,
    color: colors.textInverse,
  },
  previewScreen: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  previewHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.surfaceAlt,
  },
  previewTitle: {
    flex: 1,
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
    color: colors.text,
    textAlign: "center",
    marginHorizontal: 8,
  },
  previewScroll: {
    flex: 1,
  },
  previewScrollContent: {
    padding: 20,
    gap: 12,
    paddingBottom: 48,
  },
  previewImage: {
    width: "100%",
    height: 280,
    borderRadius: 12,
    backgroundColor: colors.surfaceAlt,
  },
  previewFallback: {
    width: "100%",
    height: 200,
    borderRadius: 12,
    backgroundColor: colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  previewFallbackText: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: "center",
    paddingHorizontal: 20,
  },
  previewNoteLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 8,
  },
  previewNoteInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.text,
    backgroundColor: colors.canvas,
    minHeight: 90,
    textAlignVertical: "top",
  },
  previewSaveBtn: {
    backgroundColor: colors.tint,
    paddingVertical: 13,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 4,
  },
  previewSaveBtnText: {
    fontFamily: "Inter_700Bold",
    fontSize: 15,
    color: colors.textInverse,
  },
  previewMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: colors.textTertiary,
    textAlign: "center",
    marginTop: 4,
  },
  previewMetaEdited: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: colors.textTertiary,
    textAlign: "center",
    marginTop: 2,
    fontStyle: "italic",
  },
  historyLinkBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 8,
    marginTop: 2,
  },
  historyLinkText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    color: colors.textSecondary,
  },
  rowHistoryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    marginTop: 4,
    alignSelf: "flex-start",
    paddingVertical: 2,
  },
  rowHistoryText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    color: colors.textSecondary,
  },
  historyBackdrop: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.45)",
    justifyContent: "flex-end",
  },
  historySheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    maxHeight: "85%",
    minHeight: "40%",
    paddingBottom: 24,
  },
  historyHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.surfaceAlt,
    gap: 12,
  },
  historyHeaderText: {
    flex: 1,
  },
  historyTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 16,
    color: colors.text,
  },
  historySubtitle: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 2,
  },
  historyScroll: {
    flex: 1,
  },
  historyScrollContent: {
    padding: 16,
    gap: 12,
  },
  historyEmpty: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: colors.textTertiary,
    textAlign: "center",
    paddingVertical: 32,
  },
  historyError: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    color: colors.errorStrong,
    textAlign: "center",
    paddingVertical: 32,
  },
  historyEntry: {
    backgroundColor: colors.canvas,
    borderRadius: 12,
    padding: 12,
    gap: 6,
  },
  historyEntryHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 4,
  },
  historyEditor: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    color: colors.text,
    flexShrink: 1,
  },
  historyTime: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: colors.textTertiary,
  },
  historySectionLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 2,
  },
  historyBlock: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  historyBlockBefore: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  historyBlockAfter: {
    backgroundColor: colors.infoSurface,
    borderWidth: 1,
    borderColor: colors.infoLight,
  },
  historyBlockText: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: colors.text,
    lineHeight: 18,
  },
  historyBlockEmpty: {
    fontStyle: "italic",
    color: colors.textTertiary,
  },
  modal: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.surfaceAlt,
  },
  modalTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 20,
    color: colors.text,
  },
  modalScroll: {
    flex: 1,
  },
  modalScrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 8,
  },
  emptyTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
    color: colors.text,
    marginTop: 8,
  },
  emptySub: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: colors.textTertiary,
    textAlign: "center",
    lineHeight: 19,
  },
  uploadBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.tint,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
    marginTop: 12,
  },
  uploadBtnPressed: {
    opacity: 0.82,
  },
  uploadBtnText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    color: colors.textInverse,
  },
  addMoreRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 16,
  },
  addMoreBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.tint,
    backgroundColor: colors.infoSurface,
  },
  addMoreBtnText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    color: colors.tint,
  },
  addMoreBtnCamera: {
    backgroundColor: colors.tint,
    borderColor: colors.tint,
  },
  addMoreBtnCameraText: {
    color: colors.textInverse,
  },
  captureThumb: {
    width: "100%",
    height: 140,
    borderRadius: 10,
    marginBottom: 12,
  },
  fileCard: {
    backgroundColor: colors.canvas,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 12,
    overflow: "hidden",
  },
  fileCardSelected: {
    borderColor: colors.tint,
    backgroundColor: colors.infoSurface,
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    gap: 12,
  },
  thumbPressable: {
    borderRadius: 8,
    overflow: "hidden",
  },
  fileThumb: {
    width: 52,
    height: 52,
    borderRadius: 8,
    backgroundColor: colors.border,
  },
  videoThumb: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.warningLight,
  },
  pdfThumb: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.errorLight,
  },
  fileGenericThumb: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceAlt,
  },
  fileTextWrap: {
    flex: 1,
    gap: 2,
  },
  fileName: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    color: colors.text,
  },
  fileMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: colors.textTertiary,
  },
  fileNotePreview: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 3,
    fontStyle: "italic",
    lineHeight: 16,
  },
  fileNoteEdited: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: colors.textTertiary,
    marginTop: 2,
    fontStyle: "italic",
  },
  fileActions: {
    flexDirection: "column",
    gap: 4,
  },
  fileActionBtn: {
    padding: 6,
    borderRadius: 6,
  },
  assignSection: {
    padding: 12,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  assignLabel: {
    fontFamily: "Inter_700Bold",
    fontSize: 14,
    color: colors.text,
    marginBottom: 10,
  },
  fieldLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    color: colors.textSecondary,
    marginBottom: 4,
  },
  patientFieldLabel: {
    marginTop: 12,
  },
  searchInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.text,
    backgroundColor: colors.surface,
  },
  dropdown: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.surface,
    marginTop: 4,
    overflow: "hidden",
  },
  dropdownScroll: {
    maxHeight: 150,
  },
  dropdownItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.surfaceAlt,
  },
  dropdownItemPressed: {
    backgroundColor: colors.surfaceAlt,
  },
  dropdownItemText: {
    fontFamily: "Inter_500Medium",
    fontSize: 14,
    color: colors.text,
  },
  dropdownItemSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: colors.textTertiary,
    marginTop: 1,
  },
  noResults: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 8,
    fontStyle: "italic",
  },
  addToCaseBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: colors.success,
    paddingVertical: 12,
    borderRadius: 10,
    marginTop: 16,
  },
  addToCaseBtnDisabled: {
    backgroundColor: colors.border,
  },
  addToCaseBtnText: {
    fontFamily: "Inter_700Bold",
    fontSize: 14,
    color: colors.textInverse,
  },
});
