import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  Platform,
  Modal,
  ScrollView,
  TextInput,
  Alert,
} from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Colors from "@/constants/colors";
import { Client, LabCase } from "@/lib/data";

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
}

interface LabFileDropZoneProps {
  cases: LabCase[];
  clients: Client[];
  currentUser: string | null;
  onAddToCase: (caseId: string, fileUri: string) => void;
  isAdmin: boolean;
  isFocused?: boolean;
}

export function LabFileDropZone({ cases, clients, currentUser, onAddToCase, isAdmin, isFocused = true }: LabFileDropZoneProps) {
  const insets = useSafeAreaInsets();
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const barRef = useRef<View>(null);
  const pendingFilesRef = useRef<PendingFile[]>([]);

  const [selectedFile, setSelectedFile] = useState<PendingFile | null>(null);
  const [providerSearch, setProviderSearch] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<Client | null>(null);
  const [patientSearch, setPatientSearch] = useState("");
  const [selectedCase, setSelectedCase] = useState<LabCase | null>(null);
  const [providerDropdownOpen, setProviderDropdownOpen] = useState(false);
  const [patientDropdownOpen, setPatientDropdownOpen] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null);

  useEffect(() => {
    pendingFilesRef.current = pendingFiles;
  }, [pendingFiles]);

  useEffect(() => {
    const key = getStorageKey(currentUser);
    AsyncStorage.getItem(key).then((raw) => {
      if (raw) {
        try { setPendingFiles(JSON.parse(raw)); } catch {}
      } else {
        setPendingFiles([]);
      }
    });
  }, [currentUser]);

  const persistFiles = useCallback((files: PendingFile[]) => {
    setPendingFiles(files);
    const key = getStorageKey(currentUser);
    AsyncStorage.setItem(key, JSON.stringify(files)).catch(() => {});
  }, [currentUser]);

  const addFiles = useCallback((newFiles: PendingFile[]) => {
    setPendingFiles((prev) => {
      const updated = [...prev, ...newFiles];
      const key = getStorageKey(currentUser);
      AsyncStorage.setItem(key, JSON.stringify(updated)).catch(() => {});
      return updated;
    });
  }, [currentUser]);

  async function processDroppedFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    const newPending: PendingFile[] = [];
    for (const file of files) {
      const validTypes = ["image/", "video/"];
      const isValid = validTypes.some((t) => file.type.startsWith(t));
      if (!isValid) continue;
      const MAX_SIZE = 5 * 1024 * 1024;
      if (file.size > MAX_SIZE) continue;
      try {
        const dataUri = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error("Failed to read file"));
          reader.readAsDataURL(file);
        });
        newPending.push({
          id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
          uri: dataUri,
          fileName: file.name,
          mimeType: file.type,
          uploadedBy: currentUser || "Unknown",
          uploadedAt: Date.now(),
        });
      } catch {}
    }
    if (newPending.length > 0) {
      addFiles(newPending);
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  }

  async function handlePickFiles() {
    if (Platform.OS === "web") {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*,video/*";
      input.multiple = true;
      input.onchange = async () => {
        if (input.files) await processDroppedFiles(input.files);
      };
      input.click();
    } else {
      try {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images", "videos"],
          allowsMultipleSelection: true,
          quality: 0.8,
        });
        if (!result.canceled && result.assets.length > 0) {
          const newPending: PendingFile[] = result.assets.map((asset) => ({
            id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
            uri: asset.uri,
            fileName: asset.fileName || "file",
            mimeType: asset.mimeType || "image/jpeg",
            uploadedBy: currentUser || "Unknown",
            uploadedAt: Date.now(),
          }));
          addFiles(newPending);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      } catch {}
    }
  }

  const processDroppedFilesRef = useRef(processDroppedFiles);
  processDroppedFilesRef.current = processDroppedFiles;

  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!isFocused) {
      setDragOver(false);
      dragCounterRef.current = 0;
      return;
    }
    dragCounterRef.current = 0;
    const onDocDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current++;
      setDragOver(true);
    };
    const onDocDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onDocDragLeave = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current--;
      if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setDragOver(false); }
    };
    const onDocDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setDragOver(false);
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        processDroppedFilesRef.current(e.dataTransfer.files);
      }
    };
    document.addEventListener("dragenter", onDocDragEnter);
    document.addEventListener("dragover", onDocDragOver);
    document.addEventListener("dragleave", onDocDragLeave);
    document.addEventListener("drop", onDocDrop);
    return () => {
      document.removeEventListener("dragenter", onDocDragEnter);
      document.removeEventListener("dragover", onDocDragOver);
      document.removeEventListener("dragleave", onDocDragLeave);
      document.removeEventListener("drop", onDocDrop);
    };
  }, [isFocused]);

  function removeFile(fileId: string) {
    setPendingFiles((prev) => {
      const updated = prev.filter((f) => f.id !== fileId);
      const key = getStorageKey(currentUser);
      AsyncStorage.setItem(key, JSON.stringify(updated)).catch(() => {});
      return updated;
    });
    if (selectedFile?.id === fileId) {
      setSelectedFile(null);
      setSelectedProvider(null);
      setProviderSearch("");
      setSelectedCase(null);
      setPatientSearch("");
    }
  }

  function handleAddToCase() {
    if (!selectedFile || !selectedCase) return;
    onAddToCase(selectedCase.id, selectedFile.uri);
    removeFile(selectedFile.id);
    setSelectedFile(null);
    setSelectedProvider(null);
    setProviderSearch("");
    setSelectedCase(null);
    setPatientSearch("");
    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert("Added", `File attached to ${selectedCase.patientName}'s case.`);
  }

  const activeClients = clients.filter((c) => c.status !== "inactive");
  const filteredProviders = providerSearch.trim().length > 0
    ? activeClients.filter((c) =>
        c.practiceName.toLowerCase().includes(providerSearch.toLowerCase()) ||
        c.leadDoctor.toLowerCase().includes(providerSearch.toLowerCase())
      )
    : activeClients;

  const providerCases = selectedProvider
    ? cases.filter((c) => {
        const dn = (c.doctorName || "").toLowerCase().trim();
        const lead = (selectedProvider.leadDoctor || "").toLowerCase().trim();
        const additional = (selectedProvider.additionalProviders || []).map((p) => p.toLowerCase().trim()).filter(Boolean);
        return dn === lead || additional.includes(dn);
      })
    : [];

  const filteredPatients = patientSearch.trim().length > 0
    ? providerCases.filter((c) =>
        c.patientName.toLowerCase().includes(patientSearch.toLowerCase())
      )
    : providerCases;

  function selectProvider(client: Client) {
    setSelectedProvider(client);
    setProviderSearch(client.practiceName);
    setProviderDropdownOpen(false);
    setSelectedCase(null);
    setPatientSearch("");
  }

  function selectPatient(c: LabCase) {
    setSelectedCase(c);
    setPatientSearch(c.patientName);
    setPatientDropdownOpen(false);
  }

  const fileCount = pendingFiles.length;

  return (
    <>
      <Pressable
        ref={barRef as any}
        testID="lab-file-drop-bar"
        onPress={() => setReviewOpen(true)}
        style={({ pressed }) => [
          s.bar,
          dragOver && s.barDragOver,
          pressed && { opacity: 0.85 },
        ]}
      >
        <View style={s.barContent}>
          <View style={s.barIconWrap}>
            <Ionicons
              name={dragOver ? "arrow-down-circle" : fileCount > 0 ? "folder-open" : "cloud-upload-outline"}
              size={24}
              color={dragOver ? "#2563EB" : fileCount > 0 ? "#D97706" : Colors.light.tint}
            />
          </View>
          <Text style={s.barTitle}>
            {dragOver
              ? "Drop files here"
              : fileCount > 0
                ? `${fileCount} file${fileCount !== 1 ? "s" : ""} pending review`
                : "File Drop Zone"}
          </Text>
          <Text style={s.barSub}>
            {dragOver
              ? "Release to upload"
              : fileCount > 0
                ? "Tap to review and assign to cases"
                : Platform.OS === "web" ? "Drag & drop or tap to upload files for review" : "Tap to upload files for review"}
          </Text>
          {fileCount > 0 && (
            <View style={s.badge}>
              <Text style={s.badgeText}>{fileCount}</Text>
            </View>
          )}
        </View>
      </Pressable>

      {reviewOpen ? (
      <Modal
        visible
        animationType="slide"
        transparent={Platform.OS === "web"}
        onRequestClose={() => setReviewOpen(false)}
      >
        <View style={s.modal}>
          <View style={[s.modalHeader, { paddingTop: Platform.OS === "web" ? 20 : insets.top + 12 }]}>
            <Text style={s.modalTitle}>File Review</Text>
            <Pressable onPress={() => setReviewOpen(false)} hitSlop={16} style={{ padding: 4 }}>
              <Ionicons name="close" size={26} color={Colors.light.text} />
            </Pressable>
          </View>

          {fileCount === 0 ? (
            <View style={s.emptyState}>
              <Ionicons name="folder-open-outline" size={48} color="#CBD5E1" />
              <Text style={s.emptyTitle}>No pending files</Text>
              <Text style={s.emptySub}>Files uploaded by lab members will appear here for review.</Text>
              <Pressable onPress={handlePickFiles} style={({ pressed }) => [s.uploadBtn, pressed && { opacity: 0.8 }]}>
                <Ionicons name="cloud-upload-outline" size={18} color="#FFF" />
                <Text style={s.uploadBtnText}>Upload Files</Text>
              </Pressable>
            </View>
          ) : (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
              <Pressable onPress={handlePickFiles} style={({ pressed }) => [s.uploadBtn, { marginBottom: 16, alignSelf: "flex-start" }, pressed && { opacity: 0.8 }]}>
                <Ionicons name="add" size={18} color="#FFF" />
                <Text style={s.uploadBtnText}>Add More Files</Text>
              </Pressable>

              {pendingFiles.map((file) => {
                const isSelected = selectedFile?.id === file.id;
                const isImage = file.mimeType?.startsWith("image/");
                const isVideo = file.mimeType?.startsWith("video/");
                return (
                  <View key={file.id} style={[s.fileCard, isSelected && s.fileCardSelected]}>
                    <Pressable
                      onPress={() => {
                        setSelectedFile(isSelected ? null : file);
                        if (!isSelected) {
                          setSelectedProvider(null);
                          setProviderSearch("");
                          setSelectedCase(null);
                          setPatientSearch("");
                        }
                      }}
                      style={s.fileRow}
                    >
                      <Pressable onPress={() => { if (isImage) setPreviewUri(file.uri); }}>
                        {isImage ? (
                          <Image source={{ uri: file.uri }} style={s.fileThumb} contentFit="cover" />
                        ) : (
                          <View style={[s.fileThumb, { justifyContent: "center", alignItems: "center", backgroundColor: "#FEF3C7" }]}>
                            <Ionicons name="videocam" size={20} color="#D97706" />
                          </View>
                        )}
                      </Pressable>
                      <View style={{ flex: 1 }}>
                        <Text style={s.fileName} numberOfLines={1}>{file.fileName}</Text>
                        <Text style={s.fileMeta}>
                          Uploaded by {file.uploadedBy} · {new Date(file.uploadedAt).toLocaleDateString()}
                        </Text>
                      </View>
                      <Pressable onPress={() => removeFile(file.id)} hitSlop={8}>
                        <Ionicons name="trash-outline" size={18} color="#EF4444" />
                      </Pressable>
                    </Pressable>

                    {isSelected && isAdmin && (
                      <View style={s.assignSection}>
                        <Text style={s.assignLabel}>Assign to Case</Text>

                        <Text style={s.fieldLabel}>Provider</Text>
                        <TextInput
                          style={s.searchInput}
                          placeholder="Start typing provider name..."
                          placeholderTextColor="#94A3B8"
                          value={providerSearch}
                          onChangeText={(t) => {
                            setProviderSearch(t);
                            setProviderDropdownOpen(t.length > 0);
                            if (selectedProvider && t !== selectedProvider.practiceName) {
                              setSelectedProvider(null);
                              setSelectedCase(null);
                              setPatientSearch("");
                            }
                          }}
                          onFocus={() => setProviderDropdownOpen(true)}
                        />
                        {providerDropdownOpen && filteredProviders.length > 0 && (
                          <View style={s.dropdown}>
                            <ScrollView style={{ maxHeight: 150 }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                              {filteredProviders.slice(0, 10).map((c) => (
                                <Pressable
                                  key={c.id}
                                  onPress={() => selectProvider(c)}
                                  style={({ pressed }) => [s.dropdownItem, pressed && { backgroundColor: "#F1F5F9" }]}
                                >
                                  <Text style={s.dropdownItemText}>{c.practiceName}</Text>
                                  <Text style={s.dropdownItemSub}>{c.leadDoctor}</Text>
                                </Pressable>
                              ))}
                            </ScrollView>
                          </View>
                        )}

                        {selectedProvider && (
                          <>
                            <Text style={[s.fieldLabel, { marginTop: 12 }]}>Patient</Text>
                            <TextInput
                              style={s.searchInput}
                              placeholder="Start typing patient name..."
                              placeholderTextColor="#94A3B8"
                              value={patientSearch}
                              onChangeText={(t) => {
                                setPatientSearch(t);
                                setPatientDropdownOpen(t.length > 0);
                                if (selectedCase && t !== selectedCase.patientName) {
                                  setSelectedCase(null);
                                }
                              }}
                              onFocus={() => setPatientDropdownOpen(true)}
                            />
                            {patientDropdownOpen && filteredPatients.length > 0 && (
                              <View style={s.dropdown}>
                                <ScrollView style={{ maxHeight: 150 }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                                  {filteredPatients.slice(0, 10).map((c) => (
                                    <Pressable
                                      key={c.id}
                                      onPress={() => selectPatient(c)}
                                      style={({ pressed }) => [s.dropdownItem, pressed && { backgroundColor: "#F1F5F9" }]}
                                    >
                                      <Text style={s.dropdownItemText}>{c.patientName}</Text>
                                      <Text style={s.dropdownItemSub}>Case #{c.caseNumber} · {c.doctorName}</Text>
                                    </Pressable>
                                  ))}
                                </ScrollView>
                              </View>
                            )}
                            {providerCases.length === 0 && (
                              <Text style={s.noResults}>No cases found for this provider</Text>
                            )}
                          </>
                        )}

                        <Pressable
                          onPress={handleAddToCase}
                          disabled={!selectedCase}
                          style={({ pressed }) => [
                            s.addToCaseBtn,
                            !selectedCase && s.addToCaseBtnDisabled,
                            pressed && !!selectedCase && { opacity: 0.8 },
                          ]}
                        >
                          <Ionicons name="add-circle" size={18} color="#FFF" />
                          <Text style={s.addToCaseBtnText}>Add to Case</Text>
                        </Pressable>
                      </View>
                    )}
                  </View>
                );
              })}
            </ScrollView>
          )}
        </View>
      </Modal>
      ) : null}

      {previewUri ? (
        <Modal
          visible
          transparent
          animationType="fade"
          statusBarTranslucent
          onRequestClose={() => setPreviewUri(null)}
        >
          <Pressable
            style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.92)", justifyContent: "center", alignItems: "center" }}
            onPress={() => setPreviewUri(null)}
          >
            <Pressable
              onPress={() => setPreviewUri(null)}
              hitSlop={16}
              style={{ position: "absolute", top: Platform.OS === "web" ? 20 : insets.top + 8, right: 20, zIndex: 10, backgroundColor: "rgba(255,255,255,0.15)", borderRadius: 20, padding: 8 }}
            >
              <Ionicons name="close" size={24} color="#FFF" />
            </Pressable>
            <Image
              source={{ uri: previewUri }}
              style={{ width: "90%", height: "75%" }}
              contentFit="contain"
            />
          </Pressable>
        </Modal>
      ) : null}
    </>
  );
}

const s = StyleSheet.create({
  bar: {
    marginHorizontal: 20,
    marginTop: 12,
    marginBottom: 8,
    borderRadius: 14,
    backgroundColor: "#F8FAFC",
    borderWidth: 1.5,
    borderColor: "#E2E8F0",
    borderStyle: "dashed",
    overflow: "hidden",
  },
  barDragOver: {
    borderColor: "#2563EB",
    backgroundColor: "rgba(37,99,235,0.08)",
  },
  barContent: {
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 24,
    paddingHorizontal: 16,
    gap: 8,
  },
  barIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: "rgba(37,99,235,0.10)",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 2,
  },
  barTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
    color: Colors.light.text,
    textAlign: "center",
  },
  barSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: "#94A3B8",
    marginTop: 0,
    textAlign: "center",
  },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#EF4444",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 6,
  },
  badgeText: {
    fontFamily: "Inter_700Bold",
    fontSize: 11,
    color: "#FFF",
  },
  modal: {
    flex: 1,
    backgroundColor: "#FFF",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#F1F5F9",
  },
  modalTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 20,
    color: Colors.light.text,
  },
  emptyState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
    gap: 8,
  },
  emptyTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
    color: Colors.light.text,
    marginTop: 8,
  },
  emptySub: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: "#94A3B8",
    textAlign: "center",
  },
  uploadBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: Colors.light.tint,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
    marginTop: 12,
  },
  uploadBtnText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    color: "#FFF",
  },
  fileCard: {
    backgroundColor: "#F8FAFC",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    marginBottom: 12,
    overflow: "hidden",
  },
  fileCardSelected: {
    borderColor: Colors.light.tint,
    backgroundColor: "#EFF6FF",
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    gap: 12,
  },
  fileThumb: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: "#E2E8F0",
  },
  fileName: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    color: Colors.light.text,
  },
  fileMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: "#94A3B8",
    marginTop: 2,
  },
  assignSection: {
    padding: 12,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: "#E2E8F0",
  },
  assignLabel: {
    fontFamily: "Inter_700Bold",
    fontSize: 14,
    color: Colors.light.text,
    marginBottom: 10,
  },
  fieldLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    color: "#64748B",
    marginBottom: 4,
  },
  searchInput: {
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
    backgroundColor: "#FFF",
  },
  dropdown: {
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 8,
    backgroundColor: "#FFF",
    marginTop: 4,
    overflow: "hidden",
  },
  dropdownItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#F1F5F9",
  },
  dropdownItemText: {
    fontFamily: "Inter_500Medium",
    fontSize: 14,
    color: Colors.light.text,
  },
  dropdownItemSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: "#94A3B8",
    marginTop: 1,
  },
  noResults: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: "#94A3B8",
    marginTop: 8,
    fontStyle: "italic",
  },
  addToCaseBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#22C55E",
    paddingVertical: 12,
    borderRadius: 10,
    marginTop: 16,
  },
  addToCaseBtnDisabled: {
    backgroundColor: "#CBD5E1",
  },
  addToCaseBtnText: {
    fontFamily: "Inter_700Bold",
    fontSize: 14,
    color: "#FFF",
  },
});
