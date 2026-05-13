import React from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Platform,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { cleanDoctorDisplay, getStationInfo, type CaseStatus } from "@/lib/data";

type ToothMapEntry = { num: number; type: string };

export type LabSlipCase = {
  caseNumber: string;
  doctorName: string;
  patientName: string;
  caseType?: string;
  material: string;
  toothIndices: string;
  shade: string;
  dueDate?: string;
  status: CaseStatus;
  isRush?: boolean;
  isRemake?: boolean;
  remakeReason?: string;
  toothMap?: ToothMapEntry[];
  notes?: string;
  createdAt: number | string;
  assignedBarcode?: string;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  caseItem: LabSlipCase;
  customStationLabels: Parameters<typeof getStationInfo>[1];
};

export function LabSlipModal({ visible, onClose, caseItem, customStationLabels }: Props) {
  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={labSlipStyles.overlay}>
        <View style={labSlipStyles.container}>
          <View style={labSlipStyles.header}>
            <Text style={labSlipStyles.headerTitle}>Lab Slip</Text>
            <Pressable onPress={onClose}>
              <Ionicons name="close" size={24} color={Colors.light.text} />
            </Pressable>
          </View>

          <ScrollView style={labSlipStyles.body} showsVerticalScrollIndicator={false}>
            <View style={labSlipStyles.slipCard}>
              <View style={labSlipStyles.slipHeader}>
                <Text style={labSlipStyles.slipTitle}>DENTAL LAB WORK ORDER</Text>
                <Text style={labSlipStyles.slipCaseNum}>Case {caseItem.caseNumber}</Text>
              </View>

              <View style={labSlipStyles.divider} />

              <View style={labSlipStyles.slipRow}>
                <View style={labSlipStyles.slipCol}>
                  <Text style={labSlipStyles.slipLabel}>Doctor</Text>
                  <Text style={labSlipStyles.slipValue}>{cleanDoctorDisplay(caseItem.doctorName)}</Text>
                </View>
                <View style={labSlipStyles.slipCol}>
                  <Text style={labSlipStyles.slipLabel}>Patient</Text>
                  <Text style={labSlipStyles.slipValue}>{caseItem.patientName}</Text>
                </View>
              </View>

              <View style={labSlipStyles.slipRow}>
                <View style={labSlipStyles.slipCol}>
                  <Text style={labSlipStyles.slipLabel}>Case Type</Text>
                  <Text style={labSlipStyles.slipValue}>{caseItem.caseType || "N/A"}</Text>
                </View>
                <View style={labSlipStyles.slipCol}>
                  <Text style={labSlipStyles.slipLabel}>Material</Text>
                  <Text style={labSlipStyles.slipValue}>{caseItem.material}</Text>
                </View>
              </View>

              <View style={labSlipStyles.slipRow}>
                <View style={labSlipStyles.slipCol}>
                  <Text style={labSlipStyles.slipLabel}>Tooth / Units</Text>
                  <Text style={labSlipStyles.slipValue}>{caseItem.toothIndices}</Text>
                </View>
                <View style={labSlipStyles.slipCol}>
                  <Text style={labSlipStyles.slipLabel}>Shade</Text>
                  <Text style={labSlipStyles.slipValue}>{caseItem.shade}</Text>
                </View>
              </View>

              <View style={labSlipStyles.slipRow}>
                <View style={labSlipStyles.slipCol}>
                  <Text style={labSlipStyles.slipLabel}>Due Date</Text>
                  <Text style={labSlipStyles.slipValue}>{caseItem.dueDate || "N/A"}</Text>
                </View>
                <View style={labSlipStyles.slipCol}>
                  <Text style={labSlipStyles.slipLabel}>Current Station</Text>
                  <Text style={labSlipStyles.slipValue}>{getStationInfo(caseItem.status, customStationLabels).label}</Text>
                </View>
              </View>

              <View style={labSlipStyles.slipRow}>
                <View style={labSlipStyles.slipCol}>
                  <Text style={labSlipStyles.slipLabel}>Rush</Text>
                  <Text style={[labSlipStyles.slipValue, caseItem.isRush && { color: "#EF4444", fontFamily: "Inter_700Bold" }]}>
                    {caseItem.isRush ? "YES - RUSH" : "No"}
                  </Text>
                </View>
                <View style={labSlipStyles.slipCol}>
                  <Text style={labSlipStyles.slipLabel}>Remake</Text>
                  <Text style={[labSlipStyles.slipValue, caseItem.isRemake && { color: "#F59E0B", fontFamily: "Inter_700Bold" }]}>
                    {caseItem.isRemake ? "YES" : "No"}
                  </Text>
                </View>
              </View>

              {caseItem.isRemake && caseItem.remakeReason && (
                <View style={labSlipStyles.slipFullRow}>
                  <Text style={labSlipStyles.slipLabel}>Remake Reason</Text>
                  <Text style={labSlipStyles.slipValue}>{caseItem.remakeReason}</Text>
                </View>
              )}

              {(caseItem.toothMap || []).length > 0 && (
                <View style={labSlipStyles.slipFullRow}>
                  <Text style={labSlipStyles.slipLabel}>Tooth Details</Text>
                  {caseItem.toothMap!.map((t, i) => (
                    <Text key={i} style={labSlipStyles.slipValue}>
                      #{t.num} - {t.type}
                    </Text>
                  ))}
                </View>
              )}

              {caseItem.notes ? (
                <View style={labSlipStyles.slipFullRow}>
                  <Text style={labSlipStyles.slipLabel}>Notes</Text>
                  <Text style={labSlipStyles.slipValue}>{caseItem.notes}</Text>
                </View>
              ) : null}

              <View style={labSlipStyles.divider} />

              <View style={labSlipStyles.slipFooter}>
                <Text style={labSlipStyles.footerText}>
                  Received: {new Date(caseItem.createdAt).toLocaleDateString()}
                </Text>
                {caseItem.assignedBarcode && (
                  <Text style={labSlipStyles.footerText}>
                    Barcode: {caseItem.assignedBarcode}
                  </Text>
                )}
              </View>
            </View>
          </ScrollView>

          <Pressable
            onPress={() => {
              if (Platform.OS === "web") {
                window.print();
              } else {
                Alert.alert("Print", "The lab slip is displayed above. Use your device's print feature to print this document.");
              }
            }}
            style={({ pressed }) => [
              labSlipStyles.printBtn,
              pressed && { opacity: 0.85 },
            ]}
          >
            <Ionicons name="print" size={20} color="#FFF" />
            <Text style={labSlipStyles.printBtnText}>Print Lab Slip</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const labSlipStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  container: { flex: 1, backgroundColor: "#FFF", marginTop: 60, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 20, borderBottomWidth: 1, borderBottomColor: "#E2E8F0" },
  headerTitle: { fontSize: 18, fontFamily: "Inter_700Bold", color: Colors.light.text },
  body: { flex: 1, padding: 20 },
  slipCard: { backgroundColor: "#FAFAFA", borderRadius: 12, padding: 20, borderWidth: 1, borderColor: "#E2E8F0" },
  slipHeader: { alignItems: "center", marginBottom: 12 },
  slipTitle: { fontSize: 18, fontFamily: "Inter_700Bold", color: Colors.light.text, letterSpacing: 1.5 },
  slipCaseNum: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.tint, marginTop: 4 },
  divider: { height: 1, backgroundColor: "#CBD5E1", marginVertical: 14 },
  slipRow: { flexDirection: "row", marginBottom: 14, gap: 12 },
  slipCol: { flex: 1 },
  slipFullRow: { marginBottom: 14 },
  slipLabel: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#94A3B8", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 },
  slipValue: { fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.light.text },
  slipFooter: { flexDirection: "row", justifyContent: "space-between" },
  footerText: { fontSize: 12, fontFamily: "Inter_400Regular", color: "#94A3B8" },
  printBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#6366F1", paddingVertical: 16, margin: 20, borderRadius: 14 },
  printBtnText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "#FFF" },
});
