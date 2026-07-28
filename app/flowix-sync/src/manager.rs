use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, RwLock};

use chrono::Utc;
use sha2::{Digest, Sha256};

use crate::client::{CloudClient, PutNoteRequest};
use crate::error::SyncError;
use crate::models::{
    AppleAuthChallenge, AppleAuthorization, AuthOutcome, ChangeVersion, CloudAccount,
    CloudCheckout, CloudMembership, CloudProduct, CloudState, LocalChangeKind, LocalNote,
    NotebookLink, OutboxEntry, RemoteApply, RemoteApplyKind, RuntimeSession, SyncReport,
};
use crate::store::SyncStore;

#[derive(Clone)]
pub struct SyncManager {
    client: CloudClient,
    store: SyncStore,
    session: Arc<RwLock<Option<RuntimeSession>>>,
    membership: Arc<RwLock<Option<CloudMembership>>>,
    last_error: Arc<RwLock<Option<String>>>,
    refresh_lock: Arc<tokio::sync::Mutex<()>>,
}

mod auth;
mod catalog;
mod engine;
mod scheduling;
mod state;
