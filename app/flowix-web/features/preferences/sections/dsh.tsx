'use client';

import { useState } from 'react';
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
import { cn } from '@/lib/utils';
import { deepseekHarness } from '@platform/tauri/client';

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

const DSH_PLUGINS: readonly {
  name: string;
  descriptionKey: I18nKey;
}[] = [
  { name: 'File tools', descriptionKey: 'preferences.dsh.plugins.file' },
  { name: 'Shell / Bash', descriptionKey: 'preferences.dsh.plugins.shell' },
  { name: 'Web search', descriptionKey: 'preferences.dsh.plugins.web' },
  { name: 'Skills', descriptionKey: 'preferences.dsh.plugins.skills' },
  { name: 'Subagents', descriptionKey: 'preferences.dsh.plugins.subagents' },
  { name: 'Workflows', descriptionKey: 'preferences.dsh.plugins.workflows' },
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
  const normalizedQuery = query.trim().toLowerCase();
  const visiblePlugins = DSH_PLUGINS.filter(({ name }) =>
    name.toLowerCase().includes(normalizedQuery),
  );

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
      {/* WKWebView 下外层滚动容器吃不到底部间距, 在列表自身留 pb-10 兜底 */}
      <div className="space-y-2 pb-10">
        {visiblePlugins.map(({ name, descriptionKey }) => (
          <div
            key={name}
            className="flex items-start gap-3 rounded-lg border border-[var(--divider)] bg-[var(--card)] px-3.5 py-3"
          >
            <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_oklch,var(--primary)_12%,transparent)] text-[var(--primary)]">
              <Puzzle className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-medium text-[var(--foreground)]">{name}</h4>
                <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-[var(--muted-foreground)]">
                  <Check className="h-3 w-3 text-emerald-500" />
                  {t('preferences.dsh.plugins.enabled')}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">{t(descriptionKey)}</p>
            </div>
          </div>
        ))}
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
