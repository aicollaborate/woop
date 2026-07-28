use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::Value;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Child;
#[cfg(windows)]
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::agent_flowix::{AgentChunk, AgentUserMessage, RunInfo};
use crate::agent_session::{NewAgentExternalEvent, ThreadManager};
use crate::events as dispatcher;
use crate::runtime_log;

mod lifecycle;
mod process_io;
mod runtime;

pub use lifecycle::*;
#[cfg(test)]
use lifecycle::{default_raw_json_enabled, parse_env_bool};
pub use process_io::*;
pub use runtime::*;

#[cfg(test)]
mod tests;
