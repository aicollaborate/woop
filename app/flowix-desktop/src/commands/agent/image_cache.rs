use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;
use uuid::Uuid;

pub(super) const MAX_AGENT_IMAGE_BYTES: usize = 5 * 1024 * 1024;
pub(super) const MAX_AGENT_IMAGE_COUNT: usize = 5;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedAgentImage {
    path: String,
    mime_type: String,
    name: String,
}

fn agent_image_extension(mime_type: &str) -> Option<&'static str> {
    match mime_type.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn agent_image_cache_root() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".flowix").join("cache").join("images"))
        .ok_or_else(|| "Home directory is unavailable".to_string())
}

fn ensure_path_within_image_cache(root: &Path, candidate: &Path) -> Result<(), String> {
    if !candidate.starts_with(root) || !candidate.is_file() {
        return Err("Cached image path is outside the image cache".to_string());
    }
    Ok(())
}

pub(super) async fn resolve_cached_agent_image(path: &str) -> Result<Option<PathBuf>, String> {
    let root = agent_image_cache_root()?;
    let root = match tokio::fs::canonicalize(&root).await {
        Ok(root) => root,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Failed to resolve image cache: {error}")),
    };
    let candidate = match tokio::fs::canonicalize(path).await {
        Ok(candidate) => candidate,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Failed to resolve cached image: {error}")),
    };
    ensure_path_within_image_cache(&root, &candidate)?;
    Ok(Some(candidate))
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cache_agent_image(
    content: String,
    mimeType: String,
) -> Result<CachedAgentImage, String> {
    let extension = agent_image_extension(&mimeType)
        .ok_or_else(|| format!("Unsupported image type: {mimeType}"))?;
    let encoded = content
        .split_once(',')
        .map(|(_, body)| body)
        .unwrap_or(content.as_str());
    // Reject oversized payloads before allocating the decoded buffer. Base64
    // expands binary data by roughly 4/3; the small allowance covers padding.
    if encoded.len() > (MAX_AGENT_IMAGE_BYTES * 4 / 3) + 4 {
        return Err(format!(
            "Image exceeds {} MB limit",
            MAX_AGENT_IMAGE_BYTES / 1024 / 1024
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid base64 image content".to_string())?;
    if bytes.is_empty() {
        return Err("Image content is empty".to_string());
    }
    if bytes.len() > MAX_AGENT_IMAGE_BYTES {
        return Err(format!(
            "Image exceeds {} MB limit",
            MAX_AGENT_IMAGE_BYTES / 1024 / 1024
        ));
    }

    let directory =
        agent_image_cache_root()?.join(chrono::Local::now().format("%Y-%m-%d").to_string());
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| format!("Failed to create image cache: {error}"))?;
    let name = format!("{}.{}", Uuid::new_v4(), extension);
    let path = directory.join(&name);
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|error| format!("Failed to cache image: {error}"))?;

    Ok(CachedAgentImage {
        path: path.to_string_lossy().into_owned(),
        mime_type: mimeType.to_ascii_lowercase(),
        name,
    })
}

#[tauri::command]
pub async fn delete_cached_agent_image(path: String) -> Result<bool, String> {
    let Some(candidate) = resolve_cached_agent_image(&path).await? else {
        return Ok(false);
    };
    tokio::fs::remove_file(candidate)
        .await
        .map(|_| true)
        .map_err(|error| format!("Failed to delete cached image: {error}"))
}

#[tauri::command]
pub async fn read_cached_agent_image(path: String) -> Result<Option<String>, String> {
    let Some(candidate) = resolve_cached_agent_image(&path).await? else {
        return Ok(None);
    };
    let mime_type = match candidate
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => return Err("Unsupported cached image type".to_string()),
    };
    let bytes = tokio::fs::read(candidate)
        .await
        .map_err(|error| format!("Failed to read cached image: {error}"))?;
    if bytes.len() > MAX_AGENT_IMAGE_BYTES {
        return Err("Cached image exceeds the preview size limit".to_string());
    }
    Ok(Some(format!(
        "data:{mime_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_image_cache_accepts_safe_raster_formats_only() {
        assert_eq!(agent_image_extension("image/png"), Some("png"));
        assert_eq!(agent_image_extension("IMAGE/JPEG"), Some("jpg"));
        assert_eq!(agent_image_extension("image/webp"), Some("webp"));
        assert_eq!(agent_image_extension("image/gif"), Some("gif"));
        assert_eq!(agent_image_extension("image/svg+xml"), None);
        assert_eq!(agent_image_extension("text/html"), None);
    }

    #[test]
    fn agent_image_cache_rejects_files_outside_its_root() {
        let root =
            std::env::temp_dir().join(format!("flowix-agent-image-root-{}", std::process::id()));
        let outside = std::env::temp_dir().join(format!(
            "flowix-agent-image-outside-{}.png",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("create cache root");
        let inside = root.join("inside.png");
        std::fs::write(&inside, b"png").expect("create inside image");
        std::fs::write(&outside, b"png").expect("create outside image");
        assert!(ensure_path_within_image_cache(&root, &inside).is_ok());
        assert!(ensure_path_within_image_cache(&root, &outside).is_err());
        let _ = std::fs::remove_file(outside);
        let _ = std::fs::remove_dir_all(root);
    }
}
