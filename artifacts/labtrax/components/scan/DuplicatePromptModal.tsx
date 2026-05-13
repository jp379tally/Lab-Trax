import React from "react";
import { Modal, View, Text, Pressable, ScrollView, TextInput } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { DuplicateHit } from "@/lib/scan/duplicate-merge";

export type DuplicatePromptState = {
  matches: DuplicateHit[];
  patientName: string;
};

type Props = {
  prompt: DuplicatePromptState | null;
  selectedId: string;
  reason: string;
  charge: "" | "yes" | "no";
  error: string | null;
  onSelectId: (id: string) => void;
  onChangeReason: (s: string) => void;
  onChangeCharge: (v: "yes" | "no") => void;
  onClose: () => void;
  onViewChart: (patientName: string) => void;
  onNotARemake: () => void;
  onConfirmRemake: (
    selectedId: string,
    reason: string,
    charged: boolean,
  ) => void;
  onSetError: (msg: string | null) => void;
};

export function DuplicatePromptModal({
  prompt,
  selectedId,
  reason,
  charge,
  error,
  onSelectId,
  onChangeReason,
  onChangeCharge,
  onClose,
  onViewChart,
  onNotARemake,
  onConfirmRemake,
  onSetError,
}: Props) {
  return (
    <Modal
      visible={!!prompt}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", padding: 16 }}>
        <View style={{ backgroundColor: "#FFF", borderRadius: 14, maxHeight: "88%", overflow: "hidden" }}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: "#E5E7EB", flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Ionicons name="warning" size={18} color="#D97706" />
            <Text style={{ flex: 1, fontFamily: "Inter_700Bold", fontSize: 15, color: "#111827" }}>
              Possible duplicate / remake?
            </Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={20} color="#6B7280" />
            </Pressable>
          </View>
          <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ padding: 16 }}>
            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 13, color: "#374151", marginBottom: 12 }}>
              Found {prompt?.matches.length ?? 0} prior case
              {(prompt?.matches.length ?? 0) === 1 ? "" : "s"} for{" "}
              <Text style={{ fontFamily: "Inter_600SemiBold", color: "#111827" }}>
                {prompt?.patientName}
              </Text>
              . If this is a remake, pick which prior case it is remaking.
            </Text>
            {(prompt?.matches ?? []).map((m) => {
              const isLegacy = m.source === "legacy";
              const selected = selectedId === m.id;
              return (
                <Pressable
                  key={`${m.source}:${m.id}`}
                  onPress={() => {
                    onSelectId(m.id);
                    onSetError(null);
                  }}
                  style={{
                    borderWidth: 1,
                    borderColor: selected ? "#2563EB" : "#E5E7EB",
                    backgroundColor: selected ? "#EFF6FF" : "#FFF",
                    borderRadius: 10,
                    padding: 10,
                    marginBottom: 8,
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <View style={{
                      width: 16, height: 16, borderRadius: 8,
                      borderWidth: 2,
                      borderColor: selected ? "#2563EB" : "#9CA3AF",
                      alignItems: "center", justifyContent: "center",
                    }}>
                      {selected && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#2563EB" }} />}
                    </View>
                    <Text style={{ fontFamily: "Inter_700Bold", fontSize: 13, color: "#111827" }}>
                      Case {m.caseNumber}
                    </Text>
                    {m.matchKind && m.matchKind !== "exact" && (
                      <Text style={{ fontFamily: "Inter_500Medium", fontSize: 10, color: "#6B7280", textTransform: "uppercase" }}>
                        {m.matchKind}
                      </Text>
                    )}
                    {isLegacy && (
                      <Text style={{ fontFamily: "Inter_500Medium", fontSize: 10, color: "#9CA3AF", marginLeft: "auto" }}>
                        mobile
                      </Text>
                    )}
                  </View>
                  <Text style={{ fontFamily: "Inter_500Medium", fontSize: 12, color: "#374151", marginTop: 6 }}>
                    {m.patientFirstName} {m.patientLastName}
                  </Text>
                  <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, color: "#6B7280", marginTop: 2 }}>
                    {(m.createdAt ? new Date(m.createdAt).toLocaleDateString() : "—")}
                    {m.toothNumbers ? ` · Teeth ${m.toothNumbers}` : ""}
                    {m.restorationTypes ? ` · ${m.restorationTypes}` : ""}
                    {m.status ? ` · ${m.status}` : ""}
                  </Text>
                </Pressable>
              );
            })}

            <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 12, color: "#374151", marginTop: 6, marginBottom: 4 }}>
              Reason for remake (required if remake)
            </Text>
            <TextInput
              value={reason}
              onChangeText={(t) => { onChangeReason(t); onSetError(null); }}
              placeholder="e.g. Doesn't fit / open margins / wrong shade..."
              multiline
              style={{
                borderWidth: 1, borderColor: "#E5E7EB", borderRadius: 8,
                paddingHorizontal: 10, paddingVertical: 8, minHeight: 60,
                fontFamily: "Inter_400Regular", fontSize: 13, color: "#111827",
                textAlignVertical: "top",
              }}
            />

            <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 12, color: "#374151", marginTop: 12, marginBottom: 4 }}>
              Charge for this remake?
            </Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {(["yes", "no"] as const).map((v) => (
                <Pressable
                  key={v}
                  onPress={() => { onChangeCharge(v); onSetError(null); }}
                  style={{
                    flex: 1, paddingVertical: 10, borderRadius: 8,
                    borderWidth: 1,
                    borderColor: charge === v ? (v === "no" ? "#D97706" : "#2563EB") : "#E5E7EB",
                    backgroundColor: charge === v ? (v === "no" ? "#FEF3C7" : "#EFF6FF") : "#FFF",
                    alignItems: "center",
                  }}
                >
                  <Text style={{
                    fontFamily: "Inter_600SemiBold", fontSize: 12,
                    color: charge === v ? (v === "no" ? "#92400E" : "#1D4ED8") : "#374151",
                  }}>
                    {v === "yes" ? "Yes — charge as usual" : "No — no-charge remake"}
                  </Text>
                </Pressable>
              ))}
            </View>

            {error && (
              <Text style={{ marginTop: 10, color: "#B91C1C", fontFamily: "Inter_500Medium", fontSize: 12 }}>
                {error}
              </Text>
            )}
          </ScrollView>

          <View style={{ flexDirection: "row", gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: "#E5E7EB" }}>
            <Pressable
              onPress={onClose}
              style={{ paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: "#F3F4F6" }}
            >
              <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 12, color: "#374151" }}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                const pn = prompt?.patientName ?? "";
                onViewChart(pn);
              }}
              style={{ paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: "#E5E7EB" }}
            >
              <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 12, color: "#111827" }}>View chart</Text>
            </Pressable>
            <View style={{ flex: 1 }} />
            <Pressable
              onPress={onNotARemake}
              style={{ paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: "#F3F4F6" }}
            >
              <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 12, color: "#374151" }}>Not a remake</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (!selectedId) {
                  onSetError("Pick the prior case being remade.");
                  return;
                }
                if (!reason.trim()) {
                  onSetError("Reason for remake is required.");
                  return;
                }
                if (charge === "") {
                  onSetError("Choose whether to charge for this remake.");
                  return;
                }
                onConfirmRemake(selectedId, reason.trim(), charge === "yes");
              }}
              style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: "#2563EB" }}
            >
              <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 12, color: "#FFF" }}>
                Yes — link as remake
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
