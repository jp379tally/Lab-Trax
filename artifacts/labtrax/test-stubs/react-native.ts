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
export const TextInput = React.forwardRef<{ focus: () => void }, HostProps>(
  (props, ref) => {
    React.useImperativeHandle(ref, () => ({ focus: () => undefined }), []);
    return React.createElement(
      "TextInput",
      props as Record<string, unknown>,
      props.children as React.ReactNode,
    );
  },
);
export const Pressable = makeHost("Pressable");

// Native scroll views close the keyboard themselves once `keyboardDismissMode`
// is "on-drag" / "interactive". Emulate that here so suites can assert the
// behaviour with `fireEvent(list, "scrollBeginDrag")` instead of only
// inspecting the prop.
type ScrollLikeProps = Record<string, unknown> & {
  keyboardDismissMode?: unknown;
  onScrollBeginDrag?: (event: unknown) => void;
};
const withKeyboardDismissOnDrag = (props: ScrollLikeProps): ScrollLikeProps => {
  const { keyboardDismissMode, onScrollBeginDrag } = props;
  if (keyboardDismissMode !== "on-drag" && keyboardDismissMode !== "interactive") {
    return props;
  }
  return {
    ...props,
    onScrollBeginDrag: (event: unknown): void => {
      Keyboard.dismiss();
      onScrollBeginDrag?.(event);
    },
  };
};

export const mockScrollViewScrollTo = vi.fn();
export const ScrollView = React.forwardRef<{ scrollTo: typeof mockScrollViewScrollTo }, HostProps>(
  (props, ref) => {
    React.useImperativeHandle(
      ref,
      () => ({ scrollTo: mockScrollViewScrollTo }),
      [],
    );
    return React.createElement(
      "ScrollView",
      withKeyboardDismissOnDrag(props),
      props.children as React.ReactNode,
    );
  },
);
ScrollView.displayName = "ScrollView";
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
    withKeyboardDismissOnDrag(rest),
    renderListSlot(ListHeaderComponent),
    ...rows,
    renderListSlot(ListFooterComponent),
    children,
  );
};
FlatList.displayName = "FlatList";
export const Modal = makeHost("Modal");
export const KeyboardAvoidingView = makeHost("KeyboardAvoidingView");
export const TouchableOpacity = makeHost("TouchableOpacity");
export const TouchableWithoutFeedback = makeHost("TouchableWithoutFeedback");
export const RefreshControl = makeHost("RefreshControl");
export const Image = makeHost("Image");
export const ActivityIndicator = nullComponent;
export const StatusBar = nullComponent;
export const Switch: React.FC<{ value?: boolean; onValueChange?: (v: boolean) => void; [key: string]: unknown }> = (props) =>
  React.createElement("Switch", {
    ...props,
    accessibilityRole: "switch",
    "aria-checked": props.value,
    onClick: props.onValueChange ? () => props.onValueChange?.(!props.value) : undefined,
  });

// ── Keyboard ─────────────────────────────────────────────────────────────────
// Screens dismiss the keyboard on background taps and track whether it is on
// screen (see `useKeyboardVisible`), so the stub keeps a real listener registry
// and a visibility flag. `showMockKeyboard()` / `hideMockKeyboard()` let a suite
// drive that state; `Keyboard.dismiss` stays a spy so dismissal is observable.
type KeyboardEventName =
  | "keyboardWillShow"
  | "keyboardDidShow"
  | "keyboardWillHide"
  | "keyboardDidHide"
  | "keyboardWillChangeFrame"
  | "keyboardDidChangeFrame";
type MockKeyboardEvent = {
  endCoordinates: { screenX: number; screenY: number; width: number; height: number };
  duration: number;
};
type KeyboardListener = (event: MockKeyboardEvent) => void;

const keyboardListeners = new Map<string, Set<KeyboardListener>>();
let keyboardVisible = false;

const keyboardEvent = (visible: boolean): MockKeyboardEvent => ({
  endCoordinates: {
    screenX: 0,
    screenY: visible ? 476 : 812,
    width: 375,
    height: visible ? 336 : 0,
  },
  duration: 250,
});

function emitKeyboardEvent(name: KeyboardEventName, visible: boolean): void {
  const listeners = keyboardListeners.get(name);
  if (!listeners) return;
  // Copy first: a listener may remove itself (or another) while we iterate.
  for (const listener of [...listeners]) listener(keyboardEvent(visible));
}

/** Simulate the soft keyboard opening (fires both the will- and did-show events). */
export function showMockKeyboard(): void {
  if (keyboardVisible) return;
  keyboardVisible = true;
  emitKeyboardEvent("keyboardWillShow", true);
  emitKeyboardEvent("keyboardDidShow", true);
}

/** Simulate the soft keyboard closing. No-op when it is already hidden. */
export function hideMockKeyboard(): void {
  if (!keyboardVisible) return;
  keyboardVisible = false;
  emitKeyboardEvent("keyboardWillHide", false);
  emitKeyboardEvent("keyboardDidHide", false);
}

/** Whether the simulated keyboard is currently on screen. */
export function isMockKeyboardVisible(): boolean {
  return keyboardVisible;
}

/** Drops every registered listener and hides the keyboard, between tests. */
export function resetMockKeyboard(): void {
  keyboardVisible = false;
  keyboardListeners.clear();
}

export const Keyboard = {
  // Dismissing really closes the simulated keyboard, so a screen listening for
  // the hide event sees it exactly as it would on device.
  dismiss: vi.fn((): void => {
    hideMockKeyboard();
  }),
  addListener: vi.fn((name: KeyboardEventName, listener: KeyboardListener) => {
    const listeners = keyboardListeners.get(name) ?? new Set<KeyboardListener>();
    listeners.add(listener);
    keyboardListeners.set(name, listeners);
    return {
      remove: (): void => {
        listeners.delete(listener);
      },
    };
  }),
  removeAllListeners: vi.fn((name?: KeyboardEventName): void => {
    if (name) keyboardListeners.get(name)?.clear();
    else keyboardListeners.clear();
  }),
  isVisible: (): boolean => keyboardVisible,
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

const flattenStyle = <T,>(style: T): T => {
  if (!Array.isArray(style)) return style;

  return style.reduce<Record<string, unknown>>((flattened, entry) => {
    const value = flattenStyle(entry);
    if (value && typeof value === "object") {
      Object.assign(flattened, value);
    }
    return flattened;
  }, {}) as T;
};

export const StyleSheet = {
  create: <T extends Record<string, object>>(s: T): T => s,
  flatten: flattenStyle,
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

export const useColorScheme = (): "light" => "light";

export const useWindowDimensions = (): { width: number; height: number; scale: number; fontScale: number } => ({
  width: 375,
  height: 812,
  scale: 2,
  fontScale: 1,
});

export const Alert = { alert: vi.fn() };
export const Linking = {
  openURL: vi.fn(async () => undefined),
  openSettings: vi.fn(async () => undefined),
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
  delay: () => animation,
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
  Switch,
  Keyboard,
  UIManager,
  LayoutAnimation,
  StyleSheet,
  Platform,
  Dimensions,
  useColorScheme,
  useWindowDimensions,
  Alert,
  Linking,
  Share,
  Animated,
  AppState,
};

export default reactNativeStub;
