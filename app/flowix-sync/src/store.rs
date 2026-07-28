use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::SyncError;
use crate::models::{
    CloudAccount, LocalChangeKind, NoteState, NotebookLink, OutboxEntry, OutboxWrite,
};

#[derive(Clone)]
pub struct SyncStore {
    path: PathBuf,
}

mod note_state;
mod notebook_links;
mod outbox;
mod schema;
mod settings;

#[cfg(test)]
mod tests;
