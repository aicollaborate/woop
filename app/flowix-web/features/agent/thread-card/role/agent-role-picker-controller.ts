import { getPropertyIconOption } from "@features/document/properties/property-icons";
import {
  getNotebookIconLetter,
  getNotebookIconMarkup,
} from "@features/memo/components/notebook-icon";
import type { I18nKey, I18nParams } from "@/lib/i18n";
import {
  createComposerRoleEmptyIcon,
  createRoleOptionsLoadingIcon,
} from "@features/agent/thread-card/agent-thread-card-icons";
import {
  appendRoleIconContent,
  type AgentRoleOption,
} from "@features/agent/thread-card/agent-thread-card-role";
import {
  fallbackAgentRoleOptionsFromStore,
  listAgentRoleMemosWithTimeout,
  loadAgentRoleBodyFromMemo,
} from "@features/agent/thread-card/role/role-options-loader";
import {
  createAnchoredPopoverController,
  type AnchoredPopoverController,
} from "@features/agent/thread-card/anchored-popover-controller";
import {
  memos as memosClient,
  type MentionNoteSearchItem,
} from "@platform/tauri/client";
import { formatTimeAgo } from "@/lib/format-time-ago";
import { createLogger } from "@/lib/logger";

const logger = createLogger("agent-thread-card-role-picker");

const ROLE_POPOVER_OFFSET_ABOVE_PX = 15;
const ROLE_POPOVER_OFFSET_BELOW_PX = 2;
const ROLE_POPOVER_VIEWPORT_PADDING_PX = 8;
const ROLE_POPOVER_WIDTH_PX = 300;
const ROLE_POPOVER_MAX_HEIGHT_PX = 360;
const ROLE_POPOVER_MIN_HEIGHT_PX = 96;
const NOTE_SEARCH_DEBOUNCE_MS = 150;
const NOTE_SEARCH_LIMIT = 10;

export interface MemoRef {
  id: string;
  filename: string;
  title: string;
}

export interface AgentRolePickerControllerOptions {
  trigger: HTMLButtonElement;
  popover: HTMLDivElement;
  /**
   * 翻译函数 ── 接受可选 I18nParams (memo.time.* 等文案走 params 插值),
   * 跟 lib/i18n/translate 签名一致。
   */
  t: (key: I18nKey, params?: I18nParams) => string;
  isDestroyed: () => boolean;
  getCurrentMemoId: () => string | null;
  getCurrentName: () => string | null;
  getMessageCount: () => number;
  updateRole: (role: { memoId: string; name: string }) => void;
  consumeOutsidePointer: (event: PointerEvent) => void;
  /**
   * 把选中的文档注入到 composer 输入框 ── 以 markdown 深链形式 (便于后端
   * 在 agent 回合里反查 memo body)。
   */
  injectMemoReference: (ref: MemoRef) => void;
}

export class AgentRolePickerController {
  private readonly trigger: HTMLButtonElement;
  private readonly popover: HTMLDivElement;
  private readonly t: (key: I18nKey, params?: I18nParams) => string;
  private readonly isDestroyed: () => boolean;
  private readonly getCurrentMemoId: () => string | null;
  private readonly getCurrentName: () => string | null;
  private readonly getMessageCount: () => number;
  private readonly updateRole: (role: { memoId: string; name: string }) => void;
  private readonly consumeOutsidePointer: (event: PointerEvent) => void;
  private readonly injectMemoReference: (ref: MemoRef) => void;
  private readonly positionController: AnchoredPopoverController;

  private roleOptions: AgentRoleOption[] | null = null;
  private isLoadingRoleOptions = false;
  private roleOptionsRequestSeq = 0;
  private cachedRoleBodies: Map<string, string | null> = new Map();
  private open = false;
  /** 搜索 input / 笔记列表的引用, 方便 refresh() 重渲染时复用 query。 */
  private noteFilter = "";
  /** 笔记搜索结果 ── 后端拉到的笔记元数据 (含 notebookName), 渲染时按 filter 二次裁剪。 */
  private noteHits: MentionNoteSearchItem[] = [];
  /** 当前后端请求序号, 避免晚到的 stale 响应覆盖新数据。 */
  private noteSearchSeq = 0;
  private noteSearchTimer: ReturnType<typeof setTimeout> | null = null;
  private noteSearchLoading = false;

  constructor(options: AgentRolePickerControllerOptions) {
    this.trigger = options.trigger;
    this.popover = options.popover;
    this.t = options.t;
    this.isDestroyed = options.isDestroyed;
    this.getCurrentMemoId = options.getCurrentMemoId;
    this.getCurrentName = options.getCurrentName;
    this.getMessageCount = options.getMessageCount;
    this.updateRole = options.updateRole;
    this.consumeOutsidePointer = options.consumeOutsidePointer;
    this.injectMemoReference = options.injectMemoReference;
    this.positionController = createAnchoredPopoverController({
      isOpen: () => this.open,
      isDestroyed: () => this.isDestroyed(),
      isHidden: () => this.popover.hidden,
      position: () => this.positionPopover(),
      // 同时观察 trigger 与 popover 自身: 搜索过滤 / 异步加载角色
      // 都会让 popover 内容高度变化, 触发 ResizeObserver → 重新定位,
      // 避免 popover 因内容收缩 / 扩张而漂离触发按钮。
      observe: () => [this.trigger, this.popover],
    });

    this.trigger.addEventListener("click", this.handleTriggerClick);
  }

  get isOpen(): boolean {
    return this.open;
  }

  get popoverElement(): HTMLDivElement {
    return this.popover;
  }

  setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.popover.hidden = !open;
    this.syncTriggerOpenState();

    if (open) {
      this.noteFilter = "";
      this.loadRoleOptions();
      this.renderOptionsList();
      this.positionController.schedule();
      this.positionController.start();
      document.addEventListener("pointerdown", this.handleOutsidePointer, true);
    } else {
      this.positionController.stop();
      document.removeEventListener(
        "pointerdown",
        this.handleOutsidePointer,
        true,
      );
      this.cancelPendingNoteSearch();
    }
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  /** 外部 (例如 store 订阅) 想刷新弹窗内容时调用 ── 弹窗隐藏时直接 no-op。 */
  refresh(): void {
    if (!this.open || this.popover.hidden) return;
    this.renderOptionsList();
    this.positionController.schedule();
  }

  refreshIcon(): void {
    const roleName = this.getCurrentName();
    this.trigger.replaceChildren();
    this.trigger.className = "agent-thread-card__composer-role-icon";
    this.syncTriggerOpenState();

    if (!roleName) {
      this.trigger.append(createComposerRoleEmptyIcon());
      this.trigger.title = this.t("editor.threadCard.roleIconTooltip");
      return;
    }

    const entry = this.selectedRoleOption();
    const memoIcon = entry?.memoIcon?.trim() ?? "";
    if (
      !memoIcon &&
      this.getCurrentMemoId() &&
      this.roleOptions === null &&
      !this.isLoadingRoleOptions
    ) {
      this.loadRoleOptions();
    }

    if (!appendRoleIconContent(this.trigger, memoIcon, roleName)) {
      this.trigger.textContent = getNotebookIconLetter(roleName);
    }
    this.trigger.title = roleName;
  }

  async loadRoleBody(memoId: string): Promise<string | null> {
    return loadAgentRoleBodyFromMemo({
      memoId,
      roleOptions: this.getRoleOptions(),
      cache: this.cachedRoleBodies,
      isDestroyed: this.isDestroyed,
    });
  }

  dispose(): void {
    this.setOpen(false);
    this.positionController.dispose();
    this.cancelPendingNoteSearch();
    document.removeEventListener("pointerdown", this.handleOutsidePointer, true);
    this.trigger.removeEventListener("click", this.handleTriggerClick);
    this.popover.remove();
  }

  private handleTriggerClick = (event: MouseEvent): void => {
    event.stopPropagation();
    this.toggle();
  };

  private handleOutsidePointer = (event: PointerEvent): void => {
    if (!this.open) return;
    const target = event.target as globalThis.Node | null;
    if (
      target &&
      (this.popover.contains(target) || this.trigger.contains(target))
    ) {
      return;
    }
    this.setOpen(false);
    this.consumeOutsidePointer(event);
  };

  private syncTriggerOpenState(): void {
    this.trigger.setAttribute("aria-expanded", this.open ? "true" : "false");
    this.trigger.classList.toggle(
      "agent-thread-card__composer-role-icon--open",
      this.open,
    );
  }

  private getRoleOptions(): AgentRoleOption[] {
    return this.roleOptions ?? fallbackAgentRoleOptionsFromStore();
  }

  private loadRoleOptions(): void {
    if (this.isLoadingRoleOptions) return;
    if (this.roleOptions === null) {
      this.roleOptions = fallbackAgentRoleOptionsFromStore();
    }
    const requestSeq = ++this.roleOptionsRequestSeq;
    this.isLoadingRoleOptions = true;
    void listAgentRoleMemosWithTimeout()
      .then((items) => {
        if (this.isDestroyed() || requestSeq !== this.roleOptionsRequestSeq)
          return;
        this.roleOptions = items.map((item) => ({
          memoId: item.memoId,
          name: item.roleName,
          filename: item.filename,
          memoIcon: item.memoIcon,
          notebookId: item.notebookId,
          notebookName: item.notebookName,
          notebookIcon: item.notebookIcon,
        }));
      })
      .catch((error) => {
        logger.error("Failed to load agent-role memos", { error });
        if (
          !this.isDestroyed() &&
          requestSeq === this.roleOptionsRequestSeq
        ) {
          this.roleOptions = fallbackAgentRoleOptionsFromStore();
        }
      })
      .finally(() => {
        if (this.isDestroyed() || requestSeq !== this.roleOptionsRequestSeq)
          return;
        this.isLoadingRoleOptions = false;
        this.refreshIcon();
        if (this.open && !this.popover.hidden) {
          this.renderOptionsList();
          this.positionController.schedule();
        }
      });
  }

  private renderOptionsList(): void {
    this.popover.replaceChildren();
    // 单一入口: 搜索框 + 双分组 (文档 / 角色) 列表。
    // 搜索 active 时跨两组按 title 过滤; 无命中组整体隐藏 header。
    this.popover.append(this.renderUnifiedSection());
  }

  /**
   * 搜索框 + 双分组 section ── 与原来「常用语 + 选择角色」共享同一套视觉节奏:
   *   - 搜索框 + 一组空状态 + 一组列表 复用同一个 role-item 样式
   *   - 分隔线 ── 搜索框与第一组之间、组与组之间, 走真 <hr> 元素
   *     (跟文档标题栏 "…more" 下拉菜单里 <hr> 同源 ── DROPDOWN_DIVIDER_SKIN)
   *   - 笔记命中按 query 命中度由后端排好序, 角色组按记忆顺序展示
   *   - 全无命中时显示统一的「未找到」占位
   */
  private renderUnifiedSection(): DocumentFragment {
    const frag = document.createDocumentFragment();

    // ── 搜索框 ── 无图标, 无边框, 无背景
    const search = document.createElement("input");
    search.type = "text";
    search.className =
      "agent-thread-card__composer-note-search";
    search.placeholder = this.t(
      "editor.threadCard.noteSearch.searchPlaceholder",
    );
    search.spellcheck = false;
    search.autocomplete = "off";
    search.setAttribute(
      "aria-label",
      this.t("editor.threadCard.noteSearch.sectionTitle"),
    );
    search.value = this.noteFilter;

    // ── 容器 ── 装两个分组, 由 helper 各自渲染 (动态)
    const groupsContainer = document.createElement("div");
    groupsContainer.className =
      "agent-thread-card__composer-note-search-list";

    const rerenderGroups = (): void => {
      groupsContainer.replaceChildren();

      const filter = this.noteFilter.trim().toLowerCase();
      const roleEntries = this.getRoleOptions();

      // ── 笔记分组 ── 按 filter 二次裁剪 (title / notebookName 都参与)
      const matchedNotes = filter
        ? this.noteHits.filter(
            (n) =>
              n.title.toLowerCase().includes(filter) ||
              n.filename.toLowerCase().includes(filter) ||
              n.notebookName.toLowerCase().includes(filter),
          )
        : this.noteHits;

      // 收集要渲染的分组 ── 多个分组时, 渲染时在组间插 <hr>
      const groupFragments: DocumentFragment[] = [];
      let hasAny = false;

      // ── 笔记分组 ── 有 hits 显示 hits; 否则给一个轻量的空占位
      if (matchedNotes.length > 0) {
        groupFragments.push(this.renderNotesGroup(matchedNotes));
        hasAny = true;
      } else if (!filter && this.noteHits.length === 0) {
        // 首次打开 / 输入框为空且没搜索过 ── 给一个提示文案
        groupFragments.push(this.renderNotesHintGroup());
        hasAny = true;
      }

      // ── 选择角色分组 ──
      const matchedRoles = filter
        ? roleEntries.filter((r) => r.name.toLowerCase().includes(filter))
        : roleEntries;
      if (matchedRoles.length > 0) {
        groupFragments.push(this.renderRoleGroup(matchedRoles));
        hasAny = true;
      }

      // ── 搜索无任何命中 ──
      if (!hasAny) {
        groupsContainer.append(
          this.createDisabledItem(
            this.t("editor.threadCard.noteSearch.emptyNoMatchGlyph"),
            this.t("editor.threadCard.noteSearch.emptyNoMatch"),
            "",
          ),
        );
        return;
      }

      // 渲染分组 ── 仅在多组之间插 <hr> 分隔线; 单组时不需要组内分隔
      // (搜索框与第一组之间的 <hr> 在 renderUnifiedSection 末尾统一追加)。
      for (let i = 0; i < groupFragments.length; i++) {
        if (i > 0) {
          groupsContainer.append(this.createSectionDivider());
        }
        groupsContainer.append(groupFragments[i]);
      }
    };

    search.addEventListener("input", () => {
      this.noteFilter = search.value;
      this.scheduleNoteSearch(this.noteFilter);
      rerenderGroups();
      // 内容高度变化后重新定位, 让 popover 相对 trigger 重新锚定
      // (虽然 ResizeObserver 也应该触发, 但显式 schedule 兼容
      //  jsdom 等无 ResizeObserver 环境 + 兜底首次渲染抖动)。
      this.positionController.schedule();
    });
    search.addEventListener("keydown", (event) => {
      // 屏蔽 ↑/↓/Enter 冒泡到 composer, 避免和 composer 历史导航 / 提交冲突。
      // Esc 关闭弹窗。
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.setOpen(false);
        return;
      }
      if (
        event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Enter"
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.navigateList(groupsContainer, event.key);
        return;
      }
      event.stopPropagation();
    });

    rerenderGroups();
    // 拼接: 搜索框 ── 分隔线 ── 列表容器 ── 列表容器内部已有组间分隔线
    frag.append(search);
    frag.append(this.createSectionDivider());
    frag.append(groupsContainer);

    // 打开弹窗时自动聚焦搜索框 + 触发一次空查询 (取最近更新 / 索引好的笔记, 给用户一个起点)
    requestAnimationFrame(() => {
      if (this.open && !this.popover.hidden) {
        search.focus();
        if (this.noteHits.length === 0) {
          this.scheduleNoteSearch("");
        }
      }
    });
    return frag;
  }

  /** 分隔线 ── 跟文档标题栏 "…more" 下拉菜单里的 <hr> 同源 (DROPDOWN_DIVIDER_SKIN)。 */
  private createSectionDivider(): HTMLHRElement {
    const hr = document.createElement("hr");
    hr.className =
      "agent-thread-card__composer-note-search-divider";
    return hr;
  }

  /** 笔记分组: header + 列表项。空 hits 时上层调 renderNotesHintGroup 给一个静态提示。
   *  header 右侧不再展示数字计数 ── 列表固定 10 条, 数字本身不携带信号,
   *  跟"角色"组视觉重量对齐, 让两个分组在视觉节奏上一致。 */
  private renderNotesGroup(matched: MentionNoteSearchItem[]): DocumentFragment {
    const frag = document.createDocumentFragment();
    const headerText = this.noteSearchLoading
      ? `${this.t("editor.threadCard.noteSearch.sectionTitle")} · ${this.t("editor.threadCard.noteSearch.searching")}`
      : this.t("editor.threadCard.noteSearch.sectionTitle");
    frag.append(this.createGroupHeader(headerText, ""));

    for (const note of matched) {
      frag.append(this.createNoteItem(note));
    }
    return frag;
  }

  /** 笔记分组空占位 ── 没有 hits 且无 query 时显示, 引导用户开始输入。 */
  private renderNotesHintGroup(): DocumentFragment {
    const frag = document.createDocumentFragment();
    frag.append(this.createGroupHeader(
      this.t("editor.threadCard.noteSearch.sectionTitle"),
      "",
    ));
    frag.append(this.createDisabledItem(
      this.t("editor.threadCard.noteSearch.emptyHintGlyph"),
      this.t("editor.threadCard.noteSearch.emptyHint"),
      "",
    ));
    return frag;
  }

  /** 选择角色分组: header + 列表项 */
  private renderRoleGroup(matched: AgentRoleOption[]): DocumentFragment {
    const frag = document.createDocumentFragment();

    const isLocked = this.getMessageCount() > 0;
    const headerText = isLocked
      ? `${this.t("editor.threadCard.selectRole")} ${this.t(
          "editor.threadCard.selectRoleLocked",
        )}`
      : this.t("editor.threadCard.selectRole");
    const header = this.createGroupHeader(headerText, "");
    if (this.isLoadingRoleOptions) {
      header.append(createRoleOptionsLoadingIcon());
    }
    frag.append(header);

    const currentMemoId = this.getCurrentMemoId();
    for (const entry of matched) {
      const item = this.createRoleItem(entry, currentMemoId, isLocked);
      frag.append(item);
    }
    return frag;
  }

  /** 创建 popover group header (复用 role-popover-header 样式)。 */
  private createGroupHeader(text: string, suffix: string): HTMLDivElement {
    const header = document.createElement("div");
    header.className = "agent-thread-card__composer-role-popover-header";
    const title = document.createElement("div");
    title.className = "agent-thread-card__composer-role-popover-title";
    title.textContent = text;
    header.append(title);
    if (suffix) {
      const meta = document.createElement("span");
      meta.className = "agent-thread-card__composer-role-popover-meta";
      meta.textContent = suffix;
      header.append(meta);
    }
    return header;
  }

  /** 创建单条角色项 — 不再渲染 desc (副标题已移除) */
  private createRoleItem(
    entry: AgentRoleOption,
    currentMemoId: string | null,
    isLocked: boolean,
  ): HTMLButtonElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "agent-thread-card__composer-role-item";
    item.setAttribute("role", "menuitem");

    const isCurrent = entry.memoId === currentMemoId;
    if (isCurrent) {
      item.classList.add("agent-thread-card__composer-role-item--selected");
    }
    if (isLocked && !isCurrent) {
      item.classList.add("agent-thread-card__composer-role-item--disabled");
      item.disabled = true;
      item.setAttribute("aria-disabled", "true");
    }

    const sourceIcon = document.createElement("span");
    sourceIcon.className = "agent-thread-card__composer-role-item-icon";
    const memoIcon = entry.memoIcon?.trim() || "";
    if (appendRoleIconContent(sourceIcon, memoIcon, entry.name)) {
      sourceIcon.classList.toggle(
        "agent-thread-card__composer-role-item-icon--svg",
        !!getNotebookIconMarkup(memoIcon) && !getPropertyIconOption(memoIcon),
      );
    } else {
      sourceIcon.textContent = getNotebookIconLetter(entry.name);
    }

    const body = document.createElement("span");
    body.className = "agent-thread-card__composer-role-item-body";
    const name = document.createElement("span");
    name.className = "agent-thread-card__composer-role-item-name";
    name.textContent = entry.name;
    body.append(name);
    item.append(sourceIcon, body);

    if (!isLocked || isCurrent) {
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        this.updateRole({ memoId: entry.memoId, name: entry.name });
        this.setOpen(false);
      });
    }
    return item;
  }

  /** 单条笔记命中项 ── 主行展示笔记标题, 右侧展示上次编辑相对时间; 点击后注入引用。
   *  视觉上不画左侧图标, 也不保留图标的水平占位 ── 文本直接从 item padding
   *  后开始, 让笔记组看起来是「按名称排版」的紧凑列表, 跟角色组
   *  (图标作为视觉锚点) 形成明显区分。
   *
   *  笔记本名 不再以副标题形式出现 ── 信息密度过高会让单条笔记占据两行高度,
   *  在 10 条列表里视觉权重不均; 完整上下文 (title · notebookName) 仍
   *  保留在 native tooltip 里, hover 时能看到。
   *
   *  右侧时间 ── 复用 memo-card 的 formatTimeAgo + 同一套阈值 (刚刚 → 秒 → 分 →
   *  时 → 天 → 月), 视觉重量与 memo card 底部时间标签同源
   *  (`text-xs tabular-nums text-[var(--muted-foreground)]`), 让"上次编辑时间"
   *  在弹窗与主列表呈现一致的口径。 */
  private createNoteItem(note: MentionNoteSearchItem): HTMLButtonElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className =
      "agent-thread-card__composer-role-item agent-thread-card__composer-note-item";
    item.setAttribute("role", "menuitem");
    // native tooltip: 让 hover 时看到完整上下文 (filename 与 title 可能不同)
    item.title = `${note.title} · ${note.notebookName}`;

    const body = document.createElement("span");
    body.className = "agent-thread-card__composer-role-item-body";
    const name = document.createElement("span");
    name.className = "agent-thread-card__composer-role-item-name";
    name.textContent = note.title || note.filename;
    body.append(name);

    // 顺序: 先 body 后 time ── item 是 flex (gap: 10px), body flex: 1 1 auto
    // 占满剩余空间, time flex: 0 0 auto 紧贴其后, 自然推到右侧。
    // updatedAt 缺失或 0 时不渲染, 避免出现"刚刚"假数据。
    item.append(body);
    if (note.updatedAt > 0) {
      // 用 <time> 元素 + dateTime 属性 (ISO 8601), 与对话列表
      // `agent-conversation-list.tsx` 右上时间标签同源:
      //   <time className="shrink-0 text-xs text-[var(--muted-foreground)]"
      //         dateTime={new Date(updatedAt).toISOString()}>
      //     {formatTimeAgo(updatedAt, t)}
      //   </time>
      // ── 同样的 DOM 形态 (语义 + ARIA 友好), 同样的样式 (text-xs +
      //  muted-foreground + shrink-0), 同样的文案 (formatTimeAgo, 跨
      //  弹窗 / 列表 / memo card 共享同一套阈值与 i18n 文案)。
      const time = document.createElement("time");
      time.className =
        "agent-thread-card__composer-role-item-time";
      time.setAttribute(
        "dateTime",
        new Date(note.updatedAt).toISOString(),
      );
      time.textContent = formatTimeAgo(note.updatedAt, this.t);
      item.append(time);
    }

    item.addEventListener("click", (event) => {
      event.stopPropagation();
      this.injectMemoReference({
        id: note.id,
        filename: note.filename,
        title: note.title || note.filename,
      });
      this.setOpen(false);
    });
    return item;
  }

  /** ↑/↓ 在所有可见项间移动焦点; Enter 选中当前高亮项。
   *  容器内所有 role-item 都是可选项 (文档 + 角色)。 */
  private navigateList(
    list: HTMLElement,
    key: "ArrowDown" | "ArrowUp" | "Enter",
  ): void {
    const items = Array.from(
      list.querySelectorAll<HTMLButtonElement>(
        ".agent-thread-card__composer-role-item:not([disabled])",
      ),
    );
    if (items.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const currentIndex = active
      ? items.findIndex((el) => el === active)
      : -1;
    if (key === "Enter") {
      if (currentIndex >= 0) items[currentIndex].click();
      else items[0]?.click();
      return;
    }
    const delta = key === "ArrowDown" ? 1 : -1;
    const next = currentIndex < 0
      ? (delta > 0 ? 0 : items.length - 1)
      : Math.max(0, Math.min(items.length - 1, currentIndex + delta));
    items[next]?.focus();
  }

  private createDisabledItem(
    fallbackText: string,
    nameText: string,
    descText: string,
  ): HTMLButtonElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className =
      "agent-thread-card__composer-role-item agent-thread-card__composer-role-item--disabled";
    item.disabled = true;
    item.setAttribute("role", "menuitem");

    const fallback = document.createElement("span");
    fallback.className = "agent-thread-card__composer-role-item-fallback";
    fallback.textContent = fallbackText;
    const body = document.createElement("span");
    body.className = "agent-thread-card__composer-role-item-body";
    const name = document.createElement("span");
    name.className = "agent-thread-card__composer-role-item-name";
    name.textContent = nameText;
    const desc = document.createElement("span");
    desc.className = "agent-thread-card__composer-role-item-desc";
    desc.textContent = descText;
    body.append(name, desc);
    item.append(fallback, body);
    return item;
  }

  private selectedRoleOption(): AgentRoleOption | null {
    const memoId = this.getCurrentMemoId();
    const roleName = this.getCurrentName();
    if (!memoId && !roleName) return null;
    const entries = this.getRoleOptions();
    return (
      entries.find((entry) => entry.memoId === memoId) ??
      entries.find((entry) => roleName !== null && entry.name === roleName) ??
      null
    );
  }

  /** 防抖触发后端笔记搜索 ── 与原 quick-phrases 弹窗的同步过滤不同, 笔记库是后端索引,
   *  走 IPC 拉 items, 用 150ms debounce + 序号合并避免晚到的响应覆盖新数据。
   *
   *  选用 `searchMentionNotes` 而非 `search_memos` ── 前者返回
   *  MentionNoteSearchItem (含 notebookName), 渲染副标题时直接拿到
   *  笔记本名, 不用再二次查表。 `search_memos` 返回的是
   *  MemoSearchHit (带 snippet, 但缺 notebookName), 不适合本场景。 */
  private scheduleNoteSearch(query: string): void {
    this.cancelPendingNoteSearch();
    const mySeq = ++this.noteSearchSeq;
    this.noteSearchLoading = true;
    this.noteSearchTimer = setTimeout(() => {
      this.noteSearchTimer = null;
      void memosClient
        .searchMentionNotes(query.trim(), NOTE_SEARCH_LIMIT)
        .then((items) => {
          if (this.isDestroyed() || mySeq !== this.noteSearchSeq) return;
          this.noteHits = items;
          this.noteSearchLoading = false;
          if (this.open && !this.popover.hidden) {
            this.renderOptionsList();
            this.positionController.schedule();
          }
        })
        .catch((error) => {
          if (this.isDestroyed() || mySeq !== this.noteSearchSeq) return;
          logger.error("Note search failed", { error, query });
          this.noteSearchLoading = false;
          this.noteHits = [];
          if (this.open && !this.popover.hidden) {
            this.renderOptionsList();
            this.positionController.schedule();
          }
        });
    }, NOTE_SEARCH_DEBOUNCE_MS);
  }

  private cancelPendingNoteSearch(): void {
    if (this.noteSearchTimer !== null) {
      clearTimeout(this.noteSearchTimer);
      this.noteSearchTimer = null;
    }
    // 提早 seq 推进, 让进行中的请求返回时被丢弃
    this.noteSearchSeq++;
    this.noteSearchLoading = false;
  }

  private positionPopover(): void {
    if (!this.open || this.popover.hidden || this.isDestroyed()) return;
    if (!this.trigger.isConnected || !this.popover.isConnected) {
      this.setOpen(false);
      return;
    }

    const anchorRect = this.trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = ROLE_POPOVER_VIEWPORT_PADDING_PX;
    const spaceAbove =
      anchorRect.top - padding - ROLE_POPOVER_OFFSET_ABOVE_PX;
    const spaceBelow =
      viewportHeight -
      anchorRect.bottom -
      padding -
      ROLE_POPOVER_OFFSET_BELOW_PX;
    const placeAbove =
      spaceAbove >= ROLE_POPOVER_MIN_HEIGHT_PX || spaceAbove >= spaceBelow;

    const popoverRect = this.popover.getBoundingClientRect();
    const popoverWidth = popoverRect.width || ROLE_POPOVER_WIDTH_PX;
    const popoverHeight = popoverRect.height || ROLE_POPOVER_MAX_HEIGHT_PX;
    const maxLeft = Math.max(padding, viewportWidth - padding - popoverWidth);
    const left = Math.min(Math.max(anchorRect.left, padding), maxLeft);
    const offset = placeAbove
      ? ROLE_POPOVER_OFFSET_ABOVE_PX
      : ROLE_POPOVER_OFFSET_BELOW_PX;
    const rawTop = placeAbove
      ? anchorRect.top - offset - popoverHeight
      : anchorRect.bottom + offset;
    const maxTop = Math.max(padding, viewportHeight - padding - popoverHeight);
    const top = Math.min(Math.max(rawTop, padding), maxTop);

    this.popover.style.left = `${left}px`;
    this.popover.style.top = `${top}px`;
  }
}