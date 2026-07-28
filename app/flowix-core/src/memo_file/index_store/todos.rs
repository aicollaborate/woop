use super::*;

impl MemoFile {
    pub fn read_todo_metadata_entries(&self, sort: &str) -> std::io::Result<Vec<MemoTodoEntry>> {
        self.read_todo_metadata_entries_for_notebook_id(None, sort)
    }

    pub fn read_todo_metadata_entries_for_notebook_id(
        &self,
        notebook_id: Option<&str>,
        sort: &str,
    ) -> std::io::Result<Vec<MemoTodoEntry>> {
        let notebook_id = self.notebook_id_for_index(notebook_id);
        let conn = self.open_memo_index_db()?;
        let order = if sort == "updatedAt" {
            "t.updated_at DESC, t.created_at DESC"
        } else {
            "t.created_at DESC, t.updated_at DESC"
        };
        let sql = format!(
            r#"
            SELECT t.content, t.status, t.memo_id, t.priority, t.time_range, t.owner, t.assignee,
                   t.created_at, t.updated_at
            FROM memo_todos t
            JOIN memos m ON m.id = t.memo_id
            WHERE m.notebook_id = ?1
            ORDER BY {order}
            "#
        );
        let mut stmt = conn.prepare(&sql).map_err(sqlite_to_io)?;
        let rows = stmt
            .query_map(params![notebook_id], |row| {
                Ok(MemoTodoEntry {
                    content: row.get(0)?,
                    status: row.get(1)?,
                    memo_id: row.get(2)?,
                    priority: row.get(3)?,
                    time_range: row.get(4)?,
                    owner: row.get(5)?,
                    assignee: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(sqlite_to_io)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_to_io)
    }
}
