use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use crate::USER_CONFIG_DIR_NAME;
use flowix_core::secret::{entry_name, SecretStore};

/// AI 模型配置文件�?── TOML 格式, 便于人手编辑与注释�?///
/// TOML 格式便于用户手改磁盘配置时写注释 (TOML 原生 `# ...`), 避免�?��字�?�?/// �?Flowix 的其它配�?���?(`boot/preference.json` /
///    `boot/system.json` / `index.db`) 鍖哄垎寰楁洿鏄剧溂
///    (TOML 格式 + 显式 `agent-` 前缀, 不会出现"�?��文件该用 JSON"的�?�?
pub const AI_CONFIG_FILE_NAME: &str = "agent-config.toml";

const BOOT_DIR_NAME: &str = "boot";
const PREFERENCE_FILE_NAME: &str = "preference.json";
const DEFAULT_SECRET_DB_NAME: &str = "default.db";
const SECRET_ACCOUNT_NAME: &str = "default";
const CLOUD_SECRET_PROVIDER: &str = "flowix_cloud_refresh";

/// ~/.flowix/boot/preference.json —用户偏好设置
/// 瀛楁鍏ㄩ儴 #[serde(default)], 鏂囦欢鎹熷潖鎴栫己澶辨椂鍥為€€鍒伴粯璁ゅ€笺€?
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalizeConfig {
    #[serde(default)]
    pub custom_instruction: String,
    #[serde(default)]
    pub response_length: String,
    #[serde(default)]
    pub preferred_language: String,
    #[serde(default)]
    pub selected_tags: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatConfig {
    #[serde(default)]
    pub font_family: String,
    #[serde(default)]
    pub font_id: Option<String>,
    #[serde(default)]
    pub font_size: f64,
    #[serde(default)]
    pub line_height: f64,
    /// 文档编辑区最大�?�?(px) —应用�?Tiptap ProseMirror max-width�?
    /// 镜像前�? `FormatConfig.documentWidth`, �?preference.json 没�?字�?
    /// 时由 `#[serde(default)]` 兜底�?0, 前�? sanitizeSettings 会用默�?值�?盖�?
    #[serde(default)]
    pub document_width: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyFieldConfig {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub r#type: String,
    #[serde(default)]
    pub options: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertiesConfig {
    #[serde(default)]
    pub fields: Vec<PropertyFieldConfig>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsConfig {
    #[serde(default)]
    pub enabled_by_type: HashMap<String, bool>,
    /// 常用�?���?── 用户在偏好�?�?�?工具 tab 里维�?
    /// 在�?色选择弹窗作为�?��输入片�?注入 composer�?
    /// �?preference.json 没有此字段时�?`#[serde(default)]` 兜底为空数组�?
    #[serde(default)]
    pub quick_phrases: Vec<QuickPhrase>,
}

/// 单条常用�?── 标�? + 提示词�?镜像前�? `QuickPhrase` 接口�?/// 后�?不做内�?校验 (长度 / 字�?必填), 由前�?sanitizeSettings 兜底;
/// 鍚庣鍙礋璐ｆ寔涔呭寲, 淇濊瘉搴忓垪鍖栧瓧娈靛畬鏁淬€?
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickPhrase {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub prompt: String,
}

fn default_product_updates_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductUpdatesConfig {
    #[serde(default = "default_product_updates_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub last_checked_at: i64,
    #[serde(default)]
    pub dismissed_notice_ids: Vec<String>,
    #[serde(default)]
    pub remind_later: HashMap<String, i64>,
}

impl Default for ProductUpdatesConfig {
    fn default() -> Self {
        Self {
            enabled: default_product_updates_enabled(),
            last_checked_at: 0,
            dismissed_notice_ids: Vec::new(),
            remind_later: HashMap::new(),
        }
    }
}

/// 合法主�?枚举 —替代原来的裸 `String`, �?serde 边界上约束取值�?///
/// 序列化形式是小写字�?�?(`"system"` / `"light"` / ...), 与前�?`ThemeId` 联合
/// 类型字面量一一对应; 老的 preference.json (字�?�? 仍然兼�?读取�?/// 任何不在 6 �?��体里的字符串 (例�?用户手改磁盘 / �?��客户�?��新主�? 会在
/// 反序列化阶�?直接报错, 不会写回内存 —兜底由前�?�� sanitizeTheme 兜底�?"system"�?
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
    Rock,
    Mist,
    /// 暖米纸面 + 珊瑚橙焦�?(主色 #FB6A42), �?rock/mist 占据同一"克制�?
    /// �?+ 单色�?槽位但走暖色�?���?前�? css/theme/ember.css 提供色板�?
    Ember,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceFile {
    #[serde(default)]
    pub personalize: PersonalizeConfig,
    #[serde(default)]
    pub format: FormatConfig,
    #[serde(default)]
    pub theme: Theme,
    /// UI display language. Separate from `personalize.preferred_language`,
    /// which only guides AI replies.
    #[serde(default)]
    pub language: String,
    /// Installation region detected by the frontend on first launch.
    #[serde(default)]
    pub region: String,
    /// Memo list card presentation ("detailed" | "compact").
    #[serde(default)]
    pub memo_card_variant: String,
    /// User shortcut overrides keyed by action id.
    #[serde(default)]
    pub shortcuts: HashMap<String, String>,
    /// 鐢ㄦ埛涓诲姩閰嶇疆杩囩殑鑷畾涔夊睘鎬у瓧娈靛畾涔夈€傚墠绔敤浜庡睘鎬у脊绐楀洖鏄俱€?
    #[serde(default)]
    pub properties: PropertiesConfig,
    /// Agent visibility preferences. Missing values default to enabled in the frontend.
    #[serde(default)]
    pub agents: AgentsConfig,
    #[serde(default)]
    pub product_updates: ProductUpdatesConfig,
    /// 文件监听�?黑名�?(skip_dirs / skip_files / allowed_extensions /
    /// max_file_size / watch_hidden)銆侾R2: 鎸佷箙鍖栧埌 preference.json,
    /// PR3 鎺ュ叆 IPC 鐑洿鏂般€?
    #[serde(default)]
    pub watcher: crate::watcher::WhitelistConfig,
}

/// AI 模型配置真源 `~/.flowix/agent-config.toml`�?///
/// `PartialEq` / `Eq` 派生用于 `AgentManager` 的缓存命�?���?(`agent.rs`
/// �?`ensure_instance` 会用 `cached.config == config` 比较)。结构体�?��
/// `String` 字�?, 派生�?derive 足�?�?///
/// 字�?�? 保留 `#[serde(rename_all = "camelCase")]` ──
///
/// - IPC (Tauri) 边界�?JSON, camelCase 与前�?`AgentConfig` 对齐
/// - TOML 文件�?camelCase 仍然合法 (TOML 不强�?snake_case), 不破�?///   任何持久化形�? 也不�?`get_ai_config` / `set_ai_config` �?JSON
///   �?TOML 之间走两�?rename 规则
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelConfig {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_url: String,
    /// �?provider 隔�?�?key �? `provider -> apiKey`�?    /// 前�?切换供应商时直接读这�? 互相不串�?
    #[serde(default)]
    pub api_keys: HashMap<String, String>,
    /// 单�? `chat_stream` 调用跨所�?cycle �?token �??上限。`Usage` �?    /// provider 在每�?��的末尾单�?push 一�? agent �?cycle �?�� `total_tokens`,
    /// 超出即熔�?���?`AgentError::TokenBudget` 收口。`0` 表示不限�?(保留
    /// 历史行为, 也方便单�?。默�?180_000 ── 100 cycle × 1.8k token,
    /// 留出 reasoning + system_prompt 余量, 同时挡住"工具结果越喂越胖"�?    /// wallet drain�?
    #[serde(default = "default_max_total_tokens")]
    pub max_total_tokens: u32,
}

fn default_max_total_tokens() -> u32 {
    180_000
}

// 手写 Default 而非 `#[derive(Default)]`: 派生实现�?`<u32 as Default>::default()`
// 缁欏埌 0, 涓嶈 `default_max_total_tokens()` 鈹€鈹€ 閭ｆ潯鍑芥暟鍙鍙嶅簭鍒楀寲
// (`#[serde(default = "...")]`) 鐢熸晥銆備袱鏉¤矾寰勫繀椤荤粰鍒板悓涓€涓厹搴曞€? 鍚﹀垯
// "刚启动未读盘" �?"�?config 缺字�? 行为分�? ── 前者会拿到 budget=0
// 等于不限, 后者会拿到 180_000�?
impl Default for AiModelConfig {
    fn default() -> Self {
        Self {
            provider: String::new(),
            model: String::new(),
            api_url: String::new(),
            api_keys: HashMap::new(),
            max_total_tokens: default_max_total_tokens(),
        }
    }
}

impl AiModelConfig {
    /// 取当�?provider 的有�?key, �?`api_keys[provider]`�?    /// 没找到返回空�? 调用方自己决定是否报错�?
    pub fn effective_api_key(&self, provider: &str) -> &str {
        self.api_keys
            .get(provider)
            .filter(|k| !k.trim().is_empty())
            .map(String::as_str)
            .unwrap_or("")
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigFile {
    #[serde(default)]
    pub model: AiModelConfig,
}

/// 全局用户配置存储。启动时一次性从磁盘读入内存, 写操作先落盘再更内存�?
pub struct UserConfigStore {
    config_dir: PathBuf,
    preference: RwLock<PreferenceFile>,
    ai_config: RwLock<AiConfigFile>,
    secrets: SecretStore,
}

/// 用户配置 (boot/preference.json / agent-config.toml) 写盘错�?。`Io` �?���?/// `std::io::Error` �? `Json` �?`serde_json::Error` �?(preference.json
/// 仍走 JSON), `Toml` �?`toml::ser::Error` �?(ai_config.toml �?TOML)�?/// 之前�?`io::Error::new(io::ErrorKind::Other, e)` 手动包�?的写法可以删�?
/// �?`?` 一步到位�?
#[derive(Debug, thiserror::Error)]
pub enum UserConfigError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("toml serialization error: {0}")]
    Toml(#[from] toml::ser::Error),
    #[error("secret store error: {0}")]
    SecretStore(String),
}

impl UserConfigStore {
    /// 持锁失败的兜�? 锁中�?(panic held it) 时仍返回 guard, 不�?单点 panic
    /// 拖垮整个 Tauri 进程。中毒意味着 in-memory 状态可能�?于不一�? �?    /// 我们�?setter 写入顺序 (disk-first, 然后整体赋�? 让这种情况极少�?
    fn read_preference(&self) -> std::sync::RwLockReadGuard<'_, PreferenceFile> {
        self.preference.read().unwrap_or_else(|poisoned| {
            tracing::error!("preference lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    fn write_preference(&self) -> std::sync::RwLockWriteGuard<'_, PreferenceFile> {
        self.preference.write().unwrap_or_else(|poisoned| {
            tracing::error!("preference lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    fn read_ai_config(&self) -> std::sync::RwLockReadGuard<'_, AiConfigFile> {
        self.ai_config.read().unwrap_or_else(|poisoned| {
            tracing::error!("ai_config lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    fn write_ai_config(&self) -> std::sync::RwLockWriteGuard<'_, AiConfigFile> {
        self.ai_config.write().unwrap_or_else(|poisoned| {
            tracing::error!("ai_config lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    pub fn new(home_dir: PathBuf) -> Self {
        // 鍑嵁 db 钀藉湪 config_dir/default.db (鐢熶骇鐜 ~/.flowix/default.db),
        // �?index.db 同目�?── �?0o700 �?�� + 0o600 文件权限保护�?
        let db_path = home_dir
            .join(USER_CONFIG_DIR_NAME)
            .join(DEFAULT_SECRET_DB_NAME);
        Self::new_with_secret_store(home_dir, SecretStore::new(db_path))
    }

    fn new_with_secret_store(home_dir: PathBuf, secrets: SecretStore) -> Self {
        let config_dir = home_dir.join(USER_CONFIG_DIR_NAME);
        let _ = fs::create_dir_all(&config_dir);
        // Restrict the configuration directory to its owner.
        set_dir_owner_only_perms(&config_dir);

        let preference = Self::read_preference_from_disk(&config_dir).unwrap_or_default();
        let ai_config = Self::read_ai_config_from_disk(&config_dir).unwrap_or_default();
        Self {
            config_dir,
            preference: RwLock::new(preference),
            ai_config: RwLock::new(ai_config),
            secrets,
        }
    }

    #[allow(dead_code)]
    pub fn config_dir(&self) -> &PathBuf {
        &self.config_dir
    }

    pub fn get_preference(&self) -> PreferenceFile {
        self.read_preference().clone()
    }

    /// 先把 JSON 落盘 (tmp + fsync + rename, 0o600), 成功后才更新内存�?    /// 任一写�?骤失�?�?内存保持旧�? 磁盘保持旧文�? 不出�?内存新�?盘旧"�?    /// "半写�?��"的损坏状态�?
    pub fn set_preference(&self, p: PreferenceFile) -> Result<(), UserConfigError> {
        let content = serde_json::to_string_pretty(&p)?;
        let path = preference_file_path(&self.config_dir);
        atomic_write_json(&path, &content)?;
        *self.write_preference() = p;
        Ok(())
    }

    pub fn get_ai_config(&self) -> AiConfigFile {
        let mut config = self.read_ai_config().clone();
        self.hydrate_ai_config_secrets(&mut config);
        config
    }

    /// 先把 secrets �?db (主存�?, 再把 **不含明文 key** �?TOML 落盘
    /// (tmp + fsync + rename, 0o600), 成功后才更新内存�?    ///
    /// **榛樿娓呯┖ TOML 閲岀殑 plaintext** 鈹€鈹€ 涓嶆妸妯″瀷 key 鍐欒繘
    /// `agent-config.toml`。fallback 仅针对历史版�?��写入�?plaintext:
    /// [`Self::get_ai_config`] �?hydrate �?db 没命�?(`None` / `Err`)
    /// 时保持内存�? 而内存值在�?��时由 `read_ai_config_from_disk` �?    /// 磁盘读入 ── 老用�?TOML 若带历史 plaintext, 此�?能兜�? 一旦走�?    /// �?��数写�? TOML 即不再含明文, 后续 fallback 依赖 db�?    ///
    /// 任一写�?骤失�?-> 内存保持旧�? 磁盘保持旧文�? 不出现内存新磁盘旧或
    /// 半写�?��的损坏状态。Tauri IPC 边界�?`UserConfigError` `.map_err` �?    /// `String` 后返回给前�? (`commands/settings.rs`)�?
    pub fn set_ai_config(&self, mut c: AiConfigFile) -> Result<(), UserConfigError> {
        self.persist_ai_config_secrets(&c)?;
        clear_ai_config_plaintext_secrets(&mut c);
        let content = toml::to_string_pretty(&c)?;
        let path = self.config_dir.join(AI_CONFIG_FILE_NAME);
        atomic_write_toml(&path, &content)?;
        *self.write_ai_config() = c;
        Ok(())
    }

    fn persist_ai_config_secrets(&self, config: &AiConfigFile) -> Result<(), UserConfigError> {
        let model = &config.model;

        for (provider, secret) in &model.api_keys {
            if provider.trim().is_empty() {
                continue;
            }
            if secret.trim().is_empty() {
                self.delete_provider_secret(provider)?;
            } else {
                self.save_provider_secret(provider, secret)?;
            }
        }

        Ok(())
    }

    /// �?db 里的 secret �?�� `api_keys` ── **db 优先, 缺失�?fallback
    /// 鍒?TOML plaintext**銆?    ///
    /// - `Ok(Some)` -> �?db 的值�?�?(db �?��存储)
    /// - `Ok(None)` / `Err` -> 保持 `config` 里已有的�? 即�?�?TOML �?    ///   plaintext (�?��时由 `read_ai_config_from_disk` 读入)。这�?    ///   `agent-config.toml` 兜底�?��: db 损坏 / �?�� / 迁移期老配�?    ///   都能从这里�?�?key, 不阻�?agent�?
    fn hydrate_ai_config_secrets(&self, config: &mut AiConfigFile) {
        let providers: Vec<String> = config.model.api_keys.keys().cloned().collect();

        for provider in providers {
            let account = entry_name(&provider, SECRET_ACCOUNT_NAME);
            match self.secrets.load(&account) {
                Ok(Some(secret)) => {
                    config.model.api_keys.insert(provider, secret.into_inner());
                }
                Ok(None) => {}
                Err(err) => {
                    tracing::warn!(
                        "failed to load api key from db for provider `{provider}`: {err}"
                    );
                }
            }
        }
    }

    fn save_provider_secret(&self, provider: &str, secret: &str) -> Result<(), UserConfigError> {
        let account = entry_name(provider, SECRET_ACCOUNT_NAME);
        self.secrets
            .save(&account, secret.trim())
            .map_err(|err| UserConfigError::SecretStore(err.to_string()))
    }

    fn delete_provider_secret(&self, provider: &str) -> Result<(), UserConfigError> {
        let account = entry_name(provider, SECRET_ACCOUNT_NAME);
        self.secrets
            .delete(&account)
            .map(|_| ())
            .map_err(|err| UserConfigError::SecretStore(err.to_string()))
    }

    pub fn save_cloud_refresh_token(&self, token: &str) -> Result<(), UserConfigError> {
        self.save_provider_secret(CLOUD_SECRET_PROVIDER, token)
    }

    pub fn load_cloud_refresh_token(&self) -> Result<Option<String>, UserConfigError> {
        let account = entry_name(CLOUD_SECRET_PROVIDER, SECRET_ACCOUNT_NAME);
        self.secrets
            .load(&account)
            .map(|value| value.map(|secret| secret.into_inner()))
            .map_err(|err| UserConfigError::SecretStore(err.to_string()))
    }

    pub fn delete_cloud_refresh_token(&self) -> Result<(), UserConfigError> {
        self.delete_provider_secret(CLOUD_SECRET_PROVIDER)
    }

    fn read_preference_from_disk(dir: &PathBuf) -> Option<PreferenceFile> {
        let path = preference_file_path(dir);
        if !path.exists() {
            return None;
        }
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
    }

    fn read_ai_config_from_disk(dir: &PathBuf) -> Option<AiConfigFile> {
        let path = dir.join(AI_CONFIG_FILE_NAME);
        if !path.exists() {
            return None;
        }
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| toml::from_str(&s).ok())
    }
}

fn clear_ai_config_plaintext_secrets(config: &mut AiConfigFile) {
    for value in config.model.api_keys.values_mut() {
        value.clear();
    }
}

fn preference_file_path(config_dir: &Path) -> PathBuf {
    config_dir.join(BOOT_DIR_NAME).join(PREFERENCE_FILE_NAME)
}

/// 原子�?JSON: �?.tmp �?fsync �?0o600 �?rename 到目标�?/// 失败�?.tmp 残留由下次启动�?�? 不影响主文件�?///
/// `pub(crate)` —`agent_access` 等同形态的 JSON 配置文件 (�?boot/preference.json)
/// 同目�? 复用这个落盘逻辑, 不�?制�?二份�?
pub(crate) fn atomic_write_json(path: &Path, content: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        set_dir_owner_only_perms(parent);
    }
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
    }
    // Restrict the temporary file before the atomic rename.
    set_file_owner_only_perms(&tmp);
    fs::rename(&tmp, path)?;
    // rename 之后�?chmod 一�? 覆盖�?��文件权限 (POSIX rename 保留 source 权限)
    set_file_owner_only_perms(path);
    Ok(())
}

/// 原子�?TOML: �?.tmp �?fsync �?0o600 �?rename 到目标�?/// �?`atomic_write_json` 同等保证, �?.tmp 后缀�?`.json.tmp` 换成 `.toml.tmp`
/// 浠ユ柟渚夸汉宸ユ帓鏌ョ鐩樻畫鐣欍€?
pub(crate) fn atomic_write_toml(path: &Path, content: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("toml.tmp");
    {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
    }
    set_file_owner_only_perms(&tmp);
    fs::rename(&tmp, path)?;
    set_file_owner_only_perms(path);
    Ok(())
}

#[cfg(unix)]
fn set_file_owner_only_perms(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(0o600);
    let _ = std::fs::set_permissions(path, perms);
}

#[cfg(not(unix))]
fn set_file_owner_only_perms(_path: &Path) {}

#[cfg(unix)]
fn set_dir_owner_only_perms(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.is_dir() {
            let perms = std::fs::Permissions::from_mode(0o700);
            let _ = std::fs::set_permissions(path, perms);
        }
    }
}

#[cfg(not(unix))]
fn set_dir_owner_only_perms(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;
    use flowix_core::secret::{KeyBackend, SecretBackend, SecretStoreError, SecretString};
    use std::sync::Mutex;

    struct TestSecretBackend {
        store: Mutex<HashMap<String, String>>,
    }

    impl TestSecretBackend {
        fn new() -> Self {
            Self {
                store: Mutex::new(HashMap::new()),
            }
        }
    }

    impl SecretBackend for TestSecretBackend {
        fn save(&self, account: &str, secret: &str) -> Result<(), SecretStoreError> {
            self.store
                .lock()
                .unwrap()
                .insert(account.to_string(), secret.to_string());
            Ok(())
        }

        fn load(&self, account: &str) -> Result<Option<SecretString>, SecretStoreError> {
            Ok(self
                .store
                .lock()
                .unwrap()
                .get(account)
                .cloned()
                .map(SecretString::new))
        }

        fn delete(&self, account: &str) -> Result<bool, SecretStoreError> {
            Ok(self.store.lock().unwrap().remove(account).is_some())
        }

        fn backend_name(&self) -> KeyBackend {
            KeyBackend::Database
        }
    }

    fn test_user_config_store(home: PathBuf) -> UserConfigStore {
        UserConfigStore::new_with_secret_store(
            home,
            SecretStore::with_backend(Box::new(TestSecretBackend::new())),
        )
    }

    #[test]
    fn max_total_tokens_default_is_180k() {
        // 榛樿 180k 鈹€鈹€ 100 cycle 脳 1.8k token, 鐣欏嚭 reasoning + system_prompt
        // 浣欓噺銆傛敼榛樿鍊兼椂杩欐潯鍗曟祴蹇呴』鍚屾鏀广€?
        let cfg = AiModelConfig::default();
        assert_eq!(cfg.max_total_tokens, 180_000);
    }

    #[test]
    fn cloud_refresh_token_round_trips_without_entering_preferences() {
        let home = tempfile::tempdir().unwrap();
        let store = test_user_config_store(home.path().to_path_buf());

        assert_eq!(store.load_cloud_refresh_token().unwrap(), None);
        store.save_cloud_refresh_token("refresh-secret").unwrap();
        assert_eq!(
            store.load_cloud_refresh_token().unwrap().as_deref(),
            Some("refresh-secret")
        );
        store.delete_cloud_refresh_token().unwrap();
        assert_eq!(store.load_cloud_refresh_token().unwrap(), None);
    }

    #[test]
    fn max_total_tokens_round_trips_through_toml() {
        let cfg = AiModelConfig {
            provider: "openai".into(),
            model: "gpt-4o".into(),
            api_url: "https://x".into(),
            api_keys: HashMap::new(),
            max_total_tokens: 50_000,
        };
        let s = toml::to_string(&cfg).unwrap();
        assert!(s.contains("maxTotalTokens = 50000"), "got: {s}");
        let back: AiModelConfig = toml::from_str(&s).unwrap();
        assert_eq!(back.max_total_tokens, 50_000);
        assert_eq!(back.model, "gpt-4o");
    }

    #[test]
    fn ai_config_file_round_trips_through_toml() {
        // 真源�?AiConfigFile (包一�?model), 整份�?TOML 序列化�?
        let cfg = AiConfigFile {
            model: AiModelConfig {
                provider: "anthropic".into(),
                model: "claude-3".into(),
                api_url: "https://api.anthropic.com".into(),
                api_keys: HashMap::new(),
                max_total_tokens: 90_000,
            },
        };
        let s = toml::to_string_pretty(&cfg).unwrap();
        assert!(s.contains("[model]"), "got: {s}");
        let back: AiConfigFile = toml::from_str(&s).unwrap();
        assert_eq!(back, cfg);
    }

    #[test]
    fn json_model_without_max_total_tokens_loads_with_default() {
        // 缂哄皯 maxTotalTokens 瀛楁鏃跺繀椤昏兘鍙嶅簭鍒楀寲, 钀藉埌
        // 默�? 180_000, 不能让用户�?�?��突然多了一�?None / 0 熔断�?        // �?JSON 反序列化 (迁移�?�� / 老文件直接走读盘), 验证 `#[serde(default = ...)]` 生效�?
        let json = r#"{
            "provider": "openai",
            "model": "gpt-4o",
            "apiUrl": "https://x",
            "apiKey": "k"
        }"#;
        let cfg: AiModelConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.max_total_tokens, 180_000);
    }

    #[test]
    fn toml_config_without_max_total_tokens_loads_with_default() {
        // 手写�?TOML (用户直接编辑) 缺字段时也走 serde default ── �?JSON 同�?义�?
        let toml_content = r#"
[model]
provider = "openai"
model = "gpt-4o"
apiUrl = "https://x"
apiKey = "k"
"#;
        let cfg: AiConfigFile = toml::from_str(toml_content).unwrap();
        assert_eq!(cfg.model.max_total_tokens, 180_000);
        assert_eq!(cfg.model.model, "gpt-4o");
    }

    #[test]
    fn set_preference_writes_to_boot_dir() {
        let home = tempfile::tempdir().unwrap();
        let store = UserConfigStore::new(home.path().to_path_buf());
        let mut pref = PreferenceFile::default();
        pref.language = "en".to_string();

        store.set_preference(pref).unwrap();

        let config_dir = home.path().join(USER_CONFIG_DIR_NAME);
        let new_path = preference_file_path(&config_dir);
        assert!(
            new_path.exists(),
            "preference should be written under boot/"
        );
        let content = std::fs::read_to_string(new_path).unwrap();
        let saved: PreferenceFile = serde_json::from_str(&content).unwrap();
        assert_eq!(saved.language, "en");
    }

    #[test]
    fn set_ai_config_redacts_plaintext_from_toml_and_persists_to_db() {
        let home = tempfile::tempdir().unwrap();
        let store = test_user_config_store(home.path().to_path_buf());
        let cfg = AiConfigFile {
            model: AiModelConfig {
                provider: "OpenAI Responses API".into(),
                model: "gpt-5.5".into(),
                api_url: "https://api.openai.com/v1".into(),
                api_keys: HashMap::from([
                    ("OpenAI Responses API".to_string(), "sk-openai".to_string()),
                    ("Anthropic".to_string(), "sk-ant".to_string()),
                ]),
                max_total_tokens: 50_000,
            },
        };

        store.set_ai_config(cfg).unwrap();

        // db �?��存储; TOML 默�?不含明文 key (redact, 不写 plaintext)�?
        let path = home
            .path()
            .join(USER_CONFIG_DIR_NAME)
            .join(AI_CONFIG_FILE_NAME);
        let content = std::fs::read_to_string(path).unwrap();
        assert!(!content.contains("sk-openai"), "got: {content}");
        assert!(!content.contains("sk-ant"), "got: {content}");

        // get �?db 读回 (db 命中)
        let loaded = store.get_ai_config();
        assert_eq!(
            loaded
                .model
                .api_keys
                .get("OpenAI Responses API")
                .map(String::as_str),
            Some("sk-openai")
        );
        assert_eq!(
            loaded.model.api_keys.get("Anthropic").map(String::as_str),
            Some("sk-ant")
        );
    }

    #[test]
    fn get_ai_config_falls_back_to_toml_plaintext_when_db_misses() {
        let home = tempfile::tempdir().unwrap();
        let config_dir = home.path().join(USER_CONFIG_DIR_NAME);
        std::fs::create_dir_all(&config_dir).unwrap();
        // 预置一份含 plaintext �?TOML ── 模拟 db �?���?/ 迁移前老配�?�?        // �?to_string_pretty 生成, 保证 from_str 能原样解析�?
        let seed = AiConfigFile {
            model: AiModelConfig {
                provider: "Anthropic".into(),
                model: "claude-3".into(),
                api_url: "https://api.anthropic.com".into(),
                api_keys: HashMap::from([(
                    "Anthropic".to_string(),
                    "sk-ant-from-toml".to_string(),
                )]),
                max_total_tokens: 50_000,
            },
        };
        std::fs::write(
            config_dir.join(AI_CONFIG_FILE_NAME),
            toml::to_string_pretty(&seed).unwrap(),
        )
        .unwrap();

        // TestSecretBackend �?��内存 ── db 没找�?key -> fallback �?TOML plaintext
        let store = test_user_config_store(home.path().to_path_buf());
        let loaded = store.get_ai_config();
        assert_eq!(
            loaded.model.api_keys.get("Anthropic").map(String::as_str),
            Some("sk-ant-from-toml"),
            "should fall back to toml plaintext when db misses"
        );
        assert_eq!(
            loaded.model.effective_api_key("Anthropic"),
            "sk-ant-from-toml"
        );
    }

    #[test]
    fn set_ai_config_deletes_empty_provider_secret() {
        let home = tempfile::tempdir().unwrap();
        let store = test_user_config_store(home.path().to_path_buf());

        store
            .set_ai_config(AiConfigFile {
                model: AiModelConfig {
                    provider: "Anthropic".into(),
                    api_keys: HashMap::from([("Anthropic".to_string(), "sk-ant".to_string())]),
                    ..AiModelConfig::default()
                },
            })
            .unwrap();
        assert_eq!(
            store
                .get_ai_config()
                .model
                .api_keys
                .get("Anthropic")
                .map(String::as_str),
            Some("sk-ant")
        );

        store
            .set_ai_config(AiConfigFile {
                model: AiModelConfig {
                    provider: "Anthropic".into(),
                    api_keys: HashMap::from([("Anthropic".to_string(), String::new())]),
                    ..AiModelConfig::default()
                },
            })
            .unwrap();

        assert_eq!(
            store
                .get_ai_config()
                .model
                .api_keys
                .get("Anthropic")
                .map(String::as_str),
            Some("")
        );
    }
}
