import React, { useRef, useEffect, useState } from "react";
import { Modal, View, Text, Pressable, Platform, Alert, TextInput, Animated as RNAnimated } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { CameraView } from "expo-camera";

export type CameraPermissionLike = { granted: boolean } | null | undefined;

export type CaseBarcodeScannerModalProps = {
  visible: boolean;
  onClose: () => void;
  insetsTop: number;
  insetsBottom: number;
  caseNumber?: string;
  cameraPermission: CameraPermissionLike;
  requestCameraPermission: () => Promise<{ granted: boolean }>;
  scanned: boolean;
  onSetScanned: (v: boolean) => void;
  onScan: (data: string) => void;
};

export function CaseBarcodeScannerModal(props: CaseBarcodeScannerModalProps) {
  const {
    visible,
    onClose,
    insetsTop,
    insetsBottom,
    caseNumber,
    cameraPermission,
    requestCameraPermission,
    scanned,
    onSetScanned,
    onScan,
  } = props;

  const firedRef = useRef(false);
  const [manualMode, setManualMode] = useState(false);
  const [manualInput, setManualInput] = useState("");
  const [torchOn, setTorchOn] = useState(false);
  const scanLine = useRef(new RNAnimated.Value(0)).current;
  const platformOS = Platform.OS as string;

  useEffect(() => {
    if (!visible) {
      firedRef.current = false;
      setManualMode(false);
      setManualInput("");
      setTorchOn(false);
    }
  }, [visible]);

  // Re-arm whenever the parent flips `scanned` back to false (e.g. after a
  // "barcode already in use" alert) so the next scan/manual submit can fire
  // without forcing the user to close and reopen the modal.
  useEffect(() => {
    if (!scanned) firedRef.current = false;
  }, [scanned]);

  useEffect(() => {
    if (!visible || manualMode || !cameraPermission?.granted) return;
    const loop = RNAnimated.loop(
      RNAnimated.sequence([
        RNAnimated.timing(scanLine, { toValue: 1, duration: 1800, useNativeDriver: true }),
        RNAnimated.timing(scanLine, { toValue: 0, duration: 1800, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [visible, manualMode, cameraPermission?.granted, scanLine]);

  function submitManual() {
    const v = manualInput.trim();
    if (!v) return;
    if (firedRef.current) return;
    firedRef.current = true;
    onSetScanned(true);
    onScan(v);
  }

  const cameraAvailable = platformOS !== "web";

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        <View style={{ paddingTop: platformOS === "web" ? 67 : insetsTop + 10, paddingHorizontal: 20, paddingBottom: 10, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: "#FFF" }}>
            {manualMode || !cameraAvailable ? "Enter Barcode" : "Scan Barcode"}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            {!manualMode && cameraAvailable && cameraPermission?.granted && (
              <Pressable onPress={() => setTorchOn((t) => !t)} hitSlop={8} style={{ padding: 6 }}>
                <Ionicons name={torchOn ? "flashlight" : "flashlight-outline"} size={22} color={torchOn ? "#FACC15" : "#FFF"} />
              </Pressable>
            )}
            <Pressable onPress={onClose} style={{ padding: 8 }}>
              <Ionicons name="close" size={24} color="#FFF" />
            </Pressable>
          </View>
        </View>

        <View style={{ flex: 1, overflow: "hidden" }}>
          {manualMode || !cameraAvailable ? (
            <View style={{ flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 32 }}>
              <Ionicons name="barcode-outline" size={56} color="rgba(255,255,255,0.4)" />
              <Text style={{ color: "#FFF", fontSize: 16, fontFamily: "Inter_600SemiBold", marginTop: 16, textAlign: "center" }}>
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
                style={{ marginTop: 20, backgroundColor: "rgba(255,255,255,0.12)", borderWidth: 1, borderColor: "rgba(255,255,255,0.25)", borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, color: "#FFF", fontSize: 17, fontFamily: "Inter_500Medium", width: "100%", maxWidth: 320, textAlign: "center" }}
              />
              <Pressable
                onPress={submitManual}
                disabled={!manualInput.trim()}
                style={({ pressed }) => ({ marginTop: 16, backgroundColor: manualInput.trim() ? "#4F8EF7" : "rgba(79,142,247,0.4)", paddingHorizontal: 28, paddingVertical: 12, borderRadius: 12, opacity: pressed ? 0.8 : 1 })}
              >
                <Text style={{ color: "#FFF", fontSize: 15, fontFamily: "Inter_600SemiBold" }}>Assign Barcode</Text>
              </Pressable>
            </View>
          ) : cameraPermission?.granted ? (
            <>
              <CameraView
                style={{ flex: 1 }}
                facing="back"
                autofocus="on"
                enableTorch={torchOn}
                barcodeScannerSettings={{ barcodeTypes: ["code128", "code39", "ean13", "ean8", "upc_a", "upc_e", "qr", "pdf417", "itf14", "codabar"] }}
                onBarcodeScanned={scanned ? undefined : (result) => {
                  if (firedRef.current) return;
                  firedRef.current = true;
                  onSetScanned(true);
                  onScan(result.data);
                }}
              />
              <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "center", alignItems: "center" }} pointerEvents="none">
                <View style={{ width: 280, height: 140, borderRadius: 14, overflow: "hidden" }}>
                  <View style={{ position: "absolute", top: 0, left: 0, width: 28, height: 28, borderTopWidth: 3, borderLeftWidth: 3, borderColor: "#4F8EF7", borderTopLeftRadius: 14 }} />
                  <View style={{ position: "absolute", top: 0, right: 0, width: 28, height: 28, borderTopWidth: 3, borderRightWidth: 3, borderColor: "#4F8EF7", borderTopRightRadius: 14 }} />
                  <View style={{ position: "absolute", bottom: 0, left: 0, width: 28, height: 28, borderBottomWidth: 3, borderLeftWidth: 3, borderColor: "#4F8EF7", borderBottomLeftRadius: 14 }} />
                  <View style={{ position: "absolute", bottom: 0, right: 0, width: 28, height: 28, borderBottomWidth: 3, borderRightWidth: 3, borderColor: "#4F8EF7", borderBottomRightRadius: 14 }} />
                  <RNAnimated.View
                    style={{
                      position: "absolute",
                      left: 14, right: 14, height: 2,
                      backgroundColor: "#4F8EF7",
                      shadowColor: "#4F8EF7", shadowOpacity: 0.8, shadowRadius: 6, shadowOffset: { width: 0, height: 0 },
                      transform: [{ translateY: scanLine.interpolate({ inputRange: [0, 1], outputRange: [4, 132] }) }],
                    }}
                  />
                </View>
                <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 10 }}>
                  Align barcode inside the frame
                </Text>
              </View>
            </>
          ) : (
            <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
              <Ionicons name="camera-outline" size={48} color="rgba(255,255,255,0.4)" />
              <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 15, fontFamily: "Inter_500Medium", marginTop: 12, textAlign: "center", paddingHorizontal: 40 }}>Camera permission is required to scan barcodes.</Text>
              <Pressable
                onPress={async () => {
                  const result = await requestCameraPermission();
                  if (!result.granted) {
                    Alert.alert("Permission Denied", "Please enable camera access in your device settings.");
                  }
                }}
                style={({ pressed }) => ({ marginTop: 16, backgroundColor: "#4F8EF7", paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, opacity: pressed ? 0.8 : 1 })}
              >
                <Text style={{ color: "#FFF", fontSize: 15, fontFamily: "Inter_600SemiBold" }}>Grant Camera Access</Text>
              </Pressable>
            </View>
          )}
        </View>

        <View style={{ paddingHorizontal: 20, paddingBottom: platformOS === "web" ? 34 : insetsBottom + 10, paddingTop: 14, alignItems: "center", gap: 12 }}>
          {cameraAvailable && (
            <Pressable
              onPress={() => setManualMode((m) => !m)}
              style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.1)", borderWidth: 1, borderColor: "rgba(255,255,255,0.2)", opacity: pressed ? 0.7 : 1 })}
            >
              <Ionicons name={manualMode ? "scan-outline" : "create-outline"} size={18} color="#FFF" />
              <Text style={{ color: "#FFF", fontSize: 14, fontFamily: "Inter_600SemiBold" }}>
                {manualMode ? "Use camera instead" : "Type barcode manually"}
              </Text>
            </Pressable>
          )}
          <Text style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center" }}>
            Assigning to:
          </Text>
          <Text style={{ color: "#FFF", fontSize: 18, fontFamily: "Inter_700Bold", textAlign: "center", marginTop: -4 }}>
            Case {caseNumber}
          </Text>
        </View>
      </View>
    </Modal>
  );
}
