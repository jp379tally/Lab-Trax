import React, { useCallback } from "react";
import {
  Keyboard,
  Platform,
  TouchableWithoutFeedback,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useKeyboardVisible } from "@/hooks/useKeyboardVisible";

/**
 * The scroll dismissal behaviour that pairs with `DismissKeyboardView`: iOS
 * lets the keyboard track the finger, Android has no interactive mode so it
 * closes as soon as the drag starts. Pass this to any `ScrollView`/`FlatList`
 * that can sit under an open keyboard.
 */
export const scrollKeyboardDismissMode: "interactive" | "on-drag" =
  Platform.OS === "ios" ? "interactive" : "on-drag";

/**
 * Returns a press handler that closes the keyboard, or a no-op while no
 * keyboard is showing.
 *
 * Use this when a screen already has a full-bleed `Pressable` that must keep
 * its handler defined (e.g. a sheet body that also has to swallow taps so they
 * never reach a closing backdrop). Everywhere else prefer `DismissKeyboardView`.
 */
export function useDismissKeyboardOnTap(): () => void {
  const keyboardVisible = useKeyboardVisible();
  return useCallback(() => {
    if (!keyboardVisible) return;
    Keyboard.dismiss();
  }, [keyboardVisible]);
}

interface DismissKeyboardViewProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Set false to keep the layer inert (e.g. while a drag gesture owns the screen). */
  enabled?: boolean;
  testID?: string;
}

/**
 * DismissKeyboardView — wrap a screen's chrome (header, search row, filter row,
 * and the space behind a list) so tapping any non-interactive part of it closes
 * the soft keyboard.
 *
 * When to use it: any screen with a text input where the keyboard would
 * otherwise cover content with no obvious way out. Wrap the screen body once,
 * as high as possible, and leave modals/dialogs to wrap their own sheet
 * content. Pair it with `scrollKeyboardDismissMode` on the screen's scrollable
 * so a drag dismisses too.
 *
 * What it deliberately does not do:
 * - It never swallows a tap meant for a child. A child `Pressable`, row, or
 *   input becomes the touch responder first, so those stay single-tap.
 * - It never blocks scrolling: a drag is claimed by the scrollable and this
 *   layer's press is cancelled.
 * - It is invisible to screen readers (`accessible={false}`) and exposes no
 *   press handler at all while the keyboard is hidden.
 */
export function DismissKeyboardView({
  children,
  style,
  enabled = true,
  testID,
}: DismissKeyboardViewProps) {
  const keyboardVisible = useKeyboardVisible();
  const handlePress = useCallback(() => {
    Keyboard.dismiss();
  }, []);

  return (
    <TouchableWithoutFeedback
      accessible={false}
      onPress={enabled && keyboardVisible ? handlePress : undefined}
      testID={testID}
    >
      <View style={style}>{children}</View>
    </TouchableWithoutFeedback>
  );
}
