//! �?watcher manager / filter 共享的路径归一工具�?//!
//! `MemoWatcher::mark_self_write` 鍜?`SelfWriteSuppressor` / `Debouncer`
//! 閮界敤杩欓噷鐢熸垚 HashMap key, 閬垮厤鍐欑洏绔笌 notify 绔矾寰勫彛寰勪笉涓€鑷淬€?
use std::path::{Path, PathBuf};

/// �?`Path` 归一�?`HashMap<PathBuf, _>` 查表口径�?///
/// 优先�?`dunce::canonicalize` 折叠 symlink / `\\?\` 前缀; 失败 (文件尚未
/// 创建 —写盘�?mark 的常见情�? 退�?�?canonicalize 父目�? �?join
/// 文件�?, 父目录在 notebook 创建时已经存�? 这一步必然成功。即便父�?��
/// canonicalize 也失�? 退回原 path 字�?�? 至少不丢抑制 (退化到精�匹配)�?
pub fn normalize_for_compare(path: &Path) -> PathBuf {
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
