use thiserror::Error;

#[derive(Debug, Error)]
pub enum SyncError {
    #[error("cloud request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("sync database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("cloud API error {status} {code}: {message}")]
    Api {
        status: u16,
        code: String,
        message: String,
        details: Option<serde_json::Value>,
    },
    #[error("not authenticated")]
    NotAuthenticated,
    #[error("cloud sync is disabled")]
    Disabled,
    #[error("notebook is not enabled for cloud sync")]
    NotebookDisabled,
    #[error("invalid cloud state: {0}")]
    InvalidState(String),
}

impl SyncError {
    pub fn api_code(&self) -> Option<&str> {
        match self {
            Self::Api { code, .. } => Some(code),
            _ => None,
        }
    }

    pub(crate) fn is_unauthorized(&self) -> bool {
        matches!(self, Self::Api { status: 401, .. })
    }
}
