//! Memo CRUD 原语 — memo index 始终是全量索引的真源。
//!
//! 物理文件: `<notebook>/<filename>.md`, `filename` 即 memo index entry.filename。
//! 命名规则:
//! - 文件名由 `sanitize(title)` 派生, 后缀恒为 `.md`。
//! - 同 title 冲突时自动追加 `-1` / `-2` / ... (不去重 id 段, 6 位 shortid
//!   仅作为 memo index 的内部 key, 不再出现在文件名)。
//! - id 仍由 `generate_memo_id` 6 位 nanoid 生成, 字符集 `[0-9a-z]`。
//!
//! 所有写路径 (UI / Agent / 外部工具 / 文件监听器) 都过本模块, 唯一入口。
//! 跨 IPC 边界的 `Memo` / `MemoIndexEntry` 字段语义: `filename` 存磁盘文件名
//! (含 `.md`); 前端展示时去后缀; 旧版 `path` 字段删除。
//!
//! ## 锁模型
//!
//! 写路径 (`create` / `rename` / `write` / `delete` / `register_*` / `reconcile`)
//! 持有 `current_index_io` Mutex, 跨 "rename 物理文件 + 写 memo index" 全过程,
//! 串行化 memo index RMW, 杜绝 lost update。`std::sync::Mutex` 不可重入,
//! 内部 _locked 变体跳过自拿锁。

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::OptionalExtension;

use super::derivation::{apply_derived_memo_fields, extract_title_and_preview};
use super::frontmatter::{
    build_md_content, extract_document_metadata,
    extract_document_metadata_preserving_invalid_tag_paths, merge_frontmatter,
    replace_frontmatter_tags, replace_frontmatter_tags_preserving_invalid_paths, MergeOverrides,
};
use super::notebook::sqlite_to_io;
use super::types::{DeleteTagReport, Memo, MoveTagReport, ReconcileReport};
use super::MemoFile;

/// title 派生 fallback: 空 body / 不可见首行时用 `untitled-YYYY-MM-DD`。
fn fallback_filename(now: chrono::DateTime<chrono::Local>) -> String {
    format!("{}.md", now.format("untitled-%Y-%m-%d"))
}

fn validate_document_frontmatter(content: &str) -> std::io::Result<()> {
    extract_document_metadata(content)
        .map(|_| ())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string()))
}

/// title 清洗: 替换文件系统非法字符 `\ / : * ? " < > |` 为空格,
/// 截到 200 字符, 去尾随 `.` (Windows 不接受 `name.`)。
pub fn sanitize_filename_component(title: &str) -> String {
    let mut sanitized: String = title
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            other => other,
        })
        .take(200)
        .collect();
    sanitized = sanitized.trim().to_string();
    if sanitized.ends_with('.') {
        sanitized.pop();
        sanitized.push(' ');
    }
    sanitized.trim().to_string()
}

/// 算基准 filename (不含冲突后缀): `<sanitized>.md`。
/// 空 title 时用 `untitled-YYYY-MM-DD.md` 兜底。
pub fn base_filename(title: &str) -> String {
    let sanitized = sanitize_filename_component(title);
    if sanitized.is_empty() {
        fallback_filename(chrono::Local::now())
    } else {
        sanitized
    }
}

/// 冲突检测: 在 base 目录下, `candidate.md` 是否已存在, 或已被 memo index
/// 某条 entry 占用。 任意一种情况都视为冲突, 自动追加 `-1` / `-2` / ...。
///
/// 关键: 之前只看 `fs::exists` 是不够的 ── 两次并发 `create_memo` 在
/// `current_index_io` 锁内串行, 但 `resolve_filename_conflict` 不读
/// memo index, 导致两个不同 id 写到同一个磁盘文件 (前一个 entry 的
/// filename 跟后一个冲突但磁盘文件已存在 → 仍报 "不冲突", 后一个
/// 覆盖前一个文件)。 现在加 memo index 维度, 跟 `apply_derived_memo_fields`
/// / `sync_index_on_write` 走同一真源。
pub fn resolve_filename_conflict(
    base: &Path,
    candidate_base: &str,
    occupied_filenames: &[String],
) -> String {
    let primary = format!("{candidate_base}.md");
    if !base.join(&primary).exists() && !occupied_filenames.contains(&primary) {
        return primary;
    }
    let mut n = 1u32;
    loop {
        let candidate = format!("{candidate_base}-{n}.md");
        if !base.join(&candidate).exists() && !occupied_filenames.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// `.md` / `.markdown` 后缀判定 (大小写不敏感)。
pub trait IsMd {
    fn is_md(&self) -> bool;
}

impl IsMd for Path {
    fn is_md(&self) -> bool {
        self.extension()
            .and_then(|e| e.to_str())
            .map(|e| {
                let lower = e.to_ascii_lowercase();
                lower == "md" || lower == "markdown"
            })
            .unwrap_or(false)
    }
}

/// 原子写: temp file + fsync + rename ── 中途崩溃看到的永远是完整旧文件或
/// 完整新文件。跟 `index_store::atomic_write_json` 同源, 推广到任意路径 + bytes
/// 供 `.md` 写路径复用。
///
/// Windows 上 `MoveFileExW + MOVEFILE_REPLACE_EXISTING` 跨同一目录是原子;
/// `dunce::canonicalize` 去除 `\\?\` UNC 前缀, 确保 tmp 与 final 落在同一
/// canonical 根下, 否则跨盘符 rename 会失败。`canonicalize` 失败时 (文件
/// 还没创建 ── e.g. 全新 register_existing_file 场景) 退回原路径, 这时
/// rename 在同一目录下仍然原子。
pub fn atomic_write_bytes(final_path: &Path, content: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let final_path = dunce::canonicalize(final_path).unwrap_or_else(|_| final_path.to_path_buf());
    if let Some(parent) = final_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = final_path.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    ));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(content)?;
        f.sync_all()?;
    }
    if let Err(e) = fs::rename(&tmp, &final_path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Atomically create a new file without replacing an entry created by another process.
fn atomic_create_bytes(final_path: &Path, content: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let parent = final_path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "file path has no parent")
    })?;
    fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(content)?;
    temp.as_file().sync_all()?;
    temp.persist_noclobber(final_path)
        .map(|_| ())
        .map_err(|error| error.error)
}

/// 跟 `flowix-desktop::fs_watcher::normalize_for_compare` 同口径的路径归一。
fn normalize_for_compare(path: &Path) -> PathBuf {
    if let Ok(canon) = dunce::canonicalize(path) {
        return canon;
    }
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if let Ok(canon_parent) = dunce::canonicalize(parent) {
            return canon_parent.join(name);
        }
    }
    path.to_path_buf()
}

impl MemoFile {
    /// 生成一个新的 6 位 memo id (字符集 `[0-9a-z]`)。同 id 已存在时循环重抽。
    pub fn generate_memo_id(&self) -> String {
        loop {
            let id = nanoid::nanoid!(8, &super::MEMO_ID_ALPHABET);
            if self.read_current_memo(&id).is_none() {
                return id;
            }
        }
    }

    fn generate_global_memo_id(&self) -> String {
        loop {
            let id = nanoid::nanoid!(8, &super::MEMO_ID_ALPHABET);
            if self.resolve_memo_location(&id).ok().flatten().is_none() {
                return id;
            }
        }
    }

    fn memo_base_for_notebook_id_result(&self, notebook_id: &str) -> Result<PathBuf, String> {
        self.get_notebook_config_by_id(notebook_id)
            .map(|config| PathBuf::from(config.path))
            .ok_or_else(|| format!("notebook {notebook_id} not found"))
    }

    pub fn read_memo_for_notebook_id(&self, notebook_id: &str, id: &str) -> Option<Memo> {
        self.read_index_for_notebook_id(Some(notebook_id))
            .ok()
            .flatten()?
            .memos
            .into_iter()
            .find(|entry| entry.id == id)
            .map(|entry| MemoFile::index_entry_to_memo(&entry))
    }

    pub fn find_memo_by_filename_for_notebook_id(
        &self,
        notebook_id: &str,
        filename: &str,
    ) -> Option<Memo> {
        self.read_index_for_notebook_id(Some(notebook_id))
            .ok()
            .flatten()?
            .memos
            .into_iter()
            .find(|entry| entry.filename == filename)
            .map(|entry| MemoFile::index_entry_to_memo(&entry))
    }

    /// 公开 title 清洗工具: 供 index_store 复用, 行为等同 `sanitize_filename_component`。
    pub fn sanitize_memo_filename_component(title: &str) -> String {
        sanitize_filename_component(title)
    }
}

mod crud;
mod reconcile;
mod registration;
mod tags;
