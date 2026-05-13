/// <reference types="vitest" />
import { defineConfig, type Plugin } from "vitest/config";
import path from "node:path";

const stubPath = path.resolve(__dirname, "test-stubs/react-native.ts");
const ASSET_REGISTRY_VIRTUAL_ID = "\0virtual:labtrax-asset-registry-stub";

// Redirect `react-native` ESM imports to a project-local stub so Vite
// never tries to parse the real (Flow-typed) source.
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
      return null;
    },
    load(id) {
      if (id === ASSET_REGISTRY_VIRTUAL_ID) {
        return `export default { registerAsset: () => 0, getAssetByID: () => null };`;
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
