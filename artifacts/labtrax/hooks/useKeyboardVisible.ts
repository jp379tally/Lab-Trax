import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

// iOS fires the `will` events as the keyboard starts animating, which keeps the
// dismissal affordance live for the whole animation. Android only emits the
// `did` events reliably, so each platform listens to the pair it actually gets.
const SHOW_EVENT = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
const HIDE_EVENT = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

/**
 * Tracks whether the soft keyboard is currently on screen.
 *
 * Used by `DismissKeyboardView` so the tap-to-dismiss layer stays completely
 * inert (no press handler at all) while no keyboard is showing. Screens rarely
 * need this directly — prefer `DismissKeyboardView` / `useDismissKeyboardOnTap`.
 */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const showSub = Keyboard.addListener(SHOW_EVENT, () => setVisible(true));
    const hideSub = Keyboard.addListener(HIDE_EVENT, () => setVisible(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return visible;
}
