import React from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Alert,
  Share,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import Colors from "@/constants/colors";

export type CourtesyTextModalProps = {
  visible: boolean;
  onClose: () => void;
  message: string;
  onChangeMessage: (v: string) => void;
  onSend: (message: string) => void;
};

export function CourtesyTextModal({ visible, onClose, message, onChangeMessage, onSend }: CourtesyTextModalProps) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={ctStyles.modalOverlay}
      >
        <View style={ctStyles.modalCard}>
          <View style={ctStyles.modalHeader}>
            <Text style={ctStyles.modalTitle}>Courtesy Text</Text>
            <Pressable onPress={onClose}>
              <Ionicons name="close" size={24} color={Colors.light.textSecondary} />
            </Pressable>
          </View>
          <Text style={ctStyles.modalSubtitle}>
            Send a delay notification to the doctor. You can edit the message before sending.
          </Text>
          <TextInput
            style={ctStyles.messageInput}
            value={message}
            onChangeText={onChangeMessage}
            multiline
            textAlignVertical="top"
            placeholder="Courtesy message..."
            placeholderTextColor="#94A3B8"
          />
          <Pressable
            onPress={() => {
              const trimmed = message.trim();
              if (trimmed) {
                onSend(trimmed);
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              }
            }}
            style={({ pressed }) => [ctStyles.sendBtn, pressed && { opacity: 0.85 }]}
          >
            <Ionicons name="send" size={20} color="#FFF" />
            <Text style={ctStyles.sendBtnText}>Send Courtesy Text</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export type ExocadLinkContext<T> = T;

export type ExocadLinkModalProps<T> = {
  visible: boolean;
  onClose: () => void;
  urlInput: string;
  onChangeUrlInput: (v: string) => void;
  patientName: string;
  caseNumber: string;
  onLink: (url: string) => T;
  onShareAfterLink: (ctx: T) => void;
};

export function ExocadLinkModal<T>({
  visible,
  onClose,
  urlInput,
  onChangeUrlInput,
  patientName,
  caseNumber,
  onLink,
  onShareAfterLink,
}: ExocadLinkModalProps<T>) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={ctStyles.modalOverlay}
      >
        <View style={ctStyles.modalCard}>
          <View style={ctStyles.modalHeader}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Ionicons name="cube-outline" size={22} color="#7C3AED" />
              <Text style={ctStyles.modalTitle}>Link ExoCAD Design</Text>
            </View>
            <Pressable onPress={onClose}>
              <Ionicons name="close" size={24} color={Colors.light.textSecondary} />
            </Pressable>
          </View>
          <Text style={ctStyles.modalSubtitle}>
            Paste the ExoCAD WebView URL to share the 3D design with the provider.
          </Text>
          <TextInput
            style={[ctStyles.dateInput, { marginBottom: 12 }]}
            value={urlInput}
            onChangeText={onChangeUrlInput}
            placeholder="https://webview.exocad.com/..."
            placeholderTextColor="#94A3B8"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Pressable
            onPress={() => {
              const url = urlInput.trim();
              if (!url) {
                Alert.alert("Please enter an ExoCAD WebView URL");
                return;
              }
              if (!url.startsWith("http")) {
                Alert.alert("Invalid URL", "Please enter a valid URL starting with http:// or https://");
                return;
              }
              const ctx = onLink(url);
              if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              Alert.alert(
                "ExoCAD Design Linked",
                "Would you like to share this design with the provider now?",
                [
                  { text: "Later", style: "cancel" },
                  {
                    text: "Share Now",
                    onPress: async () => {
                      try {
                        await Share.share({
                          message: `View the 3D design for patient ${patientName} (Case ${caseNumber}):\n${url}`,
                          title: "ExoCAD WebView Design",
                        });
                        onShareAfterLink(ctx);
                      } catch {}
                    },
                  },
                ],
              );
            }}
            style={({ pressed }) => [ctStyles.sendBtn, { backgroundColor: "#7C3AED" }, pressed && { opacity: 0.85 }]}
          >
            <Ionicons name="link" size={20} color="#FFF" />
            <Text style={ctStyles.sendBtnText}>Link Design</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export type ProposeDateModalProps = {
  visible: boolean;
  onClose: () => void;
  date: string;
  time: string;
  onChangeDate: (v: string) => void;
  onChangeTime: (v: string) => void;
  onPropose: (date: string, time: string) => void;
};

export function ProposeDateModal({ visible, onClose, date, time, onChangeDate, onChangeTime, onPropose }: ProposeDateModalProps) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={ctStyles.modalOverlay}
      >
        <View style={ctStyles.modalCard}>
          <View style={ctStyles.modalHeader}>
            <Text style={ctStyles.modalTitle}>Propose Delivery Date</Text>
            <Pressable onPress={onClose}>
              <Ionicons name="close" size={24} color={Colors.light.textSecondary} />
            </Pressable>
          </View>
          <Text style={ctStyles.modalSubtitle}>
            Provide an updated delivery date and time for the client to review.
          </Text>
          <Text style={ctStyles.inputLabel}>Date (MM/DD/YYYY)</Text>
          <TextInput
            style={ctStyles.dateInput}
            value={date}
            onChangeText={onChangeDate}
            placeholder="03/15/2026"
            placeholderTextColor="#94A3B8"
          />
          <Text style={ctStyles.inputLabel}>Time</Text>
          <TextInput
            style={ctStyles.dateInput}
            value={time}
            onChangeText={onChangeTime}
            placeholder="2:00 PM"
            placeholderTextColor="#94A3B8"
          />
          <Pressable
            onPress={() => {
              const d = date.trim();
              const t = time.trim();
              if (d && t) {
                onPropose(d, t);
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              }
            }}
            style={({ pressed }) => [ctStyles.sendBtn, { backgroundColor: "#3B82F6" }, pressed && { opacity: 0.85 }]}
          >
            <Ionicons name="calendar" size={20} color="#FFF" />
            <Text style={ctStyles.sendBtnText}>Propose Date</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export type DeclineDateModalProps = {
  visible: boolean;
  onClose: () => void;
  note: string;
  onChangeNote: (v: string) => void;
  onDecline: (note: string) => void;
};

export function DeclineDateModal({ visible, onClose, note, onChangeNote, onDecline }: DeclineDateModalProps) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={ctStyles.modalOverlay}
      >
        <View style={ctStyles.modalCard}>
          <View style={ctStyles.modalHeader}>
            <Text style={ctStyles.modalTitle}>Decline Proposed Date</Text>
            <Pressable onPress={onClose}>
              <Ionicons name="close" size={24} color={Colors.light.textSecondary} />
            </Pressable>
          </View>
          <Text style={ctStyles.modalSubtitle}>
            Let the lab know why this date doesn&apos;t work so they can propose a better one.
          </Text>
          <TextInput
            style={ctStyles.messageInput}
            value={note}
            onChangeText={onChangeNote}
            multiline
            textAlignVertical="top"
            placeholder="Optional note..."
            placeholderTextColor="#94A3B8"
          />
          <Pressable
            onPress={() => {
              onDecline(note.trim());
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            }}
            style={({ pressed }) => [ctStyles.sendBtn, { backgroundColor: "#EF4444" }, pressed && { opacity: 0.85 }]}
          >
            <Ionicons name="close-circle" size={20} color="#FFF" />
            <Text style={ctStyles.sendBtnText}>Decline &amp; Request New Date</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const ctStyles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  modalCard: {
    backgroundColor: "#FFF",
    borderRadius: 20,
    padding: 24,
    width: "100%",
    maxWidth: 400,
    gap: 12,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  modalSubtitle: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    lineHeight: 19,
  },
  messageInput: {
    backgroundColor: Colors.light.background,
    borderRadius: 12,
    padding: 14,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
    minHeight: 120,
    borderWidth: 1,
    borderColor: Colors.light.borderLight,
  },
  dateInput: {
    backgroundColor: Colors.light.background,
    borderRadius: 12,
    padding: 14,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
    borderWidth: 1,
    borderColor: Colors.light.borderLight,
  },
  inputLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  sendBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#F59E0B",
    paddingVertical: 14,
    borderRadius: 14,
    marginTop: 4,
  },
  sendBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
});
