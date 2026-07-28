use super::*;

impl SyncStore {
    pub fn enabled(&self) -> Result<bool, SyncError> {
        let value = self
            .open()?
            .query_row(
                "SELECT value FROM sync_settings WHERE key = 'enabled'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(value.as_deref() == Some("true"))
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<(), SyncError> {
        self.open()?.execute(
            r#"INSERT INTO sync_settings(key, value) VALUES ('enabled', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value"#,
            [if enabled { "true" } else { "false" }],
        )?;
        Ok(())
    }

    pub(crate) fn device_id(&self) -> Result<String, SyncError> {
        let connection = self.open()?;
        if let Some(value) = connection
            .query_row(
                "SELECT value FROM sync_settings WHERE key = 'device_id'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            return Ok(value);
        }
        let value = uuid::Uuid::new_v4().to_string();
        connection.execute(
            "INSERT OR IGNORE INTO sync_settings(key, value) VALUES ('device_id', ?1)",
            [&value],
        )?;
        connection
            .query_row(
                "SELECT value FROM sync_settings WHERE key = 'device_id'",
                [],
                |row| row.get(0),
            )
            .map_err(SyncError::from)
    }

    pub(crate) fn next_logical_counter(&self) -> Result<i64, SyncError> {
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        let current = transaction
            .query_row(
                "SELECT value FROM sync_settings WHERE key = 'logical_counter'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0);
        let next = current.saturating_add(1);
        transaction.execute(
            r#"INSERT INTO sync_settings(key, value) VALUES ('logical_counter', ?1)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value"#,
            [next.to_string()],
        )?;
        transaction.commit()?;
        Ok(next)
    }

    pub(crate) fn observe_logical_counter(&self, observed: i64) -> Result<(), SyncError> {
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        let current = transaction
            .query_row(
                "SELECT value FROM sync_settings WHERE key = 'logical_counter'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0);
        if observed > current {
            transaction.execute(
                r#"INSERT INTO sync_settings(key, value) VALUES ('logical_counter', ?1)
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value"#,
                [observed.to_string()],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn server_time_offset(&self) -> Result<i64, SyncError> {
        Ok(self
            .open()?
            .query_row(
                "SELECT value FROM sync_settings WHERE key = 'server_time_offset'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0))
    }

    pub(crate) fn observe_server_time(
        &self,
        server_time: i64,
        local_time: i64,
    ) -> Result<(), SyncError> {
        let offset = server_time.saturating_sub(local_time);
        self.open()?.execute(
            r#"INSERT INTO sync_settings(key, value) VALUES ('server_time_offset', ?1)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value"#,
            [offset.to_string()],
        )?;
        Ok(())
    }

    pub fn account(&self) -> Result<Option<CloudAccount>, SyncError> {
        let payload = self
            .open()?
            .query_row(
                "SELECT payload_json FROM cloud_account WHERE singleton = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        payload
            .map(|value| {
                serde_json::from_str(&value).map_err(|error| {
                    SyncError::InvalidState(format!("invalid stored cloud account: {error}"))
                })
            })
            .transpose()
    }

    pub fn save_account(&self, account: &CloudAccount) -> Result<(), SyncError> {
        self.open()?.execute(
            r#"INSERT INTO cloud_account(singleton, payload_json, updated_at) VALUES (1, ?1, ?2)
             ON CONFLICT(singleton) DO UPDATE SET
               payload_json = excluded.payload_json, updated_at = excluded.updated_at"#,
            params![
                serde_json::to_string(account).map_err(|error| {
                    SyncError::InvalidState(format!("serialize cloud account: {error}"))
                })?,
                chrono::Utc::now().timestamp_millis()
            ],
        )?;
        Ok(())
    }

    pub fn clear_account(&self) -> Result<(), SyncError> {
        self.open()?.execute("DELETE FROM cloud_account", [])?;
        Ok(())
    }
}
