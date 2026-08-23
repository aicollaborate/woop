import { useEffect, useState } from 'react';

/**
 * 折叠动画期间保持子树挂载, 过渡结束后再卸载。
 *
 * 列宽 collapse 走 150ms `transition-[width]`, 但顶栏 / 面板内容是条件渲染
 * ── 状态翻转的那一帧就卸载, 列表会瞬间上移顶到窗口顶部。此 hook 把卸载
 * 推迟到宽度动画结束之后, 让内容跟着列一起被裁掉, 视觉连续。
 *
 * 用 setTimeout 而非 transitionend: WKWebView 下 width 过渡的事件可靠性
 * 不足, resize / 打断等边角会丢事件。定时器 + 余量更鲁棒。
 * 动画未结束反向展开时, effect cleanup 会取消定时器, 元素尚未卸载,
 * 宽度从当前值反向过渡, 天然可逆。
 */
export function useDeferredUnmount(active: boolean, delay = 200) {
  const [mounted, setMounted] = useState(active);

  useEffect(() => {
    if (active) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), delay);
    return () => clearTimeout(timer);
  }, [active, delay]);

  return mounted;
}
