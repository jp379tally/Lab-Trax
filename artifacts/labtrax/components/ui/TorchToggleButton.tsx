import React from "react";
import { Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

interface TorchToggleButtonProps {
  torchOn: boolean;
  onToggle: () => void;
  /** Disabled when the device has no torch (e.g. front camera, simulator). */
  disabled?: boolean;
  testID?: string;
}

/**
 * Manual flashlight/torch toggle used by all three barcode scan screens
 * (dashboard scan modal, batch-locate, AI-reader barcode assignment).
 * Shared so torch behavior/appearance stays consistent across screens.
 */
export function TorchToggleButton({
  torchOn,
  onToggle,
  disabled = false,
  testID = "scan-torch-toggle",
}: TorchToggleButtonProps) {
  return (
    <Pressable
      style={[
        styles.button,
        torchOn && styles.buttonActive,
        disabled && styles.buttonDisabled,
      ]}
      onPress={onToggle}
      disabled={disabled}
      hitSlop={8}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={torchOn ? "Turn flashlight off" : "Turn flashlight on"}
      accessibilityState={{ disabled, selected: torchOn }}
    >
      <Ionicons
        name={torchOn ? "flash" : "flash-outline"}
        size={20}
        color={torchOn ? "#111827" : "#fff"}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  buttonActive: {
    backgroundColor: "#fbbf24",
  },
  buttonDisabled: {
    opacity: 0.4,
  },
});
