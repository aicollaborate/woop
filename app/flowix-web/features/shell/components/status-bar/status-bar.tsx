'use client';

import { useEffect, useState } from 'react';
import { Hash, ListTodo, SlidersHorizontal } from 'lucide-react';
import { Tooltip } from '@shared/ui/tooltip';
import type { Notebook } from '@features/memo';
import { NotebookSwitcher } from '@features/shell/components/status-bar/notebook-switcher';
import { AgentRuntimeStatusMenu } from '@features/shell/components/status-bar/agent-runtime-status-menu';
import { ProductUpdatePill } from '@features/shell/components/status-bar/product-update-pill';
import { useI18n } from '@/lib/i18n';
import { useDocumentMetricsStore } from '@features/document';
import { useMemoStore } from '@features/memo';

interface StatusBarProps {
  onSelectNotebook: (notebook: Notebook) => void;
  onEditNotebook: (notebook: Notebook) => void;
  onDeleteNotebook: (notebook: Notebook) => void;
  todoCount: number;
  onOpenTodos: () => void;
  onToggleNoteNavigation: () => void;
  onOpenPreferences: () => void;
}

/**
 * Bottom status bar for the main window.
 *
 * Layout (two columns):
 *   [NotebookSwitcher] | [Todos] [char count]   …flex spacer…   [Note Nav] [AI Chat] [⚙]
 *                       ↑ top border
 *
 * The left column is the notebook switcher (fixed width by its own button
 * content); the right column takes the remaining width and carries the top
 * border so the switcher's primary-colored block reads as a standalone first
 * column.
 *
 * Renders no chrome of its own — it assumes it lives in a `h-[26px]` flex strip.
 */
export function StatusBar({
  onSelectNotebook,
  onEditNotebook,
  onDeleteNotebook,
  todoCount,
  onOpenTodos,
  onToggleNoteNavigation,
  onOpenPreferences,
}: StatusBarProps) {
  const { t } = useI18n();
  const [notebookPopupOpen, setNotebookPopupOpen] = useState(false);
  const notebooks = useMemoStore((state) => state.notebooks);
  const selectedNotebook = useMemoStore((state) => state.selectedNotebook);
  const setNotebooks = useMemoStore((state) => state.setNotebooks);
  const charCount = useDocumentMetricsStore((state) => state.charCount);

  useEffect(() => {
    const handleToggle = () => setNotebookPopupOpen((open) => !open);
    window.addEventListener('flowix:toggle-notebook-switcher', handleToggle);
    return () => window.removeEventListener('flowix:toggle-notebook-switcher', handleToggle);
  }, []);
  return (
    <div className="flex h-[26px] shrink-0 select-none items-stretch bg-[var(--statusbar-bg)] text-xs text-[var(--muted-foreground)]">
      {/* Left column: notebook switcher (fixed width by its own button content). */}
      <div className="shrink-0 flex items-center">
        <NotebookSwitcher
          open={notebookPopupOpen}
          onOpenChange={setNotebookPopupOpen}
          notebooks={notebooks}
          selectedNotebook={selectedNotebook}
          onSelect={onSelectNotebook}
          onEdit={(notebook) => {
            setNotebookPopupOpen(false);
            onEditNotebook(notebook);
          }}
          onDelete={(notebook) => {
            setNotebookPopupOpen(false);
            onDeleteNotebook(notebook);
          }}
          onRefresh={setNotebooks}
        />
      </div>
      {/* Right column: full-width content area; carries the top border. */}
      <div className="flex-1 min-w-0 flex items-center gap-1.5 pl-1.5 border-t border-[var(--divider)]">
        <button
          type="button"
          className="h-full inline-flex items-center gap-1 px-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
          aria-label={`${t('status.todos')} ${todoCount}`}
          onClick={onOpenTodos}
        >
          <ListTodo className="w-3.5 h-3.5 shrink-0" />
          <span>{t('status.todos')}</span>
          <span>{todoCount}</span>
        </button>
        {charCount > 0 && <span className="text-[var(--muted-foreground)]">{t('status.characters')} {charCount}</span>}
        <div className="flex-1" />
        <ProductUpdatePill />
        <Tooltip content={t('shell.statusBar.noteNavTooltip')}>
          <button
            type="button"
            onClick={onToggleNoteNavigation}
            className="h-full flex items-center gap-1 px-1.5 py-0 hover:bg-[var(--muted)]"
            aria-label={t('shell.statusBar.noteNav')}
          >
            <Hash className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
        <AgentRuntimeStatusMenu />
        <Tooltip content={t('status.preferences')} shortcut="menu.open" side="top">
          <button
            type="button"
            onClick={onOpenPreferences}
            className="mr-1.5 h-full flex items-center justify-center px-1.5 py-0 hover:bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            aria-label={t('status.preferences')}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
