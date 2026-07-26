'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DEFAULT_APP_LANGUAGE,
  getMessages,
  isLanguageLoaded,
  loadLanguage,
  sanitizeAppLanguage,
  type AppLanguage,
  type I18nKey,
} from '@/lib/i18n/locales';

export type I18nParams = Record<string, string | number>;

function interpolate(template: string, params?: I18nParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const value = params[name];
    return value == null ? match : String(value);
  });
}

interface I18nContextValue {
  language: AppLanguage;
  t: (key: I18nKey, params?: I18nParams) => string;
}

const I18nContext = createContext<I18nContextValue>({
  language: DEFAULT_APP_LANGUAGE,
  t: (key) => getMessages(DEFAULT_APP_LANGUAGE)[key],
});

export function I18nProvider({
  language,
  children,
}: {
  language: AppLanguage;
  children: ReactNode;
}) {
  const normalizedLanguage = sanitizeAppLanguage(language);

  // version 在非默认语言加载完成时自增, 触发 useMemo 重算 -> context value
  // 引用变化 -> 消费者重渲染, 使 t 切到新语言消息。加载期间 t 回退默认语言。
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (isLanguageLoaded(normalizedLanguage)) return;
    let cancelled = false;
    void loadLanguage(normalizedLanguage).then(() => {
      if (!cancelled) setVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [normalizedLanguage]);

  const value = useMemo<I18nContextValue>(() => ({
    language: normalizedLanguage,
    t: (key, params) =>
      interpolate(
        getMessages(normalizedLanguage)[key] ?? getMessages(DEFAULT_APP_LANGUAGE)[key],
        params,
      ),
  }), [normalizedLanguage, version]);

  useEffect(() => {
    document.documentElement.lang = normalizedLanguage;
  }, [normalizedLanguage]);

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export function translate(language: AppLanguage, key: I18nKey, params?: I18nParams): string {
  const normalizedLanguage = sanitizeAppLanguage(language);
  return interpolate(
    getMessages(normalizedLanguage)[key] ?? getMessages(DEFAULT_APP_LANGUAGE)[key],
    params,
  );
}
