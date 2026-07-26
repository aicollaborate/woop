//! `MemoEventProcessor` 鈥?鎶?`RawFsEvent` 杞垚 `MemoEvent` 骞?emit銆?//!
//! watcher manager 不直接调 `MemoFile` �?register / reload / unregister,
//! 统一委派给本模块。pipeline 跑过之后, �?`RawFsEvent` 喂给
//! `MemoEventProcessor::process`, 它看 event.kind 分派, �?register_unnamed /
//! reload / unregister, 最�?emit `MemoEvent` (�?dispatcher 抽象, �?channel
//! 后续在这�?extend)�?//!
//! `process` �?��步的: 拿到事件 �?同�?�?//! `MemoFile` (Arc<RwLock>) �?同�? emit �?返回。notify 回调线程�?await�?
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::memo_events::{emit, MemoChangeSource, MemoDerivedChanged, MemoEvent};
use crate::watcher::event::{FsEventKind, RawFsEvent};
use flowix_core::memo_file::{extract_frontmatter_key, Memo, MemoFile};

#[derive(Debug, Clone)]
pub struct NotebookWatchContext {
    pub notebook_id: String,
    pub root: PathBuf,
}

/// 业务处理�?—状态由调用方注�?(memo_file / app)�?///
/// 故意不做�?struct 持字�? 而是 stateless: `process` 接收所有依赖。原�?
/// manager �?notify 回调�?��已经�?`move |res| { ... }`, �?��捕获
/// Arc<MemoFile> / AppHandle 引用, 不需�?processor 内部再持一份�?
pub struct MemoEventProcessor;

/// �?��数分流结�? dispatcher 决定�?emit �?��事件 + 附带的副作用数据�?
#[derive(Debug)]
pub(crate) enum DispatchOutcome {
    /// �?Updated �?��, 无副作用
    Updated(MemoEvent),
    /// �?Created �?��, 需�?caller �?mark_self_write(new_abs_path) 抑制
    /// 鍚庣画 notify 浜嬩欢
    Created {
        event: MemoEvent,
        new_abs_path: PathBuf,
    },
}

fn read_indexed_memo_after_external_marker(
    memo_file: &MemoFile,
    notebook_id: &str,
    memo_id: &str,
) -> Option<Memo> {
    if let Some(memo) = memo_file.read_memo_for_notebook_id(notebook_id, memo_id) {
        return Some(memo);
    }
    if !memo_file
        .has_pending_external_memo_create(memo_id, notebook_id)
        .unwrap_or(false)
    {
        return None;
    }

    // The marker is committed before the markdown file is published. Give the
    // creating process a short opportunity to commit the corresponding memo row.
    for _ in 0..8 {
        std::thread::sleep(Duration::from_millis(25));
        if let Some(memo) = memo_file.read_memo_for_notebook_id(notebook_id, memo_id) {
            return Some(memo);
        }
    }
    None
}

fn emit_updated_for_context(
    ctx: &NotebookWatchContext,
    before: Option<&Memo>,
    memo: Memo,
) -> DispatchOutcome {
    let entry_path = ctx.root.join(&memo.filename).display().to_string();
    let derived_changed = MemoDerivedChanged::from_memos(before, &memo);
    DispatchOutcome::Updated(MemoEvent::Updated {
        id: memo.id.clone(),
        path: entry_path,
        notebook_id: ctx.notebook_id.clone(),
        memo,
        derived_changed,
        source: MemoChangeSource::ExternalTool,
    })
}

fn emit_created_for_context(
    ctx: &NotebookWatchContext,
    memo: Memo,
    new_abs_path: PathBuf,
) -> DispatchOutcome {
    let derived_changed = MemoDerivedChanged::from_memos(None, &memo);
    DispatchOutcome::Created {
        event: MemoEvent::Created {
            notebook_id: ctx.notebook_id.clone(),
            derived_changed,
            memo,
            source: MemoChangeSource::ExternalTool,
        },
        new_abs_path,
    }
}

/// Frontmatter-key-first 分流: 给一�?Create/Modify 事件�?abs path,
/// 决定 emit �?? MemoEvent�?///
/// **磁盘 frontmatter �?`key` 字�?�?id 真源**, 文件名是派生属性。�?磁盘 �?/// �?key �?�?memo index 里按 id 反查, 命中即用 key 对应�?entry; 不命�?/// 才退�?filename 兜底�?///
/// 这样做的核心收益: rename �?fs::rename 拆成�?From + To 两条事件, To 事件
/// 读到�?frontmatter key 跟旧 entry �?id 一�?�?命中 �?�?`rename_memo_file`
/// �?entry.filename, id 保留。完全不需�?inode_tracker / file_index 这些 OS �?/// 元数�? �?NTFS / FAT32 / exFAT / 网络�?/ symlink 上�?为一致�?///
/// 分流规则 (�?disk key + memo index 状�?:
/// - key 命中 + filename 一�? reload (重派�?preview/tags/todos)
/// - key 命中 + filename 不一�?+ old file 已不存在: physical rename, 保留 id
/// - key 命中 + filename 不一�?+ old file 仍存�? pasted duplicate, 新建 memo 并刷�?key
/// - key 不在当前 memo index: pasted/imported markdown, 新建 memo 并刷�?key
/// - �?key + filename �?memo index: reload (保留 id/filename, 用户保存时会注入 key)
/// - �?key + filename 不在: register (生成�?id, 通过 merge_frontmatter 注入)
///
/// �?`process()` 抽出来好做单�?(process �?��依赖 AppHandle, 不易�?;
/// 分流规则�?�� MemoFile 状态有�? �?Tauri 解耦�?
/// 测试入口: 不需要自写抑制的调用方走这条, mark 传 no-op。生产路径 (`process`) 直接
/// 调 [`dispatch_modify_event_with_mark`], 在每个写盘分支 *之前* mark_self_write ──
/// 关闭 "stamp 写盘触发的 self-write notify 事件先于 mark 到达" 的 race window (见
/// manager.rs 模块头注释)。此前 mark 在写盘之后做、靠 process 跑在 notify 共享线程上
/// 的串行性兜底; process 移到 worker 线程后那层串行性没了, 必须改成写盘前 mark。
#[cfg(test)]
pub(crate) fn dispatch_modify_event(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    path: &Path,
    event_kind: FsEventKind,
) -> Result<DispatchOutcome, String> {
    dispatch_modify_event_with_mark(memo_file, ctx, path, event_kind, |_: &Path| {})
}

fn dispatch_modify_event_with_mark(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    path: &Path,
    _event_kind: FsEventKind,
    mark: impl Fn(&Path),
) -> Result<DispatchOutcome, String> {
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("invalid path: {}", path.display()))?
        .to_string();

    // 读�?盘抽 frontmatter key ── id 真源。�?失败 (权限 / 临时消失) 退�?    // filename-based 兜底, 行为等同�?refactor 前�?
    let disk_key = std::fs::read_to_string(path)
        .ok()
        .and_then(|c| extract_frontmatter_key(&c));

    match disk_key {
        Some(id) => match read_indexed_memo_after_external_marker(memo_file, &ctx.notebook_id, &id)
        {
            Some(existing) if existing.filename == filename => {
                if memo_file
                    .has_pending_external_memo_create(&id, &ctx.notebook_id)
                    .unwrap_or(false)
                {
                    tracing::info!(
                        "[MemoWatcher] claimed external create marker: id={} path={}",
                        existing.id,
                        path.display(),
                    );
                    let refreshed = memo_file.reload_memo_from_disk_by_filename_for_notebook_id(
                        &ctx.notebook_id,
                        &filename,
                    )?;
                    if memo_file
                        .consume_pending_external_memo_create(&id, &ctx.notebook_id)
                        .unwrap_or(false)
                    {
                        Ok(emit_created_for_context(ctx, refreshed, path.to_path_buf()))
                    } else {
                        Ok(emit_updated_for_context(ctx, Some(&existing), refreshed))
                    }
                } else {
                    reload_existing_memo(memo_file, ctx, &filename)
                }
            }
            Some(existing) => {
                // Rename handling must be idempotent. The internal save path can
                // update the index before this watcher event obtains the index lock,
                // so the locked sync below resolves by id and accepts both old->new
                // and already-new index states.
                let old_path = ctx.root.join(&existing.filename);
                if is_physical_rename_candidate(&old_path) {
                    // sync_renamed_memo_from_key 不写 memo 文件 (只读 + 改 in-memory index),
                    // 无 self-write, 不需要 mark。
                    sync_renamed_memo_from_key(memo_file, ctx, &existing, &id, &old_path, path)
                } else {
                    // register_pasted_copy_as_new -> register_existing_file_as_new 会
                    // atomic_write_bytes 把 key stamp 进文件: 必须先 mark 再写。
                    mark(path);
                    register_pasted_copy_as_new(memo_file, ctx, path, Some(&id))
                }
            }
            None => {
                mark(path);
                register_pasted_copy_as_new(memo_file, ctx, path, Some(&id))
            }
        },
        None => {
            // Disk �?frontmatter key: 不能�?id 反查, 退�?filename-based�?
            if memo_file
                .find_memo_by_filename_for_notebook_id(&ctx.notebook_id, &filename)
                .is_some()
            {
                reload_existing_memo(memo_file, ctx, &filename)
            } else {
                // 新文件无 key: register_existing_file_for_notebook_id �?generate-new-id + stamp �?��
                mark(path);
                let memo =
                    memo_file.register_existing_file_for_notebook_id(&ctx.notebook_id, path)?;
                Ok(emit_created_for_context(ctx, memo, path.to_path_buf()))
            }
        }
    }
}

fn reload_existing_memo(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    filename: &str,
) -> Result<DispatchOutcome, String> {
    let before = memo_file.find_memo_by_filename_for_notebook_id(&ctx.notebook_id, filename);
    let updated =
        memo_file.reload_memo_from_disk_by_filename_for_notebook_id(&ctx.notebook_id, filename)?;
    Ok(emit_updated_for_context(ctx, before.as_ref(), updated))
}

fn is_physical_rename_candidate(old_path: &Path) -> bool {
    !old_path.exists()
}

/// path �?��在当�?notebook �?`attachments/` �?���? 这层判断�?���?/// [`crate::watcher::WhitelistConfig`], 因为 whitelist �?? preference.json
/// 瑕嗙洊, 鐢ㄦ埛鐨勬棫閰嶇疆鍙兘婕忛厤 `attachments`. processor 鍦ㄥ叆鍙ｈ蛋杩欓亾闃茬嚎,
/// �?attachments/ 下的任何 .md 文件 (无�?�?���??复制进来的另一台笔记本
/// 的笔�? 都直接拒�? 避免"幽灵笔�?"污染 memo 列表.
///
/// �?[`crate::watcher::path::normalize_for_compare`] 而不�?�� `starts_with`:
/// - canonicalize 任一边失败都退�?父目�?canonicalize + join"回退�?��,
///   文件刚写盘但 fs 元数�?��就绪时仍能给出�?�?���?/// - 同一�?normalize �?watcher 抑制�?(`SelfWriteSuppressor` /
///   `Debouncer`) 口径一�? 避免半状态路�?(canonical vs �?canonical)
///   缁曡繃杩欓亾闃茬嚎
/// - 不再�?component-level 匹配 (`parent.file_name == "attachments"`),
///   那�?匹配会�?杀 `bar/attachments/foo.md` 这�?"嵌�?同名子目�?�?��.
fn is_under_attachments_dir(ctx: &NotebookWatchContext, path: &Path) -> bool {
    let attachments_dir =
        crate::watcher::path::normalize_for_compare(&ctx.root.join("attachments"));
    let path_norm = crate::watcher::path::normalize_for_compare(path);
    path_norm.starts_with(&attachments_dir)
}

/// Memo files live directly under the notebook root. The watcher itself is
/// recursive because it also observes notebook-owned auxiliary directories,
/// but Markdown files below arbitrary subdirectories are regular documents,
/// not memos, and must never be registered in the memo index.
fn is_direct_notebook_child(ctx: &NotebookWatchContext, path: &Path) -> bool {
    let root = crate::watcher::path::normalize_for_compare(&ctx.root);
    let path = crate::watcher::path::normalize_for_compare(path);
    path.parent().is_some_and(|parent| parent == root)
}

fn sync_renamed_memo_from_key(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    before: &Memo,
    id: &str,
    old_path: &Path,
    new_path: &Path,
) -> Result<DispatchOutcome, String> {
    tracing::info!(
        "[MemoWatcher] rename detected via frontmatter key {}: {} -> {}",
        id,
        old_path.display(),
        new_path.display(),
    );
    let updated = memo_file.sync_memo_filename_from_disk_key_for_notebook_id(
        &ctx.notebook_id,
        id,
        new_path,
    )?;
    Ok(emit_updated_at(ctx, Some(before), updated, new_path))
}

fn register_pasted_copy_as_new(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    path: &Path,
    disk_key: Option<&str>,
) -> Result<DispatchOutcome, String> {
    if let Some(id) = disk_key {
        tracing::info!(
            "[MemoWatcher] markdown key {} treated as pasted/imported document, stamping fresh key: {}",
            id,
            path.display(),
        );
    }
    let memo = memo_file.register_existing_file_as_new_for_notebook_id(&ctx.notebook_id, path)?;
    Ok(emit_created_for_context(ctx, memo, path.to_path_buf()))
}

/// �?[`emit_updated`] 但路径用事件原�? path (rename 场景下是新位�?��绝�?�?��)�?
fn emit_updated_at(
    ctx: &NotebookWatchContext,
    before: Option<&Memo>,
    memo: Memo,
    abs_path: &Path,
) -> DispatchOutcome {
    let entry_path = abs_path.display().to_string();
    let derived_changed = MemoDerivedChanged::from_memos(before, &memo);
    DispatchOutcome::Updated(MemoEvent::Updated {
        id: memo.id.clone(),
        path: entry_path,
        notebook_id: ctx.notebook_id.clone(),
        memo,
        derived_changed,
        source: MemoChangeSource::ExternalTool,
    })
}

fn wait_for_markdown_copy_to_settle(path: &Path) {
    let mut last_len = None;
    let mut stable_samples = 0;

    for _ in 0..8 {
        let Ok(meta) = std::fs::metadata(path) else {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        };
        if !meta.is_file() {
            return;
        }

        let len = meta.len();
        if Some(len) == last_len {
            stable_samples += 1;
            if stable_samples >= 2 && std::fs::File::open(path).is_ok() {
                return;
            }
        } else {
            last_len = Some(len);
            stable_samples = 0;
        }

        std::thread::sleep(Duration::from_millis(50));
    }
}

fn try_update_search_index(app: &AppHandle, id: &str) {
    if let Some(state) = app.try_state::<crate::app::state::AppState>() {
        crate::app::search_index::try_index_upsert(state.inner(), id);
    }
}

fn try_remove_from_search_index(app: &AppHandle, id: &str) {
    if let Some(state) = app.try_state::<crate::app::state::AppState>() {
        crate::app::search_index::try_index_remove(state.inner(), id);
    }
}

impl MemoEventProcessor {
    /// 入口 —pipeline 跑过之后调用, 事件已通过 filter�?    ///
    /// 琛屼负:
    /// - Create/Modify: 文件存在 �?key-first 分流; 不存�?�?unregister
    /// - Remove:        unregister (�?filename �?memo index, 命中�? 没命�?no-op)
    /// - Other:         蹇界暐
    pub fn process(
        event: &RawFsEvent,
        app: &AppHandle,
        memo_file: &Arc<std::sync::RwLock<MemoFile>>,
        ctx: &NotebookWatchContext,
    ) {
        if !is_direct_notebook_child(ctx, &event.path) {
            tracing::debug!(
                "[MemoWatcher] processor skipped non-root Markdown path: {}",
                event.path.display()
            );
            return;
        }

        // 防御性拦�? 附件�?��下的 .md 文件不是 memo, 一律不处理.
        // 后�? `save_attachment` / `save_attachment_content` 会把任意�?�?        // �?��文件复制�?`<notebook>/attachments/`, 包括用户选了另一�?        // notebook 的笔�?.md —这�?情况 attachment �?��里会出现一�?        // 不�?出现�?memo 列表里的"幽灵笔�?".
        //
        // 这道防线�?���?whitelist (whitelist �?���?��户的 preference.json
        // 覆盖, 或�?hot-update 期间窗口�?��不一�?, �?processor 入口
        // 拒掉, �?create / modify / remove 三�? kind 的最后一道闸�?
        if is_under_attachments_dir(ctx, &event.path) {
            tracing::debug!(
                "[MemoWatcher] processor skipped attachments/ path: {}",
                event.path.display()
            );
            return;
        }

        match event.kind {
            FsEventKind::Create | FsEventKind::Modify => {
                let path = &event.path;
                if !path.exists() {
                    // Modify 事件但文件没�?—�?Delete �?��
                    Self::unregister_and_emit(app, memo_file, ctx, path);
                    return;
                }
                wait_for_markdown_copy_to_settle(path);

                // Frontmatter-key-first 分流 ── 详情�?[`dispatch_modify_event`]�?
                let outcome = match memo_file.read() {
                    Ok(mf) => dispatch_modify_event_with_mark(
                        &mf,
                        ctx,
                        path,
                        event.kind,
                        |p| crate::watcher::runtime::mark_self_write_for(app, p),
                    ),
                    Err(_) => return,
                };
                match outcome {
                    Ok(DispatchOutcome::Updated(event)) => {
                        if let MemoEvent::Updated { id, .. } = &event {
                            try_update_search_index(app, id);
                        }
                        emit(app, event)
                    }
                    Ok(DispatchOutcome::Created {
                        event,
                        new_abs_path,
                    }) => {
                        tracing::info!("[MemoWatcher] registered: {}", new_abs_path.display(),);
                        if let Some(w) = crate::watcher::current_watcher(app) {
                            if let Ok(g) = w.read() {
                                g.mark_self_write(&new_abs_path);
                            }
                        }
                        if let MemoEvent::Created { memo, .. } = &event {
                            try_update_search_index(app, &memo.id);
                        }
                        emit(app, event);
                    }
                    Err(e) => {
                        tracing::warn!(
                            "[MemoWatcher] dispatch_modify_event failed for {}: {e}",
                            path.display()
                        );
                    }
                }
            }
            FsEventKind::Remove => {
                // Remove 事件�?filename �?── 没有 inode_tracker 也无所�?
                // - GUI �?���?SelfWriteSuppressor 已经吞了 From 事件, 走不到这�?                // - 外部 rename �?From 事件: �?unregister_and_emit, 后跟�?To
                //   事件�?key-first 分流�?(c) 分支, 用�?�?frontmatter key 重建
                //   entry, id 保留 (�?createdAt/updatedAt 会重�?�� now, 因为
                //   从�?盘�?不到原�?时间�? 这是 frontmatter-key-first 在�?�?                //   rename 场景下相�?inode_tracker 的取�?
                Self::unregister_and_emit(app, memo_file, ctx, &event.path);
            }
            FsEventKind::Other => {
                // Access / Other —忽略
            }
        }
    }

    pub(crate) fn unregister_and_emit(
        app: &AppHandle,
        memo_file: &Arc<std::sync::RwLock<MemoFile>>,
        ctx: &NotebookWatchContext,
        path: &Path,
    ) {
        // v2: inode 还在 tracker 里的�? 这是 rename 的旧位置, 跳过 unregister
        // (�?Create(new) �?rename 配�?�?��)�?process() 已经先做了一次�?�?
        // 这里�?defense-in-depth 一欰�?
        let Ok(mf) = memo_file.read() else {
            return;
        };
        // 鐗╃悊鏂囦欢鍚嶆槸 `<title>.md` (id 璺熸枃浠跺悕瑙ｈ€?, 鏃у疄鐜颁細鎶婄┖ id 鍙戝埌鍓嶇,
        // �?`handleMemoDeleted` �?`memos.filter(m => m.id !== "")` 一条都
        // 过滤不掉 -> 幽灵笔�?�?        //
        // �?��: **�?`unregister_memo_by_path` 之前**�?filename 反查 memo index
        // 拿到真实 id。`unregister_memo_by_path` 内部就是用同一 filename 匹配 + �?        // entry, 所以这里查到的 id 跟它即将删的那条�?��一�? 不存�?race -- 都是
        // �?`current_index_io` 锁串行化, 内部�?? + �?memo index 一欰�?        //
        // 拿不�?id 的两种情�?
        // - �?��里没有合法的 .md 文件�?(�?`..`): 直接放弃 emit, 反�?
        //   `unregister_memo_by_path` 也会 return false, memo index 没动�?        // - filename 不在 memo index (孤立 .md / 已经�?���?: 同样放弃 emit, 不凭�?        //   generate id, 保持 id 一定来�?memo index 这个不变量�?
        let Some(filename) = path.file_name().and_then(|n| n.to_str()) else {
            return;
        };
        let Some(memo) = mf.find_memo_by_filename_for_notebook_id(&ctx.notebook_id, filename)
        else {
            tracing::debug!(
                "[MemoWatcher] unregister_and_emit: no memo index entry for filename={}, skipping emit (unregister will also no-op)",
                filename
            );
            return;
        };
        let id = memo.id.clone();
        let derived_changed = MemoDerivedChanged::from_deleted(&memo);
        if !mf.unregister_memo_by_path_for_notebook_id(&ctx.notebook_id, path) {
            return;
        }
        let entry_path = path.display().to_string();
        try_remove_from_search_index(app, &id);
        // emit 带真�?id �?Deleted, 让前�?handleMemoDeleted 能精准从
        // 列表 filter �?(避免 id=“�?�?filter 什么都不丢、只能靠
        // triggerRefresh 重拉补救)�?path 依然传出, 供会话点�?path 匹配�?
        emit(
            app,
            MemoEvent::Deleted {
                id,
                path: entry_path,
                notebook_id: ctx.notebook_id.clone(),
                derived_changed,
                source: MemoChangeSource::ExternalTool,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    //! 覆盖 `dispatch_modify_event` �?��数的两�?分流�?���?    //!
    //! 不依�?Tauri AppHandle / MemoWatcher / inode tracker ── �?MemoFile
    //! 直接调纯函数, �?�� emit 出来的事�?kind/path/memo 字�?�?    //!
    //! setup pattern �?flowix-core �?`fresh_memo_file` 一�? tempdir +
    //! seed notebook registry + MemoFile::new銆?
    use super::*;
    use flowix_core::memo_file::MemoFile;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// 构造一�?���?tempdir �?MemoFile, tempdir 模拟 "default notebook"�?
    fn fresh_memo_file() -> (MemoFile, PathBuf) {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let tmp = std::env::temp_dir().join(format!(
            "flowix-watcher-processor-test-{}-{}-{}",
            std::process::id(),
            n,
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let app_data = tmp.join("app_data");
        let config_dir = tmp.join("config");
        fs::create_dir_all(&app_data).unwrap();
        fs::create_dir_all(&config_dir).unwrap();

        let memo_file = MemoFile::new(config_dir);
        // 把测�?fixture �?nb_test 写进 SQLite ── 没有这条, register_existing_file
        // �?memo index sync 时撞 `memos.notebook_id` -> `notebooks.id` �?        // FOREIGN KEY 失败 (FOREIGN KEY constraint failed)�?        // 不调 set_current_notebook 的话, get_memo_base 走默认路�?        // (~/Documents/flowix) ── register_existing_file / write_index
        // 会写到那�?���? 我们�?tempdir 测试 fixture 失效�?
        let cfg = flowix_core::memo_file::NotebookConfig {
            id: "nb_test".to_string(),
            name: "Test".to_string(),
            icon: None,
            path: format!("{}/", tmp.display()),
            is_default: true,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        };
        let mut memo_file = memo_file;
        memo_file.write_notebook_configs(&[cfg]).unwrap();
        memo_file.set_current_notebook(Some("nb_test".to_string()));
        (memo_file, tmp)
    }

    fn watch_ctx(base: &Path) -> NotebookWatchContext {
        NotebookWatchContext {
            notebook_id: "nb_test".to_string(),
            root: base.to_path_buf(),
        }
    }

    #[test]
    fn memo_processing_accepts_only_markdown_directly_under_notebook_root() {
        let (_mf, base) = fresh_memo_file();
        let ctx = watch_ctx(&base);
        let root_memo = base.join("Memo.md");
        let nested_document = base.join("docs").join("Reference.md");
        fs::create_dir_all(nested_document.parent().unwrap()).unwrap();
        fs::write(&root_memo, "# Memo\n").unwrap();
        fs::write(&nested_document, "# Reference\n").unwrap();

        assert!(is_direct_notebook_child(&ctx, &root_memo));
        assert!(!is_direct_notebook_child(&ctx, &nested_document));
    }

    /// 写一�?.md �?notebook 根目�? �?register_existing_file 把它登�?
    /// �?memo index。返�?(memo, abs_path)�?
    fn seed_registered_md(mf: &MemoFile, base: &PathBuf, title: &str) -> (String, PathBuf) {
        let filename = format!("{title}.md");
        let path = base.join(&filename);
        fs::write(
            &path,
            format!("---\ntitle: {title}\n---\n# {title}\n\ninitial body\n"),
        )
        .unwrap();
        // register_existing_file �?��生成 id, 这里�?���?filename
        let _memo = mf.register_existing_file(&path).expect("register ok");
        (filename, path)
    }

    #[test]
    fn dispatch_modify_event_emits_updated_for_registered_file() {
        // (1) 鍑嗗: 涓存椂 notebook + 涓€涓凡娉ㄥ唽 .md
        let (mf, base) = fresh_memo_file();
        let (filename, path) = seed_registered_md(&mf, &base, "Hello");

        // (2) 模拟"vim �?body": 覆写磁盘
        fs::write(&path, format!("# Hello\n\nexternal edit content\n")).unwrap();

        // (3) �?dispatch_modify_event, 期望 Updated
        let outcome = dispatch_modify_event(&mf, &watch_ctx(&base), &path, FsEventKind::Modify)
            .expect("dispatch ok");
        let event = match outcome {
            DispatchOutcome::Updated(e) => e,
            DispatchOutcome::Created { .. } => panic!("expected Updated, got Created"),
        };

        // (4) 鏂█浜嬩欢瀛楁
        match event {
            MemoEvent::Updated {
                id,
                path: ep,
                memo,
                source,
                ..
            } => {
                assert!(!id.is_empty(), "id should not be empty");
                let expected_path = mf
                    .get_memo_base()
                    .join(&memo.filename)
                    .display()
                    .to_string();
                assert_eq!(ep, expected_path, "path should equal base+filename");
                assert_eq!(memo.filename, filename);
                // preview 来自�?body 的派�?
                assert!(
                    memo.preview.contains("external edit content"),
                    "preview should reflect new body, got: {}",
                    memo.preview
                );
                assert!(matches!(source, MemoChangeSource::ExternalTool));
            }
            other => panic!("expected Updated, got {:?}", std::mem::discriminant(&other)),
        }
    }

    #[test]
    fn dispatch_modify_event_emits_created_for_unregistered_file() {
        // (1) 准�?: 临时 notebook, **�?*注册任何 .md
        let (mf, base) = fresh_memo_file();
        let filename = "Stranger.md";
        let path = base.join(filename);
        fs::write(&path, "# Stranger\n\nnew file content\n").unwrap();

        // (2) �?dispatch_modify_event, 期望 Created + new_abs_path
        let outcome = dispatch_modify_event(&mf, &watch_ctx(&base), &path, FsEventKind::Create)
            .expect("dispatch ok");
        let (event, new_abs_path) = match outcome {
            DispatchOutcome::Updated(_) => panic!("expected Created, got Updated"),
            DispatchOutcome::Created {
                event,
                new_abs_path,
            } => (event, new_abs_path),
        };

        match event {
            MemoEvent::Created { memo, source, .. } => {
                assert!(!memo.id.is_empty(), "id should be generated");
                assert_eq!(memo.filename, filename);
                assert!(matches!(source, MemoChangeSource::ExternalTool));
            }
            other => panic!("expected Created, got {:?}", std::mem::discriminant(&other)),
        }
        // register_existing_file_for_notebook_id 璧?generate-new-id + stamp 璺緞,
        // new_abs_path 跟原 path 不一定相�?
        assert!(
            new_abs_path.exists(),
            "registered file should exist on disk"
        );
    }

    #[test]
    fn dispatch_modify_event_with_mark_marks_before_register_write_only() {
        // 验证 mark_self_write 在「会写盘的注册分支」之前被调用、在「只读 reload 分支」不调用。
        // 这是 process 移到 worker 线程后关闭 self-write echo race 的关键: stamp 写盘前
        // mark 必须已落抑制表 (见 manager.rs 模块头注释), 否则 stamp 触发的 self-write
        // notify 事件会先于 mark 到达 -> Created 后跟一个冗余 Updated。
        use std::cell::RefCell;
        let (mf, base) = fresh_memo_file();
        let filename = "Stranger.md";
        let path = base.join(filename);
        fs::write(&path, "# Stranger\n\nno frontmatter key\n").unwrap();

        // (1) 未注册文件 (无 key) -> register 分支会 stamp key 写盘: mark 应被调用一次。
        let marked = RefCell::new(Vec::<PathBuf>::new());
        let outcome = dispatch_modify_event_with_mark(
            &mf,
            &watch_ctx(&base),
            &path,
            FsEventKind::Create,
            |p: &Path| marked.borrow_mut().push(p.to_path_buf()),
        )
        .expect("dispatch ok");
        match &outcome {
            DispatchOutcome::Created { .. } => {}
            other => panic!("expected Created (register), got {:?}", std::mem::discriminant(other)),
        }
        assert_eq!(
            marked.borrow().len(),
            1,
            "mark must fire exactly once before the register write"
        );
        assert_eq!(
            marked.borrow()[0], path,
            "mark must be called with the event path (the file about to be stamped)"
        );

        // (2) 同一文件已注册 (有 key, 已索引) -> reload 分支只读不写盘: mark 不应被调用,
        // 否则会在 2s TTL 内误吞合法的外部连续编辑。
        marked.borrow_mut().clear();
        let outcome = dispatch_modify_event_with_mark(
            &mf,
            &watch_ctx(&base),
            &path,
            FsEventKind::Modify,
            |p: &Path| marked.borrow_mut().push(p.to_path_buf()),
        )
        .expect("dispatch ok");
        match &outcome {
            DispatchOutcome::Updated(_) => {}
            other => panic!("expected Updated (reload), got {:?}", std::mem::discriminant(other)),
        }
        assert!(
            marked.borrow().is_empty(),
            "mark must NOT fire on the read-only reload branch"
        );
    }

    #[test]
    fn dispatch_modify_emits_created_when_mcp_already_wrote_the_shared_index() {
        let (mf, base) = fresh_memo_file();
        // MCP/CLI uses a separate MemoFile instance but performs this same
        // file + shared-index write before Desktop observes the fs event.
        let created = mf
            .create_external_memo_for_notebook_id("nb_test", "MCP note", "# MCP note\n", None)
            .expect("mcp-style create");
        let path = base.join(&created.filename);

        // macOS FSEvents reports MemoFile's atomic temp-file rename at the
        // final markdown path as Modify rather than Create.
        let outcome = dispatch_modify_event(&mf, &watch_ctx(&base), &path, FsEventKind::Modify)
            .expect("dispatch ok");

        match outcome {
            DispatchOutcome::Created {
                event: MemoEvent::Created { memo, source, .. },
                ..
            } => {
                assert_eq!(memo.id, created.id);
                assert!(matches!(source, MemoChangeSource::ExternalTool));
            }
            DispatchOutcome::Updated(_) => {
                panic!("MCP-created memo must stay a Created event")
            }
            DispatchOutcome::Created { event, .. } => {
                panic!("expected Created memo event, got {event:?}")
            }
        }
    }

    #[test]
    fn dispatch_modify_event_updated_preserves_id_across_external_edit() {
        // 关键不变�? 外部�?body �? memo index 里这�?entry �?id 不会�?        // (id �?register_existing_file 时生�? 后续 reload �?�� preview/
        // tags/todos/updated_at)銆?
        let (mf, base) = fresh_memo_file();
        let (_, path) = seed_registered_md(&mf, &base, "Note");

        let id1 = mf
            .find_memo_by_filename_for_notebook_id("nb_test", "Note.md")
            .expect("seeded memo")
            .id;

        // 妯℃嫙绗簩娆″閮ㄦ敼
        fs::write(&path, "# Note\n\nsecond edit\n").unwrap();
        let e2 = match dispatch_modify_event(&mf, &watch_ctx(&base), &path, FsEventKind::Modify)
            .unwrap()
        {
            DispatchOutcome::Updated(e) => e,
            _ => panic!("expected Updated on second dispatch"),
        };
        let id2 = match e2 {
            MemoEvent::Updated { id, .. } => id,
            _ => unreachable!(),
        };

        assert_eq!(id1, id2, "id must be stable across external body edits");
    }

    #[test]
    fn external_create_marker_is_consumed_once_without_reopening_on_quick_edit() {
        let (mf, base) = fresh_memo_file();
        let created = mf
            .create_external_memo_for_notebook_id("nb_test", "MCP note", "# MCP note\n", None)
            .expect("external create");
        let path = base.join(&created.filename);

        let first = dispatch_modify_event(&mf, &watch_ctx(&base), &path, FsEventKind::Modify)
            .expect("first event");
        assert!(matches!(first, DispatchOutcome::Created { .. }));

        fs::write(&path, "# MCP note\n\nquick external edit\n").unwrap();
        let second = dispatch_modify_event(&mf, &watch_ctx(&base), &path, FsEventKind::Modify)
            .expect("second event");
        assert!(matches!(second, DispatchOutcome::Updated(_)));
    }

    /// 回归: 物理删除�? `unregister_and_emit` 必须能从 memo index 查到真实 id
    /// 注入�?`MemoEvent::Deleted` 里。物理文件名�?`<title>.md` (id �?    /// 文件名解�?, emit `id=""` 给前�?�?`memos.filter(m => m.id !== "")`
    /// 一条都过滤不掉 �?幽灵笔�?。这里直接验证修复后的核心查找逻辑:
    /// "�?filename �?memo index entry, 拿到�?id �?register 时生成的 id 一�?�?
    #[test]
    fn physical_delete_resolves_real_id_from_index() {
        let (mf, base) = fresh_memo_file();
        let (filename, path) = seed_registered_md(&mf, &base, "Ghost");

        // 淇鍓? id=""
        // �??�? id 应�?�?memo index 里这�?entry 的真�?id
        let memo = mf
            .find_memo_by_filename(&filename)
            .expect("seeded entry should be in memo index");
        let real_id = memo.id.clone();

        assert!(
            !real_id.is_empty(),
            "register_existing_file should have generated a non-empty id; got empty"
        );
        // V3 ids come from the memo index rather than the physical filename.
        assert_ne!(real_id, filename, "v3 id must be decoupled from filename");
        // �?��存在 + �?base join 起来等于 expected_abs (unregister_memo_by_path
        // 内部就是这个 invariant guard 通过后才�?entry)
        assert!(
            path.exists(),
            "seeded .md should still be on disk for this test"
        );
        let expected_abs = base.join(&memo.filename);
        assert_eq!(
            expected_abs.canonicalize().ok(),
            path.canonicalize().ok(),
            "abs path should round-trip through base + filename"
        );
    }

    /// 边界: 一�?*�?���?*�?.md �?��理删�?(用户�?��了未注册文件, �?    /// 我们�?register 完就删了), `unregister_and_emit` 应当**�?*emit
    /// `MemoEvent::Deleted` (id 拿不�?,也不�?memo index�?
    #[test]
    fn physical_delete_for_unregistered_file_is_noop() {
        let (mf, base) = fresh_memo_file();
        let filename = "Stray.md";
        let path = base.join(filename);
        fs::write(&path, "# Stray\n").unwrap();

        // 模拟 unregister_and_emit �?id 查找前置�? filename 不在 memo index
        let looked_up = mf.find_memo_by_filename(filename);
        assert!(
            looked_up.is_none(),
            "unregistered .md must not resolve to a memo index entry"
        );

        // 模拟 unregister �? 同样 no-op
        let removed = mf.unregister_memo_by_path(&path);
        assert!(!removed, "unregister must return false for unknown file");
    }

    // ====== Frontmatter-key-first 鍒嗘祦锛歳ename via disk key ======
    //
    // 复现 GUI 标�?编辑的代码路径：fs::rename(OLD �?NEW) �?
    // SELF_WRITE_SUPPRESSOR 吞了 From 事件, To 事件进入 dispatch_modify_event�?    // 关键�?��: 磁盘 frontmatter key (�?rename 保留) �?命中 OLD entry �?    // rename_memo_file �?entry.filename, id 不变, created_at 不变�?    //
    // 这个测试不依�?Tauri AppHandle / notify / SelfWriteSuppressor —直接
    // 喂一�?Create 事件形态的 path �?dispatch_modify_event, 模拟 GUI �?��
    // 走到 processor 时的入参�?
    #[test]
    fn dispatch_modify_event_detects_rename_via_frontmatter_key() {
        let (mf, base) = fresh_memo_file();
        let (filename, old_path) = seed_registered_md(&mf, &base, "Original");

        // 抓原�?entry �?id / timestamps
        let original = mf
            .find_memo_by_filename(&filename)
            .expect("seeded entry should exist");
        let original_id = original.id.clone();
        let original_created = original.created_at;
        let original_updated = original.updated_at;

        // 物理 rename ── �?GUI write_memo_renaming_on_title_change 一�?
        // frontmatter key 跟着文件�?(fs::rename �?metadata-only 操作,
        // 鏂囦欢鍐呭涓嶅彉, frontmatter 鍧楃殑 key 瀛楁淇濈暀)
        let new_filename = "Renamed.md".to_string();
        let new_path = base.join(&new_filename);
        std::fs::rename(&old_path, &new_path).expect("physical rename must succeed");

        // �?To 事件形�? dispatch_modify_event 读�?�?�?�?key �?反查 entry
        let outcome = dispatch_modify_event(&mf, &watch_ctx(&base), &new_path, FsEventKind::Create)
            .expect("dispatch ok");
        let event = match outcome {
            DispatchOutcome::Updated(e) => e,
            DispatchOutcome::Created { .. } => {
                panic!("expected Updated (rename via key), got Created")
            }
        };

        match event {
            MemoEvent::Updated {
                id,
                path,
                memo,
                source,
                ..
            } => {
                // 关键不变�?── id �?rename 保留
                assert_eq!(
                    id, original_id,
                    "id must be preserved across rename detected via frontmatter key"
                );
                assert_eq!(
                    memo.id, original_id,
                    "memo.id must match memo index entry id"
                );
                // filename 改成磁盘实际文件�?
                assert_eq!(
                    memo.filename, new_filename,
                    "filename must reflect post-rename disk state"
                );
                // path 鏄柊浣嶇疆 (rename 鍚庣殑缁濆璺緞)
                assert_eq!(
                    path,
                    new_path.display().to_string(),
                    "emit path must be the post-rename abs path"
                );
                // created_at 淇濈暀 鈹€鈹€ rename_memo_file 涓嶅姩 created_at
                assert_eq!(
                    memo.created_at, original_created,
                    "created_at must be preserved (rename_memo_file leaves it alone)"
                );
                // updated_at 刷新 ── rename �?��算一次更�?
                assert!(
                    memo.updated_at >= original_updated,
                    "updated_at should be refreshed on rename"
                );
                assert!(matches!(source, MemoChangeSource::ExternalTool));
            }
            other => panic!("expected Updated, got {:?}", std::mem::discriminant(&other)),
        }

        // 收尾: memo index �?entry.filename 真的更新�?
        let entry_after = mf
            .find_memo_by_filename(&new_filename)
            .expect("new filename should be in memo index after rename");
        assert_eq!(
            entry_after.id, original_id,
            "memo index entry's id must be preserved"
        );
        // �?filename 应�?已经不在 memo index
        assert!(
            mf.find_memo_by_filename(&filename).is_none(),
            "old filename must be removed from memo index after rename"
        );

        // 娓呯悊
        std::fs::rename(&new_path, &old_path).ok();
    }

    #[test]
    fn dispatch_modify_event_rekeys_pasted_duplicate_when_original_still_exists() {
        let (mf, base) = fresh_memo_file();
        let (original_filename, original_path) = seed_registered_md(&mf, &base, "Original");
        let original = mf
            .find_memo_by_filename(&original_filename)
            .expect("seeded entry should exist");
        let original_id = original.id.clone();

        let pasted_filename = "Original Copy.md".to_string();
        let pasted_path = base.join(&pasted_filename);
        std::fs::copy(&original_path, &pasted_path).expect("copy should succeed");

        let outcome =
            dispatch_modify_event(&mf, &watch_ctx(&base), &pasted_path, FsEventKind::Create)
                .expect("dispatch ok");
        let memo = match outcome {
            DispatchOutcome::Created {
                event: MemoEvent::Created { memo, .. },
                ..
            } => memo,
            DispatchOutcome::Updated(_) => panic!("pasted duplicate must emit Created"),
            DispatchOutcome::Created { event, .. } => {
                panic!("expected Created memo event, got {event:?}")
            }
        };

        assert_ne!(memo.id, original_id, "pasted copy must get a fresh id");
        assert_eq!(memo.filename, pasted_filename);
        assert_eq!(
            mf.read_current_memo(&original_id).unwrap().filename,
            original_filename,
            "original memo entry must not be moved"
        );
        let pasted_content = std::fs::read_to_string(&pasted_path).unwrap();
        assert_eq!(extract_frontmatter_key(&pasted_content), Some(memo.id));
    }

    // ====== Frontmatter-key-first 分流�?c) case ======
    //
    // 模拟"memo index 已经�?��序事件清�? 磁盘 key 还在" ── 比�?外部
    // rename �?From + To 两条事件, From 进了 unregister_and_emit 删了
    // entry, To �?dispatch_modify_event 此时 read_memo(key) 返回 None�?    // 当前粘贴�?��: �?key 的陌生文件也按新文档注册, 并把磁盘 key 刷新成新 id�?
    #[test]
    fn dispatch_modify_event_rekeys_orphan_disk_key_as_new_document() {
        let (mf, base) = fresh_memo_file();

        // 直接造一�?.md �?frontmatter key �?memo index 里没记录�?孤儿"
        let orphan_filename = "Orphan.md".to_string();
        let orphan_path = base.join(&orphan_filename);
        let orphan_id = "abc123";
        std::fs::write(
            &orphan_path,
            format!("---\nkey: {orphan_id}\n---\n# Orphan\n\nbody content\n"),
        )
        .unwrap();

        // 模拟 read_memo 返回 None 的状�?── memo index 干净
        assert!(mf.read_current_memo(orphan_id).is_none());

        // dispatch: 搴斿垱寤烘柊 memo, 涓嶆部鐢ㄧ鐩樻棫 key
        let outcome =
            dispatch_modify_event(&mf, &watch_ctx(&base), &orphan_path, FsEventKind::Create)
                .expect("dispatch ok");
        let memo = match outcome {
            DispatchOutcome::Created {
                event: MemoEvent::Created { memo, .. },
                ..
            } => memo,
            other => panic!("expected Created via (c) path, got {other:?}"),
        };

        assert_ne!(memo.id, orphan_id, "pasted file must get a fresh id");
        assert_eq!(memo.filename, orphan_filename);

        // 收尾: memo index 真的有这�?entry
        assert!(
            mf.read_current_memo(orphan_id).is_none(),
            "old disk key must not be registered in this notebook"
        );
        let entry = mf
            .read_current_memo(&memo.id)
            .expect("fresh id should now be in memo index");
        assert_eq!(entry.id, memo.id);
        let stamped = std::fs::read_to_string(&orphan_path).unwrap();
        assert_eq!(extract_frontmatter_key(&stamped), Some(memo.id));
    }

    // ====== GUI 鏍囬缂栬緫鍏ㄩ摼璺細SelfWriteSuppressor + dispatch 鍗忎綔 ======
    //
    // 妯℃嫙 write_memo_renaming_on_title_change 娴佺▼:
    //   1. mark_self_write(OLD) ── �?OLD �?��塞抑制表
    //   2. fs::rename(OLD �?NEW) ── 触发 notify From(OLD) + To(NEW)
    //   3. notify 回调 �?filter pipeline:
    //      - From(OLD) �?SelfWriteSuppressor 命中 �?吞掉 �?    //      - To(NEW)   �?SelfWriteSuppressor miss �?�?processor
    //   4. processor �?frontmatter-key-first 分流:
    //      - 读�?�?�?�?key = id (frontmatter 跟着 fs::rename �?
    //      - read_memo(id) �?Some (entry 沤?�? From �?���?
    //      - existing.filename != current filename �?(a) 分支
    //      - rename_memo_file(OLD, NEW) �?entry.filename �? id 保留
    //
    // 关键 invariant: id �?rename 保留, created_at 不变, updated_at 刷新�?    // 这是用户报告�?bug 的核�?── 之前 Windows 上因 inode_tracker 留空,
    // dispatch_modify_event �?filename-based �?��, �?entry �?新文�?
    // 重新注册, id 漂移 / createdAt 重置�?    //
    // 这个测试**不依�?Tauri AppHandle / 真实 notify** ── 直接�?    // SelfWriteSuppressor + dispatch_modify_event, 验证两条事件流入
    // processor �? dispatch 的输出是正��?rename_memo_file 调用�?
    #[test]
    fn gui_title_edit_full_pipeline_preserves_id_and_timestamps() {
        use crate::watcher::filter::{run_pipeline, PathFilter};
        use crate::watcher::path::normalize_for_compare;
        use crate::watcher::whitelist::WhitelistConfig;
        use std::path::PathBuf;
        use std::time::Instant;

        let (mf, base) = fresh_memo_file();
        let (filename, old_path) = seed_registered_md(&mf, &base, "Original");

        // 抓原�?entry �?id / created_at / updated_at
        let original = mf
            .find_memo_by_filename(&filename)
            .expect("seeded entry should exist");
        let original_id = original.id.clone();
        let original_created = original.created_at;
        let original_updated = original.updated_at;

        // ====== Step 1: GUI 写盘�?mark_self_write(OLD) ======
        let recent = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::<
            PathBuf,
            Instant,
        >::new()));
        recent
            .lock()
            .unwrap()
            .insert(normalize_for_compare(&old_path), Instant::now());

        // ====== Step 2: fs::rename(OLD �?NEW) ── 物理重命�?======
        let new_filename = "Renamed.md".to_string();
        let new_path = base.join(&new_filename);
        std::fs::rename(&old_path, &new_path).expect("physical rename must succeed");

        // ====== Step 3a: 妯℃嫙 notify From(OLD) 浜嬩欢杩涘叆 filter pipeline ======
        let whitelist =
            std::sync::Arc::new(std::sync::RwLock::new(WhitelistConfig::load_or_default()));
        let path_filter = PathFilter {
            whitelist: whitelist.clone(),
        };
        let last_emit = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::<
            PathBuf,
            Instant,
        >::new()));
        let from_event = RawFsEvent::new(FsEventKind::Remove, old_path.clone());
        let from_decision = run_pipeline(&from_event, &recent, &last_emit, &path_filter);
        assert!(
            matches!(
                from_decision,
                crate::watcher::event::FilterDecision::Drop {
                    reason: crate::watcher::event::DropReason::SelfWriteSuppressed
                }
            ),
            "From(OLD) must be suppressed by SelfWriteSuppressor (GUI marked OLD)"
        );

        // ====== Step 3b: 妯℃嫙 notify To(NEW) 浜嬩欢杩涘叆 filter pipeline ======
        let to_event = RawFsEvent::new(FsEventKind::Create, new_path.clone());
        let to_decision = run_pipeline(&to_event, &recent, &last_emit, &path_filter);
        assert!(
            matches!(to_decision, crate::watcher::event::FilterDecision::Pass),
            "To(NEW) must pass through filter pipeline (NEW was not marked)"
        );

        // ====== Step 4: processor dispatch_modify_event(NEW) ── �?(a) 分支 ======
        let outcome = dispatch_modify_event(&mf, &watch_ctx(&base), &new_path, FsEventKind::Create)
            .expect("dispatch ok");
        let event = match outcome {
            DispatchOutcome::Updated(e) => e,
            DispatchOutcome::Created { .. } => {
                panic!("GUI rename must emit Updated (rename detected via disk key), not Created")
            }
        };

        match event {
            MemoEvent::Updated {
                id,
                path,
                memo,
                source: _,
                ..
            } => {
                assert_eq!(id, original_id, "id must be preserved across GUI rename");
                assert_eq!(memo.id, original_id);
                assert_eq!(
                    memo.filename, new_filename,
                    "filename must reflect post-rename disk state"
                );
                assert_eq!(
                    path,
                    new_path.display().to_string(),
                    "emit path must be the post-rename abs path"
                );
                assert_eq!(
                    memo.created_at, original_created,
                    "created_at must be preserved (rename_memo_file leaves it alone)"
                );
                assert!(
                    memo.updated_at >= original_updated,
                    "updated_at should be refreshed on rename"
                );
            }
            other => panic!("expected Updated, got {:?}", std::mem::discriminant(&other)),
        }

        // ====== 鏀跺熬锛歮emo index entry 鐘舵€?======
        let entry_after = mf
            .find_memo_by_filename(&new_filename)
            .expect("new filename should be in memo index after rename");
        assert_eq!(entry_after.id, original_id);
        assert!(
            mf.find_memo_by_filename(&filename).is_none(),
            "old filename must be removed from memo index after rename"
        );

        // 娓呯悊: 鎶婃枃浠舵尓鍥炲幓閬垮厤姹℃煋鍏朵粬娴嬭瘯
        std::fs::rename(&new_path, &old_path).ok();
    }

    #[test]
    fn dispatch_modify_event_emits_updated_when_index_already_renamed() {
        let (mf, base) = fresh_memo_file();
        let (filename, old_path) = seed_registered_md(&mf, &base, "Original");
        let original = mf
            .find_memo_by_filename(&filename)
            .expect("seeded entry should exist");
        let original_id = original.id.clone();
        let original_created = original.created_at;

        let new_filename = "Renamed Already Indexed.md".to_string();
        let new_path = base.join(&new_filename);
        std::fs::rename(&old_path, &new_path).expect("physical rename must succeed");

        // Simulate the internal save path winning the race and updating the index
        // before the watcher processes the new-path event.
        let synced = mf
            .sync_memo_filename_from_disk_key(&original_id, &new_path)
            .expect("pre-sync should succeed");
        assert_eq!(synced.filename, new_filename);

        let outcome = dispatch_modify_event(&mf, &watch_ctx(&base), &new_path, FsEventKind::Create)
            .expect("dispatch ok");
        let event = match outcome {
            DispatchOutcome::Updated(event) => event,
            DispatchOutcome::Created { .. } => {
                panic!("already-indexed rename must still emit Updated")
            }
        };

        match event {
            MemoEvent::Updated { id, path, memo, .. } => {
                assert_eq!(id, original_id);
                assert_eq!(memo.id, original_id);
                assert_eq!(memo.filename, new_filename);
                assert_eq!(memo.created_at, original_created);
                assert_eq!(
                    crate::watcher::path::normalize_for_compare(std::path::Path::new(&path)),
                    crate::watcher::path::normalize_for_compare(&new_path)
                );
            }
            other => panic!("expected Updated, got {:?}", std::mem::discriminant(&other)),
        }
    }
}
