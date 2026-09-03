//! Transport-neutral Flowix operations shared by CLI and MCP adapters.

use crate::{errors::CliError, fmt, output, plugin, store};
use serde_json::Value;

#[derive(Debug, Clone)]
pub(crate) enum FlowixOperation {
    Notebooks,
    List {
        notebook: Option<String>,
        limit: usize,
        offset: usize,
    },
    Tags {
        notebook: Option<String>,
    },
    Show {
        id: String,
    },
    Search {
        query: String,
        notebook: Option<String>,
        tag: Option<String>,
        limit: usize,
    },
    Create {
        notebook: Option<String>,
        content: String,
    },
    Edit {
        id: String,
        old: String,
        replacement: String,
        dry_run: bool,
    },
    Write {
        id: String,
        content: String,
    },
    Delete {
        id: String,
    },
    ArtifactList,
    ArtifactDescribe {
        plugin_id: String,
    },
    ArtifactCreate {
        plugin_id: String,
        notebook: Option<String>,
        source_note: Option<String>,
        producer: String,
        content: String,
    },
}

pub(crate) fn execute(operation: FlowixOperation) -> Result<Value, CliError> {
    match operation {
        FlowixOperation::Notebooks => {
            let (configs, selected) = store::notebooks_list_data()?;
            let counts = store::notebook_note_counts(&configs)?;
            let tag_counts = store::notebook_tag_counts(&configs)?;
            Ok(fmt::notebooks_to_json(
                &configs,
                &counts,
                &tag_counts,
                selected.as_deref(),
            ))
        }
        FlowixOperation::List {
            notebook,
            limit,
            offset,
        } => {
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            let entries = store::notes_list_entries(&notebook)?;
            let total = entries.len();
            let notes = entries
                .into_iter()
                .skip(offset)
                .take(limit)
                .collect::<Vec<_>>();
            Ok(serde_json::json!({
                "ok": true,
                "action": "list",
                "notebook": notebook,
                "notes": fmt::notes_to_json(&notes),
                "total": total,
                "offset": offset,
                "limit": limit,
                "next_offset": (offset + notes.len() < total).then_some(offset + notes.len())
            }))
        }
        FlowixOperation::Tags { notebook } => store::notebook_tags(notebook.as_deref()),
        FlowixOperation::Show { id } => Ok(store::note_show_data(&id)?.to_json()),
        FlowixOperation::Search {
            query,
            notebook,
            tag,
            limit,
        } => {
            let results = store::search_hits(&query, notebook.as_deref(), tag.as_deref(), limit)?;
            output::to_json_value(&store::search_results_to_value(
                &query,
                tag.as_deref(),
                &results,
            ))
        }
        FlowixOperation::Create { notebook, content } => {
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            let (mut memo_file, config) = store::open_in(&notebook)?;
            output::to_json_value(&store::create_note(&mut memo_file, &config, &content)?)
        }
        FlowixOperation::Edit {
            id,
            old,
            replacement,
            dry_run,
        } => {
            let (mut memo_file, full_id) = store::resolve_id(&id)?;
            let result = if dry_run {
                store::preview_edit_note(&mut memo_file, &full_id, &old, &replacement)
            } else {
                store::edit_note(&mut memo_file, &full_id, &old, &replacement)
            }?;
            output::to_json_value(&result)
        }
        FlowixOperation::Write { id, content } => {
            let (mut memo_file, full_id) = store::resolve_id(&id)?;
            output::to_json_value(&store::write_note(&mut memo_file, &full_id, &content)?)
        }
        FlowixOperation::Delete { id } => {
            let (mut memo_file, full_id) = store::resolve_id(&id)?;
            let path = memo_file.find_memo_file_path(&full_id);
            output::to_json_value(&store::delete_note(
                &mut memo_file,
                &full_id,
                path.as_deref(),
            )?)
        }
        FlowixOperation::ArtifactList => output::to_json_value(&plugin::list_data()),
        FlowixOperation::ArtifactDescribe { plugin_id } => {
            output::to_json_value(&plugin::describe_data(&plugin_id)?)
        }
        FlowixOperation::ArtifactCreate {
            plugin_id,
            notebook,
            source_note,
            producer,
            content,
        } => {
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            output::to_json_value(&plugin::create_data(
                &plugin_id,
                &notebook,
                source_note.as_deref(),
                &producer,
                &content,
            )?)
        }
    }
}
