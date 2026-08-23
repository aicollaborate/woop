//! File IPC — 任意 in-notebook 文件 tree / read / write / create。
//!
//! 与 `memo.rs::read_document` / `write_document` 的区别: 那两个是单文件路径
//! (`can_access_document_path` 守卫, 包括 `.md` 后缀绕过), 这八个是
//! `space_path` 作用域 (`can_access_scoped_file` 守卫, 必须落在声明的
//! notebook 根下)。侧栏"资料"文件夹 (agent access folder entry) 与注册
//! 笔记本同权放行, 让文件树视图能浏览用户添加的资料目录。
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Serialize;
use tauri::State;

use crate::config::path_is_inside;

use super::helpers::{
    can_access_scoped_file, is_agent_access_folder, is_registered_notebook_path,
    start_security_bookmark_access,
};
use crate::app::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocTreeItem {
    pub id: String,
    pub full_path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub parent_id: Option<String>,
    pub children: Option<Vec<DocTreeItem>>,
    /// 文件字节大小 (folder 为 None, 避免递归统计目录大小的开销)。
    pub size_bytes: Option<u64>,
    /// 最后修改时间 (Unix epoch 毫秒; 文件与 folder 均适用)。
    pub modified_ms: Option<u64>,
    /// 创建时间 (Unix epoch 毫秒; macOS/Windows 免费读, 其余平台为 None)。
    pub created_ms: Option<u64>,
}

// ==================== 域内 helper ====================

fn generate_stable_id(full_path: &str) -> String {
    format!(
        "file-{}",
        full_path.replace(['\\', '/', '#', '%', '?', '&'], "_")
    )
}

fn system_time_to_ms(t: SystemTime) -> Option<u64> {
    t.duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

fn modified_time_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified().ok().and_then(system_time_to_ms)
}

/// 创建时间 → Unix epoch 毫秒。macOS (`st_birthtime`) 与 Windows
/// (`creation_time`) 都在同一次 stat 结果里, 读取零额外 syscall; 其余
/// 平台 std 不提供 birth time, 返回 None。
fn created_time_ms(meta: &fs::Metadata) -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        let secs = meta.st_birthtime();
        return (secs >= 0).then_some(secs as u64 * 1000);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        // FILETIME: 100ns 自 1601-01-01; 与 Unix epoch 相差 11,644,473,600 秒。
        const WINDOWS_TO_UNIX_EPOCH_MS: u64 = 11_644_473_600_000;
        let ms_since_1601 = meta.creation_time() / 10_000; // 100ns → ms
        return Some(ms_since_1601.saturating_sub(WINDOWS_TO_UNIX_EPOCH_MS));
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = meta;
        None
    }
}

/// 单层目录列举 ── 只列直接子项, folder 的 `children` 置空占位, 由前端
/// 展开时再对子目录调 `get_dir_children` 惰性拉取 (VSCode 风格)。资料
/// 文夹可能很大, 全量递归会卡首屏; 单层也天然规避符号链接循环。
fn read_dir_single_level(dir_path: &Path) -> Vec<DocTreeItem> {
    let mut items = Vec::new();

    if !dir_path.exists() {
        return items;
    }

    if let Ok(entries) = fs::read_dir(dir_path) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();

            // Skip hidden files
            if name.starts_with('.') {
                continue;
            }

            // 一次 fs::metadata() 同时拿类型与大小 (语义与原先 path.is_dir()
            // 一致、跟随符号链接): 文件取 len()、folder 置 None, 不做递归统计。
            let meta = fs::metadata(&path).ok();
            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let size_bytes = if is_dir {
                None
            } else {
                meta.as_ref().map(|m| m.len())
            };
            let modified_ms = meta.as_ref().and_then(modified_time_ms);
            let created_ms = meta.as_ref().and_then(created_time_ms);
            let item = DocTreeItem {
                id: generate_stable_id(&path.to_string_lossy()),
                full_path: path.to_string_lossy().to_string(),
                name,
                item_type: if is_dir {
                    "folder".to_string()
                } else {
                    "document".to_string()
                },
                parent_id: None,
                children: if is_dir { Some(Vec::new()) } else { None },
                size_bytes,
                modified_ms,
                created_ms,
            };

            items.push(item);
        }
    }

    // Sort: folders first, then by name
    items.sort_by(|a, b| {
        if a.item_type != b.item_type {
            if a.item_type == "folder" {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            }
        } else {
            a.name.cmp(&b.name)
        }
    });

    items
}

// ==================== IPC ====================

#[tauri::command]
pub fn get_file_tree(space_path: String, state: State<AppState>) -> Option<Vec<DocTreeItem>> {
    let path = Path::new(&space_path);
    start_security_bookmark_access(&state, path);
    if !path.exists() || !is_browsable_scope(path, &state) {
        return None;
    }
    Some(read_dir_single_level(path))
}

#[tauri::command]
pub fn get_dir_children(dir_path: String, state: State<AppState>) -> Vec<DocTreeItem> {
    let path = Path::new(&dir_path);
    start_security_bookmark_access(&state, path);
    if !path.exists() || !is_browsable_scope(path, &state) {
        return vec![];
    }
    read_dir_single_level(path)
}

/// 文件树可浏览作用域 ── 注册笔记本根 或 资料文件夹 (agent access
/// folder entry), 两者都要求 path 本身落在作用域内 (子目录随
/// `path_is_inside` 一并放行)。
fn is_browsable_scope(path: &Path, state: &State<AppState>) -> bool {
    is_registered_notebook_path(path, state) || is_agent_access_folder(path, state)
}

#[tauri::command]
pub fn read_file(
    file_path: String,
    space_path: Option<String>,
    state: State<AppState>,
) -> Option<String> {
    if !can_access_scoped_file(Path::new(&file_path), space_path.as_deref(), &state) {
        eprintln!("[read_file] refused out-of-scope path: {}", file_path);
        return None;
    }
    start_security_bookmark_access(&state, Path::new(&file_path));
    fs::read_to_string(&file_path).ok()
}

fn image_mime_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "avif" => Some("image/avif"),
        "ico" => Some("image/x-icon"),
        "tif" | "tiff" => Some("image/tiff"),
        "heic" => Some("image/heic"),
        _ => None,
    }
}

/// Read an in-scope image as a data URL so the webview can preview arbitrary
/// user files without widening the Tauri asset-protocol scope.
#[tauri::command]
pub fn read_image_file(
    file_path: String,
    space_path: Option<String>,
    state: State<AppState>,
) -> Option<String> {
    let path = Path::new(&file_path);
    let mime = image_mime_type(path)?;
    if !can_access_scoped_file(path, space_path.as_deref(), &state) || !path.is_file() {
        eprintln!("[read_image_file] refused file: {}", file_path);
        return None;
    }
    start_security_bookmark_access(&state, path);
    let bytes = fs::read(path).ok()?;
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command]
pub fn write_file(
    file_path: String,
    content: String,
    _skip_validation: Option<bool>,
    space_path: Option<String>,
    state: State<AppState>,
) -> bool {
    if !can_access_scoped_file(Path::new(&file_path), space_path.as_deref(), &state) {
        eprintln!("[write_file] refused out-of-scope path: {}", file_path);
        return false;
    }
    start_security_bookmark_access(&state, Path::new(&file_path));
    if let Some(parent) = Path::new(&file_path).parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&file_path, content).is_ok()
}

#[tauri::command]
pub fn delete_file(file_path: String, space_path: Option<String>, state: State<AppState>) -> bool {
    if !can_access_scoped_file(Path::new(&file_path), space_path.as_deref(), &state) {
        eprintln!("[delete_file] refused out-of-scope path: {}", file_path);
        return false;
    }
    start_security_bookmark_access(&state, Path::new(&file_path));
    fs::remove_file(&file_path).is_ok()
}

#[tauri::command]
pub fn create_folder(
    space_path: String,
    name: String,
    _parent_id: Option<String>,
    state: State<AppState>,
) -> Option<DocTreeItem> {
    let target_path = Path::new(&space_path).join(&name);
    if !is_browsable_scope(Path::new(&space_path), &state)
        || !path_is_inside(&target_path, Path::new(&space_path))
    {
        eprintln!(
            "[create_folder] refused out-of-scope path: {}",
            target_path.display()
        );
        return None;
    }
    start_security_bookmark_access(&state, &target_path);
    fs::create_dir_all(&target_path).ok()?;

    Some(DocTreeItem {
        id: generate_stable_id(&target_path.to_string_lossy()),
        full_path: target_path.to_string_lossy().to_string(),
        name,
        item_type: "folder".to_string(),
        parent_id: None,
        children: Some(vec![]),
        size_bytes: None,
        modified_ms: None,
        created_ms: None,
    })
}

#[tauri::command]
pub fn create_document(
    space_path: String,
    name: String,
    _parent_id: Option<String>,
    state: State<AppState>,
) -> Option<DocTreeItem> {
    let file_name = if name.ends_with(".md") {
        name.clone()
    } else {
        format!("{}.md", name)
    };
    let target_path = Path::new(&space_path).join(&file_name);
    if !is_browsable_scope(Path::new(&space_path), &state)
        || !path_is_inside(&target_path, Path::new(&space_path))
    {
        eprintln!(
            "[create_document] refused out-of-scope path: {}",
            target_path.display()
        );
        return None;
    }
    start_security_bookmark_access(&state, &target_path);
    fs::write(&target_path, "").ok()?;

    Some(DocTreeItem {
        id: generate_stable_id(&target_path.to_string_lossy()),
        full_path: target_path.to_string_lossy().to_string(),
        name: file_name,
        item_type: "document".to_string(),
        parent_id: None,
        children: None,
        size_bytes: Some(0),
        modified_ms: None,
        created_ms: None,
    })
}
