'use client';

import { lazy, Suspense, useEffect, useState } from "react";
import { ErrorBoundary } from "@shared/error-boundary";
import { Toaster } from "sonner";
import { useUserSettings } from "@features/preferences/hooks/use-user-settings";
import { useUserSettingsStore } from "@features/preferences/store/user-settings-store";
import { useAgentRuntimeStore } from "@features/agent/store/agent-runtime-store";
import { useApplyFontSettings } from "@features/preferences/hooks/use-apply-font-settings";
import { ThemeProvider } from "@features/theme";
import { ShortcutsProvider } from "@features/shortcuts";
import { I18nProvider } from "@/lib/i18n";
import { TooltipProvider } from "@shared/ui/tooltip";
import "@features/shortcuts/actions";
import { listenToUserConfigChanges, windows } from "@platform/tauri/client";
import { syncUserConfigChange } from "./user-config-sync";
import { invalidateDshModelConfigs } from "@features/agent/store/dsh-model-config-store";
import { createLogger } from "@/lib/logger";

const logger = createLogger("app");

const MainLayout = lazy(() =>
  import("@features/shell")
    .then((module) => ({ default: module.MainLayout }))
    .catch((error) => {
      // A packaged Tauri WebView can fail to resolve a lazy chunk while the
      // root document itself has already loaded. Do not leave the static
      // startup spinner covering the error boundary forever in that case.
      removeAppLoading();
      throw error;
    })
);

const PreferencesView = lazy(() =>
  import("@features/preferences").then((module) => ({ default: module.PreferencesView }))
);

const TabWindow = lazy(() =>
  import("./tab-window/tab-window").then((module) => ({ default: module.TabWindow }))
);

const MainWindowEffects = lazy(() =>
  import("./main-window-effects").then((module) => ({ default: module.MainWindowEffects }))
);

const AgentWindowEffects = lazy(() =>
  import("./agent-window-effects").then((module) => ({ default: module.AgentWindowEffects }))
);

function AppToaster() {
  return (
    <Toaster
      className="flowix-toaster"
      position="top-center"
      richColors={false}
      closeButton={false}
    />
  );
}

function removeAppLoading() {
  document.getElementById("app-loading")?.remove();
}

function AppReadySignal() {
  useEffect(() => {
    removeAppLoading();
  }, []);

  return null;
}

function MainWindowReadySignal() {
  useEffect(() => {
    removeAppLoading();
    void windows.showMain().catch((error) => {
      logger.error("show main window failed", { error });
    });
  }, []);

  return null;
}

function App() {
  const [hash, setHash] = useState(() => window.location.hash);
  const language = useUserSettings((settings) => settings.language);
  const format = useUserSettings((settings) => settings.format);
  const shortcutOverrides = useUserSettings((settings) => settings.shortcuts);
  const loadInitial = useUserSettingsStore((s) => s.loadInitial);
  const flushPending = useUserSettingsStore((s) => s.flushPending);
  const refreshAgentRuntime = useAgentRuntimeStore((s) => s.refresh);
  useApplyFontSettings(format);

  useEffect(() => {
    // The static loading screen is only a first-paint fallback. It must not
    // depend on a lazy route resolving: if a packaged chunk is unavailable,
    // ErrorBoundary should be visible instead of an endless spinner.
    removeAppLoading();

    const isAuxiliaryWindow = hash.startsWith("#tab-window") || hash.startsWith("#preferences");
    if (!isAuxiliaryWindow) {
      void windows.showMain().catch((error) => {
        logger.error("show main window failed during app bootstrap", { error });
      });
    }
  }, [hash]);

  useEffect(() => {
    loadInitial();
    return () => {
      void flushPending();
    };
  }, [loadInitial, flushPending]);

  useEffect(() => {
    return listenToUserConfigChanges((kind) => {
      if (kind === "dsh_config") invalidateDshModelConfigs();
      syncUserConfigChange(kind, {
        reloadPreferences: loadInitial,
        refreshAgentRuntime: () => refreshAgentRuntime({ force: true }),
      });
    });
  }, [loadInitial, refreshAgentRuntime]);

  useEffect(() => {
    const handleHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", handleHashChange);

    return () => {
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  const isTabWindow = hash.startsWith("#tab-window");
  const isPreferencesWindow = hash.startsWith("#preferences");

  if (isTabWindow) {
    return (
      <ErrorBoundary language={language}>
        <AppToaster />
        <I18nProvider language={language}>
          <ThemeProvider>
            <Suspense fallback={null}>
              <AgentWindowEffects />
            </Suspense>
            <TooltipProvider>
              <ShortcutsProvider overrides={shortcutOverrides}>
                <Suspense fallback={null}>
                  <TabWindow />
                  <AppReadySignal />
                </Suspense>
              </ShortcutsProvider>
            </TooltipProvider>
          </ThemeProvider>
        </I18nProvider>
      </ErrorBoundary>
    );
  }

  if (isPreferencesWindow) {
    const tab = hash.split("/")[1] || undefined;
    return (
      <ErrorBoundary language={language}>
        <AppToaster />
        <I18nProvider language={language}>
          <ThemeProvider>
            <TooltipProvider>
              <ShortcutsProvider overrides={shortcutOverrides}>
              <Suspense fallback={null}>
                <PreferencesView initialTab={tab} />
                <AppReadySignal />
              </Suspense>
              </ShortcutsProvider>
            </TooltipProvider>
          </ThemeProvider>
        </I18nProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary language={language}>
      <AppToaster />
      <I18nProvider language={language}>
        <ThemeProvider>
          <Suspense fallback={null}>
            <AgentWindowEffects />
          </Suspense>
          <Suspense fallback={null}>
            <MainWindowEffects />
          </Suspense>
          <TooltipProvider>
            <ShortcutsProvider overrides={shortcutOverrides}>
              <Suspense fallback={null}>
                <MainLayout />
                <MainWindowReadySignal />
              </Suspense>
            </ShortcutsProvider>
          </TooltipProvider>
        </ThemeProvider>
      </I18nProvider>
    </ErrorBoundary>
  );
}

export default App;
