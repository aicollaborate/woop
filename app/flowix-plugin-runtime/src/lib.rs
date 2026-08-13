//! Non-agent plugin artifact runtime shared by the Desktop host and Flowix CLI.
//!
//! This crate deliberately has no Tauri or model-runtime dependency. Callers
//! provide final artifact content; the runtime validates it, writes the hidden
//! artifact, and creates the user-facing Flowix pointer note.

use flowix_core::memo_file::{atomic_write_bytes, MemoFile, NotebookConfig};
use flowix_core::MemoService;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

pub const MINDMAP_PLUGIN_ID: &str = "mindmap";
pub const MINDMAP_VERSION: &str = "0.2.0";
pub const MINDMAP_NOTE_TYPE: &str = "mindmap";
pub const MINDMAP_RENDERER: &str = "markmap";
pub const MINDMAP_PARSER: &str = "mindmap-markdown";
pub const MINDMAP_OUTPUT_DIRECTORY: &str = ".plugin-output/mindmap";

pub const MINDMAP_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "mindmap",
  "name": "思维导图",
  "version": "0.2.0",
  "kind": "artifact-tool",
  "ui": { "placement": "sidebar", "order": 100, "icon": "mindmap" },
  "input": { "fields": [] },
  "tool": {
    "command": "flowix plugin create mindmap",
    "input": "stdin",
    "contentType": "text/markdown",
    "instructions": "SKILL.md"
  },
  "discovery": { "noteType": "mindmap" },
  "output": {
    "format": "markdown",
    "directory": ".plugin-output/mindmap",
    "extension": ".md",
    "renderer": "markmap",
    "parser": "mindmap-markdown"
  }
}"#;

pub const MINDMAP_SKILL: &str = r#"# Mindmap Artifact Tool

Use this tool only when the user explicitly asks to create or generate a mind map.

Prepare the complete Markmap-compatible Markdown yourself, then pass it to
`flowix plugin create mindmap --notebook <name|id|path>` through stdin.

Input contract:

1. The input must contain exactly one level-one heading, used as the root node.
2. Use level-two/level-three headings and unordered lists for branches.
3. Keep node text concise; do not place explanatory paragraphs around the map.
4. Do not wrap the input in a Markdown code fence.
5. The CLI creates the artifact and its Flowix document. Do not create either file manually.
"#;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginToolDescription {
    pub id: &'static str,
    pub name: &'static str,
    pub version: &'static str,
    pub kind: &'static str,
    pub command: &'static str,
    pub input: &'static str,
    pub content_type: &'static str,
    pub parser: &'static str,
    pub renderer: &'static str,
    pub output_directory: &'static str,
    pub instructions: &'static str,
}

pub fn builtin_tools() -> Vec<PluginToolDescription> {
    vec![mindmap_description()]
}

pub fn describe_tool(id: &str) -> Option<PluginToolDescription> {
    (id == MINDMAP_PLUGIN_ID).then(mindmap_description)
}

fn mindmap_description() -> PluginToolDescription {
    PluginToolDescription {
        id: MINDMAP_PLUGIN_ID,
        name: "思维导图",
        version: MINDMAP_VERSION,
        kind: "artifact-tool",
        command: "flowix plugin create mindmap --notebook <name|id|path>",
        input: "stdin",
        content_type: "text/markdown",
        parser: MINDMAP_PARSER,
        renderer: MINDMAP_RENDERER,
        output_directory: MINDMAP_OUTPUT_DIRECTORY,
        instructions: MINDMAP_SKILL,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedMindmap {
    pub content: String,
    pub title: String,
}

/// Validate final tool input. Unlike the legacy agent-output parser, this is
/// intentionally strict: a tool caller must submit only the final map.
pub fn parse_mindmap_input(raw: &str) -> Result<ParsedMindmap, String> {
    let content = raw.trim().replace("\r\n", "\n");
    if content.is_empty() {
        return Err("mindmap input is empty".to_string());
    }
    if content.len() > 200_000 {
        return Err("mindmap input is too large (maximum 200000 bytes)".to_string());
    }
    if content.contains("```") {
        return Err("mindmap input must not use Markdown code fences".to_string());
    }

    let roots = content
        .lines()
        .filter_map(|line| line.strip_prefix("# ").map(str::trim))
        .collect::<Vec<_>>();
    if roots.is_empty() {
        return Err("mindmap input must contain one level-one heading".to_string());
    }
    if roots.len() != 1 {
        return Err("mindmap input must contain exactly one level-one heading".to_string());
    }
    if roots[0].is_empty() {
        return Err("mindmap root heading cannot be empty".to_string());
    }
    let first_non_empty = content.lines().find(|line| !line.trim().is_empty());
    if first_non_empty
        .and_then(|line| line.strip_prefix("# "))
        .is_none()
    {
        return Err("mindmap input must start with its level-one root heading".to_string());
    }

    let title = roots[0].to_string();
    Ok(ParsedMindmap { content, title })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginArtifactPointer {
    pub path: String,
    pub format: String,
    pub parser: String,
    pub renderer: String,
    pub title: String,
    pub content_hash: String,
    pub created_at: String,
    #[serde(default)]
    pub source_note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginNoteFrontmatter {
    pub flowix_note_type: String,
    pub flowix_plugin: String,
    pub flowix_plugin_version: String,
    pub flowix_artifact: PluginArtifactPointer,
}

#[derive(Debug, Clone)]
pub struct CreateArtifactRequest<'a> {
    pub plugin_id: &'a str,
    pub notebook: &'a str,
    pub content: &'a str,
    pub source_note: Option<&'a str>,
    pub producer: &'a str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedPluginArtifact {
    pub ok: bool,
    pub action: &'static str,
    pub plugin_id: String,
    pub note_id: String,
    pub notebook_id: String,
    pub notebook: String,
    pub title: String,
    pub renderer: String,
    pub artifact_path: String,
    pub note_path: String,
}

pub fn create_artifact(
    memo_file: &MemoFile,
    request: CreateArtifactRequest<'_>,
) -> Result<CreatedPluginArtifact, String> {
    if request.plugin_id != MINDMAP_PLUGIN_ID {
        return Err(format!("plugin tool not found: {}", request.plugin_id));
    }
    let parsed = parse_mindmap_input(request.content)?;
    let notebook = resolve_notebook(memo_file, request.notebook)?;
    let notebook_path = PathBuf::from(&notebook.path);
    if !notebook_path.is_dir() {
        return Err(format!("notebook path is unavailable: {}", notebook.path));
    }

    let relative_output = Path::new(MINDMAP_OUTPUT_DIRECTORY);
    if !is_safe_relative_path(relative_output) {
        return Err("plugin output directory is invalid".to_string());
    }
    let output_dir = notebook_path.join(relative_output);
    std::fs::create_dir_all(&output_dir)
        .map_err(|error| format!("create plugin output directory: {error}"))?;
    let canonical_notebook = notebook_path
        .canonicalize()
        .map_err(|error| format!("resolve notebook path: {error}"))?;
    let canonical_output = output_dir
        .canonicalize()
        .map_err(|error| format!("resolve plugin output directory: {error}"))?;
    if !canonical_output.starts_with(&canonical_notebook) {
        return Err("plugin output directory escaped notebook root".to_string());
    }
    let artifact_path = output_file_path(&output_dir, &parsed.title);
    let artifact_document =
        artifact_document(&parsed.content, request.producer, request.source_note);
    atomic_write_bytes(&artifact_path, artifact_document.as_bytes())
        .map_err(|error| format!("write plugin artifact: {error}"))?;

    let relative_path = artifact_path
        .strip_prefix(&notebook_path)
        .map_err(|_| "plugin artifact escaped notebook root".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let now = chrono::Local::now().to_rfc3339();
    let pointer = PluginArtifactPointer {
        path: relative_path,
        format: "markdown".to_string(),
        parser: MINDMAP_PARSER.to_string(),
        renderer: MINDMAP_RENDERER.to_string(),
        title: parsed.title.clone(),
        content_hash: format!("sha256:{:x}", Sha256::digest(parsed.content.as_bytes())),
        created_at: now,
        source_note: request
            .source_note
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    };
    let pointer_body = pointer_document(&pointer)?;
    let created = MemoService::new(memo_file)
        .create_external_memo_named(&notebook.id, &parsed.title, &pointer_body)
        .map_err(|error| {
            let _ = std::fs::remove_file(&artifact_path);
            format!("create plugin document: {error}")
        })?;

    Ok(CreatedPluginArtifact {
        ok: true,
        action: "pluginArtifactCreated",
        plugin_id: MINDMAP_PLUGIN_ID.to_string(),
        note_id: created.memo.id,
        notebook_id: notebook.id,
        notebook: notebook.name,
        title: parsed.title,
        renderer: MINDMAP_RENDERER.to_string(),
        artifact_path: artifact_path.to_string_lossy().to_string(),
        note_path: created.path.to_string_lossy().to_string(),
    })
}

fn resolve_notebook(memo_file: &MemoFile, key: &str) -> Result<NotebookConfig, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("plugin create requires a notebook name, id, or path".to_string());
    }
    let notebooks = memo_file
        .read_notebook_configs()
        .map_err(|error| format!("read notebooks: {error}"))?;
    notebooks
        .into_iter()
        .find(|notebook| {
            notebook.id == key
                || notebook.name == key
                || paths_equal(Path::new(&notebook.path), Path::new(key))
        })
        .ok_or_else(|| format!("notebook not found: {key}"))
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    if !right.is_absolute() {
        return false;
    }
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn is_safe_relative_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

fn output_file_path(output_dir: &Path, title: &str) -> PathBuf {
    let safe_title = title
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .take(60)
        .collect::<String>();
    output_dir.join(format!(
        "{}-{}-{}.md",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        if safe_title.is_empty() {
            "mindmap"
        } else {
            &safe_title
        },
        &uuid::Uuid::new_v4().to_string()[..8]
    ))
}

fn artifact_document(content: &str, producer: &str, source_note: Option<&str>) -> String {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ArtifactMetadata<'a> {
        flowix_plugin: &'a str,
        plugin_version: &'a str,
        agent_type: &'a str,
        created_at: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        source_note: Option<&'a str>,
    }

    let source_note = source_note.map(str::trim).filter(|value| !value.is_empty());
    let producer = producer.trim();
    let metadata = ArtifactMetadata {
        flowix_plugin: MINDMAP_PLUGIN_ID,
        plugin_version: MINDMAP_VERSION,
        agent_type: if producer.is_empty() {
            "agent-cli"
        } else {
            producer
        },
        created_at: chrono::Local::now().to_rfc3339(),
        source_note,
    };
    let yaml = serde_yaml::to_string(&metadata).expect("artifact metadata is serializable");
    format!("---\n{yaml}---\n\n{content}\n")
}

fn pointer_document(pointer: &PluginArtifactPointer) -> Result<String, String> {
    let frontmatter = PluginNoteFrontmatter {
        flowix_note_type: MINDMAP_NOTE_TYPE.to_string(),
        flowix_plugin: MINDMAP_PLUGIN_ID.to_string(),
        flowix_plugin_version: MINDMAP_VERSION.to_string(),
        flowix_artifact: pointer.clone(),
    };
    let yaml = serde_yaml::to_string(&frontmatter)
        .map_err(|error| format!("serialize plugin document: {error}"))?;
    Ok(format!("---\n{yaml}---\n"))
}

#[cfg(test)]
mod tests {
    use super::{create_artifact, parse_mindmap_input, CreateArtifactRequest};
    use flowix_core::memo_file::{MemoFile, NotebookConfig};
    use std::path::Path;

    #[test]
    fn accepts_one_root() {
        let parsed = parse_mindmap_input("# Root\n\n## Branch\n- Leaf\n").unwrap();
        assert_eq!(parsed.title, "Root");
    }

    #[test]
    fn rejects_multiple_roots_and_explanation() {
        assert!(parse_mindmap_input("# One\n# Two").is_err());
        assert!(parse_mindmap_input("Here it is\n# Root").is_err());
    }

    #[test]
    fn creates_artifact_and_external_pointer_note() {
        let temp = tempfile::tempdir().unwrap();
        let notebook_path = temp.path().join("notes");
        std::fs::create_dir_all(&notebook_path).unwrap();
        let memo_file = MemoFile::new(temp.path().join("config"));
        memo_file
            .write_notebook_configs(&[NotebookConfig {
                id: "work".to_string(),
                name: "Work Notes".to_string(),
                icon: None,
                path: format!("{}/", notebook_path.display()),
                is_default: true,
                sort: 0,
                created_at: 1,
                updated_at: 1,
            }])
            .unwrap();

        let created = create_artifact(
            &memo_file,
            CreateArtifactRequest {
                plugin_id: "mindmap",
                notebook: notebook_path.to_str().unwrap(),
                content: "# Product Plan\n\n## Goals\n- Reliable tools\n",
                source_note: Some("source.md"),
                producer: "codex",
            },
        )
        .unwrap();

        assert!(Path::new(&created.artifact_path).is_file());
        assert!(Path::new(&created.note_path).is_file());
        let artifact = std::fs::read_to_string(&created.artifact_path).unwrap();
        assert!(artifact.contains("flowixPlugin: mindmap"));
        assert!(artifact.contains("agentType: codex"));
        assert!(artifact.contains("# Product Plan"));
        let pointer = std::fs::read_to_string(&created.note_path).unwrap();
        assert!(pointer.contains("flowix_note_type: mindmap"));
        assert!(pointer.contains("renderer: markmap"));
        assert_eq!(
            memo_file.read_all_memos_for_notebook_id(Some("work")).len(),
            1
        );
    }
}
