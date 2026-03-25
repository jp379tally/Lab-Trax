import React from "react";
import { View, Text, Pressable, StyleSheet, Modal } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import Colors from "@/constants/colors";

interface CameraPermissionPromptProps {
  onContinue: () => void;
  onSkip?: () => void;
  skipLabel?: string;
}

export default function CameraPermissionPrompt({ onContinue, onSkip, skipLabel }: CameraPermissionPromptProps) {
  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <View style={styles.iconWrap}>
          <LinearGradient
            colors={[Colors.light.tint, "#3B82F6"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.iconGradient}
          >
            <Ionicons name="camera" size={40} color="#FFF" />
          </LinearGradient>
        </View>
        <Text style={styles.title}>Camera Access</Text>
        <Text style={styles.description}>
          This feature uses your camera to capture dental case photos for case tracking, documentation, and communication with the dental lab.
        </Text>
        <Pressable
          onPress={onContinue}
          style={({ pressed }) => [styles.continueBtn, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }]}
        >
          <Text style={styles.continueBtnText}>Continue</Text>
        </Pressable>
        {onSkip && (
          <Pressable
            onPress={onSkip}
            style={({ pressed }) => [styles.skipBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.skipBtnText}>{skipLabel || "Not now"}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

interface CameraPermissionModalProps {
  visible: boolean;
  onContinue: () => void;
  onCancel: () => void;
}

export function CameraPermissionModal({ visible, onContinue, onCancel }: CameraPermissionModalProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <View style={styles.modalIconWrap}>
            <LinearGradient
              colors={[Colors.light.tint, "#3B82F6"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.modalIconGradient}
            >
              <Ionicons name="camera" size={32} color="#FFF" />
            </LinearGradient>
          </View>
          <Text style={styles.modalTitle}>Camera Access</Text>
          <Text style={styles.modalDescription}>
            This feature uses your camera to capture dental case photos for case tracking, documentation, and communication with the dental lab.
          </Text>
          <Pressable
            onPress={onContinue}
            style={({ pressed }) => [styles.modalContinueBtn, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.continueBtnText}>Continue</Text>
          </Pressable>
          <Pressable
            onPress={onCancel}
            style={({ pressed }) => [styles.modalCancelBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.modalCancelText}>Not now</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light.background,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  content: {
    alignItems: "center",
    maxWidth: 340,
  },
  iconWrap: {
    marginBottom: 24,
  },
  iconGradient: {
    width: 88,
    height: 88,
    borderRadius: 28,
    justifyContent: "center",
    alignItems: "center",
  },
  title: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    marginBottom: 12,
    textAlign: "center",
  },
  description: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 32,
  },
  continueBtn: {
    backgroundColor: Colors.light.tint,
    paddingVertical: 16,
    paddingHorizontal: 48,
    borderRadius: 14,
    width: "100%",
    alignItems: "center",
  },
  continueBtnText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
  skipBtn: {
    marginTop: 16,
    paddingVertical: 12,
  },
  skipBtnText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  modalCard: {
    backgroundColor: Colors.light.background,
    borderRadius: 20,
    padding: 32,
    alignItems: "center",
    maxWidth: 360,
    width: "100%",
  },
  modalIconWrap: {
    marginBottom: 20,
  },
  modalIconGradient: {
    width: 72,
    height: 72,
    borderRadius: 22,
    justifyContent: "center",
    alignItems: "center",
  },
  modalTitle: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    marginBottom: 10,
    textAlign: "center",
  },
  modalDescription: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 24,
  },
  modalContinueBtn: {
    backgroundColor: Colors.light.tint,
    paddingVertical: 14,
    paddingHorizontal: 48,
    borderRadius: 14,
    width: "100%",
    alignItems: "center",
  },
  modalCancelBtn: {
    marginTop: 14,
    paddingVertical: 10,
  },
  modalCancelText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
  },
});
