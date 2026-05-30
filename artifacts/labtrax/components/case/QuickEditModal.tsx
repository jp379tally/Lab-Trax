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
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";

const makeLabelStyle = (colors: ThemeColors) => ({
  fontSize: 12,
  fontFamily: "Inter_600SemiBold",
  color: colors.textSecondary,
  marginBottom: 4,
  textTransform: "uppercase" as const,
  letterSpacing: 0.5,
});
const makeInputStyle = (colors: ThemeColors) => ({
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: 10,
  padding: 12,
  fontSize: 15,
  fontFamily: "Inter_500Medium",
  color: colors.text,
});

export type QuickEditModalProps = {
  visible: boolean;
  onClose: () => void;
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

export function QuickEditModal(props: QuickEditModalProps) {
  const {
    visible,
    onClose,
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

  const { colors } = useTheme();
  const labelStyle = useMemo(() => makeLabelStyle(colors), [colors]);
  const inputStyle = useMemo(() => makeInputStyle(colors), [colors]);

  return (
    <Modal visible={visible} transparent animationType="fade">
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", padding: 20 }} onPress={onClose}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <Pressable style={{ backgroundColor: colors.surface, borderRadius: 16, padding: 20, maxHeight: "90%" }} onPress={(e) => e.stopPropagation()}>
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: colors.text }}>Edit Case Info</Text>
                <Pressable onPress={onClose} hitSlop={12}>
                  <Ionicons name="close" size={22} color={colors.textSecondary} />
                </Pressable>
              </View>

              <Text style={labelStyle}>Doctor</Text>
              <TextInput style={[inputStyle, { marginBottom: 12 }]} value={doctor} onChangeText={onChangeDoctor} placeholder="Doctor name" placeholderTextColor={colors.textTertiary} />

              <Text style={labelStyle}>Patient</Text>
              <TextInput style={[inputStyle, { marginBottom: 12 }]} value={patient} onChangeText={onChangePatient} placeholder="Patient name" placeholderTextColor={colors.textTertiary} />

              <View style={{ flexDirection: "row", gap: 10, marginBottom: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text style={labelStyle}>Teeth</Text>
                  <TextInput style={inputStyle} value={teeth} onChangeText={onChangeTeeth} placeholder="#30, #31" placeholderTextColor={colors.textTertiary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={labelStyle}>Shade</Text>
                  <TextInput style={inputStyle} value={shade} onChangeText={onChangeShade} placeholder="A2" placeholderTextColor={colors.textTertiary} />
                </View>
              </View>

              <Text style={labelStyle}>Material</Text>
              <TextInput style={[inputStyle, { marginBottom: 12 }]} value={material} onChangeText={onChangeMaterial} placeholder="Zirconia" placeholderTextColor={colors.textTertiary} />

              <Text style={labelStyle}>Due Date (YYYY-MM-DD)</Text>
              <TextInput style={[inputStyle, { marginBottom: 12 }]} value={dueDate} onChangeText={onChangeDueDate} placeholder="2026-04-15" placeholderTextColor={colors.textTertiary} />

              <Text style={labelStyle}>Notes</Text>
              <TextInput style={[inputStyle, { marginBottom: 16, minHeight: 80, textAlignVertical: "top" as const }]} value={notes} onChangeText={onChangeNotes} placeholder="Case notes..." placeholderTextColor={colors.textTertiary} multiline />

              <View style={{ flexDirection: "row", gap: 10 }}>
                <Pressable onPress={onClose} style={({ pressed }) => [{ flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: colors.surfaceAlt, alignItems: "center" as const }, pressed && { opacity: 0.85 }]}>
                  <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: colors.textSecondary }}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={onSave}
                  style={({ pressed }) => [{ flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: colors.info, alignItems: "center" as const }, pressed && { opacity: 0.85 }]}
                >
                  <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: colors.textInverse }}>Save Changes</Text>
                </Pressable>
              </View>
            </ScrollView>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}
