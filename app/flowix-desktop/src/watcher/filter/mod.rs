//! Filter pipeline —`RawFsEvent` 串接多�? `Filter`�?//!
//! 璁捐:
//! - `Filter::decide(event, &mut Ctx) -> FilterDecision`, `Pass` 放�? (事件�?//!   替换�?`event` 或新事件), `Drop` 拒绝并�? reason, `PassMutated` 放�?
//!   但替�?���?(例�?�?��规范化后)。短�? 任一 Filter 返回 `Drop` 后续不再执�?�?//! - `FilterCtx` �?filter 间共�?���?��状�?(recent_self_writes / last_emit /
//!   watcher 句柄) —同一 watcher 持有一�? callback �?��
//!   引用它�?//! - 跑顺序为 PathFilter �?SelfWriteSuppressor �?Debouncer�?//!   ExtensionFilter �?WhitelistConfig 覆盖, 集成�?//!   PathFilter �?(复用同一�?path 检�?, 不单�?��段以省一�?path 操作�?//!
//! Concrete stages live in the sibling modules; this module owns shared state
//! and pipeline composition.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use super::event::{FilterDecision, RawFsEvent};

pub mod debouncer;
pub mod path_filter;
pub mod self_write;

pub use path_filter::PathFilter;

/// �?��抑制�?TTL —2 秒。�?盖绝大部�?IPC 命令结束 �?notify 回调到达的间隔�?
pub const SELF_WRITE_TTL: Duration = Duration::from_secs(2);
/// �?��防抖窗口 —150ms。�?�?macOS FSEvents �?save 时偶发的双触发�?
pub const DEBOUNCE: Duration = Duration::from_millis(150);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileRevision([u8; 32]);

impl FileRevision {
    pub fn read(path: &std::path::Path) -> Option<Self> {
        let bytes = std::fs::read(path).ok()?;
        Some(Self(Sha256::digest(bytes).into()))
    }
}

#[derive(Clone, Debug)]
pub struct SelfWriteMark {
    pub marked_at: Instant,
    pub expected_revision: Option<FileRevision>,
}

pub type SelfWriteMap = HashMap<PathBuf, SelfWriteMark>;
/// Filter 共享�?运�?时上下文" —�?`MemoWatcher` 创建, �?��捕获引用�?///
/// �?Filter �?��读写�?��关心的字�? 互不干扰。`watcher` 句柄保留
/// `mark_self_write` 入口�?
pub struct FilterCtx {
    /// Self-write candidates keyed by normalized path. Path equality alone
    /// never suppresses a later writer's different content revision.
    pub recent_self_writes: Arc<Mutex<SelfWriteMap>>,
    /// �?��防抖�? `normalized path -> 上�? emit 时间`�?50ms 内吞�?
    pub last_emit: Arc<Mutex<HashMap<PathBuf, Instant>>>,
}

impl FilterCtx {
    /// 构造一份空 FilterCtx�?预留 API, 主路径由 run_pipeline 内部
    /// �?Arc 拼�?不走 new(), 但�?部调用点 (e.g. 单测) �?��用�?
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self {
            recent_self_writes: Arc::new(Mutex::new(HashMap::new())),
            last_emit: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Filter trait —一段�?�? 返回 Pass / PassMutated / Drop�?
pub trait Filter: Send + Sync {
    /// `event` �?��参事�? 返回 `FilterDecision` 决定去向�?
    fn decide(&self, event: &RawFsEvent, ctx: &mut FilterCtx) -> FilterDecision;
}

/// Pipeline 顺序组�?。`whitelist` 注入白名�? `ctx` �?FilterCtx�?///
/// 顺序: PathFilter �?SelfWriteSuppressor �?Debouncer。任一 Drop �?���?
pub fn run_pipeline(
    event: &RawFsEvent,
    path_filter: &PathFilter,
) -> FilterDecision {
    let mut ctx = FilterCtx::new();
    path_filter.decide(event, &mut ctx)
}
