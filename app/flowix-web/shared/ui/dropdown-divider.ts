/**
 * Dropdown / 中间列等弹层内 1px 分隔线皮肤。
 *
 * 颜色走 `--border` 主题变量 — 改 token 即可一次性影响所有出现位置。
 * opacity-90 (而非 50) 在 dark 主题下也能保持清晰可见; 如果之后想再调,
 * 改这一行比 grep 13 处更安全。
 *
 * 调用点惯例:
 *   <hr className={cn('mx-2 my-1 border-0', DROPDOWN_DIVIDER_SKIN)} />
 *
 * margin(`mx-2` / `mx-3` / `mx-2 my-1`) 和 `border-0`(dropdown 内必须, 否则 hr
 * 默认 0.5em 上下留白 + 灰色 1px 边框会把整条 hr 撑粗) 由调用点决定, 这部分跟
 * 布局有关, 不应该被 token 化, 否则调用点布局调试会很难追。
 */
export const DROPDOWN_DIVIDER_SKIN = 'border-t border-[var(--border)] opacity-90';
