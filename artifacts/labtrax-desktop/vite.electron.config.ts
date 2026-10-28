import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
      "virtual:pwa-register": path.resolve(import.meta.dirname, "src/electron-pwa-register.ts"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/electron-app"),
    emptyOutDir: true,
    // Never ship synthetic auth / analysis stubs in release builds. CI opts
    // in so the smoke runs compiled intake code through the real app protocol.
    ...(process.env.LABTRAX_RENDERER_SMOKE === "1" ? {
      rollupOptions: {
        input: {
          app: path.resolve(import.meta.dirname, "index.html"),
          intakeSmoke: path.resolve(import.meta.dirname, "browser-tests/dashboard-reference.html"),
        },
      },
    } : {}),
  },
});
