import zhCNMessages from './messages.zh-CN';

export const APP_LANGUAGES = ["zh-CN", "en-US"] as const;

export type AppLanguage = (typeof APP_LANGUAGES)[number];

export const DEFAULT_APP_LANGUAGE = "zh-CN" satisfies AppLanguage;

export const LANGUAGE_OPTIONS: { value: AppLanguage; label: string }[] = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en-US", label: "English" },
];

export function sanitizeAppLanguage(value: unknown): AppLanguage {
  return APP_LANGUAGES.includes(value as AppLanguage)
    ? (value as AppLanguage)
    : DEFAULT_APP_LANGUAGE;
}

// i18n 按语言分包: 默认语言 zh-CN eager (进主 bundle), en-US 动态 import
// (独立 chunk, 切换时加载)。translate / useI18n 始终同步读 getMessages(lang),
// 未加载的语言回退到默认语言; I18nProvider 在 language 变化时触发 loadLanguage
// 并在就绪后重渲染。
//
// key 类型以 zh-CN 为基准派生, messages.en-US.ts 用 Record<keyof typeof zhCN, string>
// 约束保证两语言 key 集合一致 (编译期检查)。
export type I18nKey = keyof typeof zhCNMessages;
export type MessageMap = Record<I18nKey, string>;

const loadedMessages: Partial<Record<AppLanguage, MessageMap>> = {
  "zh-CN": zhCNMessages,
};

let enUSPromise: Promise<MessageMap> | null = null;

/** 同步读取某语言消息表; 未加载时回退到默认语言 (zh-CN)。 */
export function getMessages(lang: AppLanguage): MessageMap {
  return loadedMessages[lang] ?? loadedMessages[DEFAULT_APP_LANGUAGE]!;
}

/** 该语言消息表是否已就绪 (默认语言始终 true)。 */
export function isLanguageLoaded(lang: AppLanguage): boolean {
  return lang === DEFAULT_APP_LANGUAGE || loadedMessages[lang] !== undefined;
}

/** 异步加载某语言消息表 (已加载则立即 resolve); 默认语言无需加载。 */
export function loadLanguage(lang: AppLanguage): Promise<MessageMap> {
  if (lang === DEFAULT_APP_LANGUAGE) {
    return Promise.resolve(zhCNMessages as MessageMap);
  }
  const cached = loadedMessages[lang];
  if (cached) return Promise.resolve(cached);
  if (lang === "en-US") {
    if (!enUSPromise) {
      enUSPromise = import('./messages.en-US').then((module) => {
        const msgs = module.default as unknown as MessageMap;
        loadedMessages["en-US"] = msgs;
        return msgs;
      });
    }
    return enUSPromise;
  }
  return Promise.resolve(zhCNMessages as MessageMap);
}
