import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The preview worker loads Prettier and Shiki only when a request or response
 * is first shown. Vite discovers those bare imports only at that point, then
 * re-optimizes dependencies and reloads the page — which in the desktop
 * WebView loses every open tab and edit. Declaring them here pre-bundles them
 * at server start, so the worker stays the only thing that loads lazily.
 */
const previewDependencies = [
  "prettier/standalone",
  "prettier/plugins/babel",
  "prettier/plugins/estree",
  "prettier/plugins/html",
  "prettier/plugins/postcss",
  "shiki/core",
  "shiki/engine/javascript",
  "shiki/themes/github-light.mjs",
  "shiki/themes/github-dark.mjs",
  "shiki/langs/http.mjs",
  "shiki/langs/json.mjs",
  "shiki/langs/html.mjs",
  "shiki/langs/javascript.mjs",
  "shiki/langs/css.mjs",
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(here, "./src") },
  },
  optimizeDeps: {
    include: previewDependencies,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: { ignored: ["**/.mygo/**", "**/build/**"] },
    warmup: { clientFiles: ["./src/lib/pretty.worker.ts"] },
    proxy: { "/api": process.env.ACRO_DEV_API_URL ?? "http://127.0.0.1:7777" },
  },
});
