'use client';

import { useCallback, useRef } from 'react';

// 入场动画用浏览器内置 Web Animations API (element.animate), 不再引入
// gsap (~168KB chunk)。动画只是 opacity + translateX + scale 的简单缓出,
// WAAPI 同步可用、无动态 import 的加载 gap, 也让 hook 少掉整套预热逻辑。

const ENTRANCE_DURATION = 300;
// ≈ gsap 的 power2.out (二次缓出)。
const ENTRANCE_EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface PendingInsert {
  newId: string;
  attempts: number;
}

function runEntrance(animEl: HTMLElement) {
  // 取消该元素上已有动画, 等价于 gsap.killTweensOf。
  animEl.getAnimations().forEach((animation) => animation.cancel());
  animEl.animate(
    [
      { opacity: 0, transform: 'translateX(-36px) scale(0.985)' },
      { opacity: 1, transform: 'translateX(0) scale(1)' },
    ],
    {
      duration: ENTRANCE_DURATION,
      easing: ENTRANCE_EASE,
    },
  );
}

/**
 * 入场动画 ── 只在**新建一条** memo 时跑一次。
 *
 * 设计:
 * - 不动整列 (没有 FLIP / 没有列表滚动), 只让新 card 自己从左侧淡入;
 * - 新 card 的容器是普通文档流, 没有 transform 定位, 物理上不可能与
 *   上下邻居重叠;
 * - 动画作用在 [data-insert-anim] wrapper 上, wrapper 自己的 transform
 *   (x / scale) 不会外溢到 row 容器;
 * - 只在 prepareForInsert(newId) 之后的下一次 useLayoutEffect 里跑,
 *   其它时候 onListRendered 是 no-op。
 */
export function useMemoInsertAnimation() {
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const pendingRef = useRef<PendingInsert | null>(null);

  const registerCard = useCallback((id: string) => (el: HTMLDivElement | null) => {
    if (el) cardRefs.current.set(id, el);
    else cardRefs.current.delete(id);
  }, []);

  // 删掉了原来的 (newId, index) + data-virt-index + scrollToIndex 三件套:
  // 新 memo 永远渲染在列表最前, index 没有意义, 滚动也由浏览器原生
  // overflow-y-auto 自然处理 (新 card 出现在最前, 用户想看就滚, 我们不替
  // 用户做"自动滚到顶部"的决定)。动态 virtualizer 的初始 overscan 会包含它。
  const prepareForInsert = useCallback((newId: string) => {
    pendingRef.current = { newId, attempts: 0 };
  }, []);

  const onListRendered = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;

    const newEl = cardRefs.current.get(pending.newId);
    if (!newEl) {
      pending.attempts += 1;
      if (pending.attempts > 2) {
        pendingRef.current = null;
      }
      return;
    }

    pendingRef.current = null;

    // 优先取 row 内部的 [data-insert-anim] wrapper, 让 transform/x/scale
    // 全部作用在视觉层; 找不到 (旧结构 / 单测 / Storybook) 时退回 row 本身。
    const animEl = (newEl.querySelector('[data-insert-anim]') as HTMLElement | null) ?? newEl;

    if (prefersReducedMotion()) return;

    runEntrance(animEl);
  }, []);

  return { registerCard, prepareForInsert, onListRendered };
}
