import React, { useState, useEffect, useRef } from "react";
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  Platform,
  TextInput,
  ScrollView,
  Alert,
  Animated as RNAnimated,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import { useApp } from "@/lib/app-context";
import Colors from "@/constants/colors";

type ScanPhase = "ready" | "scanning" | "detected" | "form";

export default function ScanScreen() {
  const insets = useSafeAreaInsets();
  const { addCase, cases } = useApp();
  const [phase, setPhase] = useState<ScanPhase>("ready");
  const scanAnim = useRef(new RNAnimated.Value(0)).current;

  const [doctorName, setDoctorName] = useState("");
  const [patientInitials, setPatientInitials] = useState("");
  const [toothIndices, setToothIndices] = useState("");
  const [shade, setShade] = useState("");
  const [material, setMaterial] = useState("Zirconia");
  const [isRush, setIsRush] = useState(false);
  const [notes, setNotes] = useState("");
  const [dueDate, setDueDate] = useState("2026-02-20");

  useEffect(() => {
    if (phase === "scanning") {
      RNAnimated.loop(
        RNAnimated.sequence([
          RNAnimated.timing(scanAnim, {
            toValue: 1,
            duration: 1500,
            useNativeDriver: true,
          }),
          RNAnimated.timing(scanAnim, {
            toValue: 0,
            duration: 1500,
            useNativeDriver: true,
          }),
        ]),
      ).start();

      const timer = setTimeout(() => {
        setPhase("detected");
        if (Platform.OS !== "web") {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [phase]);

  function handleScan() {
    setPhase("scanning");
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
  }

  function handleDetected() {
    setDoctorName("Dr. Williams");
    setPatientInitials("S.M.");
    setToothIndices("#14, #15");
    setShade("A2");
    setIsRush(false);
    setPhase("form");
  }

  function handleSubmit() {
    if (!doctorName.trim()) {
      Alert.alert("Required", "Doctor name is required");
      return;
    }
    const nextNum = cases.length > 0
      ? parseInt(cases[0].caseNumber.replace("#", "")) + 1
      : 4530;

    addCase({
      caseNumber: `#${nextNum}`,
      doctorName: doctorName.trim(),
      patientInitials: patientInitials.trim(),
      toothIndices: toothIndices.trim(),
      shade: shade.trim(),
      material,
      status: "INTAKE",
      isRush,
      notes: notes.trim(),
      price: Math.round(500 + Math.random() * 3000),
      dueDate,
    });

    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }

    resetForm();
    Alert.alert("Case Added", `Case #${nextNum} has been created and is now in Intake.`);
  }

  function resetForm() {
    setPhase("ready");
    setDoctorName("");
    setPatientInitials("");
    setToothIndices("");
    setShade("");
    setMaterial("Zirconia");
    setIsRush(false);
    setNotes("");
    setDueDate("2026-02-20");
    scanAnim.setValue(0);
  }

  const scanTranslateY = scanAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 280],
  });

  if (phase === "form") {
    return (
      <View style={styles.container}>
        <View
          style={[
            styles.formHeader,
            { paddingTop: Platform.OS === "web" ? 67 + 12 : insets.top + 12 },
          ]}
        >
          <Pressable onPress={resetForm} style={styles.backBtn}>
            <Ionicons name="close" size={24} color={Colors.light.text} />
          </Pressable>
          <Text style={styles.formTitle}>New Case</Text>
          <Pressable
            onPress={handleSubmit}
            style={({ pressed }) => [
              styles.submitBtn,
              pressed && { opacity: 0.8 },
            ]}
          >
            <Ionicons name="checkmark" size={22} color="#FFF" />
          </Pressable>
        </View>
        <ScrollView
          style={styles.formScroll}
          contentContainerStyle={{
            paddingBottom: Platform.OS === "web" ? 84 + 40 : 120,
          }}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.detectedBanner}>
            <Ionicons
              name="checkmark-circle"
              size={20}
              color={Colors.light.success}
            />
            <Text style={styles.detectedText}>Rx Document Detected</Text>
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.formLabel}>Doctor Name</Text>
            <TextInput
              style={styles.formInput}
              value={doctorName}
              onChangeText={setDoctorName}
              placeholder="Dr. Smith"
              placeholderTextColor={Colors.light.textTertiary}
            />
          </View>

          <View style={styles.formRow}>
            <View style={[styles.formGroup, { flex: 1 }]}>
              <Text style={styles.formLabel}>Patient Initials</Text>
              <TextInput
                style={styles.formInput}
                value={patientInitials}
                onChangeText={setPatientInitials}
                placeholder="J.S."
                placeholderTextColor={Colors.light.textTertiary}
              />
            </View>
            <View style={[styles.formGroup, { flex: 1 }]}>
              <Text style={styles.formLabel}>Due Date</Text>
              <TextInput
                style={styles.formInput}
                value={dueDate}
                onChangeText={setDueDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={Colors.light.textTertiary}
              />
            </View>
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.formLabel}>Tooth Indices</Text>
            <TextInput
              style={styles.formInput}
              value={toothIndices}
              onChangeText={setToothIndices}
              placeholder="#8, #9, #10"
              placeholderTextColor={Colors.light.textTertiary}
            />
          </View>

          <View style={styles.formRow}>
            <View style={[styles.formGroup, { flex: 1 }]}>
              <Text style={styles.formLabel}>Shade</Text>
              <TextInput
                style={styles.formInput}
                value={shade}
                onChangeText={setShade}
                placeholder="A2"
                placeholderTextColor={Colors.light.textTertiary}
              />
            </View>
            <View style={[styles.formGroup, { flex: 1 }]}>
              <Text style={styles.formLabel}>Material</Text>
              <View style={styles.materialSelector}>
                {["Zirconia", "E.max", "PFM", "Gold"].map((m) => (
                  <Pressable
                    key={m}
                    onPress={() => setMaterial(m)}
                    style={[
                      styles.materialChip,
                      material === m && styles.materialChipActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.materialText,
                        material === m && styles.materialTextActive,
                      ]}
                    >
                      {m}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </View>

          <Pressable
            onPress={() => setIsRush(!isRush)}
            style={[styles.rushToggle, isRush && styles.rushToggleActive]}
          >
            <Ionicons
              name="flash"
              size={18}
              color={isRush ? "#EF4444" : Colors.light.textTertiary}
            />
            <Text
              style={[styles.rushToggleText, isRush && { color: "#EF4444" }]}
            >
              Rush Order
            </Text>
            <View style={styles.rushToggleSwitch}>
              <View
                style={[
                  styles.rushToggleDot,
                  isRush && styles.rushToggleDotActive,
                ]}
              />
            </View>
          </Pressable>

          <View style={styles.formGroup}>
            <Text style={styles.formLabel}>Notes</Text>
            <TextInput
              style={[styles.formInput, styles.formTextArea]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Additional instructions..."
              placeholderTextColor={Colors.light.textTertiary}
              multiline
              numberOfLines={3}
            />
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View
        style={[
          styles.scanHeader,
          { paddingTop: Platform.OS === "web" ? 67 + 12 : insets.top + 12 },
        ]}
      >
        <Text style={styles.scanTitle}>AI Intake</Text>
      </View>

      <View style={styles.scanArea}>
        <View style={styles.viewfinder}>
          {phase === "scanning" && (
            <RNAnimated.View
              style={[
                styles.scanLine,
                { transform: [{ translateY: scanTranslateY }] },
              ]}
            />
          )}
          <View style={styles.viewfinderContent}>
            {phase === "ready" && (
              <>
                <MaterialCommunityIcons
                  name="file-document-outline"
                  size={56}
                  color={Colors.light.textTertiary}
                />
                <Text style={styles.viewfinderText}>
                  Align Prescription Document
                </Text>
              </>
            )}
            {phase === "scanning" && (
              <>
                <MaterialCommunityIcons
                  name="file-document-outline"
                  size={56}
                  color={Colors.light.tint}
                />
                <View style={styles.detectingBadge}>
                  <Text style={styles.detectingText}>DETECTING RX...</Text>
                </View>
              </>
            )}
            {phase === "detected" && (
              <>
                <Ionicons
                  name="checkmark-circle"
                  size={56}
                  color={Colors.light.success}
                />
                <Text style={styles.detectedViewText}>
                  Prescription Detected
                </Text>
                <Text style={styles.detectedSubText}>
                  Dr. Williams - Tooth #14, #15 - Shade A2
                </Text>
              </>
            )}
          </View>
          <View style={styles.cornerTL} />
          <View style={styles.cornerTR} />
          <View style={styles.cornerBL} />
          <View style={styles.cornerBR} />
        </View>
      </View>

      <View
        style={[
          styles.scanControls,
          { paddingBottom: Platform.OS === "web" ? 84 + 20 : insets.bottom + 80 },
        ]}
      >
        {phase === "ready" && (
          <Pressable
            onPress={handleScan}
            style={({ pressed }) => [
              styles.captureBtn,
              pressed && { transform: [{ scale: 0.95 }] },
            ]}
          >
            <View style={styles.captureBtnInner} />
          </Pressable>
        )}
        {phase === "scanning" && (
          <View style={styles.scanningIndicator}>
            <Text style={styles.scanningText}>Analyzing document...</Text>
          </View>
        )}
        {phase === "detected" && (
          <View style={styles.detectedActions}>
            <Pressable
              onPress={resetForm}
              style={({ pressed }) => [
                styles.actionBtn,
                styles.actionBtnSecondary,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Ionicons name="refresh" size={22} color={Colors.light.text} />
            </Pressable>
            <Pressable
              onPress={handleDetected}
              style={({ pressed }) => [
                styles.actionBtn,
                styles.actionBtnPrimary,
                pressed && { opacity: 0.85, transform: [{ scale: 0.97 }] },
              ]}
            >
              <Ionicons name="checkmark" size={24} color="#FFF" />
              <Text style={styles.actionBtnText}>Confirm & Edit</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light.dark,
  },
  scanHeader: {
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  scanTitle: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  scanArea: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 30,
  },
  viewfinder: {
    width: "100%",
    aspectRatio: 3 / 4,
    maxHeight: 360,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    overflow: "hidden",
    position: "relative",
    justifyContent: "center",
    alignItems: "center",
  },
  viewfinderContent: {
    alignItems: "center",
    gap: 16,
  },
  viewfinderText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "rgba(255,255,255,0.4)",
  },
  scanLine: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: Colors.light.tint,
    shadowColor: Colors.light.tint,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 10,
    zIndex: 10,
  },
  detectingBadge: {
    backgroundColor: Colors.light.tint,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  detectingText: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
    letterSpacing: 1,
  },
  detectedViewText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: Colors.light.success,
  },
  detectedSubText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.5)",
    textAlign: "center",
  },
  cornerTL: {
    position: "absolute",
    top: 10,
    left: 10,
    width: 24,
    height: 24,
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderColor: "rgba(255,255,255,0.3)",
    borderTopLeftRadius: 6,
  },
  cornerTR: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 24,
    height: 24,
    borderTopWidth: 3,
    borderRightWidth: 3,
    borderColor: "rgba(255,255,255,0.3)",
    borderTopRightRadius: 6,
  },
  cornerBL: {
    position: "absolute",
    bottom: 10,
    left: 10,
    width: 24,
    height: 24,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderColor: "rgba(255,255,255,0.3)",
    borderBottomLeftRadius: 6,
  },
  cornerBR: {
    position: "absolute",
    bottom: 10,
    right: 10,
    width: 24,
    height: 24,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderColor: "rgba(255,255,255,0.3)",
    borderBottomRightRadius: 6,
  },
  scanControls: {
    alignItems: "center",
    paddingVertical: 24,
  },
  captureBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: "rgba(255,255,255,0.3)",
    justifyContent: "center",
    alignItems: "center",
  },
  captureBtnInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#FFF",
  },
  scanningIndicator: {
    paddingVertical: 16,
  },
  scanningText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: "rgba(255,255,255,0.5)",
  },
  detectedActions: {
    flexDirection: "row",
    gap: 16,
    alignItems: "center",
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 16,
    gap: 8,
  },
  actionBtnSecondary: {
    backgroundColor: "rgba(255,255,255,0.1)",
    paddingHorizontal: 16,
  },
  actionBtnPrimary: {
    backgroundColor: Colors.light.tint,
  },
  actionBtnText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  formHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 16,
    backgroundColor: Colors.light.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.border,
  },
  backBtn: {
    width: 44,
    height: 44,
    justifyContent: "center",
    alignItems: "center",
  },
  formTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  submitBtn: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: Colors.light.tint,
    justifyContent: "center",
    alignItems: "center",
  },
  formScroll: {
    flex: 1,
    backgroundColor: Colors.light.background,
    padding: 20,
  },
  detectedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: Colors.light.successLight,
    padding: 14,
    borderRadius: 14,
    marginBottom: 20,
  },
  detectedText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.success,
  },
  formGroup: {
    marginBottom: 18,
  },
  formRow: {
    flexDirection: "row",
    gap: 12,
  },
  formLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  formInput: {
    backgroundColor: Colors.light.surface,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 14,
    padding: 14,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
  },
  formTextArea: {
    height: 80,
    textAlignVertical: "top",
  },
  materialSelector: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  materialChip: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Colors.light.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  materialChipActive: {
    backgroundColor: Colors.light.tintLight,
    borderColor: Colors.light.tint,
  },
  materialText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
  },
  materialTextActive: {
    color: Colors.light.tint,
  },
  rushToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: Colors.light.surface,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 14,
    padding: 16,
    marginBottom: 18,
  },
  rushToggleActive: {
    borderColor: Colors.light.error,
    backgroundColor: Colors.light.errorLight,
  },
  rushToggleText: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  rushToggleSwitch: {
    width: 44,
    height: 26,
    borderRadius: 13,
    backgroundColor: Colors.light.surfaceSecondary,
    justifyContent: "center",
    paddingHorizontal: 3,
  },
  rushToggleDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: Colors.light.textTertiary,
  },
  rushToggleDotActive: {
    backgroundColor: Colors.light.error,
    alignSelf: "flex-end",
  },
});
