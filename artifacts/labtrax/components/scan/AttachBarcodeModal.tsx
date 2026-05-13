import React from "react";
import { Modal, View, Text, Pressable, TextInput, Platform, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { CameraView, type BarcodeScanningResult } from "expo-camera";

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

  const platformOS = Platform.OS as string;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onSkipAndProceed}
    >
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        <View style={{ paddingTop: platformOS === "web" ? 67 : insetsTop, paddingHorizontal: 20, paddingBottom: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "rgba(0,0,0,0.8)" }}>
          <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: "#FFF" }}>Attach Barcode</Text>
          <Pressable onPress={onSkipAndProceed}>
            <Ionicons name="close" size={28} color="#FFF" />
          </Pressable>
        </View>
        {platformOS === "web" ? (
          <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 40 }}>
            <Ionicons name="barcode-outline" size={60} color="#FFF" />
            <Text style={{ color: "#FFF", fontSize: 16, fontFamily: "Inter_500Medium", textAlign: "center", marginTop: 16 }}>Barcode scanning requires a device camera.</Text>
            <Text style={{ color: "#999", marginTop: 8, fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center" }}>Enter a barcode manually:</Text>
            <TextInput
              style={{ backgroundColor: "rgba(255,255,255,0.15)", borderRadius: 10, paddingHorizontal: 16, paddingVertical: 12, color: "#FFF", fontSize: 16, fontFamily: "Inter_500Medium", width: 260, marginTop: 12, textAlign: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.3)" }}
              placeholder="Enter barcode..."
              placeholderTextColor="rgba(255,255,255,0.4)"
              autoCapitalize="none"
              onSubmitEditing={(e) => {
                const val = e.nativeEvent.text.trim();
                if (val) onScanned({ data: val });
              }}
            />
            <Pressable onPress={onSkipAndProceed} style={{ marginTop: 20, backgroundColor: "rgba(255,255,255,0.15)", paddingHorizontal: 28, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.3)" }}>
              <Text style={{ color: "#FFF", fontSize: 15, fontFamily: "Inter_600SemiBold" }}>Skip</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            {permission?.granted ? (
              <CameraView
                style={{ flex: 1 }}
                facing="back"
                autofocus="on"
                barcodeScannerSettings={{ barcodeTypes: ["qr", "code128", "code39", "ean13", "ean8", "upc_a", "upc_e", "codabar", "itf14"] }}
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
                      <View style={{ position: "absolute", top: 0, left: 0, width: 30, height: 30, borderTopWidth: 3, borderLeftWidth: 3, borderColor: "#22C55E", borderTopLeftRadius: 16 }} />
                      <View style={{ position: "absolute", top: 0, right: 0, width: 30, height: 30, borderTopWidth: 3, borderRightWidth: 3, borderColor: "#22C55E", borderTopRightRadius: 16 }} />
                      <View style={{ position: "absolute", bottom: 0, left: 0, width: 30, height: 30, borderBottomWidth: 3, borderLeftWidth: 3, borderColor: "#22C55E", borderBottomLeftRadius: 16 }} />
                      <View style={{ position: "absolute", bottom: 0, right: 0, width: 30, height: 30, borderBottomWidth: 3, borderRightWidth: 3, borderColor: "#22C55E", borderBottomRightRadius: 16 }} />
                      <View style={{ position: "absolute", top: "50%", left: 16, right: 16, height: 2, backgroundColor: "rgba(34,197,94,0.4)", marginTop: -1 }} />
                    </View>
                    <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)" }} />
                  </View>
                  <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", paddingTop: 20 }}>
                    <Text style={{ color: "#FFF", fontSize: 15, fontFamily: "Inter_600SemiBold" }}>Position barcode inside the frame</Text>
                    <Text style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, fontFamily: "Inter_400Regular", marginTop: 4 }}>Hold steady and aim the barcode at the frame</Text>
                  </View>
                </View>
              </CameraView>
            ) : (
              <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
                <Ionicons name="camera-outline" size={48} color="rgba(255,255,255,0.4)" />
                <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 15, fontFamily: "Inter_500Medium", marginTop: 12, textAlign: "center", paddingHorizontal: 40 }}>Camera permission is required to scan barcodes.</Text>
                <Pressable onPress={async () => { const r = await requestPermission(); if (!r.granted) Alert.alert("Permission Denied", "Please enable camera access in your device settings."); }} style={({ pressed }) => ({ marginTop: 16, backgroundColor: "#4F8EF7", paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, opacity: pressed ? 0.8 : 1 })}>
                  <Text style={{ color: "#FFF", fontSize: 15, fontFamily: "Inter_600SemiBold" }}>Grant Camera Access</Text>
                </Pressable>
              </View>
            )}
            <View style={{ paddingHorizontal: 20, paddingBottom: platformOS === "web" ? 34 : insetsBottom + 10, paddingTop: 12, backgroundColor: "rgba(0,0,0,0.85)" }}>
              <Pressable
                onPress={onSkipAndProceed}
                style={({ pressed }) => ({
                  flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
                  paddingVertical: 14, borderRadius: 14,
                  backgroundColor: "rgba(255,255,255,0.12)", borderWidth: 1, borderColor: "rgba(255,255,255,0.2)",
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Ionicons name="arrow-forward" size={20} color="#FFF" />
                <Text style={{ color: "#FFF", fontSize: 15, fontFamily: "Inter_600SemiBold" }}>Skip — No Barcode</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}
