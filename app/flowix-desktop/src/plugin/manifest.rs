use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;

use super::artifact::output_extension;
use super::{is_relative_plugin_path, is_valid_output_extension, valid_plugin_id};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: String,
    pub ui: PluginUi,
    pub input: PluginInput,
    #[serde(default)]
    pub agent: Option<PluginAgent>,
    #[serde(default)]
    pub tool: Option<PluginTool>,
    #[serde(default)]
    pub discovery: PluginDiscovery,
    #[serde(default)]
    pub execution: PluginExecution,
    pub output: PluginOutput,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginTool {
    pub command: String,
    pub input: String,
    pub content_type: String,
    pub instructions: String,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(super) enum PluginParser {
    MindmapMarkdown,
    Markdown,
    Json,
    Html,
    Text,
}

impl PluginParser {
    fn parse(raw: &str, format: &str) -> Result<Self, String> {
        let normalized = if raw.trim().is_empty() {
            match format {
                "markdown" => "mindmap-markdown",
                "json" => "json",
                "html" => "html",
                "text" => "text",
                _ => return Err(format!("unsupported plugin output format: {format}")),
            }
        } else {
            raw.trim()
        };
        match normalized {
            "mindmap-markdown" => Ok(Self::MindmapMarkdown),
            "markdown" => Ok(Self::Markdown),
            "json" => Ok(Self::Json),
            "html" => Ok(Self::Html),
            "text" => Ok(Self::Text),
            _ => Err(format!("unsupported plugin output parser: {normalized}")),
        }
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(super) enum PluginRuntime {
    Flowix,
    Codex,
    Claude,
    Hermes,
    OpenCode,
}

impl PluginRuntime {
    fn parse(raw: Option<&str>) -> Result<Option<Self>, String> {
        let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        let runtime = match raw.to_ascii_lowercase().as_str() {
            "flowix" => Self::Flowix,
            "codex" => Self::Codex,
            "claude" => Self::Claude,
            "hermes" => Self::Hermes,
            "opencode" => Self::OpenCode,
            _ => return Err(format!("unsupported plugin runtime: {raw}")),
        };
        Ok(Some(runtime))
    }

    pub(super) fn key(self) -> &'static str {
        match self {
            Self::Flowix => "flowix",
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Hermes => "hermes",
            Self::OpenCode => "opencode",
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct PluginDefinition {
    pub(super) parser: PluginParser,
    pub(super) runtime: Option<PluginRuntime>,
    pub(super) output_directory: PathBuf,
    pub(super) extension: String,
    pub(super) note_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginUi {
    pub placement: String,
    pub order: i32,
    pub icon: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginInput {
    #[serde(default)]
    pub fields: Vec<PluginField>,
    #[serde(default)]
    pub prompt: Option<PluginField>,
    #[serde(default)]
    pub agent_type: Option<PluginField>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PluginField {
    #[serde(default)]
    pub id: String,
    #[serde(rename = "type")]
    pub field_type: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub options: Vec<PluginOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PluginAgent {
    pub skill: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginDiscovery {
    #[serde(default)]
    pub note_type: Option<String>,
}

impl Default for PluginDiscovery {
    fn default() -> Self {
        Self { note_type: None }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginExecution {
    #[serde(default)]
    pub runtime: Option<String>,
}

impl Default for PluginExecution {
    fn default() -> Self {
        Self { runtime: None }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginOutput {
    pub format: String,
    pub directory: String,
    pub extension: String,
    pub renderer: String,
    #[serde(default)]
    pub parser: String,
}

pub(super) fn validate_manifest(manifest: &PluginManifest) -> Result<PluginDefinition, String> {
    if manifest.schema_version != 1 && manifest.schema_version != 2 {
        return Err(format!(
            "unsupported plugin schema version: {}",
            manifest.schema_version
        ));
    }
    if !valid_plugin_id(&manifest.id) {
        return Err("plugin id must use lowercase letters, numbers, '-' or '_'".to_string());
    }
    let note_type = manifest
        .discovery
        .note_type
        .as_deref()
        .unwrap_or(&manifest.id)
        .trim();
    if note_type.is_empty()
        || note_type.len() > 64
        || !note_type
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_')
    {
        return Err(
            "plugin discovery noteType must use lowercase letters, numbers, '-' or '_'".to_string(),
        );
    }
    if manifest.name.trim().is_empty() || manifest.version.trim().is_empty() {
        return Err("plugin name and version are required".to_string());
    }
    match manifest.kind.as_str() {
        "agent-markdown" => {}
        "artifact-tool" if manifest.schema_version >= 2 => {
            let tool = manifest
                .tool
                .as_ref()
                .ok_or_else(|| "artifact-tool plugin requires a tool declaration".to_string())?;
            if tool.command.trim().is_empty()
                || tool.input != "stdin"
                || tool.content_type.trim().is_empty()
                || tool.instructions.trim().is_empty()
                || !is_relative_plugin_path(&tool.instructions)
            {
                return Err("plugin tool declaration is invalid".to_string());
            }
        }
        other => return Err(format!("unsupported plugin kind: {other}")),
    }
    if manifest.ui.placement != "sidebar" {
        return Err(format!(
            "unsupported plugin UI placement: {}",
            manifest.ui.placement
        ));
    }
    if manifest.kind == "agent-markdown" {
        let agent = manifest
            .agent
            .as_ref()
            .ok_or_else(|| "agent-markdown plugin requires an agent skill".to_string())?;
        if agent.skill.trim().is_empty() || !is_relative_plugin_path(&agent.skill) {
            return Err("plugin manifest contains an invalid skill".to_string());
        }
    }
    if !is_relative_plugin_path(&manifest.output.directory) {
        return Err("plugin manifest contains an invalid output directory".to_string());
    }
    let mut field_ids = HashSet::new();
    let fields = if manifest.input.fields.is_empty() {
        manifest
            .input
            .prompt
            .iter()
            .map(|field| (field, "prompt"))
            .chain(
                manifest
                    .input
                    .agent_type
                    .iter()
                    .map(|field| (field, "agentType")),
            )
            .collect::<Vec<_>>()
    } else {
        manifest
            .input
            .fields
            .iter()
            .map(|field| (field, field.id.as_str()))
            .collect::<Vec<_>>()
    };
    for (field, fallback_id) in fields {
        let field_id = if field.id.trim().is_empty() {
            fallback_id
        } else {
            field.id.as_str()
        };
        if !field_ids.insert(field_id) {
            return Err("plugin input field ids must be unique and non-empty".to_string());
        }
        match field.field_type.as_str() {
            "text" | "input" | "textarea" | "select" | "agent-select" | "number" | "checkbox" => {}
            other => return Err(format!("unsupported plugin input field type: {other}")),
        }
        if field.field_type == "select" || field.field_type == "agent-select" {
            if field.options.is_empty() {
                return Err(format!("plugin field '{field_id}' requires options"));
            }
            let mut option_values = HashSet::new();
            if field.options.iter().any(|option| {
                option.value.trim().is_empty()
                    || option.label.trim().is_empty()
                    || !option_values.insert(option.value.as_str())
            }) {
                return Err(format!("plugin field '{field_id}' has invalid options"));
            }
        }
    }
    let parser = PluginParser::parse(&manifest.output.parser, &manifest.output.format)?;
    let expected_format = match parser {
        PluginParser::MindmapMarkdown | PluginParser::Markdown => "markdown",
        PluginParser::Json => "json",
        PluginParser::Html => "html",
        PluginParser::Text => "text",
    };
    if manifest.output.format != expected_format {
        return Err(format!(
            "plugin parser does not match output format: {} vs {}",
            manifest.output.parser, manifest.output.format
        ));
    }
    if !is_valid_output_extension(&manifest.output.extension) {
        return Err("plugin manifest contains an invalid output extension".to_string());
    }
    match manifest.output.renderer.as_str() {
        "markmap" if parser == PluginParser::MindmapMarkdown => {}
        "json-viewer" if parser == PluginParser::Json => {}
        "html" if parser == PluginParser::Html => {}
        "text" | "markdown" => {}
        other => return Err(format!("unsupported plugin output renderer: {other}")),
    }
    Ok(PluginDefinition {
        parser,
        runtime: PluginRuntime::parse(manifest.execution.runtime.as_deref())?,
        output_directory: PathBuf::from(&manifest.output.directory),
        extension: output_extension(&manifest.output.extension),
        note_type: note_type.to_string(),
    })
}
