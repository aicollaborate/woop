use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

pub const PROTOCOL_EPOCH: i64 = 2;

pub fn v2_content_hash(bytes: &[u8]) -> String {
    base64_url_no_pad(&Sha256::digest(bytes))
}

pub fn new_v2_operation_id() -> String {
    format!("op_{}", uuid::Uuid::now_v7())
}

pub fn v2_notebook_metadata_hash(name: &str, icon: Option<&str>, sort_order: i64) -> String {
    let canonical = serde_json::to_vec(&(name, icon, sort_order))
        .expect("notebook metadata serialization is infallible");
    v2_content_hash(&canonical)
}

fn base64_url_no_pad(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied().unwrap_or(0);
        let c = chunk.get(2).copied().unwrap_or(0);
        output.push(ALPHABET[(a >> 2) as usize] as char);
        output.push(ALPHABET[(((a & 0x03) << 4) | (b >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(ALPHABET[(((b & 0x0f) << 2) | (c >> 6)) as usize] as char);
        }
        if chunk.len() > 2 {
            output.push(ALPHABET[(c & 0x3f) as usize] as char);
        }
    }
    output
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct V2CloudAccount {
    pub user: crate::models::CloudUser,
    pub protocol_epoch: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct V2SyncedNotebook {
    pub notebook_id: String,
    pub enabled: bool,
    pub bootstrap_required: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct V2NoteState {
    pub note_id: String,
    pub notebook_id: String,
    pub revision: String,
    pub content_hash: Option<String>,
    pub filename: String,
    pub deleted: bool,
    pub last_seq: i64,
    pub attachments: Vec<V2Attachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct V2NotebookState {
    pub notebook_id: String,
    pub revision: String,
    pub metadata_hash: String,
    pub deleted: bool,
    pub last_seq: i64,
}

#[derive(Debug, Clone)]
pub struct V2LocalNotebook {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub sort_order: i64,
}

#[derive(Debug, Clone)]
pub struct V2LocalNote {
    pub id: String,
    pub notebook_id: String,
    pub filename: String,
    pub content: Vec<u8>,
    pub attachments: Vec<V2LocalAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct V2Attachment {
    pub filename: String,
    pub content_hash: String,
    pub size_bytes: i64,
    pub mime_type: String,
}

#[derive(Debug, Clone)]
pub struct V2LocalAttachment {
    pub metadata: V2Attachment,
    pub content: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct V2RemoteAttachment {
    pub metadata: V2Attachment,
    pub content: Vec<u8>,
}

/// Collects only files referenced by this document's `asset://` links.
/// `attachments/` is notebook-scoped storage, while cloud manifests must be
/// document-scoped to avoid unrelated files causing sync churn.
pub fn collect_v2_attachments(directory: &Path, markdown: &[u8]) -> Result<Vec<V2LocalAttachment>, String> {
    if !directory.exists() { return Ok(Vec::new()); }
    let directory = std::fs::canonicalize(directory).map_err(|error| error.to_string())?;
    let mut attachments = Vec::new();
    for path in referenced_attachment_paths(&directory, markdown) {
        let filename = path.file_name().and_then(|value| value.to_str()).unwrap_or_default().to_string();
        if filename.is_empty() || filename.contains(['/', '\\']) { continue; }
        let content = std::fs::read(path).map_err(|error| error.to_string())?;
        attachments.push(V2LocalAttachment {
            metadata: V2Attachment {
                mime_type: attachment_mime_type(&filename).to_string(),
                filename,
                content_hash: v2_content_hash(&content),
                size_bytes: i64::try_from(content.len()).map_err(|_| "attachment exceeds i64".to_string())?,
            },
            content,
        });
    }
    attachments.sort_by(|left, right| left.metadata.filename.cmp(&right.metadata.filename));
    Ok(attachments)
}

fn referenced_attachment_paths(directory: &Path, markdown: &[u8]) -> BTreeSet<PathBuf> {
    const PREFIXES: [&str; 3] = ["asset://localhost/", "http://asset.localhost/", "https://asset.localhost/"];
    let source = String::from_utf8_lossy(markdown);
    let mut paths = BTreeSet::new();
    for prefix in PREFIXES {
        let mut remaining = source.as_ref();
        while let Some(index) = remaining.find(prefix) {
            let encoded = &remaining[index + prefix.len()..];
            let end = encoded.find(|value: char| value.is_whitespace() || matches!(value, ')' | '"' | '\'' | '<' | '>'))
                .unwrap_or(encoded.len());
            if let Some(decoded) = percent_decode(&encoded[..end]) {
                if let Ok(path) = std::fs::canonicalize(PathBuf::from(decoded)) {
                    if path.starts_with(directory) && path.is_file() {
                        paths.insert(path);
                    }
                }
            }
            remaining = &encoded[end..];
            if remaining.is_empty() { break; }
        }
    }
    paths
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            decoded.push((hex_value(*bytes.get(index + 1)?)? << 4) | hex_value(*bytes.get(index + 2)?)?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn attachment_mime_type(filename: &str) -> &'static str {
    match Path::new(filename).extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}

#[derive(Debug, Clone)]
pub enum V2RemoteApply {
    Notebook {
        notebook_id: String,
        name: Option<String>,
        icon: Option<String>,
        sort_order: Option<i64>,
        revision: String,
        sync_seq: i64,
        deleted: bool,
    },
    Note {
        note_id: String,
        notebook_id: String,
        filename: String,
        content_hash: Option<String>,
        content: Option<Vec<u8>>,
        revision: String,
        sync_seq: i64,
        deleted: bool,
        attachments: Vec<V2RemoteAttachment>,
    },
}

#[derive(Debug, Clone, Default)]
pub struct V2AccountSyncReport {
    pub started_at: i64,
    pub cursor: i64,
    pub head_cursor: i64,
    pub uploaded: usize,
    pub deleted: usize,
    pub remote: Vec<V2RemoteApply>,
    pub bootstrapped_notebooks: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum V2EntityType {
    Notebook,
    Note,
}

impl V2EntityType {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Notebook => "notebook",
            Self::Note => "note",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "notebook" => Some(Self::Notebook),
            "note" => Some(Self::Note),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum V2OperationKind {
    Put,
    Delete,
}

impl V2OperationKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Put => "put",
            Self::Delete => "delete",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "put" => Some(Self::Put),
            "delete" => Some(Self::Delete),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V2DirtyEntity {
    pub entity_type: V2EntityType,
    pub entity_id: String,
    pub notebook_id: Option<String>,
    pub generation: i64,
    pub operation_kind: V2OperationKind,
    pub fingerprint: String,
    pub detected_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V2InflightOperation {
    pub operation_id: String,
    pub entity_type: V2EntityType,
    pub entity_id: String,
    pub generation: i64,
    pub operation_kind: V2OperationKind,
    pub base_revision: Option<String>,
    pub payload_json: String,
    pub attempts: i64,
    pub next_retry_at: i64,
}

#[derive(Debug, Clone)]
pub struct V2FreezeOperation<'a> {
    pub operation_id: &'a str,
    pub entity_type: V2EntityType,
    pub entity_id: &'a str,
    pub generation: i64,
    pub operation_kind: V2OperationKind,
    pub base_revision: Option<&'a str>,
    pub payload_json: &'a str,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct V2SyncStatus {
    pub protocol_epoch: i64,
    pub cursor: i64,
    pub head_cursor: i64,
    pub has_changes: bool,
    pub server_time: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct V2Change {
    pub sync_seq: i64,
    pub entity_type: String,
    pub entity_id: String,
    pub notebook_id: Option<String>,
    pub revision: String,
    pub kind: String,
    pub created_at: i64,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub sort_order: Option<i64>,
    #[serde(default)]
    pub filename: Option<String>,
    #[serde(default)]
    pub content_hash: Option<String>,
    #[serde(default)]
    pub size_bytes: Option<i64>,
    pub deleted: bool,
    #[serde(default)]
    pub attachments: Vec<V2Attachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2ChangesPage {
    pub protocol_epoch: i64,
    pub cursor: i64,
    pub head_cursor: i64,
    pub has_more: bool,
    pub changes: Vec<V2Change>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2Bootstrap {
    pub protocol_epoch: i64,
    pub cursor: i64,
    pub server_time: i64,
    pub notebooks: Vec<V2BootstrapNotebook>,
    pub notes: Vec<V2BootstrapNote>,
    pub usage: V2Usage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2BootstrapNotebook {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub sort_order: i64,
    pub revision: String,
    pub deleted: bool,
    pub sync_seq: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2BootstrapNote {
    pub id: String,
    pub notebook_id: String,
    pub filename: String,
    pub revision: String,
    pub content_hash: Option<String>,
    pub size_bytes: i64,
    pub deleted: bool,
    pub sync_seq: i64,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub attachments: Vec<V2Attachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2Usage {
    pub used_bytes: i64,
    pub quota_bytes: i64,
    pub entitlement_expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2BlobReservation {
    pub reservation_id: String,
    pub content_hash: String,
    pub size_bytes: i64,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2BlobReservationEnvelope {
    pub data: V2BlobReservation,
    pub upload: V2BlobUpload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct V2BlobUpload {
    pub method: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum V2PushOperation {
    #[serde(rename = "notebook.put")]
    NotebookPut {
        operation_id: String,
        base_revision: Option<String>,
        notebook: V2NotebookPut,
    },
    #[serde(rename = "notebook.delete")]
    NotebookDelete {
        operation_id: String,
        base_revision: Option<String>,
        notebook_id: String,
    },
    #[serde(rename = "note.put")]
    NotePut {
        operation_id: String,
        base_revision: Option<String>,
        note: V2NotePut,
    },
    #[serde(rename = "note.delete")]
    NoteDelete {
        operation_id: String,
        base_revision: Option<String>,
        note_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2NotebookPut {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2NotePut {
    pub id: String,
    pub notebook_id: String,
    pub filename: String,
    pub content_hash: String,
    pub size_bytes: i64,
    #[serde(default)]
    pub attachments: Vec<V2Attachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2OperationResult {
    pub operation_id: String,
    pub ok: bool,
    pub status: u16,
    #[serde(default)]
    pub data: Option<V2OperationData>,
    #[serde(default)]
    pub error: Option<V2OperationError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2OperationError {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2OperationData {
    pub entity_type: String,
    pub entity_id: String,
    pub revision: String,
    pub sync_seq: i64,
    pub deleted: bool,
    pub resolution: String,
    pub base_revision: Option<String>,
    pub replaced_revision: Option<String>,
    #[serde(default)]
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2PushResult {
    pub protocol_epoch: i64,
    pub results: Vec<V2OperationResult>,
    pub head_cursor: i64,
}

#[cfg(test)]
mod tests {
    use super::{collect_v2_attachments, new_v2_operation_id, v2_content_hash, V2NotePut, V2PushOperation};

    #[test]
    fn content_hash_matches_web_crypto_base64_url_without_padding() {
        assert_eq!(
            v2_content_hash(b""),
            "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"
        );
        assert_eq!(v2_content_hash(b"Flowix").len(), 43);
    }

    #[test]
    fn operation_ids_are_unique_and_protocol_safe() {
        let first = new_v2_operation_id();
        let second = new_v2_operation_id();
        assert_ne!(first, second);
        assert!(first.starts_with("op_"));
        assert!(first
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '_' || value == '-'));
    }

    #[test]
    fn push_operation_matches_the_cloud_camel_case_contract() {
        let value = serde_json::to_value(V2PushOperation::NotePut {
            operation_id: "op_test_123".into(),
            base_revision: Some("rev_1".into()),
            note: V2NotePut {
                id: "abc12345".into(),
                notebook_id: "nb_0198f1aa-7b22-7def-8123-0123456789ab".into(),
                filename: "abc12345.md".into(),
                content_hash: "A".repeat(43),
                size_bytes: 12,
                attachments: Vec::new(),
            },
        })
        .unwrap();
        assert_eq!(value["type"], "note.put");
        assert_eq!(value["operationId"], "op_test_123");
        assert_eq!(value["baseRevision"], "rev_1");
        assert_eq!(
            value["note"]["notebookId"],
            "nb_0198f1aa-7b22-7def-8123-0123456789ab"
        );
        assert_eq!(value["note"]["sizeBytes"], 12);
        assert!(value.get("operation_id").is_none());
    }

    #[test]
    fn attachment_manifest_contains_only_document_asset_links() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("attachments");
        std::fs::create_dir(&directory).unwrap();
        let used = directory.join("used image.png");
        std::fs::write(&used, b"used").unwrap();
        std::fs::write(directory.join("unrelated.mp4"), b"unrelated").unwrap();
        let encoded = used.to_string_lossy().replace('/', "%2F").replace(' ', "%20");
        let markdown = format!("![image](asset://localhost/{encoded})");

        let attachments = collect_v2_attachments(&directory, markdown.as_bytes()).unwrap();

        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].metadata.filename, "used image.png");
        assert_eq!(attachments[0].metadata.mime_type, "image/png");
    }

    #[test]
    fn attachment_manifest_rejects_paths_outside_the_notebook_directory() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("attachments");
        std::fs::create_dir(&directory).unwrap();
        let outside = temp.path().join("private.pdf");
        std::fs::write(&outside, b"private").unwrap();
        let encoded = outside.to_string_lossy().replace('/', "%2F");
        let markdown = format!("[file](asset://localhost/{encoded})");

        assert!(collect_v2_attachments(&directory, markdown.as_bytes()).unwrap().is_empty());
    }
}
