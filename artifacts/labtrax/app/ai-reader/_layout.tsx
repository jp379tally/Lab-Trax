import { Stack } from "expo-router";
import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

console.log("[AiReader/_layout] Module loaded");

class AiReaderErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[AiReader] ErrorBoundary caught render error:", error.message);
    console.error("[AiReader] Stack trace:", error.stack);
    console.error("[AiReader] Component stack:", info.componentStack);
  }

  render() {
    if (this.state.error) {
      const err = this.state.error;
      return (
        <View style={{ flex: 1, backgroundColor: "#111827", padding: 24, paddingTop: 80 }}>
          <Text style={{ color: "#f87171", fontSize: 16, fontWeight: "700", marginBottom: 10 }}>
            AI Reader — Crash Report
          </Text>
          <Text style={{ color: "#e5e7eb", fontSize: 13, marginBottom: 14 }}>
            {err.name}: {err.message}
          </Text>
          <ScrollView style={{ maxHeight: 320, backgroundColor: "#1f2937", borderRadius: 8, padding: 10 }}>
            <Text style={{ color: "#9ca3af", fontSize: 11, fontFamily: "monospace" }}>
              {err.stack}
            </Text>
          </ScrollView>
          <Pressable
            onPress={() => this.setState({ error: null })}
            style={{ marginTop: 20, padding: 14, backgroundColor: "#374151", borderRadius: 8, alignItems: "center" }}
          >
            <Text style={{ color: "#f9fafb", fontSize: 14 }}>Dismiss</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function AiReaderLayout() {
  console.log("[AiReader/_layout] Rendering Stack");
  return (
    <AiReaderErrorBoundary>
      <Stack screenOptions={{ headerShown: false, animation: "slide_from_right" }}>
        <Stack.Screen name="capture" />
        <Stack.Screen name="review" />
        <Stack.Screen name="extracted" />
        <Stack.Screen name="barcode" />
      </Stack>
    </AiReaderErrorBoundary>
  );
}
