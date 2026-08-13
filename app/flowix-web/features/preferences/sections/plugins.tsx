'use client';

import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, RefreshCw, Trash2 } from 'lucide-react';
import { dialogs, plugins, type PluginDescriptor } from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { SectionHeader } from './primitives';

export function PluginsSection() {
  const [items, setItems] = useState<PluginDescriptor[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await plugins.refresh());
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const install = async () => {
    const source = await dialogs.selectDirectory();
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      await plugins.install(source);
      await load();
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : String(installError));
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async (plugin: PluginDescriptor) => {
    if (plugin.isSystem || !window.confirm(`确定卸载插件“${plugin.manifest.name}”吗？`)) return;
    setBusy(true);
    setError(null);
    try {
      await plugins.uninstall(plugin.manifest.id);
      await load();
    } catch (uninstallError) {
      setError(uninstallError instanceof Error ? uninstallError.message : String(uninstallError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="插件"
        description="插件安装在 ~/.flowix/plugin/，安装后对全部笔记本可用。"
      />
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void install()}>
          <FolderOpen className="mr-1.5 h-4 w-4" />安装插件目录
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void load()}>
          <RefreshCw className="mr-1.5 h-4 w-4" />刷新
        </Button>
      </div>
      {error && <p className="rounded-md bg-red-500/10 p-3 text-xs text-red-600">{error}</p>}
      <div className="space-y-2">
        {items.map((plugin) => (
          <div key={plugin.manifest.id} className="flex items-center justify-between rounded-lg border border-[var(--divider)] bg-[var(--card)] p-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-[var(--foreground)]">
                <span className="truncate">{plugin.manifest.name}</span>
                {plugin.isSystem && <span className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">内置</span>}
              </div>
              <p className="mt-1 truncate text-xs text-[var(--muted-foreground)]">{plugin.manifest.id} · v{plugin.manifest.version}</p>
            </div>
            {!plugin.isSystem && <Button variant="ghost" size="icon" disabled={busy} onClick={() => void uninstall(plugin)} title="卸载插件"><Trash2 className="h-4 w-4 text-red-500" /></Button>}
          </div>
        ))}
      </div>
    </div>
  );
}
