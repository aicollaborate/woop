'use client';

import { useEffect, useState } from 'react';
import {
  Bot,
  Check,
  Database,
  PanelsTopLeft,
  Puzzle,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Input } from '@shared/ui/input';
import { AgentSection } from '@features/preferences/sections/agent';
import { SectionHeader } from '@features/preferences/sections/primitives';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { errorMessage } from '@/lib/error-message';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { deepseekHarness } from '@platform/tauri/client';
import type { DeepSeekHarnessPlugin, DeepSeekHarnessPluginCatalog } from '@platform/tauri/client';

type DshTab = 'models' | 'general' | 'plugins' | 'presets';

const DSH_TABS: readonly {
  id: DshTab;
  labelKey: I18nKey;
  icon: LucideIcon;
}[] = [
  { id: 'general', labelKey: 'preferences.dsh.tabs.general', icon: Settings2 },
  { id: 'models', labelKey: 'preferences.dsh.tabs.models', icon: Database },
  { id: 'plugins', labelKey: 'preferences.dsh.tabs.plugins', icon: Puzzle },
  { id: 'presets', labelKey: 'preferences.dsh.tabs.presets', icon: PanelsTopLeft },
];

const DSH_PRESETS: readonly {
  id: 'standard' | 'code' | 'minimal' | 'cordis';
  titleKey: I18nKey;
  descriptionKey: I18nKey;
}[] = [
  {
    id: 'standard',
    titleKey: 'agent.mode.standard',
    descriptionKey: 'agent.mode.standard.description',
  },
  {
    id: 'code',
    titleKey: 'agent.mode.code',
    descriptionKey: 'agent.mode.code.description',
  },
  {
    id: 'minimal',
    titleKey: 'agent.mode.minimal',
    descriptionKey: 'agent.mode.minimal.description',
  },
  {
    id: 'cordis',
    titleKey: 'agent.mode.cordis',
    descriptionKey: 'agent.mode.cordis.description',
  },
];

export function DshSettingsSection() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<DshTab>('general');
  const activeTabLabelKey = DSH_TABS.find((tab) => tab.id === activeTab)?.labelKey ?? DSH_TABS[0].labelKey;

  return (
    <div className="space-y-5">
      <SectionHeader
        title={t('preferences.dsh.title')}
        description={t('preferences.dsh.description')}
      />

      <div
        className="grid grid-cols-4 gap-1 rounded-lg border border-[var(--divider)] bg-[var(--muted)]/40 p-1"
        role="tablist"
        aria-label={t('preferences.dsh.title')}
      >
        {DSH_TABS.map(({ id, labelKey, icon: Icon }) => {
          const selected = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={cn(
                'flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs transition-colors',
                selected
                  ? 'bg-[color-mix(in_oklch,var(--card)_93%,#000)] font-medium text-[var(--primary)] shadow-sm'
                  : 'text-[var(--muted-foreground)] hover:bg-[var(--card)]/70 hover:text-[var(--foreground)]',
              )}
              onClick={() => setActiveTab(id)}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{t(labelKey)}</span>
            </button>
          );
        })}
      </div>

      <div role="tabpanel" aria-label={t(activeTabLabelKey)}>
        {activeTab === 'models' && (
          <AgentSection
            configStore={deepseekHarness}
            configChangeKind="dsh_config"
            testConnection={deepseekHarness.testConnection}
            modelDirectory={deepseekHarness}
          />
        )}
        {activeTab === 'general' && <GeneralTab />}
        {activeTab === 'plugins' && <PluginsTab />}
        {activeTab === 'presets' && <PresetsTab />}
      </div>
    </div>
  );
}

function GeneralTab() {
  const { t } = useI18n();
  const rows = [
    {
      icon: Bot,
      title: t('preferences.dsh.general.runtime'),
      value: t('preferences.dsh.general.runtimeValue'),
    },
    {
      icon: Database,
      title: t('preferences.dsh.general.provider'),
      value: t('preferences.dsh.general.providerValue'),
    },
    {
      icon: ShieldCheck,
      title: t('preferences.dsh.general.permission'),
      value: t('preferences.dsh.general.permissionValue'),
    },
    {
      icon: PanelsTopLeft,
      title: t('preferences.dsh.general.sessions'),
      value: t('preferences.dsh.general.sessionsValue'),
    },
  ] as const;

  return (
    <div className="space-y-2">
      <SectionHeader
        title={t('preferences.dsh.general.title')}
        className="flex h-8 items-center border-b-0 pb-0"
      />
      <div className="border-b border-[var(--divider)]" />
      <div className="divide-y divide-[var(--divider)] rounded-lg border border-[var(--divider)] bg-[var(--card)]">
        {rows.map(({ icon: Icon, title, value }) => (
          <div key={title} className="flex items-center gap-3 px-3.5 py-3">
            <Icon className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
            <span className="min-w-0 flex-1 text-sm text-[var(--foreground)]">{title}</span>
            <span className="text-right text-xs text-[var(--muted-foreground)]">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PluginsTab() {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<DeepSeekHarnessPluginCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  const normalizedQuery = query.trim().toLowerCase();

  useEffect(() => {
    let cancelled = false;
    void deepseekHarness.pluginCatalog().then((nextCatalog) => {
      if (!cancelled) {
        setCatalog(nextCatalog);
        setLoadError(null);
      }
    }).catch((error: unknown) => {
      if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, []);

  const togglePlugin = async (plugin: DeepSeekHarnessPlugin) => {
    if (!plugin.toggleable || togglingKey !== null) return;
    setTogglingKey(plugin.key);
    try {
      setCatalog(await deepseekHarness.setPluginEnabled(plugin.key, !plugin.enabled));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setTogglingKey(null);
    }
  };

  const groups: readonly { key: string; title: string; plugins: DeepSeekHarnessPlugin[] }[] = catalog === null
    ? []
    : [
        { key: 'host', title: t('preferences.dsh.plugins.host'), plugins: catalog.host },
        ...Object.entries(catalog.presets).map(([preset, plugins]) => ({
          key: `preset:${preset}`,
          title: `${t('preferences.dsh.plugins.preset')} · ${preset}`,
          plugins,
        })),
      ];

  return (
    <div className="space-y-2">
      {/* 分割线单独一行铺满宽度; 标题去掉 SectionHeader 自带的 pb + border,
          与搜索框同行 items-center 水平对齐 */}
      <div className="flex h-8 items-center gap-3">
        <SectionHeader
          title={t('preferences.dsh.plugins.title')}
          className="flex min-w-0 flex-1 items-center border-b-0 pb-0"
        />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('preferences.dsh.plugins.searchPlaceholder')}
          className="h-8 w-44 shrink-0"
        />
      </div>
      <div className="border-b border-[var(--divider)]" />
      <p className="text-xs text-[var(--muted-foreground)]">
        {t('preferences.dsh.plugins.hostHint')}
      </p>
      {/* WKWebView 下外层滚动容器吃不到底部间距, 在列表自身留 pb-10 兜底 */}
      <div className="space-y-2 pb-10">
        {loadError && <p className="rounded-lg border border-red-500/30 bg-red-500/5 px-3.5 py-3 text-xs text-red-600">{t('preferences.dsh.plugins.loadError')}: {loadError}</p>}
        {catalog === null && loadError === null && <p className="text-xs text-[var(--muted-foreground)]">{t('preferences.dsh.plugins.loading')}</p>}
        {groups.map(({ key, title, plugins }) => {
          const visiblePlugins = plugins.filter(({ id, name }) =>
            `${id} ${name}`.toLowerCase().includes(normalizedQuery),
          );
          if (visiblePlugins.length === 0) return null;
          return (
            <div key={key} className="space-y-2">
              <h4 className="pt-2 text-xs font-medium text-[var(--muted-foreground)]">{title}</h4>
              {visiblePlugins.map((plugin) => (
                <div
                  key={`${key}:${plugin.key}`}
                  className="flex items-start gap-3 rounded-lg border border-[var(--divider)] bg-[var(--card)] px-3.5 py-3"
                >
                  <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_oklch,var(--primary)_12%,transparent)] text-[var(--primary)]">
                    <Puzzle className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="truncate text-sm font-medium text-[var(--foreground)]">{plugin.id}</h4>
                      <div className="inline-flex shrink-0 items-center gap-2">
                        <Check className={cn('h-3 w-3', plugin.enabled ? 'text-emerald-500' : 'text-[var(--muted-foreground)]')} />
                        <span className="text-[11px] text-[var(--muted-foreground)]">
                          {t(plugin.enabled ? 'preferences.dsh.plugins.enabled' : 'preferences.dsh.plugins.disabled')}
                        </span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={plugin.enabled}
                          aria-label={`${t('preferences.dsh.plugins.toggle')}: ${plugin.id}`}
                          title={plugin.toggleable ? t('preferences.dsh.plugins.toggle') : t('preferences.dsh.plugins.protected')}
                          disabled={!plugin.toggleable || togglingKey !== null}
                          onClick={() => void togglePlugin(plugin)}
                          className={cn(
                            'relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                            plugin.enabled ? 'bg-[var(--primary)]' : 'bg-[var(--muted)]',
                          )}
                        >
                          <span
                            className={cn(
                              'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                              plugin.enabled ? 'translate-x-4' : 'translate-x-0',
                            )}
                          />
                        </button>
                      </div>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-[var(--muted-foreground)]">{plugin.name}</p>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PresetsTab() {
  const { t } = useI18n();

  return (
    <div className="space-y-2">
      <SectionHeader
        title={t('preferences.dsh.presets.title')}
        className="flex h-8 items-center border-b-0 pb-0"
      />
      <div className="border-b border-[var(--divider)]" />
      <div className="space-y-2">
        {DSH_PRESETS.map(({ id, titleKey, descriptionKey }) => (
          <div
            key={id}
            className="rounded-lg border border-[var(--divider)] bg-[var(--card)] px-3.5 py-3"
          >
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--primary)_12%,transparent)] text-[var(--primary)]">
                <PanelsTopLeft className="h-3 w-3" />
              </span>
              <h4 className="text-sm font-medium text-[var(--foreground)]">{t(titleKey)}</h4>
              <span className="ml-auto rounded-full bg-[var(--muted)] px-2 py-0.5 text-[10px] text-[var(--muted-foreground)]">
                {id}
              </span>
            </div>
            <p className="mt-1.5 pl-7 text-xs leading-5 text-[var(--muted-foreground)]">
              {t(descriptionKey)}
            </p>
          </div>
        ))}
      </div>
      <p className="pb-10 text-xs text-[var(--muted-foreground)]">
        {t('preferences.dsh.presets.hint')}
      </p>
    </div>
  );
}
