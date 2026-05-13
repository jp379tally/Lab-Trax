import React from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  Platform,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";

export interface LabelData {
  caseNumber: string;
  doctorName: string;
  patientName: string;
  caseType: string;
  toothIndices: string;
  shade: string;
  material: string;
  isRush: boolean;
  dueDate: string;
  notes: string;
  price: number;
  createdAt: string;
  toothDiagram?: number[];
}

export type LabelPrintModalProps = {
  visible: boolean;
  labelData: LabelData | null;
  selectedPrinter: { name: string; url: string } | null;
  onSelectPrinter: () => void;
  onClearPrinter: () => void;
  onPrint: (label: LabelData) => void;
  onDone: () => void;
};

export function LabelPrintModal(props: LabelPrintModalProps) {
  const {
    visible,
    labelData,
    selectedPrinter,
    onSelectPrinter,
    onClearPrinter,
    onPrint,
    onDone,
  } = props;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onDone}
    >
      <View style={labelStyles.overlay}>
        <View style={labelStyles.container}>
          <View style={labelStyles.header}>
            <Text style={labelStyles.headerTitle}>Case Label</Text>
            <Pressable onPress={onDone} hitSlop={12}>
              <Ionicons name="close" size={22} color={Colors.light.textSecondary} />
            </Pressable>
          </View>

          {labelData && (
            <ScrollView style={labelStyles.scroll} showsVerticalScrollIndicator={false}>
              <View style={labelStyles.labelCard}>
                <View style={labelStyles.labelTopBar}>
                  <Text style={labelStyles.labName}>DRIVESYNC LAB</Text>
                  {labelData.isRush && (
                    <View style={labelStyles.rushTag}>
                      <Text style={labelStyles.rushTagText}>RUSH</Text>
                    </View>
                  )}
                </View>
                <View style={labelStyles.divider} />
                <View style={labelStyles.labelRow}>
                  <Text style={labelStyles.labelKey}>Case #</Text>
                  <Text style={labelStyles.labelValue}>{labelData.caseNumber}</Text>
                </View>
                <View style={labelStyles.labelRow}>
                  <Text style={labelStyles.labelKey}>Patient</Text>
                  <Text style={labelStyles.labelValue}>{labelData.patientName}</Text>
                </View>
                <View style={labelStyles.labelRow}>
                  <Text style={labelStyles.labelKey}>Doctor</Text>
                  <Text style={labelStyles.labelValue}>{labelData.doctorName}</Text>
                </View>
                {labelData.caseType ? (
                  <View style={labelStyles.labelRow}>
                    <Text style={labelStyles.labelKey}>Case Type</Text>
                    <Text style={labelStyles.labelValue}>{labelData.caseType}</Text>
                  </View>
                ) : null}
                {labelData.toothIndices ? (
                  <View style={labelStyles.labelRow}>
                    <Text style={labelStyles.labelKey}>Tooth #</Text>
                    <Text style={labelStyles.labelValue}>{labelData.toothIndices}</Text>
                  </View>
                ) : null}
                {labelData.shade ? (
                  <View style={labelStyles.labelRow}>
                    <Text style={labelStyles.labelKey}>Shade</Text>
                    <Text style={labelStyles.labelValue}>{labelData.shade}</Text>
                  </View>
                ) : null}
                <View style={labelStyles.labelRow}>
                  <Text style={labelStyles.labelKey}>Material</Text>
                  <Text style={labelStyles.labelValue}>{labelData.material}</Text>
                </View>
                {labelData.dueDate ? (
                  <View style={labelStyles.labelRow}>
                    <Text style={labelStyles.labelKey}>Due Date</Text>
                    <Text style={labelStyles.labelValue}>{labelData.dueDate}</Text>
                  </View>
                ) : null}
                <View style={labelStyles.labelRow}>
                  <Text style={labelStyles.labelKey}>Created</Text>
                  <Text style={labelStyles.labelValue}>{labelData.createdAt}</Text>
                </View>
                {labelData.notes ? (
                  <>
                    <View style={labelStyles.divider} />
                    <View style={labelStyles.notesSection}>
                      <Text style={labelStyles.labelKey}>Notes</Text>
                      <Text style={labelStyles.notesText}>{labelData.notes}</Text>
                    </View>
                  </>
                ) : null}
                {labelData.toothDiagram && labelData.toothDiagram.length > 0 ? (
                  <>
                    <View style={labelStyles.divider} />
                    <Text style={{ fontSize: 10, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, textTransform: "uppercase", marginBottom: 6, letterSpacing: 0.5 }}>Tooth Diagram</Text>
                    <View style={{ alignItems: "center" }}>
                      <View style={{ flexDirection: "row", marginBottom: 2 }}>
                        {[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16].map(t => {
                          const active = labelData.toothDiagram!.includes(t);
                          return (
                            <View key={t} style={{ width: 18, height: 18, borderRadius: 3, borderWidth: 1, borderColor: active ? "#22C55E" : "#E0E0E0", backgroundColor: active ? "#22C55E" : "transparent", justifyContent: "center", alignItems: "center", marginHorizontal: 0.5 }}>
                              <Text style={{ fontSize: 7, fontFamily: active ? "Inter_700Bold" : "Inter_400Regular", color: active ? "#FFF" : "#BBB" }}>{t}</Text>
                            </View>
                          );
                        })}
                      </View>
                      <View style={{ width: "90%", height: 1, backgroundColor: "#DDD", marginVertical: 2 }} />
                      <View style={{ flexDirection: "row" }}>
                        {[32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17].map(t => {
                          const active = labelData.toothDiagram!.includes(t);
                          return (
                            <View key={t} style={{ width: 18, height: 18, borderRadius: 3, borderWidth: 1, borderColor: active ? "#22C55E" : "#E0E0E0", backgroundColor: active ? "#22C55E" : "transparent", justifyContent: "center", alignItems: "center", marginHorizontal: 0.5 }}>
                              <Text style={{ fontSize: 7, fontFamily: active ? "Inter_700Bold" : "Inter_400Regular", color: active ? "#FFF" : "#BBB" }}>{t}</Text>
                            </View>
                          );
                        })}
                      </View>
                    </View>
                  </>
                ) : null}
              </View>
            </ScrollView>
          )}
          {Platform.OS === "ios" && (
            <Pressable
              style={({ pressed }) => ({
                flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
                paddingVertical: 10, paddingHorizontal: 16, marginHorizontal: 20, marginBottom: 8,
                borderRadius: 12, borderWidth: 1,
                borderColor: selectedPrinter ? "rgba(34,197,94,0.4)" : "rgba(255,255,255,0.2)",
                backgroundColor: selectedPrinter ? "rgba(34,197,94,0.1)" : "rgba(255,255,255,0.06)",
                opacity: pressed ? 0.7 : 1,
              })}
              onPress={onSelectPrinter}
            >
              <Ionicons name="wifi" size={18} color={selectedPrinter ? "#22C55E" : "#9CA3AF"} />
              <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 13, color: selectedPrinter ? "#22C55E" : "#9CA3AF" }}>
                {selectedPrinter ? selectedPrinter.name : "Select Network Printer"}
              </Text>
              {selectedPrinter && (
                <Pressable onPress={onClearPrinter} hitSlop={8}>
                  <Ionicons name="close-circle" size={16} color="rgba(255,255,255,0.4)" />
                </Pressable>
              )}
            </Pressable>
          )}
          <View style={labelStyles.actions}>
            <Pressable
              style={({ pressed }) => [labelStyles.printBtn, pressed && { opacity: 0.8 }]}
              onPress={() => {
                if (labelData) onPrint(labelData);
              }}
            >
              <Ionicons name="print-outline" size={20} color="#FFF" />
              <Text style={labelStyles.printBtnText}>Print Label</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [labelStyles.doneBtn, pressed && { opacity: 0.8 }]}
              onPress={onDone}
              testID="label-done-btn"
            >
              <Text style={labelStyles.doneBtnText}>Done</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const labelStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  container: {
    backgroundColor: "#FFF",
    borderRadius: 20,
    width: "100%",
    maxWidth: 400,
    maxHeight: "85%",
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 12,
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  scroll: {
    paddingHorizontal: 20,
  },
  labelCard: {
    backgroundColor: Colors.light.surface,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: Colors.light.borderLight,
    borderStyle: "dashed",
    padding: 18,
  },
  labelTopBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  labName: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: Colors.light.tint,
    letterSpacing: 1.5,
  },
  rushTag: {
    backgroundColor: Colors.light.warningLight,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 6,
  },
  rushTagText: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: Colors.light.warning,
    letterSpacing: 0.5,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.light.borderLight,
    marginVertical: 12,
  },
  labelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingVertical: 5,
  },
  labelKey: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
    width: 80,
  },
  labelValue: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
    flex: 1,
    textAlign: "right",
  },
  notesSection: {
    gap: 6,
  },
  notesText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
    lineHeight: 18,
  },
  labelFooter: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textTertiary,
    textAlign: "center",
  },
  actions: {
    flexDirection: "row",
    gap: 12,
    padding: 20,
    paddingTop: 16,
  },
  printBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.light.tint,
    paddingVertical: 14,
    borderRadius: 12,
  },
  printBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
  doneBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.light.surfaceSecondary,
    paddingVertical: 14,
    borderRadius: 12,
  },
  doneBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
  },
});
