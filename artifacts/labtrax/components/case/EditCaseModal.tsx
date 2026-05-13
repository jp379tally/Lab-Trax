import React from "react";
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

const editFieldStyles = StyleSheet.create({
  label: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#475569",
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: "#1E293B",
    backgroundColor: "#F8FAFC",
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
  notes: string;
  onChangeDoctor: (v: string) => void;
  onChangePatient: (v: string) => void;
  onChangeTeeth: (v: string) => void;
  onChangeShade: (v: string) => void;
  onChangeMaterial: (v: string) => void;
  onChangeDueDate: (v: string) => void;
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
    notes,
    onChangeDoctor,
    onChangePatient,
    onChangeTeeth,
    onChangeShade,
    onChangeMaterial,
    onChangeDueDate,
    onChangeNotes,
    onSave,
  } = props;

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
          <View style={{ backgroundColor: "#FFF", borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "90%", paddingBottom: Platform.OS === "web" ? 34 : insetsBottom }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: "#E2E8F0" }}>
              <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: "#1E293B" }}>Edit Case</Text>
              <Pressable onPress={onClose}>
                <Ionicons name="close" size={24} color="#64748B" />
              </Pressable>
            </View>
            <ScrollView style={{ paddingHorizontal: 20 }} contentContainerStyle={{ paddingVertical: 16, gap: 14 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <View>
                <Text style={editFieldStyles.label}>Provider / Doctor</Text>
                <TextInput style={editFieldStyles.input} value={doctor} onChangeText={onChangeDoctor} placeholder="Doctor name" placeholderTextColor="#94A3B8" />
                {doctor.trim().toLowerCase() !== (originalDoctorName || "").toLowerCase() && doctor.trim().length > 0 && (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6, backgroundColor: "#FEF3C7", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 }}>
                    <Ionicons name="swap-horizontal" size={14} color="#D97706" />
                    <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: "#92400E", flex: 1 }}>Invoice will transfer to new provider</Text>
                  </View>
                )}
              </View>

              <View>
                <Text style={editFieldStyles.label}>Patient Name</Text>
                <TextInput style={editFieldStyles.input} value={patient} onChangeText={onChangePatient} placeholder="Patient name" placeholderTextColor="#94A3B8" />
              </View>

              <View style={{ flexDirection: "row", gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text style={editFieldStyles.label}>Teeth</Text>
                  <TextInput style={editFieldStyles.input} value={teeth} onChangeText={onChangeTeeth} placeholder="e.g. 3,4,5" placeholderTextColor="#94A3B8" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={editFieldStyles.label}>Shade</Text>
                  <TextInput style={editFieldStyles.input} value={shade} onChangeText={onChangeShade} placeholder="e.g. A2" placeholderTextColor="#94A3B8" />
                </View>
              </View>

              <View style={{ flexDirection: "row", gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text style={editFieldStyles.label}>Material</Text>
                  <TextInput style={editFieldStyles.input} value={material} onChangeText={onChangeMaterial} placeholder="e.g. Zirconia" placeholderTextColor="#94A3B8" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={editFieldStyles.label}>Due Date (YYYY-MM-DD)</Text>
                  <TextInput style={editFieldStyles.input} value={dueDate} onChangeText={onChangeDueDate} placeholder="2025-12-31" placeholderTextColor="#94A3B8" />
                </View>
              </View>

              <View>
                <Text style={editFieldStyles.label}>Notes</Text>
                <TextInput style={[editFieldStyles.input, { height: 80, textAlignVertical: "top" }]} value={notes} onChangeText={onChangeNotes} placeholder="Case notes..." placeholderTextColor="#94A3B8" multiline />
              </View>

              <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
                <Pressable
                  onPress={onClose}
                  style={({ pressed }) => [{ flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: "#F1F5F9", alignItems: "center" as const }, pressed && { opacity: 0.85 }]}
                >
                  <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#64748B" }}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={onSave}
                  style={({ pressed }) => [{ flex: 1, flexDirection: "row" as const, gap: 6, paddingVertical: 14, borderRadius: 12, backgroundColor: "#10B981", alignItems: "center" as const, justifyContent: "center" as const }, pressed && { opacity: 0.85 }]}
                >
                  <Ionicons name="checkmark-circle" size={18} color="#FFF" />
                  <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: "#FFF" }}>Save Changes</Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
