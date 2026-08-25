//! CLI adapter for declaration-driven artifact tools.

use crate::errors::CliError;
use crate::output::print_pretty_json;
use flowix_plugin_runtime::{
    builtin_tools, create_artifact, describe_tool, CreateArtifactRequest, CreatedPluginArtifact,
    PluginToolDescription,
};

pub fn cmd_list(json: bool) -> Result<(), CliError> {
    let tools = list_data();
    if json {
        print_pretty_json(&tools)
    } else {
        for tool in tools {
            println!("{}\t{}\t{}", tool.id, tool.name, tool.kind);
        }
        Ok(())
    }
}

pub fn cmd_describe(plugin_id: &str, json: bool) -> Result<(), CliError> {
    let tool = describe_data(plugin_id)?;
    if json {
        print_pretty_json(&tool)
    } else {
        println!("{} ({})", tool.name, tool.id);
        println!("  kind:      {}", tool.kind);
        println!("  command:   {}", tool.command);
        println!("  input:     {} ({})", tool.input, tool.content_type);
        println!("  renderer:  {}", tool.renderer);
        println!("  parser:    {}", tool.parser);
        println!("\n{}", tool.instructions.trim());
        Ok(())
    }
}

pub fn cmd_create(
    plugin_id: &str,
    notebook: &str,
    source_note: Option<&str>,
    producer: &str,
    json: bool,
) -> Result<(), CliError> {
    use std::io::Read;
    let mut content = String::new();
    std::io::stdin()
        .read_to_string(&mut content)
        .map_err(CliError::Io)?;
    let content = content.strip_prefix('\u{FEFF}').unwrap_or(&content);
    let created = create_data(plugin_id, notebook, source_note, producer, content)?;
    if json {
        print_pretty_json(&created)
    } else {
        println!("created plugin document: {}", created.note_id);
        println!("  plugin:    {}", created.plugin_id);
        println!("  notebook:  {}", created.notebook);
        println!("  title:     {}", created.title);
        println!("  document:  {}", created.note_path);
        println!("  artifact:  {}", created.artifact_path);
        Ok(())
    }
}

pub(crate) fn list_data() -> Vec<PluginToolDescription> {
    builtin_tools()
}

pub(crate) fn describe_data(plugin_id: &str) -> Result<PluginToolDescription, CliError> {
    describe_tool(plugin_id)
        .ok_or_else(|| CliError::NotFound(format!("plugin tool not found: {plugin_id}")))
}

pub(crate) fn create_data(
    plugin_id: &str,
    notebook: &str,
    source_note: Option<&str>,
    producer: &str,
    content: &str,
) -> Result<CreatedPluginArtifact, CliError> {
    let memo_file = crate::store::open()?;
    create_artifact(
        &memo_file,
        CreateArtifactRequest {
            plugin_id,
            notebook,
            content,
            source_note,
            producer,
        },
    )
    .map_err(map_runtime_error)
}

fn map_runtime_error(message: String) -> CliError {
    if message.starts_with("plugin tool not found:") || message.starts_with("notebook not found:") {
        CliError::NotFound(message)
    } else if message.starts_with("mindmap ")
        || message.starts_with("webpage ")
        || message.starts_with("plugin create requires")
    {
        CliError::Usage(message)
    } else {
        CliError::Other(message)
    }
}
