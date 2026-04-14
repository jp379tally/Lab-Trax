import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
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

export function LabFileDropZone({
  cases,
  clients,
  currentUser,
  onAddToCase,
  isAdmin,
  isFocused = true,
}: LabFileDropZoneProps) {
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

  const dragCounterRef = useRef(0);
  const pendingFilesRef = useRef<PendingFile[]>([]);

  useEffect(() => {
    pendingFilesRef.current = pendingFiles;
  }, [pendingFiles]);

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
        if (cancelled) {
          return;
        }

        if (!raw) {
          setPendingFiles([]);
          return;
        }

        try {
          const parsed = JSON.parse(raw);
          setPendingFiles(Array.isArray(parsed) ? parsed : []);
        } catch {
          setPendingFiles([]);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPendingFiles([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentUser]);

  const addFiles = useCallback(
    async (newFiles: PendingFile[]) => {
      if (newFiles.length === 0) {
        return;
      }

      const updated = [...pendingFilesRef.current, ...newFiles];
      await persistFiles(updated);

      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      }
    },
    [persistFiles],
  );

  const processDroppedFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      const newPending: PendingFile[] = [];

      for (const file of files) {
        const isValidType = file.type.startsWith("image/") || file.type.startsWith("video/");
        if (!isValidType) {
          continue;
        }

        const maxSize = 5 * 1024 * 1024;
        if (file.size > maxSize) {
          continue;
        }

        try {
          const dataUri = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(new Error("Failed to read file"));
            reader.readAsDataURL(file);
          });

          newPending.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            uri: dataUri,
            fileName: file.name,
            mimeType: file.type,
            uploadedBy: currentUser || "Unknown",
            uploadedAt: Date.now(),
          });
        } catch {}
      }

      await addFiles(newPending);
    },
    [addFiles, currentUser],
  );

  const processDroppedFilesRef = useRef(processDroppedFiles);

  useEffect(() => {
    processDroppedFilesRef.current = processDroppedFiles;
  }, [processDroppedFiles]);

  async function handlePickFiles() {
    if (Platform.OS === "web") {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*,video/*";
      input.multiple = true;
      input.onchange = async () => {
        if (input.files) {
          await processDroppedFiles(input.files);
        }
      };
      input.click();
      return;
    }

    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images", "videos"],
        allowsMultipleSelection: true,
        quality: 0.8,
      });

      if (result.canceled || result.assets.length === 0) {
        return;
      }

      const newPending: PendingFile[] = result.assets.map((asset) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        uri: asset.uri,
        fileName: asset.fileName || "file",
        mimeType: asset.mimeType || "image/jpeg",
        uploadedBy: currentUser || "Unknown",
        uploadedAt: Date.now(),
      }));

      await addFiles(newPending);
    } catch {}
  }

  useEffect(() => {
    if (Platform.OS !== "web") {
      return;
    }

    if (!isFocused) {
      setDragOver(false);
      dragCounterRef.current = 0;
      return;
    }

    dragCounterRef.current = 0;

    const handleDragEnter = (event: DragEvent) => {
      if (!event.dataTransfer?.types?.includes("Files")) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current += 1;
      setDragOver(true);
    };

    const handleDragOver = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };

    const handleDragLeave = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current -= 1;

      if (dragCounterRef.current <= 0) {
        dragCounterRef.current = 0;
        setDragOver(false);
      }
    };

    const handleDrop = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current = 0;
      setDragOver(false);

      if (event.dataTransfer?.files?.length) {
        processDroppedFilesRef.current(event.dataTransfer.files);
      }
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
    const updated = pendingFilesRef.current.filter((file) => file.id !== fileId);
    persistFiles(updated).catch(() => {});

    if (selectedFile?.id === fileId) {
      resetSelection();
    }
  }

  function handleAddToCase() {
    if (!selectedFile || !selectedCase) {
      return;
    }

    onAddToCase(selectedCase.id, selectedFile.uri);
    removeFile(selectedFile.id);

    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }

    Alert.alert("Added", `File attached to ${selectedCase.patientName}'s case.`);
  }

  function handleBarPress() {
    if (pendingFiles.length > 0) {
      setReviewOpen(true);
      return;
    }

    handlePickFiles();
  }

  function selectProvider(client: Client) {
    setSelectedProvider(client);
    setProviderSearch(client.practiceName);
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

  const activeClients = clients.filter((client) => client.status !== "inactive");
  const filteredProviders =
    providerSearch.trim().length > 0
      ? activeClients.filter((client) => {
          const query = providerSearch.toLowerCase();
          return (
            client.practiceName.toLowerCase().includes(query) ||
            client.leadDoctor.toLowerCase().includes(query)
          );
        })
      : activeClients;

  const providerCases = selectedProvider
    ? cases.filter((labCase) => {
        const doctorName = (labCase.doctorName || "").toLowerCase().trim();
        const leadDoctor = (selectedProvider.leadDoctor || "").toLowerCase().trim();
        const additionalProviders = (selectedProvider.additionalProviders || [])
          .map((provider) => provider.toLowerCase().trim())
          .filter(Boolean);

        return doctorName === leadDoctor || additionalProviders.includes(doctorName);
      })
    : [];

  const filteredPatients =
    patientSearch.trim().length > 0
      ? providerCases.filter((labCase) =>
          labCase.patientName.toLowerCase().includes(patientSearch.toLowerCase()),
        )
      : providerCases;

  const fileCount = pendingFiles.length;
  const barTitle = dragOver
    ? "Drop files to intake"
    : fileCount > 0
      ? `${fileCount} file${fileCount !== 1 ? "s" : ""} ready for review`
      : "Case media intake";
  const barSub = dragOver
    ? "Release to upload these files"
    : fileCount > 0
      ? "Open the review queue and assign files to the correct case"
      : Platform.OS === "web"
        ? "Drag files here or browse to attach new case media"
        : "Browse photos or videos to attach new case media";
  const barActionLabel = dragOver ? "Drop Now" : fileCount > 0 ? "Review" : "Upload";

  return (
    <>
      <Pressable
        testID="lab-file-drop-bar"
        onPress={handleBarPress}
        style={({ pressed }) => [
          s.bar,
          dragOver && s.barDragOver,
          pressed && s.barPressed,
        ]}
      >
        <View style={s.barContent}>
          <View style={s.barMain}>
            <View style={s.barIconWrap}>
              <Ionicons
                name={dragOver ? "arrow-down-circle" : fileCount > 0 ? "folder-open" : "cloud-upload-outline"}
                size={22}
                color={dragOver ? "#2563EB" : fileCount > 0 ? "#D97706" : Colors.light.tint}
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

      <Modal
        visible={reviewOpen}
        animationType="slide"
        transparent={Platform.OS === "web"}
        onRequestClose={() => setReviewOpen(false)}
      >
        <View style={s.modal}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>File Review</Text>
            <Pressable onPress={() => setReviewOpen(false)} hitSlop={12}>
              <Ionicons name="close" size={24} color={Colors.light.text} />
            </Pressable>
          </View>

          {fileCount === 0 ? (
            <View style={s.emptyState}>
              <Ionicons name="folder-open-outline" size={48} color="#CBD5E1" />
              <Text style={s.emptyTitle}>No pending files</Text>
              <Text style={s.emptySub}>
                Files uploaded by lab members will appear here for review.
              </Text>
              <Pressable
                onPress={handlePickFiles}
                style={({ pressed }) => [s.uploadBtn, pressed && s.uploadBtnPressed]}
              >
                <Ionicons name="cloud-upload-outline" size={18} color="#FFF" />
                <Text style={s.uploadBtnText}>Upload Files</Text>
              </Pressable>
            </View>
          ) : (
            <ScrollView style={s.modalScroll} contentContainerStyle={s.modalScrollContent}>
              <Pressable
                onPress={handlePickFiles}
                style={({ pressed }) => [
                  s.uploadBtn,
                  s.addMoreBtn,
                  pressed && s.uploadBtnPressed,
                ]}
              >
                <Ionicons name="add" size={18} color="#FFF" />
                <Text style={s.uploadBtnText}>Add More Files</Text>
              </Pressable>

              {pendingFiles.map((file) => {
                const isSelected = selectedFile?.id === file.id;
                const isImage = file.mimeType.startsWith("image/");

                return (
                  <View key={file.id} style={[s.fileCard, isSelected && s.fileCardSelected]}>
                    <Pressable
                      onPress={() => {
                        if (isSelected) {
                          resetSelection();
                          return;
                        }

                        setSelectedFile(file);
                        setSelectedProvider(null);
                        setProviderSearch("");
                        setSelectedCase(null);
                        setPatientSearch("");
                        setProviderDropdownOpen(false);
                        setPatientDropdownOpen(false);
                      }}
                      style={s.fileRow}
                    >
                      {isImage ? (
                        <Image source={{ uri: file.uri }} style={s.fileThumb} contentFit="cover" />
                      ) : (
                        <View style={[s.fileThumb, s.videoThumb]}>
                          <Ionicons name="videocam" size={20} color="#D97706" />
                        </View>
                      )}

                      <View style={s.fileTextWrap}>
                        <Text style={s.fileName} numberOfLines={1}>
                          {file.fileName}
                        </Text>
                        <Text style={s.fileMeta}>
                          Uploaded by {file.uploadedBy} - {new Date(file.uploadedAt).toLocaleDateString()}
                        </Text>
                      </View>

                      <Pressable onPress={() => removeFile(file.id)} hitSlop={8}>
                        <Ionicons name="trash-outline" size={18} color="#EF4444" />
                      </Pressable>
                    </Pressable>

                    {isSelected && isAdmin ? (
                      <View style={s.assignSection}>
                        <Text style={s.assignLabel}>Assign to Case</Text>

                        <Text style={s.fieldLabel}>Provider</Text>
                        <TextInput
                          style={s.searchInput}
                          placeholder="Start typing provider name..."
                          placeholderTextColor="#94A3B8"
                          value={providerSearch}
                          onChangeText={(value) => {
                            setProviderSearch(value);
                            setProviderDropdownOpen(value.length > 0);

                            if (selectedProvider && value !== selectedProvider.practiceName) {
                              setSelectedProvider(null);
                              setSelectedCase(null);
                              setPatientSearch("");
                            }
                          }}
                          onFocus={() => setProviderDropdownOpen(true)}
                        />

                        {providerDropdownOpen && filteredProviders.length > 0 ? (
                          <View style={s.dropdown}>
                            <ScrollView
                              style={s.dropdownScroll}
                              keyboardShouldPersistTaps="handled"
                              nestedScrollEnabled
                            >
                              {filteredProviders.slice(0, 10).map((client) => (
                                <Pressable
                                  key={client.id}
                                  onPress={() => selectProvider(client)}
                                  style={({ pressed }) => [
                                    s.dropdownItem,
                                    pressed && s.dropdownItemPressed,
                                  ]}
                                >
                                  <Text style={s.dropdownItemText}>{client.practiceName}</Text>
                                  <Text style={s.dropdownItemSub}>{client.leadDoctor}</Text>
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
                              placeholderTextColor="#94A3B8"
                              value={patientSearch}
                              onChangeText={(value) => {
                                setPatientSearch(value);
                                setPatientDropdownOpen(value.length > 0);

                                if (selectedCase && value !== selectedCase.patientName) {
                                  setSelectedCase(null);
                                }
                              }}
                              onFocus={() => setPatientDropdownOpen(true)}
                            />

                            {patientDropdownOpen && filteredPatients.length > 0 ? (
                              <View style={s.dropdown}>
                                <ScrollView
                                  style={s.dropdownScroll}
                                  keyboardShouldPersistTaps="handled"
                                  nestedScrollEnabled
                                >
                                  {filteredPatients.slice(0, 10).map((labCase) => (
                                    <Pressable
                                      key={labCase.id}
                                      onPress={() => selectPatient(labCase)}
                                      style={({ pressed }) => [
                                        s.dropdownItem,
                                        pressed && s.dropdownItemPressed,
                                      ]}
                                    >
                                      <Text style={s.dropdownItemText}>{labCase.patientName}</Text>
                                      <Text style={s.dropdownItemSub}>
                                        Case #{labCase.caseNumber} - {labCase.doctorName}
                                      </Text>
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
                          <Ionicons name="add-circle" size={18} color="#FFF" />
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
}

const s = StyleSheet.create({
  bar: {
    marginHorizontal: 20,
    marginTop: 16,
    marginBottom: 10,
    borderRadius: 18,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#DCE7F5",
    overflow: "hidden",
    shadowColor: "#0F172A",
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  barDragOver: {
    borderColor: "#2563EB",
    backgroundColor: "#EFF6FF",
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
    color: Colors.light.text,
  },
  barSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: "#64748B",
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
    backgroundColor: "#EEF4FF",
  },
  barActionText: {
    fontFamily: "Inter_700Bold",
    fontSize: 12,
    color: "#1D4ED8",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#EF4444",
    alignItems: "center",
    justifyContent: "center",
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
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: Platform.OS === "web" ? 20 : 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#F1F5F9",
  },
  modalTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 20,
    color: Colors.light.text,
  },
  modalScroll: {
    flex: 1,
  },
  modalScrollContent: {
    padding: 16,
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
    color: Colors.light.text,
    marginTop: 8,
  },
  emptySub: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: "#94A3B8",
    textAlign: "center",
    lineHeight: 19,
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
  addMoreBtn: {
    alignSelf: "flex-start",
    marginBottom: 16,
  },
  uploadBtnPressed: {
    opacity: 0.82,
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
  videoThumb: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FEF3C7",
  },
  fileTextWrap: {
    flex: 1,
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
  patientFieldLabel: {
    marginTop: 12,
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
  dropdownScroll: {
    maxHeight: 150,
  },
  dropdownItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#F1F5F9",
  },
  dropdownItemPressed: {
    backgroundColor: "#F1F5F9",
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
