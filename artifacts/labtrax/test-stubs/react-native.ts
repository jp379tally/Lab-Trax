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
// FlatList in the real RN renders each `data` row via `renderItem`. The
// trivial host stub used to ignore `data`, which made smoke tests blind
// to per-row regressions. This minimal implementation invokes
// `renderItem` (and optional separators) so tests can assert on rendered
// case rows.
type FlatListProps = {
  data?: ReadonlyArray<unknown> | null;
  renderItem?: (info: {
    item: unknown;
    index: number;
    separators: Record<string, () => void>;
  }) => React.ReactNode;
  keyExtractor?: (item: unknown, index: number) => string;
  ListHeaderComponent?: React.ReactNode | React.ComponentType;
  ListFooterComponent?: React.ReactNode | React.ComponentType;
  ListEmptyComponent?: React.ReactNode | React.ComponentType;
  ItemSeparatorComponent?: React.ComponentType;
  children?: React.ReactNode;
  [key: string]: unknown;
};
const renderListSlot = (
  slot: React.ReactNode | React.ComponentType | undefined,
): React.ReactNode => {
  if (!slot) return null;
  if (typeof slot === "function") {
    const Slot = slot as React.ComponentType;
    return React.createElement(Slot);
  }
  return slot as React.ReactNode;
};
export const FlatList: React.FC<FlatListProps> = (props) => {
  const {
    data,
    renderItem,
    keyExtractor,
    ListHeaderComponent,
    ListFooterComponent,
    ListEmptyComponent,
    ItemSeparatorComponent,
    children,
    ...rest
  } = props;
  const rows: React.ReactNode[] = [];
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    const empty = renderListSlot(ListEmptyComponent);
    if (empty) rows.push(React.createElement(React.Fragment, { key: "empty" }, empty));
  } else if (renderItem) {
    items.forEach((item, index) => {
      const key = keyExtractor ? keyExtractor(item, index) : String(index);
      const node = renderItem({ item, index, separators: {} as Record<string, () => void> });
      rows.push(React.createElement(React.Fragment, { key }, node));
      if (ItemSeparatorComponent && index < items.length - 1) {
        rows.push(
          React.createElement(ItemSeparatorComponent as React.ComponentType, {
            key: `${key}__sep`,
          }),
        );
      }
    });
  }
  return React.createElement(
    "FlatList",
    rest,
    renderListSlot(ListHeaderComponent),
    ...rows,
    renderListSlot(ListFooterComponent),
    children,
  );
};
FlatList.displayName = "FlatList";
export const Modal = makeHost("Modal");
export const KeyboardAvoidingView = makeHost("KeyboardAvoidingView");
export const TouchableWithoutFeedback = makeHost("TouchableWithoutFeedback");
export const RefreshControl = makeHost("RefreshControl");
export const Image = makeHost("Image");
export const ActivityIndicator = nullComponent;
export const StatusBar = nullComponent;

export const Keyboard = {
  dismiss: vi.fn(),
  addListener: vi.fn(() => ({ remove: (): void => {} })),
  removeAllListeners: vi.fn(),
};

export const UIManager = {
  setLayoutAnimationEnabledExperimental: vi.fn(),
  getViewManagerConfig: vi.fn(() => ({})),
};

export const LayoutAnimation = {
  configureNext: vi.fn(),
  create: vi.fn(),
  Presets: {
    easeInEaseOut: {},
    linear: {},
    spring: {},
  },
  Types: { spring: "spring", linear: "linear", easeInEaseOut: "easeInEaseOut" },
  Properties: { opacity: "opacity", scaleXY: "scaleXY" },
};

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

export const AppState = {
  currentState: "active" as const,
  addEventListener: vi.fn(() => ({ remove: (): void => {} })),
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
  TouchableWithoutFeedback,
  RefreshControl,
  Image,
  ActivityIndicator,
  StatusBar,
  Keyboard,
  UIManager,
  LayoutAnimation,
  StyleSheet,
  Platform,
  Dimensions,
  Alert,
  Linking,
  Share,
  Animated,
  AppState,
};

export default reactNativeStub;
