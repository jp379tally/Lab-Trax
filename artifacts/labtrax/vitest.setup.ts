// Vitest setup for the mobile client. Pure-helper tests need none of this;
// the mocks below let smoke tests render real screen modules with RNTL.
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

import { vi } from "vitest";
import * as React from "react";
import { createRequire } from "node:module";
import reactNativeStub from "./test-stubs/react-native";

type ChildrenOnly = React.PropsWithChildren<unknown>;
const passthrough = ({ children }: ChildrenOnly): React.ReactNode =>
  children ?? null;
const nullComponent = (): null => null;

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
  mockSearchParams.current = params;
}

// Mutable data slice that drives the mocked `@workspace/api-client-react`
// hooks below (useCases / useCase / useInvoices / useInvoice). Tests seed the
// canonical cases/invoices they care about via `setMockAppState({ cases,
// invoices })`; everything else stays empty. `resetMockAppState()` runs
// between tests so overrides don't leak across files.
type MockAppOverrides = Record<string, unknown>;
const mockAppOverrides: { current: MockAppOverrides } = { current: {} };
export function setMockAppState(overrides: MockAppOverrides): void {
  mockAppOverrides.current = { ...mockAppOverrides.current, ...overrides };
}
export function resetMockAppState(): void {
  mockAppOverrides.current = {};
}

// Stable mutation spies so tests can assert calls (a fresh vi.fn() per render
// would be unobservable). `mock`-prefixed so Vitest allows them in the factory.
export const mockUpdateCaseMutateAsync = vi.fn(async () => ({ ok: true, data: null }));
export const mockAddCaseNoteMutateAsync = vi.fn(async () => ({ ok: true, data: null }));
export const mockDeleteAttachmentMutateAsync = vi.fn(async () => ({ ok: true, data: null }));
export const mockEmailInvoiceMutateAsync = vi.fn(async () => ({ ok: true, data: null }));
export const mockUpdateInvoiceMutateAsync = vi.fn(async () => ({ ok: true, data: null }));
export const mockAddCaseRestorationMutateAsync = vi.fn(async () => ({ ok: true, data: null }));
export const mockCreateAiMemoryMutateAsync = vi.fn(async () => ({ ok: true, data: null }));
export const mockUpdateAiMemoryMutateAsync = vi.fn(async () => ({ ok: true, data: null }));
export const mockDeleteAiMemoryMutateAsync = vi.fn(async () => undefined);

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
};
const StackImpl = passthrough as StackComponent;
StackImpl.Screen = passthrough;

// Errors from the focus callback intentionally propagate — that's the
// class of regression the smoke tests are here to catch.
type FocusEffectCallback = () => void | (() => void);
let focusEffectEnabled = true;
export function setFocusEffectEnabled(enabled: boolean): void {
  focusEffectEnabled = enabled;
}
const deferredFocusEffect = (cb: FocusEffectCallback): void => {
  if (!focusEffectEnabled) return;
  queueMicrotask(() => {
    cb();
  });
};

vi.mock("expo-router", () => {
  const router = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    canGoBack: () => false,
    setParams: vi.fn(),
    navigate: vi.fn(),
  };
  const Tabs = Object.assign(passthrough, { Screen: passthrough });
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
  useRoute: () => ({ params: {} }),
  useFocusEffect: deferredFocusEffect,
  NavigationContainer: passthrough,
}));

vi.mock("@expo/vector-icons", () => {
  const Icon = ({ name }: { name?: string }) =>
    React.createElement("Icon", { name });
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
  Image: ({ source, testID }: { source?: unknown; testID?: string }) =>
    React.createElement("Image", { source, testID }),
}));

// MockCameraView captures onBarcodeScanned callbacks so tests can trigger
// simulated barcode scans via triggerMockBarcodeScan(data).
//
// Callbacks are stored in two ways:
//   1. By testID (preferred) — keyed in _mockBarcodeScanCallbacksByTestId so
//      multiple CameraViews with different testIDs can coexist (e.g. the main
//      barcode scanner vs. AttachBarcodeModal's scanner).
//   2. Legacy unnamed fallback — _mockBarcodeScanCallback, overwritten by the
//      last MockCameraView that rendered without a testID.
const _mockBarcodeScanCallbacksByTestId = new Map<
  string,
  ((payload: { data: string }) => void) | undefined
>();
let _mockBarcodeScanCallback: ((payload: { data: string }) => void) | undefined;

function MockCameraView({
  children,
  onBarcodeScanned,
  testID,
}: {
  children?: React.ReactNode;
  onBarcodeScanned?: (payload: { data: string }) => void;
  testID?: string;
}) {
  if (testID !== undefined) {
    _mockBarcodeScanCallbacksByTestId.set(testID, onBarcodeScanned);
  } else {
    _mockBarcodeScanCallback = onBarcodeScanned;
  }
  return (children ?? null) as React.ReactNode;
}

/** Call from tests to fire a fake barcode scan event.
 * @param data     The barcode string value to simulate scanning.
 * @param testID   The testID of the target CameraView (default: "scan-barcode-scanner").
 *                 Pass undefined to target the legacy unnamed callback instead.
 * Throws if no matching CameraView callback is found. */
export function triggerMockBarcodeScan(
  data: string,
  testID: string | null = "scan-barcode-scanner",
): void {
  let cb: ((payload: { data: string }) => void) | undefined;
  if (testID !== null) {
    cb = _mockBarcodeScanCallbacksByTestId.get(testID);
    if (cb === undefined && !_mockBarcodeScanCallbacksByTestId.has(testID)) {
      throw new Error(
        `triggerMockBarcodeScan: no CameraView with testID="${testID}" is mounted.`,
      );
    }
  } else {
    cb = _mockBarcodeScanCallback;
    if (!cb) {
      throw new Error(
        "triggerMockBarcodeScan: no unnamed CameraView with onBarcodeScanned is mounted.",
      );
    }
  }
  if (cb) cb({ data });
}

vi.mock("expo-camera", () => ({
  CameraView: MockCameraView,
  useCameraPermissions: () => [
    { granted: true, status: "granted" },
    vi.fn(async () => ({ granted: true, status: "granted" })),
  ],
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

vi.mock("@/lib/query-client", () => ({
  getApiUrl: () => "http://localhost/",
  getAccessToken: vi.fn(async () => null),
  resilientFetch: vi.fn(
    async (url: string, init?: RequestInit) => fetchHandler.current(url, init),
  ),
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

// ── @tanstack/react-query: stub useQuery so CaseDetailScreen's auth/me call
// doesn't require a real QueryClientProvider. Defaults to empty data
// (canEdit=false); tests that need edit permission seed memberships via
// `setMockAppState({ meMemberships: [{ organizationId, role, status }] })`.
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: vi.fn((options?: { queryKey?: unknown[] }) => {
      const key = Array.isArray(options?.queryKey) ? options.queryKey[0] : null;
      const isMeQuery = key === "auth-me";
      return {
        data:
          isMeQuery && mockAppOverrides.current.meMemberships !== undefined
            ? { memberships: mockAppOverrides.current.meMemberships }
            : undefined,
        isLoading: false,
        isError: false,
      };
    }),
    useQueryClient: vi.fn(() => ({
      invalidateQueries: vi.fn(async () => undefined),
      setQueryData: vi.fn(),
      getQueryData: vi.fn(() => undefined),
    })),
  };
});

// ── @workspace/api-client-react: mock React Query hooks so screens that use
// useCases / useCase / useInvoices / useInvoice don't need a QueryClientProvider.
// Hook data is driven by the same mockAppOverrides used for the AppContext mock.
vi.mock("@workspace/api-client-react", () => ({
  useCases: () => ({
    data: (mockAppOverrides.current.cases as unknown[]) ?? [],
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
    mutateAsync: vi.fn(async () => ({ ok: true, data: { id: "test-mock-case-id" } })),
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
    mutateAsync: vi.fn(async () => undefined),
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  }),
  UpdateCaseInputStatus: {},
  UpdateCaseInputPriority: {},
  AddCaseNoteInputVisibility: {},
  useInvoices: () => ({
    data: (mockAppOverrides.current.invoices as unknown[]) ?? [],
    isLoading: false,
    isError: false,
    refetch: vi.fn(async () => undefined),
  }),
  useInvoice: (id?: string) => ({
    data: id
      ? ((mockAppOverrides.current.invoices as Array<{ id: string }> | undefined)?.find(
          (i) => i.id === id,
        ) ?? null)
      : null,
    isLoading: (mockAppOverrides.current.invoiceIsLoading as boolean | undefined) ?? false,
    isError: false,
    refetch: vi.fn(async () => undefined),
  }),
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
    mutateAsync: vi.fn(async () => ({ ok: true, data: null })),
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
    data: { ok: true, data: { entries: [] } },
    isLoading: false,
    isError: false,
    refetch: vi.fn(async () => undefined),
  }),
  getSearchDoctorsQueryKey: (params?: unknown) => ["/api/doctors/search", params],
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
  setBaseUrl: vi.fn(),
  setAuthTokenGetter: vi.fn(),
  setAuthRefresher: vi.fn(),
}));

// authed-media-cache: return the URL as-is in tests (no filesystem I/O).
vi.mock("@/lib/authed-media-cache", () => ({
  getAuthedMediaUri: vi.fn(async (url: string | null | undefined) => url ?? null),
  refreshAuthedMediaUri: vi.fn(async (url: string | null | undefined) => url ?? null),
}));

// expo-file-system/legacy: stub constants and methods used by authed-media-cache.
vi.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///cache/",
  getInfoAsync: vi.fn(async () => ({ exists: false })),
  makeDirectoryAsync: vi.fn(async () => undefined),
  downloadAsync: vi.fn(async (_url: string, dest: string) => ({ status: 200, uri: dest })),
  deleteAsync: vi.fn(async () => undefined),
  readAsStringAsync: vi.fn(async () => ""),
  copyAsync: vi.fn(async () => undefined),
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
