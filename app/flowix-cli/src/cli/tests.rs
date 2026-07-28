//! `parse()` 全分支覆盖 ── 把 CLI 表面契约锁住。
//!
//! 测试的是 **用户感知** 的 arg 解析行为, 不是 cmd_* 函数的具体动作。
//! 后者要 `MemoFile` 真实环境, 在 store.rs 里加 `#[cfg(test)]` 集成测试
//! (需要 tempfile + 临时 notebook) ── 见后续工单。

use super::*;

/// `&[&str]` → `Vec<String>` 助手, 测试代码更紧凑。
fn parse_args(args: &[&str]) -> Result<Option<Cli>, CliError> {
    parse(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>())
}

fn assert_err_contains(err: &CliError, needle: &str) {
    let msg = err.to_string();
    assert!(
        msg.contains(needle),
        "error message `{msg}` does not contain `{needle}`"
    );
}

// ===== Help / Version =====

#[test]
fn empty_args_prints_help() {
    // 0 args → 打印 help, 正常退出 (Ok(None) 是 print_help 路径)
    assert!(matches!(parse_args(&[]), Ok(None)));
}

#[test]
fn help_variants() {
    for flag in ["--help", "-h", "help"] {
        assert!(
            matches!(parse_args(&[flag]), Ok(None)),
            "`{flag}` should print help"
        );
    }
}

#[test]
fn version_variants() {
    for flag in ["--version", "-V"] {
        assert!(
            matches!(parse_args(&[flag]), Ok(Some(Cli::Version))),
            "`{flag}` should return Cli::Version"
        );
    }
}

// ===== Notebooks =====

#[test]
fn notebooks_basic_and_alias() {
    assert!(matches!(
        parse_args(&["notebooks"]),
        Ok(Some(Cli::Notebooks { json: false }))
    ));
    assert!(matches!(
        parse_args(&["nb"]),
        Ok(Some(Cli::Notebooks { json: false }))
    ));
}

#[test]
fn notebooks_json_anywhere() {
    // --json 在 verb 前 / 后 / -j 短选项, 都应被识别
    assert!(matches!(
        parse_args(&["notebooks", "--json"]),
        Ok(Some(Cli::Notebooks { json: true }))
    ));
    assert!(matches!(
        parse_args(&["--json", "notebooks"]),
        Ok(Some(Cli::Notebooks { json: true }))
    ));
    assert!(matches!(
        parse_args(&["-j", "notebooks"]),
        Ok(Some(Cli::Notebooks { json: true }))
    ));
}

#[test]
fn notebook_alias_removed() {
    // 旧别名 `notebook` (单数) 已删除, 应该报 unknown command
    let err = parse_args(&["notebook"]).unwrap_err();
    assert_err_contains(&err, "unknown command");
    assert_eq!(err.exit_code(), 2);
}

// ===== List =====

#[test]
fn list_basic_and_alias() {
    assert!(matches!(
        parse_args(&["list", "Default Notebook"]),
        Ok(Some(Cli::List {
            notebook,
            json: false,
        })) if notebook == "Default Notebook"
    ));
    assert!(matches!(
        parse_args(&["ls", "Default Notebook"]),
        Ok(Some(Cli::List {
            notebook,
            json: false,
        })) if notebook == "Default Notebook"
    ));
}

#[test]
fn list_missing_arg_errors() {
    let err = parse_args(&["list"]).unwrap_err();
    assert_err_contains(&err, "usage:");
    assert_eq!(err.exit_code(), 2);
}

// ===== Show =====

#[test]
fn show_basic_and_alias() {
    assert!(matches!(
        parse_args(&["show", "abc123"]),
        Ok(Some(Cli::Show { id, json: false })) if id == "abc123"
    ));
    assert!(matches!(
        parse_args(&["s", "abc123"]),
        Ok(Some(Cli::Show { id, json: false })) if id == "abc123"
    ));
}

#[test]
fn show_missing_arg_errors() {
    let err = parse_args(&["show"]).unwrap_err();
    assert_err_contains(&err, "usage:");
    assert_eq!(err.exit_code(), 2);
}

// ===== Create =====

#[test]
fn create_basic_and_aliases() {
    // 主命令 `create` + 旧别名 `new` + 短别名 `c` 都工作
    for verb in ["create", "new", "c"] {
        assert!(
            matches!(
                parse_args(&[verb, "Default Notebook"]),
                Ok(Some(Cli::Create {
                    notebook,
                    json: false,
                })) if notebook == "Default Notebook"
            ),
            "`{verb}` should be a valid alias for create"
        );
    }
}

#[test]
fn create_missing_arg_errors() {
    for verb in ["create", "new", "c"] {
        let err = parse_args(&[verb]).unwrap_err();
        assert_err_contains(&err, "usage:");
        assert_eq!(err.exit_code(), 2);
    }
}

#[test]
fn create_extra_positional_errors() {
    // 多余位置参数 (旧 `new <nb> name` 走编辑器的用法) 现在严格拒绝
    let err = parse_args(&["create", "Default Notebook", "extra"]).unwrap_err();
    assert_err_contains(&err, "usage:");
    assert_err_contains(&err, "no extra positional args");
    assert_eq!(err.exit_code(), 2);
}

#[test]
fn create_dash_suffix_no_longer_special() {
    // 旧 `new <nb> -` 用法已废, `-` 现在被当 notebook 名, 但仍走 stdin
    assert!(matches!(
        parse_args(&["create", "-"]),
        Ok(Some(Cli::Create {
            notebook,
            json: false,
        })) if notebook == "-"
    ));
}

// ===== Delete =====

#[test]
fn delete_basic_and_alias() {
    assert!(matches!(
        parse_args(&["delete", "abc123"]),
        Ok(Some(Cli::Delete { id, json: false })) if id == "abc123"
    ));
    assert!(matches!(
        parse_args(&["rm", "abc123"]),
        Ok(Some(Cli::Delete { id, json: false })) if id == "abc123"
    ));
}

#[test]
fn delete_missing_arg_errors() {
    let err = parse_args(&["delete"]).unwrap_err();
    assert_err_contains(&err, "usage:");
    assert_eq!(err.exit_code(), 2);
}

// ===== Edit (B 风格: --old / --new) =====

#[test]
fn edit_basic_old_and_new_long() {
    assert!(matches!(
        parse_args(&["edit", "abc123", "--old", "foo", "--new", "bar"]),
        Ok(Some(Cli::Edit {
            id,
            old: Some(o),
            new: Some(n),
            new_from_stdin: false,
            dry_run: false,
            json: false,
        })) if id == "abc123" && o == "foo" && n == "bar"
    ));
}

#[test]
fn edit_joins_split_old_and_new_values() {
    assert!(matches!(
        parse_args(&[
            "edit", "abc123", "--old", "line", "A:", "original", "alpha", "--new", "line",
            "A:", "EDITED", "alpha"
        ]),
        Ok(Some(Cli::Edit {
            id,
            old: Some(o),
            new: Some(n),
            ..
        })) if id == "abc123" && o == "line A: original alpha" && n == "line A: EDITED alpha"
    ));
}

#[test]
fn edit_alias_e() {
    assert!(matches!(
        parse_args(&["e", "abc123", "-o", "foo", "-n", "bar"]),
        Ok(Some(Cli::Edit {
            id,
            old: Some(o),
            new: Some(n),
            ..
        })) if id == "abc123" && o == "foo" && n == "bar"
    ));
}

#[test]
fn edit_short_flags() {
    assert!(matches!(
        parse_args(&["edit", "id", "-o", "x", "-n", "y"]),
        Ok(Some(Cli::Edit {
            old: Some(o),
            new: Some(n),
            ..
        })) if o == "x" && n == "y"
    ));
}

#[test]
fn edit_new_stdin_flag() {
    assert!(matches!(
        parse_args(&["edit", "id", "--old", "foo", "--new-stdin"]),
        Ok(Some(Cli::Edit {
            old: Some(o),
            new: None,
            new_from_stdin: true,
            ..
        })) if o == "foo"
    ));
}

#[test]
fn edit_json_flag() {
    assert!(matches!(
        parse_args(&["edit", "id", "--old", "x", "--new", "y", "--json"]),
        Ok(Some(Cli::Edit { json: true, .. }))
    ));
}

#[test]
fn edit_dry_run_flag() {
    assert!(matches!(
        parse_args(&["edit", "id", "--old", "x", "--new", "y", "--dry-run"]),
        Ok(Some(Cli::Edit { dry_run: true, .. }))
    ));
}

#[test]
fn edit_missing_id_errors() {
    let err = parse_args(&["edit"]).unwrap_err();
    assert_err_contains(&err, "usage:");
    assert_err_contains(&err, "--old");
    assert_eq!(err.exit_code(), 2);
}

#[test]
fn edit_missing_old_errors() {
    // parse 层只校验 id 存在, --old 缺失由 cmd_edit 阶段报错
    // (parse 不能区分 "后面会从 stdin 给" 还是 "真的漏了")
    assert!(matches!(
        parse_args(&["edit", "abc123"]),
        Ok(Some(Cli::Edit { id, old: None, .. })) if id == "abc123"
    ));
}

#[test]
fn edit_old_missing_value_errors() {
    let err = parse_args(&["edit", "id", "--old"]).unwrap_err();
    assert_err_contains(&err, "--old/-o requires a value");
    assert_eq!(err.exit_code(), 2);
    let err = parse_args(&["edit", "id", "-o"]).unwrap_err();
    assert_err_contains(&err, "--old/-o requires a value");
}

#[test]
fn edit_new_missing_value_errors() {
    let err = parse_args(&["edit", "id", "--old", "x", "--new"]).unwrap_err();
    assert_err_contains(&err, "--new/-n requires a value");
    assert_eq!(err.exit_code(), 2);
}

#[test]
fn edit_unknown_flag_errors() {
    let err = parse_args(&["edit", "id", "--old", "x", "--new", "y", "--foo"]).unwrap_err();
    assert_err_contains(&err, "edit: unknown arg `--foo`");
    assert_eq!(err.exit_code(), 2);
}

#[test]
fn edit_old_with_stdin_combo_works() {
    // --old 参数 + --new-stdin 都合法, parse 不互斥
    assert!(matches!(
        parse_args(&["edit", "id", "-o", "x", "--new-stdin"]),
        Ok(Some(Cli::Edit {
            old: Some(o),
            new: None,
            new_from_stdin: true,
            ..
        })) if o == "x"
    ));
}

// ===== Write =====

#[test]
fn write_basic_and_alias() {
    assert!(matches!(
        parse_args(&["write", "abc123"]),
        Ok(Some(Cli::Write { id, json: false })) if id == "abc123"
    ));
    assert!(matches!(
        parse_args(&["w", "abc123"]),
        Ok(Some(Cli::Write { id, json: false })) if id == "abc123"
    ));
}

#[test]
fn write_missing_arg_errors() {
    let err = parse_args(&["write"]).unwrap_err();
    assert_err_contains(&err, "usage:");
    assert_eq!(err.exit_code(), 2);
}

// ===== Search =====

#[test]
fn search_basic() {
    assert!(matches!(
        parse_args(&["search", "TODO"]),
        Ok(Some(Cli::Search {
            query,
            notebook: None,
            limit: 20,
            json: false,
        })) if query == "TODO"
    ));
}

#[test]
fn search_alias_q() {
    assert!(matches!(
        parse_args(&["q", "TODO"]),
        Ok(Some(Cli::Search { query, .. })) if query == "TODO"
    ));
}

#[test]
fn search_with_notebook_long_and_short() {
    // --notebook / -b 都接受, json flag 可以插在中间
    assert!(matches!(
        parse_args(&["search", "TODO", "--notebook", "work"]),
        Ok(Some(Cli::Search {
            query,
            notebook: Some(nb),
            limit: 20,
            ..
        })) if query == "TODO" && nb == "work"
    ));
    assert!(matches!(
        parse_args(&["search", "--json", "TODO", "-b", "work"]),
        Ok(Some(Cli::Search {
            notebook: Some(nb),
            json: true,
            ..
        })) if nb == "work"
    ));
}

#[test]
fn search_with_limit_long_and_short() {
    assert!(matches!(
        parse_args(&["search", "TODO", "--limit", "5"]),
        Ok(Some(Cli::Search { limit: 5, .. }))
    ));
    assert!(matches!(
        parse_args(&["search", "TODO", "-l", "5"]),
        Ok(Some(Cli::Search { limit: 5, .. }))
    ));
}

#[test]
fn search_with_both_flags() {
    assert!(matches!(
        parse_args(&["search", "TODO", "-b", "work", "-l", "3"]),
        Ok(Some(Cli::Search {
            query,
            notebook: Some(nb),
            limit: 3,
            ..
        })) if query == "TODO" && nb == "work"
    ));
}

#[test]
fn search_missing_arg_errors() {
    let err = parse_args(&["search"]).unwrap_err();
    assert_err_contains(&err, "usage:");
    assert_eq!(err.exit_code(), 2);
}

#[test]
fn search_notebook_missing_value_errors() {
    // 旧 bug: --notebook 不带值时静默成 None, 现在严格报错
    let err = parse_args(&["search", "TODO", "--notebook"]).unwrap_err();
    assert_err_contains(&err, "--notebook/-b requires a value");
    assert_eq!(err.exit_code(), 2);
    let err = parse_args(&["search", "TODO", "-b"]).unwrap_err();
    assert_err_contains(&err, "--notebook/-b requires a value");
}

#[test]
fn search_limit_non_integer_errors() {
    let err = parse_args(&["search", "TODO", "--limit", "abc"]).unwrap_err();
    assert_err_contains(&err, "positive integer");
    assert_err_contains(&err, "`abc`");
    assert_eq!(err.exit_code(), 2);
}

#[test]
fn search_limit_zero_errors() {
    let err = parse_args(&["search", "TODO", "--limit", "0"]).unwrap_err();
    assert_err_contains(&err, "positive integer");
    assert_eq!(err.exit_code(), 2);
}

#[test]
fn search_limit_missing_value_errors() {
    let err = parse_args(&["search", "TODO", "--limit"]).unwrap_err();
    assert_err_contains(&err, "--limit/-l requires a value");
    assert_eq!(err.exit_code(), 2);
}

#[test]
fn search_unknown_flag_errors() {
    let err = parse_args(&["search", "TODO", "--foo"]).unwrap_err();
    assert_err_contains(&err, "unknown arg `--foo`");
    assert_eq!(err.exit_code(), 2);
}

#[test]
fn search_old_n_alias_no_longer_valid() {
    // 修复 B: search 短选项 -n 已改为 -b, 旧 -n 应该是 unknown arg
    let err = parse_args(&["search", "TODO", "-n", "work"]).unwrap_err();
    assert_err_contains(&err, "unknown arg `-n`");
    assert_eq!(err.exit_code(), 2);
}

// ===== Completion =====

#[test]
fn completion_basic() {
    assert!(matches!(
        parse_args(&["completion", "bash"]),
        Ok(Some(Cli::Completion { shell })) if shell == "bash"
    ));
}

#[test]
fn completion_missing_arg_errors() {
    let err = parse_args(&["completion"]).unwrap_err();
    assert_err_contains(&err, "usage:");
    assert_eq!(err.exit_code(), 2);
}

// ===== Unknown command =====

#[test]
fn unknown_command_errors() {
    let err = parse_args(&["foo"]).unwrap_err();
    assert_err_contains(&err, "unknown command: `foo`");
    assert_err_contains(&err, "--help");
    assert_eq!(err.exit_code(), 2);
}

// ===== 退出码契约 =====

#[test]
fn exit_codes() {
    // 4 个 CliError 变体各自映射到约定的退出码
    assert_eq!(CliError::Usage("x".into()).exit_code(), 2);
    assert_eq!(CliError::NotFound("x".into()).exit_code(), 3);
    assert_eq!(
        CliError::Io(std::io::Error::new(std::io::ErrorKind::Other, "x")).exit_code(),
        5
    );
    assert_eq!(CliError::Other("x".into()).exit_code(), 1);
}
