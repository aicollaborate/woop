export const SELECTED_ITEM_SCROLL_PADDING_TOP = 20;

export function scrollSelectedItemIntoView(
  scroller: HTMLElement,
  item: HTMLElement,
  paddingTop = SELECTED_ITEM_SCROLL_PADDING_TOP,
): void {
  const scrollerRect = scroller.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const itemTop = itemRect.top - scrollerRect.top + scroller.scrollTop;
  const itemBottom = itemRect.bottom - scrollerRect.top + scroller.scrollTop;
  const visibleTop = scroller.scrollTop + paddingTop;
  const visibleBottom = scroller.scrollTop + scroller.clientHeight;

  if (itemTop >= visibleTop && itemBottom <= visibleBottom) return;

  const targetTop = itemTop - paddingTop;
  const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  scroller.scrollTop = Math.max(0, Math.min(targetTop, maxScrollTop));
}
