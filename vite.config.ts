import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { getRendererBase } from "./src/shared/electronAppPaths";

export default defineConfig(({ command }) => ({
  base: getRendererBase(command),
  plugins: [react()],
  resolve: {
    alias: {
      "@main": path.resolve(__dirname, "src/main"),
      "@preload": path.resolve(__dirname, "src/preload"),
      "@renderer": path.resolve(__dirname, "src/renderer"),
      "@runtime": path.resolve(__dirname, "src/runtime"),
      "@shared": path.resolve(__dirname, "src/shared"),
      "@generated": path.resolve(__dirname, "src/generated")
    }
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom", "react-dom/client"],
          "ui-vendor": ["@radix-ui/react-scroll-area", "@radix-ui/react-separator", "clsx"]
        }
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["src/tests/setup.ts"],
    css: false
  }
}));
