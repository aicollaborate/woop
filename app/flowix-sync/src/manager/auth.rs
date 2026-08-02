use super::*;

impl SyncManager {
    pub async fn register(
        &self,
        email: &str,
        password: &str,
        display_name: &str,
    ) -> Result<AuthOutcome, SyncError> {
        let auth = self.client.register(email, password, display_name).await?;
        self.accept_auth(
            V2CloudAccount {
                user: auth.user,
                protocol_epoch: crate::v2::PROTOCOL_EPOCH,
            },
            auth.session.into(),
        )
        .await
    }

    pub async fn login(&self, email: &str, password: &str) -> Result<AuthOutcome, SyncError> {
        let auth = self.client.login(email, password).await?;
        let runtime: RuntimeSession = auth.session.into();
        let me = self.client.me(&runtime.access_token).await?;
        self.accept_auth(
            V2CloudAccount {
                user: me.user,
                protocol_epoch: crate::v2::PROTOCOL_EPOCH,
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
        self.accept_auth(
            V2CloudAccount {
                user: me.user,
                protocol_epoch: crate::v2::PROTOCOL_EPOCH,
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
        let first = self.client.apple_link(&access_token, authorization).await;
        if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token().await?;
            self.client.apple_link(&refreshed, authorization).await?;
        } else {
            first?;
        }
        self.state()
    }

    pub async fn restore(&self, refresh_token: &str) -> Result<AuthOutcome, SyncError> {
        let account = self
            .store
            .v2_account()?
            .ok_or(SyncError::NotAuthenticated)?;
        let refreshed = self.client.refresh(refresh_token).await?;
        self.accept_auth(account, refreshed.session.into()).await
    }

    async fn accept_auth(
        &self,
        account: V2CloudAccount,
        runtime: RuntimeSession,
    ) -> Result<AuthOutcome, SyncError> {
        let refresh_token = runtime.refresh_token.clone();
        self.store.save_v2_account(&account)?;
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
        self.store.clear_v2_account()?;
        Ok(())
    }

    pub(super) async fn access_token(&self) -> Result<String, SyncError> {
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
        self.refresh_access_token(&current.access_token).await
    }

    pub(super) async fn force_refresh_access_token(&self) -> Result<String, SyncError> {
        let stale_access_token = self
            .session
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .map(|session| session.access_token.clone())
            .ok_or(SyncError::NotAuthenticated)?;
        self.refresh_access_token(&stale_access_token).await
    }

    async fn refresh_access_token(&self, stale_access_token: &str) -> Result<String, SyncError> {
        let _guard = self.refresh_lock.lock().await;
        let current = self
            .session
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or(SyncError::NotAuthenticated)?;
        // Another concurrent request already rotated this session while we
        // were waiting for the lock; reuse its result instead of rotating the
        // new refresh token a second time.
        if current.access_token != stale_access_token {
            return Ok(current.access_token);
        }
        if current.refresh_token_expires_at <= chrono::Utc::now().timestamp_millis() {
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
}
