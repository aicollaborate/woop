use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudUser {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub system_role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspace {
    pub id: String,
    pub name: Option<String>,
    pub slug: String,
    pub role: String,
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudNotebook {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub synced: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudSession {
    pub access_token: String,
    pub access_token_expires_at: i64,
    pub refresh_token: String,
    pub refresh_token_expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthData {
    pub user: CloudUser,
    pub session: CloudSession,
    pub workspace: Option<CloudWorkspace>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppleAuthChallenge {
    pub challenge_id: String,
    pub nonce: String,
    pub expires_at: i64,
    pub client_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppleAuthorization {
    pub challenge_id: String,
    pub nonce: String,
    pub identity_token: String,
    pub authorization_code: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct DataEnvelope<T> {
    pub data: T,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RefreshData {
    pub session: CloudSession,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MeData {
    pub user: CloudUser,
    pub workspaces: Vec<CloudWorkspace>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ApiErrorEnvelope {
    pub error: ApiErrorBody,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiErrorBody {
    pub code: String,
    pub message: String,
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudAccount {
    pub user: CloudUser,
    pub workspace: CloudWorkspace,
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeSession {
    pub access_token: String,
    pub access_token_expires_at: i64,
    pub refresh_token: String,
    pub refresh_token_expires_at: i64,
}

impl From<CloudSession> for RuntimeSession {
    fn from(value: CloudSession) -> Self {
        Self {
            access_token: value.access_token,
            access_token_expires_at: value.access_token_expires_at,
            refresh_token: value.refresh_token,
            refresh_token_expires_at: value.refresh_token_expires_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudMembership {
    pub active: bool,
    pub starts_at: Option<i64>,
    pub expires_at: Option<i64>,
    pub used_bytes: i64,
    pub quota_bytes: i64,
    pub available_bytes: i64,
    pub note_count: i64,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudProduct {
    pub id: String,
    pub name: String,
    pub description: String,
    pub price: CloudPrice,
    pub entitlement: ProductEntitlement,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudPrice {
    pub amount: i64,
    pub currency: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductEntitlement {
    pub storage_bytes: i64,
    pub duration: ProductDuration,
    pub features: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductDuration {
    pub unit: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudCheckout {
    pub order_id: String,
    pub status: String,
    pub checkout_url: String,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudState {
    pub enabled: bool,
    pub authenticated: bool,
    pub account: Option<CloudAccount>,
    pub membership: Option<CloudMembership>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AuthOutcome {
    pub state: CloudState,
    pub refresh_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotebookLink {
    pub local_notebook_id: String,
    pub workspace_id: String,
    pub cloud_notebook_id: String,
    pub enabled: bool,
    pub last_cursor: i64,
    pub last_sync_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct LocalNote {
    pub id: String,
    pub filename: String,
    pub content: String,
    /// Wall-clock millis of the last local edit. Used as the last-writer-wins
    /// tiebreaker when both sides changed a note.
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct NoteState {
    pub revision: String,
    pub last_synced_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManifestData {
    pub cursor: i64,
    pub has_more: bool,
    pub changes: Vec<ManifestChange>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManifestChange {
    pub notebook_id: String,
    pub note_id: String,
    pub filename: String,
    pub revision: Option<String>,
    pub deleted_at: Option<i64>,
    #[serde(default)]
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PutNoteData {
    pub note: PutNote,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PutNote {
    pub revision: String,
}

#[derive(Debug, Clone)]
pub enum RemoteApplyKind {
    Upsert {
        filename: String,
        content: String,
        revision: String,
    },
    Delete,
}

#[derive(Debug, Clone)]
pub struct RemoteApply {
    pub note_id: String,
    pub kind: RemoteApplyKind,
}

#[derive(Debug, Clone, Default)]
pub struct SyncReport {
    pub workspace_id: String,
    pub uploaded: usize,
    pub deleted: usize,
    pub remote: Vec<RemoteApply>,
    pub cursor: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EntitlementData {
    pub membership: EntitlementMembership,
    pub usage: EntitlementUsage,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EntitlementMembership {
    pub active: bool,
    pub starts_at: Option<i64>,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EntitlementUsage {
    pub used_bytes: i64,
    pub quota_bytes: i64,
    pub available_bytes: i64,
    pub note_count: i64,
    pub read_only: bool,
}

impl From<EntitlementData> for CloudMembership {
    fn from(value: EntitlementData) -> Self {
        Self {
            active: value.membership.active,
            starts_at: value.membership.starts_at,
            expires_at: value.membership.expires_at,
            used_bytes: value.usage.used_bytes,
            quota_bytes: value.usage.quota_bytes,
            available_bytes: value.usage.available_bytes,
            note_count: value.usage.note_count,
            read_only: value.usage.read_only,
        }
    }
}
