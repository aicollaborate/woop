//! Flowix Cloud authentication and synchronization engine.
//!
//! This crate deliberately has no Tauri dependency. `flowix-desktop` owns the
//! local Markdown adapter and secret persistence; this crate owns the Cloud
//! HTTP contract, sync state database, revisions, cursors and conflict plans.

mod client;
mod error;
mod manager;
mod models;
mod store;
mod v2;

pub use client::CloudClient;
pub use error::SyncError;
pub use manager::SyncManager;
pub use models::{
    AppleAuthChallenge, AppleAuthorization, AuthOutcome, CloudCheckout, CloudMembership,
    CloudNotebook, CloudPrice, CloudProduct, CloudState, CloudUser, LocalChangeKind,
    ProductDuration, ProductEntitlement,
};
pub use store::SyncStore;
pub use v2::{
    collect_v2_attachments, new_v2_operation_id, v2_content_hash, v2_notebook_metadata_hash, V2AccountSyncReport,
    V2BlobReservation, V2BlobReservationEnvelope, V2BlobUpload, V2Bootstrap, V2Change,
    V2ChangesPage, V2CloudAccount, V2DirtyEntity, V2EntityType, V2FreezeOperation,
    V2InflightOperation, V2LocalNote, V2LocalNotebook, V2NoteState, V2NotebookState,
    V2OperationError, V2OperationKind, V2PushOperation, V2PushResult, V2RemoteApply, V2SyncStatus,
    V2Attachment, V2LocalAttachment, V2RemoteAttachment, V2SyncedNotebook, PROTOCOL_EPOCH,
};

pub const DEFAULT_CLOUD_API_BASE: &str = "https://cloud.flowix-memo.com";
