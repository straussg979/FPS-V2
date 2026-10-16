// The browser client build: two entries (the website's pages and the 3D game), content-hashed into
// client/dist/assets with a manifest the server reads to link them. No inline scripts are produced.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: "/",
  publicDir: path.join(here, "public"),
  resolve: { alias: { "@cs/shared": path.join(here, "../shared/src") } },
  build: {
    outDir: path.join(here, "dist"),
    emptyOutDir: false,
    manifest: true,
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: { site: path.join(here, "src/site/main.ts"), game: path.join(here, "src/game/main.ts") },
      output: { entryFileNames: "assets/[name]-[hash].js", chunkFileNames: "assets/[name]-[hash].js", assetFileNames: "assets/[name]-[hash][extname]" },
    },
  },
});
