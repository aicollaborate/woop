import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(__dirname, "app/flowix-web");

// KaTeX ships every font in three formats (woff2 / woff / ttf) so it can serve
// ancient browsers, but Flowix only targets modern Chromium via Tauri. Strip
// the woff and ttf fallback entries from `katex.min.css` so the bundler emits
// the woff2 variant only. Each font family goes from ~3 emitted assets down to
// one (~250 KB total instead of ~1 MB).
function katexWoff2Only(): Plugin {
  return {
    name: "flowix-katex-woff2-only",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("node_modules/katex/dist/katex.min.css")) {
        return null;
      }
      const transformed = code
        .replace(
          /,url\([^)]+\.woff\) format\(["']woff["']\)/g,
          "",
        )
        .replace(
          /,url\([^)]+\.ttf\) format\(["']truetype["']\)/g,
          "",
        );
      if (transformed === code) {
        return null;
      }
      return { code: transformed, map: null };
    },
  };
}

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const isMobile = mode === "mobile";
  const isEditorWebView = mode === "editor-webview";

  return {
    // Packaged Tauri pages are served from an application protocol rather
    // than an HTTP origin. Keep every emitted asset URL relative in builds so
    // CSS, fonts, and lazy chunks resolve beside index.html in the installed
    // app. The dev server still needs an origin-root base for HMR.
    base: command === "build" || isEditorWebView ? "./" : "/",
    // 鍓嶇鍏ュ彛: app/flowix-web/ 浣滀负 Vite 鏍? 璁?index.html / entrypoints /
    // public 閮藉湪鍚屼竴鐩綍, 閬垮厤 Tauri / Vite 璺緞浜掔浉绌胯秺銆?
    root: frontendRoot,
    publicDir: resolve(frontendRoot, "public"),
    build: {
      outDir: resolve(__dirname, isEditorWebView ? ".build/ios-editor" : ".build/web-dist"),
      emptyOutDir: true,
      rollupOptions: {
        input: resolve(frontendRoot, isEditorWebView ? "editor-webview.html" : "index.html"),
      },
    },

    plugins: [react(), katexWoff2Only()],
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
