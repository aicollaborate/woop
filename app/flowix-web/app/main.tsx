import { createRoot } from "react-dom/client";
import "sonner/dist/styles.css";
import "@/styles/index.css";

// Initialize Tauri RPC
import { initTauriClient } from "@platform/tauri/client";

const isMac = navigator.platform.toUpperCase().includes("MAC");
document.documentElement.dataset.platform = isMac ? "mac" : "non-mac";

// Mobile intentionally ships with the warm, low-chroma Rock palette. Unlike
// desktop it has no theme settings surface, so resolve the palette before the
// first React paint instead of inheriting a stale desktop preference.
if (import.meta.env.MODE === "mobile") {
  document.documentElement.dataset.theme = "rock";
}

try {
  initTauriClient();
} catch (err) {
  console.error("[main.tsx] Failed to initialize Tauri:", err);
}

async function mountApp() {
  const RootApp = import.meta.env.MODE === "mobile"
    ? (await import("@app/mobile/mobile-app")).MobileApp
    : (await import("@app/app")).default;

  createRoot(document.getElementById("root")!).render(<RootApp />);
}

void mountApp();
