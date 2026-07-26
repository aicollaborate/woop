use std::sync::Arc;

use crate::agent_external::runtime_registry::ExternalRuntimeRegistry;

const EXTERNAL_AGENT_WATCHDOG_INTERVAL_MS: u64 = 5_000;
const EXTERNAL_AGENT_DEFAULT_IDLE_TIMEOUT_MS: i64 = 30 * 60 * 1_000;

fn external_agent_watchdog_idle_timeout_ms() -> i64 {
    std::env::var("FLOWIX_EXTERNAL_AGENT_IDLE_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value >= 0)
        .unwrap_or(EXTERNAL_AGENT_DEFAULT_IDLE_TIMEOUT_MS)
}

/// Spawn the idle-watchdog that finalizes external-CLI runs which have gone
/// silent (no stdout event for `idle_timeout_ms`). The watchdog must cover
/// **every** external runtime -- a hung child in any vendor would otherwise
/// leak (its registry entry lingers, blocking future runs on that thread, and
/// on Unix its process group is never reaped).
pub fn spawn_external_agent_watchdog(
    app_handle: tauri::AppHandle,
    runtimes: Arc<ExternalRuntimeRegistry>,
) {
    let idle_timeout_ms = external_agent_watchdog_idle_timeout_ms();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(
            EXTERNAL_AGENT_WATCHDOG_INTERVAL_MS,
        ));
        loop {
            interval.tick().await;
            let finalized = runtimes
                .reap_inactive_runs(&app_handle, idle_timeout_ms)
                .await;
            let total = finalized.iter().map(|(_, count)| count).sum::<usize>();
            if total > 0 {
                let summary = finalized
                    .iter()
                    .map(|(key, count)| format!("{key}={count}"))
                    .collect::<Vec<_>>()
                    .join(", ");
                tracing::warn!(
                    "external agent watchdog finalized runs: {summary}, idle_timeout_ms={idle_timeout_ms}"
                );
            }
        }
    });
}
