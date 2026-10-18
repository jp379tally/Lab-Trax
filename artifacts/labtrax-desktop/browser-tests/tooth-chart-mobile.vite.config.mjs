import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const desktopRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const mobileRoot = path.resolve(desktopRoot, "../labtrax");
const fixtureRoot = path.join(desktopRoot, "browser-tests");

export default defineConfig({
  root: fixtureRoot,
  cacheDir: path.join(desktopRoot, "node_modules/.vite-tooth-chart-mobile"),
  resolve: {
    alias: [
      {
        find: "@/lib/theme-context",
        replacement: path.join(fixtureRoot, "tooth-chart-mobile-theme.tsx"),
      },
      { find: "@", replacement: mobileRoot },
      {
        find: "react-native-svg",
        replacement: path.join(fixtureRoot, "tooth-chart-svg-web.tsx"),
      },
      { find: "react-native", replacement: "react-native-web" },
    ],
    dedupe: ["react", "react-dom"],
  },
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    strictPort: true,
    fs: { allow: [desktopRoot, mobileRoot] },
  },
  optimizeDeps: { include: ["react-native-web"] },
});
