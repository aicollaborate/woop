use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::json;

use crate::error::SyncError;
use crate::models::{
    ApiErrorEnvelope, AppleAuthChallenge, AppleAuthorization, AuthData, CloudCheckout,
    CloudProduct, DataEnvelope, EntitlementData, MeData, RefreshData,
};
use crate::v2::{
    V2BlobReservationEnvelope, V2Bootstrap, V2ChangesPage, V2PushOperation, V2PushResult,
    V2SyncStatus, PROTOCOL_EPOCH,
};

fn apple_authorization_body(authorization: &AppleAuthorization) -> serde_json::Value {
    let mut body = serde_json::Map::from_iter([
        (
            "challengeId".to_string(),
            serde_json::Value::String(authorization.challenge_id.clone()),
        ),
        (
            "nonce".to_string(),
            serde_json::Value::String(authorization.nonce.clone()),
        ),
        (
            "identityToken".to_string(),
            serde_json::Value::String(authorization.identity_token.clone()),
        ),
        (
            "authorizationCode".to_string(),
            serde_json::Value::String(authorization.authorization_code.clone()),
        ),
    ]);
    if let Some(display_name) = &authorization.display_name {
        body.insert(
            "displayName".to_string(),
            serde_json::Value::String(display_name.clone()),
        );
    }
    serde_json::Value::Object(body)
}

#[derive(Clone)]
pub struct CloudClient {
    base_url: String,
    http: reqwest::Client,
}

impl CloudClient {
    pub fn new(base_url: impl Into<String>) -> Result<Self, SyncError> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()?;
        Ok(Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            http,
        })
    }

    async fn send<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        token: Option<&str>,
        body: Option<serde_json::Value>,
    ) -> Result<T, SyncError> {
        let mut request = self
            .http
            .request(method, format!("{}{}", self.base_url, path));
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await?;
        Self::decode(response).await
    }

    async fn decode<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, SyncError> {
        let status = response.status();
        let bytes = response.bytes().await?;
        if !status.is_success() {
            let parsed = serde_json::from_slice::<ApiErrorEnvelope>(&bytes).ok();
            return Err(SyncError::Api {
                status: status.as_u16(),
                code: parsed
                    .as_ref()
                    .map(|value| value.error.code.clone())
                    .unwrap_or_else(|| "HTTP_ERROR".to_string()),
                message: parsed
                    .as_ref()
                    .map(|value| value.error.message.clone())
                    .unwrap_or_else(|| String::from_utf8_lossy(&bytes).into_owned()),
                details: parsed.and_then(|value| value.error.details),
            });
        }
        serde_json::from_slice(&bytes)
            .map_err(|error| SyncError::InvalidState(format!("invalid cloud response: {error}")))
    }

    pub(crate) async fn products(&self) -> Result<Vec<CloudProduct>, SyncError> {
        self.send::<DataEnvelope<Vec<CloudProduct>>>(
            Method::GET,
            "/v2/catalog/products",
            None,
            None,
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn checkout(
        &self,
        access_token: &str,
        product_id: &str,
        idempotency_key: &str,
    ) -> Result<CloudCheckout, SyncError> {
        let response = self
            .http
            .post(format!("{}/v2/billing/checkout", self.base_url))
            .bearer_auth(access_token)
            .header("Idempotency-Key", idempotency_key)
            .json(&json!({
                "productId": product_id,
                "successUrl": "flowix://billing/success",
                "cancelUrl": "flowix://billing/cancel",
            }))
            .send()
            .await?;
        Self::decode::<DataEnvelope<CloudCheckout>>(response)
            .await
            .map(|value| value.data)
    }

    pub(crate) async fn register(
        &self,
        email: &str,
        password: &str,
        display_name: &str,
    ) -> Result<AuthData, SyncError> {
        self.send::<DataEnvelope<AuthData>>(
            Method::POST,
            "/v1/auth/register",
            None,
            Some(json!({
                "email": email,
                "password": password,
                "displayName": display_name,
            })),
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn login(&self, email: &str, password: &str) -> Result<AuthData, SyncError> {
        self.send::<DataEnvelope<AuthData>>(
            Method::POST,
            "/v1/auth/login",
            None,
            Some(json!({ "email": email, "password": password })),
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn apple_challenge(&self) -> Result<AppleAuthChallenge, SyncError> {
        self.send::<DataEnvelope<AppleAuthChallenge>>(
            Method::POST,
            "/v1/auth/apple/challenge",
            None,
            None,
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn apple_exchange(
        &self,
        authorization: &AppleAuthorization,
    ) -> Result<AuthData, SyncError> {
        self.send::<DataEnvelope<AuthData>>(
            Method::POST,
            "/v1/auth/apple/exchange",
            None,
            Some(apple_authorization_body(authorization)),
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn apple_link(
        &self,
        access_token: &str,
        authorization: &AppleAuthorization,
    ) -> Result<(), SyncError> {
        self.send::<DataEnvelope<serde_json::Value>>(
            Method::POST,
            "/v1/auth/apple/link",
            Some(access_token),
            Some(apple_authorization_body(authorization)),
        )
        .await
        .map(|_| ())
    }

    pub(crate) async fn refresh(&self, refresh_token: &str) -> Result<RefreshData, SyncError> {
        self.send::<DataEnvelope<RefreshData>>(
            Method::POST,
            "/v1/auth/refresh",
            None,
            Some(json!({ "refreshToken": refresh_token })),
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn logout(&self, access_token: &str) -> Result<(), SyncError> {
        let response = self
            .http
            .post(format!("{}/v1/auth/logout", self.base_url))
            .bearer_auth(access_token)
            .send()
            .await?;
        if response.status().is_success() || response.status() == StatusCode::UNAUTHORIZED {
            Ok(())
        } else {
            Err(SyncError::Api {
                status: response.status().as_u16(),
                code: "LOGOUT_FAILED".into(),
                message: "Cloud logout failed".into(),
                details: None,
            })
        }
    }

    pub(crate) async fn me(&self, access_token: &str) -> Result<MeData, SyncError> {
        self.send::<DataEnvelope<MeData>>(Method::GET, "/v1/auth/me", Some(access_token), None)
            .await
            .map(|value| value.data)
    }

    pub(crate) async fn entitlements(
        &self,
        access_token: &str,
    ) -> Result<EntitlementData, SyncError> {
        self.send::<DataEnvelope<EntitlementData>>(
            Method::GET,
            "/v2/entitlements/current",
            Some(access_token),
            None,
        )
        .await
        .map(|value| value.data)
    }

    pub async fn v2_sync_status(
        &self,
        access_token: &str,
        cursor: i64,
    ) -> Result<V2SyncStatus, SyncError> {
        self.send::<DataEnvelope<V2SyncStatus>>(
            Method::GET,
            &format!("/v2/sync/status?cursor={cursor}"),
            Some(access_token),
            None,
        )
        .await
        .map(|value| value.data)
    }

    pub async fn v2_changes(
        &self,
        access_token: &str,
        cursor: i64,
        limit: usize,
    ) -> Result<V2ChangesPage, SyncError> {
        let limit = limit.clamp(1, 1_000);
        self.send::<DataEnvelope<V2ChangesPage>>(
            Method::GET,
            &format!("/v2/sync/changes?cursor={cursor}&limit={limit}"),
            Some(access_token),
            None,
        )
        .await
        .map(|value| value.data)
    }

    pub async fn v2_bootstrap(&self, access_token: &str) -> Result<V2Bootstrap, SyncError> {
        self.send::<DataEnvelope<V2Bootstrap>>(
            Method::GET,
            "/v2/sync/bootstrap",
            Some(access_token),
            None,
        )
        .await
        .map(|value| value.data)
    }

    pub async fn v2_reserve_blob(
        &self,
        access_token: &str,
        content_hash: &str,
        size_bytes: i64,
        blob_kind: &str,
    ) -> Result<V2BlobReservationEnvelope, SyncError> {
        self.send::<V2BlobReservationEnvelope>(
            Method::POST,
            "/v2/blobs/reservations",
            Some(access_token),
            Some(json!({
                "protocolEpoch": PROTOCOL_EPOCH,
                "contentHash": content_hash,
                "sizeBytes": size_bytes,
                "blobKind": blob_kind,
            })),
        )
        .await
    }

    pub async fn v2_upload_blob(
        &self,
        access_token: &str,
        upload_path: &str,
        content: Vec<u8>,
    ) -> Result<(), SyncError> {
        if !upload_path.starts_with("/v2/blobs/reservations/") {
            return Err(SyncError::InvalidState(
                "cloud returned an invalid v2 upload path".into(),
            ));
        }
        let response = self
            .http
            .put(format!("{}{}", self.base_url, upload_path))
            .bearer_auth(access_token)
            .header(
                reqwest::header::CONTENT_TYPE,
                "text/markdown; charset=utf-8",
            )
            .body(content)
            .send()
            .await?;
        Self::decode::<DataEnvelope<serde_json::Value>>(response)
            .await
            .map(|_| ())
    }

    pub async fn v2_push(
        &self,
        access_token: &str,
        operations: &[V2PushOperation],
    ) -> Result<V2PushResult, SyncError> {
        self.send::<DataEnvelope<V2PushResult>>(
            Method::POST,
            "/v2/sync/push",
            Some(access_token),
            Some(json!({
                "protocolEpoch": PROTOCOL_EPOCH,
                "operations": operations,
            })),
        )
        .await
        .map(|value| value.data)
    }

    pub async fn v2_download_blob(
        &self,
        access_token: &str,
        content_hash: &str,
    ) -> Result<Vec<u8>, SyncError> {
        let response = self
            .http
            .get(format!("{}/v2/blobs/{content_hash}", self.base_url))
            .bearer_auth(access_token)
            .send()
            .await?;
        if !response.status().is_success() {
            return Self::decode::<DataEnvelope<serde_json::Value>>(response)
                .await
                .map(|_| Vec::new());
        }
        Ok(response.bytes().await?.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::apple_authorization_body;
    use crate::models::AppleAuthorization;
    use serde_json::json;

    fn authorization(display_name: Option<&str>) -> AppleAuthorization {
        AppleAuthorization {
            challenge_id: "ach_test".into(),
            nonce: "nonce_test".into(),
            identity_token: "identity_token_test".into(),
            authorization_code: "authorization_code_test".into(),
            display_name: display_name.map(str::to_string),
        }
    }

    #[test]
    fn apple_authorization_body_includes_first_login_name() {
        assert_eq!(
            apple_authorization_body(&authorization(Some("Flowix User"))),
            json!({
                "challengeId": "ach_test",
                "nonce": "nonce_test",
                "identityToken": "identity_token_test",
                "authorizationCode": "authorization_code_test",
                "displayName": "Flowix User",
            })
        );
    }

    #[test]
    fn apple_authorization_body_omits_name_after_first_login() {
        let body = apple_authorization_body(&authorization(None));
        assert_eq!(
            body,
            json!({
                "challengeId": "ach_test",
                "nonce": "nonce_test",
                "identityToken": "identity_token_test",
                "authorizationCode": "authorization_code_test",
            })
        );
        assert!(body.get("displayName").is_none());
    }
}
