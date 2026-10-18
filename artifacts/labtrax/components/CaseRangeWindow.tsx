import React, { useRef, useState } from "react";
import { Modal, View, Text, TextInput, Pressable, Keyboard, useWindowDimensions, Platform, ScrollView } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { formatCalendarDate, parseRangeDate, rangeDateError, rangeMonthDays, rangeCalendarMonth } from "@workspace/calendar-date";
import { useTheme } from "@/lib/theme-context";
import { DismissKeyboardView } from "@/components/ui/DismissKeyboardView";

export function CaseRangeWindow({ start, end, context, onCancel, onApply }: {
  start: string; end: string; context: "created" | "due";
  onCancel: () => void; onApply: (start: string, end: string) => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const [from, setFrom] = useState(formatCalendarDate(start) ?? "");
  const [to, setTo] = useState(formatCalendarDate(end) ?? "");
  const [attempted, setAttempted] = useState(false);
  const [choosingEnd, setChoosingEnd] = useState(false);
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return start ? rangeCalendarMonth(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1) : rangeCalendarMonth(now.getFullYear(), now.getMonth());
  });
  const endRef = useRef<TextInput>(null);
  const a = parseRangeDate(from), b = parseRangeDate(to);
  const error = rangeDateError(a, b);
  const cancel = () => { Keyboard.dismiss(); onCancel(); };
  function normalize(value: string, setter: (text: string) => void) {
    const iso = parseRangeDate(value);
    if (iso) {
      setter(formatCalendarDate(iso)!);
      setMonth(rangeCalendarMonth(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1));
    }
    setAttempted(true);
  }
  function choose(day: string) {
    Keyboard.dismiss();
    if (!choosingEnd) {
      setFrom(formatCalendarDate(day)!); setTo(""); setChoosingEnd(true); setAttempted(false);
    } else {
      setTo(formatCalendarDate(day)!); setChoosingEnd(false); setAttempted(true);
    }
  }
  const text = { color: colors.text, fontSize: 14 };
  return <Modal testID="case-range-modal" visible transparent animationType="fade" onRequestClose={cancel}>
    <KeyboardAvoidingView testID="case-range-keyboard-viewport" behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1, justifyContent: "center", alignItems: "center", paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }}>
      <Pressable accessibilityLabel="Cancel date range" onPress={cancel} style={{ position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.5)" }} />
      <View testID="cases-custom-range-panel" accessibilityViewIsModal style={{ flexShrink: 1, width: Math.min(384, width - 24), maxHeight: height - insets.top - insets.bottom - 24, backgroundColor: colors.surface, borderRadius: 16, overflow: "hidden" }}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16 }} bounces={false}>
          <DismissKeyboardView testID="cases-custom-date-keyboard-dismiss">
            <Text accessibilityRole="header" style={{ ...text, fontSize: 18, fontWeight: "600" }}>Custom {context} date</Text>
            <Text style={{ ...text, fontSize: 12, marginVertical: 8 }}>Pick Start then End, or type M/D or M/D/YYYY.</Text>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Pressable accessibilityRole="button" accessibilityLabel="Previous month" onPress={() => setMonth(rangeCalendarMonth(month.getFullYear(), month.getMonth() - 1))} style={{ padding: 10 }}><Text style={text}>‹</Text></Pressable>
              <Text accessibilityLiveRegion="polite" style={text}>{month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Next month" onPress={() => setMonth(rangeCalendarMonth(month.getFullYear(), month.getMonth() + 1))} style={{ padding: 10 }}><Text style={text}>›</Text></Pressable>
            </View>
            <View style={{ flexDirection: "row" }}>{["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map(day => <Text key={day} style={{ ...text, width: "14.2857%", textAlign: "center", fontSize: 12 }}>{day}</Text>)}</View>
            <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
              {rangeMonthDays(month.getFullYear(), month.getMonth()).map((day, i) => day ? <Pressable key={day} accessibilityRole="button" accessibilityLabel={formatCalendarDate(day)!}
                accessibilityState={{ selected: !!a && day >= a && day <= (b && b >= a ? b : a) }}
                onPress={() => choose(day)} style={{ width: "14.2857%", minHeight: 36, alignItems: "center", justifyContent: "center", borderRadius: 4, backgroundColor: day === a || day === b ? colors.tint : a && b && day > a && day < b ? colors.tint + "22" : "transparent" }}>
                <Text style={{ ...text, color: day === a || day === b ? colors.textInverse : colors.text }}>{Number(day.slice(8))}</Text>
              </Pressable> : <View key={i} style={{ width: "14.2857%", minHeight: 36 }} />)}
            </View>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
              <View style={{ flex: 1 }}><Text style={text}>Start date</Text><TextInput accessibilityLabel="Start date" accessibilityHint="Enter M/D or M/D/YYYY" testID="case-range-start" value={from} placeholder="M/D/YYYY" placeholderTextColor={colors.textTertiary}
                style={{ ...text, borderWidth: 1, borderColor: colors.border, borderRadius: 6, padding: 8, minHeight: 44 }} keyboardType="numbers-and-punctuation" returnKeyType="next" blurOnSubmit={false}
                onChangeText={s => { setFrom(s); setChoosingEnd(false); }} onBlur={() => normalize(from, setFrom)} onSubmitEditing={() => { normalize(from, setFrom); endRef.current?.focus(); }}
                onKeyPress={e => { if (e.nativeEvent.key === "Escape") cancel(); else if (e.nativeEvent.key === "Tab") { normalize(from, setFrom); endRef.current?.focus(); } }} /></View>
              <View style={{ flex: 1 }}><Text style={text}>End date</Text><TextInput ref={endRef} accessibilityLabel="End date" testID="case-range-end" value={to} placeholder="M/D/YYYY" placeholderTextColor={colors.textTertiary}
                style={{ ...text, borderWidth: 1, borderColor: colors.border, borderRadius: 6, padding: 8, minHeight: 44 }} keyboardType="numbers-and-punctuation" returnKeyType="done"
                onChangeText={s => { setTo(s); setChoosingEnd(false); }} onBlur={() => normalize(to, setTo)} onSubmitEditing={() => { normalize(to, setTo); Keyboard.dismiss(); }} onKeyPress={e => { if (e.nativeEvent.key === "Escape") cancel(); else if (e.nativeEvent.key === "Tab") normalize(to, setTo); }} /></View>
            </View>
            <Text accessibilityLiveRegion="polite" style={{ ...text, fontSize: 12, marginVertical: 8 }}>{a && b ? `${formatCalendarDate(a)} – ${formatCalendarDate(b)}` : a ? `${formatCalendarDate(a)} – Select End date` : "Select a range"}</Text>
            {attempted && error && <Text accessibilityRole="alert" style={{ color: colors.error, fontSize: 12 }}>{error}</Text>}
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 12, marginTop: 8 }}>
              <Pressable accessibilityRole="button" onPress={cancel} style={{ padding: 12 }}><Text style={text}>Cancel</Text></Pressable>
              <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!error }} disabled={!!error} style={{ padding: 12, backgroundColor: colors.tint, borderRadius: 6, opacity: error ? 0.5 : 1 }}
                onPress={() => { if (a && b && !error) { Keyboard.dismiss(); onApply(a, b); } }}><Text style={{ ...text, color: colors.textInverse }}>Apply</Text></Pressable>
            </View>
          </DismissKeyboardView>
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}
