use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::json;

use crate::error::SyncError;
use crate::models::{
    ApiErrorEnvelope, AppleAuthChallenge, AppleAuthorization, AuthData, ChangeVersion,
    CloudCheckout, CloudNotebook, CloudProduct, DataEnvelope, EntitlementData, ManifestData,
    MeData, PutNoteData, RefreshData, SyncStatusData,
};

pub(crate) struct PutNoteRequest<'a> {
    pub access_token: &'a str,
    pub workspace_id: &'a str,
    pub notebook_id: &'a str,
    pub note_id: &'a str,
    pub filename: &'a str,
    pub content: &'a str,
    pub base_revision: Option<&'a str>,
    pub change_version: &'a ChangeVersion,
}

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
            "/v1/catalog/products",
            None,
            None,
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn checkout(
        &self,
        access_token: &str,
        workspace_id: &str,
        product_id: &str,
        idempotency_key: &str,
    ) -> Result<CloudCheckout, SyncError> {
        let response = self
            .http
            .post(format!(
                "{}/v1/billing/{workspace_id}/checkout",
                self.base_url
            ))
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
        workspace_id: &str,
    ) -> Result<EntitlementData, SyncError> {
        self.send::<DataEnvelope<EntitlementData>>(
            Method::GET,
            &format!("/v1/workspaces/{workspace_id}/entitlements"),
            Some(access_token),
            None,
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn create_notebook(
        &self,
        access_token: &str,
        workspace_id: &str,
        notebook_id: &str,
        name: &str,
    ) -> Result<(), SyncError> {
        let result = self
            .send::<DataEnvelope<serde_json::Value>>(
                Method::POST,
                &format!("/v1/workspaces/{workspace_id}/notebooks"),
                Some(access_token),
                Some(json!({ "id": notebook_id, "name": name })),
            )
            .await;
        match result {
            Ok(_) => Ok(()),
            Err(error) if error.api_code() == Some("NOTEBOOK_ALREADY_EXISTS") => Ok(()),
            Err(error) => Err(error),
        }
    }

    pub(crate) async fn notebooks(
        &self,
        access_token: &str,
        workspace_id: &str,
    ) -> Result<Vec<CloudNotebook>, SyncError> {
        self.send::<DataEnvelope<Vec<CloudNotebook>>>(
            Method::GET,
            &format!("/v1/workspaces/{workspace_id}/notebooks"),
            Some(access_token),
            None,
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn manifest(
        &self,
        access_token: &str,
        workspace_id: &str,
        cursor: i64,
    ) -> Result<ManifestData, SyncError> {
        self.send::<DataEnvelope<ManifestData>>(
            Method::GET,
            &format!("/v1/workspaces/{workspace_id}/sync/manifest?cursor={cursor}&limit=1000"),
            Some(access_token),
            None,
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn sync_status(
        &self,
        access_token: &str,
        workspace_id: &str,
        cursor: i64,
    ) -> Result<SyncStatusData, SyncError> {
        self.send::<DataEnvelope<SyncStatusData>>(
            Method::GET,
            &format!("/v1/workspaces/{workspace_id}/sync/status?cursor={cursor}"),
            Some(access_token),
            None,
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn delete_note(
        &self,
        access_token: &str,
        workspace_id: &str,
        notebook_id: &str,
        note_id: &str,
        base_revision: Option<&str>,
        change_version: &ChangeVersion,
    ) -> Result<(), SyncError> {
        self.send::<DataEnvelope<serde_json::Value>>(
            Method::DELETE,
            &format!("/v1/workspaces/{workspace_id}/notebooks/{notebook_id}/notes/{note_id}"),
            Some(access_token),
            Some(json!({
                "baseRevision": base_revision,
                "changeVersion": change_version,
            })),
        )
        .await
        .map(|_| ())
    }

    pub(crate) async fn put_note(
        &self,
        input: PutNoteRequest<'_>,
    ) -> Result<PutNoteData, SyncError> {
        self.send::<DataEnvelope<PutNoteData>>(
            Method::PUT,
            &format!(
                "/v1/workspaces/{}/notebooks/{}/notes/{}",
                input.workspace_id, input.notebook_id, input.note_id
            ),
            Some(input.access_token),
            Some(json!({
                "filename": input.filename,
                "content": input.content,
                "baseRevision": input.base_revision,
                "changeVersion": input.change_version,
            })),
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn get_note(
        &self,
        access_token: &str,
        workspace_id: &str,
        notebook_id: &str,
        note_id: &str,
    ) -> Result<String, SyncError> {
        let response = self
            .http
            .get(format!(
                "{}/v1/workspaces/{workspace_id}/notebooks/{notebook_id}/notes/{note_id}",
                self.base_url
            ))
            .bearer_auth(access_token)
            .send()
            .await?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            return Err(SyncError::Api {
                status,
                code: "NOTE_DOWNLOAD_FAILED".into(),
                message: body,
                details: None,
            });
        }
        Ok(response.text().await?)
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
