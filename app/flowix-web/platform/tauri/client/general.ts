import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type { UserSettings } from '@/lib/constants';
import type { AgentAccessConfig, AgentAccessEntry } from '@/lib/types/agent-access';
import type { UsageInfo } from '@/types/agent';
import type { AgentConfig, TestConnectionResult } from './agent';

export const preferences = {
  get: () => invoke<UserSettings>('get_preference'),
  set: (preference: UserSettings) => invoke<void>('set_preference', { preference }),
};

export interface BootFeatures {
  experimental: boolean;
}

export const boot = {
  getFeatures: () => invoke<BootFeatures>('get_boot_features'),
};

export interface FontCacheStatus {
  fontId: string;
  cached: boolean;
}

export interface CachedFontFile {
  family: string;
  weight: string;
  style: string;
  format: string;
  unicodeRange?: string | null;
  path: string;
}

export interface CachedFontResult {
  fontId: string;
  cached: boolean;
  files: CachedFontFile[];
}

export const fontCache = {
  getStatus: () => invoke<FontCacheStatus[]>('get_font_cache_status'),
  ensureCached: (fontId: string) => invoke<CachedFontResult>('ensure_font_cached', { fontId }),
  toAssetUrl: (path: string) => convertFileSrc(path),
};

export interface WebPageMetadata {
  url: string;
  title: string;
  description: string;
  image: string;
}

export interface AgentRoleMemoItem {
  memoId: string;
  roleName: string;
  filename: string;
  memoIcon?: string | null;
  notebookId: string;
  notebookName: string;
  notebookIcon?: string | null;
}

export const web = {
  parsePage: (url: string) => invoke<WebPageMetadata>('parse_web_page', { url }),
};

// AI Config (backend ~/.flowix/agent-config.toml)
// 鈹€ 鐪熸簮鍦ㄥ悗绔枃浠? 鍋忓ソ璁剧疆鐨?AI 妯″瀷 tab 鐢?get/set 鍔犺浇涓庝繚瀛樸€?
//   chat 璋冪敤璧?backend AgentManager, 鏃犻渶鍓嶇鍐?init銆?
export const aiConfig = {
  get: () => invoke<{ model: AgentConfig }>('get_ai_config'),
  set: (config: AgentConfig) => invoke<void>('set_ai_config', { config: { model: config } }),
  /**
   * One-shot connectivity probe for the form the user is editing.
   *
   * Distinct from `set`: doesn't write to disk, doesn't broadcast
   * `user-config-changed`, and uses a fresh provider instance per call
   * (so a failing probe can't poison the production chat cache).
   *
   * The backend (`commands/settings.rs::test_ai_connection`) returns a
   * `TestConnectionResult` even on failure — the IPC boundary stays
   * 200-shaped and the failure is expressed via `result.error.kind`.
   */
  testConnection: (config: AgentConfig) =>
    invoke<TestConnectionResult>('test_ai_connection', { config }),
};

/** DeepSeek Harness model probe. This uses dsh-host/runtime and is separate
 * from the Flowix Agent provider probe above. */
export const deepseekHarness = {
  // DeepSeek Harness uses its own llm-pi-ai settings document, separate from
  // the Flowix Agent's agent-config.toml.
  get: () => invoke<{ model: AgentConfig }>('get_deepseek_harness_config'),
  // The Rust command returns Vec<AiConfigFile> directly. Each item keeps the
  // same `{ model: ... }` envelope as the single-config response above.
  list: () => invoke<{ model: AgentConfig }[]>('get_deepseek_harness_configs'),
  set: (config: AgentConfig) =>
    invoke<void>('set_deepseek_harness_config', { config: { model: config } }),
  add: (config: AgentConfig) =>
    invoke<void>('add_deepseek_harness_model', { config: { model: config } }),
  testConnection: (config: AgentConfig) =>
    invoke<TestConnectionResult>('test_deepseek_harness_connection', { config }),
  modelCatalog: () =>
    invoke<DeepSeekHarnessModelCatalog>('deepseek_harness_model_catalog'),
  pluginCatalog: () =>
    invoke<DeepSeekHarnessPluginCatalog>('deepseek_harness_plugin_catalog'),
  setPluginEnabled: (pluginKey: string, enabled: boolean) =>
    invoke<DeepSeekHarnessPluginCatalog>('set_deepseek_harness_plugin_enabled', {
      pluginKey,
      enabled,
    }),
  discoverModels: (config: AgentConfig) =>
    invoke<DeepSeekHarnessModelListing>('discover_deepseek_harness_models', { config }),
  sessionUsage: async (threadId: string): Promise<DeepSeekHarnessSessionSnapshot | null> => {
    const usage = await invoke<DeepSeekHarnessSessionUsage | null>(
      'deepseek_harness_session_usage',
      { threadId },
    );
    if (usage === null) return null;
    return snapshotFromHarnessUsage(usage);
  },
};

function snapshotFromHarnessUsage(
  usage: DeepSeekHarnessSessionUsage,
): DeepSeekHarnessSessionSnapshot {
  return {
    model: usage.modelId ?? undefined,
    usage: {
      input_tokens: usage.inputTokens,
      cached_input_tokens: usage.cacheReadTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens
        + usage.cacheReadTokens
        + usage.cacheWriteTokens
        + usage.outputTokens,
      model_context_window: usage.contextWindow ?? null,
      context_used_tokens: usage.contextTokens ?? null,
    },
  };
}

export interface DeepSeekHarnessSessionSnapshot {
  model?: string;
  usage: UsageInfo;
}

export interface DeepSeekHarnessSessionUsage {
  sessionId: string;
  modelId?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextTokens?: number | null;
  contextWindow?: number | null;
}

export interface DeepSeekHarnessModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface DeepSeekHarnessCatalogProvider {
  provider: string;
  displayName?: string;
  baseUrl?: string;
  api?: string;
  takesApiKey: boolean;
  models: DeepSeekHarnessModel[];
}

export interface DeepSeekHarnessModelCatalog {
  providers: DeepSeekHarnessCatalogProvider[];
}

export interface DeepSeekHarnessModelListing {
  models: DeepSeekHarnessModel[];
}

export interface DeepSeekHarnessPlugin {
  key: string;
  id: string;
  name: string;
  enabled: boolean;
  toggleable: boolean;
  scope: 'host' | 'preset';
  preset?: string;
}

export interface DeepSeekHarnessPluginCatalog {
  platform: string;
  host: DeepSeekHarnessPlugin[];
  presets: Record<string, DeepSeekHarnessPlugin[]>;
}

// Agent access roots (backend ~/.flowix/agent-access.json).
// Source of truth is `agent_access::AgentAccessStore`; it mirrors notebooks and user-added folders.
// 鏁翠唤 set 鏇夸唬閫愭潯 patch, 閬垮厤鍓嶇瀵瑰崟鏉?entry 绠?diff; 鍐欐椂璧颁箰瑙傛洿鏂?
// (鏈湴鍏堟敼, 澶辫触 `loadInitial` 鍥炴粴)銆?
export const agentAccess = {
  get: () => invoke<AgentAccessConfig>('get_agent_access'),
  set: (config: AgentAccessConfig) => invoke<void>('set_agent_access', { config }),
  addFolderFromPicker: () =>
    invoke<AgentAccessEntry | null>('add_agent_access_folder_from_picker'),
};

export interface SystemTagLayoutItem {
  id: string;
  parentId: string | null;
}

export interface NotebookTagSystemMetadata {
  hidden: string[];
  order: string[];
  layout: SystemTagLayoutItem[];
  /**
   * 置顶标签簿: parent fullPath → MRU 顺序的子 fullPath 列表。
   * 空 key (`""`) 表示 root 级别。Vec 索引 0 = 最近置顶 = 渲染最前。
   * 旧版持久化可能没有这个字段, 加载时会默认空对象。
   */
  pinnedByParent: Record<string, string[]>;
}

// System metadata (backend ~/.flowix/boot/system.json).
export const system = {
  getTagMetadata: (notebookId: string) =>
    invoke<NotebookTagSystemMetadata>('get_tag_system_metadata', { notebookId }),
  setTagLayout: (notebookId: string, layout: SystemTagLayoutItem[]) =>
    invoke<void>('set_tag_system_layout', { notebookId, layout }),
  /**
   * 写回某 parent 下的 pinned 列表。
   * - `parentId` 是空字符串时表 root。
   * - `pinned` 数组顺序 = MRU（index 0 = 最近置顶）。
   * - 空数组语义 = 该 parent 下不再有 pinned（持久化层会清空 key）。
   */
  setTagPinned: (notebookId: string, parentId: string, pinned: string[]) =>
    invoke<void>('set_tag_system_pinned', { notebookId, parentId, pinned }),
};

// Memos
