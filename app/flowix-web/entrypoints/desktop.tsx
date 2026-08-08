import { createRoot } from "react-dom/client";

import App from "@app/app";
import "@/styles/index.css";
import "sonner/dist/styles.css";
import { initTauriClient } from "@platform/tauri/client";

const isMac = navigator.platform.toUpperCase().includes("MAC");
document.documentElement.dataset.platform = isMac ? "mac" : "non-mac";

// The desktop bridge is intentionally initialized only by the desktop entry.
// Mobile uses the capability-limited @platform/tauri/mobile-client facade.
try {
  initTauriClient();
} catch (error) {
  console.error("[desktop entry] Failed to initialize Tauri:", error);
}

createRoot(document.getElementById("root")!).render(<App />);
