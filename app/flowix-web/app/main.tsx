import { createRoot } from "react-dom/client";

const isMobile = import.meta.env.MODE === "mobile";
const isMac = navigator.platform.toUpperCase().includes("MAC");
document.documentElement.dataset.platform = isMac ? "mac" : "non-mac";

// Mobile intentionally ships with the warm, low-chroma Rock palette. Unlike
// desktop it has no theme settings surface, so resolve the palette before the
// first React paint instead of inheriting a stale desktop preference.
if (isMobile) {
  document.documentElement.dataset.theme = "rock";
}

async function mountApp() {
  // CSS is split per target so desktop editor*.css / sonner styles never ship
  // to mobile:
  //   - mobile: styles/mobile/index.css (fonts + Rock theme + Tailwind base +
  //     mobile modules) — a trimmed entry that drops ~110 KB of desktop editor
  //     styles while keeping the shared Rock visuals.
  //   - desktop: the full styles/index.css + sonner toast styles.
  if (isMobile) {
    await import("@/styles/mobile/index.css");
  } else {
    await import("@/styles/index.css");
    await import("sonner/dist/styles.css");
    // Desktop Tauri RPC bridge (sets window.__tauriRpc). The mobile client
    // invokes @tauri-apps/api/core directly via @platform/tauri/mobile-client,
    // so mobile must not pull the desktop barrel (agent/desktop/general client
    // modules) into its bundle.
    try {
      const { initTauriClient } = await import("@platform/tauri/client");
      initTauriClient();
    } catch (err) {
      console.error("[main.tsx] Failed to initialize Tauri:", err);
    }
  }

  const RootApp = isMobile
    ? (await import("@app/mobile/mobile-app")).MobileApp
    : (await import("@app/app")).default;

  createRoot(document.getElementById("root")!).render(<RootApp />);
}

void mountApp();
