import React, { useMemo } from "react";
import {
  Modal,
  KeyboardAvoidingView,
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  Platform,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";

const makeEditFieldStyles = (colors: ThemeColors) => StyleSheet.create({
  label: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.textSecondary,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: colors.text,
    backgroundColor: colors.canvas,
  },
});

export type EditCaseModalProps = {
  visible: boolean;
  onClose: () => void;
  insetsBottom: number;
  originalDoctorName: string;
  doctor: string;
  patient: string;
  teeth: string;
  shade: string;
  material: string;
  dueDate: string;
  expectedDeliveryDate: string;
  notes: string;
  onChangeDoctor: (v: string) => void;
  onChangePatient: (v: string) => void;
  onChangeTeeth: (v: string) => void;
  onChangeShade: (v: string) => void;
  onChangeMaterial: (v: string) => void;
  onChangeDueDate: (v: string) => void;
  onChangeExpectedDeliveryDate: (v: string) => void;
  onChangeNotes: (v: string) => void;
  onSave: () => void;
};

export function EditCaseModal(props: EditCaseModalProps) {
  const {
    visible,
    onClose,
    insetsBottom,
    originalDoctorName,
    doctor,
    patient,
    teeth,
    shade,
    material,
    dueDate,
    expectedDeliveryDate,
    notes,
    onChangeDoctor,
    onChangePatient,
    onChangeTeeth,
    onChangeShade,
    onChangeMaterial,
    onChangeDueDate,
    onChangeExpectedDeliveryDate,
    onChangeNotes,
    onSave,
  } = props;

  const { colors } = useTheme();
  const editFieldStyles = useMemo(() => makeEditFieldStyles(colors), [colors]);

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
          <View style={{ backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "90%", paddingBottom: Platform.OS === "web" ? 34 : insetsBottom }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
              <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: colors.text }}>Edit Case</Text>
              <Pressable onPress={onClose}>
                <Ionicons name="close" size={24} color={colors.textSecondary} />
              </Pressable>
            </View>
            <ScrollView style={{ paddingHorizontal: 20 }} contentContainerStyle={{ paddingVertical: 16, gap: 14 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <View>
                <Text style={editFieldStyles.label}>Provider / Doctor</Text>
                <TextInput style={editFieldStyles.input} value={doctor} onChangeText={onChangeDoctor} placeholder="Doctor name" placeholderTextColor={colors.textTertiary} />
                {doctor.trim().toLowerCase() !== (originalDoctorName || "").toLowerCase() && doctor.trim().length > 0 && (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6, backgroundColor: colors.warningLight, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 }}>
                    <Ionicons name="swap-horizontal" size={14} color={colors.warningStrong} />
                    <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: colors.warningText, flex: 1 }}>Invoice will transfer to new provider</Text>
                  </View>
                )}
              </View>

              <View>
                <Text style={editFieldStyles.label}>Patient Name</Text>
                <TextInput style={editFieldStyles.input} value={patient} onChangeText={onChangePatient} placeholder="Patient name" placeholderTextColor={colors.textTertiary} />
              </View>

              <View style={{ flexDirection: "row", gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text style={editFieldStyles.label}>Teeth</Text>
                  <TextInput style={editFieldStyles.input} value={teeth} onChangeText={onChangeTeeth} placeholder="e.g. 3,4,5" placeholderTextColor={colors.textTertiary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={editFieldStyles.label}>Shade</Text>
                  <TextInput style={editFieldStyles.input} value={shade} onChangeText={onChangeShade} placeholder="e.g. A2" placeholderTextColor={colors.textTertiary} />
                </View>
              </View>

              <View style={{ flexDirection: "row", gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text style={editFieldStyles.label}>Material</Text>
                  <TextInput style={editFieldStyles.input} value={material} onChangeText={onChangeMaterial} placeholder="e.g. Zirconia" placeholderTextColor={colors.textTertiary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={editFieldStyles.label}>Due Date (YYYY-MM-DD)</Text>
                  <TextInput style={editFieldStyles.input} value={dueDate} onChangeText={onChangeDueDate} placeholder="2025-12-31" placeholderTextColor={colors.textTertiary} />
                </View>
              </View>

              <View>
                <Text style={editFieldStyles.label}>Expected Delivery (YYYY-MM-DD)</Text>
                <TextInput style={editFieldStyles.input} value={expectedDeliveryDate} onChangeText={onChangeExpectedDeliveryDate} placeholder="2025-12-31" placeholderTextColor={colors.textTertiary} keyboardType="numbers-and-punctuation" />
              </View>

              <View>
                <Text style={editFieldStyles.label}>Notes</Text>
                <TextInput style={[editFieldStyles.input, { height: 80, textAlignVertical: "top" }]} value={notes} onChangeText={onChangeNotes} placeholder="Case notes..." placeholderTextColor={colors.textTertiary} multiline />
              </View>

              <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
                <Pressable
                  onPress={onClose}
                  style={({ pressed }) => [{ flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: colors.surfaceAlt, alignItems: "center" as const }, pressed && { opacity: 0.85 }]}
                >
                  <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: colors.textSecondary }}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={onSave}
                  style={({ pressed }) => [{ flex: 1, flexDirection: "row" as const, gap: 6, paddingVertical: 14, borderRadius: 12, backgroundColor: colors.success, alignItems: "center" as const, justifyContent: "center" as const }, pressed && { opacity: 0.85 }]}
                >
                  <Ionicons name="checkmark-circle" size={18} color={colors.textInverse} />
                  <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: colors.textInverse }}>Save Changes</Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
