// Minimal `react-native` stub for the smoke-test harness.
// Only exports what the four smoke-tested screens import. Add more
// here when a new test surfaces a missing export.
import * as React from "react";
import { vi } from "vitest";

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const makeHost = (name: string): React.FC<HostProps> => {
  const Comp: React.FC<HostProps> = (props) =>
    React.createElement(name, props, props.children);
  Comp.displayName = name;
  return Comp;
};
const nullComponent = (): null => null;

export const View = makeHost("View");
export const Text = makeHost("Text");
export const TextInput = makeHost("TextInput");
export const Pressable = makeHost("Pressable");
export const ScrollView = makeHost("ScrollView");
export const FlatList = makeHost("FlatList");
export const Modal = makeHost("Modal");
export const KeyboardAvoidingView = makeHost("KeyboardAvoidingView");
export const RefreshControl = makeHost("RefreshControl");
export const Image = makeHost("Image");
export const ActivityIndicator = nullComponent;

export const StyleSheet = {
  create: <T extends Record<string, object>>(s: T): T => s,
  flatten: <T,>(s: T): T => s,
  hairlineWidth: 1,
  absoluteFill: {} as Record<string, unknown>,
  absoluteFillObject: {} as Record<string, unknown>,
};

export const Platform = {
  OS: "ios" as const,
  Version: 17,
  select: <T,>(o: { ios?: T; android?: T; default?: T; native?: T }):
    | T
    | undefined => o.ios ?? o.native ?? o.default,
};

export const Dimensions = {
  get: () => ({ width: 375, height: 812, scale: 2, fontScale: 1 }),
  addEventListener: () => ({ remove: (): void => {} }),
};

export const Alert = { alert: vi.fn() };
export const Linking = {
  openURL: vi.fn(async () => undefined),
  canOpenURL: vi.fn(async () => true),
};
export const Share = {
  share: vi.fn(async () => ({ action: "dismissedAction" })),
};

class AnimatedValue {
  setValue(): void {}
  interpolate(): AnimatedValue {
    return this;
  }
  stopAnimation(): void {}
}
const animation = {
  start: (cb?: (info: { finished: boolean }) => void): void =>
    cb?.({ finished: true }),
  stop: (): void => {},
};

export const Animated = {
  View: makeHost("Animated.View"),
  Text: makeHost("Animated.Text"),
  Image: makeHost("Animated.Image"),
  ScrollView: makeHost("Animated.ScrollView"),
  createAnimatedComponent: <T,>(c: T): T => c,
  Value: AnimatedValue,
  ValueXY: AnimatedValue,
  timing: () => animation,
  spring: () => animation,
  parallel: () => animation,
  sequence: () => animation,
  loop: () => animation,
  event: () => () => {},
};

const reactNativeStub = {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  FlatList,
  Modal,
  KeyboardAvoidingView,
  RefreshControl,
  Image,
  ActivityIndicator,
  StyleSheet,
  Platform,
  Dimensions,
  Alert,
  Linking,
  Share,
  Animated,
};

export default reactNativeStub;
