//! `parse_open_target` —�?URL / 物理�?�� 解析�?[`OpenTarget`]�?//!
//! **�?���? 无副作用**: 不查磁盘, 不�?配置�?重�?跑零成本, 单测全栈覆盖�?//!
//! ## URL scheme 璁捐
//!
//! - `flowix://memo/<memo-id>`              —主�?场景
//! - `flowix://open?path=<encoded-abs>`     —物理�?�� (内部�?id)
//! - `file://<abs>`                          —物理�?���?URL 形式 (兼�? macOS Finder 复制)
//! - 裸绝对路�?(�?`/` 开�?               —物理�?��直传
//!
//! ## memo id 鏍煎紡绾︽潫
//!
//! memo id 格式: 兼�?�?6 字�?或当�?[`flowix_core::memo_file::MEMO_ID_LENGTH`]
//! 字�?, 字�?集为 `[0-9a-z]`�?
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 解析后、待�?���?打开请求"�?不绑定具�?notebook / memo, �?���?/// "用户想打开什�?�?resolver 层再查�?�?/ memo index 落到具体 notebook�?
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    rename_all = "camelCase",
    tag = "kind",
    rename_all_fields = "snake_case"
)]
pub enum OpenTarget {
    /// 物理�?�� —�?memo index �?���?notebook 找匹配的 .md�?
    PhysicalPath {
        path: String,
        memo_id: Option<String>,
    },
    /// 深链 `flowix://...` —memo_id �?��局�?��主键�?
    DeepLink {
        url: String,
        memo_id: Option<String>,
        /// `flowix://open?path=` 时携�?
        physical_path: Option<String>,
    },
}

#[derive(Debug, Error, Serialize)]
pub enum OpenTargetError {
    #[error("empty input")]
    Empty,
    #[error("invalid memo id: {0}")]
    InvalidMemoId(String),
    #[error("unknown route: {0}")]
    UnknownRoute(String),
    #[error("missing path query parameter")]
    MissingPath,
}

/// memo id: �?6 字�?或当�?MEMO_ID_LENGTH 字�?, 字�?�?`[0-9a-z]`�?
pub fn is_valid_memo_id(s: &str) -> bool {
    matches!(s.len(), 6 | flowix_core::memo_file::MEMO_ID_LENGTH)
        && s.chars()
            .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
}

fn percent_decode(s: &str) -> String {
    // 兜底: JS �?url.pathname 已经 percent-decode 大部�? 后�? url crate �?
    // query 时也会解, 这里再做一道�?裸字符串鲁�?�?失败按原值返回�?
    percent_decode_strict(s).unwrap_or_else(|| s.to_string())
}

fn percent_decode_strict(s: &str) -> Option<String> {
    let mut out = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn split_scheme<'a>(raw: &'a str) -> Option<(&'a str, &'a str)> {
    // `flowix://memo/<id>` —�?scheme + 之后部分�?    //   - scheme 部分 (`flowix`) 大小写不敏感 (OS 投递时大小写不固定)
    //   - rest **保留**原大小写 ── memo id �?memo index 里走 `[0-9a-z]`,
    //     任何大写字�?都是无效 id, 直接�?`is_valid_memo_id` 里拒�?
    //     不�?�?lowercase 否则 `flowix://memo/ABCDEF` 会�?�?��为合法�?
    let lower = raw.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("flowix://") {
        // 鍚屾牱鍋忕Щ鍦ㄥ師 `raw` 涓婂彇 rest, 淇濇寔鍘熷ぇ灏忓啓
        let original_rest = &raw[raw.len() - rest.len()..];
        Some(("flowix", original_rest))
    } else {
        None
    }
}

fn split_path_query(rest: &str) -> (String, Vec<(String, String)>) {
    // 简�?query 解析: `?k=v&k=v` �?`[(k, v), ...]`
    // 不依�?url crate (避免引入 'url' 依赖)�?
    match rest.find('?') {
        Some(idx) => {
            let path = rest[..idx].to_string();
            let query = rest[idx + 1..].to_string();
            let pairs: Vec<(String, String)> = query
                .split('&')
                .filter(|s| !s.is_empty())
                .filter_map(|kv| {
                    let mut parts = kv.splitn(2, '=');
                    let k = parts.next()?.to_string();
                    let v = parts.next().unwrap_or("").to_string();
                    Some((percent_decode(&k), percent_decode(&v)))
                })
                .collect();
            (path, pairs)
        }
        None => (rest.to_string(), Vec::new()),
    }
}

fn get_query<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    pairs
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.as_str())
}

/// 解析原�?输入 (URL / 物理�?��) �?[`OpenTarget`]�?
pub fn parse_open_target(raw: &str) -> Result<OpenTarget, OpenTargetError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(OpenTargetError::Empty);
    }

    // 1. `flowix://` 娣遍摼
    if let Some((_, rest)) = split_scheme(trimmed) {
        return parse_deep_link(&rest, trimmed);
    }

    // 2. `file://` 鐗╃悊璺緞 (macOS Finder 澶嶅埗绮樿创甯歌)
    if let Some(rest) = trimmed
        .strip_prefix("file://")
        .or_else(|| trimmed.strip_prefix("file:///"))
    {
        let decoded = percent_decode(rest);
        // v3: 物理 filename 不再�?`#<id>` 后缀, memo_id �?resolver �?        // memo index filename �?id 反查; parser 阶�?无法�?memo_id�?
        return Ok(OpenTarget::PhysicalPath {
            path: decoded,
            memo_id: None,
        });
    }

    // 3. 裸绝对路�?/ 任意字�? (resolver 拒掉非法)
    Ok(OpenTarget::PhysicalPath {
        path: trimmed.to_string(),
        memo_id: None,
    })
}

fn parse_deep_link(rest: &str, full: &str) -> Result<OpenTarget, OpenTargetError> {
    let (path, query) = split_path_query(rest);
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    match segments.as_slice() {
        ["memo", id] => {
            if !is_valid_memo_id(id) {
                return Err(OpenTargetError::InvalidMemoId(id.to_string()));
            }
            Ok(OpenTarget::DeepLink {
                url: full.to_string(),
                memo_id: Some(id.to_string()),
                physical_path: None,
            })
        }
        ["open"] => {
            let path_arg = get_query(&query, "path")
                .ok_or(OpenTargetError::MissingPath)?
                .to_string();
            // v3: 物理 filename 不再�?`#<id>` 后缀, memo_id �?resolver
            // �?memo index filename �?id 反查�?
            Ok(OpenTarget::DeepLink {
                url: full.to_string(),
                memo_id: None,
                physical_path: Some(path_arg),
            })
        }
        _ => Err(OpenTargetError::UnknownRoute(path)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_returns_error() {
        assert!(matches!(parse_open_target(""), Err(OpenTargetError::Empty)));
        assert!(matches!(
            parse_open_target("   "),
            Err(OpenTargetError::Empty)
        ));
    }

    #[test]
    fn parses_deep_link_memo_with_id() {
        let t = parse_open_target("flowix://memo/abc12345").unwrap();
        match t {
            OpenTarget::DeepLink {
                memo_id,
                physical_path,
                ..
            } => {
                assert_eq!(memo_id.as_deref(), Some("abc12345"));
                assert_eq!(physical_path, None);
            }
            _ => panic!("expected DeepLink"),
        }
    }

    #[test]
    fn rejects_invalid_memo_id_length() {
        // 5 位和 7 位都拒绝；旧 6 位和�?8 位都兼�?�?
        let err = parse_open_target("flowix://memo/abc12").unwrap_err();
        assert!(matches!(err, OpenTargetError::InvalidMemoId(_)));
        let err = parse_open_target("flowix://memo/abc1234").unwrap_err();
        assert!(matches!(err, OpenTargetError::InvalidMemoId(_)));
        let err = parse_open_target("flowix://memo/abc123456").unwrap_err();
        assert!(matches!(err, OpenTargetError::InvalidMemoId(_)));
        assert!(parse_open_target("flowix://memo/abc123").is_ok());
        assert!(parse_open_target("flowix://memo/abc12345").is_ok());
    }

    #[test]
    fn rejects_invalid_memo_id_chars() {
        // �?���?/ `_` / `-` 都不�?
        let err = parse_open_target("flowix://memo/ABCDEF").unwrap_err();
        assert!(matches!(err, OpenTargetError::InvalidMemoId(_)));
        let err = parse_open_target("flowix://memo/ab_cde").unwrap_err();
        assert!(matches!(err, OpenTargetError::InvalidMemoId(_)));
    }

    #[test]
    fn parses_open_with_path_query() {
        // v3: 物理 filename 不再�?`#<id>` 后缀, parser 阶�? memo_id = None,
        // resolver �?memo index filename �?id 反查�?
        let t = parse_open_target(
            "flowix://open?path=%2FUsers%2Frop%2FDocuments%2Fflowix%2Fnotebook%2Fhello.md",
        )
        .unwrap();
        match t {
            OpenTarget::DeepLink {
                memo_id,
                physical_path,
                ..
            } => {
                assert_eq!(memo_id, None);
                assert_eq!(
                    physical_path.as_deref(),
                    Some("/Users/rop/Documents/flowix/notebook/hello.md")
                );
            }
            _ => panic!("expected DeepLink"),
        }
    }

    #[test]
    fn parses_file_scheme() {
        // v3: 物理 filename 不再�?`#<id>` 后缀, parser 阶�? memo_id = None�?
        let t = parse_open_target("file:///Users/rop/Documents/flowix/nb/hello.md").unwrap();
        match t {
            OpenTarget::PhysicalPath { path, memo_id } => {
                assert_eq!(path, "/Users/rop/Documents/flowix/nb/hello.md");
                assert_eq!(memo_id, None);
            }
            _ => panic!("expected PhysicalPath"),
        }
    }

    #[test]
    fn parses_raw_absolute_path() {
        // v3: 物理 filename 不再�?`#<id>` 后缀, parser 阶�? memo_id = None�?
        let t = parse_open_target("/Users/rop/Documents/flowix/nb/hello.md").unwrap();
        match t {
            OpenTarget::PhysicalPath { path, memo_id } => {
                assert_eq!(path, "/Users/rop/Documents/flowix/nb/hello.md");
                assert_eq!(memo_id, None);
            }
            _ => panic!("expected PhysicalPath"),
        }
    }

    #[test]
    fn raw_path_without_memo_id_extracts_none() {
        let t = parse_open_target("/Users/rop/Documents/flowix/nb/random.txt").unwrap();
        match t {
            OpenTarget::PhysicalPath { memo_id, .. } => assert_eq!(memo_id, None),
            _ => panic!("expected PhysicalPath"),
        }
    }

    #[test]
    fn unknown_route_returns_error() {
        let err = parse_open_target("flowix://other/abc").unwrap_err();
        assert!(matches!(err, OpenTargetError::UnknownRoute(_)));
    }

    #[test]
    fn memo_id_with_unicode_path() {
        // 物理�?��里含�?��, 必须�?PhysicalPath �?�� (非深�?�?        // v3 �?filename 不再�?`#<id>`, parser 阶�? memo_id = None�?
        let t = parse_open_target("/Users/rop/Documents/flowix/开发待办事�?笔�?.md").unwrap();
        match t {
            OpenTarget::PhysicalPath { path, memo_id } => {
                assert_eq!(path, "/Users/rop/Documents/flowix/开发待办事�?笔�?.md");
                assert_eq!(memo_id, None);
            }
            _ => panic!("expected PhysicalPath"),
        }
    }

    #[test]
    fn case_insensitive_scheme() {
        // macOS / Windows 投递过来的 scheme 大小写不一�? 都�?能解�?
        let t = parse_open_target("FLOWIX://memo/abc12345").unwrap();
        assert!(matches!(t, OpenTarget::DeepLink { .. }));
    }

    #[test]
    fn is_valid_memo_id_strict() {
        assert!(is_valid_memo_id("abc123"));
        assert!(is_valid_memo_id("000000"));
        assert!(is_valid_memo_id("abc12345"));
        assert!(is_valid_memo_id("00000000"));
        assert!(!is_valid_memo_id("ABCDEF"));
        assert!(!is_valid_memo_id("ab_cde"));
        assert!(!is_valid_memo_id("abc12"));
        assert!(!is_valid_memo_id("abc1234"));
        assert!(!is_valid_memo_id("abc123456"));
        assert!(!is_valid_memo_id(""));
    }
}
