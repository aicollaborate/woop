'use client';

import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import type { UserSettings } from '@/lib/constants';
import { useShallow } from 'zustand/react/shallow';

/**
 * 偏好设置 hook — 薄包装层, 委托给全局 zustand store。
 *
 * 真实状态在 lib/store/user-settings-store.ts: 全进程单例, 多个调用方
 * 共享同一份 settings。任何 updateSettings 调用立即通知所有订阅者。
 *
 * 启动加载 (loadInitial) 需在 app.tsx 顶层显式调一次, 见 app.tsx。
 */
export function useUserSettings<T>(selector: (settings: UserSettings) => T): T {
  return useUserSettingsStore((state) => selector(state.settings));
}

export function useUserSettingsActions() {
  return useUserSettingsStore(
    useShallow((state) => ({
      updateSettings: state.updateSettings,
      setShortcutOverride: state.setShortcutOverride,
      resetShortcutOverride: state.resetShortcutOverride,
      resetAllShortcutOverrides: state.resetAllShortcutOverrides,
    })),
  );
}
