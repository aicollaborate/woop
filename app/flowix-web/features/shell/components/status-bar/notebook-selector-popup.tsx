'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronsUpDown, Pencil, Plus, Trash2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { notebooks as notebooksClient } from '@platform/tauri/client';
import { NotebookIcon, useMemoStore, type Notebook } from '@features/memo';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';

export interface NotebookSelectorPopupProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notebooks: Notebook[];
  selectedNotebook: Notebook | null;
  onSelect: (notebook: Notebook) => void;
  onEdit: (notebook: Notebook) => void;
  onDelete: (notebook: Notebook) => void;
  onRefresh: (notebooks: Notebook[]) => void;
  /** Optional alternate anchor, e.g. the current notebook card in the sidebar. */
  trigger?: React.ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  sideOffset?: number;
}

type DropPosition = 'before' | 'after';

interface DropTarget {
  id: string;
  position: DropPosition;
}

interface PointerState {
  sourceId: string;
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
  ghostRect: DOMRect;
  pointerX: number;
  pointerY: number;
}

const DRAG_THRESHOLD_PX = 4;

/**
 * Status-bar notebook selector. The popup deliberately owns the complete
 * interaction boundary so selecting or opening a notebook action always
 * closes the Popover before the parent starts another transition.
 */
export function NotebookSelectorPopup({
  open,
  onOpenChange,
  notebooks,
  selectedNotebook,
  onSelect,
  onEdit,
  onDelete,
  onRefresh,
  trigger,
  side = 'top',
  sideOffset = 6,
}: NotebookSelectorPopupProps) {
  const { t } = useI18n();
  const reorderNotebooks = useMemoStore((state) => state.reorderNotebooks);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const pointerRef = useRef<PointerState | null>(null);
  const refreshRequestRef = useRef(0);
  const pendingAfterCloseRef = useRef<(() => void) | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [ghost, setGhost] = useState<PointerState | null>(null);

  const refreshNotebooks = useCallback(async () => {
    const requestId = ++refreshRequestRef.current;
    try {
      const notebookList = await notebooksClient.getAll();
      if (requestId !== refreshRequestRef.current) return;
      onRefresh(notebookList ?? []);
    } catch {
      // The existing notebook list remains usable if refreshing fails.
    }
  }, [onRefresh]);

  useEffect(() => () => {
    refreshRequestRef.current += 1;
  }, []);

  useEffect(() => {
    if (open) pendingAfterCloseRef.current = null;
  }, [open]);

  const closeThen = useCallback((afterClose: () => void) => {
    pendingAfterCloseRef.current = afterClose;
    onOpenChange(false);
  }, [onOpenChange]);

  const handleExitComplete = useCallback(() => {
    const afterClose = pendingAfterCloseRef.current;
    pendingAfterCloseRef.current = null;
    afterClose?.();
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // Do not unmount the content while a pointer reorder is in progress.
      if (!next && pointerRef.current?.dragging) return;
      if (next) void refreshNotebooks();
      onOpenChange(next);
    },
    [onOpenChange, refreshNotebooks],
  );

  useEffect(() => {
    const findDropTarget = (x: number, y: number, sourceId: string): DropTarget | null => {
      let nearest: { id: string; distance: number; position: DropPosition } | null = null;

      for (const notebook of notebooks) {
        if (notebook.id === sourceId) continue;
        const card = cardRefs.current.get(notebook.id);
        if (!card) continue;
        const rect = card.getBoundingClientRect();
        const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const distance = Math.hypot(x - centerX, y - centerY);
        const position: DropPosition = x < centerX ? 'before' : 'after';

        if (inside) return { id: notebook.id, position };
        if (!nearest || distance < nearest.distance) {
          nearest = { id: notebook.id, distance, position };
        }
      }

      // Gaps between cards should not cause an unexpected reorder when the
      // pointer has left the card grid entirely.
      if (!nearest) return null;
      const gridCards = [...cardRefs.current.values()];
      const gridRect = gridCards.reduce<DOMRect | null>((bounds, card) => {
        const rect = card.getBoundingClientRect();
        if (!bounds) return rect;
        const left = Math.min(bounds.left, rect.left);
        const top = Math.min(bounds.top, rect.top);
        const right = Math.max(bounds.right, rect.right);
        const bottom = Math.max(bounds.bottom, rect.bottom);
        return new DOMRect(left, top, right - left, bottom - top);
      }, null);
      if (!gridRect || x < gridRect.left || x > gridRect.right || y < gridRect.top || y > gridRect.bottom) {
        return null;
      }
      return { id: nearest.id, position: nearest.position };
    };

    const handleMove = (event: PointerEvent) => {
      const pointer = pointerRef.current;
      if (!pointer || pointer.pointerId !== event.pointerId) return;

      if (!pointer.dragging) {
        const dx = Math.abs(event.clientX - pointer.startX);
        const dy = Math.abs(event.clientY - pointer.startY);
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        pointer.dragging = true;
        setDraggingId(pointer.sourceId);
      }

      pointer.pointerX = event.clientX;
      pointer.pointerY = event.clientY;
      setGhost({ ...pointer });
      setDropTarget(findDropTarget(event.clientX, event.clientY, pointer.sourceId));
    };

    const handleUp = (event: PointerEvent) => {
      const pointer = pointerRef.current;
      if (!pointer || pointer.pointerId !== event.pointerId) return;

      const target = pointer.dragging
        ? findDropTarget(event.clientX, event.clientY, pointer.sourceId)
        : null;
      if (target) {
        const ids = notebooks.map((notebook) => notebook.id);
        const sourceIndex = ids.indexOf(pointer.sourceId);
        const targetIndex = ids.indexOf(target.id);
        if (sourceIndex >= 0 && targetIndex >= 0) {
          const [moved] = ids.splice(sourceIndex, 1);
          let insertAt = targetIndex;
          if (sourceIndex < targetIndex) insertAt -= 1;
          if (target.position === 'after') insertAt += 1;
          ids.splice(Math.max(0, Math.min(insertAt, ids.length)), 0, moved);
          void reorderNotebooks(ids);
        }
      } else if (!pointer.dragging) {
        const notebook = notebooks.find((item) => item.id === pointer.sourceId);
        if (notebook) {
          if (notebook.missing) {
            closeThen(() => toast.warning(t('status.invalidNotebookPath')));
          } else {
            closeThen(() => onSelect(notebook));
          }
        }
      }

      pointerRef.current = null;
      setDraggingId(null);
      setDropTarget(null);
      setGhost(null);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [closeThen, notebooks, onSelect, reorderNotebooks, t]);

  const handleCardPointerDown = (notebook: Notebook, event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || pointerRef.current) return;
    event.preventDefault();
    pointerRef.current = {
      sourceId: notebook.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      ghostRect: event.currentTarget.getBoundingClientRect(),
      pointerX: event.clientX,
      pointerY: event.clientY,
    };
  };

  const handleCardKeyDown = (notebook: Notebook, event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (notebook.missing) {
      closeThen(() => toast.warning(t('status.invalidNotebookPath')));
      return;
    }
    closeThen(() => onSelect(notebook));
  };

  const sourceNotebook = ghost ? notebooks.find((notebook) => notebook.id === ghost.sourceId) : null;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            className="flex h-[26px] items-center gap-1 bg-[var(--primary)] px-1 hover:opacity-90"
            aria-label={t('status.switchNotebook')}
          >
            <span className="flex h-full items-center overflow-hidden whitespace-nowrap pl-2 text-[var(--primary-foreground)]">
              {t('status.notebook')}
            </span>
            <NotebookIcon
              icon={selectedNotebook?.icon}
              name={selectedNotebook?.name}
              className="h-4 w-4 rounded bg-[color-mix(in_oklch,var(--primary-foreground)_10%,transparent)] text-[12px] font-semibold text-[var(--primary-foreground)]"
            />
            <ChevronsUpDown className="h-3 w-3 shrink-0 text-[var(--primary-foreground)]" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side={side}
        sideOffset={sideOffset}
        onExitComplete={handleExitComplete}
        className={cn(
          'flowix-notebook-selector-popup ml-1.5 flex h-[480px] w-[390px] flex-col overflow-hidden rounded-xl bg-[var(--popover)]',
          side === 'bottom' && 'flowix-notebook-selector-popup--bottom',
        )}
      >
        <div className="shrink-0 px-1.5 pb-2 pt-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          {t('status.notebookList')}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
          {notebooks.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-[var(--muted-foreground)]">
              {t('status.noNotebooks')}
            </div>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(108px,1fr))] gap-2.5">
            {notebooks.map((notebook) => {
                const isActive = selectedNotebook?.id === notebook.id;
                const isMissing = Boolean(notebook.missing);
                const isDragging = draggingId === notebook.id;
                const isDropTarget = dropTarget?.id === notebook.id && !isDragging;

                return (
                  <div
                    key={notebook.id}
                    ref={(element) => {
                      if (element) cardRefs.current.set(notebook.id, element);
                      else cardRefs.current.delete(notebook.id);
                    }}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isActive}
                    onPointerDown={(event) => handleCardPointerDown(notebook, event)}
                    onKeyDown={(event) => handleCardKeyDown(notebook, event)}
                    className={cn(
                      'group relative flex min-h-[124px] select-none flex-col items-start gap-2 rounded-lg border px-3 py-3 text-left transition-colors',
                      isDragging && 'opacity-30',
                      isActive
                        ? 'border-[var(--primary)]/50 bg-[color-mix(in_oklch,var(--primary)_10%,transparent)]'
                        : 'border-[var(--border)] hover:border-[var(--primary)]/50 hover:bg-[var(--muted)]/60',
                      isDropTarget && 'ring-2 ring-[var(--primary)] ring-offset-1 ring-offset-[var(--popover)]',
                      isMissing && 'opacity-70',
                    )}
                    style={{
                      touchAction: 'none',
                      ...(isActive
                        ? {
                            backgroundColor: 'var(--popover)',
                            backgroundImage:
                              'radial-gradient(ellipse 90% 145% at 100% 0%, color-mix(in oklch, var(--primary) 18%, transparent), transparent 58%)',
                          }
                        : {}),
                    }}
                  >
                    <NotebookIcon
                      icon={notebook.icon}
                      name={notebook.name}
                      className="h-7 w-7 shrink-0 rounded-md bg-[var(--muted)] text-[11px] font-semibold text-[var(--secondary-foreground)]"
                      imageClassName="h-[72%] w-[72%]"
                    />
                    <div className="mt-auto w-full space-y-1">
                      <span
                        className={cn(
                          'block min-h-5 w-full min-w-0 truncate text-left text-sm font-medium',
                          isMissing ? 'text-[var(--muted-foreground)]' : 'text-[var(--foreground)]',
                        )}
                        title={notebook.name}
                      >
                        {notebook.name}
                        {isMissing && ` ${t('status.invalid')}`}
                      </span>
                      <span className="block text-left text-xs text-[var(--muted-foreground)]">
                        {t('status.notebookMemoCount', { count: notebook.memoCount ?? 0 })}
                      </span>
                    </div>
                    <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <button
                        type="button"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          closeThen(() => onEdit(notebook));
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                        aria-label={t('status.editNotebook')}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          closeThen(() => onDelete(notebook));
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
                        aria-label={t('status.deleteNotebook')}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                );
            })}
            <button
              type="button"
              onClick={() => {
                closeThen(() => {
                  window.dispatchEvent(new CustomEvent('flowix:open-create-notebook'));
                });
              }}
              className="group relative flex min-h-[124px] items-center justify-center rounded-lg border border-dashed border-[var(--border)] text-[var(--muted-foreground)] transition-colors hover:border-[var(--primary)]/50 hover:bg-[var(--muted)]/60 hover:text-[var(--foreground)]"
              aria-label={t('status.newNotebook')}
              title={t('status.newNotebook')}
            >
              <Plus className="h-7 w-7" />
            </button>
          </div>
        </div>

        {ghost && sourceNotebook && (
          <div
            className="pointer-events-none fixed z-[1600] flex items-center gap-2 rounded-lg border border-[var(--primary)] bg-[var(--popover)] px-2.5 py-2 shadow-lg"
            style={{
              left: ghost.pointerX + 12,
              top: ghost.pointerY + 12,
              width: ghost.ghostRect.width,
            }}
          >
            <NotebookIcon
              icon={sourceNotebook.icon}
              name={sourceNotebook.name}
              className="h-7 w-7 shrink-0 rounded-md bg-[var(--muted)] text-[11px] font-semibold text-[var(--secondary-foreground)]"
            />
            <span className="truncate text-sm font-medium text-[var(--foreground)]">
              {sourceNotebook.name}
            </span>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
