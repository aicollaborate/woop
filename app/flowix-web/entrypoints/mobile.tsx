import { createRoot } from "react-dom/client";

import { MobileApp } from "@app/mobile/mobile-app";
import "@/styles/mobile/index.css";

// Mobile intentionally has one fixed palette and no desktop theme settings.
// Set it before React's first paint so a previous desktop preference cannot
// flash while the native webview starts.
document.documentElement.dataset.platform = "non-mac";
document.documentElement.dataset.theme = "rock";

createRoot(document.getElementById("root")!).render(<MobileApp />);
