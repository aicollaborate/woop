use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::manifest::PluginParser;
use super::PluginDescriptor;

#[derive(Debug, Clone)]
pub(super) struct ParsedPluginOutput {
    pub(super) content: String,
    pub(super) title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PluginArtifactPointer {
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
pub(super) struct PluginNoteFrontmatter {
    pub flowix_note_type: String,
    pub flowix_plugin: String,
    pub flowix_plugin_version: String,
    pub flowix_artifact: PluginArtifactPointer,
}

pub(super) fn parse_plugin_output(
    plugin: &PluginDescriptor,
    raw: &str,
) -> Result<ParsedPluginOutput, String> {
    match plugin.definition.parser {
        PluginParser::MindmapMarkdown => parse_mindmap_markdown(raw),
        PluginParser::Markdown => parse_markdown(raw),
        PluginParser::Json => parse_json(raw),
        PluginParser::Html => parse_html(raw),
        PluginParser::Text => parse_text(raw),
    }
}

fn normalize_output(raw: &str) -> String {
    raw.trim().replace("\r\n", "\n")
}

fn strip_code_fence(raw: &str) -> Result<String, String> {
    let content = normalize_output(raw);
    let Some(start) = content.find("```") else {
        return Ok(content);
    };
    let after_open = content[start..]
        .find('\n')
        .map(|offset| start + offset + 1)
        .ok_or_else(|| "plugin response has an invalid code fence".to_string())?;
    let relative_end = content[after_open..]
        .find("```")
        .ok_or_else(|| "plugin response has an unclosed code fence".to_string())?;
    Ok(content[after_open..after_open + relative_end]
        .trim()
        .to_string())
}

fn title_from_content(content: &str, fallback: &str) -> String {
    content
        .lines()
        .find(|line| line.trim_start().starts_with("# "))
        .map(|line| line.trim_start_matches('#').trim().to_string())
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

pub(super) fn parse_mindmap_markdown(raw: &str) -> Result<ParsedPluginOutput, String> {
    let mut content = strip_code_fence(raw)?;
    let root_start = content
        .lines()
        .position(|line| line.trim_start().starts_with("# "))
        .ok_or_else(|| "mindmap response must contain a level-one heading".to_string())?;
    content = content
        .lines()
        .skip(root_start)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    if content.len() > 200_000 {
        return Err("mindmap response is too large".to_string());
    }
    let title = title_from_content(&content, "mindmap");
    Ok(ParsedPluginOutput { content, title })
}

fn parse_markdown(raw: &str) -> Result<ParsedPluginOutput, String> {
    let content = strip_code_fence(raw)?;
    if content.is_empty() {
        return Err("plugin markdown output is empty".to_string());
    }
    if content.len() > 200_000 {
        return Err("plugin markdown output is too large".to_string());
    }
    let title = title_from_content(&content, "output");
    Ok(ParsedPluginOutput { content, title })
}

pub(super) fn parse_json(raw: &str) -> Result<ParsedPluginOutput, String> {
    let content = strip_code_fence(raw)?;
    let value = serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|error| format!("plugin output is invalid JSON: {error}"))?;
    let content = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("format plugin JSON output: {error}"))?;
    let title = value
        .get("title")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("JSON output")
        .to_string();
    Ok(ParsedPluginOutput { content, title })
}

pub(super) fn parse_html(raw: &str) -> Result<ParsedPluginOutput, String> {
    let content = normalize_output(raw);
    if content.is_empty() {
        return Err("plugin HTML output is empty".to_string());
    }
    if content.len() > 1_000_000 {
        return Err("plugin HTML output is too large".to_string());
    }
    Ok(ParsedPluginOutput {
        content,
        title: "HTML output".to_string(),
    })
}

fn parse_text(raw: &str) -> Result<ParsedPluginOutput, String> {
    let content = normalize_output(raw);
    if content.is_empty() {
        return Err("plugin output is empty".to_string());
    }
    if content.len() > 1_000_000 {
        return Err("plugin output is too large".to_string());
    }
    Ok(ParsedPluginOutput {
        content,
        title: "Plugin output".to_string(),
    })
}

#[cfg(test)]
pub(super) fn clean_markdown(raw: &str) -> Result<String, String> {
    parse_mindmap_markdown(raw).map(|parsed| parsed.content)
}

pub(super) fn output_extension(extension: &str) -> String {
    let trimmed = extension.trim();
    if trimmed.is_empty() {
        String::new()
    } else if trimmed.starts_with('.') {
        trimmed.to_string()
    } else {
        format!(".{trimmed}")
    }
}

pub(super) fn output_file_path(output_dir: &Path, title: &str, extension: &str) -> PathBuf {
    let safe_title: String = title
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .take(60)
        .collect();
    let now = chrono::Local::now();
    output_dir.join(format!(
        "{}-{}-{}{}",
        now.format("%Y%m%d-%H%M%S"),
        if safe_title.is_empty() {
            "output"
        } else {
            &safe_title
        },
        &uuid::Uuid::new_v4().to_string()[..8],
        output_extension(extension)
    ))
}

pub(super) fn artifact_document(
    plugin: &PluginDescriptor,
    clean: &str,
    agent_type: &str,
    source_note: Option<&str>,
) -> String {
    if plugin.manifest.output.format != "markdown" {
        return clean.to_string();
    }
    let source_note_line = source_note
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!("sourceNote: {value}\n"))
        .unwrap_or_default();
    format!(
        "---\nflowixPlugin: {}\npluginVersion: {}\nagentType: {}\ncreatedAt: {}\n{}---\n\n{}\n",
        plugin.manifest.id,
        plugin.manifest.version,
        agent_type,
        chrono::Local::now().to_rfc3339(),
        source_note_line,
        clean,
    )
}

pub(super) fn pointer_document(
    plugin: &PluginDescriptor,
    pointer: &PluginArtifactPointer,
) -> Result<String, String> {
    let frontmatter = PluginNoteFrontmatter {
        flowix_note_type: plugin.definition.note_type.clone(),
        flowix_plugin: plugin.manifest.id.clone(),
        flowix_plugin_version: plugin.manifest.version.clone(),
        flowix_artifact: pointer.clone(),
    };
    let yaml = serde_yaml::to_string(&frontmatter)
        .map_err(|error| format!("serialize plugin note metadata: {error}"))?;
    Ok(format!("---\n{yaml}---\n"))
}

#[cfg(test)]
mod tests {
    use super::{clean_markdown, pointer_document, PluginArtifactPointer};
    use crate::plugin::manifest::{validate_manifest, PluginManifest};
    use crate::plugin::{PluginDescriptor, MINDMAP_MANIFEST};

    #[test]
    fn cleans_markdown_code_fence() {
        assert_eq!(
            clean_markdown("```markdown\n# Root\n\n## Child\n```").unwrap(),
            "# Root\n\n## Child"
        );
    }

    #[test]
    fn serializes_pointer_metadata_as_frontmatter_only() {
        let manifest: PluginManifest = serde_json::from_str(MINDMAP_MANIFEST).unwrap();
        let definition = validate_manifest(&manifest).unwrap();
        let plugin = PluginDescriptor {
            manifest,
            installed_path: "/tmp/mindmap".to_string(),
            skill: String::new(),
            is_system: true,
            definition,
        };
        let pointer = PluginArtifactPointer {
            path: ".plugin-output/mindmap/output.md".to_string(),
            format: "markdown".to_string(),
            parser: "mindmap-markdown".to_string(),
            renderer: "markmap".to_string(),
            title: "Roadmap".to_string(),
            content_hash: "sha256:abc".to_string(),
            created_at: "2026-08-13T00:00:00Z".to_string(),
            source_note: None,
        };
        let document = pointer_document(&plugin, &pointer).unwrap();
        assert!(document.starts_with("---\nflowix_note_type: mindmap\n"));
        assert!(document.ends_with("---\n"));
        assert!(!document.contains("# Roadmap"));
    }
}
