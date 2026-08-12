import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(__dirname, "app/flowix-web");

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isMobile = mode === "mobile";
  const isEditorWebView = mode === "editor-webview";

  return {
    base: isEditorWebView ? "./" : "/",
    // 前端入口: app/flowix-web/ 作为 Vite 根, 让 index.html / entrypoints /
    // public 都在同一目录, 避免 Tauri / Vite 路径互相穿越。
    root: frontendRoot,
    publicDir: resolve(frontendRoot, "public"),
    build: {
      outDir: resolve(__dirname, isEditorWebView ? ".build/ios-editor" : ".build/web-dist"),
      emptyOutDir: true,
      rollupOptions: {
        input: resolve(frontendRoot, isEditorWebView ? "editor-webview.html" : "index.html"),
      },
    },

    plugins: [react()],
    resolve: {
      alias: {
        "@": frontendRoot,
        "@app": resolve(frontendRoot, "app"),
        "@features": resolve(frontendRoot, "features"),
        "@platform": resolve(frontendRoot, "platform"),
        "@shared": resolve(frontendRoot, "shared"),
        // A compile-time target selection; never use a runtime MODE branch
        // here, otherwise both application roots can enter one bundle.
        "@flowix-target-entry": resolve(
          frontendRoot,
          isMobile ? "entrypoints/mobile.tsx" : "entrypoints/desktop.tsx",
        ),
      },
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
          protocol: "ws",
          host,
          port: 1421,
        }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `backend` (relative to repo root)
        ignored: ["**/app/flowix-desktop/**", "**/app/flowix-mobile/**", "**/app/flowix-core/**", "**/app/flowix-cli/**", "**/app/target/**"],
      },
    },
  };
});
