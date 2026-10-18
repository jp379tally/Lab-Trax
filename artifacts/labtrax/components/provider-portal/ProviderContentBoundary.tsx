import React, { Component, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useTheme, type ThemeColors } from "@/lib/theme-context";

class ContentBoundary extends Component<{ children: ReactNode; colors: ThemeColors }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return (
      <View accessibilityRole="alert" style={{ padding: 24, gap: 16 }}>
        <Text style={{ color: this.props.colors.text }}>This section could not be opened. Try again, choose another section, or sign out.</Text>
        <Pressable accessibilityRole="button" onPress={() => this.setState({ failed: false })}>
          <Text style={{ color: this.props.colors.tint }}>Try opening section again</Text>
        </Pressable>
      </View>
    );
    return this.props.children;
  }
}

export function ProviderContentBoundary({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <ContentBoundary colors={colors}>{children}</ContentBoundary>;
}
