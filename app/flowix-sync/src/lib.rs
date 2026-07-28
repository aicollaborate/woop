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

pub use client::CloudClient;
pub use error::SyncError;
pub use manager::SyncManager;
pub use models::{
    AppleAuthChallenge, AppleAuthorization, AuthOutcome, CloudAccount, CloudCheckout,
    CloudMembership, CloudNotebook, CloudPrice, CloudProduct, CloudState, CloudUser,
    CloudWorkspace, LocalChangeKind, LocalNote, NotebookLink, ProductDuration, ProductEntitlement,
    RemoteApply, RemoteApplyKind, SyncReport,
};
pub use store::SyncStore;

pub const DEFAULT_CLOUD_API_BASE: &str = "https://cloud.flowix-memo.com";
