use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, RwLock};

use crate::client::CloudClient;
use crate::error::SyncError;
use crate::models::{
    AppleAuthChallenge, AppleAuthorization, AuthOutcome, CloudCheckout, CloudMembership,
    CloudProduct, CloudState, LocalChangeKind, RuntimeSession,
};
use crate::store::SyncStore;
use crate::v2::{
    V2AccountSyncReport, V2Bootstrap, V2Change, V2CloudAccount, V2EntityType, V2FreezeOperation,
    V2LocalNote, V2LocalNotebook, V2OperationKind, V2PushOperation, V2RemoteApply,
};
use chrono::Utc;

#[derive(Clone)]
pub struct SyncManager {
    client: CloudClient,
    store: SyncStore,
    session: Arc<RwLock<Option<RuntimeSession>>>,
    membership: Arc<RwLock<Option<CloudMembership>>>,
    last_error: Arc<RwLock<Option<String>>>,
    refresh_lock: Arc<tokio::sync::Mutex<()>>,
    account_sync_lock: Arc<tokio::sync::Mutex<()>>,
}

mod auth;
mod catalog;
mod state;
mod v2_engine;
