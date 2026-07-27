use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, RwLock};

use sha2::{Digest, Sha256};

use crate::client::CloudClient;
use crate::error::SyncError;
use crate::models::{
    AppleAuthChallenge, AppleAuthorization, AuthOutcome, CloudAccount, CloudCheckout,
    CloudMembership, CloudProduct, CloudState, LocalNote, NotebookLink, RemoteApply,
    RemoteApplyKind, RuntimeSession, SyncReport,
};
use crate::store::SyncStore;

#[derive(Clone)]
pub struct SyncManager {
    client: CloudClient,
    store: SyncStore,
    session: Arc<RwLock<Option<RuntimeSession>>>,
    membership: Arc<RwLock<Option<CloudMembership>>>,
    last_error: Arc<RwLock<Option<String>>>,
}

impl SyncManager {
    pub fn new(api_base: &str, database_path: impl AsRef<Path>) -> Result<Self, SyncError> {
        Ok(Self {
            client: CloudClient::new(api_base)?,
            store: SyncStore::new(database_path)?,
            session: Arc::new(RwLock::new(None)),
            membership: Arc::new(RwLock::new(None)),
            last_error: Arc::new(RwLock::new(None)),
        })
    }

    pub fn store(&self) -> &SyncStore {
        &self.store
    }

    pub fn state(&self) -> Result<CloudState, SyncError> {
        Ok(CloudState {
            enabled: self.store.enabled()?,
            authenticated: self
                .session
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_some(),
            account: self.store.account()?,
            membership: self
                .membership
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
            last_error: self
                .last_error
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
        })
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<CloudState, SyncError> {
        self.store.set_enabled(enabled)?;
        self.state()
    }

    /// Returns the currently rotated refresh token for persistence by the
    /// desktop shell. The token must never cross the frontend IPC boundary.
    pub fn current_refresh_token(&self) -> Option<String> {
        self.session
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .map(|session| session.refresh_token.clone())
    }

    pub async fn register(
        &self,
        email: &str,
        password: &str,
        display_name: &str,
    ) -> Result<AuthOutcome, SyncError> {
        let auth = self.client.register(email, password, display_name).await?;
        let workspace = auth.workspace.clone().ok_or_else(|| {
            SyncError::InvalidState("registration did not return a workspace".into())
        })?;
        self.accept_auth(
            CloudAccount {
                user: auth.user,
                workspace,
            },
            auth.session.into(),
        )
        .await
    }

    pub async fn login(&self, email: &str, password: &str) -> Result<AuthOutcome, SyncError> {
        let auth = self.client.login(email, password).await?;
        let runtime: RuntimeSession = auth.session.into();
        let me = self.client.me(&runtime.access_token).await?;
        let workspace = me
            .workspaces
            .into_iter()
            .find(|workspace| workspace.kind.as_deref() == Some("personal"))
            .or_else(|| auth.workspace)
            .ok_or_else(|| SyncError::InvalidState("account has no workspace".into()))?;
        self.accept_auth(
            CloudAccount {
                user: me.user,
                workspace,
            },
            runtime,
        )
        .await
    }

    pub async fn apple_challenge(&self) -> Result<AppleAuthChallenge, SyncError> {
        self.client.apple_challenge().await
    }

    pub async fn sign_in_with_apple(
        &self,
        authorization: &AppleAuthorization,
    ) -> Result<AuthOutcome, SyncError> {
        let auth = self.client.apple_exchange(authorization).await?;
        let runtime: RuntimeSession = auth.session.into();
        let me = self.client.me(&runtime.access_token).await?;
        let workspace = me
            .workspaces
            .into_iter()
            .find(|workspace| workspace.kind.as_deref() == Some("personal"))
            .or(auth.workspace)
            .ok_or_else(|| SyncError::InvalidState("account has no workspace".into()))?;
        self.accept_auth(
            CloudAccount {
                user: me.user,
                workspace,
            },
            runtime,
        )
        .await
    }

    pub async fn link_apple(
        &self,
        authorization: &AppleAuthorization,
    ) -> Result<CloudState, SyncError> {
        let access_token = self.access_token().await?;
        self.client.apple_link(&access_token, authorization).await?;
        self.state()
    }

    pub async fn restore(&self, refresh_token: &str) -> Result<AuthOutcome, SyncError> {
        let account = self.store.account()?.ok_or(SyncError::NotAuthenticated)?;
        let refreshed = self.client.refresh(refresh_token).await?;
        self.accept_auth(account, refreshed.session.into()).await
    }

    async fn accept_auth(
        &self,
        account: CloudAccount,
        runtime: RuntimeSession,
    ) -> Result<AuthOutcome, SyncError> {
        let refresh_token = runtime.refresh_token.clone();
        self.store.save_account(&account)?;
        *self
            .session
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(runtime);
        *self
            .last_error
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        let _ = self.refresh_membership().await;
        Ok(AuthOutcome {
            state: self.state()?,
            refresh_token,
        })
    }

    pub async fn logout(&self) -> Result<(), SyncError> {
        let token = self
            .session
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .map(|session| session.access_token.clone());
        if let Some(token) = token {
            let _ = self.client.logout(&token).await;
        }
        *self
            .session
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .membership
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        self.store.clear_account()?;
        Ok(())
    }

    async fn access_token(&self) -> Result<String, SyncError> {
        let current = self
            .session
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or(SyncError::NotAuthenticated)?;
        let now = chrono::Utc::now().timestamp_millis();
        if current.access_token_expires_at > now + 30_000 {
            return Ok(current.access_token);
        }
        if current.refresh_token_expires_at <= now {
            return Err(SyncError::NotAuthenticated);
        }
        let refreshed = self.client.refresh(&current.refresh_token).await?;
        let access_token = refreshed.session.access_token.clone();
        *self
            .session
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(refreshed.session.into());
        Ok(access_token)
    }

    pub async fn refresh_membership(&self) -> Result<CloudMembership, SyncError> {
        let account = self.store.account()?.ok_or(SyncError::NotAuthenticated)?;
        let token = self.access_token().await?;
        let membership: CloudMembership = self
            .client
            .entitlements(&token, &account.workspace.id)
            .await?
            .into();
        *self
            .membership
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(membership.clone());
        Ok(membership)
    }

    pub async fn products(&self) -> Result<Vec<CloudProduct>, SyncError> {
        self.client.products().await
    }

    pub async fn remote_notebooks(&self) -> Result<Vec<crate::models::CloudNotebook>, SyncError> {
        let account = self.store.account()?.ok_or(SyncError::NotAuthenticated)?;
        let token = self.access_token().await?;
        let mut notebooks = self.client.notebooks(&token, &account.workspace.id).await?;
        for notebook in &mut notebooks {
            notebook.synced = self
                .store
                .cloud_notebook_is_linked(&account.workspace.id, &notebook.id)?;
        }
        Ok(notebooks)
    }

    pub async fn link_remote_notebook(
        &self,
        notebook_id: &str,
        cloud_notebook_id: &str,
    ) -> Result<NotebookLink, SyncError> {
        let account = self.store.account()?.ok_or(SyncError::NotAuthenticated)?;
        let token = self.access_token().await?;
        let remote_exists = self
            .client
            .notebooks(&token, &account.workspace.id)
            .await?
            .into_iter()
            .any(|notebook| notebook.id == cloud_notebook_id);
        if !remote_exists {
            return Err(SyncError::InvalidState(
                "remote notebook does not exist".into(),
            ));
        }
        if self
            .store
            .cloud_notebook_is_linked(&account.workspace.id, cloud_notebook_id)?
        {
            return Err(SyncError::InvalidState(
                "remote notebook is already linked locally".into(),
            ));
        }
        self.store.set_enabled(true)?;
        self.store
            .link_remote_notebook(&account.workspace.id, notebook_id, cloud_notebook_id)
    }

    pub async fn create_checkout(
        &self,
        product_id: &str,
        idempotency_key: &str,
    ) -> Result<CloudCheckout, SyncError> {
        let account = self.store.account()?.ok_or(SyncError::NotAuthenticated)?;
        let token = self.access_token().await?;
        self.client
            .checkout(&token, &account.workspace.id, product_id, idempotency_key)
            .await
    }

    pub async fn set_notebook_enabled(
        &self,
        notebook_id: &str,
        notebook_name: &str,
        enabled: bool,
    ) -> Result<NotebookLink, SyncError> {
        let account = self.store.account()?.ok_or(SyncError::NotAuthenticated)?;
        if enabled {
            let token = self.access_token().await?;
            let cloud_notebook_id = if let Some(link) = self
                .store
                .notebook_link(&account.workspace.id, notebook_id)?
            {
                link.cloud_notebook_id
            } else {
                let mut matched = None;
                for notebook in self
                    .client
                    .notebooks(&token, &account.workspace.id)
                    .await?
                    .into_iter()
                    .filter(|notebook| notebook.name.eq_ignore_ascii_case(notebook_name))
                {
                    if !self
                        .store
                        .cloud_notebook_is_linked(&account.workspace.id, &notebook.id)?
                    {
                        matched = Some(notebook.id);
                        break;
                    }
                }
                matched.unwrap_or_else(|| notebook_id.to_string())
            };
            self.client
                .create_notebook(
                    &token,
                    &account.workspace.id,
                    &cloud_notebook_id,
                    notebook_name,
                )
                .await?;
            return self.store.set_notebook(
                notebook_id,
                &account.workspace.id,
                &cloud_notebook_id,
                true,
            );
        }
        let cloud_notebook_id = self
            .store
            .notebook_link(&account.workspace.id, notebook_id)?
            .map(|link| link.cloud_notebook_id)
            .unwrap_or_else(|| notebook_id.to_string());
        self.store.set_notebook(
            notebook_id,
            &account.workspace.id,
            &cloud_notebook_id,
            false,
        )
    }

    pub fn notebook_link(&self, notebook_id: &str) -> Result<Option<NotebookLink>, SyncError> {
        let Some(account) = self.store.account()? else {
            return Ok(None);
        };
        self.store.notebook_link(&account.workspace.id, notebook_id)
    }

    pub fn enabled_notebooks(&self) -> Result<Vec<NotebookLink>, SyncError> {
        let Some(account) = self.store.account()? else {
            return Ok(Vec::new());
        };
        self.store.enabled_notebooks(&account.workspace.id)
    }

    pub fn disable_notebook(&self, notebook_id: &str) -> Result<(), SyncError> {
        let account = self.store.account()?.ok_or(SyncError::NotAuthenticated)?;
        self.store
            .disable_notebook(&account.workspace.id, notebook_id)
    }

    pub fn forget_notebook(&self, notebook_id: &str) -> Result<(), SyncError> {
        self.store.forget_notebook(notebook_id)
    }

    pub async fn sync_notebook(
        &self,
        notebook_id: &str,
        local_notes: Vec<LocalNote>,
    ) -> Result<SyncReport, SyncError> {
        if !self.store.enabled()? {
            return Err(SyncError::Disabled);
        }
        let account = self.store.account()?.ok_or(SyncError::NotAuthenticated)?;
        let workspace_id = account.workspace.id;
        let link = self
            .store
            .notebook_link(&workspace_id, notebook_id)?
            .filter(|link| link.enabled)
            .ok_or(SyncError::NotebookDisabled)?;
        let token = self.access_token().await?;
        let mut manifest = self
            .client
            .manifest(&token, &link.workspace_id, link.last_cursor)
            .await?;
        while manifest.has_more {
            let next = self
                .client
                .manifest(&token, &link.workspace_id, manifest.cursor)
                .await?;
            if next.cursor <= manifest.cursor {
                return Err(SyncError::InvalidState(
                    "cloud manifest cursor did not advance".into(),
                ));
            }
            manifest.cursor = next.cursor;
            manifest.has_more = next.has_more;
            manifest.changes.extend(next.changes);
        }
        let remote_by_id: HashMap<_, _> = manifest
            .changes
            .iter()
            .filter(|change| change.notebook_id == link.cloud_notebook_id)
            .map(|change| (change.note_id.as_str(), change))
            .collect();
        let local_by_id: HashMap<_, _> = local_notes
            .iter()
            .map(|note| (note.id.as_str(), note))
            .collect();
        let mut handled_remote = HashSet::new();
        let mut report = SyncReport {
            workspace_id: workspace_id.clone(),
            cursor: manifest.cursor,
            ..SyncReport::default()
        };

        for note in &local_notes {
            let hash = content_hash(&note.content);
            let state = self
                .store
                .note_state(&workspace_id, notebook_id, &note.id)?;
            let local_dirty = state
                .as_ref()
                .map(|state| state.last_synced_hash != hash)
                .unwrap_or(true);
            let remote = remote_by_id.get(note.id.as_str()).copied();
            let remote_dirty = match (remote, state.as_ref()) {
                (Some(change), Some(state)) => {
                    change.deleted_at.is_some()
                        || change.revision.as_deref() != Some(state.revision.as_str())
                }
                (Some(_), None) => true,
                _ => false,
            };

            if local_dirty && remote_dirty {
                if let Some(change) = remote {
                    if change.deleted_at.is_some() {
                        // Local edit vs cloud delete: the edit wins. Resurrect
                        // the cloud note by uploading with no base revision,
                        // which clears `deleted_at` server-side.
                        let put = self
                            .client
                            .put_note(
                                &token,
                                &link.workspace_id,
                                &link.cloud_notebook_id,
                                &note.id,
                                &note.filename,
                                &note.content,
                                None,
                            )
                            .await?;
                        self.store.save_note_state(
                            &workspace_id,
                            notebook_id,
                            &note.id,
                            &put.note.revision,
                            &hash,
                        )?;
                        report.uploaded += 1;
                        handled_remote.insert(note.id.clone());
                        continue;
                    }
                    let revision = change.revision.clone().unwrap_or_default();
                    let cloud_content = self
                        .client
                        .get_note(
                            &token,
                            &link.workspace_id,
                            &link.cloud_notebook_id,
                            &note.id,
                        )
                        .await?;
                    if content_hash(&cloud_content) == hash {
                        // Both sides converged to the same bytes: align state.
                        self.store.save_note_state(
                            &workspace_id,
                            notebook_id,
                            &note.id,
                            &revision,
                            &hash,
                        )?;
                        handled_remote.insert(note.id.clone());
                        continue;
                    }
                    // Last-writer-wins: the newer edit overwrites the older.
                    // Ties go to local so we avoid a needless download cycle.
                    // Note: cloud `updated_at` is the server upload time, so
                    // near-simultaneous edits (within sync delay) may pick the
                    // cloud side; this only matters for sub-second races.
                    if local_wins_lww(note.updated_at, change.updated_at) {
                        let put = self
                            .client
                            .put_note(
                                &token,
                                &link.workspace_id,
                                &link.cloud_notebook_id,
                                &note.id,
                                &note.filename,
                                &note.content,
                                change.revision.as_deref(),
                            )
                            .await?;
                        self.store.save_note_state(
                            &workspace_id,
                            notebook_id,
                            &note.id,
                            &put.note.revision,
                            &hash,
                        )?;
                        report.uploaded += 1;
                    } else {
                        report.remote.push(RemoteApply {
                            note_id: note.id.clone(),
                            kind: RemoteApplyKind::Upsert {
                                filename: change.filename.clone(),
                                content: cloud_content,
                                revision,
                            },
                        });
                    }
                    handled_remote.insert(note.id.clone());
                    continue;
                }
            }

            if local_dirty {
                let put = self
                    .client
                    .put_note(
                        &token,
                        &link.workspace_id,
                        &link.cloud_notebook_id,
                        &note.id,
                        &note.filename,
                        &note.content,
                        state.as_ref().map(|state| state.revision.as_str()),
                    )
                    .await?;
                self.store.save_note_state(
                    &workspace_id,
                    notebook_id,
                    &note.id,
                    &put.note.revision,
                    &hash,
                )?;
                report.uploaded += 1;
            }
        }

        // A note that existed at the last successful sync but no longer
        // exists locally is a local delete. If Cloud changed it concurrently,
        // the edit wins: pull the Cloud version back down instead of deleting.
        for (note_id, state) in self.store.note_states(&workspace_id, notebook_id)? {
            if local_by_id.contains_key(note_id.as_str()) {
                continue;
            }
            if let Some(change) = remote_by_id.get(note_id.as_str()).copied() {
                handled_remote.insert(note_id.clone());
                if change.deleted_at.is_some() {
                    self.store
                        .remove_note_state(&workspace_id, notebook_id, &note_id)?;
                    continue;
                }
                if change.revision.as_deref() != Some(state.revision.as_str()) {
                    // Local delete vs cloud edit: resurrect locally.
                    let revision = change.revision.clone().unwrap_or_default();
                    let cloud_content = self
                        .client
                        .get_note(
                            &token,
                            &link.workspace_id,
                            &link.cloud_notebook_id,
                            &note_id,
                        )
                        .await?;
                    report.remote.push(RemoteApply {
                        note_id: note_id.clone(),
                        kind: RemoteApplyKind::Upsert {
                            filename: change.filename.clone(),
                            content: cloud_content,
                            revision,
                        },
                    });
                    continue;
                }
            }
            self.client
                .delete_note(
                    &token,
                    &link.workspace_id,
                    &link.cloud_notebook_id,
                    &note_id,
                    Some(&state.revision),
                )
                .await?;
            self.store
                .remove_note_state(&workspace_id, notebook_id, &note_id)?;
            report.deleted += 1;
        }

        for change in &manifest.changes {
            if change.notebook_id != link.cloud_notebook_id
                || handled_remote.contains(&change.note_id)
            {
                continue;
            }
            let state = self
                .store
                .note_state(&workspace_id, notebook_id, &change.note_id)?;
            if remote_change_already_applied(change, state.as_ref()) {
                continue;
            }
            if change.deleted_at.is_some() {
                if local_by_id.contains_key(change.note_id.as_str())
                    && should_propagate_remote_delete(state.as_ref(), change)
                {
                    report.remote.push(RemoteApply {
                        note_id: change.note_id.clone(),
                        kind: RemoteApplyKind::Delete,
                    });
                }
                continue;
            }
            let revision = change.revision.clone().unwrap_or_default();
            let content = self
                .client
                .get_note(
                    &token,
                    &link.workspace_id,
                    &link.cloud_notebook_id,
                    &change.note_id,
                )
                .await?;
            report.remote.push(RemoteApply {
                note_id: change.note_id.clone(),
                kind: RemoteApplyKind::Upsert {
                    filename: change.filename.clone(),
                    content,
                    revision,
                },
            });
        }

        Ok(report)
    }

    /// Commit the remote cursor only after the desktop adapter has applied all
    /// filesystem changes successfully.
    pub fn complete_sync(&self, notebook_id: &str, report: &SyncReport) -> Result<(), SyncError> {
        if report.workspace_id.is_empty() {
            return Err(SyncError::InvalidState(
                "sync report is missing its workspace".into(),
            ));
        }
        let workspace_id = &report.workspace_id;
        for remote in &report.remote {
            match &remote.kind {
                RemoteApplyKind::Delete => {
                    self.store
                        .remove_note_state(workspace_id, notebook_id, &remote.note_id)?;
                }
                RemoteApplyKind::Upsert {
                    content, revision, ..
                } => {
                    self.store.save_note_state(
                        workspace_id,
                        notebook_id,
                        &remote.note_id,
                        revision,
                        &content_hash(content),
                    )?;
                }
            }
        }
        self.store
            .finish_sync(workspace_id, notebook_id, report.cursor)
    }
}

fn content_hash(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

fn remote_change_already_applied(
    change: &crate::models::ManifestChange,
    state: Option<&crate::models::NoteState>,
) -> bool {
    change.deleted_at.is_none()
        && state.map(|state| state.revision.as_str()) == change.revision.as_deref()
}

/// Last-writer-wins tiebreaker. Returns true when the local edit should
/// overwrite the cloud version. Ties (and a missing cloud timestamp) go to
/// local so we avoid a needless download round-trip.
fn local_wins_lww(local_updated_at: i64, cloud_updated_at: Option<i64>) -> bool {
    local_updated_at >= cloud_updated_at.unwrap_or(0)
}

/// Whether a cloud tombstone should delete the local copy. Only true when the
/// local note is still at the pre-delete revision. A note that was resurrected
/// by a concurrent local edit (state advanced past the tombstone's revision)
/// must be kept -- the tombstone is stale and a later sync will reconcile once
/// the cursor moves past it.
fn should_propagate_remote_delete(
    state: Option<&crate::models::NoteState>,
    change: &crate::models::ManifestChange,
) -> bool {
    state
        .map(|s| Some(s.revision.as_str()) == change.revision.as_deref())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ManifestChange, NoteState};

    fn change(deleted_at: Option<i64>) -> ManifestChange {
        ManifestChange {
            notebook_id: "cloud_nb_1".into(),
            note_id: "abc12345".into(),
            filename: "note.md".into(),
            revision: Some("same_revision".into()),
            deleted_at,
            updated_at: None,
        }
    }

    #[test]
    fn matching_revision_only_skips_live_remote_change() {
        let state = NoteState {
            revision: "same_revision".into(),
            last_synced_hash: "hash".into(),
        };
        assert!(remote_change_already_applied(&change(None), Some(&state)));
        assert!(!remote_change_already_applied(
            &change(Some(1_700_000_000_000)),
            Some(&state)
        ));
    }

    #[test]
    fn lww_picks_local_on_later_edit_or_tie() {
        // Local edited later than the cloud upload -> local wins.
        assert!(local_wins_lww(2_000, Some(1_000)));
        // Tie goes to local to skip a redundant download.
        assert!(local_wins_lww(1_000, Some(1_000)));
        // Cloud edited later -> local loses, cloud version is downloaded.
        assert!(!local_wins_lww(1_000, Some(2_000)));
        // Missing cloud timestamp is treated as oldest, so local wins.
        assert!(local_wins_lww(1_000, None));
    }

    #[test]
    fn remote_delete_only_propagates_at_pre_delete_revision() {
        let tombstone = change(Some(1_700_000_000_000)); // revision = "same_revision"
        // Local still at the pre-delete revision -> propagate the delete.
        let pre_delete = NoteState {
            revision: "same_revision".into(),
            last_synced_hash: "hash".into(),
        };
        assert!(should_propagate_remote_delete(Some(&pre_delete), &tombstone));
        // Local was resurrected (state advanced past the tombstone) -> keep it.
        let resurrected = NoteState {
            revision: "newer_revision".into(),
            last_synced_hash: "hash".into(),
        };
        assert!(!should_propagate_remote_delete(
            Some(&resurrected),
            &tombstone
        ));
        // No state (never synced) -> keep the local note, do not delete.
        assert!(!should_propagate_remote_delete(None, &tombstone));
    }
}
