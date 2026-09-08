import { useMemo, type ReactNode } from 'react'
import { TrashSimpleIcon } from '@phosphor-icons/react'
import {
  headingMenuItems,
  listMenuItems,
  blockMenuItems,
  type BlockMenuItem,
} from '@features/editor/components/drag-context-menu/items'
import { useI18n } from '@/lib/i18n'

export type BlockMenuActionGroup = 'heading' | 'list' | 'block' | 'danger'

export interface BlockMenuAction {
  id: string
  group: BlockMenuActionGroup
  icon: ReactNode
  label: string
  shortcut?: string
  onSelect: () => void
}

export function useBlockMenuActions(
  onMenuItem: (item: BlockMenuItem) => void,
  onDelete: () => void,
): BlockMenuAction[] {
  const { t } = useI18n()
  return useMemo(() => [
    ...headingMenuItems.map((item): BlockMenuAction => ({
      id: item.kind === 'heading' ? `h${item.level}` : 'paragraph',
      group: 'heading',
      icon: item.icon,
      label: item.kind === 'paragraph' ? t('editor.block.paragraph') : item.display,
      shortcut: item.shortcut,
      onSelect: () => onMenuItem(item),
    })),
    ...listMenuItems.map((item): BlockMenuAction => ({
      id: item.listType,
      group: 'list',
      icon: item.icon,
      label: t(
        item.listType === 'bulletList'
          ? 'editor.block.bulletList'
          : item.listType === 'orderedList'
            ? 'editor.block.orderedList'
            : 'editor.block.taskList',
      ),
      shortcut: item.shortcut,
      onSelect: () => onMenuItem(item),
    })),
    ...blockMenuItems.map((item): BlockMenuAction => ({
      id: item.blockType,
      group: 'block',
      icon: item.icon,
      label: t(item.displayKey),
      onSelect: () => onMenuItem(item),
    })),
    {
      id: 'delete',
      group: 'danger',
      icon: <TrashSimpleIcon size={16} weight="bold" />,
      label: t('editor.block.delete'),
      onSelect: onDelete,
    },
  ], [onMenuItem, onDelete, t])
}
