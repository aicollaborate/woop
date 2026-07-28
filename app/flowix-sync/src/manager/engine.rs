use super::*;

impl SyncManager {
    pub async fn sync_notebook(
        &self,
        notebook_id: &str,
        local_notes: Vec<LocalNote>,
    ) -> Result<SyncReport, SyncError> {
        let first = self
            .sync_notebook_once(notebook_id, local_notes.clone())
            .await;
        if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            self.force_refresh_access_token().await?;
            return self.sync_notebook_once(notebook_id, local_notes).await;
        }
        first
    }

    async fn sync_notebook_once(
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
        let started_at = Utc::now().timestamp_millis();
        let pending_entries = self.store.outbox(&workspace_id, notebook_id)?;
        let outbox_through_id = pending_entries
            .iter()
            .map(|entry| entry.id)
            .max()
            .unwrap_or(0);
        let pending_by_id: HashMap<_, _> = pending_entries
            .into_iter()
            .map(|entry| (entry.note_id.clone(), entry))
            .collect();
        let device_id = self.store.device_id()?;
        let mut manifest = self
            .client
            .manifest(&token, &link.workspace_id, link.last_cursor)
            .await?;
        if let Some(server_time) = manifest.server_time {
            self.store
                .observe_server_time(server_time, Utc::now().timestamp_millis())?;
        }
        while manifest.has_more {
            let next = self
                .client
                .manifest(&token, &link.workspace_id, manifest.cursor)
                .await?;
            if let Some(server_time) = next.server_time {
                self.store
                    .observe_server_time(server_time, Utc::now().timestamp_millis())?;
            }
            if next.cursor <= manifest.cursor {
                return Err(SyncError::InvalidState(
                    "cloud manifest cursor did not advance".into(),
                ));
            }
            manifest.cursor = next.cursor;
            manifest.has_more = next.has_more;
            manifest.changes.extend(next.changes);
        }
        self.store.observe_logical_counter(
            manifest
                .changes
                .iter()
                .map(|change| change.logical_counter)
                .max()
                .unwrap_or(0),
        )?;
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
            started_at,
            outbox_through_id,
            cursor: manifest.cursor,
            ..SyncReport::default()
        };

        for note in &local_notes {
            let hash = content_hash(&note.content);
            let local_version = pending_by_id
                .get(&note.id)
                .map(OutboxEntry::version)
                .unwrap_or_else(|| ChangeVersion {
                    modified_at: note.updated_at,
                    logical_counter: 0,
                    device_id: device_id.clone(),
                });
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
                        if local_wins_lww(&local_version, &remote_version(change)) {
                            // The local edit happened after the cloud tombstone:
                            // resurrect the note with no base revision.
                            let put = self
                                .client
                                .put_note(PutNoteRequest {
                                    access_token: &token,
                                    workspace_id: &link.workspace_id,
                                    notebook_id: &link.cloud_notebook_id,
                                    note_id: &note.id,
                                    filename: &note.filename,
                                    content: &note.content,
                                    base_revision: None,
                                    change_version: &local_version,
                                })
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
                                kind: RemoteApplyKind::Delete,
                            });
                        }
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
                    // Last-writer-wins uses a stable version tuple so every
                    // device makes the same decision when wall times tie.
                    if local_wins_lww(&local_version, &remote_version(change)) {
                        let put = self
                            .client
                            .put_note(PutNoteRequest {
                                access_token: &token,
                                workspace_id: &link.workspace_id,
                                notebook_id: &link.cloud_notebook_id,
                                note_id: &note.id,
                                filename: &note.filename,
                                content: &note.content,
                                base_revision: change.revision.as_deref(),
                                change_version: &local_version,
                            })
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
                    .put_note(PutNoteRequest {
                        access_token: &token,
                        workspace_id: &link.workspace_id,
                        notebook_id: &link.cloud_notebook_id,
                        note_id: &note.id,
                        filename: &note.filename,
                        content: &note.content,
                        base_revision: state.as_ref().map(|state| state.revision.as_str()),
                        change_version: &local_version,
                    })
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
                    let local_delete_at = pending_by_id
                        .get(&note_id)
                        .filter(|entry| entry.operation == LocalChangeKind::Delete)
                        .map(OutboxEntry::version);
                    if local_delete_at
                        .as_ref()
                        .is_some_and(|version| local_wins_lww(version, &remote_version(change)))
                    {
                        self.client
                            .delete_note(
                                &token,
                                &link.workspace_id,
                                &link.cloud_notebook_id,
                                &note_id,
                                change.revision.as_deref(),
                                local_delete_at.as_ref().expect("checked above"),
                            )
                            .await?;
                        self.store
                            .remove_note_state(&workspace_id, notebook_id, &note_id)?;
                        report.deleted += 1;
                    } else {
                        // Without a durable local delete timestamp, prefer the
                        // cloud edit so bootstrap and recovered devices do not
                        // turn an empty folder into a remote mass deletion.
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
                    }
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
                    &pending_by_id
                        .get(&note_id)
                        .map(OutboxEntry::version)
                        .unwrap_or_else(|| ChangeVersion {
                            modified_at: started_at,
                            logical_counter: 0,
                            device_id: device_id.clone(),
                        }),
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
            .finish_sync(workspace_id, notebook_id, report.cursor)?;
        self.store
            .clear_outbox_through(workspace_id, notebook_id, report.outbox_through_id)
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
fn remote_version(change: &crate::models::ManifestChange) -> ChangeVersion {
    ChangeVersion {
        modified_at: change
            .modified_at
            .or(change.deleted_at)
            .or(change.updated_at)
            .unwrap_or(0),
        logical_counter: change.logical_counter,
        device_id: change
            .device_id
            .clone()
            .unwrap_or_else(|| "server".to_string()),
    }
}

fn local_wins_lww(local: &ChangeVersion, cloud: &ChangeVersion) -> bool {
    (
        local.modified_at,
        local.logical_counter,
        local.device_id.as_str(),
    ) >= (
        cloud.modified_at,
        cloud.logical_counter,
        cloud.device_id.as_str(),
    )
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
            modified_at: None,
            logical_counter: 0,
            device_id: None,
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
        let version = |modified_at, logical_counter, device_id: &str| ChangeVersion {
            modified_at,
            logical_counter,
            device_id: device_id.to_string(),
        };
        assert!(local_wins_lww(
            &version(2_000, 0, "device-a"),
            &version(1_000, 10, "device-z")
        ));
        assert!(local_wins_lww(
            &version(1_000, 2, "device-a"),
            &version(1_000, 1, "device-z")
        ));
        assert!(local_wins_lww(
            &version(1_000, 1, "device-z"),
            &version(1_000, 1, "device-a")
        ));
        assert!(!local_wins_lww(
            &version(1_000, 1, "device-a"),
            &version(1_000, 1, "device-z")
        ));
    }

    #[test]
    fn remote_delete_only_propagates_at_pre_delete_revision() {
        let tombstone = change(Some(1_700_000_000_000)); // revision = "same_revision"
                                                         // Local still at the pre-delete revision -> propagate the delete.
        let pre_delete = NoteState {
            revision: "same_revision".into(),
            last_synced_hash: "hash".into(),
        };
        assert!(should_propagate_remote_delete(
            Some(&pre_delete),
            &tombstone
        ));
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
