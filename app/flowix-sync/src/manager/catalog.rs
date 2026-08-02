use super::*;

impl SyncManager {
    pub async fn refresh_membership(&self) -> Result<CloudMembership, SyncError> {
        let token = self.access_token().await?;
        let first = self.client.entitlements(&token).await;
        let entitlement = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token().await?;
            self.client.entitlements(&refreshed).await?
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

    pub async fn create_checkout(
        &self,
        product_id: &str,
        idempotency_key: &str,
    ) -> Result<CloudCheckout, SyncError> {
        let token = self.access_token().await?;
        let first = self
            .client
            .checkout(&token, product_id, idempotency_key)
            .await;
        if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token().await?;
            return self
                .client
                .checkout(&refreshed, product_id, idempotency_key)
                .await;
        }
        first
    }
}
