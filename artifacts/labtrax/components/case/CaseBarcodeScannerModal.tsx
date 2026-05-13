import React from "react";
import { Modal, View, Text, Pressable, Platform, Alert } from "react-native";
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

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        <View style={{ paddingTop: Platform.OS === "web" ? 67 : insetsTop + 10, paddingHorizontal: 20, paddingBottom: 10, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: "#FFF" }}>Scan Barcode</Text>
          <Pressable onPress={onClose} style={{ padding: 8 }}>
            <Ionicons name="close" size={24} color="#FFF" />
          </Pressable>
        </View>
        <View style={{ flex: 1, overflow: "hidden" }}>
          {cameraPermission?.granted ? (
            <>
              <CameraView
                style={{ flex: 1 }}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["code128", "code39", "ean13", "ean8", "upc_a", "upc_e", "qr", "pdf417", "itf14", "codabar"] }}
                onBarcodeScanned={scanned ? undefined : (result) => {
                  onSetScanned(true);
                  onScan(result.data);
                }}
              />
              <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "center", alignItems: "center" }} pointerEvents="none">
                <View style={{ width: 260, height: 100, borderWidth: 2, borderColor: "rgba(79,142,247,0.6)", borderRadius: 12, borderStyle: "dashed" }} />
                <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 8 }}>
                  Align barcode in the box
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
        <View style={{ paddingHorizontal: 20, paddingBottom: Platform.OS === "web" ? 34 : insetsBottom + 10, paddingTop: 16, alignItems: "center" }}>
          <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center" }}>
            Point camera at a barcode to assign it to case {caseNumber}
          </Text>
        </View>
      </View>
    </Modal>
  );
}
