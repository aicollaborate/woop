use super::*;

impl SyncManager {
    pub async fn refresh_membership(&self) -> Result<CloudMembership, SyncError> {
        let account = self.store.account()?.ok_or(SyncError::NotAuthenticated)?;
        let token = self.access_token().await?;
        let first = self
            .client
            .entitlements(&token, &account.workspace.id)
            .await;
        let entitlement = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token().await?;
            self.client
                .entitlements(&refreshed, &account.workspace.id)
                .await?
        } else {
            first?
        };
        let membership: CloudMembership = entitlement.into();
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
        let mut notebooks = self.authenticated_notebooks(&account.workspace.id).await?;
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
        let remote_exists = self
            .authenticated_notebooks(&account.workspace.id)
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
        let first = self
            .client
            .checkout(&token, &account.workspace.id, product_id, idempotency_key)
            .await;
        if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token().await?;
            return self
                .client
                .checkout(
                    &refreshed,
                    &account.workspace.id,
                    product_id,
                    idempotency_key,
                )
                .await;
        }
        first
    }

    pub async fn set_notebook_enabled(
        &self,
        notebook_id: &str,
        notebook_name: &str,
        enabled: bool,
    ) -> Result<NotebookLink, SyncError> {
        let account = self.store.account()?.ok_or(SyncError::NotAuthenticated)?;
        if enabled {
            let cloud_notebook_id = if let Some(link) = self
                .store
                .notebook_link(&account.workspace.id, notebook_id)?
            {
                link.cloud_notebook_id
            } else {
                let mut matched = None;
                for notebook in self
                    .authenticated_notebooks(&account.workspace.id)
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
            self.authenticated_create_notebook(
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

    async fn authenticated_notebooks(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<crate::models::CloudNotebook>, SyncError> {
        let token = self.access_token().await?;
        let first = self.client.notebooks(&token, workspace_id).await;
        if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token().await?;
            return self.client.notebooks(&refreshed, workspace_id).await;
        }
        first
    }

    async fn authenticated_create_notebook(
        &self,
        workspace_id: &str,
        notebook_id: &str,
        name: &str,
    ) -> Result<(), SyncError> {
        let token = self.access_token().await?;
        let first = self
            .client
            .create_notebook(&token, workspace_id, notebook_id, name)
            .await;
        if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token().await?;
            return self
                .client
                .create_notebook(&refreshed, workspace_id, notebook_id, name)
                .await;
        }
        first
    }
}
