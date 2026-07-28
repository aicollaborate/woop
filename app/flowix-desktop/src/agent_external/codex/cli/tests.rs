//! Tests in this module read or write process-global env vars
//! (`PATH`, `CODEX_CLI_PATH`, `CODEX_NODE_PATH`, 鈥?. These
//! mutations are process-wide and are visible to every other test
//! in the binary, so the tests must hold the shared external-agent
//! environment lock for the entire duration of the env access.
//!
//! **Convention:** any test that calls `std::env::var*` /
//! `std::env::set_var` / `std::env::remove_var` (or transitively
//! calls a helper that does) must start with
//!
//! ```ignore
//! let _guard = acquire_env_lock();
//! ```
//!
//! and hold `_guard` for the whole test body. Pure-function tests
//! (e.g. parsers, sort helpers) don't need the lock.
use super::*;
use crate::agent_external::acquire_test_env_lock as acquire_env_lock;

#[test]
fn formats_missing_native_dependency_with_repair_guidance() {
    let message = format_codex_failure(
        "exit status: 1",
        "Error: Missing optional dependency @openai/codex-darwin-x64",
    );

    assert!(message.contains("@openai/codex-darwin-x64"));
    assert!(message.contains("npm install -g @openai/codex@latest --force --include=optional"));
    assert!(message.contains("CODEX_NODE_PATH"));
}

#[test]
fn formats_empty_codex_failure_without_trailing_separator() {
    assert_eq!(
        format_codex_failure("exit status: 1", "  "),
        "Codex CLI exited with status exit status: 1"
    );
}

#[test]
fn normalizes_supported_permission_modes() {
    assert_eq!(
        normalized_permission_mode(Some("read-only")),
        Some("read-only")
    );
    assert_eq!(
        normalized_permission_mode(Some("workspace-write")),
        Some("workspace-write")
    );
    assert_eq!(
        normalized_permission_mode(Some("danger-full-access")),
        Some("danger-full-access")
    );
    assert_eq!(normalized_permission_mode(Some("yolo")), Some("yolo"));
    assert_eq!(normalized_permission_mode(Some("inherit")), None);
    assert_eq!(normalized_permission_mode(Some("unknown")), None);
    assert_eq!(normalized_permission_mode(None), None);
}

#[test]
fn normalizes_codex_model_override() {
    assert_eq!(
        normalized_codex_model(Some("gpt-5.5")).as_deref(),
        Some("gpt-5.5")
    );
    assert_eq!(normalized_codex_model(Some(" inherit ")), None);
    assert_eq!(normalized_codex_model(Some("")), None);
    assert_eq!(normalized_codex_model(None), None);
}

#[test]
fn normalizes_reasoning_effort_override() {
    assert_eq!(normalized_reasoning_effort(Some("low")), Some("low"));
    assert_eq!(normalized_reasoning_effort(Some("medium")), Some("medium"));
    assert_eq!(normalized_reasoning_effort(Some("high")), Some("high"));
    assert_eq!(normalized_reasoning_effort(Some("xhigh")), Some("xhigh"));
    assert_eq!(normalized_reasoning_effort(Some(" extra-high ")), None);
    assert_eq!(normalized_reasoning_effort(None), None);
}

/// 构造一�?��离的临时�?��，里面放一�?fake `codex` �?��行文件�?    /// �?pid + 一�?��试名后缀避免并�?测试互相串扰�?
#[test]
fn select_session_prefers_hint_over_mapping() {
    let mapped = Some("019f0000-0000-7000-8000-000000000000".to_string());
    // thread_id �?��就是 UUID 形式 �?hint 胜出，无�?SQLite 映射�?
    let session_id = "019f0000-0000-7000-8000-000000000001";
    assert_eq!(
        select_external_session_for_runtime(mapped.clone(), Some(session_id.to_string()))
            .as_deref(),
        Some(session_id)
    );
}

#[test]
fn select_session_falls_back_to_mapping_when_no_hint() {
    let mapped = Some("019f0000-0000-7000-8000-000000000000".to_string());
    // thread_id 不是 UUID 形式 �?�?SQLite 里的映射 (cwd / workspace
    // 一致与否不再参与决策，UI 在�?条消�?���?�?
    assert_eq!(
        select_external_session_for_runtime(mapped.clone(), None),
        mapped
    );
}

#[test]
fn select_session_returns_none_for_brand_new_thread() {
    // 全新 thread：既没映射，thread_id 也不�?UUID �?新建 session�?
    assert_eq!(select_external_session_for_runtime(None, None), None);
}

#[test]
fn new_codex_session_adds_enabled_workspace_dirs() {
    let root = std::env::temp_dir().join(format!(
        "flowix-codex-workspace-test-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
    ));
    let cwd = root.join("primary");
    let secondary = root.join("secondary");
    let third = root.join("third");
    std::fs::create_dir_all(&cwd).expect("create primary dir");
    std::fs::create_dir_all(&secondary).expect("create secondary dir");
    std::fs::create_dir_all(&third).expect("create third dir");

    let workspace_paths = vec![
        cwd.to_string_lossy().to_string(),
        secondary.to_string_lossy().to_string(),
        secondary.to_string_lossy().to_string(),
        root.join("missing").to_string_lossy().to_string(),
        third.to_string_lossy().to_string(),
    ];
    let cmd = build_codex_command(None, &cwd, &workspace_paths, None, None, None);
    let args: Vec<String> = cmd
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect();

    assert!(args
        .windows(2)
        .any(|pair| pair[0] == "-C" && pair[1] == cwd.to_string_lossy()));
    assert_eq!(
        args.windows(2)
            .filter(|pair| pair[0] == "--add-dir")
            .map(|pair| pair[1].clone())
            .collect::<Vec<_>>(),
        vec![
            secondary.to_string_lossy().to_string(),
            third.to_string_lossy().to_string()
        ]
    );

    cleanup(&root);
}

#[test]
fn new_codex_session_reads_prompt_from_stdin_without_dash_argument() {
    let cwd = std::env::temp_dir();
    let workspace_paths = Vec::new();
    let cmd = build_codex_command(None, &cwd, &workspace_paths, None, None, None);
    let args: Vec<String> = cmd
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect();

    assert!(!args.iter().any(|arg| arg == "-"));
    assert!(args.iter().any(|arg| arg == "exec"));
    assert!(args.iter().any(|arg| arg == "--json"));
}

#[test]
fn codex_command_enables_web_search_for_new_and_resumed_sessions() {
    let cwd = std::env::temp_dir();
    for session_id in [None, Some("019f0000-0000-7000-8000-000000000000")] {
        let cmd = build_codex_command(session_id, &cwd, &[], None, None, None);
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let search_index = args
            .iter()
            .position(|arg| arg == "--search")
            .expect("Codex command must enable web search");
        let exec_index = args
            .iter()
            .position(|arg| arg == "exec")
            .expect("Codex command must contain exec");
        assert!(
            search_index < exec_index,
            "--search is a top-level option and must precede exec: {args:?}"
        );
    }
}

#[test]
fn resumed_codex_session_does_not_add_workspace_dirs() {
    let root = std::env::temp_dir().join(format!(
        "flowix-codex-resume-workspace-test-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
    ));
    let cwd = root.join("primary");
    let secondary = root.join("secondary");
    std::fs::create_dir_all(&cwd).expect("create primary dir");
    std::fs::create_dir_all(&secondary).expect("create secondary dir");

    let workspace_paths = vec![secondary.to_string_lossy().to_string()];
    let cmd = build_codex_command(
        Some("019f0000-0000-7000-8000-000000000000"),
        &cwd,
        &workspace_paths,
        None,
        None,
        None,
    );
    let args: Vec<String> = cmd
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect();

    assert!(!args.iter().any(|arg| arg == "-C"));
    assert!(!args.iter().any(|arg| arg == "--add-dir"));

    cleanup(&root);
}

#[test]
fn resumed_codex_session_uses_config_override_instead_of_sandbox_flag() {
    // `codex exec resume` 拒绝 `--sandbox`（exit 2: unexpected argument）�?        // resume �?���?CLI invocation，必须用它支持的 config override 重新
    // 应用 thread card 的权限快照，不能假定首�? turn �?sandbox 会�?恢�?�?
    let root = std::env::temp_dir().join(format!(
        "flowix-codex-resume-sandbox-test-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
    ));
    std::fs::create_dir_all(&root).expect("create temp dir");

    let cmd = build_codex_command(
        Some("019f0000-0000-7000-8000-000000000000"),
        &root,
        &[],
        Some("workspace-write"),
        None,
        None,
    );
    let args: Vec<String> = cmd
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect();

    assert!(
        !args.iter().any(|arg| arg == "--sandbox"),
        "resume argv must not contain --sandbox, got: {:?}",
        args
    );
    assert!(args
        .windows(2)
        .any(|pair| { pair[0] == "-c" && pair[1] == "sandbox_mode=\"workspace-write\"" }));

    cleanup(&root);
}

#[test]
fn resumed_codex_session_reapplies_yolo_permission_mode() {
    let root = std::env::temp_dir().join(format!(
        "flowix-codex-resume-yolo-test-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
    ));
    std::fs::create_dir_all(&root).expect("create temp dir");

    let cmd = build_codex_command(
        Some("019f0000-0000-7000-8000-000000000000"),
        &root,
        &[],
        Some("yolo"),
        None,
        None,
    );
    let args: Vec<String> = cmd
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect();

    assert!(args.iter().any(|arg| arg == "--yolo"));
    assert!(!args.iter().any(|arg| arg == "--sandbox"));
    assert!(!args.iter().any(|arg| arg.starts_with("sandbox_mode=")));

    cleanup(&root);
}

#[test]
fn codex_command_adds_reasoning_effort_override() {
    let cwd = std::env::temp_dir();
    let workspace_paths = Vec::new();
    let cmd = build_codex_command(None, &cwd, &workspace_paths, None, None, Some("xhigh"));
    let args: Vec<String> = cmd
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect();

    assert!(args
        .windows(2)
        .any(|pair| { pair[0] == "-c" && pair[1] == "model_reasoning_effort=\"xhigh\"" }));
}

#[test]
fn codex_command_uses_documented_sandbox_flag() {
    let cwd = std::env::temp_dir();
    let workspace_paths = Vec::new();
    let cmd = build_codex_command(
        None,
        &cwd,
        &workspace_paths,
        Some("workspace-write"),
        None,
        None,
    );
    let args: Vec<String> = cmd
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect();

    assert!(args
        .windows(2)
        .any(|pair| pair[0] == "--sandbox" && pair[1] == "workspace-write"));
}

#[test]
fn codex_command_uses_yolo_flag_for_yolo_permission_mode() {
    let cwd = std::env::temp_dir();
    let workspace_paths = Vec::new();
    let cmd = build_codex_command(None, &cwd, &workspace_paths, Some("yolo"), None, None);
    let args: Vec<String> = cmd
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect();

    assert!(args.iter().any(|arg| arg == "--yolo"));
    assert!(!args.iter().any(|arg| arg == "--sandbox"));
}

#[test]
fn codex_command_attaches_images_for_new_and_resumed_sessions() {
    let root =
        std::env::temp_dir().join(format!("flowix-codex-image-test-{}", std::process::id(),));
    std::fs::create_dir_all(&root).expect("create image test dir");
    let image = root.join("pasted.png");
    std::fs::write(&image, b"png").expect("create image");
    let images = vec![image.to_string_lossy().into_owned()];

    for session_id in [None, Some("019f0000-0000-7000-8000-000000000000")] {
        let cmd =
            build_codex_command_with_images(session_id, &root, &[], None, None, None, &images);
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--image" && pair[1] == images[0]));
    }
    cleanup(&root);
}

#[test]
fn latest_versioned_subdir_prefers_high_major_over_lexicographic() {
    // Older Node left over from a long-ago install. A pure lexicographic
    // sort would compare '8' > '1' and wrongly resolve `swap_remove(last)`
    // to this old v8 directory. The semver-aware sort must pick v20.10.0.
    let parent = std::env::temp_dir().join(format!(
        "flowix-codex-cli-test-semver-major-{}",
        std::process::id(),
    ));
    std::fs::create_dir_all(&parent).expect("create temp dir");
    let v8 = parent.join("v8.17.0");
    let v18 = parent.join("v18.19.0");
    let v20 = parent.join("v20.10.0");
    for d in [&v8, &v18, &v20] {
        std::fs::create_dir_all(d).expect("create version dir");
    }
    // Non-version siblings must not poison the result.
    std::fs::create_dir_all(parent.join("latest")).expect("create latest dir");
    std::fs::create_dir_all(parent.join("current")).expect("create current dir");
    std::fs::write(parent.join("README.md"), "# readme").expect("write readme");

    let picked = latest_versioned_subdir(&parent);

    cleanup(&parent);

    assert_eq!(
        picked,
        Some(v20),
        "expected highest semver v20.10.0; got {:?} (lexicographic sort \
             would wrongly pick v8.17.0 since '8' > '1')",
        picked,
    );
}

#[test]
fn parse_node_version_handles_nvm_fnm_and_asdf_shapes() {
    // nvm / fnm use the `v`-prefixed shape.
    assert_eq!(parse_node_version("v20.10.0"), Some((20, 10, 0)));
    assert_eq!(parse_node_version("v18.19.0"), Some((18, 19, 0)));
    // asdf installs use the unprefixed shape.
    assert_eq!(parse_node_version("18.19.0"), Some((18, 19, 0)));
    // Pre-release suffix is truncated before parsing the leading triple.
    assert_eq!(parse_node_version("v20.0.0-rc.1"), Some((20, 0, 0)),);
    // Junk / non-semver / over-segmented names return None, not garbage.
    assert_eq!(parse_node_version("latest"), None);
    assert_eq!(parse_node_version("current"), None);
    assert_eq!(parse_node_version("v18"), None);
    assert_eq!(parse_node_version("18.19.0.foo"), None);
}

fn make_fake_codex_dir(suffix: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "flowix-codex-cli-test-{}-{}-{}",
        std::process::id(),
        suffix,
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let fake = dir.join("codex");
    std::fs::write(&fake, "#!/bin/sh\nexit 0\n").expect("write fake codex");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&fake).expect("stat fake").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&fake, perms).expect("chmod fake");
    }
    dir
}

fn cleanup(dir: &PathBuf) {
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn resolve_codex_binary_prefers_codex_cli_path_env() {
    let _guard = acquire_env_lock();
    let dir = make_fake_codex_dir("env-override");
    let fake = dir.join("my-codex");
    std::fs::write(&fake, "#!/bin/sh\nexit 0\n").expect("write fake");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&fake).expect("stat fake").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&fake, perms).expect("chmod fake");
    }

    let original = std::env::var_os("CODEX_CLI_PATH");
    std::env::set_var("CODEX_CLI_PATH", &fake);
    let resolved = resolve_codex_binary();
    match original {
        Some(v) => std::env::set_var("CODEX_CLI_PATH", v),
        None => std::env::remove_var("CODEX_CLI_PATH"),
    }
    cleanup(&dir);

    assert_eq!(resolved, fake);
}

#[test]
fn resolve_codex_binary_ignores_missing_codex_cli_path() {
    let _guard = acquire_env_lock();
    let original = std::env::var_os("CODEX_CLI_PATH");
    std::env::set_var(
        "CODEX_CLI_PATH",
        std::env::temp_dir().join("flowix-nonexistent-codex-cli-path"),
    );
    let resolved = resolve_codex_binary();
    match original {
        Some(v) => std::env::set_var("CODEX_CLI_PATH", v),
        None => std::env::remove_var("CODEX_CLI_PATH"),
    }
    assert_ne!(
        resolved,
        std::env::temp_dir().join("flowix-nonexistent-codex-cli-path")
    );
}

#[test]
fn which_codex_finds_binary_in_path() {
    let _guard = acquire_env_lock();
    let dir = make_fake_codex_dir("which-hit");
    let original = std::env::var_os("PATH");
    let sep = if cfg!(windows) { ';' } else { ':' };
    let joined = match &original {
        Some(p) => format!("{}{}{}", dir.display(), sep, p.to_string_lossy()),
        None => dir.display().to_string(),
    };
    std::env::set_var("PATH", joined);
    let result = which_codex();
    match original {
        Some(v) => std::env::set_var("PATH", v),
        None => std::env::remove_var("PATH"),
    }
    cleanup(&dir);

    let found = result.expect("expected to find fake codex in PATH");
    // `which_codex` 直接�?`dir.join("codex")` 返回，不走�?号链接解析；
    // Compare paths directly to avoid macOS /var -> /private/var canonicalization.
    assert_eq!(found, dir.join("codex"));
}

#[test]
fn which_codex_returns_err_when_path_empty() {
    let _guard = acquire_env_lock();
    let original = std::env::var_os("PATH");
    std::env::set_var("PATH", "");
    let result = which_codex();
    match original {
        Some(v) => std::env::set_var("PATH", v),
        None => std::env::remove_var("PATH"),
    }
    assert!(result.is_err());
}

#[cfg(target_os = "macos")]
#[test]
fn codex_candidate_paths_include_chatgpt_app_bundle_cli() {
    assert!(super::super::binary::codex_candidate_paths()
        .iter()
        .any(|path| {
            path == &PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex")
        }));
}

#[cfg(target_os = "macos")]
#[test]
fn resolve_codex_binary_falls_back_to_chatgpt_app_bundle_cli() {
    let _guard = acquire_env_lock();
    let bundled = PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex");
    if !bundled.is_file() {
        return;
    }
    let earlier_executable_candidate = super::super::binary::codex_candidate_paths()
        .into_iter()
        .take_while(|path| path != &bundled)
        .any(|path| is_executable_file(&path));
    if earlier_executable_candidate {
        return;
    }

    let original_path = std::env::var_os("PATH");
    let original_cli_env = std::env::var_os("CODEX_CLI_PATH");
    std::env::set_var("PATH", "");
    std::env::remove_var("CODEX_CLI_PATH");

    let resolved = resolve_codex_binary();

    match original_path {
        Some(v) => std::env::set_var("PATH", v),
        None => std::env::remove_var("PATH"),
    }
    match original_cli_env {
        Some(v) => std::env::set_var("CODEX_CLI_PATH", v),
        None => std::env::remove_var("CODEX_CLI_PATH"),
    }

    assert_eq!(resolved, bundled);
}

fn make_fake_node_dir(suffix: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "flowix-codex-node-test-{}-{}-{}",
        std::process::id(),
        suffix,
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let fake = dir.join("node");
    std::fs::write(&fake, "#!/bin/sh\nexit 0\n").expect("write fake node");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&fake).expect("stat fake").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&fake, perms).expect("chmod fake");
    }
    dir
}

#[test]
fn resolve_node_binary_prefers_codex_node_path_env() {
    let _guard = acquire_env_lock();
    let dir = make_fake_node_dir("env-override");
    let fake = dir.join("node");

    let original = std::env::var_os("CODEX_NODE_PATH");
    std::env::set_var("CODEX_NODE_PATH", &fake);
    let resolved = resolve_node_binary();
    match original {
        Some(v) => std::env::set_var("CODEX_NODE_PATH", v),
        None => std::env::remove_var("CODEX_NODE_PATH"),
    }
    cleanup(&dir);

    assert_eq!(resolved, Some(fake));
}

#[test]
fn resolve_node_binary_finds_node_in_path() {
    let _guard = acquire_env_lock();
    let dir = make_fake_node_dir("path-hit");

    let original_path = std::env::var_os("PATH");
    let original_node_env = std::env::var_os("CODEX_NODE_PATH");
    std::env::remove_var("CODEX_NODE_PATH");
    let sep = if cfg!(windows) { ';' } else { ':' };
    let joined = match &original_path {
        Some(p) => format!("{}{}{}", dir.display(), sep, p.to_string_lossy()),
        None => dir.display().to_string(),
    };
    std::env::set_var("PATH", joined);

    let resolved = resolve_node_binary();

    match original_path {
        Some(v) => std::env::set_var("PATH", v),
        None => std::env::remove_var("PATH"),
    }
    match original_node_env {
        Some(v) => std::env::set_var("CODEX_NODE_PATH", v),
        None => std::env::remove_var("CODEX_NODE_PATH"),
    }
    cleanup(&dir);

    assert_eq!(resolved, Some(dir.join("node")));
}

#[test]
fn resolve_node_binary_falls_back_to_homebrew_path_when_path_empty() {
    let _guard = acquire_env_lock();
    // �?�� macOS / Linux 且文件�实存在的 CI 上验证；开发机一�?���?
    #[cfg(unix)]
    {
        let original_path = std::env::var_os("PATH");
        let original_node_env = std::env::var_os("CODEX_NODE_PATH");
        std::env::remove_var("CODEX_NODE_PATH");
        std::env::set_var("PATH", "");

        let resolved = resolve_node_binary();

        match original_path {
            Some(v) => std::env::set_var("PATH", v),
            None => std::env::remove_var("PATH"),
        }
        match original_node_env {
            Some(v) => std::env::set_var("CODEX_NODE_PATH", v),
            None => std::env::remove_var("CODEX_NODE_PATH"),
        }

        // 命中 /opt/homebrew/bin/node �?/usr/local/bin/node �?/usr/bin/node 之一即可
        if let Some(p) = &resolved {
            assert!(
                p.starts_with("/opt/homebrew/bin/node")
                    || p.starts_with("/usr/local/bin/node")
                    || p.starts_with("/usr/bin/node"),
                "unexpected fallback path: {}",
                p.display()
            );
        }
    }
    #[cfg(not(unix))]
    {
        // Windows �?`node` 通常已经�?PATH，不强制
    }
}

#[test]
fn preflight_codex_returns_friendly_error_when_no_node() {
    let _guard = acquire_env_lock();
    let original_path = std::env::var_os("PATH");
    let original_node_env = std::env::var_os("CODEX_NODE_PATH");
    let original_cli_env = std::env::var_os("CODEX_CLI_PATH");
    std::env::remove_var("CODEX_NODE_PATH");
    std::env::set_var("PATH", "");
    // �?codex 指向一�?���?��存在�?.js，�? needs_node=true �?node 找不�?
    std::env::set_var(
        "CODEX_CLI_PATH",
        std::env::temp_dir().join("flowix-preflight-nonexistent-codex.js"),
    );

    let result = preflight_codex();

    match original_path {
        Some(v) => std::env::set_var("PATH", v),
        None => std::env::remove_var("PATH"),
    }
    match original_node_env {
        Some(v) => std::env::set_var("CODEX_NODE_PATH", v),
        None => std::env::remove_var("CODEX_NODE_PATH"),
    }
    match original_cli_env {
        Some(v) => std::env::set_var("CODEX_CLI_PATH", v),
        None => std::env::remove_var("CODEX_CLI_PATH"),
    }

    // 在�?�?node 的开发机上（包括 CI）会通过；这里只�?��"错�?信息包含指引"�?通过"
    if let Err(msg) = result {
        assert!(
            msg.contains("Node.js"),
            "error should mention Node.js, got: {msg}"
        );
        assert!(
            msg.contains("CODEX_NODE_PATH") || msg.contains("nodejs.org"),
            "error should point to a fix path, got: {msg}"
        );
    }
}
