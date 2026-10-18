/// <reference types="vitest" />
import { defineConfig, type Plugin } from "vitest/config";
import path from "node:path";

const stubPath = path.resolve(__dirname, "test-stubs/react-native.ts");
const ASSET_REGISTRY_VIRTUAL_ID = "\0virtual:labtrax-asset-registry-stub";
const EXPO_MODULES_CORE_VIRTUAL_ID = "\0virtual:labtrax-expo-modules-core-stub";

const IMAGE_ASSET_VIRTUAL_ID = "\0virtual:labtrax-image-asset-stub";
// Matches common image/font asset extensions used in RN projects.
const IMAGE_ASSET_RE = /\.(png|jpg|jpeg|gif|webp|svg|ttf|otf|woff|woff2)$/;

// Redirect `react-native` ESM imports to a project-local stub so Vite
// never tries to parse the real (Flow-typed) source.
// Also intercept `expo-modules-core` which requires a native bridge that
// doesn't exist in the test environment.
function reactNativeStubPlugin(): Plugin {
  return {
    name: "labtrax:react-native-stub",
    enforce: "pre",
    resolveId(source) {
      if (source === "react-native") return stubPath;
      if (source === "react-native/Libraries/Image/AssetRegistry") {
        return ASSET_REGISTRY_VIRTUAL_ID;
      }
      if (source.startsWith("react-native/")) return stubPath;
      if (
        source === "expo-modules-core" ||
        source.startsWith("expo-modules-core/")
      ) {
        return EXPO_MODULES_CORE_VIRTUAL_ID;
      }
      // Stub out image/font asset requires (e.g. require('@/assets/images/icon.png'))
      // so tests that render components with inline asset requires don't crash.
      if (IMAGE_ASSET_RE.test(source)) {
        return IMAGE_ASSET_VIRTUAL_ID;
      }
      return null;
    },
    // Rewrite inline `require("...asset")` calls inside source files so that
    // they are replaced with a stub integer before Node.js ever tries to
    // resolve the asset path.  The `resolveId` hook above catches ESM static
    // imports; this transform hook is needed for JSX-style inline requires
    // (e.g. `source={require('@/assets/images/icon.png')}`).
    transform(code, id) {
      if (
        id.endsWith(".ts") ||
        id.endsWith(".tsx") ||
        id.endsWith(".js") ||
        id.endsWith(".jsx")
      ) {
        const INLINE_ASSET_REQUIRE_RE =
          /require\s*\(\s*(['"`])([^'"` \t\r\n]+?\.(png|jpg|jpeg|gif|webp|svg|ttf|otf|woff|woff2))\1\s*\)/g;
        if (INLINE_ASSET_REQUIRE_RE.test(code)) {
          return {
            code: code.replace(INLINE_ASSET_REQUIRE_RE, "1"),
            map: null,
          };
        }
      }
      return null;
    },
    load(id) {
      if (id === IMAGE_ASSET_VIRTUAL_ID) {
        return `export default 1;`;
      }
      if (id === ASSET_REGISTRY_VIRTUAL_ID) {
        return `export default { registerAsset: () => 0, getAssetByID: () => null };`;
      }
      if (id === EXPO_MODULES_CORE_VIRTUAL_ID) {
        return `
class MockEventEmitter {
  addListener() { return { remove: () => {} }; }
  removeAllListeners() {}
  emit() {}
}
export class EventEmitter extends MockEventEmitter {}
export class NativeModule extends MockEventEmitter {}
export class SharedObject {}
export const NativeModulesProxy = new Proxy({}, { get: () => () => {} });
export const requireNativeModule = () => new Proxy({}, { get: () => () => {} });
export const requireOptionalNativeModule = () => null;
export const Platform = { OS: 'ios', select: (obj) => (obj.ios !== undefined ? obj.ios : obj.default) };
export class CodedError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export class UnavailabilityError extends Error {
  constructor(moduleName, propertyName) {
    super(moduleName + '.' + propertyName + ' is not available.');
  }
}
export const uuid = { v4: () => 'test-uuid' };
export default {};
`;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [reactNativeStubPlugin()],
  resolve: {
    alias: [{ find: "@", replacement: path.resolve(__dirname) }],
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "lib/**/*.test.ts",
      "lib/**/*.test.tsx",
      "components/**/*.test.tsx",
      "app/__tests__/**/*.ts",
      "app/__tests__/**/*.tsx",
    ],
    // Keep the mobile gate to one fork. Screen-render tests retain a large
    // React Native module graph, and multiple forks can exhaust the shared
    // worker memory budget when this gate runs alongside the other validation
    // workflows.
    pool: "forks",
    maxWorkers: 1,
    // Heavier screen smoke tests need headroom under shared validation load.
    // Individual waitFor() calls keep their own shorter timeouts, so a genuine
    // hang still fails fast rather than sitting here for 15s.
    testTimeout: 15_000,
  },
});
