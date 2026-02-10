import React, { useState, useEffect } from "react";
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  Pressable,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import * as LocalAuthentication from "expo-local-authentication";
import { useAuth } from "@/lib/auth-context";
import Colors from "@/constants/colors";

export default function LockScreen() {
  const insets = useSafeAreaInsets();
  const { unlockWithBiometric, unlockWithPassword, currentUser, logout } = useAuth();
  const [showPasswordInput, setShowPasswordInput] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricType, setBiometricType] = useState("Biometric");

  useEffect(() => {
    checkBiometric();
  }, []);

  async function checkBiometric() {
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();
      setBiometricAvailable(hasHardware && isEnrolled);
      if (hasHardware && isEnrolled) {
        const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
        if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
          setBiometricType("Face ID");
        } else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
          setBiometricType("Fingerprint");
        }
      }
    } catch {}
  }

  async function handleBiometricUnlock() {
    setIsUnlocking(true);
    setError(null);
    const result = await unlockWithBiometric();
    if (!result.success) {
      setError(result.error || "Authentication failed.");
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } else {
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    }
    setIsUnlocking(false);
  }

  function handlePasswordUnlock() {
    setError(null);
    const result = unlockWithPassword(password);
    if (!result.success) {
      setError(result.error || "Incorrect password.");
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } else {
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    }
  }

  return (
    <LinearGradient colors={["#0F172A", "#1E293B", "#0F172A"]} style={styles.container}>
      <View style={[styles.content, { paddingTop: Platform.OS === "web" ? 100 : insets.top + 60 }]}>
        <View style={styles.lockIcon}>
          <Ionicons name="lock-closed" size={48} color="#FFF" />
        </View>
        <Text style={styles.title}>Session Locked</Text>
        <Text style={styles.subtitle}>
          Your session has been locked due to inactivity.{"\n"}Please authenticate to continue.
        </Text>
        {currentUser && (
          <View style={styles.userBadge}>
            <Ionicons name="person-circle" size={20} color="#94A3B8" />
            <Text style={styles.userBadgeText}>{currentUser}</Text>
          </View>
        )}

        {error && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={16} color="#EF4444" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {!showPasswordInput ? (
          <View style={styles.actions}>
            {biometricAvailable && Platform.OS !== "web" && (
              <Pressable
                style={({ pressed }) => [styles.biometricBtn, pressed && { opacity: 0.85 }]}
                onPress={handleBiometricUnlock}
                disabled={isUnlocking}
              >
                {isUnlocking ? (
                  <ActivityIndicator color="#FFF" />
                ) : (
                  <>
                    <Ionicons
                      name={biometricType === "Face ID" ? "scan" : "finger-print"}
                      size={24}
                      color="#FFF"
                    />
                    <Text style={styles.biometricText}>Unlock with {biometricType}</Text>
                  </>
                )}
              </Pressable>
            )}

            <Pressable
              style={({ pressed }) => [styles.passwordBtn, pressed && { opacity: 0.85 }]}
              onPress={() => setShowPasswordInput(true)}
            >
              <Ionicons name="key" size={20} color="#94A3B8" />
              <Text style={styles.passwordBtnText}>Use Password</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.passwordSection}>
            <TextInput
              style={styles.input}
              placeholder="Enter your password"
              placeholderTextColor="#475569"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoFocus
              onSubmitEditing={handlePasswordUnlock}
            />
            <Pressable
              style={({ pressed }) => [styles.unlockBtn, pressed && { opacity: 0.85 }]}
              onPress={handlePasswordUnlock}
            >
              <Text style={styles.unlockText}>Unlock</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.7 }]}
              onPress={() => { setShowPasswordInput(false); setPassword(""); setError(null); }}
            >
              <Text style={styles.backText}>Back</Text>
            </Pressable>
          </View>
        )}

        <Pressable
          style={({ pressed }) => [styles.logoutLink, pressed && { opacity: 0.7 }]}
          onPress={logout}
        >
          <Ionicons name="log-out-outline" size={16} color="#64748B" />
          <Text style={styles.logoutText}>Sign Out</Text>
        </Pressable>
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    alignItems: "center",
    paddingHorizontal: 32,
  },
  lockIcon: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: "rgba(99,102,241,0.2)",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 24,
    borderWidth: 2,
    borderColor: "rgba(99,102,241,0.3)",
  },
  title: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: "#F8FAFC",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#94A3B8",
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 20,
  },
  userBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(255,255,255,0.06)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    marginBottom: 24,
  },
  userBadgeText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: "#CBD5E1",
  },
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(239,68,68,0.15)",
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
    width: "100%",
  },
  errorText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#FCA5A5",
    flex: 1,
  },
  actions: {
    width: "100%",
    gap: 14,
    alignItems: "center",
  },
  biometricBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: "#6366F1",
    borderRadius: 14,
    paddingVertical: 16,
    width: "100%",
  },
  biometricText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
  passwordBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 14,
    paddingVertical: 14,
    width: "100%",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  passwordBtnText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: "#94A3B8",
  },
  passwordSection: {
    width: "100%",
    gap: 12,
  },
  input: {
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#F8FAFC",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  unlockBtn: {
    backgroundColor: "#6366F1",
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  unlockText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
  backBtn: {
    alignItems: "center",
    paddingVertical: 10,
  },
  backText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: "#64748B",
  },
  logoutLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 32,
    paddingVertical: 10,
  },
  logoutText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#64748B",
  },
});
