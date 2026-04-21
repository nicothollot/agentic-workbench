import { defineConfig } from "vite";
import path from "node:path";
import { electronAlias, electronExternal } from "./vite.shared-electron";

export default defineConfig({
  resolve: {
    alias: electronAlias
  },
  build: {
    outDir: "dist-electron/main",
    emptyOutDir: false,
    sourcemap: true,
    lib: {
      entry: path.resolve(__dirname, "src/main/index.ts"),
      formats: ["cjs"],
      fileName: () => "index.cjs"
    },
    rollupOptions: {
      external: electronExternal
    }
  }
});
