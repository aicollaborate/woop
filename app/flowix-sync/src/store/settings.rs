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
}
