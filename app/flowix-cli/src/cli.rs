//! CLI 命令定义与 argv 解析。
//!
//! 执行调度在 `dispatch` 模块，具体 memo 操作在 `store` 模块。

use clap::{Arg, ArgAction, Command};

use crate::errors::CliError;

pub(crate) const DISPLAY_BIN: &str = "flowix";

/// 解析后的 CLI 命令。
#[derive(Debug)]
pub enum Cli {
    Version,
    Notebooks {
        json: bool,
    },
    List {
        notebook: String,
        json: bool,
    },
    Show {
        id: String,
        json: bool,
    },
    Create {
        notebook: String,
        json: bool,
    },
    Delete {
        id: String,
        json: bool,
    },
    Search {
        query: String,
        notebook: Option<String>,
        limit: usize,
        json: bool,
    },
    Edit {
        id: String,
        /// 旧字符串 (精确匹配, 必须唯一)
        old: Option<String>,
        /// 新字符串
        new: Option<String>,
        /// 从 stdin 读 new (避免歧义)
        new_from_stdin: bool,
        dry_run: bool,
        json: bool,
    },
    /// 覆盖整个笔记内容 (从 stdin 读) ── `edit` 的非交互等价物。
    /// 第一行 `# title` 变了 → 自动 rename 物理文件 + 同步 memo index。
    Write {
        id: String,
        json: bool,
    },
    Completion {
        shell: String,
    },
    /// Model Context Protocol over stdio。向外部 Agent 暴露唯一工具
    /// `flowix_memo`，工具参数采用受限的 Flowix CLI 语法。
    Mcp,
}

/// 解析 argv。`Ok(None)` 表示"打印了 help 正常退出"。
pub(crate) fn parse(args: &[String]) -> Result<Option<Cli>, CliError> {
    if args.is_empty() {
        print_help();
        return Ok(None);
    }
    if matches!(
        args.first().map(String::as_str),
        Some("--help" | "-h" | "help")
    ) {
        print_help();
        return Ok(None);
    }
    if matches!(args.first().map(String::as_str), Some("--version" | "-V")) {
        return Ok(Some(Cli::Version));
    }

    preflight_usage_errors(args)?;

    if matches!(first_command(args).as_deref(), Some("edit" | "e")) {
        return parse_edit_command(args).map(Some);
    }

    let argv = std::iter::once(DISPLAY_BIN.to_string())
        .chain(args.iter().cloned())
        .collect::<Vec<_>>();
    let matches = cli_command()
        .try_get_matches_from(argv)
        .map_err(clap_to_cli_error)?;
    let json = matches.get_flag("json");

    match matches.subcommand() {
        Some(("notebooks", _)) => Ok(Some(Cli::Notebooks { json })),
        Some(("list", sub)) => Ok(Some(Cli::List {
            notebook: required_string(sub, "notebook")?,
            json,
        })),
        Some(("show", sub)) => Ok(Some(Cli::Show {
            id: required_string(sub, "id")?,
            json,
        })),
        Some(("create", sub)) => Ok(Some(Cli::Create {
            notebook: required_string(sub, "notebook")?,
            json,
        })),
        Some(("delete", sub)) => Ok(Some(Cli::Delete {
            id: required_string(sub, "id")?,
            json,
        })),
        Some(("edit", sub)) => Ok(Some(Cli::Edit {
            id: required_string(sub, "id")?,
            old: sub.get_one::<String>("old").cloned(),
            new: sub.get_one::<String>("new").cloned(),
            new_from_stdin: sub.get_flag("new-stdin"),
            dry_run: sub.get_flag("dry-run"),
            json,
        })),
        Some(("write", sub)) => Ok(Some(Cli::Write {
            id: required_string(sub, "id")?,
            json,
        })),
        Some(("search", sub)) => {
            let limit = *sub.get_one::<usize>("limit").unwrap_or(&20);
            if limit == 0 {
                return Err(CliError::Usage(
                    "search: --limit/-l requires a positive integer".into(),
                ));
            }
            Ok(Some(Cli::Search {
                query: required_string(sub, "query")?,
                notebook: sub.get_one::<String>("notebook").cloned(),
                limit,
                json,
            }))
        }
        Some(("completion", sub)) => Ok(Some(Cli::Completion {
            shell: required_string(sub, "shell")?,
        })),
        Some(("mcp", _)) => Ok(Some(Cli::Mcp)),
        Some((other, _)) => Err(CliError::Usage(format!(
            "unknown command: `{other}`\n(run `{DISPLAY_BIN} --help` for usage)"
        ))),
        None => {
            print_help();
            Ok(None)
        }
    }
}

pub(crate) fn cli_command() -> Command {
    Command::new(DISPLAY_BIN)
        .disable_help_flag(true)
        .disable_version_flag(true)
        .arg(
            Arg::new("json")
                .long("json")
                .short('j')
                .global(true)
                .action(ArgAction::SetTrue),
        )
        .subcommand_required(true)
        .subcommand(Command::new("notebooks").alias("nb"))
        .subcommand(
            Command::new("list")
                .alias("ls")
                .arg(required_arg("notebook")),
        )
        .subcommand(Command::new("show").alias("s").arg(required_arg("id")))
        .subcommand(
            Command::new("create")
                .alias("new")
                .alias("c")
                .arg(required_arg("notebook")),
        )
        .subcommand(Command::new("delete").alias("rm").arg(required_arg("id")))
        .subcommand(
            Command::new("edit")
                .alias("e")
                .arg(required_arg("id"))
                .arg(Arg::new("old").long("old").short('o').num_args(1))
                .arg(Arg::new("new").long("new").short('n').num_args(1))
                .arg(
                    Arg::new("new-stdin")
                        .long("new-stdin")
                        .action(ArgAction::SetTrue),
                )
                .arg(
                    Arg::new("dry-run")
                        .long("dry-run")
                        .action(ArgAction::SetTrue),
                ),
        )
        .subcommand(Command::new("write").alias("w").arg(required_arg("id")))
        .subcommand(
            Command::new("search")
                .alias("q")
                .arg(required_arg("query"))
                .arg(Arg::new("notebook").long("notebook").short('b').num_args(1))
                .arg(
                    Arg::new("limit")
                        .long("limit")
                        .short('l')
                        .value_parser(clap::value_parser!(usize))
                        .num_args(1),
                ),
        )
        .subcommand(Command::new("completion").arg(required_arg("shell")))
        .subcommand(Command::new("mcp"))
}

fn required_arg(name: &'static str) -> Arg {
    Arg::new(name)
        .required(true)
        .allow_hyphen_values(true)
        .num_args(1)
}

fn required_string(matches: &clap::ArgMatches, name: &str) -> Result<String, CliError> {
    matches
        .get_one::<String>(name)
        .cloned()
        .ok_or_else(|| CliError::Usage(format!("missing required argument `{name}`")))
}

fn clap_to_cli_error(err: clap::Error) -> CliError {
    CliError::Usage(err.to_string())
}

#[allow(
    clippy::collapsible_match,
    reason = "Each command needs a fall-through path after its independent missing-argument check."
)]
fn preflight_usage_errors(args: &[String]) -> Result<(), CliError> {
    let command = first_command(args);
    match command.as_deref() {
        Some("list") | Some("ls") => {
            if command_positionals(args, &["--json", "-j"]).len() == 1 {
                return Err(CliError::Usage(format!(
                    "usage: {DISPLAY_BIN} list <notebook> [--json]"
                )));
            }
        }
        Some("show") | Some("s") => {
            if command_positionals(args, &["--json", "-j"]).len() == 1 {
                return Err(CliError::Usage(format!(
                    "usage: {DISPLAY_BIN} show <id> [--json]"
                )));
            }
        }
        Some("delete") | Some("rm") => {
            if command_positionals(args, &["--json", "-j"]).len() == 1 {
                return Err(CliError::Usage(format!("usage: {DISPLAY_BIN} delete <id>")));
            }
        }
        Some("write") | Some("w") => {
            if command_positionals(args, &["--json", "-j"]).len() == 1 {
                return Err(CliError::Usage(format!(
                    "usage: {DISPLAY_BIN} write <id>  (reads body from stdin)"
                )));
            }
        }
        Some("completion") => {
            if command_positionals(args, &["--json", "-j"]).len() == 1 {
                return Err(CliError::Usage(format!(
                    "usage: {DISPLAY_BIN} completion <bash|zsh|fish>"
                )));
            }
        }
        Some("edit") | Some("e") => {
            if command_positionals(args, &["--json", "-j"]).len() == 1 {
                return Err(CliError::Usage(format!(
                    "usage: {DISPLAY_BIN} edit <id> --old <text> --new <text> [--new-stdin]"
                )));
            }
            missing_value(args, &["--old", "-o"], "edit: --old/-o requires a value")?;
            missing_value(args, &["--new", "-n"], "edit: --new/-n requires a value")?;
        }
        Some("search") | Some("q") => {
            if command_positionals(args, &["--json", "-j"]).len() == 1 {
                return Err(CliError::Usage(format!(
                    "usage: {DISPLAY_BIN} search <query> [--notebook|-b <nb>] [--limit|-l <n>]"
                )));
            }
            missing_value(
                args,
                &["--notebook", "-b"],
                "search: --notebook/-b requires a value",
            )?;
            missing_value(
                args,
                &["--limit", "-l"],
                "search: --limit/-l requires a value",
            )?;
            invalid_limit_value(args)?;
            unknown_flags(
                args,
                &["--json", "-j", "--notebook", "-b", "--limit", "-l"],
                |flag| {
                    format!(
                        "search: unknown arg `{flag}`\n\
                         usage: {DISPLAY_BIN} search <query> [--notebook|-b <nb>] [--limit|-l <n>]"
                    )
                },
            )?;
        }
        Some("mcp") => {
            let extras = args
                .iter()
                .filter(|a| a.as_str() != "--json" && a.as_str() != "-j")
                .skip_while(|a| a.as_str() != "mcp")
                .skip(1)
                .count();
            if extras > 0 {
                return Err(CliError::Usage(format!(
                    "usage: {DISPLAY_BIN} mcp  (no extra args; MCP over stdio)"
                )));
            }
        }
        Some("create") | Some("new") | Some("c") => {
            let positional = command_positionals(args, &["--json", "-j"]);
            if positional.len() == 1 {
                return Err(CliError::Usage(format!(
                    "usage: {DISPLAY_BIN} create <notebook>  (body from stdin)\n\
                     (aliases: new, c)"
                )));
            }
            if positional.len() > 2 {
                return Err(CliError::Usage(format!(
                    "usage: {DISPLAY_BIN} create <notebook>  (body from stdin)\n\
                     (no extra positional args; title is derived from body's first `# heading`)"
                )));
            }
        }
        Some("notebooks") | Some("nb") => {}
        Some(other) => {
            return Err(CliError::Usage(format!(
                "unknown command: `{other}`\n(run `{DISPLAY_BIN} --help` for usage)"
            )));
        }
        _ => {}
    }
    Ok(())
}

#[derive(Copy, Clone)]
enum EditValueTarget {
    Old,
    New,
}

fn parse_edit_command(args: &[String]) -> Result<Cli, CliError> {
    let mut json = false;
    let mut seen_command = false;
    let mut id: Option<String> = None;
    let mut old_parts: Vec<String> = Vec::new();
    let mut new_parts: Vec<String> = Vec::new();
    let mut seen_old = false;
    let mut seen_new = false;
    let mut new_from_stdin = false;
    let mut dry_run = false;
    let mut target: Option<EditValueTarget> = None;

    for arg in args {
        let value = arg.as_str();
        if !seen_command {
            match value {
                "--json" | "-j" => json = true,
                "edit" | "e" => seen_command = true,
                other => {
                    return Err(CliError::Usage(format!(
                        "unknown command: `{other}`\n(run `{DISPLAY_BIN} --help` for usage)"
                    )))
                }
            }
            continue;
        }

        if matches!(value, "--json" | "-j") {
            json = true;
            continue;
        }

        if id.is_none() {
            id = Some(arg.clone());
            continue;
        }

        match value {
            "--old" | "-o" => {
                seen_old = true;
                target = Some(EditValueTarget::Old);
            }
            "--new" | "-n" => {
                seen_new = true;
                target = Some(EditValueTarget::New);
            }
            "--new-stdin" => {
                new_from_stdin = true;
                target = None;
            }
            "--dry-run" => {
                dry_run = true;
                target = None;
            }
            other if other.starts_with('-') && other.len() > 1 => {
                return Err(CliError::Usage(format!(
                    "edit: unknown arg `{other}`\n\
                     usage: {DISPLAY_BIN} edit <id> --old <text> --new <text> [--new-stdin] [--dry-run]"
                )))
            }
            other => match target {
                Some(EditValueTarget::Old) => old_parts.push(other.to_string()),
                Some(EditValueTarget::New) => new_parts.push(other.to_string()),
                None => {
                    return Err(CliError::Usage(format!(
                        "edit: unexpected argument `{other}`\n\
                         usage: {DISPLAY_BIN} edit <id> --old <text> --new <text> [--new-stdin]"
                    )))
                }
            },
        }
    }

    if !seen_command {
        return Err(CliError::Usage(format!(
            "usage: {DISPLAY_BIN} edit <id> --old <text> --new <text> [--new-stdin]"
        )));
    }

    let id = id.ok_or_else(|| {
        CliError::Usage(format!(
            "usage: {DISPLAY_BIN} edit <id> --old <text> --new <text> [--new-stdin]"
        ))
    })?;

    let old = if seen_old {
        Some(old_parts.join(" "))
    } else {
        None
    };
    let new = if seen_new {
        Some(new_parts.join(" "))
    } else {
        None
    };

    Ok(Cli::Edit {
        id,
        old,
        new,
        new_from_stdin,
        dry_run,
        json,
    })
}

fn first_command(args: &[String]) -> Option<String> {
    args.iter()
        .find(|a| a.as_str() != "--json" && a.as_str() != "-j")
        .cloned()
}

fn command_positionals<'a>(args: &'a [String], global_flags: &[&str]) -> Vec<&'a str> {
    args.iter()
        .filter(|a| !global_flags.contains(&a.as_str()))
        .map(String::as_str)
        .collect()
}

fn missing_value(args: &[String], flags: &[&str], message: &str) -> Result<(), CliError> {
    for (idx, arg) in args.iter().enumerate() {
        if flags.contains(&arg.as_str()) {
            let missing = args
                .get(idx + 1)
                .map(|next| next.starts_with('-'))
                .unwrap_or(true);
            if missing {
                return Err(CliError::Usage(message.into()));
            }
        }
    }
    Ok(())
}

fn invalid_limit_value(args: &[String]) -> Result<(), CliError> {
    for (idx, arg) in args.iter().enumerate() {
        if matches!(arg.as_str(), "--limit" | "-l") {
            if let Some(value) = args.get(idx + 1) {
                if value.parse::<usize>().is_err() {
                    return Err(CliError::Usage(format!(
                        "search: --limit/-l requires a positive integer, got `{value}`"
                    )));
                }
            }
        }
    }
    Ok(())
}

fn unknown_flags(
    args: &[String],
    known_flags: &[&str],
    message: impl Fn(&str) -> String,
) -> Result<(), CliError> {
    let mut iter = args.iter().skip(1);
    while let Some(arg) = iter.next() {
        let value = arg.as_str();
        if known_flags.contains(&value) {
            if matches!(
                value,
                "--old" | "-o" | "--new" | "-n" | "--notebook" | "-b" | "--limit" | "-l"
            ) {
                let _ = iter.next();
            }
            continue;
        }
        if value.starts_with('-') {
            return Err(CliError::Usage(message(value)));
        }
    }
    Ok(())
}

pub fn print_help() {
    let usage = "\
USAGE:
    flowix [GLOBAL FLAGS] <COMMAND> [ARGS]

GLOBAL FLAGS:
    --version, -V      Print version and exit
    --help, -h         Print this help and exit
    --json, -j         Output as JSON where supported

COMMANDS:
    notebooks          List all notebooks                    [alias: nb]
    list <notebook>    List notes in a notebook              [alias: ls]
    show <id>          Print a note to stdout                [alias: s]
    create <notebook>  Create a new note (body from stdin)   [alias: new, c]
                       title derived from first `# heading` line
    delete <id>        Delete a note                         [alias: rm]
    edit <id>          Incremental edit by exact-string replace [alias: e]
                       --old|-o <text> --new|-n <text> [--new-stdin] [--dry-run]
                       old must match exactly once; non-interactive;
                       auto-rename on title change
    write <id>         Overwrite a note (body from stdin)    [alias: w]
                       non-interactive; auto-rename on title change
    search <query>     Full-text search                      [alias: q]
                       [--notebook|-b <nb>] [--limit|-l <n>]
    completion <sh>    Print shell completion (bash|zsh|fish)
    mcp               MCP over stdio (external Agent integration)

ENVIRONMENT:
    FLOWIX_HOME        Override config dir (default: ~/.flowix; contains index.db)
    FLOWIX_DATA        Override data dir (default: <OS data dir>/flowix)

ENCODING:
    Notes are always written as UTF-8; stdin is read as UTF-8.
    On Windows the CLI sets its console to UTF-8 at startup. When piping
    non-ASCII content from PowerShell 5.1, also set
      $OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
    (or run `chcp 65001`). PowerShell 7+ and the MCP transport are UTF-8
    by default.

EXAMPLES:
    flowix --version
    flowix notebooks
    flowix notebooks --json | jq
    flowix list work
    flowix list work --json | jq '.[] | select(.favorited)'
    flowix show a1b2c3
    flowix show a1b2c3 --json | jq '.body'
    echo \"# hello\" | flowix create work
    printf \"# new title\\nbody\\n\" | flowix write a1b2c3
    flowix edit a1b2c3 --old \"old text\" --new \"new text\"
    flowix search TODO --limit 20
    FLOWIX_HOME=/tmp/fx-test flowix notebooks
";
    print!("{usage}");
}

#[cfg(test)]
mod tests;
