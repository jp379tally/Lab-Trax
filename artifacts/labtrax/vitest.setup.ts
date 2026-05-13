// Vitest setup for the mobile client. Pure-helper tests need none of this;
// the mocks below let smoke tests render real screen modules with RNTL.
//
// `react-native` is redirected to a project-local stub two ways: (1) Vite
// plugin in vitest.config.ts for ESM imports, (2) Node require.cache here
// for externalised CJS (RNTL's matchers) — the real package's Flow source
// is unparsable.
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

// Mutable slice of the mocked `useApp()` payload. Tests override only the
// fields they care about (cases, invoices, clients, …); everything else
// stays at the empty defaults. `resetMockAppState()` is called between
// tests so overrides don't leak across files.
type MockAppOverrides = Record<string, unknown>;
const mockAppOverrides: { current: MockAppOverrides } = { current: {} };
export function setMockAppState(overrides: MockAppOverrides): void {
  mockAppOverrides.current = { ...mockAppOverrides.current, ...overrides };
}
export function resetMockAppState(): void {
  mockAppOverrides.current = {};
}

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

type StackComponent = React.FC<ChildrenOnly> & {
  Screen: React.FC<ChildrenOnly>;
};
const StackImpl = passthrough as StackComponent;
StackImpl.Screen = passthrough;

// Errors from the focus callback intentionally propagate — that's the
// class of regression the smoke tests are here to catch.
type FocusEffectCallback = () => void | (() => void);
const deferredFocusEffect = (cb: FocusEffectCallback): void => {
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
  Image: ({ source }: { source?: unknown }) =>
    React.createElement("Image", { source }),
}));

vi.mock("expo-camera", () => ({
  CameraView: passthrough,
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
  printToFileAsync: vi.fn(async () => ({ uri: "file:///tmp/test.pdf" })),
}));

vi.mock("expo-sharing", () => ({
  shareAsync: vi.fn(),
  isAvailableAsync: vi.fn(async () => true),
}));

vi.mock("expo-image-picker", () => ({
  getCameraPermissionsAsync: vi.fn(async () => ({ granted: true })),
  requestCameraPermissionsAsync: vi.fn(async () => ({ status: "granted" })),
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

vi.mock("expo/fetch", () => ({ fetch: globalThis.fetch ?? vi.fn() }));

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

vi.mock("@/lib/app-context", () => ({
  useApp: () => ({
    cases: [],
    invoices: [],
    notifications: [],
    clients: [],
    pricingTiers: [],
    users: [],
    role: "user",
    adminUnlocked: false,
    customStationLabels: {},
    findCaseByBarcode: () => null,
    updateCaseStatus: vi.fn(),
    addCasePhoto: vi.fn(),
    addCaseNote: vi.fn(),
    addCasePhotosWithNote: vi.fn(),
    addTrackingNumber: vi.fn(),
    addCaseItem: vi.fn(),
    updateInvoice: vi.fn(),
    addInvoice: vi.fn(),
    updateCase: vi.fn(),
    sendCourtesyText: vi.fn(),
    respondToCourtesyText: vi.fn(),
    proposeDeliveryDate: vi.fn(),
    respondToProposedDate: vi.fn(),
    assignBarcodeToCase: vi.fn(),
    addNotification: vi.fn(),
    hardRefresh: vi.fn(async () => undefined),
    hydrateInvoiceFromServer: vi.fn(async () => undefined),
    refreshCases: vi.fn(async () => undefined),
    fullRefreshCases: vi.fn(async () => undefined),
    setPendingInvoiceEditId: vi.fn(),
    ...mockAppOverrides.current,
  }),
  AppProvider: passthrough,
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
  queryClient: { clear: vi.fn() },
}));

vi.mock("@/components/ChatButton", () => ({ ChatButton: nullComponent }));
vi.mock("@/components/InvoicePDFViewer", () => ({ default: nullComponent }));
vi.mock("@/components/KeyboardAwareScrollViewCompat", () => ({
  KeyboardAwareScrollViewCompat: passthrough,
}));
vi.mock("@/components/ManualCropOverlay", () => ({
  ManualCropOverlay: nullComponent,
}));
vi.mock("@/components/ReadOnlyToothChart", () => ({
  ReadOnlyToothChart: nullComponent,
}));

vi.mock("@/lib/pdfToImages", () => ({
  convertPdfToImages: vi.fn(async () => []),
}));

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(async () => undefined) }));
