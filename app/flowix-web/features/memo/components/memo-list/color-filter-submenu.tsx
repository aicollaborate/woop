import { MEMO_COLORS, MEMO_COLOR_HEX, type ColorFilterValue, type MemoColor } from '@features/memo';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { DROPDOWN_DIVIDER_SKIN } from '@shared/ui/dropdown-divider';

export const COLOR_LABEL_KEYS: Record<MemoColor, import('@/lib/i18n').I18nKey> = {
  red: 'document.color.red',
  orange: 'document.color.orange',
  yellow: 'document.color.yellow',
  green: 'document.color.green',
  cyan: 'document.color.cyan',
  blue: 'document.color.blue',
  gray: 'document.color.gray',
};

interface ColorFilterSubmenuContentProps {
  value: ColorFilterValue;
  onSelect: (value: ColorFilterValue) => void;
}

/**
 * 颜色筛选项内容（无内部滚动、无组标题）。外层的定位、hover 延迟和关闭行为由
 * MemoNavigationSubmenu 统一处理；调用方负责放置「颜色」分组标题与滚动容器。
 */
export function ColorFilterSubmenuContent({
  value,
  onSelect,
}: ColorFilterSubmenuContentProps) {
  const { t } = useI18n();

  const renderRow = (
    key: string,
    label: string,
    swatch: React.ReactNode,
    next: ColorFilterValue,
  ) => {
    const isActive = value === next;
    return (
      <button
        key={key}
        type="button"
        onClick={() => onSelect(next)}
        onMouseDown={(event) => event.preventDefault()}
        className={cn(
          'mention-note-item cursor-pointer hover:bg-[var(--muted)] focus-visible:bg-[var(--muted)] focus-visible:outline-none',
          isActive && 'is-selected',
        )}
      >
        <span className="mention-note-title flex min-w-0 items-center gap-3">
          <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
            {swatch}
          </span>
          <span className="min-w-0 truncate">{label}</span>
        </span>
      </button>
    );
  };

  return (
    <>
      {renderRow(
        'any',
        t('memo.list.filterColorAny'),
        <span className="inline-flex h-3.5 w-3.5 rounded-full border border-dashed border-[var(--muted-foreground)]" />,
        'any',
      )}
      {renderRow(
        'none',
        t('memo.list.filterColorNone'),
        <span className="inline-flex h-3.5 w-3.5 rounded-full border border-[var(--border)] bg-transparent" />,
        'none',
      )}
      <hr className={cn('mx-2 my-1 border-0', DROPDOWN_DIVIDER_SKIN)} />
      {MEMO_COLORS.map((color) =>
        renderRow(
          color,
          t(COLOR_LABEL_KEYS[color]),
          <span
            className="block h-3.5 w-3.5 rounded-full"
            style={{
              backgroundColor: `color-mix(in oklch, ${MEMO_COLOR_HEX[color]} 67%, white)`,
            }}
          />,
          color,
        ),
      )}
    </>
  );
}
