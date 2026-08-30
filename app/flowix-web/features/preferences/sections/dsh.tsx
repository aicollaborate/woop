'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Bot,
  Check,
  Database,
  Loader2,
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
import { AgentIcon } from '@features/agent/components/agent-icon';
import { deepseekHarness } from '@platform/tauri/client';
import type { DeepSeekHarnessPlugin, DeepSeekHarnessPluginCatalog } from '@platform/tauri/client';
import { dshIntegration, type DshIntegrationStatus } from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import { Button } from '@shared/ui/button';
import { useDshRuntimeInstaller } from '@features/preferences/hooks/use-dsh-runtime-installer';

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
  const [useLocalDevRuntime, setUseLocalDevRuntime] = useState(false);
  const [status, setStatus] = useState<DshIntegrationStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const activeTabLabelKey = DSH_TABS.find((tab) => tab.id === activeTab)?.labelKey ?? DSH_TABS[0].labelKey;

  const refreshStatus = useCallback(async () => {
    setStatusError(null);
    try {
      setStatus(await dshIntegration.status());
    } catch (value) {
      setStatusError(value instanceof Error ? value.message : String(value));
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    return subscribe('dsh-runtime-status-changed', () => {
      void refreshStatus();
    });
  }, [refreshStatus]);

  const handleUninstalled = (next: DshIntegrationStatus) => {
    setStatus(next);
    setActiveTab('general');
  };

  if (status === null) {
    return (
      <div className="flex min-h-[min(560px,calc(100vh-220px))] flex-col">
        <SectionHeader
          title={t('preferences.dsh.title')}
          description={t('preferences.dsh.description')}
        />
        <div className="flex flex-1 items-center justify-center px-8 py-12 text-center">
          <div className="space-y-3">
            {!statusError && (
              <Loader2 className="mx-auto h-7 w-7 animate-spin text-[var(--primary)]" />
            )}
            <p className="text-sm text-[var(--muted-foreground)]">
              {statusError ?? t('preferences.dsh.setup.loading')}
            </p>
            {statusError && (
              <Button type="button" size="sm" variant="outline" onClick={() => void refreshStatus()}>
                {t('preferences.dsh.setup.retry')}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!status.installed && !(import.meta.env.DEV && useLocalDevRuntime)) {
    if (import.meta.env.DEV) {
      return (
        <div className="flex min-h-[min(560px,calc(100vh-220px))] flex-col">
          <DshDevRuntimeNotice onContinue={() => setUseLocalDevRuntime(true)} />
        </div>
      );
    }
    return (
      <div className="flex min-h-[min(560px,calc(100vh-220px))] flex-col">
        <DshInstallPage initialStatus={status} onInstalled={setStatus} />
      </div>
    );
  }

  const displayedStatus = import.meta.env.DEV && useLocalDevRuntime
    ? { ...status, installed: true }
    : status;

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
        {activeTab === 'general' && <GeneralTab initialStatus={displayedStatus} onUninstalled={handleUninstalled} />}
        {activeTab === 'plugins' && <PluginsTab />}
        {activeTab === 'presets' && <PresetsTab />}
      </div>
    </div>
  );
}

function DshDevRuntimeNotice({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center px-1 py-2">
      <div className="w-full max-w-xl rounded-2xl border border-[var(--divider)] bg-[var(--card)] p-8 text-center shadow-sm">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-[color-mix(in_oklch,var(--primary)_12%,transparent)] text-[var(--primary)]">
          <AgentIcon typeKey="deepseek-harness" alt="" className="h-8 w-8" />
        </div>
        <h3 className="mt-5 text-lg font-semibold text-[var(--foreground)]">Dev 本地 DSH</h3>
        <p className="mt-2 text-sm text-[var(--muted-foreground)]">
          开发版本使用本地 dsh-host 和 runtime，不下载或安装远程 DSH。
        </p>
        <Button type="button" className="mt-8" onClick={onContinue}>
          继续使用本地 DSH
        </Button>
      </div>
    </div>
  );
}

function DshInstallPage({
  initialStatus,
  onInstalled,
}: {
  initialStatus: DshIntegrationStatus;
  onInstalled: (status: DshIntegrationStatus) => void;
}) {
  const { t } = useI18n();
  const { busy, error, progress, install, cancel } = useDshRuntimeInstaller(initialStatus);
  const [archiveSize, setArchiveSize] = useState<number | null>(initialStatus.archiveSize ?? null);
  const canCancel = busy && progress?.phase !== 'downloaded';

  useEffect(() => {
    if (initialStatus.installed) return;
    void dshIntegration.archiveSize().then((size) => setArchiveSize(size));
  }, [initialStatus.installed]);

  const startInstall = async () => {
    try {
      const status = await install();
      if (status) {
        onInstalled(status);
        toast.success(t('preferences.dsh.setup.installSuccess'));
      }
    } catch {
      // The hook owns and exposes the rendered error state.
    }
  };

  const cancelInstall = async () => {
    if (await cancel()) toast.info(t('preferences.dsh.setup.cancelled'));
  };

  return (
    <div className="flex flex-1 items-center justify-center px-1 py-2">
      <div className="w-full max-w-xl rounded-2xl border border-[var(--divider)] bg-[var(--card)] p-8 text-center shadow-sm">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-[color-mix(in_oklch,var(--primary)_12%,transparent)] text-[var(--primary)]">
          <AgentIcon typeKey="deepseek-harness" alt="" className="h-8 w-8" />
        </div>
        <h3 className="mt-5 text-lg font-semibold text-[var(--foreground)]">
          {t('preferences.dsh.setup.title')}
        </h3>
        <p className="mt-2 text-sm text-[var(--muted-foreground)]">
          {t('preferences.dsh.setup.description')}
        </p>
        {archiveSize != null && (
          <p className="mt-3 text-xs text-[var(--muted-foreground)]">
            {t('preferences.dsh.runtime.packageSize')}: {formatDshArchiveSize(archiveSize)}
          </p>
        )}

        <div className="mt-[60px] flex justify-center gap-2">
          <Button type="button" onClick={() => void startInstall()} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {busy ? t('preferences.dsh.setup.installing') : t('preferences.dsh.setup.install')}
          </Button>
          {canCancel && (
            <Button type="button" variant="outline" onClick={() => void cancelInstall()}>
              {t('preferences.dsh.setup.cancel')}
            </Button>
          )}
        </div>

        {busy && progress && (
          <div className="mx-auto mt-6 max-w-md space-y-2 text-left">
            <div className="flex justify-between text-xs text-[var(--muted-foreground)]">
              <span>{t('preferences.dsh.setup.downloadProgress')}</span>
              <span>{progress.percent == null ? '…' : `${progress.percent}%`}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-[var(--muted)]">
              <div
                className="h-full rounded-full bg-[var(--primary)] transition-[width]"
                style={{ width: `${progress.percent ?? 0}%` }}
              />
            </div>
            {progress.resumed && (
              <p className="text-xs text-[var(--muted-foreground)]">
                {t('preferences.dsh.setup.resumed')}
              </p>
            )}
          </div>
        )}

        {error && (
          <div className="mx-auto mt-5 max-w-md space-y-2 rounded-lg border border-[var(--destructive)]/30 bg-[var(--destructive)]/5 px-3 py-2 text-left">
            <p className="text-xs text-[var(--destructive)]">
              {t('preferences.dsh.setup.error')}: {error}
            </p>
            {!busy && (
              <Button type="button" variant="outline" className="px-3" onClick={() => void startInstall()}>
                {t('preferences.dsh.setup.retry')}
              </Button>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

function GeneralTab({
  initialStatus,
  onUninstalled,
}: {
  initialStatus: DshIntegrationStatus;
  onUninstalled: (status: DshIntegrationStatus) => void;
}) {
  const { t } = useI18n();
  const { status, busy, error, progress, install, uninstall } =
    useDshRuntimeInstaller(initialStatus);
  const [uninstalling, setUninstalling] = useState(false);
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

  const startUninstall = async () => {
    if (!window.confirm(t('preferences.dsh.runtime.uninstallConfirm'))) return;
    setUninstalling(true);
    try {
      const next = await uninstall();
      if (next) {
        onUninstalled(next);
        toast.success(t('preferences.dsh.runtime.uninstallSuccess'));
      } else {
        toast.error(t('preferences.dsh.runtime.uninstallFailed'));
      }
    } finally {
      setUninstalling(false);
    }
  };

  const checkForUpdates = async () => {
    const previousVersion = status?.version;
    const next = await install();
    if (!next) {
      toast.error(t('preferences.dsh.runtime.updateFailed'));
      return;
    }
    toast.success(
      next.version && next.version !== previousVersion
        ? t('preferences.dsh.runtime.updateSuccess')
        : t('preferences.dsh.runtime.upToDate'),
    );
  };

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
      <div className="space-y-2 rounded-lg border border-[var(--divider)] bg-[var(--card)] px-3.5 py-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-[var(--foreground)]">{t('preferences.dsh.runtime.uninstall')}</p>
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">
              {t('preferences.dsh.runtime.uninstallHint')}
            </p>
          </div>
          <Button
            variant="outline"
            className="px-3"
            disabled={busy || !status?.installed}
            onClick={() => void checkForUpdates()}
          >
            {busy
              ? t('preferences.dsh.runtime.updating')
              : t('preferences.dsh.runtime.check')}
          </Button>
          <Button
            variant="outline"
            className="px-3 text-[var(--destructive)] hover:text-[var(--destructive)]"
            title={t('preferences.dsh.runtime.uninstall')}
            disabled={busy || !status?.installed}
            onClick={() => void startUninstall()}
          >
            {uninstalling && <Loader2 className="h-4 w-4 animate-spin" />}
            {uninstalling
              ? t('preferences.dsh.runtime.uninstalling')
              : t('preferences.dsh.runtime.uninstall')}
          </Button>
        </div>
        {busy && progress && (
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs text-[var(--muted-foreground)]">
              <span>{t('preferences.dsh.runtime.downloadProgress')}</span>
              <span>{progress.percent == null ? '…' : `${progress.percent}%`}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--muted)]">
              <div
                className="h-full rounded-full bg-[var(--primary)] transition-[width]"
                style={{ width: `${progress.percent ?? 0}%` }}
              />
            </div>
            {progress.resumed && (
              <p className="text-xs text-[var(--muted-foreground)]">
                {t('preferences.dsh.runtime.resumed')}
              </p>
            )}
          </div>
        )}
        {status?.installed && (
          <p className="text-xs text-[var(--muted-foreground)]">
            {t('preferences.dsh.runtime.detected')}: {status.version ?? 'unknown'}
          </p>
        )}
        {error && <p className="text-xs text-[var(--destructive)]">{error}</p>}
      </div>
    </div>
  );
}

function formatDshArchiveSize(bytes: number | null | undefined): string {
  if (!Number.isFinite(bytes) || bytes == null || bytes <= 0) return '—';
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes.toFixed(megabytes >= 10 ? 0 : 1)} MB`;
}

function PluginsTab() {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<DeepSeekHarnessPluginCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  const [packageSpec, setPackageSpec] = useState('');
  const [managingPlugin, setManagingPlugin] = useState<string | null>(null);
  const normalizedQuery = query.trim().toLowerCase();

  const loadCatalog = useCallback(() => {
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

  useEffect(() => {
    return loadCatalog();
  }, [loadCatalog]);

  const manageProfilePlugin = useCallback(async (action: 'add' | 'remove' | 'update', target?: string) => {
    const spec = action === 'update' ? '' : (target ?? packageSpec.trim());
    if ((action === 'add' || action === 'remove') && !spec) return;
    setManagingPlugin(`${action}:${spec}`);
    try {
      await deepseekHarness.manageProfilePlugin(action, spec || undefined);
      if (action === 'add') setPackageSpec('');
      loadCatalog();
      toast.success(t('preferences.dsh.plugins.manageSuccess'));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setManagingPlugin(null);
    }
  }, [loadCatalog, packageSpec, t]);

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
        { key: 'profile', title: t('preferences.dsh.plugins.profile'), plugins: catalog.profile ?? [] },
        { key: 'host', title: t('preferences.dsh.plugins.host'), plugins: catalog.host ?? [] },
        ...Object.entries(catalog.presets ?? {}).map(([preset, plugins]) => ({
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
      <div className="flex items-center gap-2 rounded-lg border border-[var(--divider)] bg-[var(--card)] p-2.5">
        <Input
          value={packageSpec}
          onChange={(event) => setPackageSpec(event.target.value)}
          placeholder={t('preferences.dsh.plugins.packagePlaceholder')}
          className="h-8 min-w-0 flex-1"
        />
        <Button
          type="button"
          size="sm"
          disabled={!packageSpec.trim() || managingPlugin !== null}
          onClick={() => void manageProfilePlugin('add')}
        >
          {managingPlugin?.startsWith('add:') && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('preferences.dsh.plugins.install')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={managingPlugin !== null}
          onClick={() => void manageProfilePlugin('update')}
        >
          {t('preferences.dsh.plugins.updateAll')}
        </Button>
      </div>
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
                        {plugin.scope === 'profile'
                          && plugin.id !== '@deepseek-ai/dsh-base'
                          && plugin.id !== 'dsh-flowix-memory' && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={managingPlugin !== null}
                            onClick={() => void manageProfilePlugin('remove', plugin.id)}
                          >
                            {t('preferences.dsh.plugins.remove')}
                          </Button>
                        )}
                        <button
                          type="button"
                          role="switch"
                          aria-checked={plugin.enabled}
                          aria-label={`${t('preferences.dsh.plugins.toggle')}: ${plugin.id}`}
                          title={plugin.toggleable ? t('preferences.dsh.plugins.toggle') : t('preferences.dsh.plugins.protected')}
                          disabled={!plugin.toggleable || togglingKey !== null || plugin.scope === 'profile'}
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
