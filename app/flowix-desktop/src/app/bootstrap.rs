use crate::agent_external::claude::ClaudeCliManager;
use crate::agent_external::codex::CodexCliManager;
use crate::agent_external::hermes::HermesCliManager;
use crate::agent_external::opencode::OpenCodeAcpManager;
use crate::agent_external::runtime_registry::ExternalRuntimeRegistry;
use crate::agent_external_config::AgentExternalConfig;
use crate::agent_flowix::AgentManager;
use crate::agent_session::ThreadManager;
use crate::app::panic::install_panic_log_hook;
use crate::app::paths::{get_app_data_path, get_user_config_dir};
use crate::app::state::AppState;
use crate::app::watchdog::spawn_external_agent_watchdog;
use crate::cli_link;
use crate::commands;
use crate::config::user as user_config;
use crate::config::AgentAccessStore;
use crate::config::SecurityBookmarkStore;
use crate::events as dispatcher;
use crate::open_target;
use crate::runtime_log;
use crate::system_data::SystemData;
use crate::watcher::MemoWatcher;
use flowix_core::search::{BigramTokenizer, MemoIndex};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::{Emitter, Listener, Manager};

pub fn run() {
    install_panic_log_hook();

    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    let app_data_path = get_app_data_path();
    std::fs::create_dir_all(&app_data_path).ok();

    let home_dir = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    runtime_log::record_event(
        "info",
        "app.start",
        format!(
            "{} {} started",
            runtime_log::PRODUCT_NAME,
            runtime_log::APP_VERSION
        ),
    );

    // �?��时在 `~/.local/bin/flowix-cli` 建一�?symlink。�?情�?
    // `cli_link` 模块: 幂等 (每�?�?��都跑, 已存在就不动), 失败�?warn
    // This is idempotent and failures do not block GUI startup.
    cli_link::ensure_cli_symlink();

    let user_config_dir = get_user_config_dir(&home_dir);
    std::fs::create_dir_all(&user_config_dir).ok();
    let thread_db_path = user_config_dir.join("thread.db");
    let user_config = Arc::new(user_config::UserConfigStore::new(home_dir.clone()));
    let cloud_sync = Arc::new(
        flowix_sync::SyncManager::new(
            flowix_sync::DEFAULT_CLOUD_API_BASE,
            user_config_dir.join("sync.db"),
        )
        .unwrap_or_else(|error| {
            tracing::error!(
                "failed to initialize cloud sync database: {error}; using a temporary database"
            );
            flowix_sync::SyncManager::new(
                flowix_sync::DEFAULT_CLOUD_API_BASE,
                std::env::temp_dir().join(format!("flowix-sync-{}.db", std::process::id())),
            )
            .expect("failed to initialize temporary cloud sync database")
        }),
    );

    // 笔�?�?��册表真源�?~/.flowix/index.db (SQLite); `MemoFile::open_index_db`
    // 首�?�??时建表�?这里不需要任何�?盘迁�?── �?`notebook.json` �?��已废�?
    let memo_file = flowix_core::memo_file::MemoFile::new(user_config_dir.clone());

    // System metadata goes under ~/.flowix/boot/system.json.
    let system_data_path = user_config_dir.join("boot").join("system.json");
    let system_data = match SystemData::new(system_data_path.clone()) {
        Ok(store) => store,
        Err(err) => {
            tracing::error!(
                "failed to initialize system data at {}: {err}",
                system_data_path.display()
            );
            SystemData::transient(system_data_path)
        }
    };

    // External CLI 璺緞閰嶇疆 (~/.flowix/agent-external-config.json) 鈹€鈹€
    // 作为 codex/claude/gemini/hermes/openclaw 执�?�?��的唯一参照�?
    let agent_external_config_path = user_config_dir.join("agent-external-config.json");
    let agent_external_config = match AgentExternalConfig::new(agent_external_config_path.clone()) {
        Ok(store) => store,
        Err(err) => {
            tracing::error!(
                "failed to initialize agent external config at {}: {err}",
                agent_external_config_path.display()
            );
            AgentExternalConfig::transient(agent_external_config_path)
        }
    };

    // 三个需要与 AgentManager 共享的依�? 提前建好 Arc �?clone�?    // refcount 期望: user_config=2 (AppState + AgentManager), thread_manager=2,
    // memo_file=2 ── �?`commands.rs::AppState` 注释�?
    let memo_file_arc = Arc::new(RwLock::new(memo_file));
    let thread_manager = match ThreadManager::new(thread_db_path.clone()) {
        Ok(manager) => manager,
        Err(err) => {
            tracing::error!(
                "failed to initialize thread database at {}: {err}; using in-memory thread store",
                thread_db_path.display()
            );
            ThreadManager::new_in_memory().unwrap_or_else(|fallback_err| {
                panic!("failed to initialize in-memory thread database: {fallback_err}")
            })
        }
    };
    let thread_manager_arc = Arc::new(thread_manager);
    // �?��时一次性清理�?�?is_loading=1 �?── 解决"上�?进程�?tool_use
    // 落盘后�? SIGKILL / 强退, 下�?�?��看到�?��卡�?工具�?的问题�?详�?
    // `ThreadManager::clear_all_loading` 娉ㄩ噴銆俙run()` 姝ゆ椂杩樺湪 tauri
    // runtime 璧锋潵涔嬪墠, 涓嶈兘 `.await`, 鎵€浠ユ槸鍚屾鏂规硶 (鍐呴儴鍗曟潯
    // UPDATE, 没有真实异�?工作)。�?锁足�? clear �?�� UPDATE, 不会
    // 与�?�?add_message / update_tool_result 冲突 (后者写同一行的 0,
    // 后到写后�? 两条�?��殊途同�?�?
    {
        match thread_manager_arc.clear_all_loading() {
            Ok(0) => tracing::debug!("[Startup] no orphan is_loading=1 rows"),
            Ok(n) => tracing::info!("[Startup] cleared {n} orphan is_loading=1 rows"),
            Err(e) => tracing::warn!("[Startup] clear_all_loading failed: {e}"),
        }
    }
    let user_config_arc = user_config.clone();

    // Agent �??�?���?store ── 必须�?notebook registry �?`memo_file_arc`
    // 都就�?��后构�?(�?store 会�? notebook registry �?? + 对账)�?
    let security_bookmarks_arc = Arc::new(SecurityBookmarkStore::new(user_config_dir.clone()));
    let agent_access_arc = Arc::new(AgentAccessStore::new(
        user_config_dir.clone(),
        &*crate::lock_utils::read_lock(&memo_file_arc, "memo_file"),
    ));

    // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    // Skills 鈹€鈹€ `~/.flowix/skills/` 鍗曟牴, 鎵弿涓や釜鍖哄煙:
    //   1. `.system/<name>/SKILL.md`  系统内置 (�?bundle 一次�?seed)
    //   2. `<name>/SKILL.md`          用户�?���?    //
    // 流程: 创建用户�?�� �?seed-once (�?bundle 拷一份到 .system/) �?默�?
    // �?agent-access.json 加一�?Folder entry (id=`fld_skills_auto`) �?    // �?��整个根目�?�?构�?SkillStore �?�?AppState / AgentManager 共享
    // ── SkillStore �?��后不�?��, Arc 共享, 无需 RwLock�?    // ──────────────────────────────────────────────────────────────────
    let skills_root = user_config_dir.join("skills");
    if let Err(e) = std::fs::create_dir_all(&skills_root) {
        tracing::warn!(
            "[startup] failed to create skills root {}: {e}",
            skills_root.display()
        );
    }

    // Seed-once: bundled `resources/skills/.system/*` 鈫?`~/.flowix/skills/.system/*`.
    // 三个候选路�? 命中�?���?��用的就停 ── �?    // `crate::agent_flowix::skills::scanner::resolve_bundled_root`�?
    if let Some(bundled) = crate::agent_flowix::skills::scanner::resolve_bundled_root() {
        let report = crate::agent_flowix::skills::seed_system_skills(&bundled, &skills_root);
        if !report.copied.is_empty() || !report.skipped.is_empty() {
            tracing::info!(
                "[startup] skills seed: copied {}, skipped {} (already present)",
                report.copied.len(),
                report.skipped.len()
            );
        }
    } else {
        tracing::debug!(
            "[startup] no bundled skills found; user can drop SKILL.md into ~/.flowix/skills/"
        );
    }

    // 默�?�?Agent `~/.flowix/skills/` 的�?权限 ── LLM �?��直接 `read` / `grep`
    // Let the agent read registered skills directly when needed.
    agent_access_arc.ensure_skill_folder(&skills_root);

    let skill_store = Arc::new(crate::agent_flowix::skills::SkillStore::load(&skills_root));
    tracing::info!(
        "[startup] loaded {} skill(s) from {}",
        skill_store.len(),
        skill_store.root().display()
    );

    // 监听 user-config-changed �?���?whitelist �? 也需�?user_config_arc,
    // 单独 clone 一�?(后续会�? move �?AgentManager::new)�?
    let user_config_for_watcher = user_config_arc.clone();

    // AppState �?`.setup()` �?��里构造。Tauri 2 �?`.manage(state)` �?    // "一次�?�?��, 所以所有共�?��赖都在进入闭包前准�?好�?    //
    // 这里把构�?AppState 需要的子结�?clone 出来 (�?�� `move` 捕获),
    // 同时把另一�?clone 喂给 sub-component 构造函数�?
    let user_config_for_state = user_config_arc.clone();
    let cloud_sync_for_state = cloud_sync.clone();
    let memo_file_for_state = memo_file_arc.clone();
    let agent_access_for_state = agent_access_arc.clone();
    let security_bookmarks_for_state = security_bookmarks_arc.clone();
    let thread_manager_for_state = thread_manager_arc.clone();
    // �?��设�?登�?模块 ── 和上面同样的 prep 模式: clone �?setup �?���?
    let user_config_dir_for_device = user_config_dir.clone();
    // `system_data` 娌?
    // impl Clone ── 直接 move �?setup �?��, 那里
    // move 杩?AppState銆?
    let search_init = RwLock::new(MemoIndex::new(Arc::new(BigramTokenizer)));
    let agent_manager = Arc::new(AgentManager::new(
        user_config_arc,
        thread_manager_arc.clone(),
        memo_file_arc.clone(),
        agent_access_arc.clone(),
        security_bookmarks_arc.clone(),
        skill_store,
    ));
    let codex_cli_manager = Arc::new(CodexCliManager::new(thread_manager_arc.clone()));
    let claude_cli_manager = Arc::new(ClaudeCliManager::new(thread_manager_arc.clone()));
    let hermes_cli_manager = Arc::new(HermesCliManager::new(thread_manager_arc.clone()));
    let opencode_acp_manager = Arc::new(OpenCodeAcpManager::new(thread_manager_arc.clone()));
    let external_runtimes = Arc::new(ExternalRuntimeRegistry::new(
        codex_cli_manager,
        claude_cli_manager,
        hermes_cli_manager,
        opencode_acp_manager,
    ));

    // 笔�?�?��录文件监�?�� —把�?部编辑器 / 其他 AI 对任意已注册 notebook
    // 的�?盘变更转�?`memo-event` 推前�?��`AppHandle` �?`run()` 阶�?拿不�?
    // 实际绑定�?.setup() �?��里完成�?
    let memo_watcher = Arc::new(RwLock::new(MemoWatcher::new(memo_file_arc.clone())));

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            handle_second_instance(app, args);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .manage(memo_watcher.clone())
        .manage(commands::tab_window::TabWindowCoordinator::default())
        .setup(move |app| {
            // 鈹€鈹€ 0) 鍚姩璁惧鐧昏 / last_seen 鍒锋柊 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
            //   不阻�? spawn 一�?fire-and-forget tokio 任务, �?��内部
            //   �?sleep 10s �?POST, 与产品更�?7s 检查错开。远�?��
            //   `device_id` upsert, 首�?插入, 后续�?��刷新 last_seen_at�?
            let app_version = app.package_info().version.to_string();
            let device_registry = Arc::new(crate::device_registration::DeviceRegistry::load(
                &user_config_dir_for_device,
                app_version,
            ));
            device_registry.clone().spawn_startup_registration();
            app.manage(device_registry);

            // 鈹€鈹€ 1) 鍚姩鎺㈡祴 external CLI 璺緞 鈹€鈹€
            //   �?source=auto/缺失�?agent 跑探测链 (env>PATH>候�?shell),
            // Populate the external CLI registry once at startup.
            agent_external_config.run_startup_detect();

            // ── 2) 构�?AppState �?manage ──
            let app_state = AppState {
                user_config: user_config_for_state.clone(),
                cloud_sync: cloud_sync_for_state.clone(),
                system_data,
                agent_external_config,
                memo_file: memo_file_for_state.clone(),
                search: search_init,
                agent_manager: agent_manager.clone(),
                external_runtimes: external_runtimes.clone(),
                thread_manager: thread_manager_for_state.clone(),
                agent_access: agent_access_for_state.clone(),
                security_bookmarks: security_bookmarks_for_state.clone(),
            };
            app.manage(app_state);
            // 注入 AppHandle 给 agent 工具链，使其 delete 等 memo 写入工具能
            // mark_self_write + emit memo-event（构造 AgentManager 时还在 builder
            // 链上，拿不到 handle）。
            agent_manager.set_app_handle(app.handle().clone());
            commands::cloud::start_cloud_sync_polling(app.handle().clone());
            if let Ok(Some(refresh_token)) = user_config_for_state.load_cloud_refresh_token() {
                let cloud_sync = cloud_sync_for_state.clone();
                let user_config = user_config_for_state.clone();
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    match cloud_sync.restore(&refresh_token).await {
                        Ok(outcome) => {
                            if let Err(error) =
                                user_config.save_cloud_refresh_token(&outcome.refresh_token)
                            {
                                tracing::warn!(
                                    "failed to persist rotated cloud refresh token: {error}"
                                );
                            }
                            let _ = app_handle.emit("cloud-state-changed", &outcome.state);
                        }
                        Err(error) => {
                            tracing::warn!("failed to restore Flowix Cloud session: {error}");
                            let _ = user_config.delete_cloud_refresh_token();
                            if let Ok(state) = cloud_sync.state() {
                                let _ = app_handle.emit("cloud-state-changed", state);
                            }
                        }
                    }
                });
            }
            spawn_external_agent_watchdog(app.handle().clone(), external_runtimes.clone());

            if let Some(window) = app.get_webview_window("main") {
                crate::window_chrome::apply_window_border_color(&window);
                // �?��即�?齐主题背�?��, 消除冷启动白�?(尤其深色主�?)�?
                let theme = app.state::<AppState>().user_config.get_preference().theme;
                crate::window_chrome::apply_theme_background(&window, theme);

                // Theme::System 时跟�?OS 明暗实时切换窗口背景�? 仅当窗口�??显式
                // theme (�?��用所有窗口都�? �?Tauri 才派�?ThemeChanged, 故这�?                // 监听主窗口即�?��发一次全局刷新 (apply_theme_background_all 遍历所有窗�?�?
                let app_for_theme = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::ThemeChanged(_) = event {
                        let current = app_for_theme
                            .state::<AppState>()
                            .user_config
                            .get_preference()
                            .theme;
                        if current == crate::config::Theme::System {
                            crate::window_chrome::apply_theme_background_all(
                                &app_for_theme,
                                current,
                            );
                        }
                    }
                });
            }

            // �?setup 阶�? manage dispatcher, 因为
            // TauriDispatcher::new 需�?AppHandle, builder chain 里拿不到�?
            let dispatcher: crate::events::SharedDispatcher =
                std::sync::Arc::new(crate::events::TauriDispatcher::new(app.handle().clone()));
            app.manage(dispatcher);
            app.manage(
                commands::external_document_watch::ExternalDocumentWatchState::new(
                    app.handle().clone(),
                ),
            );
            // Watch every configured notebook. MCP/external tools may write to
            // a background notebook, and those creates must still reach the
            // main Webview so it can route the note into a tab window.
            let initial_notebooks = {
                let memo_file = crate::lock_utils::read_lock(&memo_file_arc, "memo_file");
                memo_file.read_notebook_configs().unwrap_or_default()
            };
            for notebook in &initial_notebooks {
                security_bookmarks_for_state
                    .start_accessing_for_path(std::path::Path::new(&notebook.path));
            }
            // Restore security-scoped access for user-selected reference
            // folders as well. External CLI children inherit the parent's
            // active extensions, so this must happen before any agent spawn.
            for entry in agent_access_for_state
                .get_config()
                .entries
                .into_iter()
                .filter(|entry| entry.enabled && !entry.missing)
            {
                security_bookmarks_for_state
                    .start_accessing_for_path(std::path::Path::new(&entry.path));
            }
            memo_watcher
                .write()
                .unwrap_or_else(|poisoned| {
                    tracing::error!("memo_watcher write lock poisoned, recovering");
                    poisoned.into_inner()
                })
                .rebind_all(app.handle().clone(), initial_notebooks.clone());

            // �?��已有 current notebook 时做�?��对账�?current=None �?            // `MemoFile` 会回退到默�?notebook �?��, �?macOS 上可能触�?            // Documents 权限弹窗�?
            let current_notebook_id = crate::lock_utils::read_lock(&memo_file_arc, "memo_file")
                .current_notebook_id_value();
            if current_notebook_id.is_some() {
                match memo_file_arc
                    .read()
                    .unwrap_or_else(|poisoned| {
                        tracing::error!("memo_file read lock poisoned, recovering");
                        poisoned.into_inner()
                    })
                    .reconcile_with_disk_bidirectional()
                {
                    Ok(report) if report.added > 0 || report.removed > 0 => {
                        runtime_log::record_event(
                            "info",
                            "startup.reconcile",
                            format!(
                                "reconcile added={}, removed={}",
                                report.added, report.removed
                            ),
                        );
                        tracing::info!(
                            "[startup] reconcile: +{} added, -{} removed",
                            report.added,
                            report.removed
                        );
                    }
                    Ok(_) => tracing::debug!("[startup] reconcile: no-op"),
                    Err(e) => {
                        runtime_log::record_event(
                            "error",
                            "startup.reconcile_failed",
                            format!("startup reconcile failed: {e}"),
                        );
                        tracing::warn!("[startup] reconcile failed: {e}");
                    }
                }

                if let Some(notebook_id) = current_notebook_id.as_deref() {
                    match memo_file_arc
                        .read()
                        .unwrap_or_else(|poisoned| {
                            tracing::error!("memo_file read lock poisoned, recovering");
                            poisoned.into_inner()
                        })
                        .ensure_tag_union_index_for_notebook_id(notebook_id)
                    {
                        Ok(updated) if updated > 0 => {
                            tracing::info!("[startup] rebuilt union tags for {updated} memos");
                        }
                        Ok(_) => {}
                        Err(error) => {
                            tracing::warn!("[startup] tag union index upgrade failed: {error}");
                        }
                    }
                }
            }

            // �?��时把 preference.json::watcher 应用�?MemoWatcher;
            // 同时注册 user-config-changed 监听做热更新 (前�?�?            // update_watcher_config IPC �?settings::update_watcher_config
            // 写后 emit 该事�? 这里收到�?set_whitelist)�?
            {
                let watcher_cfg = user_config_for_watcher.get_preference().watcher.clone();
                memo_watcher
                    .write()
                    .unwrap_or_else(|poisoned| {
                        tracing::error!("memo_watcher write lock poisoned, recovering");
                        poisoned.into_inner()
                    })
                    .set_whitelist(watcher_cfg);

                let w_for_evt = memo_watcher.clone();
                let uc_for_evt = user_config_for_watcher.clone();
                app.listen("user-config-changed", move |event| {
                    // payload �?kind 字�?�?("preference" / "ai_config" / "watcher")
                    // ── ai_config �?~/.flowix/agent-config.toml (TOML), 其余�?JSON
                    // event.payload() 返回 serde_json 序列化结�?(带引�? �?"\"preference\""),
                    // 直接 == 比�?会恒�?false, 这里反序列化还原成裸字�?串�?
                    let kind = serde_json::from_str::<String>(event.payload()).unwrap_or_default();
                    if kind == "preference" || kind == "watcher" {
                        let new_cfg = uc_for_evt.get_preference().watcher.clone();
                        w_for_evt
                            .write()
                            .unwrap_or_else(|poisoned| {
                                tracing::error!("memo_watcher write lock poisoned, recovering");
                                poisoned.into_inner()
                            })
                            .set_whitelist(new_cfg);
                        tracing::info!("[watcher] whitelist hot-updated");
                    }
                    // 主�?切换的原�?chrome 更新由前�?apply_window_theme IPC 实时驱动,
                    // 不在这里处理 (这里 200ms 防抖后才触发, 且与持久化耦合)�?
                });
            }

            register_deep_links(app);
            handle_cold_start_open_targets(app.handle());

            // release 构建不包�??分支�?用户随时�?�� F12 / Ctrl+Shift+I 切换�?
            // 鈹€鈹€ spawn flowix-cli sidecar 鈹€鈹€
            // 必须�?setup �?��, 此时 AppState 已经 manage, IPC 调用方可�?
            // 拿到 (虽然还没�?handle ── 失败时返 "not yet spawned" �?�?
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 偏好 (JSON, �?user_config)
            commands::product::get_product_info,
            commands::product::get_diagnostics,
            commands::product::check_product_update_notice,
            commands::product::open_log_dir,
            commands::settings::get_preference,
            commands::settings::set_preference,
            commands::settings::get_ai_config,
            commands::settings::set_ai_config,
            commands::settings::test_ai_connection,
            commands::settings::get_watcher_config,
            commands::settings::update_watcher_config,
            commands::boot::get_boot_features,
            commands::cloud::cloud_get_state,
            commands::cloud::cloud_register,
            commands::cloud::cloud_login,
            commands::cloud::cloud_sign_in_with_apple,
            commands::cloud::cloud_link_apple,
            commands::cloud::cloud_logout,
            commands::cloud::cloud_set_enabled,
            commands::cloud::cloud_get_notebook_state,
            commands::cloud::cloud_list_notebook_states,
            commands::cloud::cloud_list_notebooks,
            commands::cloud::cloud_link_notebook,
            commands::cloud::cloud_set_notebook_enabled,
            commands::cloud::cloud_refresh_membership,
            commands::cloud::cloud_list_products,
            commands::cloud::cloud_create_checkout,
            commands::cloud::cloud_sync_now,
            // agent 鍙闂洰褰?(JSON, 璧?agent_access)
            commands::agent_access::get_agent_access,
            commands::agent_access::set_agent_access,
            // System metadata (JSON, ~/.flowix/boot/system.json)
            commands::kv::get_tag_system_metadata,
            commands::kv::set_tag_system_layout,
            commands::kv::set_tag_system_hidden,
            commands::kv::set_tag_system_pinned,
            // 笔�? / Doc ── �?commands/memo/{reads,creates,versions,deletes}.rs
            // 瀛愭ā鍧楄矾寰勫彇, 涓嶈蛋 `commands::memo::xxx` 椤跺眰 re-export 鈹€鈹€
            // `#[tauri::command]` 宏生成的 `__cmd__xxx` wrapper �?��数所�?            // 模块的同�?macro, �?��在�?模块�?�� (`commands::memo::reads::xxx`)
            // 解析�? `commands::memo::xxx` 顶层�?��不传�?macro re-export.
            commands::memo::reads::get_memos,
            commands::memo::reads::search_mention_notes,
            commands::memo::reads::list_agent_role_memos,
            commands::memo::reads::get_used_memo_tag_ids,
            commands::memo::reads::get_memo_todo_metadata,
            commands::memo::reads::get_memo_todo_count,
            commands::memo::reads::read_memo,
            commands::memo::reads::open_memo_session,
            commands::memo::reads::read_document,
            commands::memo::reads::write_document,
            commands::external_document::read_external_document,
            commands::external_document::write_external_document,
            commands::memo::reads::get_launch_open_files,
            commands::memo::reads::search_memos,
            commands::memo::creates::add_document,
            commands::memo::creates::import_external_document_to_memo,
            commands::memo::creates::update_memo_db,
            commands::memo::creates::finalize_memo_filename,
            commands::memo::creates::favorite_memo,
            commands::memo::creates::unfavorite_memo,
            commands::memo::creates::set_memo_colors,
            commands::memo::creates::list_memo_templates,
            commands::memo::creates::save_memo_template,
            commands::memo::creates::delete_memo_template,
            commands::memo::creates::create_memo_from_template,
            commands::memo::versions::list_memo_versions,
            commands::memo::versions::read_memo_version,
            commands::memo::versions::create_memo_version,
            commands::memo::versions::restore_memo_version,
            commands::memo::deletes::delete_memo,
            commands::memo::deletes::clear_memos,
            commands::memo::versions::delete_memo_version,
            // tag
            commands::tag::get_all_tags,
            commands::tag::create_notebook_tag,
            commands::tag::move_memo_tag,
            commands::tag::delete_memo_tag,
            commands::tag::get_tag_prefix_counts,
            // notebook
            commands::notebook::get_notebooks,
            commands::notebook::create_notebook,
            commands::notebook::create_notebook_from_cloud,
            commands::notebook::update_notebook,
            commands::notebook::delete_notebook,
            commands::notebook::clear_notebooks,
            commands::notebook::set_current_notebook,
            commands::notebook::reorder_notebooks,
            // file
            commands::file::get_file_tree,
            commands::file::get_dir_children,
            commands::file::read_file,
            commands::file::write_file,
            commands::file::delete_file,
            commands::file::create_folder,
            commands::file::create_document,
            // font cache
            commands::font::get_font_cache_status,
            commands::font::ensure_font_cached,
            commands::font::remove_cached_font,
            // web page metadata
            commands::web::parse_web_page,
            // dialog
            commands::dialog::select_directory,
            commands::dialog::select_files,
            commands::dialog::save_file_dialog,
            commands::dialog::write_export_file,
            commands::dialog::save_attachment,
            commands::dialog::save_attachment_content,
            commands::dialog::copy_attachment_file,
            commands::dialog::open_attachment_file,
            commands::agent_access::add_agent_access_folder_from_picker,
            // agent
            commands::agent::external_config::agent_runtime_status,
            commands::agent::external_config::get_agent_external_config,
            commands::agent::external_config::set_agent_external_path,
            commands::agent::external_config::redetect_agent_external,
            commands::agent::external_config::select_external_cli_path,
            commands::agent::terminal::open_codex_cli_install_terminal,
            commands::agent::terminal::open_codex_config,
            commands::agent::image_cache::cache_agent_image,
            commands::agent::image_cache::delete_cached_agent_image,
            commands::agent::image_cache::read_cached_agent_image,
            commands::agent::chat::chat_with_agent_stream,
            commands::agent::chat::stop_agent_stream,
            commands::agent::chat::agent_running_threads,
            commands::agent::chat::agent_external_events,
            // thread
            commands::thread::thread_list,
            commands::thread::thread_create,
            commands::thread::thread_get,
            commands::thread::thread_get_page,
            commands::thread::agent_conversation_list,
            commands::thread::agent_conversation_get,
            commands::thread::agent_conversation_find_by_thread,
            commands::thread::agent_conversation_upsert,
            commands::thread::agent_conversation_delete,
            commands::thread::agent_conversation_delete_for_thread,
            commands::thread::local_agent_thread_list,
            commands::thread::codex_thread_list,
            commands::thread::codex_thread_get,
            commands::thread::codex_thread_get_page,
            commands::thread::codex_thread_session_id,
            commands::agent::model_catalog::codex_default_model,
            commands::agent::model_catalog::agent_supported_models,
            commands::thread::claude_thread_list,
            commands::thread::claude_thread_get,
            commands::thread::claude_thread_get_page,
            commands::thread::claude_thread_session_id,
            commands::thread::hermes_thread_list,
            commands::thread::hermes_thread_get,
            commands::thread::hermes_thread_get_page,
            commands::thread::hermes_thread_session_id,
            commands::thread::opencode_thread_session_id,
            commands::thread::opencode_thread_list,
            commands::thread::opencode_thread_get_page,
            commands::thread::thread_delete,
            commands::thread::thread_update_title,
            // window
            commands::window::show_main_window,
            commands::window::open_preferences_window,
            commands::window::apply_window_theme,
            commands::tab_window::open_note_window,
            commands::tab_window::open_note_tab,
            commands::tab_window::open_external_markdown_window,
            commands::tab_window::open_external_markdown_tab,
            commands::tab_window::open_markdown_path_tab,
            commands::tab_window::tab_window_ready,
            commands::tab_window::tab_window_ack_transfer,
            commands::tab_window::tab_window_set_tab_region,
            commands::tab_window::tab_window_close_tab,
            commands::tab_window::tab_window_reorder_tab,
            commands::tab_window::tab_window_detach_tab,
            commands::tab_window::tab_window_begin_tab_item_drag,
            commands::tab_window::tab_window_cancel_tab_item_drag,
            commands::external_document_watch::watch_external_document,
            commands::external_document_watch::unwatch_external_document,
            // 鍏ㄥ眬"閫氳繃閾炬帴鎵撳紑绗旇"鍏ュ彛 鈹€鈹€ 鎺ユ敹 URL / 鐗╃悊璺緞, 瑙ｆ瀽 + emit
            open_target::handler::open_memo_by_target,
            commands::cli::cli_link_status,
            commands::cli::install_cli_path,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(handle_run_event);
}

fn handle_second_instance(app: &tauri::AppHandle, args: Vec<String>) {
    // 二�?�?��: 区分 markdown 文件�?���?flowix:// 深链�?    // 两个通道�?��同时触发 (用户�?`xdg-open foo.md flowix://memo/abc123` �?��)�?
    let paths = commands::markdown_paths_from_args(args.clone());
    for path in &paths {
        route_markdown_path_to_tab(app, path);
    }

    for arg in args {
        if !paths.contains(&arg) {
            emit_open_target_if_resolved(app, &arg);
        }
    }
}

#[cfg(desktop)]
fn register_deep_links(app: &mut tauri::App) {
    use tauri_plugin_deep_link::DeepLinkExt;

    // 开发期每�?�?��都注册一次幂等；正式打包�?installer 会接管，运�?时注册仍�?��漏�?
    let _ = app.deep_link().register("flowix");

    // macOS / Windows: OS 把深链投�?running app, 通过 deep-link 插件回调派发�?
    let app_handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            emit_open_target_if_resolved(&app_handle, url.as_str());
        }
    });
}

#[cfg(not(desktop))]
fn register_deep_links(_app: &mut tauri::App) {}

fn handle_cold_start_open_targets(app: &tauri::AppHandle) {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let paths = commands::markdown_paths_from_args(args.clone());
    if !paths.is_empty() {
        if let Some(main_window) = app.get_webview_window("main") {
            main_window.hide().ok();
        }
        for path in &paths {
            route_markdown_path_to_tab(app, path);
        }
    }
    for arg in args {
        if !paths.contains(&arg) {
            emit_open_target_if_resolved(app, &arg);
        }
    }
}

fn route_markdown_path_to_tab(app: &tauri::AppHandle, path: &str) {
    let state = app.state::<AppState>();
    let coordinator = app.state::<commands::tab_window::TabWindowCoordinator>();
    if let Err(error) =
        commands::tab_window::route_markdown_path_tab(app, state.inner(), coordinator.inner(), path)
    {
        tracing::warn!("[open-markdown] failed to route {path}: {error}");
    }
}

fn emit_open_target_if_resolved(app: &tauri::AppHandle, raw: &str) {
    let state = app.state::<AppState>();
    if let Ok(target) = open_target::parse_open_target(raw) {
        if let Ok(resolved) = open_target::resolve_open_target(target, state.memo_file.as_ref()) {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
            dispatcher::emit_to(app, "flowix:open-target", resolved);
        }
    }
}

fn handle_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
            for url in urls {
                if url.scheme() == "file" {
                    if let Ok(path) = url.to_file_path() {
                        let path = path.to_string_lossy().to_string();
                        if !commands::markdown_paths_from_args([path.clone()]).is_empty() {
                            route_markdown_path_to_tab(app, &path);
                        }
                    }
                }
            }
        }
        tauri::RunEvent::ExitRequested { .. } => {
            stop_external_agent_children(app, "exit");
        }
        tauri::RunEvent::Exit => {
            stop_external_agent_children(app, "final exit");
        }
        _ => {}
    }
}

/// 退出路径上等待 5 个 CLI manager `stop_all` 的总时长上界。
///
/// `stop_all` -> `kill_child_tree` 在 Unix 同步发 SIGTERM/SIGKILL、在 Windows 跑
/// `taskkill /T /F`, 正常 ms 级完成; 若某子进程句柄 `child.kill().await` 卡住,
/// 无上界会让 `block_on` 永不返回 ── 表现为 app 退不掉。超时即放行退出: kill 信号
/// 已在超时前并发送出, 句柄是否回收不影响子进程已被杀。
const EXTERNAL_AGENT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

fn stop_external_agent_children(app: &tauri::AppHandle, phase: &str) {
    let state = app.state::<AppState>();
    tauri::async_runtime::block_on(async {
        // ExternalRuntimeRegistry 并发停止所有 manager，既缩短
        // 正常退出耗时, 也保证即便某个 `child.kill().await` 卡住, 其余 manager 的
        // kill 信号仍及时送出。超时后整个 join future 被 drop ── 取消未完成的
        // `stop_all`, 但 SIGTERM/SIGKILL 已在 `kill_child_tree` 内同步发出。
        let stopped = tokio::time::timeout(
            EXTERNAL_AGENT_SHUTDOWN_TIMEOUT,
            state.external_runtimes.stop_all(),
        )
        .await;

        match stopped {
            Ok(stopped) => {
                let total = stopped.iter().map(|(_, count)| count).sum::<usize>();
                if total > 0 {
                    let summary = stopped
                        .iter()
                        .map(|(key, count)| format!("{key}={count}"))
                        .collect::<Vec<_>>()
                        .join(", ");
                    tracing::info!("stopped external agent children on {phase}: {summary}");
                }
            }
            Err(_) => {
                tracing::warn!(
                    "external agent shutdown on {phase} exceeded {EXTERNAL_AGENT_SHUTDOWN_TIMEOUT:?}; kill signals already dispatched, proceeding with exit"
                );
            }
        }
    });
}
