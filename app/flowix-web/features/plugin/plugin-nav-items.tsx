'use client';

import { useEffect, useState } from 'react';
import { PuzzlePieceIcon, TreeStructureIcon } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { plugins, type PluginDescriptor } from '@platform/tauri/client';
import { listenToPluginCatalogChanges } from '@platform/tauri/client/plugin';

export function PluginNavItems({
  activePluginId,
  onOpenPlugin,
}: {
  activePluginId: string | null;
  onOpenPlugin: (plugin: PluginDescriptor) => void;
}) {
  const [items, setItems] = useState<PluginDescriptor[]>([]);

  useEffect(() => {
    let active = true;
    const load = () => plugins.list().then((next) => {
      if (active) setItems(next.filter((item) => item.manifest.ui.placement === 'sidebar'));
    }).catch((error) => console.warn('[PluginNavItems] failed to load plugins', error));
    void load();
    const unlisten = listenToPluginCatalogChanges(() => { void load(); });
    return () => { active = false; unlisten(); };
  }, []);

  if (items.length === 0) return null;
  return (
    <div className="mt-1 space-y-0.5 border-t border-[var(--muted-foreground)]/30 pt-1">
      {items.map((plugin) => (
        <div
          key={plugin.manifest.id}
          role="button"
          tabIndex={0}
          onClick={() => onOpenPlugin(plugin)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onOpenPlugin(plugin);
            }
          }}
          className={cn(
            'flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-sm transition-colors',
            activePluginId === plugin.manifest.id
              ? 'bg-[var(--muted)] text-[var(--foreground)]'
              : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
          )}
          aria-pressed={activePluginId === plugin.manifest.id}
        >
          {pluginIcon(plugin.manifest.ui.icon)}
          <span className="min-w-0 flex-1 truncate">{plugin.manifest.name}</span>
        </div>
      ))}
    </div>
  );
}

function pluginIcon(icon: string) {
  switch (icon.trim().toLowerCase()) {
    case 'mindmap':
    case 'tree-structure':
      return <TreeStructureIcon size={16} weight="bold" className="shrink-0" />;
    default:
      return <PuzzlePieceIcon size={16} weight="bold" className="shrink-0" />;
  }
}
