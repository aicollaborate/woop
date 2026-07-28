import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { MEMO_COLORS, MEMO_COLOR_HEX, type ColorFilterValue, type MemoColor } from '@features/memo';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * 颜色筛选二级弹窗。Hover/聚焦父项时, 通过 portal 渲染到 body,
 * 浮在父级 DropdownMenuContent 右侧。子项点击后, 设置
 *   - activeFilter = 'color'
 *   - colorFilter  = 选定值 ('any' | 'none' | MemoColor)
 * 父级 dropdown 关闭后此弹窗随之销毁。
 *
 * 打开/关闭由父级 (MemoList) 通过 `active` prop 控制:
 *   - 父 trigger onMouseEnter → 父 setColorSubmenuOpen(true)
 *   - 父 trigger onMouseLeave → 父 setTimeout(setColorSubmenuOpen(false), 120)
 *   - 父级 dropdown 关闭 → 父 setColorSubmenuOpen(false)
 * 子菜单自身不再管 timer, 只在 onCancelClose 被调用时通知父级撤销关闭
 * (即用户从 trigger 移到了子菜单上, 父级那个 setTimeout 应当清掉)。
 */
interface ColorFilterSubmenuProps {
  parentRef: RefObject<HTMLButtonElement | null>;
  active: boolean;
  onClose: () => void;
  onCancelClose: () => void;
  value: ColorFilterValue;
  onSelect: (value: ColorFilterValue) => void;
}

export const COLOR_LABEL_KEYS: Record<MemoColor, import('@/lib/i18n').I18nKey> = {
  red: 'document.color.red',
  orange: 'document.color.orange',
  yellow: 'document.color.yellow',
  green: 'document.color.green',
  cyan: 'document.color.cyan',
  blue: 'document.color.blue',
  gray: 'document.color.gray',
};

export function ColorFilterSubmenu({
  parentRef,
  active,
  onClose,
  onCancelClose,
  value,
  onSelect,
}: ColorFilterSubmenuProps) {
  const { t } = useI18n();
  const submenuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  // 计算位置: 浮在父 trigger 右侧, 高度对齐 trigger 中线, 顶不过 viewport
  useLayoutEffect(() => {
    if (!active || !parentRef.current) {
      setPosition(null);
      return;
    }
    const update = () => {
      const trigger = parentRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const menuWidth = 168;
      const menuHeight = submenuRef.current?.offsetHeight ?? 240;
      const top = Math.max(
        4,
        Math.min(
          rect.top + rect.height / 2 - 16,
          window.innerHeight - menuHeight - 4,
        ),
      );
      const left = Math.min(
        rect.right + 4,
        window.innerWidth - menuWidth - 4,
      );
      setPosition({ top, left });
    };
    update();
    const raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, [active, parentRef]);

  // 外部点击关闭
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        submenuRef.current?.contains(target) ||
        parentRef.current?.contains(target)
      ) {
        return;
      }
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [active, onClose, parentRef]);

  // Esc 关闭
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, onClose]);

  if (!active || !position) return null;

  const handleSelect = (next: ColorFilterValue) => {
    onSelect(next);
    onClose();
  };

  const handleMouseEnter = () => {
    onCancelClose();
  };

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
        onClick={() => handleSelect(next)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--foreground)] hover:bg-[var(--muted)] cursor-pointer outline-none',
        )}
      >
        <span className="inline-flex h-3.5 w-7 shrink-0 items-center justify-center">
          {swatch}
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {isActive && <Check className="h-3.5 w-3.5 text-[var(--primary)]" />}
      </button>
    );
  };

  return createPortal(
    <div
      ref={submenuRef}
      onMouseEnter={handleMouseEnter}
      // 阻止 mousedown 冒泡到 document — 父 DropdownMenu 的 click-outside
      // 监听挂在 document 上, 一旦冒泡到 document 就会 setOpen(false),
      // 引发 re-render, 我们的 useLayoutEffect 看到 parentRef.current === null
      // (trigger 已被父 dropdown 卸载) 就 setPosition(null) 把自己也卸载掉,
      // 紧接着的 click 事件就落到脱离 DOM 的按钮上, onClick 不触发。
      // 在 portal 根节点 stopPropagation, 父 dropdown 维持打开, click 落
      // 到还在 mounted 的按钮, 走 handleSelect 把 colorFilter / activeFilter
      // 真正 set 进去。
      onMouseDown={(e) => e.stopPropagation()}
      style={{ top: position.top, left: position.left }}
      className="fixed z-[1600] w-[168px] rounded-lg border border-[var(--border)] bg-[var(--card)] p-1 shadow-lg animate-in fade-in-0 zoom-in-95"
    >
      {renderRow(
        'any',
        t('memo.list.filterColorAny'),
        <span className="inline-flex h-3 w-3 rounded-full border border-dashed border-[var(--muted-foreground)]" />,
        'any',
      )}
      {renderRow(
        'none',
        t('memo.list.filterColorNone'),
        <span className="inline-block h-3 w-3 rounded-full border border-[var(--border)] bg-transparent" />,
        'none',
      )}
      <hr className="mx-2 my-1 border-t border-[var(--border)] opacity-50" />
      {MEMO_COLORS.map((c) =>
        renderRow(
          c,
          t(COLOR_LABEL_KEYS[c]),
          <span
            className="block h-3 w-3 rounded-full"
            style={{ backgroundColor: MEMO_COLOR_HEX[c] }}
          />,
          c,
        ),
      )}
    </div>,
    document.body,
  );
}


