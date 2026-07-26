import { beforeAll } from 'vitest';
import { loadLanguage } from '@/lib/i18n';

// i18n 按语言分包后, en-US 走动态 import (独立 chunk); 单测不挂 I18nProvider,
// 直接调 translate('en-US', ...) 的测试需预先加载 en-US 消息表, 否则
// getMessages('en-US') 回退到 zh-CN。loadLanguage 内部缓存 promise, 首个文件
// 触发实际加载, 后续文件立即 resolve。
beforeAll(async () => {
  await loadLanguage('en-US');
});
