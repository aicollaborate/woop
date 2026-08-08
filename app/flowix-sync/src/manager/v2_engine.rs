use super::*;

fn verify_v2_blob(
    note_id: &str,
    expected_hash: &str,
    content: Vec<u8>,
) -> Result<Vec<u8>, SyncError> {
    let actual_hash = crate::v2::v2_content_hash(&content);
    if actual_hash != expected_hash {
        return Err(SyncError::InvalidState(format!(
            "cloud blob hash mismatch for note {note_id}: expected {expected_hash}, got {actual_hash}"
        )));
    }
    Ok(content)
}

fn v2_note_fingerprint(note: &crate::v2::V2LocalNote) -> Result<String, SyncError> {
    let mut attachments: Vec<_> = note.attachments.iter().map(|item| item.metadata.clone()).collect();
    attachments.sort();
    let canonical = serde_json::to_vec(&(crate::v2::v2_content_hash(&note.content), attachments))
        .map_err(|error| SyncError::InvalidState(format!("serialize attachment manifest: {error}")))?;
    Ok(crate::v2::v2_content_hash(&canonical))
}

impl SyncManager {
    pub fn v2_notebook(
        &self,
        notebook_id: &str,
    ) -> Result<Option<crate::v2::V2SyncedNotebook>, SyncError> {
        Ok(self
            .store
            .v2_notebooks(false)?
            .into_iter()
            .find(|notebook| notebook.notebook_id == notebook_id))
    }

    pub fn v2_enabled_notebooks(&self) -> Result<Vec<crate::v2::V2SyncedNotebook>, SyncError> {
        self.store.v2_notebooks(true)
    }

    pub fn v2_retry_delay(&self, now: i64) -> Result<Option<i64>, SyncError> {
        Ok(self
            .store
            .v2_next_retry_at()?
            .map(|retry_at| retry_at.saturating_sub(now).max(1)))
    }

    pub async fn v2_remote_notebooks(
        &self,
    ) -> Result<Vec<crate::models::CloudNotebook>, SyncError> {
        let token = self.access_token().await?;
        let first = self.client.v2_bootstrap(&token).await;
        let bootstrap = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token().await?;
            self.client.v2_bootstrap(&refreshed).await?
        } else {
            first?
        };
        let enabled: HashSet<String> = self
            .store
            .v2_notebooks(true)?
            .into_iter()
            .map(|notebook| notebook.notebook_id)
            .collect();
        Ok(bootstrap
            .notebooks
            .into_iter()
            .filter(|notebook| !notebook.deleted)
            .map(|notebook| crate::models::CloudNotebook {
                synced: enabled.contains(&notebook.id),
                id: notebook.id,
                name: notebook.name,
                icon: notebook.icon,
                sort_order: notebook.sort_order,
                created_at: notebook.created_at,
                updated_at: notebook.updated_at,
            })
            .collect())
    }
    pub fn record_v2_local_change(
        &self,
        notebook_id: &str,
        note_id: &str,
        operation: LocalChangeKind,
        fingerprint: &str,
    ) -> Result<(), SyncError> {
        if !self
            .store
            .v2_notebooks(true)?
            .iter()
            .any(|notebook| notebook.notebook_id == notebook_id)
        {
            return Ok(());
        }
        self.store.mark_v2_dirty(
            V2EntityType::Note,
            note_id,
            Some(notebook_id),
            match operation {
                LocalChangeKind::Put => V2OperationKind::Put,
                LocalChangeKind::Delete => V2OperationKind::Delete,
            },
            fingerprint,
            Utc::now().timestamp_millis(),
        )?;
        Ok(())
    }

    pub fn has_pending_v2_note_change(&self, note_id: &str) -> Result<bool, SyncError> {
        Ok(self
            .store
            .v2_dirty_entities()?
            .into_iter()
            .any(|dirty| dirty.entity_type == V2EntityType::Note && dirty.entity_id == note_id))
    }

    pub fn set_v2_notebook_enabled(
        &self,
        notebook: &V2LocalNotebook,
        enabled: bool,
    ) -> Result<crate::v2::V2SyncedNotebook, SyncError> {
        let state = self.store.set_v2_notebook(&notebook.id, enabled)?;
        if enabled {
            self.store.set_enabled(true)?;
            self.store.mark_v2_dirty(
                V2EntityType::Notebook,
                &notebook.id,
                Some(&notebook.id),
                V2OperationKind::Put,
                &crate::v2::v2_notebook_metadata_hash(
                    &notebook.name,
                    notebook.icon.as_deref(),
                    notebook.sort_order,
                ),
                Utc::now().timestamp_millis(),
            )?;
        }
        Ok(state)
    }

    pub fn record_v2_notebook_delete(&self, notebook_id: &str) -> Result<(), SyncError> {
        let Some(notebook) = self.v2_notebook(notebook_id)? else {
            return Ok(());
        };
        if !notebook.enabled {
            return Ok(());
        }
        self.store.mark_v2_dirty(
            V2EntityType::Notebook,
            notebook_id,
            Some(notebook_id),
            V2OperationKind::Delete,
            "deleted",
            Utc::now().timestamp_millis(),
        )?;
        Ok(())
    }

    pub fn record_v2_notebook_change(&self, notebook: &V2LocalNotebook) -> Result<bool, SyncError> {
        let Some(state) = self.v2_notebook(&notebook.id)? else {
            return Ok(false);
        };
        if !state.enabled {
            return Ok(false);
        }
        self.store.mark_v2_dirty(
            V2EntityType::Notebook,
            &notebook.id,
            Some(&notebook.id),
            V2OperationKind::Put,
            &crate::v2::v2_notebook_metadata_hash(
                &notebook.name,
                notebook.icon.as_deref(),
                notebook.sort_order,
            ),
            Utc::now().timestamp_millis(),
        )?;
        Ok(true)
    }

    pub async fn sync_v2_account(
        &self,
        notebooks: Vec<V2LocalNotebook>,
        notes: Vec<V2LocalNote>,
    ) -> Result<V2AccountSyncReport, SyncError> {
        let _guard = self.account_sync_lock.lock().await;
        if !self.store.enabled()? {
            return Err(SyncError::Disabled);
        }
        self.store
            .v2_account()?
            .ok_or(SyncError::NotAuthenticated)?;
        let first_token = self.access_token().await?;
        let first = self
            .sync_v2_account_once(&first_token, &notebooks, &notes)
            .await;
        if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token().await?;
            return self
                .sync_v2_account_once(&refreshed, &notebooks, &notes)
                .await;
        }
        first
    }

    pub fn complete_v2_account_sync(&self, report: &V2AccountSyncReport) -> Result<(), SyncError> {
        self.store.commit_v2_sync_report(
            &report.remote,
            report.cursor,
            &report.bootstrapped_notebooks,
            Utc::now().timestamp_millis(),
        )
    }

    async fn sync_v2_account_once(
        &self,
        access_token: &str,
        notebooks: &[V2LocalNotebook],
        notes: &[V2LocalNote],
    ) -> Result<V2AccountSyncReport, SyncError> {
        let started_at = Utc::now().timestamp_millis();
        let enabled_notebooks = self.store.v2_notebooks(true)?;
        let enabled_ids: HashSet<&str> = enabled_notebooks
            .iter()
            .map(|notebook| notebook.notebook_id.as_str())
            .collect();
        self.reconcile_v2_snapshot(&enabled_ids, notebooks, notes)?;
        self.freeze_new_v2_operations(access_token, notebooks, notes)
            .await?;

        let due = self.store.v2_inflight_due(Utc::now().timestamp_millis())?;
        let (uploaded, deleted) = self.push_v2_inflight(access_token, &due).await?;

        let bootstrap_required = enabled_notebooks
            .iter()
            .any(|notebook| notebook.bootstrap_required);
        let cursor = self.store.v2_cursor()?;
        let (remote, next_cursor, head_cursor, bootstrapped_notebooks) = if bootstrap_required {
            let bootstrap = self.client.v2_bootstrap(access_token).await?;
            let remote = self
                .remote_from_bootstrap(access_token, &enabled_ids, &bootstrap)
                .await?;
            (
                remote,
                bootstrap.cursor,
                bootstrap.cursor,
                enabled_notebooks
                    .iter()
                    .map(|notebook| notebook.notebook_id.clone())
                    .collect(),
            )
        } else {
            match self.pull_v2_changes(access_token, cursor).await {
                Ok(result) => (result.0, result.1, result.2, Vec::new()),
                Err(SyncError::Api {
                    status: 410, code, ..
                }) if code == "CURSOR_EXPIRED" => {
                    let bootstrap = self.client.v2_bootstrap(access_token).await?;
                    let remote = self
                        .remote_from_bootstrap(access_token, &enabled_ids, &bootstrap)
                        .await?;
                    (
                        remote,
                        bootstrap.cursor,
                        bootstrap.cursor,
                        enabled_notebooks
                            .iter()
                            .map(|notebook| notebook.notebook_id.clone())
                            .collect(),
                    )
                }
                Err(error) => return Err(error),
            }
        };

        Ok(V2AccountSyncReport {
            started_at,
            cursor: next_cursor,
            head_cursor,
            uploaded,
            deleted,
            remote,
            bootstrapped_notebooks,
        })
    }

    fn reconcile_v2_snapshot(
        &self,
        enabled_ids: &HashSet<&str>,
        notebooks: &[V2LocalNotebook],
        notes: &[V2LocalNote],
    ) -> Result<(), SyncError> {
        let now = Utc::now().timestamp_millis();
        for notebook in notebooks
            .iter()
            .filter(|notebook| enabled_ids.contains(notebook.id.as_str()))
        {
            let fingerprint = crate::v2::v2_notebook_metadata_hash(
                &notebook.name,
                notebook.icon.as_deref(),
                notebook.sort_order,
            );
            let current = self.store.v2_notebook_state(&notebook.id)?;
            if current
                .as_ref()
                .is_none_or(|state| state.deleted || state.metadata_hash != fingerprint)
            {
                self.store.mark_v2_dirty(
                    V2EntityType::Notebook,
                    &notebook.id,
                    Some(&notebook.id),
                    V2OperationKind::Put,
                    &fingerprint,
                    now,
                )?;
            }
        }
        for note in notes
            .iter()
            .filter(|note| enabled_ids.contains(note.notebook_id.as_str()))
        {
            let fingerprint = v2_note_fingerprint(note)?;
            let content_hash = crate::v2::v2_content_hash(&note.content);
            let current = self.store.v2_note_state(&note.id)?;
            if current.as_ref().is_none_or(|state| {
                state.deleted
                    || state.notebook_id != note.notebook_id
                    || state.filename != note.filename
                    || state.content_hash.as_deref() != Some(content_hash.as_str())
                    || state.attachments != note.attachments.iter().map(|item| item.metadata.clone()).collect::<Vec<_>>()
            }) {
                self.store.mark_v2_dirty(
                    V2EntityType::Note,
                    &note.id,
                    Some(&note.notebook_id),
                    V2OperationKind::Put,
                    &fingerprint,
                    now,
                )?;
            }
        }
        Ok(())
    }

    async fn freeze_new_v2_operations(
        &self,
        access_token: &str,
        notebooks: &[V2LocalNotebook],
        notes: &[V2LocalNote],
    ) -> Result<(), SyncError> {
        let notebooks_by_id: HashMap<&str, &V2LocalNotebook> = notebooks
            .iter()
            .map(|item| (item.id.as_str(), item))
            .collect();
        let notes_by_id: HashMap<&str, &V2LocalNote> =
            notes.iter().map(|item| (item.id.as_str(), item)).collect();
        for dirty in self.store.v2_dirty_entities()? {
            if self
                .store
                .v2_inflight_for_generation(dirty.entity_type, &dirty.entity_id, dirty.generation)?
                .is_some()
            {
                continue;
            }
            let operation_id = crate::v2::new_v2_operation_id();
            let base_revision = match dirty.entity_type {
                V2EntityType::Notebook => self
                    .store
                    .v2_notebook_state(&dirty.entity_id)?
                    .map(|state| state.revision),
                V2EntityType::Note => self
                    .store
                    .v2_note_state(&dirty.entity_id)?
                    .map(|state| state.revision),
            };
            let operation = match (dirty.entity_type, dirty.operation_kind) {
                (V2EntityType::Notebook, V2OperationKind::Put) => {
                    let Some(notebook) = notebooks_by_id.get(dirty.entity_id.as_str()) else {
                        continue;
                    };
                    V2PushOperation::NotebookPut {
                        operation_id: operation_id.clone(),
                        base_revision: base_revision.clone(),
                        notebook: crate::v2::V2NotebookPut {
                            id: notebook.id.clone(),
                            name: notebook.name.clone(),
                            icon: notebook.icon.clone(),
                            sort_order: notebook.sort_order,
                        },
                    }
                }
                (V2EntityType::Notebook, V2OperationKind::Delete) => {
                    V2PushOperation::NotebookDelete {
                        operation_id: operation_id.clone(),
                        base_revision: base_revision.clone(),
                        notebook_id: dirty.entity_id.clone(),
                    }
                }
                (V2EntityType::Note, V2OperationKind::Put) => {
                    let Some(note) = notes_by_id.get(dirty.entity_id.as_str()) else {
                        continue;
                    };
                    let content_hash = crate::v2::v2_content_hash(&note.content);
                    let reservation = self
                        .client
                        .v2_reserve_blob(
                            access_token,
                            &content_hash,
                            i64::try_from(note.content.len()).map_err(|_| {
                                SyncError::InvalidState("memo content length exceeds i64".into())
                            })?,
                            "note",
                        )
                        .await?;
                    self.client
                        .v2_upload_blob(
                            access_token,
                            &reservation.upload.path,
                            note.content.clone(),
                        )
                        .await?;
                    for attachment in &note.attachments {
                        let reservation = self.client.v2_reserve_blob(
                            access_token,
                            &attachment.metadata.content_hash,
                            attachment.metadata.size_bytes,
                            "attachment",
                        ).await?;
                        self.client.v2_upload_blob(
                            access_token,
                            &reservation.upload.path,
                            attachment.content.clone(),
                        ).await?;
                    }
                    V2PushOperation::NotePut {
                        operation_id: operation_id.clone(),
                        base_revision: base_revision.clone(),
                        note: crate::v2::V2NotePut {
                            id: note.id.clone(),
                            notebook_id: note.notebook_id.clone(),
                            filename: note.filename.clone(),
                            content_hash,
                            size_bytes: i64::try_from(note.content.len()).map_err(|_| {
                                SyncError::InvalidState("memo content length exceeds i64".into())
                            })?,
                            attachments: note.attachments.iter().map(|item| item.metadata.clone()).collect(),
                        },
                    }
                }
                (V2EntityType::Note, V2OperationKind::Delete) => V2PushOperation::NoteDelete {
                    operation_id: operation_id.clone(),
                    base_revision: base_revision.clone(),
                    note_id: dirty.entity_id.clone(),
                },
            };
            let payload = serde_json::to_string(&operation).map_err(|error| {
                SyncError::InvalidState(format!("serialize v2 operation: {error}"))
            })?;
            match self.store.freeze_v2_operation(V2FreezeOperation {
                operation_id: &operation_id,
                entity_type: dirty.entity_type,
                entity_id: &dirty.entity_id,
                generation: dirty.generation,
                operation_kind: dirty.operation_kind,
                base_revision: base_revision.as_deref(),
                payload_json: &payload,
            }) {
                Ok(_) => {}
                Err(SyncError::InvalidState(message))
                    if message.starts_with("dirty generation changed before operation freeze") => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    async fn push_v2_inflight(
        &self,
        access_token: &str,
        due: &[crate::v2::V2InflightOperation],
    ) -> Result<(usize, usize), SyncError> {
        let mut uploaded = 0;
        let mut deleted = 0;
        for batch in due.chunks(100) {
            let operations = batch
                .iter()
                .map(|item| {
                    serde_json::from_str::<V2PushOperation>(&item.payload_json).map_err(|error| {
                        SyncError::InvalidState(format!("invalid frozen v2 operation: {error}"))
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            let result = match self.client.v2_push(access_token, &operations).await {
                Ok(result) => result,
                Err(error) => {
                    for item in batch {
                        self.store.defer_v2_operation(
                            &item.operation_id,
                            Utc::now().timestamp_millis(),
                            &error.to_string(),
                        )?;
                    }
                    return Err(error);
                }
            };
            let by_id: HashMap<&str, &crate::v2::V2OperationResult> = result
                .results
                .iter()
                .map(|item| (item.operation_id.as_str(), item))
                .collect();
            for item in batch {
                let response = by_id.get(item.operation_id.as_str()).ok_or_else(|| {
                    SyncError::InvalidState(format!(
                        "cloud omitted operation result {}",
                        item.operation_id
                    ))
                })?;
                if response.ok {
                    self.store.acknowledge_v2_operation(
                        &item.operation_id,
                        item.entity_type,
                        &item.entity_id,
                        item.generation,
                    )?;
                    match item.operation_kind {
                        V2OperationKind::Put => uploaded += 1,
                        V2OperationKind::Delete => deleted += 1,
                    }
                } else {
                    let message = response
                        .error
                        .as_ref()
                        .map(|error| format!("{}: {}", error.code, error.message))
                        .unwrap_or_else(|| {
                            format!("operation failed with status {}", response.status)
                        });
                    self.store.defer_v2_operation(
                        &item.operation_id,
                        Utc::now().timestamp_millis(),
                        &message,
                    )?;
                }
            }
        }
        Ok((uploaded, deleted))
    }

    async fn pull_v2_changes(
        &self,
        access_token: &str,
        cursor: i64,
    ) -> Result<(Vec<V2RemoteApply>, i64, i64), SyncError> {
        let enabled: HashSet<String> = self
            .store
            .v2_notebooks(true)?
            .into_iter()
            .map(|notebook| notebook.notebook_id)
            .collect();
        let mut next_cursor = cursor;
        let mut latest = HashMap::<(String, String), V2Change>::new();
        let head_cursor = loop {
            let page = self
                .client
                .v2_changes(access_token, next_cursor, 1_000)
                .await?;
            let page_head_cursor = page.head_cursor;
            let page_cursor = page.cursor;
            let has_more = page.has_more;
            for change in page.changes {
                latest.insert(
                    (change.entity_type.clone(), change.entity_id.clone()),
                    change,
                );
            }
            if page_cursor < next_cursor || (has_more && page_cursor == next_cursor) {
                return Err(SyncError::InvalidState(
                    "cloud v2 changes cursor did not advance".into(),
                ));
            }
            next_cursor = page_cursor;
            if !has_more {
                break page_head_cursor;
            }
        };
        let mut changes: Vec<_> = latest.into_values().collect();
        changes.sort_by_key(|change| change.sync_seq);
        let mut remote = Vec::new();
        for change in changes {
            if change.entity_type == "notebook" {
                if !enabled.contains(&change.entity_id) {
                    continue;
                }
                remote.push(V2RemoteApply::Notebook {
                    notebook_id: change.entity_id,
                    name: change.name,
                    icon: change.icon,
                    sort_order: change.sort_order,
                    revision: change.revision,
                    sync_seq: change.sync_seq,
                    deleted: change.deleted,
                });
            } else if change.entity_type == "note" {
                let Some(notebook_id) = change.notebook_id else {
                    return Err(SyncError::InvalidState(
                        "cloud note change has no notebook".into(),
                    ));
                };
                if !enabled.contains(&notebook_id) {
                    continue;
                }
                let filename = change.filename.ok_or_else(|| {
                    SyncError::InvalidState("cloud note change has no filename".into())
                })?;
                let content = match (&change.content_hash, change.deleted) {
                    (Some(hash), false) => Some(
                        self.download_verified_v2_blob(access_token, &change.entity_id, hash)
                            .await?,
                    ),
                    _ => None,
                };
                let attachments = if change.deleted { Vec::new() } else {
                    let mut values = Vec::new();
                    for attachment in &change.attachments {
                        values.push(crate::v2::V2RemoteAttachment {
                            content: self.download_verified_v2_blob(access_token, &change.entity_id, &attachment.content_hash).await?,
                            metadata: attachment.clone(),
                        });
                    }
                    values
                };
                remote.push(V2RemoteApply::Note {
                    note_id: change.entity_id,
                    notebook_id,
                    filename,
                    content_hash: change.content_hash,
                    content,
                    revision: change.revision,
                    sync_seq: change.sync_seq,
                    deleted: change.deleted,
                    attachments,
                });
            } else {
                return Err(SyncError::InvalidState(format!(
                    "unknown cloud v2 entity type {}",
                    change.entity_type
                )));
            }
        }
        Ok((remote, next_cursor, head_cursor))
    }

    async fn remote_from_bootstrap(
        &self,
        access_token: &str,
        enabled: &HashSet<&str>,
        bootstrap: &V2Bootstrap,
    ) -> Result<Vec<V2RemoteApply>, SyncError> {
        let mut remote = Vec::new();
        for notebook in &bootstrap.notebooks {
            if enabled.contains(notebook.id.as_str()) {
                remote.push(V2RemoteApply::Notebook {
                    notebook_id: notebook.id.clone(),
                    name: Some(notebook.name.clone()),
                    icon: notebook.icon.clone(),
                    sort_order: Some(notebook.sort_order),
                    revision: notebook.revision.clone(),
                    sync_seq: notebook.sync_seq,
                    deleted: notebook.deleted,
                });
            }
        }
        for note in &bootstrap.notes {
            if !enabled.contains(note.notebook_id.as_str()) {
                continue;
            }
            let content = match (&note.content_hash, note.deleted) {
                (Some(hash), false) => Some(
                    self.download_verified_v2_blob(access_token, &note.id, hash)
                        .await?,
                ),
                _ => None,
            };
            let mut attachments = Vec::new();
            if !note.deleted {
                for attachment in &note.attachments {
                    attachments.push(crate::v2::V2RemoteAttachment {
                        content: self.download_verified_v2_blob(access_token, &note.id, &attachment.content_hash).await?,
                        metadata: attachment.clone(),
                    });
                }
            }
            remote.push(V2RemoteApply::Note {
                note_id: note.id.clone(),
                notebook_id: note.notebook_id.clone(),
                filename: note.filename.clone(),
                content_hash: note.content_hash.clone(),
                content,
                revision: note.revision.clone(),
                sync_seq: note.sync_seq,
                deleted: note.deleted,
                attachments,
            });
        }
        remote.sort_by_key(|change| match change {
            V2RemoteApply::Notebook { sync_seq, .. } | V2RemoteApply::Note { sync_seq, .. } => {
                *sync_seq
            }
        });
        Ok(remote)
    }

    async fn download_verified_v2_blob(
        &self,
        access_token: &str,
        note_id: &str,
        expected_hash: &str,
    ) -> Result<Vec<u8>, SyncError> {
        let content = self
            .client
            .v2_download_blob(access_token, expected_hash)
            .await?;
        verify_v2_blob(note_id, expected_hash, content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_reconciliation_only_advances_generation_for_real_changes() {
        let temp = tempfile::tempdir().unwrap();
        let manager =
            SyncManager::new("https://cloud.example.test", temp.path().join("sync.db")).unwrap();
        let notebook = V2LocalNotebook {
            id: "nb_0198f1aa-7b22-7def-8123-0123456789ab".into(),
            name: "Notes".into(),
            icon: None,
            sort_order: 0,
        };
        manager.set_v2_notebook_enabled(&notebook, true).unwrap();
        let note = V2LocalNote {
            id: "abc12345".into(),
            notebook_id: notebook.id.clone(),
            filename: "abc12345.md".into(),
            content: b"first".to_vec(),
            attachments: Vec::new(),
        };
        let enabled = HashSet::from([notebook.id.as_str()]);
        manager
            .reconcile_v2_snapshot(
                &enabled,
                std::slice::from_ref(&notebook),
                std::slice::from_ref(&note),
            )
            .unwrap();
        let first = manager.store.v2_dirty_entities().unwrap();
        manager
            .reconcile_v2_snapshot(
                &enabled,
                std::slice::from_ref(&notebook),
                std::slice::from_ref(&note),
            )
            .unwrap();
        assert_eq!(manager.store.v2_dirty_entities().unwrap(), first);

        let changed = V2LocalNote {
            content: b"second".to_vec(),
            ..note
        };
        manager
            .reconcile_v2_snapshot(
                &enabled,
                std::slice::from_ref(&notebook),
                std::slice::from_ref(&changed),
            )
            .unwrap();
        let note_dirty = manager
            .store
            .v2_dirty_entities()
            .unwrap()
            .into_iter()
            .find(|dirty| dirty.entity_type == V2EntityType::Note)
            .unwrap();
        assert_eq!(note_dirty.generation, 2);
    }

    #[test]
    fn missing_local_file_does_not_infer_a_cloud_delete() {
        let temp = tempfile::tempdir().unwrap();
        let manager =
            SyncManager::new("https://cloud.example.test", temp.path().join("sync.db")).unwrap();
        let notebook = V2LocalNotebook {
            id: "nb_0198f1aa-7b22-7def-8123-0123456789ab".into(),
            name: "Notes".into(),
            icon: None,
            sort_order: 0,
        };
        manager.set_v2_notebook_enabled(&notebook, true).unwrap();
        manager
            .store
            .save_v2_note_state(&crate::v2::V2NoteState {
                note_id: "abc12345".into(),
                notebook_id: notebook.id.clone(),
                revision: "rev_2".into(),
                content_hash: Some(crate::v2::v2_content_hash(b"remote")),
                filename: "abc12345.md".into(),
                deleted: false,
                last_seq: 2,
                attachments: Vec::new(),
            })
            .unwrap();
        let enabled = HashSet::from([notebook.id.as_str()]);

        manager
            .reconcile_v2_snapshot(&enabled, std::slice::from_ref(&notebook), &[])
            .unwrap();

        assert!(manager
            .store
            .v2_dirty_entities()
            .unwrap()
            .iter()
            .all(|dirty| dirty.entity_type != V2EntityType::Note));
        assert!(
            !manager
                .store
                .v2_note_state("abc12345")
                .unwrap()
                .unwrap()
                .deleted
        );
    }

    #[test]
    fn account_reconciliation_tracks_multiple_notebooks() {
        let temp = tempfile::tempdir().unwrap();
        let manager =
            SyncManager::new("https://cloud.example.test", temp.path().join("sync.db")).unwrap();
        let notebooks = [
            V2LocalNotebook {
                id: "nb_a".into(),
                name: "A".into(),
                icon: None,
                sort_order: 0,
            },
            V2LocalNotebook {
                id: "nb_b".into(),
                name: "B".into(),
                icon: None,
                sort_order: 10,
            },
        ];
        for notebook in &notebooks {
            manager.set_v2_notebook_enabled(notebook, true).unwrap();
        }
        let notes = [
            V2LocalNote {
                id: "memo_a".into(),
                notebook_id: "nb_a".into(),
                filename: "a.md".into(),
                content: b"a".to_vec(),
                attachments: Vec::new(),
            },
            V2LocalNote {
                id: "memo_b".into(),
                notebook_id: "nb_b".into(),
                filename: "b.md".into(),
                content: b"b".to_vec(),
                attachments: Vec::new(),
            },
        ];
        let enabled = HashSet::from(["nb_a", "nb_b"]);

        manager
            .reconcile_v2_snapshot(&enabled, &notebooks, &notes)
            .unwrap();

        let dirty = manager.store.v2_dirty_entities().unwrap();
        assert_eq!(
            dirty
                .iter()
                .filter(|item| item.entity_type == V2EntityType::Notebook)
                .count(),
            2
        );
        assert_eq!(
            dirty
                .iter()
                .filter(|item| item.entity_type == V2EntityType::Note)
                .count(),
            2
        );
    }

    #[test]
    fn notebook_delete_can_freeze_after_local_registry_removal() {
        let temp = tempfile::tempdir().unwrap();
        let manager =
            SyncManager::new("https://cloud.example.test", temp.path().join("sync.db")).unwrap();
        let notebook = V2LocalNotebook {
            id: "nb_deleted".into(),
            name: "Deleted".into(),
            icon: None,
            sort_order: 0,
        };
        manager.set_v2_notebook_enabled(&notebook, true).unwrap();
        manager.record_v2_notebook_delete(&notebook.id).unwrap();

        let dirty = manager
            .store
            .v2_dirty_entities()
            .unwrap()
            .into_iter()
            .find(|item| {
                item.entity_type == V2EntityType::Notebook
                    && item.entity_id == notebook.id
                    && item.operation_kind == V2OperationKind::Delete
            })
            .unwrap();
        let operation_id = crate::v2::new_v2_operation_id();
        let payload = serde_json::to_string(&V2PushOperation::NotebookDelete {
            operation_id: operation_id.clone(),
            base_revision: None,
            notebook_id: notebook.id.clone(),
        })
        .unwrap();
        manager
            .store
            .freeze_v2_operation(V2FreezeOperation {
                operation_id: &operation_id,
                entity_type: dirty.entity_type,
                entity_id: &dirty.entity_id,
                generation: dirty.generation,
                operation_kind: dirty.operation_kind,
                base_revision: None,
                payload_json: &payload,
            })
            .unwrap();

        let operations = manager.store.v2_inflight_due(0).unwrap();
        assert!(operations.iter().any(|operation| {
            operation.entity_type == V2EntityType::Notebook
                && operation.entity_id == notebook.id
                && operation.operation_kind == V2OperationKind::Delete
        }));
    }

    #[test]
    fn downloaded_blob_hash_is_verified() {
        let content = b"verified".to_vec();
        let hash = crate::v2::v2_content_hash(&content);
        assert_eq!(
            verify_v2_blob("memo", &hash, content.clone()).unwrap(),
            content
        );
        assert!(verify_v2_blob("memo", &hash, b"tampered".to_vec()).is_err());
    }
}
