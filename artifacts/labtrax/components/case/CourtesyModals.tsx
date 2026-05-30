import React, { useMemo } from "react";
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
import { useTheme, type ThemeColors } from "@/lib/theme-context";

export type CourtesyTextModalProps = {
  visible: boolean;
  onClose: () => void;
  message: string;
  onChangeMessage: (v: string) => void;
  onSend: (message: string) => void;
};

export function CourtesyTextModal({ visible, onClose, message, onChangeMessage, onSend }: CourtesyTextModalProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeCtStyles(colors), [colors]);
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.modalOverlay}
      >
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Courtesy Text</Text>
            <Pressable onPress={onClose}>
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </Pressable>
          </View>
          <Text style={styles.modalSubtitle}>
            Send a delay notification to the doctor. You can edit the message before sending.
          </Text>
          <TextInput
            style={styles.messageInput}
            value={message}
            onChangeText={onChangeMessage}
            multiline
            textAlignVertical="top"
            placeholder="Courtesy message..."
            placeholderTextColor={colors.textTertiary}
          />
          <Pressable
            onPress={() => {
              const trimmed = message.trim();
              if (trimmed) {
                onSend(trimmed);
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              }
            }}
            style={({ pressed }) => [styles.sendBtn, pressed && { opacity: 0.85 }]}
          >
            <Ionicons name="send" size={20} color={colors.textInverse} />
            <Text style={styles.sendBtnText}>Send Courtesy Text</Text>
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
  const { colors } = useTheme();
  const styles = useMemo(() => makeCtStyles(colors), [colors]);
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.modalOverlay}
      >
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Ionicons name="cube-outline" size={22} color={colors.violet} />
              <Text style={styles.modalTitle}>Link ExoCAD Design</Text>
            </View>
            <Pressable onPress={onClose}>
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </Pressable>
          </View>
          <Text style={styles.modalSubtitle}>
            Paste the ExoCAD WebView URL to share the 3D design with the provider.
          </Text>
          <TextInput
            style={[styles.dateInput, { marginBottom: 12 }]}
            value={urlInput}
            onChangeText={onChangeUrlInput}
            placeholder="https://webview.exocad.com/..."
            placeholderTextColor={colors.textTertiary}
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
            style={({ pressed }) => [styles.sendBtn, { backgroundColor: colors.violet }, pressed && { opacity: 0.85 }]}
          >
            <Ionicons name="link" size={20} color={colors.textInverse} />
            <Text style={styles.sendBtnText}>Link Design</Text>
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
  const { colors } = useTheme();
  const styles = useMemo(() => makeCtStyles(colors), [colors]);
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.modalOverlay}
      >
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Propose Delivery Date</Text>
            <Pressable onPress={onClose}>
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </Pressable>
          </View>
          <Text style={styles.modalSubtitle}>
            Provide an updated delivery date and time for the client to review.
          </Text>
          <Text style={styles.inputLabel}>Date (MM/DD/YYYY)</Text>
          <TextInput
            style={styles.dateInput}
            value={date}
            onChangeText={onChangeDate}
            placeholder="03/15/2026"
            placeholderTextColor={colors.textTertiary}
          />
          <Text style={styles.inputLabel}>Time</Text>
          <TextInput
            style={styles.dateInput}
            value={time}
            onChangeText={onChangeTime}
            placeholder="2:00 PM"
            placeholderTextColor={colors.textTertiary}
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
            style={({ pressed }) => [styles.sendBtn, { backgroundColor: colors.info }, pressed && { opacity: 0.85 }]}
          >
            <Ionicons name="calendar" size={20} color={colors.textInverse} />
            <Text style={styles.sendBtnText}>Propose Date</Text>
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
  const { colors } = useTheme();
  const styles = useMemo(() => makeCtStyles(colors), [colors]);
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.modalOverlay}
      >
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Decline Proposed Date</Text>
            <Pressable onPress={onClose}>
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </Pressable>
          </View>
          <Text style={styles.modalSubtitle}>
            Let the lab know why this date doesn&apos;t work so they can propose a better one.
          </Text>
          <TextInput
            style={styles.messageInput}
            value={note}
            onChangeText={onChangeNote}
            multiline
            textAlignVertical="top"
            placeholder="Optional note..."
            placeholderTextColor={colors.textTertiary}
          />
          <Pressable
            onPress={() => {
              onDecline(note.trim());
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            }}
            style={({ pressed }) => [styles.sendBtn, { backgroundColor: colors.error }, pressed && { opacity: 0.85 }]}
          >
            <Ionicons name="close-circle" size={20} color={colors.textInverse} />
            <Text style={styles.sendBtnText}>Decline &amp; Request New Date</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export type ProviderDateRequestModalProps = {
  visible: boolean;
  onClose: () => void;
  date: string;
  note: string;
  onChangeDate: (v: string) => void;
  onChangeNote: (v: string) => void;
  onSubmit: (date: string, note: string) => void;
  submitting?: boolean;
};

export function ProviderDateRequestModal({
  visible,
  onClose,
  date,
  note,
  onChangeDate,
  onChangeNote,
  onSubmit,
  submitting = false,
}: ProviderDateRequestModalProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeCtStyles(colors), [colors]);
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.modalOverlay}
      >
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Request Delivery Date Change</Text>
            <Pressable onPress={onClose}>
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </Pressable>
          </View>
          <Text style={styles.modalSubtitle}>
            Enter your preferred delivery date. The lab will accept, counter, or contact you.
          </Text>
          <Text style={styles.inputLabel}>Preferred Date (MM/DD/YYYY)</Text>
          <TextInput
            style={styles.dateInput}
            value={date}
            onChangeText={onChangeDate}
            placeholder="03/15/2026"
            placeholderTextColor={colors.textTertiary}
            keyboardType="numbers-and-punctuation"
          />
          <Text style={styles.inputLabel}>Note (optional)</Text>
          <TextInput
            style={styles.messageInput}
            value={note}
            onChangeText={onChangeNote}
            multiline
            textAlignVertical="top"
            placeholder="e.g. Patient appointment moved to next week"
            placeholderTextColor={colors.textTertiary}
          />
          <Pressable
            onPress={() => {
              if (!submitting && date.trim()) {
                onSubmit(date.trim(), note.trim());
                if (Platform.OS !== "web") {
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                }
              }
            }}
            style={({ pressed }) => [
              styles.sendBtn,
              { backgroundColor: colors.violet },
              pressed && { opacity: 0.85 },
              (submitting || !date.trim()) && { opacity: 0.45 },
            ]}
          >
            <Ionicons name="calendar-outline" size={20} color={colors.textInverse} />
            <Text style={styles.sendBtnText}>{submitting ? "Sending…" : "Send Request"}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const makeCtStyles = (colors: ThemeColors) => StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  modalCard: {
    backgroundColor: colors.surface,
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
    color: colors.text,
  },
  modalSubtitle: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.textSecondary,
    lineHeight: 19,
  },
  messageInput: {
    backgroundColor: colors.background,
    borderRadius: 12,
    padding: 14,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.text,
    minHeight: 120,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  dateInput: {
    backgroundColor: colors.background,
    borderRadius: 12,
    padding: 14,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  inputLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.text,
  },
  sendBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.warning,
    paddingVertical: 14,
    borderRadius: 14,
    marginTop: 4,
  },
  sendBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.textInverse,
  },
});
