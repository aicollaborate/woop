// pinyin-pro 动态 import (独立 chunk, ~316KB)。
//
// 调用方两种模式:
//  - property-key.generatePropertyKey: 创建属性时调用, 改 async 走 ensurePinyin
//    保证中文属性名生成正确拼音 key (降级会退化为 'property' 造成冲突)。
//  - notebook-icon.getNotebookIconLetter: 渲染热路径, 保持同步签名, 用 getPinyin
//    读已加载模块; 未加载时降级返回原字符占位, 加载后 NotebookIcon 经
//    subscribePinyinReady 重渲染刷新为拼音首字母。

type PinyinFn = typeof import('pinyin-pro')['pinyin'];

let pinyinPromise: Promise<PinyinFn> | null = null;
let pinyinLoaded: PinyinFn | null = null;
const readyListeners = new Set<() => void>();

function notifyReady(): void {
  for (const cb of readyListeners) cb();
  readyListeners.clear();
}

/** 异步加载 pinyin-pro (已加载则立即 resolve), 返回 pinyin 函数。 */
export function ensurePinyin(): Promise<PinyinFn> {
  if (pinyinLoaded) return Promise.resolve(pinyinLoaded);
  if (!pinyinPromise) {
    pinyinPromise = import('pinyin-pro').then((module) => {
      pinyinLoaded = module.pinyin;
      notifyReady();
      return module.pinyin;
    });
  }
  return pinyinPromise;
}

/** 同步读取已加载的 pinyin 函数; 未加载返回 null。 */
export function getPinyin(): PinyinFn | null {
  return pinyinLoaded;
}

/** pinyin 是否已加载 (供 useSyncExternalStore getSnapshot)。 */
export function isPinyinLoaded(): boolean {
  return pinyinLoaded !== null;
}

/**
 * 订阅 pinyin 加载完成; 若已加载, 返回的订阅函数为 no-op (调用方渲染时已读到
 * 最新值)。用于 NotebookIcon 等需要在加载后刷新的组件。
 */
export function subscribePinyinReady(cb: () => void): () => void {
  if (pinyinLoaded) return () => {};
  readyListeners.add(cb);
  return () => {
    readyListeners.delete(cb);
  };
}

export type { PinyinFn };
