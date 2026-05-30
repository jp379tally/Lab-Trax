import React, { useEffect, useRef, useState } from "react";
import { Modal, View, Text, Pressable, TextInput, Platform, Alert, Animated as RNAnimated } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { CameraView, type BarcodeScanningResult } from "expo-camera";
import { useTheme } from "@/lib/theme-context";

const SCAN_TARGET_WIDTH = 280;
const SCAN_TARGET_HEIGHT = 180;

type Bounds = BarcodeScanningResult["bounds"];
type CornerPoints = BarcodeScanningResult["cornerPoints"];

export type AttachBarcodeModalProps = {
  visible: boolean;
  onSkipAndProceed: () => void;
  insetsTop: number;
  insetsBottom: number;
  permission: { granted: boolean } | null | undefined;
  requestPermission: () => Promise<{ granted: boolean }>;
  alreadyScanned: boolean;
  cameraLayout: { width: number; height: number };
  onCameraLayout: (layout: { width: number; height: number }) => void;
  isInTargetArea: (b: Bounds | undefined, c: CornerPoints | undefined, w: number, h: number) => boolean;
  onScanned: (e: { data: string; bounds?: Bounds; cornerPoints?: CornerPoints }) => void;
};

export function AttachBarcodeModal(props: AttachBarcodeModalProps) {
  const {
    visible,
    onSkipAndProceed,
    insetsTop,
    insetsBottom,
    permission,
    requestPermission,
    alreadyScanned,
    cameraLayout,
    onCameraLayout,
    isInTargetArea,
    onScanned,
  } = props;

  const { colors } = useTheme();

  const platformOS = Platform.OS as string;
  const cameraAvailable = platformOS !== "web";

  const [manualMode, setManualMode] = useState(false);
  const [manualInput, setManualInput] = useState("");
  const [torchOn, setTorchOn] = useState(false);
  const scanLine = useRef(new RNAnimated.Value(0)).current;
  const submittedRef = useRef(false);

  useEffect(() => {
    if (!visible) {
      setManualMode(false);
      setManualInput("");
      setTorchOn(false);
      submittedRef.current = false;
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || manualMode || !cameraAvailable || !permission?.granted) return;
    const loop = RNAnimated.loop(
      RNAnimated.sequence([
        RNAnimated.timing(scanLine, { toValue: 1, duration: 1800, useNativeDriver: true }),
        RNAnimated.timing(scanLine, { toValue: 0, duration: 1800, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [visible, manualMode, permission?.granted, cameraAvailable, scanLine]);

  function submitManual() {
    const v = manualInput.trim();
    if (!v || submittedRef.current) return;
    submittedRef.current = true;
    onScanned({ data: v });
  }

  function renderManual() {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 32 }}>
        <Ionicons name="barcode-outline" size={56} color="rgba(255,255,255,0.4)" />
        <Text style={{ color: colors.textInverse, fontSize: 16, fontFamily: "Inter_600SemiBold", marginTop: 16, textAlign: "center" }}>
          Type the barcode number
        </Text>
        <Text style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, fontFamily: "Inter_400Regular", marginTop: 6, textAlign: "center" }}>
          Enter the digits printed under the barcode.
        </Text>
        <TextInput
          value={manualInput}
          onChangeText={setManualInput}
          placeholder="e.g. 123456789"
          placeholderTextColor="rgba(255,255,255,0.35)"
          autoCapitalize="characters"
          autoCorrect={false}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={submitManual}
          style={{ marginTop: 20, backgroundColor: "rgba(255,255,255,0.12)", borderWidth: 1, borderColor: "rgba(255,255,255,0.25)", borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, color: colors.textInverse, fontSize: 17, fontFamily: "Inter_500Medium", width: "100%", maxWidth: 320, textAlign: "center" }}
        />
        <Pressable
          onPress={submitManual}
          disabled={!manualInput.trim()}
          style={({ pressed }) => ({ marginTop: 16, backgroundColor: manualInput.trim() ? colors.success : "rgba(34,197,94,0.4)", paddingHorizontal: 28, paddingVertical: 12, borderRadius: 12, opacity: pressed ? 0.8 : 1 })}
        >
          <Text style={{ color: colors.textInverse, fontSize: 15, fontFamily: "Inter_600SemiBold" }}>Attach Barcode</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onSkipAndProceed}
    >
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        <View style={{ paddingTop: platformOS === "web" ? 67 : insetsTop, paddingHorizontal: 20, paddingBottom: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "rgba(0,0,0,0.8)" }}>
          <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: colors.textInverse }}>
            {manualMode || !cameraAvailable ? "Enter Barcode" : "Attach Barcode"}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            {!manualMode && cameraAvailable && permission?.granted && (
              <Pressable onPress={() => setTorchOn((t) => !t)} hitSlop={8} style={{ padding: 6 }}>
                <Ionicons name={torchOn ? "flashlight" : "flashlight-outline"} size={22} color={torchOn ? colors.warning : colors.textInverse} />
              </Pressable>
            )}
            <Pressable onPress={onSkipAndProceed}>
              <Ionicons name="close" size={28} color={colors.textInverse} />
            </Pressable>
          </View>
        </View>

        {!cameraAvailable || manualMode ? (
          <>
            {renderManual()}
            <View style={{ paddingHorizontal: 20, paddingBottom: platformOS === "web" ? 34 : insetsBottom + 10, paddingTop: 12, gap: 10, backgroundColor: "rgba(0,0,0,0.85)" }}>
              {cameraAvailable && (
                <Pressable
                  onPress={() => setManualMode(false)}
                  style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 12, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.08)", borderWidth: 1, borderColor: "rgba(255,255,255,0.2)", opacity: pressed ? 0.7 : 1 })}
                >
                  <Ionicons name="scan-outline" size={18} color={colors.textInverse} />
                  <Text style={{ color: colors.textInverse, fontSize: 14, fontFamily: "Inter_600SemiBold" }}>Use camera instead</Text>
                </Pressable>
              )}
              <Pressable
                onPress={onSkipAndProceed}
                style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.12)", borderWidth: 1, borderColor: "rgba(255,255,255,0.2)", opacity: pressed ? 0.7 : 1 })}
              >
                <Ionicons name="arrow-forward" size={20} color={colors.textInverse} />
                <Text style={{ color: colors.textInverse, fontSize: 15, fontFamily: "Inter_600SemiBold" }}>Skip — No Barcode</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <View style={{ flex: 1 }}>
            {permission?.granted ? (
              <CameraView
                style={{ flex: 1 }}
                facing="back"
                autofocus="on"
                enableTorch={torchOn}
                barcodeScannerSettings={{ barcodeTypes: ["qr", "code128", "code39", "ean13", "ean8", "upc_a", "upc_e", "codabar", "itf14", "pdf417"] }}
                onBarcodeScanned={alreadyScanned ? undefined : (e) => {
                  if (!isInTargetArea(e.bounds, e.cornerPoints, cameraLayout.width, cameraLayout.height)) return;
                  onScanned(e);
                }}
                onLayout={(e) => {
                  const { width, height } = e.nativeEvent.layout;
                  onCameraLayout({ width, height });
                }}
              >
                <View style={{ flex: 1 }} pointerEvents="none">
                  <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)" }} />
                  <View style={{ flexDirection: "row", height: SCAN_TARGET_HEIGHT }}>
                    <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)" }} />
                    <View style={{ width: SCAN_TARGET_WIDTH, height: SCAN_TARGET_HEIGHT, borderRadius: 16, overflow: "hidden" }}>
                      <View style={{ position: "absolute", top: 0, left: 0, width: 30, height: 30, borderTopWidth: 3, borderLeftWidth: 3, borderColor: colors.success, borderTopLeftRadius: 16 }} />
                      <View style={{ position: "absolute", top: 0, right: 0, width: 30, height: 30, borderTopWidth: 3, borderRightWidth: 3, borderColor: colors.success, borderTopRightRadius: 16 }} />
                      <View style={{ position: "absolute", bottom: 0, left: 0, width: 30, height: 30, borderBottomWidth: 3, borderLeftWidth: 3, borderColor: colors.success, borderBottomLeftRadius: 16 }} />
                      <View style={{ position: "absolute", bottom: 0, right: 0, width: 30, height: 30, borderBottomWidth: 3, borderRightWidth: 3, borderColor: colors.success, borderBottomRightRadius: 16 }} />
                      <RNAnimated.View
                        style={{
                          position: "absolute",
                          left: 16, right: 16, height: 2,
                          backgroundColor: colors.success,
                          shadowColor: colors.success, shadowOpacity: 0.8, shadowRadius: 6, shadowOffset: { width: 0, height: 0 },
                          transform: [{ translateY: scanLine.interpolate({ inputRange: [0, 1], outputRange: [4, SCAN_TARGET_HEIGHT - 6] }) }],
                        }}
                      />
                    </View>
                    <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)" }} />
                  </View>
                  <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", paddingTop: 20 }}>
                    <Text style={{ color: colors.textInverse, fontSize: 15, fontFamily: "Inter_600SemiBold" }}>Position barcode inside the frame</Text>
                    <Text style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, fontFamily: "Inter_400Regular", marginTop: 4 }}>Hold steady — torch button helps in low light</Text>
                  </View>
                </View>
              </CameraView>
            ) : (
              <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
                <Ionicons name="camera-outline" size={48} color="rgba(255,255,255,0.4)" />
                <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 15, fontFamily: "Inter_500Medium", marginTop: 12, textAlign: "center", paddingHorizontal: 40 }}>Camera permission is required to scan barcodes.</Text>
                <Pressable onPress={async () => { const r = await requestPermission(); if (!r.granted) Alert.alert("Permission Denied", "Please enable camera access in your device settings."); }} style={({ pressed }) => ({ marginTop: 16, backgroundColor: colors.info, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, opacity: pressed ? 0.8 : 1 })}>
                  <Text style={{ color: colors.textInverse, fontSize: 15, fontFamily: "Inter_600SemiBold" }}>Grant Camera Access</Text>
                </Pressable>
                <Pressable onPress={() => setManualMode(true)} style={({ pressed }) => ({ marginTop: 12, paddingHorizontal: 18, paddingVertical: 10, opacity: pressed ? 0.7 : 1 })}>
                  <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 14, fontFamily: "Inter_500Medium", textDecorationLine: "underline" }}>Type barcode manually</Text>
                </Pressable>
              </View>
            )}
            <View style={{ paddingHorizontal: 20, paddingBottom: platformOS === "web" ? 34 : insetsBottom + 10, paddingTop: 12, gap: 10, backgroundColor: "rgba(0,0,0,0.85)" }}>
              <Pressable
                onPress={() => setManualMode(true)}
                style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 12, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.08)", borderWidth: 1, borderColor: "rgba(255,255,255,0.2)", opacity: pressed ? 0.7 : 1 })}
              >
                <Ionicons name="create-outline" size={18} color={colors.textInverse} />
                <Text style={{ color: colors.textInverse, fontSize: 14, fontFamily: "Inter_600SemiBold" }}>Type barcode manually</Text>
              </Pressable>
              <Pressable
                onPress={onSkipAndProceed}
                style={({ pressed }) => ({
                  flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
                  paddingVertical: 14, borderRadius: 14,
                  backgroundColor: "rgba(255,255,255,0.12)", borderWidth: 1, borderColor: "rgba(255,255,255,0.2)",
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Ionicons name="arrow-forward" size={20} color={colors.textInverse} />
                <Text style={{ color: colors.textInverse, fontSize: 15, fontFamily: "Inter_600SemiBold" }}>Skip — No Barcode</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}
