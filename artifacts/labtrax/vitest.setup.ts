// Vitest setup for the mobile client. Pure-helper tests need none of this;
// the mocks below let smoke tests render real screen modules with RNTL.
//
// EVERY mobile test loads this file. If a merge splices unrelated code into
// it, the whole suite goes dark — no test file even transforms. Guard before
// you trust a mobile run:
//   pnpm --filter @workspace/scripts run check-test-harness:collect
// (workflow `rel-test-harness`; the parse half also fronts `rel-mobile-tests`).
// After a merge touches this file, diff it against the last intact revision
// and restore the clobbered regions rather than patching around them.
//
// `react-native` is redirected to a project-local stub two ways: (1) Vite
// plugin in vitest.config.ts for ESM imports, (2) Node require.cache here
// for externalised CJS (RNTL's matchers) — the real package's Flow source
// is unparsable.

// expo-modules-core expects two React Native globals at module-evaluation
// time. Set them before any expo import so the module-level checks don't
// throw. `__DEV__` is used by many expo packages; `globalThis.expo` is read
// by EventEmitter.ts inside expo-modules-core.
(globalThis as unknown as Record<string, unknown>).__DEV__ = false;
(globalThis as unknown as Record<string, unknown>).IS_REACT_NATIVE_TEST_ENVIRONMENT = true;
(globalThis as unknown as Record<string, unknown>).expo = {
  EventEmitter: class MockEventEmitter {
    addListener(_: string, __: (...args: unknown[]) => void) {
      return { remove: () => undefined };
    }
    removeAllListeners(_: string) {
      return undefined;
    }
    emit(_: string, ...__: unknown[]) {
      return undefined;
    }
  },
  modules: {},
};

import { afterEach, vi } from "vitest";
import * as React from "react";
import { createRequire } from "node:module";
import reactNativeStub, {
  hideMockKeyboard as hideStubKeyboard,
  isMockKeyboardVisible as isStubKeyboardVisible,
  resetMockKeyboard as resetStubKeyboard,
  showMockKeyboard as showStubKeyboard,
} from "./test-stubs/react-native";

// The soft-keyboard controls live on the react-native stub; suites reach them
// from here alongside the other mock controls. These are thin wrappers rather
// than a plain `export { ... }` re-export: a re-exported binding arrives as
// undefined in suites that import this setup file.
/** Simulate the soft keyboard opening, so dismissal affordances arm. */
export function showMockKeyboard(): void {
  showStubKeyboard();
}
/** Simulate the soft keyboard closing. */
export function hideMockKeyboard(): void {
  hideStubKeyboard();
}
/** Whether the simulated soft keyboard is currently on screen. */
export function isMockKeyboardVisible(): boolean {
  return isStubKeyboardVisible();
}

// Simulated keyboard state is per-test: reset it after each one so a suite
// that opens the keyboard can't leak that into the next test.
afterEach(() => {
  resetStubKeyboard();
});

type ChildrenOnly = React.PropsWithChildren<unknown>;
const passthrough = ({ children }: ChildrenOnly): React.ReactNode =>
  children ?? null;
const nullComponent = (): null => null;
type ProtectedProps = React.PropsWithChildren<{ guard?: boolean }>;
// expo-router's `<Stack.Protected guard={...}>` / `<Tabs.Protected>`: render the
// children only when the guard passes, so route-guard regressions surface as a
// missing screen instead of silently rendering everything.
const protectedPassthrough = ({ guard, children }: ProtectedProps): React.ReactNode =>
  guard === false ? null : (children ?? null);

const reactActWarning = /not wrapped in act\(\.\.\.\)/i;

const asyncReactAct = React.act as unknown as (
  callback: () => Promise<void>,
) => Promise<void>;
const req = createRequire(import.meta.url);
type CachedModule = {
  id: string;
  filename: string;
  loaded: boolean;
  exports: unknown;
  children: unknown[];
  paths: string[];
};
function installCachedModule(specifier: string, exportsValue: unknown): void {
  try {
    const resolved = req.resolve(specifier);
    const cache = req.cache as Record<string, CachedModule>;
    cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports: exportsValue,
      children: [],
      paths: [],
    };
  } catch {
    // Specifier isn't installed; nothing to short-circuit.
  }
}
installCachedModule("react-native", {
  __esModule: true,
  ...reactNativeStub,
  default: reactNativeStub,
});

const mockSearchParams: { current: Record<string, string | undefined> } = {
  current: {},
};
export function setMockSearchParams(
  params: Record<string, string | undefined>,
): void {
  mockSearchParams.current = { ...params };
}

// Mutable data slice that drives the mocked `@workspace/api-client-react`
// hooks below (useCases / useCase / useInvoices / useInvoice). Tests seed the
// canonical cases/invoices they care about via `setMockAppState({ cases,
// invoices })`; everything else stays empty. `resetMockAppState()` runs
// between tests so overrides don't leak across files.
type MockAppOverrides = Record<string, unknown>;
const mockAppOverrides: { current: MockAppOverrides } = { current: {} };
export const mockPreCreateItemParams: {
  calls: Array<{ labOrganizationId: string; providerOrganizationId?: string; doctorName?: string }>;
} = { calls: [] };

const mockEmptyRows: unknown[] = [];
const mockCasesPageRows = new Map<string, unknown[]>();
const mockPagedInvoiceLoadedCounts = new Map<string, number>();
export function setMockAppState(overrides: MockAppOverrides): void {
  mockAppOverrides.current = { ...mockAppOverrides.current, ...overrides };
}
export function resetMockAppState(): void {
  mockAppOverrides.current = {};
  mockPreCreateItemParams.calls = [];
  mockProviderOrganizationId.current = null;
  mockUseCasesParams.calls = [];
  mockPagedInvoiceParams.calls = [];
  mockStatementSummaryLabIds.calls = [];
  mockDoctorDirectoryParams.calls = [];
  mockCasesPageRows.clear();
  mockPagedInvoiceLoadedCounts.clear();
}

// Params passed to the mocked `useCases` hook, in render order. `mock`-prefixed
// so Vitest allows referencing it inside the vi.mock factory below.
export const mockUseCasesParams: { calls: unknown[] } = { calls: [] };
export const mockPagedInvoiceParams: { calls: unknown[] } = { calls: [] };
export const mockStatementSummaryLabIds: { calls: unknown[] } = { calls: [] };
export const mockDoctorDirectoryParams: { calls: unknown[] } = { calls: [] };
export const mockQueryCacheListeners = new Set<(event: unknown) => void>();
/** Emit the cache event React Query publishes when a key is invalidated. */
export function emitMockCacheInvalidate(rootKey: string): void {
  for (const listener of [...mockQueryCacheListeners]) {
    listener({ type: "updated", action: { type: "invalidate" }, query: { queryKey: [rootKey] } });
  }
}
export const mockInvalidateQueries = vi.fn(async (..._args: unknown[]) => undefined);

export const mockProviderOrganizationId: { current: string | null } = {
  current: null,
};

type ReceiptQueryClient = {
  refetchQueries: (filters?: { queryKey?: unknown[] }) => Promise<unknown>;
  setQueryData: (...args: unknown[]) => unknown;
};
/** Params from the most recent `useCases()` render. */
export function lastUseCasesParams(): unknown {
  return mockUseCasesParams.calls[mockUseCasesParams.calls.length - 1];
}

// Stable mutation spies so tests can assert calls (a fresh vi.fn() per render
// would be unobservable). `mock`-prefixed so Vitest allows them in the factory.
export const mockUpdateCaseMutateAsync = vi.fn(async () => ({ ok: true, data: null }));
// Stable create-case spy so doctor-confirmation tests can (a) assert the exact
// payload re-submitted after "use existing doctor" / "create as new doctor" and
// (b) inject a 409 DOCTOR_CONFIRMATION_REQUIRED via `.mockImplementationOnce()`.
// Default is a successful create returning a stub id.
export const mockCreateCaseMutateAsync = vi.fn(async (_vars?: unknown) => ({
  ok: true,
  data: { id: "test-mock-case-id" },
}));

export const mockGenerateInvoiceForCaseMutateAsync = vi.fn(
  async (_vars?: unknown) => ({ ok: true, data: null }),
);
export const mockAddCaseNoteMutateAsync = vi.fn(async () => ({ ok: true, data: null }));
export const mockDeleteAttachmentMutateAsync = vi.fn(async () => ({ ok: true, data: null }));
export const mockEmailInvoiceMutateAsync = vi.fn(async () => ({ ok: true, data: null }));
export const mockUpdateInvoiceMutateAsync = vi.fn(async () => ({ ok: true, data: null }));
export const mockAddCaseRestorationMutateAsync = vi.fn(async () => ({ ok: true, data: null }));
export const mockUpdateCaseRestorationMutateAsync = vi.fn(async () => undefined);
export const mockCreateAiMemoryMutateAsync = vi.fn(async () => ({ ok: true, data: null }));
export const mockUpdateAiMemoryMutateAsync = vi.fn(async () => ({ ok: true, data: null }));
export const mockDeleteAiMemoryMutateAsync = vi.fn(async () => undefined);
export const mockApproveAiMemoryCandidateMutateAsync = vi.fn(async () => ({ ok: true, data: null }));
export const mockRejectAiMemoryCandidateMutateAsync = vi.fn(async () => ({ ok: true, data: null }));
export const mockSearchDoctors = vi.fn(async (_params: unknown) => ({
  ok: true,
  data: { entries: [] as unknown[] },
}));
export const mockMergeDoctorsMutate = vi.fn();
export const mockGetCaseDoctorCandidates = vi.fn(async (_caseId: string, _params?: unknown): Promise<any> => ({
  ok: true, data: { assignment: null, entries: [], total: 0, nextOffset: null },
}));
export const mockReassignCaseDoctorMutateAsync = vi.fn(async (_variables: unknown): Promise<any> => {
  throw new Error("Test must provide a case-only reassignment response");
});
export const mockUndoCaseDoctorReassignment = vi.fn(async (_caseId: string, _auditId: string): Promise<any> => {
  throw new Error("Test must provide a case-only undo response");
});
const mockPreviewDoctorMergeReset = vi.fn();

// Mutable handler for the mocked `resilientFetch`. The default returns
// `{ data: null }` (preserves the previous behaviour). Tests that need
// `/api/legacy/cases/:id` to return a hydrated case override this.
type FetchHandler = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response>;
const defaultFetchHandler: FetchHandler = () =>
  new Response(JSON.stringify({ data: null }), { status: 200 });
const fetchHandler: { current: FetchHandler } = { current: defaultFetchHandler };
export function setMockFetchHandler(handler: FetchHandler): void {
  fetchHandler.current = handler;
}
export function resetMockFetchHandler(): void {
  fetchHandler.current = defaultFetchHandler;
}

// Mutable handler for the mocked `chunkedUploadCaseMedia` / `uploadCaseMedia`.
// Defaults to a successful upload so screens that incidentally trigger an
// upload during a smoke test don't surface a failure toast. Caller tests that
// exercise the photo-attach failure path override this to return
// `{ ok: false }` and then assert the user-visible "Upload Failed" alert.
type UploadResult = { ok: true; url: string } | { ok: false; error?: string };
type UploadHandler = (
  uri: string,
  name: string,
  mimeType: string,
) => UploadResult | Promise<UploadResult>;
const defaultUploadHandler: UploadHandler = () => ({
  ok: true,
  url: "/uploads/case-media/test.jpg",
});
const uploadHandler: { current: UploadHandler } = {
  current: defaultUploadHandler,
};
export function setMockUploadHandler(handler: UploadHandler): void {
  uploadHandler.current = handler;
}
export function resetMockUploadHandler(): void {
  uploadHandler.current = defaultUploadHandler;
}

type StackComponent = React.FC<ChildrenOnly> & {
  Screen: React.FC<ChildrenOnly>;
  Protected: React.FC<ProtectedProps>;
};
const StackImpl = passthrough as StackComponent;
StackImpl.Screen = passthrough;
StackImpl.Protected = protectedPassthrough;

// Errors from the focus callback intentionally propagate — that's the
// class of regression the smoke tests are here to catch.
type FocusEffectCallback = () => void | (() => void);
let focusEffectEnabled = true;
export function setFocusEffectEnabled(enabled: boolean): void {
  focusEffectEnabled = enabled;
}

// Cleanups returned by focus-effect callbacks are the "on blur" side of
// useFocusEffect. The real navigator runs them when the screen loses focus;
// this mock never does. Tests that need to assert blur behavior (e.g. the
// Cases reset-on-leave effect) drive it explicitly via runFocusEffectCleanup().
const focusEffectCleanups: Array<() => void> = [];
const focusCallbacksWithoutCleanup = new WeakSet<FocusEffectCallback>();
const deferredFocusEffect = (cb: FocusEffectCallback): void => {
  React.useEffect(() => {
    if (!focusEffectEnabled) return;
    if (focusCallbacksWithoutCleanup.has(cb)) return;
    queueMicrotask(() => {
      const cleanup = cb();
      if (typeof cleanup === "function") {
        focusEffectCleanups.push(cleanup);
      } else {
        focusCallbacksWithoutCleanup.add(cb);
      }
    });
  });
};

// Run exactly one focus-effect cleanup (a single simulated blur) and discard
// any others queued by intermediate re-renders. Cleanups read live module
// state, so running the most recent one is equivalent to a single blur.
export function runFocusEffectCleanup(): void {
  const cleanup = focusEffectCleanups.pop();
  focusEffectCleanups.length = 0;
  if (cleanup) cleanup();
}

vi.mock("expo-router", () => {
  const router = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    canGoBack: () => false,
    setParams: vi.fn(),
    navigate: vi.fn(),
    dismiss: vi.fn(),
    dismissTo: vi.fn(),
    dismissAll: vi.fn(),
  };
  const Tabs = Object.assign(passthrough, {
    Screen: passthrough,
    Protected: protectedPassthrough,
  });
  return {
    Stack: StackImpl,
    Link: passthrough,
    Redirect: nullComponent,
    Slot: passthrough,
    Tabs,
    useRouter: () => router,
    router,
    useLocalSearchParams: () => mockSearchParams.current,
    useGlobalSearchParams: () => mockSearchParams.current,
    useSegments: () => [],
    usePathname: () => "/",
    useFocusEffect: deferredFocusEffect,
    useNavigation: () => ({}),
  };
});

vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
  useNavigation: () => ({}),
  usePreventRemove: () => {},
  useRoute: () => ({ params: {} }),
  useFocusEffect: deferredFocusEffect,
  NavigationContainer: passthrough,
}));

vi.mock("@expo/vector-icons", () => {
  // `testID` is forwarded so screens can mark meaningful icons (e.g. the
  // "has media" paperclip on an exception row) and assert on them.
  const Icon = ({ name, testID }: { name?: string; testID?: string }) =>
    React.createElement("Icon", { name, testID });
  return {
    Ionicons: Icon,
    Feather: Icon,
    MaterialCommunityIcons: Icon,
    MaterialIcons: Icon,
    FontAwesome: Icon,
    FontAwesome5: Icon,
    AntDesign: Icon,
    Entypo: Icon,
  };
});

vi.mock("expo-image", () => ({
  Image: ({
    source,
    testID,
    ...props
  }: {
    source?: unknown;
    testID?: string;
    [key: string]: unknown;
  }) => React.createElement("Image", { source, testID, ...props }),
}));

// The case lightboxes use native gesture/worklet drivers. In the RN test
// renderer expose gesture callbacks on the host view so tests can exercise
// pinch, pan and double-tap math without a native UI thread.
vi.mock("react-native-gesture-handler", () => {
  const makeGesture = () => {
    const gesture: Record<string, any> = {};
    for (const method of ["onStart", "onUpdate", "onEnd"]) {
      gesture[method] = (callback: (...args: any[]) => void) => {
        gesture[method.slice(2).toLowerCase()] = callback;
        return gesture;
      };
    }
    gesture.maxPointers = () => gesture;
    gesture.numberOfTaps = () => gesture;
    return gesture;
  };
  return {
    GestureHandlerRootView: ({ children, ...props }: any) => React.createElement("View", props, children),
    GestureDetector: ({ children, gesture }: any) =>
      React.createElement("View", { testID: "zoom-gesture", gesture }, children),
    Gesture: {
      Pinch: makeGesture,
      Pan: makeGesture,
      Tap: makeGesture,
      Simultaneous: (...gestures: any[]) => gestures,
    },
  };
});

export const mockZoomSharedValues: Array<{ value: number }> = [];

vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children, ...props }: any) => React.createElement("View", props, children) },
  useSharedValue: (value: number) => {
    const ref = React.useRef<{ value: number } | null>(null);
    if (!ref.current) {
      ref.current = { value };
      mockZoomSharedValues.push(ref.current);
    }
    return ref.current;
  },
  useAnimatedStyle: (callback: () => unknown) => callback(),
  withTiming: (value: number) => value,
}));

// MockCamera captures each mounted <Camera codeScanner={...}> so tests can
// trigger simulated barcode scans via triggerMockBarcodeScan(data). This
// mocks react-native-vision-camera (the scan engine), but keeps the exact
// same triggerMockBarcodeScan(data, testID) signature the screens' tests
// already use, translating the simple {data} payload into a one-code
// onCodeScanned(codes, frame) call — matching the shape lib/vision-camera-codes
// .ts's codesToBarcodeCandidates() expects.
//
// CodeScanners are stored in two ways:
//   1. By testID (preferred) — keyed in _mockCodeScannerByTestId so multiple
//      Cameras with different testIDs can coexist (e.g. the dashboard scan
//      modal vs. batch-locate vs. the AI-reader barcode-assignment screen).
//   2. Legacy unnamed fallback — _mockCodeScannerLegacy, overwritten by the
//      last MockCamera that rendered without a testID.
interface MockScannedCode {
  type: string;
  value?: string;
  frame?: { x: number; y: number; width: number; height: number };
  corners?: Array<{ x: number; y: number }>;
}

interface MockCodeScanner {
  onCodeScanned: (codes: MockScannedCode[], frame: { width: number; height: number }) => void;
}

const _mockCodeScannerByTestId = new Map<string, MockCodeScanner | undefined>();
let _mockCodeScannerLegacy: MockCodeScanner | undefined;

function MockCamera({
  codeScanner,
  testID,
}: {
  codeScanner?: MockCodeScanner;
  testID?: string;
}) {
  if (testID !== undefined) {
    _mockCodeScannerByTestId.set(testID, codeScanner);
  } else {
    _mockCodeScannerLegacy = codeScanner;
  }
  return null;
}

export type MockBarcodeScanInput =
  | string
  | {
      data: string;
      frame?: { x: number; y: number; width: number; height: number };
      corners?: Array<{ x: number; y: number }>;
      scannerFrame?: { width: number; height: number };
    };

/** Call from tests to fire a fake barcode scan event.
 * @param data     One barcode or multiple barcodes from the same native callback.
 * @param testID   The testID of the target Camera (default: "scan-barcode-scanner").
 *                 Pass undefined to target the legacy unnamed callback instead.
 * Throws if no matching Camera is mounted with that testID. No-ops (like the
 * real onCodeScanned) if that Camera's codeScanner is currently undefined
 * (e.g. paused mid-lookup). */
export function triggerMockBarcodeScan(
  data: MockBarcodeScanInput | MockBarcodeScanInput[],
  testID: string | null = "scan-barcode-scanner",
): void {
  let scanner: MockCodeScanner | undefined;
  if (testID !== null) {
    if (!_mockCodeScannerByTestId.has(testID)) {
      throw new Error(
        `triggerMockBarcodeScan: no Camera with testID="${testID}" is mounted.`,
      );
    }
    scanner = _mockCodeScannerByTestId.get(testID);
  } else {
    if (!_mockCodeScannerLegacy) {
      throw new Error(
        "triggerMockBarcodeScan: no unnamed Camera with a codeScanner is mounted.",
      );
    }
    scanner = _mockCodeScannerLegacy;
  }
  const inputs = Array.isArray(data) ? data : [data];
  const scannerFrame =
    inputs.find(
      (input): input is Exclude<MockBarcodeScanInput, string> =>
        typeof input !== "string" && !!input.scannerFrame,
    )?.scannerFrame ?? { width: 1920, height: 1080 };
  const codes = inputs.map<MockScannedCode>((input) =>
    typeof input === "string"
      ? {
          type: "qr",
          value: input,
          frame: {
            x: scannerFrame.width * 0.45,
            y: scannerFrame.height * 0.45,
            width: scannerFrame.width * 0.1,
            height: scannerFrame.height * 0.1,
          },
        }
      : {
          type: "qr",
          value: input.data,
          frame:
            input.frame ??
            {
              x: scannerFrame.width * 0.45,
              y: scannerFrame.height * 0.45,
              width: scannerFrame.width * 0.1,
              height: scannerFrame.height * 0.1,
            },
          corners: input.corners,
        },
  );
  scanner?.onCodeScanned(codes, scannerFrame);
}

vi.mock("react-native-vision-camera", () => ({
  Camera: MockCamera,
  useCameraDevice: () => ({ id: "back", position: "back", hasTorch: true }),
  useCameraPermission: () => ({
    hasPermission: true,
    requestPermission: vi.fn(async () => true),
  }),
  useCodeScanner: (config: MockCodeScanner & Record<string, unknown>) => config,
}));

vi.mock("expo-haptics", () => ({
  notificationAsync: vi.fn(),
  impactAsync: vi.fn(),
  selectionAsync: vi.fn(),
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
}));

vi.mock("expo-print", () => ({
  printToFileAsync: vi.fn(async () => ({ uri: "file:///tmp/test.pdf", base64: "dGVzdA==" })),
}));

vi.mock("expo-sharing", () => ({
  shareAsync: vi.fn(),
  isAvailableAsync: vi.fn(async () => true),
}));

// Global fallback for expo-media-library so any test that transitively
// imports the long-press save helpers doesn't crash with
// "createPermissionHook is not a function" from the real native module.
// Files that need to assert on specific save-to-device outcomes still
// declare their own `vi.mock("expo-media-library", ...)`, which takes
// precedence for that file.
vi.mock("expo-media-library", () => ({
  requestPermissionsAsync: vi.fn(async () => ({ granted: true, status: "granted" })),
  saveToLibraryAsync: vi.fn(async () => undefined),
}));

// Global fallback so any test that transitively imports expo-asset/expo-image
// (which read `Constants.executionEnvironment` at module-load time) doesn't
// crash with "Cannot read properties of undefined (reading 'EXDevLauncher')".
// Individual test files that need specific expoConfig values still declare
// their own `vi.mock("expo-constants", ...)`, which takes precedence for
// that file.
vi.mock("expo-constants", () => ({
  default: {
    expoConfig: { name: "LabTrax", slug: "labtrax", version: "1.0.0" },
    executionEnvironment: "standalone",
  },
}));

// Global fallback for expo-av so any test that transitively renders a
// screen importing `Audio` from expo-av (e.g. via CaseExceptionSheet) doesn't
// crash with "createPermissionHook is not a function" from the real native
// module. Files that need to assert on specific Audio calls still declare
// their own `vi.mock("expo-av", ...)`, which takes precedence for that file.
vi.mock("expo-av", () => ({
  Video: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) =>
    React.createElement("Video", props, children),
  ResizeMode: { CONTAIN: "contain" },
  Audio: {
    requestPermissionsAsync: vi.fn(async () => ({ granted: true, status: "granted" })),
    setAudioModeAsync: vi.fn(async () => undefined),
    Recording: {
      createAsync: vi.fn(async () => ({
        recording: { stopAndUnloadAsync: vi.fn(), getURI: () => "file:///tmp/rec.m4a" },
      })),
    },
    RecordingOptionsPresets: { HIGH_QUALITY: {} },
    Sound: {
      createAsync: vi.fn(async () => ({
        sound: { playAsync: vi.fn(), unloadAsync: vi.fn() },
        status: {},
      })),
    },
  },
}));

vi.mock("react-native-compressor", () => ({
  clearCache: vi.fn(async () => "cleared"),
  createVideoThumbnail: vi.fn(async () => ({
    path: "file:///tmp/video-thumbnail.jpg",
    size: 100,
    mime: "image/jpeg",
    width: 320,
    height: 180,
  })),
  Video: { compress: vi.fn(async (uri: string) => uri) },
}));

vi.mock("expo-image-picker", () => ({
  getCameraPermissionsAsync: vi.fn(async () => ({ granted: true })),
  requestCameraPermissionsAsync: vi.fn(async () => ({ status: "granted" })),
  requestMediaLibraryPermissionsAsync: vi.fn(async () => ({ status: "granted" })),
  launchCameraAsync: vi.fn(async () => ({ canceled: true, assets: [] })),
  launchImageLibraryAsync: vi.fn(async () => ({ canceled: true, assets: [] })),
  MediaTypeOptions: { Images: "Images", Videos: "Videos", All: "All" },
}));

vi.mock("expo-document-picker", () => ({
  getDocumentAsync: vi.fn(async () => ({ canceled: true, assets: [] })),
}));

vi.mock("expo-image-manipulator", () => ({
  manipulateAsync: vi.fn(async (uri: string) => ({ uri })),
  SaveFormat: { JPEG: "jpeg", PNG: "png" },
}));

vi.mock("expo-file-system", () => ({
  documentDirectory: "file:///tmp/",
  cacheDirectory: "file:///tmp/cache/",
  getInfoAsync: vi.fn(async () => ({ exists: false })),
  readAsStringAsync: vi.fn(async () => ""),
  writeAsStringAsync: vi.fn(async () => undefined),
  deleteAsync: vi.fn(async () => undefined),
  EncodingType: { UTF8: "utf8", Base64: "base64" },
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

vi.mock("expo-linear-gradient", () => ({ LinearGradient: passthrough }));
vi.mock("expo-blur", () => ({ BlurView: passthrough }));
vi.mock("expo-glass-effect", () => ({ GlassView: passthrough }));
vi.mock("expo-symbols", () => ({ SymbolView: nullComponent }));
vi.mock("expo-status-bar", () => ({ StatusBar: nullComponent }));

vi.mock("expo-share-intent", () => ({
  useShareIntent: () => ({
    hasShareIntent: false,
    shareIntent: null,
    resetShareIntent: vi.fn(),
  }),
}));

vi.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: vi.fn(),
  hideAsync: vi.fn(),
}));

vi.mock("expo-local-authentication", () => ({
  hasHardwareAsync: vi.fn(async () => false),
  isEnrolledAsync: vi.fn(async () => false),
  authenticateAsync: vi.fn(async () => ({ success: true })),
}));

export const mockInitPaymentSheet = vi.fn(async () => ({ error: undefined }));
export const mockPresentPaymentSheet = vi.fn(async () => ({ error: undefined }));
vi.mock("@stripe/stripe-react-native", () => ({
  AddressCollectionMode: { AUTOMATIC: "automatic", NEVER: "never", FULL: "full" },
  CollectionMode: { AUTOMATIC: "automatic", NEVER: "never", ALWAYS: "always" },
  initStripe: vi.fn(async () => undefined),
  useStripe: () => ({
    initPaymentSheet: mockInitPaymentSheet,
    presentPaymentSheet: mockPresentPaymentSheet,
  }),
}));

vi.mock("expo/fetch", () => ({
  // Route through the test fetchHandler so screen-driven tests can
  // intercept calls made via expo/fetch (e.g. ScanScreen.sendToAI).
  fetch: vi.fn(async (url: any, init?: RequestInit) => {
    const u = typeof url === "string" ? url : String(url);
    return fetchHandler.current(u, init);
  }),
}));

vi.mock("@react-native-async-storage/async-storage", () => {
  const store = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (k: string) => store.get(k) ?? null),
      setItem: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
      removeItem: vi.fn(async (k: string) => {
        store.delete(k);
      }),
      clear: vi.fn(async () => {
        store.clear();
      }),
      getAllKeys: vi.fn(async () => Array.from(store.keys())),
      multiGet: vi.fn(async (keys: string[]) =>
        keys.map((k) => [k, store.get(k) ?? null] as [string, string | null]),
      ),
      multiSet: vi.fn(async (pairs: [string, string][]) => {
        for (const [k, v] of pairs) store.set(k, v);
      }),
      multiRemove: vi.fn(async (keys: string[]) => {
        for (const k of keys) store.delete(k);
      }),
    },
  };
});

vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: passthrough,
  SafeAreaView: passthrough,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 375, height: 812 }),
}));

vi.mock("react-native-keyboard-controller", () => ({
  KeyboardProvider: passthrough,
  KeyboardAvoidingView: passthrough,
  KeyboardStickyView: (props: Record<string, unknown>) =>
    React.createElement((reactNativeStub as any).View, props),
  KeyboardAwareScrollView: (props: Record<string, unknown>) =>
    React.createElement((reactNativeStub as any).ScrollView, props),
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    currentUser: "tester",
    userType: "lab",
    registeredUsers: [],
    isAuthenticated: true,
    accessToken: null,
    login: vi.fn(),
    logout: vi.fn(),
  }),
  AuthProvider: passthrough,
}));

// Mirrors the real throwIfResNotOk: screens show the server's own `message`
// (or `error`) text, falling back to the status text. Kept as a named helper
// so the mock below and any future caller share one implementation.
async function mockThrowIfResNotOk(res: Response): Promise<void> {
  if (res.ok) return;
  const fallback = res.statusText || "Request failed. Please try again.";
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(fallback);
  }
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const message = typeof record.message === "string" && record.message.trim() ? record.message : null;
  const error = typeof record.error === "string" && record.error.trim() ? record.error : null;
  throw new Error(message ?? error ?? fallback);
}

vi.mock("@/lib/query-client", () => ({
  getApiUrl: () => "http://localhost/",
  getAccessToken: vi.fn(() => null as string | null),
  waitForHydration: vi.fn(async () => undefined),
  refreshAndGetAccessToken: vi.fn(async () => null as string | null),
  // Multipart senders (messenger, provider lab-inbox) build their own XHR and
  // read these directly, so the stub has to answer them the way the real
  // module would for a signed-in native client.
  loadTokens: vi.fn(async () => undefined),
  getCsrfToken: vi.fn(() => null as string | null),
  // Active provider practice. Kept as a real module-level value (not a bare
  // spy) so tests can assert what the request layer would actually stamp on
  // provider requests after a practice switch.
  setProviderOrganizationId: vi.fn((id: string | null) => {
    mockProviderOrganizationId.current = id;
  }),
  getProviderOrganizationId: vi.fn(() => mockProviderOrganizationId.current),
  resilientFetch: vi.fn(
    async (url: string, init?: RequestInit) => fetchHandler.current(url, init),
  ),
  // This factory *is* the module in tests, so a screen that imports this
  // helper receives `undefined` and fails at the call site unless it is
  // listed here.
  throwIfResNotOk: vi.fn(mockThrowIfResNotOk),
  // Mirrors the real apiRequest: routes through the same mocked fetchHandler
  // and throws on a non-ok response. Used by useCaseRealtimeUpdates to mint a
  // WS ticket; the default fetchHandler's `{ data: null }` body means no
  // ticket is ever found, so the hook quietly no-ops in tests that don't set
  // up a ws-ticket response (never constructs a real `WebSocket`).
  apiRequest: vi.fn(async (method: string, url: string, data?: unknown) => {
    const res = await fetchHandler.current(url, {
      method,
      headers: data ? { "Content-Type": "application/json" } : {},
      body: data ? JSON.stringify(data) : undefined,
    });
    await mockThrowIfResNotOk(res);
    return res;
  }),
  chunkedUploadCaseMedia: vi.fn(
    async (uri: string, name: string, mimeType: string) =>
      uploadHandler.current(uri, name, mimeType),
  ),
  uploadCaseMedia: vi.fn(
    async (uri: string, name: string, mimeType: string) =>
      uploadHandler.current(uri, name, mimeType),
  ),
  logDebugEvent: vi.fn(),
  queryClient: {
    clear: vi.fn(),
    invalidateQueries: vi.fn(async () => undefined),
  },
}));

vi.mock("@/components/ReadOnlyToothChart", () => ({
  ReadOnlyToothChart: nullComponent,
}));

vi.mock("@/components/ToothChart", () => ({
  ToothChart: nullComponent,
}));

vi.mock("@/components/ToothActionSheet", () => ({
  ToothActionSheet: nullComponent,
}));

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(async () => undefined) }));

vi.mock("react-native-webview", () => ({
  WebView: passthrough,
  default: passthrough,
}));

vi.mock("react-native-qrcode-svg", () => ({
  default: nullComponent,
}));

// react-native-svg is native-backed: its CommonJS build reads RN internals
// (`Touchable.Mixin`, `processColor`, `TurboModuleRegistry`) at module scope,
// which the react-native stub does not carry, so any screen that draws a chart
// or captures a signature fails to load rather than fails a test. Screens only
// need the element tree to exist, so each element is a plain host that forwards
// its props — testIDs and text children stay assertable.
vi.mock("react-native-svg", () => {
  const svgHost = (name: string) => {
    const SvgElement = ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement(name, props, children);
    SvgElement.displayName = name;
    return SvgElement;
  };
  const Svg = svgHost("Svg");
  return {
    __esModule: true,
    default: Svg,
    Svg,
    G: svgHost("G"),
    Path: svgHost("Path"),
    Circle: svgHost("Circle"),
    Rect: svgHost("Rect"),
    Line: svgHost("Line"),
    Text: svgHost("SvgText"),
    TSpan: svgHost("TSpan"),
    Polygon: svgHost("Polygon"),
    Polyline: svgHost("Polyline"),
    Ellipse: svgHost("Ellipse"),
    Defs: svgHost("Defs"),
    LinearGradient: svgHost("LinearGradient"),
    Stop: svgHost("Stop"),
    ClipPath: svgHost("ClipPath"),
    Mask: svgHost("Mask"),
    Use: svgHost("Use"),
  };
});

// ── @tanstack/react-query: stub useQuery so CaseDetailScreen's auth/me call
// doesn't require a real QueryClientProvider. Defaults to empty data
// (canEdit=false); tests that need edit permission seed memberships via
// `setMockAppState({ meMemberships: [{ organizationId, role, status }] })`.
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: vi.fn((options?: {
      queryKey?: unknown[];
      [key: string]: unknown;
    }) => {
      const key = Array.isArray(options?.queryKey) ? options.queryKey[0] : null;
        const segment = Array.isArray(options?.queryKey) ? options.queryKey[1] : null;
      if (
        key === "doctors" &&
        mockAppOverrides.current.liveDoctorSearchQueries
      ) {
        return actual.useQuery(options as any);
      }
      if (key === "receive-payments" && segment === "payment-session") {
        activeReceiptQueryClient = actual.useQueryClient() as ReceiptQueryClient;
        return actual.useQuery(options as any);
      }
      const isMeQuery = key === "auth-me";
      let data: unknown;
      if (isMeQuery && mockAppOverrides.current.meMemberships !== undefined) {
        data = { memberships: mockAppOverrides.current.meMemberships };
      } else if (key === "statement-runs") {
        data = (mockAppOverrides.current.statementRuns as unknown[]) ?? [];
      } else if (key === "statement-account-summaries") {
        data =
          (mockAppOverrides.current.statementAccountSummaries as unknown[]) ?? [];
      } else if (key === "doctor-resolve") {
        // Drives the AI-reader "doctor not on file" resolution gate. Tests seed
        // the resolve result via `setMockAppState({ doctorResolve: {...} })`.
        data = mockAppOverrides.current.doctorResolve;
      } else if (key === "case-exceptions") {
        // The queue and the per-exception detail share the "case-exceptions"
        // prefix, so the second key segment picks which slice to serve. Tests
        // seed them via `setMockAppState({ caseExceptions / caseExceptionDetail })`.
        const segment = Array.isArray(options?.queryKey) ? options.queryKey[1] : null;
        data =
          segment === "detail"
            ? mockAppOverrides.current.caseExceptionDetail
            : mockAppOverrides.current.caseExceptions;
      } else if (key === "cases" && segment === "saved-views") {
        data = (mockAppOverrides.current.savedCaseViews as unknown[]) ?? [];
      } else if (key === "provider-case") {
        // Drives the provider case detail screen. Tests seed the case via
        // `setMockAppState({ providerCase: {...} })`.
        data = mockAppOverrides.current.providerCase;
      } else if (key === "receive-payments") {
        const segment = Array.isArray(options?.queryKey) ? options.queryKey[1] : null;
        if (segment === "accounts" || segment === "invoices") {
          data = mockAppOverrides.current.receivePaymentsInvoices;
        } else if (segment === "eligible-accounts") {
          data = mockAppOverrides.current.receivePaymentsEligibleAccounts;
        } else if (segment === "invoice-accounts") {
          data = mockAppOverrides.current.receivePaymentsInvoiceAccounts;
        } else if (segment === "statements") {
          data = mockAppOverrides.current.receivePaymentsStatements;
        } else if (segment === "statement-context") {
          const statementId = Array.isArray(options?.queryKey) ? options.queryKey[2] : null;
          const contexts = mockAppOverrides.current.receivePaymentsStatementContexts as
            | Record<string, unknown>
            | undefined;
          data = typeof statementId === "string" ? contexts?.[statementId] : undefined;
        } else if (segment === "open") {
        const providerId = Array.isArray(options?.queryKey) ? options.queryKey[2] : null;
        const byProvider = mockAppOverrides.current.receivePaymentsSavedCards as
          | Record<string, unknown>
          | undefined;
          data = typeof providerId === "string" ? byProvider?.[providerId] : undefined;
        }
      } else if (key === "provider-lab-card") {
        const providerId = Array.isArray(options?.queryKey) ? options.queryKey[2] : null;
        const byProvider = mockAppOverrides.current.receivePaymentsSavedCards as
          | Record<string, unknown>
          | undefined;
        data = typeof providerId === "string" ? byProvider?.[providerId] : undefined;
      } else if (key === "billing" && options?.queryKey?.[1] === "card-config") {
        data = mockAppOverrides.current.receivePaymentsCardConfig;
      } else if (key === "finance") {
        const segment = Array.isArray(options?.queryKey) ? options.queryKey[1] : null;
        if (segment === "bills") data = mockAppOverrides.current.apBills;
        else if (segment === "bill") data = mockAppOverrides.current.apBillDetail;
        else if (segment === "vendors") data = mockAppOverrides.current.apVendors;
        else if (segment === "categories") data = mockAppOverrides.current.apCategories;
        else if (segment === "pay-bills") data = mockAppOverrides.current.apPayBills;
        else if (segment === "ap-aging") data = mockAppOverrides.current.apAging;
        else if (segment === "ar-aging") data = mockAppOverrides.current.arAging;
        else if (segment === "ap-summary") data = mockAppOverrides.current.apVendorSummary;
      } else if (key === "finance-accounts") {
        data = mockAppOverrides.current.apAccounts;
      } else if (key === "undeposited-funds-summary") {
        data = mockAppOverrides.current.undepositedFundsSummary;
      }
      return {
        data,
        isLoading:
          key === "case-exceptions"
            ? ((mockAppOverrides.current.caseExceptionsIsLoading as boolean | undefined) ?? false)
            : key === "receive-payments" && options?.queryKey?.[1] === "eligible-accounts"
              ? ((mockAppOverrides.current.receivePaymentsEligibleAccountsIsLoading as boolean | undefined) ?? false)
            : false,
        isError:
          key === "case-exceptions"
            ? ((mockAppOverrides.current.caseExceptionsIsError as boolean | undefined) ?? false)
            : key === "receive-payments" && options?.queryKey?.[1] === "eligible-accounts"
              ? ((mockAppOverrides.current.receivePaymentsEligibleAccountsIsError as boolean | undefined) ?? false)
            : false,
        isSuccess: key === "doctor-resolve" && data !== undefined,
        isFetching:
          key === "statement-runs"
            ? ((mockAppOverrides.current.statementRunsIsFetching as boolean | undefined) ?? false)
            : key === "statement-account-summaries"
              ? ((mockAppOverrides.current
                  .statementAccountSummariesIsFetching as boolean | undefined) ?? false)
            : false,
        refetch: vi.fn(async () => undefined),
      };
    }),
    useQueryClient: vi.fn(() => {
      // Tests that opt into live invoice queries (`liveInvoiceQueries`) render a
      // REAL QueryClientProvider, so a screen's invalidation has to reach that
      // client or the live `useInvoices` / `useInvoice` queries never refetch.
      // Every other test keeps the recording-only stub below.
      const liveClient = React.useContext(actual.QueryClientContext);
      const forwardTo =
        (mockAppOverrides.current.liveInvoiceQueries ||
          mockAppOverrides.current.liveDoctorSearchQueries) &&
        liveClient
          ? liveClient
          : null;
      return {
        invalidateQueries: async (...args: unknown[]) => {
          await mockInvalidateQueries(...args);
          if (!forwardTo) return undefined;
          return forwardTo.invalidateQueries(
            ...(args as Parameters<typeof forwardTo.invalidateQueries>),
          );
        },
        setQueryData: (...args: unknown[]) => forwardTo
          ? forwardTo.setQueryData(...(args as Parameters<typeof forwardTo.setQueryData>))
          : activeReceiptQueryClient?.setQueryData(...args),
        getQueryData: vi.fn(() => undefined),
        getQueryCache: () => ({
          subscribe: (listener: (event: unknown) => void) => {
            mockQueryCacheListeners.add(listener);
            return () => { mockQueryCacheListeners.delete(listener); };
          },
        }),
      };
    }),
    useMutation: vi.fn((options?: {
      mutationFn?: (...args: any[]) => unknown;
      onSuccess?: (...args: any[]) => unknown;
      onError?: (...args: any[]) => unknown;
      onSettled?: (...args: any[]) => unknown;
    }) => {
      const [isPending, setIsPending] = React.useState(false);
      const execute = async (variables: any, callOptions?: {
        onSuccess?: (...args: any[]) => unknown;
        onError?: (...args: any[]) => unknown;
        onSettled?: (...args: any[]) => unknown;
      }) => {
        setIsPending(true);
        let result: unknown;
        let failure: unknown;
        try {
          result = await options?.mutationFn?.(variables);
          await options?.onSuccess?.(result, variables);
          await callOptions?.onSuccess?.(result, variables);
          return result;
        } catch (error) {
          failure = error;
          await options?.onError?.(error, variables);
          await callOptions?.onError?.(error, variables);
          throw error;
        } finally {
          await options?.onSettled?.(result, failure, variables);
          await callOptions?.onSettled?.(result, failure, variables);
          setIsPending(false);
        }
      };
      const mutateAsync = (variables?: any, callOptions?: {
        onSuccess?: (...args: any[]) => unknown;
        onError?: (...args: any[]) => unknown;
        onSettled?: (...args: any[]) => unknown;
      }) => execute(variables, callOptions);
      return {
        isPending,
        mutate: (variables?: any, callOptions?: {
          onSuccess?: (...args: any[]) => unknown;
          onError?: (...args: any[]) => unknown;
          onSettled?: (...args: any[]) => unknown;
        }) => {
          void execute(variables, callOptions).catch(() => undefined);
        },
        mutateAsync,
      };
    }),
  };
});

// ── @workspace/api-client-react: mock React Query hooks so screens that use
// useCases / useCase / useInvoices / useInvoice don't need a QueryClientProvider.
// Hook data is driven by the same mockAppOverrides used for the AppContext mock.
vi.mock("@workspace/api-client-react", async () => {
  const providerSignupPlans = await import("../../lib/api-client-react/src/provider-signup-plans");
  const { refreshCaseDoctorQueries } = await import("../../lib/api-client-react/src/case-doctor-refresh");
  const {
    FINANCE_INVOICES_QUERY_KEY,
    FINANCE_STATEMENT_SUMMARIES_QUERY_KEY,
  } = await import("../../lib/api-client-react/src/finance-query-keys");
  // The invoice hooks below can opt into REAL React Query caching (see
  // `liveInvoiceQueries`), so tests can assert that a mutation's cache
  // invalidation actually refetches invoice totals. `vi.importActual` bypasses
  // the "@tanstack/react-query" mock above while resolving to the same module
  // instance its `...actual` re-exports come from, so the QueryClientProvider a
  // test renders is the same context this `useQuery` reads.
  const { useQuery: realUseQuery } = await vi.importActual<
    typeof import("@tanstack/react-query")
  >("@tanstack/react-query");

  // One filter for the paged invoice list, shared by the static mock and the
  // live-query branch below so the two cannot drift apart.
  const filterPagedInvoiceRows = (
    params?: Record<string, any>,
  ): Array<Record<string, any>> => {
    // Paged invoices read the seeded invoice fixture only. The copy matters:
    // the sort branch below sorts in place, and sorting the seeded array
    // itself would leak one test's ordering into the next render.
    let rows = [
      ...((mockAppOverrides.current.invoices as Array<Record<string, any>> | undefined) ?? []),
    ];
    if (params?.labOrganizationId) {
      rows = rows.filter((row) =>
        row.labOrganizationId == null || row.labOrganizationId === params.labOrganizationId,
      );
    }
    if (params?.practiceId) {
      rows = rows.filter((row) =>
        row.providerOrganizationId == null || row.providerOrganizationId === params.practiceId,
      );
    }
    if (params?.view === "open") {
      rows = rows.filter((row) => row.status === "open" || row.status === "partially_paid");
    } else if (params?.view === "outstanding") {
      const today = new Date().toISOString().slice(0, 10);
      rows = rows.filter((row) =>
        (row.status === "open" || row.status === "partially_paid") &&
        String(row.dueAt ?? row.dueDate ?? "").slice(0, 10) < today,
      );
    }
    const statuses = String(params?.status ?? "").split(",").filter(Boolean);
    if (statuses.length) {
      rows = rows.filter((row) => statuses.some((status) => {
        if (status === "zero_balance") return Number(row.balanceDue ?? row.total ?? 0) === 0;
        if (status === "frozen") return Boolean(row.frozen);
        return row.status === status || (status === "open" && row.status === "partially_paid");
      }));
    }
    const search = String(params?.search ?? "").trim().toLowerCase();
    if (search) {
      rows = rows.filter((row) => {
        const metadata = row.displayMetadataJson ?? row.displayMetadata ?? {};
        return [row.invoiceNumber, row.providerOrganization?.name, metadata.patientName, metadata.billTo]
          .some((value) => String(value ?? "").toLowerCase().includes(search));
      });
    }
    if (params?.doctorName) {
      rows = rows.filter((row) =>
        String((row.displayMetadataJson ?? row.displayMetadata ?? {}).billTo ?? "") === params.doctorName,
      );
    }
    if (params?.aiOnly) rows = rows.filter((row) => row.aiGenerated === true);
    if (params?.issuedFrom || params?.issuedTo) {
      rows = rows.filter((row) => {
        const source = row.issuedAt ?? row.createdAt;
        if (!source) return false;
        const time = new Date(source).getTime();
        return Number.isFinite(time)
          && (!params.issuedFrom || time >= new Date(params.issuedFrom).getTime())
          && (!params.issuedTo || time < new Date(params.issuedTo).getTime());
      });
    }
    if (params?.sortBy) {
      const direction = params.sortDirection === "asc" ? 1 : -1;
      rows.sort((a, b) => {
        const value = (row: Record<string, any>) => params.sortBy === "practice"
          ? String(row.providerOrganization?.name ?? "")
          : String(params.sortBy === "issued" ? row.issuedAt : (row.dueAt ?? row.dueDate ?? ""));
        return direction * value(a).localeCompare(value(b), undefined, { sensitivity: "base" });
      });
    }
    return rows;
  };
  return {
    ...providerSignupPlans,
    // Re-export the REAL shared AI-stream error contract (constants + mapping
    // helpers) so component tests exercise the exact production strings instead
    // of mock duplicates that could drift.
    ...(await vi.importActual<Record<string, unknown>>(
      "../../lib/api-client-react/src/ai-stream-errors",
    )),
    // Keep pure shared dashboard contracts real while generated data hooks stay
    // mocked, so desktop/mobile parity tests cannot drift behind the library.
    ...(await vi.importActual<Record<string, unknown>>(
      "../../lib/api-client-react/src/due-tomorrow-sort",
    )),
    ...(await vi.importActual<Record<string, unknown>>(
      "../../lib/api-client-react/src/invoice-filters",
    )),
    ...(await vi.importActual<Record<string, unknown>>(
      "../../lib/api-client-react/src/finance-query-keys",
    )),
    getToolCallLabel: (name?: string | null) => (name ? `Working: ${name}` : ""),
    ReceivePaymentsInputPaymentMethod: {
      card: "card",
      ach: "ach",
      check: "check",
      cash: "cash",
      other: "other",
    },
    getGetCatalogTreeQueryKey: (params?: { labOrganizationId?: string; includeInactive?: string }) => [
      "/api/catalog/tree",
      ...(params ? [params] : []),
    ],
    getGetPreCreateInvoiceItemsQueryKey: (params?: {
      labOrganizationId?: string;
      providerOrganizationId?: string;
      doctorName?: string;
    }) => ["/api/pricing/pre-create-items", ...(params ? [params] : [])],
    useGetPreCreateInvoiceItems: (params: {
      labOrganizationId: string;
      providerOrganizationId?: string;
      doctorName?: string;
    }) => {
      mockPreCreateItemParams.calls.push(params);
      const byContext = mockAppOverrides.current.preCreateInvoiceItemsByContext as
        Record<string, unknown[]> | undefined;
      const contextKey = [params.labOrganizationId, params.providerOrganizationId ?? "", params.doctorName ?? ""].join("|");
      const items = byContext ? byContext[contextKey] : mockAppOverrides.current.preCreateInvoiceItems;
      const catalogItems = mockAppOverrides.current.preCreateCatalogItems;
      return ({
      data:
        items !== undefined || catalogItems !== undefined
          ? {
              ok: true,
              data: { items: items ?? [], catalogItems },
            }
          : undefined,
      isLoading:
        (mockAppOverrides.current.preCreateInvoiceItemsIsLoading as
          | boolean
          | undefined) ?? false,
      isError:
        (mockAppOverrides.current.preCreateInvoiceItemsIsError as
          | boolean
          | undefined) ?? false,
      refetch: vi.fn(async () => undefined),
    });
    },
    useGetCatalogTree: (params?: { labOrganizationId?: string; includeInactive?: string }) => ({
      queryKey: ["/api/catalog/tree", params ?? {}],
      data: mockAppOverrides.current.catalogTree
        ? { ok: true, data: mockAppOverrides.current.catalogTree }
        : undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn(async () => undefined),
    }),
    useCases: (params?: unknown) => {
      // Record the params each render passes so tests can assert that a screen
      // pushes its search term to the SERVER rather than filtering only the
      // already-fetched page (the server caps un-searched list reads).
      mockUseCasesParams.calls.push(params);
      return {
        data: (mockAppOverrides.current.cases as unknown[]) ?? [],
        isLoading: false,
        isError: false,
        refetch: vi.fn(async () => undefined),
      };
    },
    useCasesOverview: () => {
      const o = mockAppOverrides.current.casesOverview as
        | { data?: unknown; isLoading?: boolean; isError?: boolean; refetch?: () => unknown }
        | undefined;
      return {
        data: o?.data ?? (o?.isLoading || o?.isError ? undefined : {
          totalCases: 0, dueToday: 0, conflicts: 0, rushCases: 0,
          processingCases: 0, inTransitCases: 0, completedCases: 0, overdueCases: 0,
          receivedCases: 0, inDesignCases: 0, modelRoomCases: 0, shippedCases: 0,
          scanCases: 0, millingCases: 0, postMillCases: 0, sinteringFurnaceCases: 0,
          porcelainCases: 0, qualityCheckCases: 0, onHoldCases: 0, remakeCases: 0,
        }),
        isLoading: o?.isLoading ?? false,
        isError: o?.isError ?? false,
        refetch: o?.refetch ?? vi.fn(async () => undefined),
      };
    },
    useCasesPage: (params?: {
      search?: string;
      barcode?: string;
      status?: string[];
      category?: string;
      taxonomyType?: string;
      conflictsOnly?: boolean;
      createdStart?: string;
      createdEnd?: string;
      dueStart?: string;
      dueEnd?: string;
      page?: number;
      pageSize?: number;
    }) => {
      mockUseCasesParams.calls.push(params);
      const page = params?.page ?? 1;
      const pageSize = params?.pageSize ?? 25;
      const casesByPage = mockAppOverrides.current.casesByPage as Record<number, unknown[]> | undefined;
      const sourceRows = casesByPage?.[page] ?? (mockAppOverrides.current.cases as any[]) ?? mockEmptyRows;
      const conflictSource = (mockAppOverrides.current.cases as any[] | undefined) ?? sourceRows;
      const conflictBarcodes = new Set(
        conflictSource
          .map((row: any) => row.casePanBarcode)
          .filter((barcode: unknown) => typeof barcode === "string" &&
            conflictSource.filter((row: any) => row.casePanBarcode === barcode).length > 1),
      );
      const rowsCacheKey = JSON.stringify({
        params: { ...params, page: undefined, pageSize: undefined },
        ids: sourceRows.map((row: any) => row.id),
      });
      const cachedRows = mockCasesPageRows.get(rowsCacheKey);
      let rows = (mockAppOverrides.current.doctorDirectory as Array<Record<string, any>> | undefined) ?? [];
      if (cachedRows) {
        rows = cachedRows as Array<Record<string, any>>;
      } else {
        rows = sourceRows.filter((row: any) => {
        if (params?.search) {
          const needle = params.search.toLowerCase();
          const haystack = [
            row.patientFirstName,
            row.patientLastName,
            row.doctorName,
            row.caseNumber,
            row.casePanBarcode,
          ].join(" ").toLowerCase();
          if (!haystack.includes(needle)) return false;
        }
        if (params?.status?.length) {
          const rawStatus = String(row.status ?? "").toLowerCase();
          const aliases: Record<string, string> = {
            intake: "received",
            design: "in_design",
            milling: "in_milling",
            porcelain: "in_porcelain",
            qc_check: "qc",
            delivery: "shipped",
            ship: "shipped",
            hold: "on_hold",
          };
          if (!params.status.includes(aliases[rawStatus] ?? rawStatus)) return false;
        }
        if (params?.barcode && String(row.casePanBarcode ?? "") !== params.barcode) return false;
        if (params?.conflictsOnly) {
          const status = String(row.status ?? "").toLowerCase();
          if (
            !conflictBarcodes.has(row.casePanBarcode) ||
            ["complete", "delivered", "cancelled"].includes(status)
          ) return false;
        }
        if (params?.taxonomyType) {
          const encoded = String(row.firstRestorationSubtype ?? "");
          const text = String(row.restorationTypes ?? "").toLowerCase();
          const inferred = encoded.split("/")[0] ||
            (/(denture|partial|flipper|removable)/.test(text) ? "removable" :
              /(guard|retainer|splint|ortho|appliance)/.test(text) ? "ortho" :
                text ? "restorative" : "");
          if (inferred !== params.taxonomyType) return false;
        }
        const inRange = (value: unknown, start?: string, end?: string) => {
          if (!start || !end) return true;
          const day = String(value ?? "").slice(0, 10);
          return day >= start && day <= end;
        };
        if (!inRange(row.createdAt, params?.createdStart, params?.createdEnd)) return false;
        if (!inRange(row.dueDate, params?.dueStart, params?.dueEnd)) return false;
          return true;
        });
        mockCasesPageRows.set(rowsCacheKey, rows);
      }
      const total = (mockAppOverrides.current.casesTotal as number | undefined) ?? rows.length;
      const { page: _page, pageSize: _pageSize, ...requestParams } = params ?? {};
      const requestKey = JSON.stringify(requestParams);
      return {
        data: {
          rows,
          total,
          page,
          pageSize,
          hasMore: (mockAppOverrides.current.casesHasMore as boolean | undefined) ?? false,
          search: params?.search ?? "",
          requestKey,
        },
        isLoading: mockAppOverrides.current.casesIsLoading ?? false,
        isFetching: mockAppOverrides.current.casesIsFetching ?? false,
        isError: mockAppOverrides.current.casesIsError ?? false,
        refetch: mockAppOverrides.current.casesRefetch ?? vi.fn(async () => undefined),
      };
    },
    // Dashboard's "Recent cases" section. Tests that render the dashboard seed
    // rows via `setMockAppState({ recentCases: [...] })`; the default keeps the
    // section rendered-but-empty so it can't interfere with sibling sections.
    useRecentCases: () => ({
      data: (mockAppOverrides.current.recentCases as unknown[]) ?? [],
      isLoading: false,
      isError: false,
      refetch: vi.fn(async () => undefined),
    }),
    useCase: (id?: string) => ({
      data: id
        ? ((mockAppOverrides.current.cases as Array<{ id: string }> | undefined)?.find(
            (c) => c.id === id,
          ) ?? null)
        : null,
      isLoading: false,
      isError: false,
      refetch: vi.fn(async () => undefined),
    }),
    // Generated OpenAPI hooks return the `{ ok, data }` envelope; screens unwrap
    // `.data`. These mirror the hand-written useCases/useCase mocks above.
    useListCases: () => ({
      data: { ok: true, data: (mockAppOverrides.current.cases as unknown[]) ?? [] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(async () => undefined),
    }),
    // Provider-scoped cases. The portal derives the provider's linked labs from
    // these rows (`labOrganizationId` / `labName`), so tests seed them with
    // `setMockAppState({ providerCases: [...] })`.
    useListProviderCases: () => ({
      data: { ok: true, data: (mockAppOverrides.current.providerCases as unknown[]) ?? [] },
      isLoading: (mockAppOverrides.current.providerCasesIsLoading as boolean | undefined) ?? false,
      isError: (mockAppOverrides.current.providerCasesIsError as boolean | undefined) ?? false,
      refetch: vi.fn(async () => undefined),
    }),
    getListProviderCasesQueryKey: (params?: unknown) => [
      "/api/cases/provider",
      ...(params ? [params] : []),
    ],
    useGetCase: (id?: string) => ({
      data: id
        ? {
            ok: true,
            data:
              (mockAppOverrides.current.cases as Array<{ id: string }> | undefined)?.find(
                (c) => c.id === id,
              ) ?? null,
          }
        : undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn(async () => undefined),
    }),
    useCreateCase: () => ({
      mutateAsync: mockCreateCaseMutateAsync,
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    }),
    usePreviewDraftInvoice: () => ({
      mutateAsync: vi.fn(async () => {
        const override = mockAppOverrides.current.previewDraftResult;
        if (override === "error") throw new Error("preview failed");
        return {
          ok: true,
          data: override ?? { lineItems: [], subtotal: "0.00", total: "0.00" },
        };
      }),
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    }),
    useUpdateCase: () => ({
      mutateAsync: mockUpdateCaseMutateAsync,
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    }),
    getGetOrganizationQueryKey: (organizationId: string) => [
      `/api/organizations/${organizationId}`,
    ],
    useGetOrganization: (organizationId: string) => {
      const organizations = mockAppOverrides.current.organizations as
        | Array<{ id: string; name?: string | null; displayName?: string | null }>
        | undefined;
      const organization = organizations?.find(
        (candidate) => candidate.id === organizationId,
      );
      return {
        data: organization ? { ok: true, data: organization } : undefined,
        isLoading: false,
        isError: false,
      };
    },
    getGetVocabularyQueryKey: (params?: unknown) => [
      "/api/vocabulary",
      ...(params ? [params] : []),
    ],
    useGetVocabulary: () => ({
      data: {
        ok: true,
        data: mockAppOverrides.current.shadeVocabulary ?? [],
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(async () => undefined),
    }),
    usePreviewDoctorMerge: () => ({
      data: undefined,
      mutate: vi.fn(),
      mutateAsync: vi.fn(async () => ({ ok: true, data: {} })),
      reset: mockPreviewDoctorMergeReset,
      isPending: false,
    }),
    useMergeDoctors: (options?: any) => ({
      mutate: (variables: unknown) => {
        mockMergeDoctorsMutate(variables);
        const outcome = mockAppOverrides.current.mergeDoctorOutcome as
          | { kind: "error"; error: Error }
          | { kind: "success"; response: unknown }
          | undefined;
        if (outcome?.kind === "error") {
          options?.mutation?.onError?.(outcome.error);
        } else {
          options?.mutation?.onSuccess?.(
            outcome?.kind === "success"
              ? outcome.response
              : { data: { casesMoved: 1, targetDoctorName: "Test Doctor" } },
          );
        }
      },
      mutateAsync: vi.fn(async () => ({ ok: true, data: {} })),
      isPending: false,
    }),
    getGetDoctorDuplicateClustersQueryKey: () => [
      "/api/doctors/duplicate-clusters",
    ],
    searchDoctors: mockSearchDoctors,
    undoDoctorMerge: vi.fn(async () => ({ ok: true, data: {} })),
    getGetCaseDoctorCandidatesQueryKey: (caseId: string, params?: unknown) => [
      `/api/cases/${caseId}/doctor-candidates`, ...(params ? [params] : []),
    ],
    useGetCaseDoctorCandidates: (caseId: string, params?: unknown) =>
      mockAppOverrides.current.liveDoctorSearchQueries
        ? realUseQuery({
            queryKey: [`/api/cases/${caseId}/doctor-candidates`, params],
            queryFn: () => mockGetCaseDoctorCandidates(caseId, params),
            retry: false,
          })
        : { data: undefined, isFetching: false, isError: false, refetch: vi.fn() },
    useReassignCaseDoctor: () => ({
      mutateAsync: mockReassignCaseDoctorMutateAsync, isPending: false,
    }),
    undoCaseDoctorReassignment: mockUndoCaseDoctorReassignment,
    refreshCaseDoctorQueries,
    useAddCaseNote: () => ({
      mutateAsync: mockAddCaseNoteMutateAsync,
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    }),
    useAddCaseRestoration: () => ({
      mutateAsync: mockAddCaseRestorationMutateAsync,
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    }),
    useDeleteCaseRestoration: () => ({
      mutateAsync: vi.fn(async () => undefined),
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    }),
    useUpdateCaseRestoration: () => ({
      mutateAsync: mockUpdateCaseRestorationMutateAsync,
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    }),
    UpdateCaseInputStatus: {},
    UpdateCaseInputPriority: {},
    AddCaseNoteInputVisibility: {},
    useInvoices: (params?: Record<string, unknown>) => {
      if (mockAppOverrides.current.liveInvoiceQueries) {
        return realUseQuery({
          queryKey: ["invoices", params ?? {}],
          queryFn: async () => (mockAppOverrides.current.invoices as unknown[]) ?? [],
        });
      }
      return {
        data: (mockAppOverrides.current.invoices as unknown[]) ?? [],
        isLoading: false,
        isFetching: (mockAppOverrides.current.invoicesIsFetching as boolean | undefined) ?? false,
        isError: false,
        refetch: vi.fn(async () => undefined),
      };
    },
    usePagedInvoices: (
      params?: Record<string, unknown>,
      options?: { enabled?: boolean; pageSize?: number },
    ) => {
      mockPagedInvoiceParams.calls.push(params);
      // Tests that opt into `liveInvoiceQueries` read the list through REAL
      // React Query under the production key, so an ["invoices"] invalidation
      // issued by a payment actually refetches the rows instead of only being
      // recorded. Both branches serve `filterPagedInvoiceRows`.
      if (mockAppOverrides.current.liveInvoiceQueries) {
        const live = realUseQuery({
          queryKey: [...FINANCE_INVOICES_QUERY_KEY, "paged", params ?? {}],
          enabled: options?.enabled,
          queryFn: async () => filterPagedInvoiceRows(params),
        });
        const liveRows = (live.data as Array<Record<string, any>> | undefined) ?? [];
        return {
          ...live,
          data: liveRows,
          total: liveRows.length,
          hasNextPage: Boolean(mockAppOverrides.current.invoicesHasNextPage),
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(async () => undefined),
          refresh: vi.fn(async () => live.refetch()),
        };
      }
      const rows = filterPagedInvoiceRows(params);
      const configuredPageSize = mockAppOverrides.current.invoicesPageSize;
      const pageSize =
        options?.pageSize ??
        (typeof configuredPageSize === "number" && configuredPageSize > 0
          ? Math.floor(configuredPageSize)
          : 25);
      const queryKey = JSON.stringify(params ?? {});
      const [loadedCount, setLoadedCount] = React.useState<number>(
        () => mockPagedInvoiceLoadedCounts.get(queryKey) ?? pageSize,
      );
      const [loadedQueryKey, setLoadedQueryKey] = React.useState(queryKey);
      if (loadedQueryKey !== queryKey) {
        setLoadedQueryKey(queryKey);
        setLoadedCount(pageSize);
      }
      // A fixture can be populated by a mutation while the list stays mounted
      // (for example, invoice generation from a case). Do not let the empty
      // pre-mutation page-count cache hide the newly available first page.
      const effectiveLoadedCount = loadedQueryKey === queryKey
        ? Math.max(loadedCount, pageSize)
        : pageSize;
      const visibleRows = rows.slice(0, effectiveLoadedCount);
      mockPagedInvoiceLoadedCounts.set(queryKey, effectiveLoadedCount);
      return {
        data: visibleRows,
        total: rows.length,
        isLoading: false,
        isFetching: (mockAppOverrides.current.invoicesIsFetching as boolean | undefined) ?? false,
        isError: false,
        hasNextPage:
          effectiveLoadedCount < rows.length ||
          Boolean(mockAppOverrides.current.invoicesHasNextPage),
        isFetchingNextPage: false,
        fetchNextPage: vi.fn(async () => {
          setLoadedCount((count) => Math.min(count + pageSize, rows.length));
        }),
        refresh: vi.fn(async () => undefined),
        refetch: vi.fn(async () => undefined),
      };
    },
    useInvoiceBrowserPage: (
      params?: Record<string, unknown>,
      options?: { page: number; pageSize: number; enabled?: boolean },
    ) => {
      const enabled = options?.enabled !== false;
      const pageSize = options?.pageSize ?? 25;
      const page = options?.page ?? 1;
      const all = enabled ? filterPagedInvoiceRows(params) : [];
      if (enabled) mockPagedInvoiceParams.calls.push(params);
      const offset = (page - 1) * pageSize;
      return {
        data: all.slice(offset, offset + pageSize),
        total: all.length,
        summary: enabled ? (mockAppOverrides.current.invoiceSummary as Record<string, unknown> | undefined) : undefined,
        offset,
        isLoading: false,
        isFetching: false,
        isError: false,
        hasNextPage: offset + pageSize < all.length,
        isFetchingNextPage: false,
        fetchNextPage: vi.fn(async () => undefined),
        refresh: vi.fn(async () => undefined),
        refetch: vi.fn(async () => undefined),
      };
    },
    useInvoiceFilterFacets: () => {
      // Facets are derived from the same seeded invoice fixture the list uses.
      const rows = filterPagedInvoiceRows();
      const practices = Array.from(new Map(rows.flatMap((invoice) => {
        const id = String(invoice.providerOrganizationId ?? "");
        const name = String(invoice.providerOrganization?.name ?? "");
        return id && name ? [[id, { id, name }] as const] : [];
      })).values());
      const doctors = Array.from(new Set(rows.map((invoice) =>
        String((invoice.displayMetadataJson ?? invoice.displayMetadata ?? {}).billTo ?? ""),
      ).filter(Boolean)));
      return { data: { practices, doctors }, isLoading: false, isError: false };
    },
    useStatementAccountSummaries: (labId?: string) => {
      mockStatementSummaryLabIds.calls.push(labId);
      // Same live/static split as the paged invoice list: under
      // `liveInvoiceQueries` the summaries come from real React Query under
      // the production key, so a ["statement-account-summaries"] invalidation
      // refetches them mid-screen.
      if (mockAppOverrides.current.liveInvoiceQueries) {
        const live = realUseQuery({
          queryKey: [...FINANCE_STATEMENT_SUMMARIES_QUERY_KEY, "paged", labId ?? ""],
          enabled: Boolean(labId),
          queryFn: async () =>
            (mockAppOverrides.current.statementAccountSummaries as
              | Array<Record<string, any>>
              | undefined) ?? [],
        });
        const liveRows = (live.data as Array<Record<string, any>> | undefined) ?? [];
        return {
          ...live,
          data: liveRows,
          total: liveRows.length,
          hasNextPage: Boolean(mockAppOverrides.current.statementAccountSummariesHasNextPage),
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(async () => undefined),
          refresh: vi.fn(async () => live.refetch()),
        };
      }
      const rows =
        (mockAppOverrides.current.statementAccountSummaries as
          | Array<Record<string, any>>
          | undefined) ?? [];
      return {
        data: rows,
        total: rows.length,
        isLoading: false,
        isFetching: (mockAppOverrides.current.statementAccountSummariesIsFetching as boolean | undefined) ?? false,
        isError: false,
        hasNextPage: Boolean(mockAppOverrides.current.statementAccountSummariesHasNextPage),
        isFetchingNextPage: false,
        fetchNextPage: vi.fn(async () => undefined),
        refresh: vi.fn(async () => undefined),
        refetch: vi.fn(async () => undefined),
      };
    },
    useDoctorDirectory: (_labId?: string, params?: { search?: string; openOnly?: boolean }) => {
      mockDoctorDirectoryParams.calls.push({ labId: _labId, params });
      let rows = (mockAppOverrides.current.doctorDirectory as Array<Record<string, any>> | undefined) ?? [];
      if (params?.openOnly) rows = rows.filter((row) => Number(row.openCases ?? 0) > 0);
      if (params?.search) {
        const search = params.search.toLowerCase();
        rows = rows.filter((row) =>
          `${row.doctorName ?? ""} ${row.practiceName ?? ""}`.toLowerCase().includes(search),
        );
      }
      return {
        data: rows,
        total: rows.length,
        isLoading: false,
        isFetching: false,
        isError: false,
        hasNextPage: Boolean(mockAppOverrides.current.doctorDirectoryHasNextPage),
        isFetchingNextPage: false,
        fetchNextPage: vi.fn(async () => undefined),
        refresh: vi.fn(async () => undefined),
        refetch: vi.fn(async () => undefined),
      };
    },
    useInvoice: (id?: string) => {
      if (mockAppOverrides.current.liveInvoiceQueries) {
        return realUseQuery({
          queryKey: ["invoices", id],
          enabled: Boolean(id),
          queryFn: async () =>
            id
              ? ((mockAppOverrides.current.invoices as Array<{ id: string }> | undefined)?.find(
                  (i) => i.id === id,
                ) ?? null)
              : null,
        });
      }
      return {
        data: id
          ? ((mockAppOverrides.current.invoices as Array<{ id: string }> | undefined)?.find(
              (i) => i.id === id,
            ) ?? null)
          : null,
        isLoading: (mockAppOverrides.current.invoiceIsLoading as boolean | undefined) ?? false,
        isError: false,
        refetch: vi.fn(async () => undefined),
      };
    },
    useListInvoices: () => {
      const raw = (mockAppOverrides.current.invoices as unknown[]) ?? [];
      return {
        data: { ok: true, data: raw },
        isLoading: false,
        isFetching: false,
        isError: false,
        error: null,
        refetch: vi.fn(async () => undefined),
      };
    },
    useUpdateInvoice: () => ({
      mutateAsync: mockUpdateInvoiceMutateAsync,
      mutate: vi.fn(),
      isPending: false,
    }),
    useGenerateInvoiceForCase: () => ({
      mutateAsync: mockGenerateInvoiceForCaseMutateAsync,
      mutate: vi.fn(),
      isPending: false,
    }),
    useEmailInvoice: () => ({
      mutateAsync: mockEmailInvoiceMutateAsync,
      mutate: vi.fn(),
      isPending: false,
    }),
    useCaseAttachments: () => ({
      data: (mockAppOverrides.current.attachments as unknown[]) ?? [],
      isLoading: false,
      refetch: vi.fn(async () => undefined),
    }),
    useDeleteCaseAttachment: () => ({
      mutateAsync: mockDeleteAttachmentMutateAsync,
      mutate: vi.fn(),
      isPending: false,
    }),
    useSearchDoctors: () => ({
      data: {
        ok: true,
        data: {
          entries:
            (mockAppOverrides.current.doctorSearchEntries as unknown[]) ?? [],
        },
      },
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(async () => undefined),
    }),
    getSearchDoctorsQueryKey: (params?: unknown) => ["/api/doctors/search", params],
    useListLabProviders: () => ({
      data: {
        ok: true,
        data: {
          providers:
            (mockAppOverrides.current.labProviders as unknown[]) ?? [],
        },
      },
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(async () => undefined),
    }),
    getListLabProvidersQueryKey: (labId?: string) => ["/api/lab-providers", labId],
    resolveItemPrice: vi.fn(async () => ({ ok: true, data: { price: null } })),
    useGetAiMemory: () => ({
      data: { ok: true, data: (mockAppOverrides.current.aiMemory as unknown[]) ?? [] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(async () => undefined),
    }),
    getGetAiMemoryQueryKey: (params?: unknown) => ["/api/ai-memory", params],
    useCreateAiMemory: () => ({
      mutateAsync: mockCreateAiMemoryMutateAsync,
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    }),
    useUpdateAiMemory: () => ({
      mutateAsync: mockUpdateAiMemoryMutateAsync,
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    }),
    useDeleteAiMemory: () => ({
      mutateAsync: mockDeleteAiMemoryMutateAsync,
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    }),
    useGetAiMemoryCandidates: () => ({
      data: { ok: true, data: (mockAppOverrides.current.aiCandidates as unknown[]) ?? [] },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(async () => undefined),
    }),
    getGetAiMemoryCandidatesQueryKey: (params?: unknown) => ["/api/ai-memory/candidates", params],
    useApproveAiMemoryCandidate: () => ({
      mutateAsync: mockApproveAiMemoryCandidateMutateAsync,
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    }),
    useRejectAiMemoryCandidate: () => ({
      mutateAsync: mockRejectAiMemoryCandidateMutateAsync,
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    }),
    useListLabInboxFiles: () => ({
      data: { ok: true, data: [] },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(async () => undefined),
    }),
    getListLabInboxFilesQueryKey: (params?: unknown) => ["/api/lab-inbox", params],
    useAssignLabInboxFile: () => ({
      mutateAsync: vi.fn(async () => ({ ok: true, data: null })),
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    }),
    useGetStatsSummary: () => ({
      data: mockAppOverrides.current.statsSummary
        ? { ok: true, data: mockAppOverrides.current.statsSummary }
        : undefined,
      isLoading: (mockAppOverrides.current.statsSummaryIsLoading as boolean | undefined) ?? false,
      isFetching: false,
      isError: (mockAppOverrides.current.statsSummaryIsError as boolean | undefined) ?? false,
      refetch: vi.fn(async () => undefined),
    }),
    getGetStatsSummaryQueryKey: (params?: unknown) => ["/api/stats/summary", params],
    useGetStatsCaseCategories: () => ({
      data: mockAppOverrides.current.statsCaseCategories
        ? { ok: true, data: mockAppOverrides.current.statsCaseCategories }
        : undefined,
      isLoading: (mockAppOverrides.current.statsCaseCategoriesIsLoading as boolean | undefined) ?? false,
      isFetching: false,
      isError: (mockAppOverrides.current.statsCaseCategoriesIsError as boolean | undefined) ?? false,
      refetch: vi.fn(async () => undefined),
    }),
    getGetStatsCaseCategoriesQueryKey: (params?: unknown) => [
      "/api/stats/case-categories",
      params,
    ],
    useGetStatsRevenueSeries: () => ({
      data: mockAppOverrides.current.statsRevenueSeries
        ? { ok: true, data: mockAppOverrides.current.statsRevenueSeries }
        : undefined,
      isLoading: (mockAppOverrides.current.statsRevenueSeriesIsLoading as boolean | undefined) ?? false,
      isFetching: false,
      isError: (mockAppOverrides.current.statsRevenueSeriesIsError as boolean | undefined) ?? false,
      refetch: vi.fn(async () => undefined),
    }),
    getGetStatsRevenueSeriesQueryKey: (params?: unknown) => [
      "/api/stats/revenue-series",
      params,
    ],
    useGetInvoiceDiscountsReport: () => ({
      data: mockAppOverrides.current.invoiceDiscountsReport
        ? { ok: true, data: mockAppOverrides.current.invoiceDiscountsReport }
        : undefined,
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(async () => undefined),
    }),
    getGetInvoiceDiscountsReportQueryKey: (params?: unknown) => [
      "/api/invoices/reports/discounts",
      params,
    ],
    useGetStatsWeekdayVolume: () => ({
      data: mockAppOverrides.current.statsWeekdayVolume
        ? { ok: true, data: mockAppOverrides.current.statsWeekdayVolume }
        : undefined,
      isLoading: (mockAppOverrides.current.statsWeekdayVolumeIsLoading as boolean | undefined) ?? false,
      isFetching: false,
      isError: (mockAppOverrides.current.statsWeekdayVolumeIsError as boolean | undefined) ?? false,
      refetch: vi.fn(async () => undefined),
    }),
    getGetStatsWeekdayVolumeQueryKey: (params?: unknown) => [
      "/api/stats/weekday-volume",
      params,
    ],
    useGetStatsRemakes: () => ({
      data: mockAppOverrides.current.statsRemakes
        ? { ok: true, data: mockAppOverrides.current.statsRemakes }
        : undefined,
      isLoading: (mockAppOverrides.current.statsRemakesIsLoading as boolean | undefined) ?? false,
      isFetching: false,
      isError: (mockAppOverrides.current.statsRemakesIsError as boolean | undefined) ?? false,
      refetch: vi.fn(async () => undefined),
    }),
    getGetStatsRemakesQueryKey: (params?: unknown) => [
      "/api/stats/remakes",
      params,
    ],
    useGetStatsSalesForecast: () => ({
      data: mockAppOverrides.current.statsSalesForecast
        ? { ok: true, data: mockAppOverrides.current.statsSalesForecast }
        : undefined,
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(async () => undefined),
    }),
    getGetStatsSalesForecastQueryKey: (params?: unknown) => [
      "/api/stats/sales-forecast",
      params,
    ],
    setBaseUrl: vi.fn(),
    setAuthTokenGetter: vi.fn(),
    setAuthRefresher: vi.fn(),
    setRequestHeadersProvider: vi.fn(),
  };
});

// authed-media-cache: return the URL as-is in tests (no filesystem I/O).
vi.mock("@/lib/authed-media-cache", () => {
  const getAuthedMediaUri = vi.fn(
    async (url: string | null | undefined) => url ?? null,
  );
  return {
    getAuthedMediaUri,
    acquireAuthedMediaUri: vi.fn(async (url: string | null | undefined) => {
      const uri = await getAuthedMediaUri(url);
      return uri ? { uri, release: () => undefined } : null;
    }),
    refreshAuthedMediaUri: vi.fn(async (url: string | null | undefined) => url ?? null),
    retainAuthedMediaUri: vi.fn(() => () => undefined),
  };
});

// expo-file-system/legacy: stub constants and methods used by authed-media-cache
// and the AI assistant TTS playback path (writeAsStringAsync + EncodingType).
vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///tmp/",
  cacheDirectory: "file:///cache/",
  getInfoAsync: vi.fn(async () => ({ exists: false })),
  makeDirectoryAsync: vi.fn(async () => undefined),
  readDirectoryAsync: vi.fn(async () => []),
  downloadAsync: vi.fn(async (_url: string, dest: string) => ({ status: 200, uri: dest })),
  deleteAsync: vi.fn(async () => undefined),
  readAsStringAsync: vi.fn(async () => ""),
  writeAsStringAsync: vi.fn(async () => undefined),
  copyAsync: vi.fn(async () => undefined),
  EncodingType: { UTF8: "utf8", Base64: "base64" },
}));

vi.mock("@/lib/theme-context", () => {
  const Colors = {
    text: "#0F172A",
    textSecondary: "#64748B",
    textTertiary: "#8FA1B5",
    textInverse: "#FFFFFF",
    background: "transparent",
    backgroundSolid: "#F4F7FB",
    surface: "#FFFFFF",
    surfaceAlt: "#EEF2F7",
    tint: "#145DA0",
    tintLight: "#D9E9F7",
    tintDark: "#0F4C81",
    border: "#E2E8F0",
    sectionBorder: "#7F97B1",
    warning: "#B45309",
    icon: "#64748B",
    tabIconDefault: "#94A3B8",
    tabIconSelected: "#145DA0",
    card: "#FFFFFF",
    shadow: "rgba(0,0,0,0.08)",
  };
  // Mirror the design-token scales `useTheme()` re-exports so primitives that
  // read spacing/radius/typography/shadows (e.g. Card) don't crash in tests.
  const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32, huge: 40 };
  const radius = { xs: 6, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28, full: 999 };
  const typography = {
    display: { fontSize: 28 },
    h1: { fontSize: 22 },
    h2: { fontSize: 18 },
    h3: { fontSize: 16 },
    bodyLg: { fontSize: 15 },
    bodyLgMedium: { fontSize: 15 },
    body: { fontSize: 14 },
    bodyMedium: { fontSize: 14 },
    bodySemibold: { fontSize: 14 },
    caption: { fontSize: 12 },
    captionMedium: { fontSize: 12 },
    captionSemibold: { fontSize: 12 },
    label: { fontSize: 11 },
    tiny: { fontSize: 10 },
  };
  const shadows = { none: {}, sm: {}, md: {}, lg: {} };
  const ctx = {
    mode: "light" as const,
    colors: Colors,
    isDark: false,
    setMode: vi.fn(),
    spacing,
    radius,
    typography,
    shadows,
  };
  const React = require("react");
  return {
    useTheme: () => ctx,
    ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});

const originalConsoleError = console.error.bind(console);

// Console output goes through this indirection so guard tests can spy on the
// forwarding itself (`vi.spyOn(consoleErrorOutput, "write")`) instead of
// replacing console.error, which would take the act-warning gate below with
// it.
export const consoleErrorOutput = {
  write: (...args: unknown[]): void => {
    originalConsoleError(...args);
  },
};

console.error = (...args: unknown[]): void => {
  consoleErrorOutput.write(...args);
  if (args.map(String).join(" ").match(reactActWarning)) {
    throw new Error("React state update was not wrapped in act(...)");
  }
};

let activeReceiptQueryClient: ReceiptQueryClient | null = null;

export async function refreshMockReceiptSession(sessionId: string): Promise<void> {
  await activeReceiptQueryClient?.refetchQueries({
    queryKey: ["receive-payments", "payment-session", sessionId],
  });
}

/**
 * Drain promise-backed React updates after screen-test bodies complete.
 *
 * Keep this in the shared setup so screen suites use one synchronization
 * policy instead of maintaining slightly different local drains.
 */
export async function flushPendingReactUpdates(): Promise<void> {
  await asyncReactAct(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}
