/// <reference types="vitest" />
import { defineConfig, type Plugin } from "vitest/config";
import path from "node:path";

const stubPath = path.resolve(__dirname, "test-stubs/react-native.ts");
const ASSET_REGISTRY_VIRTUAL_ID = "\0virtual:labtrax-asset-registry-stub";
const EXPO_MODULES_CORE_VIRTUAL_ID = "\0virtual:labtrax-expo-modules-core-stub";

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
      return null;
    },
    load(id) {
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
    include: ["lib/**/*.test.ts", "lib/**/*.test.tsx"],
  },
});
