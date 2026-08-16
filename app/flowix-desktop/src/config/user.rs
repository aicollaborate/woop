use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
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
pub const DSH_SETTINGS_FILE_NAME: &str = "dsh-settings.yaml";
pub const DSH_PLUGIN_SETTINGS_FILE_NAME: &str = "dsh-plugin-settings.json";

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
    /// Route ID for a hand-configured DeepSeek Harness provider. Built-in
    /// providers leave this empty and continue to use the stable `flowix`
    /// bridge route for backwards compatibility.
    #[serde(default)]
    pub provider_id: String,
    /// Human-readable name for a custom Harness provider.
    #[serde(default)]
    pub display_name: String,
    /// Custom Harness provider wire protocol (`openai-completions`,
    /// `openai-responses`, or `anthropic-messages`).
    #[serde(default)]
    pub api_protocol: String,
    #[serde(default)]
    pub model: String,
    /// Hand-entered model directory for a custom Harness provider.
    #[serde(default)]
    pub models: Vec<AiModelEntry>,
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

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelEntry {
    pub id: String,
    #[serde(default)]
    pub name: String,
}

/// User overrides for the declarative DeepSeek Harness plugin composition.
/// The list contains stable catalog keys for entries the user disabled.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekHarnessPluginSettings {
    #[serde(default)]
    pub disabled: Vec<String>,
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
            provider_id: String::new(),
            display_name: String::new(),
            api_protocol: String::new(),
            model: String::new(),
            models: Vec::new(),
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

/// The durable settings document consumed by the vendored `llm-pi-ai`
/// settings provider.  Flowix keeps the selected provider/model for the
/// DeepSeek Harness here, separately from the Flowix Agent TOML config.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeepSeekHarnessSettingsFile {
    #[serde(rename = "llm-pi-ai", default)]
    pub llm_pi_ai: DeepSeekHarnessLlmSettings,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeepSeekHarnessLlmSettings {
    #[serde(default)]
    pub providers: BTreeMap<String, DeepSeekHarnessProviderSettings>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeepSeekHarnessProviderSettings {
    #[serde(default, rename = "displayName")]
    pub display_name: String,
    #[serde(default, rename = "apiKeyEnv")]
    pub api_key_env: String,
    #[serde(default)]
    pub api: String,
    #[serde(default, rename = "baseURL")]
    pub base_url: String,
    #[serde(default)]
    pub models: Vec<DeepSeekHarnessModelSettings>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeepSeekHarnessModelSettings {
    pub id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
}

impl DeepSeekHarnessSettingsFile {
    fn route_id_for_ai_config(config: &AiConfigFile) -> String {
        let provider_id = config.model.provider_id.trim();
        if provider_id.is_empty() {
            // llm-pi-ai uses the provider map key as the route identity. Keep
            // the old bridge only for an actually blank provider; a catalog
            // provider such as `deepseek` or `zai` must get its own route.
            let provider = config.model.provider.trim();
            if provider.is_empty() {
                "flowix".to_string()
            } else {
                provider.to_string()
            }
        } else {
            provider_id.to_string()
        }
    }

    fn provider_settings_for_ai_config(
        config: &AiConfigFile,
    ) -> Option<DeepSeekHarnessProviderSettings> {
        let model = &config.model;
        let provider = model.provider.trim().to_string();
        // A provider with no remaining models is removed rather than written
        // as an invalid llm-pi-ai route. The Harness schema rejects unknown
        // routes whose model directory is empty.
        if model.models.is_empty() && model.model.trim().is_empty() {
            return None;
        }
        let display_name = if model.display_name.trim().is_empty() {
            provider.clone()
        } else {
            model.display_name.trim().to_string()
        };
        // Keep an intentionally empty custom directory empty. This is used
        // by the preferences model manager after deleting the final model;
        // otherwise the legacy fallback would immediately recreate it from
        // `model` on the next read.
        let models = if model.models.is_empty() && !model.model.trim().is_empty() {
            vec![AiModelEntry {
                id: model.model.trim().to_string(),
                name: String::new(),
            }]
        } else {
            model.models.clone()
        };
        Some(DeepSeekHarnessProviderSettings {
            display_name,
            api_key_env: "DSH_API_KEY".to_string(),
            api: (!model.api_protocol.trim().is_empty())
                .then(|| model.api_protocol.trim().to_string())
                .unwrap_or_else(|| deepseek_harness_api_protocol(&provider)),
            base_url: model.api_url.trim_end_matches('/').to_string(),
            models: models
                .into_iter()
                .map(|entry| DeepSeekHarnessModelSettings {
                    id: entry.id,
                    name: entry.name,
                })
                .collect(),
        })
    }

    fn from_ai_config(config: &AiConfigFile) -> Self {
        let Some(provider) = Self::provider_settings_for_ai_config(config) else {
            return Self::default();
        };
        let mut providers = BTreeMap::new();
        providers.insert(Self::route_id_for_ai_config(config), provider);
        Self {
            llm_pi_ai: DeepSeekHarnessLlmSettings { providers },
        }
    }

    fn to_ai_config_for_route(
        route_id: &str,
        provider: &DeepSeekHarnessProviderSettings,
    ) -> AiConfigFile {
        // The settings document deliberately holds only a credential
        // reference (`apiKeyEnv`), never the secret itself.  Seed the
        // provider key here so `hydrate_ai_config_secrets` can look up the
        // corresponding value in Flowix's owner-only secret store.
        //
        // Without this entry the hydration loop has no provider to inspect,
        // so a correctly saved Harness key is silently dropped and the
        // runtime fails its preflight with "API key is not configured".
        let provider_name = if provider.display_name.trim().is_empty() {
            route_id.to_string()
        } else {
            provider.display_name.trim().to_string()
        };
        let is_custom = route_id != "flowix";
        let key_bucket = if is_custom {
            route_id.to_string()
        } else {
            provider_name.clone()
        };
        let api_keys = (!key_bucket.is_empty())
            .then(|| HashMap::from([(key_bucket, String::new())]))
            .unwrap_or_default();
        AiConfigFile {
            model: AiModelConfig {
                // For a real llm-pi-ai route the map key is the provider value
                // sent to Harness. The display name is presentation only.
                // The legacy `flowix` bridge keeps its historical provider
                // name so old configurations continue to resolve.
                provider: if is_custom {
                    route_id.to_string()
                } else {
                    provider_name.clone()
                },
                provider_id: is_custom.then(|| route_id.to_string()).unwrap_or_default(),
                display_name: provider_name,
                api_protocol: provider.api.clone(),
                model: provider
                    .models
                    .first()
                    .map(|model| model.id.clone())
                    .unwrap_or_default(),
                models: provider
                    .models
                    .iter()
                    .map(|model| AiModelEntry {
                        id: model.id.clone(),
                        name: model.name.clone(),
                    })
                    .collect(),
                api_url: provider.base_url.clone(),
                api_keys,
                ..AiModelConfig::default()
            },
        }
    }

    fn to_ai_config(&self) -> AiConfigFile {
        let (route_id, provider) = if let Some(provider) = self.llm_pi_ai.providers.get("flowix") {
            ("flowix", provider)
        } else if let Some((route_id, provider)) = self.llm_pi_ai.providers.iter().next() {
            (route_id.as_str(), provider)
        } else {
            return AiConfigFile::default();
        };
        Self::to_ai_config_for_route(route_id, provider)
    }

    fn to_ai_configs(&self) -> Vec<AiConfigFile> {
        self.llm_pi_ai
            .providers
            .iter()
            .map(|(route_id, provider)| Self::to_ai_config_for_route(route_id, provider))
            .collect()
    }
}

fn deepseek_harness_api_protocol(provider: &str) -> String {
    let normalized: String = provider
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '-' && *character != '_')
        .flat_map(char::to_lowercase)
        .collect();
    match normalized.as_str() {
        "anthropic" | "claude" | "kimiforcoding" | "minimax" | "minimaxcn" | "vercelaigateway" => {
            "anthropic-messages"
        }
        "openai" | "openairesponses" | "openairesponsesapi" | "responsesapi" => "openai-responses",
        _ => "openai-completions",
    }
    .to_string()
}

fn merge_harness_provider(
    existing: &mut DeepSeekHarnessProviderSettings,
    incoming: DeepSeekHarnessProviderSettings,
) {
    existing.display_name = incoming.display_name;
    existing.api_key_env = incoming.api_key_env;
    existing.api = incoming.api;
    existing.base_url = incoming.base_url;
    for incoming_model in incoming.models {
        if let Some(existing_model) = existing
            .models
            .iter_mut()
            .find(|model| model.id == incoming_model.id)
        {
            if !incoming_model.name.is_empty() {
                existing_model.name = incoming_model.name;
            }
        } else {
            existing.models.push(incoming_model);
        }
    }
}

fn normalized_harness_identity(value: &str) -> String {
    value.trim().trim_end_matches('/').to_ascii_lowercase()
}

/// Resolve the route represented by an IPC config against the routes already
/// present in `llm-pi-ai.providers`.
///
/// Older Flowix builds always stored the active custom provider under the
/// stable `flowix` route and kept its real identity in `displayName`. Newer
/// UI drafts carry that identity as `providerId`. Treating those two forms as
/// different routes is what made adding model B create a second route while
/// the reader continued to show model A from `flowix`. Match the existing
/// route by identity/endpoint before falling back to the requested route id.
fn existing_harness_route_id(
    settings: &DeepSeekHarnessSettingsFile,
    config: &AiConfigFile,
) -> String {
    let requested = DeepSeekHarnessSettingsFile::route_id_for_ai_config(config);
    if settings.llm_pi_ai.providers.contains_key(&requested) {
        return requested;
    }

    let model = &config.model;
    let identities = [model.provider.trim(), model.display_name.trim()];
    let base_url = normalized_harness_identity(&model.api_url);
    settings
        .llm_pi_ai
        .providers
        .iter()
        .find(|(route_id, provider)| {
            identities.iter().any(|identity| {
                !identity.is_empty()
                    && normalized_harness_identity(&provider.display_name)
                        == normalized_harness_identity(identity)
            }) || (route_id.as_str() == "flowix"
                && !base_url.is_empty()
                && normalized_harness_identity(&provider.base_url) == base_url)
        })
        .map(|(route_id, _)| route_id.clone())
        .unwrap_or(requested)
}

fn harness_provider_matches_config(
    route_id: &str,
    provider: &DeepSeekHarnessProviderSettings,
    config: &AiConfigFile,
) -> bool {
    let identities = [
        config.model.provider.trim(),
        config.model.display_name.trim(),
    ];
    let base_url = normalized_harness_identity(&config.model.api_url);
    identities.iter().any(|identity| {
        !identity.is_empty()
            && normalized_harness_identity(&provider.display_name)
                == normalized_harness_identity(identity)
    }) || (route_id == "flowix"
        && !base_url.is_empty()
        && normalized_harness_identity(&provider.base_url) == base_url)
}

fn split_models_from_legacy_flowix_route(
    settings: &mut DeepSeekHarnessSettingsFile,
    requested_route_id: &str,
    config: &AiConfigFile,
    incoming: &DeepSeekHarnessProviderSettings,
) -> bool {
    if requested_route_id == "flowix"
        || settings
            .llm_pi_ai
            .providers
            .contains_key(requested_route_id)
        || settings
            .llm_pi_ai
            .providers
            .get("flowix")
            .is_none_or(|provider| harness_provider_matches_config("flowix", provider, config))
    {
        return false;
    }
    let incoming_ids = incoming
        .models
        .iter()
        .map(|model| model.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    if let Some(legacy) = settings.llm_pi_ai.providers.get_mut("flowix") {
        legacy
            .models
            .retain(|model| !incoming_ids.contains(model.id.as_str()));
    }
    if settings
        .llm_pi_ai
        .providers
        .get("flowix")
        .is_some_and(|provider| provider.models.is_empty())
    {
        settings.llm_pi_ai.providers.remove("flowix");
    }
    true
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
    #[error("yaml serialization error: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("invalid configuration: {0}")]
    InvalidConfig(String),
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

    pub fn get_deepseek_harness_plugin_settings(
        &self,
    ) -> Result<DeepSeekHarnessPluginSettings, UserConfigError> {
        let path = self.config_dir.join(DSH_PLUGIN_SETTINGS_FILE_NAME);
        match fs::read_to_string(path) {
            Ok(content) => Ok(serde_json::from_str(&content)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(DeepSeekHarnessPluginSettings::default())
            }
            Err(error) => Err(error.into()),
        }
    }

    pub fn set_deepseek_harness_plugin_enabled(
        &self,
        plugin_key: &str,
        enabled: bool,
    ) -> Result<DeepSeekHarnessPluginSettings, UserConfigError> {
        let mut settings = self.get_deepseek_harness_plugin_settings()?;
        if enabled {
            settings.disabled.retain(|key| key != plugin_key);
        } else if !settings.disabled.iter().any(|key| key == plugin_key) {
            settings.disabled.push(plugin_key.to_string());
        }
        settings.disabled.sort();
        let content = serde_json::to_string_pretty(&settings)?;
        let path = self.config_dir.join(DSH_PLUGIN_SETTINGS_FILE_NAME);
        atomic_write_json(&path, &content)?;
        Ok(settings)
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

    /// Load the DeepSeek Harness model configuration from the llm-pi-ai
    /// settings document. Existing installations are migrated lazily from
    /// agent-config.toml on first access, so changing Flowix Agent settings
    /// later does not overwrite an already-created Harness configuration.
    pub fn get_deepseek_harness_config(&self) -> Result<AiConfigFile, UserConfigError> {
        let path = self.config_dir.join(DSH_SETTINGS_FILE_NAME);
        let settings = match self.read_deepseek_harness_settings()? {
            Some(settings) => settings,
            None => {
                let config = self.get_ai_config();
                let settings = DeepSeekHarnessSettingsFile::from_ai_config(&config);
                let content = serde_yaml::to_string(&settings)?;
                atomic_write_yaml(&path, &content)?;
                settings
            }
        };
        let mut config = settings.to_ai_config();
        self.hydrate_ai_config_secrets(&mut config);
        Ok(config)
    }

    /// Return every configured llm-pi-ai route. The model manager must not
    /// flatten this into the first provider: `deepseek` and `zai` are
    /// independent routes and their model cards carry different endpoints
    /// and credentials.
    pub fn get_deepseek_harness_configs(&self) -> Result<Vec<AiConfigFile>, UserConfigError> {
        let path = self.config_dir.join(DSH_SETTINGS_FILE_NAME);
        let settings = match self.read_deepseek_harness_settings()? {
            Some(settings) => settings,
            None => {
                let config = self.get_ai_config();
                let settings = DeepSeekHarnessSettingsFile::from_ai_config(&config);
                let content = serde_yaml::to_string(&settings)?;
                atomic_write_yaml(&path, &content)?;
                settings
            }
        };
        let mut configs = settings.to_ai_configs();
        for config in &mut configs {
            self.hydrate_ai_config_secrets(config);
        }
        Ok(configs)
    }

    /// Persist only the DeepSeek Harness settings. API keys remain in the
    /// existing owner-only secret store and are never written to YAML.
    pub fn set_deepseek_harness_config(
        &self,
        config: &AiConfigFile,
    ) -> Result<(), UserConfigError> {
        self.persist_ai_config_secrets(config)?;
        let mut settings = self.read_deepseek_harness_settings()?.unwrap_or_default();
        if let Some(provider) = DeepSeekHarnessSettingsFile::provider_settings_for_ai_config(config)
        {
            let requested_route_id = DeepSeekHarnessSettingsFile::route_id_for_ai_config(config);
            let split_legacy = split_models_from_legacy_flowix_route(
                &mut settings,
                &requested_route_id,
                config,
                &provider,
            );
            let route_id = if split_legacy {
                requested_route_id
            } else {
                existing_harness_route_id(&settings, config)
            };
            // Replace only the provider being edited. Other llm-pi-ai routes
            // and their model directories belong to the settings document
            // and must survive an unrelated save/delete operation.
            settings.llm_pi_ai.providers.insert(route_id, provider);
        } else {
            let route_id = existing_harness_route_id(&settings, config);
            settings.llm_pi_ai.providers.remove(&route_id);
        }
        let content = serde_yaml::to_string(&settings)?;
        let path = self.config_dir.join(DSH_SETTINGS_FILE_NAME);
        atomic_write_yaml(&path, &content)?;
        Ok(())
    }

    /// Add a model to the active llm-pi-ai provider without replacing the
    /// provider's existing model directory. This is deliberately separate
    /// from `set_deepseek_harness_config`: edit/delete need replacement
    /// semantics, while the Add model action is an append/merge operation.
    pub fn add_deepseek_harness_config(
        &self,
        config: &AiConfigFile,
    ) -> Result<(), UserConfigError> {
        self.persist_ai_config_secrets(config)?;
        let mut settings = self.read_deepseek_harness_settings()?.unwrap_or_default();
        let requested_route_id = DeepSeekHarnessSettingsFile::route_id_for_ai_config(config);
        let route_id = existing_harness_route_id(&settings, config);
        let Some(incoming) = DeepSeekHarnessSettingsFile::provider_settings_for_ai_config(config)
        else {
            return Err(UserConfigError::InvalidConfig(
                "cannot add a Harness model without a provider and model".to_string(),
            ));
        };
        // Repair the only ambiguous legacy shape while writing: an old
        // `flowix` route may already contain a model that the user is now
        // explicitly assigning to a different catalog route.
        let should_split_legacy_route = split_models_from_legacy_flowix_route(
            &mut settings,
            &requested_route_id,
            config,
            &incoming,
        );
        let target_route_id = if should_split_legacy_route {
            requested_route_id
        } else {
            route_id
        };
        if let Some(existing) = settings.llm_pi_ai.providers.get_mut(&target_route_id) {
            merge_harness_provider(existing, incoming);
        } else {
            settings
                .llm_pi_ai
                .providers
                .insert(target_route_id, incoming);
        }
        let content = serde_yaml::to_string(&settings)?;
        let path = self.config_dir.join(DSH_SETTINGS_FILE_NAME);
        atomic_write_yaml(&path, &content)?;
        Ok(())
    }

    fn read_deepseek_harness_settings(
        &self,
    ) -> Result<Option<DeepSeekHarnessSettingsFile>, UserConfigError> {
        let path = self.config_dir.join(DSH_SETTINGS_FILE_NAME);
        match fs::read_to_string(path) {
            Ok(content) => Ok(Some(serde_yaml::from_str(&content)?)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Render a standalone Harness settings document for a one-shot probe.
    ///
    /// A probe must be able to validate a model that has not been saved yet.
    /// Keeping this renderer separate from `set_deepseek_harness_config`
    /// avoids mutating the user's durable settings just to test a draft.
    pub(crate) fn deepseek_harness_settings_yaml(
        config: &AiModelConfig,
    ) -> Result<String, UserConfigError> {
        serde_yaml::to_string(&DeepSeekHarnessSettingsFile::from_ai_config(
            &AiConfigFile {
                model: config.clone(),
            },
        ))
        .map_err(UserConfigError::Yaml)
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

pub(crate) fn atomic_write_yaml(path: &Path, content: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        set_dir_owner_only_perms(parent);
    }
    let tmp = path.with_extension("yaml.tmp");
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
    fn deepseek_harness_plugin_settings_round_trip_enabled_state() {
        let home = tempfile::tempdir().unwrap();
        let store = test_user_config_store(home.path().to_path_buf());

        let disabled = store
            .set_deepseek_harness_plugin_enabled("preset:standard:3:tool-web", false)
            .unwrap();
        assert_eq!(disabled.disabled, vec!["preset:standard:3:tool-web"]);

        let loaded = store.get_deepseek_harness_plugin_settings().unwrap();
        assert_eq!(loaded, disabled);

        let enabled = store
            .set_deepseek_harness_plugin_enabled("preset:standard:3:tool-web", true)
            .unwrap();
        assert!(enabled.disabled.is_empty());
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
            ..AiModelConfig::default()
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
                ..AiModelConfig::default()
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
                ..AiModelConfig::default()
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
                ..AiModelConfig::default()
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

    #[test]
    fn deepseek_harness_config_hydrates_its_provider_key_from_secret_store() {
        let home = tempfile::tempdir().unwrap();
        let store = test_user_config_store(home.path().to_path_buf());
        let config = AiConfigFile {
            model: AiModelConfig {
                provider: "DeepSeek".into(),
                model: "deepseek-chat".into(),
                api_url: "https://api.deepseek.com/v1".into(),
                api_keys: HashMap::from([("DeepSeek".to_string(), "test-key".to_string())]),
                ..AiModelConfig::default()
            },
        };

        store.set_deepseek_harness_config(&config).unwrap();

        let settings_path = home
            .path()
            .join(USER_CONFIG_DIR_NAME)
            .join(DSH_SETTINGS_FILE_NAME);
        let settings = std::fs::read_to_string(settings_path).unwrap();
        assert!(
            !settings.contains("test-key"),
            "settings must not contain the API key"
        );

        let loaded = store.get_deepseek_harness_config().unwrap();
        assert_eq!(loaded.model.provider, "DeepSeek");
        assert_eq!(loaded.model.effective_api_key("DeepSeek"), "test-key");
    }

    #[test]
    fn custom_deepseek_harness_provider_round_trips_its_route_and_directory() {
        let home = tempfile::tempdir().unwrap();
        let store = test_user_config_store(home.path().to_path_buf());
        let config = AiConfigFile {
            model: AiModelConfig {
                provider: "acme-gateway".into(),
                provider_id: "acme-gateway".into(),
                display_name: "Acme Gateway".into(),
                api_protocol: "openai-responses".into(),
                model: "acme-large".into(),
                models: vec![
                    AiModelEntry {
                        id: "acme-large".into(),
                        name: "Acme Large".into(),
                    },
                    AiModelEntry {
                        id: "acme-think".into(),
                        name: "Acme Think".into(),
                    },
                ],
                api_url: "https://gateway.acme.example/v1".into(),
                api_keys: HashMap::from([("acme-gateway".to_string(), "test-key".to_string())]),
                ..AiModelConfig::default()
            },
        };

        store.set_deepseek_harness_config(&config).unwrap();

        let settings = std::fs::read_to_string(
            home.path()
                .join(USER_CONFIG_DIR_NAME)
                .join(DSH_SETTINGS_FILE_NAME),
        )
        .unwrap();
        assert!(settings.contains("acme-gateway:"), "got: {settings}");
        assert!(
            settings.contains("api: openai-responses"),
            "got: {settings}"
        );
        assert!(settings.contains("name: Acme Think"), "got: {settings}");
        assert!(
            !settings.contains("test-key"),
            "settings must not contain the API key"
        );

        let loaded = store.get_deepseek_harness_config().unwrap();
        assert_eq!(loaded.model.provider_id, "acme-gateway");
        assert_eq!(loaded.model.display_name, "Acme Gateway");
        assert_eq!(loaded.model.api_protocol, "openai-responses");
        assert_eq!(loaded.model.models.len(), 2);
        assert_eq!(loaded.model.models[1].name, "Acme Think");
        assert_eq!(loaded.model.effective_api_key("acme-gateway"), "test-key");
    }

    #[test]
    fn adding_harness_model_merges_with_the_existing_llm_pi_ai_directory() {
        let home = tempfile::tempdir().unwrap();
        let store = test_user_config_store(home.path().to_path_buf());
        let first = AiConfigFile {
            model: AiModelConfig {
                provider: "acme-gateway".into(),
                provider_id: "acme-gateway".into(),
                display_name: "Acme Gateway".into(),
                api_protocol: "openai-completions".into(),
                model: "model-a".into(),
                models: vec![AiModelEntry {
                    id: "model-a".into(),
                    name: "Model A".into(),
                }],
                api_url: "https://gateway.acme.example/v1".into(),
                ..AiModelConfig::default()
            },
        };
        store.set_deepseek_harness_config(&first).unwrap();

        let second = AiConfigFile {
            model: AiModelConfig {
                provider: "acme-gateway".into(),
                provider_id: "acme-gateway".into(),
                display_name: "Acme Gateway".into(),
                api_protocol: "openai-completions".into(),
                model: "model-b".into(),
                models: vec![AiModelEntry {
                    id: "model-b".into(),
                    name: "Model B".into(),
                }],
                api_url: "https://gateway.acme.example/v1".into(),
                ..AiModelConfig::default()
            },
        };
        store.add_deepseek_harness_config(&second).unwrap();

        let loaded = store.get_deepseek_harness_config().unwrap();
        assert_eq!(
            loaded
                .model
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["model-a", "model-b"]
        );
    }

    #[test]
    fn adding_to_legacy_flowix_route_does_not_create_a_shadow_route() {
        let home = tempfile::tempdir().unwrap();
        let store = test_user_config_store(home.path().to_path_buf());
        let path = home
            .path()
            .join(USER_CONFIG_DIR_NAME)
            .join(DSH_SETTINGS_FILE_NAME);
        let mut settings = DeepSeekHarnessSettingsFile::default();
        settings.llm_pi_ai.providers.insert(
            "flowix".into(),
            DeepSeekHarnessProviderSettings {
                display_name: "zai-coding-cn".into(),
                api_key_env: "DSH_API_KEY".into(),
                api: "openai-completions".into(),
                base_url: "https://open.bigmodel.cn/api/coding/paas/v4".into(),
                models: vec![DeepSeekHarnessModelSettings {
                    id: "model-a".into(),
                    name: "Model A".into(),
                }],
            },
        );
        std::fs::write(&path, serde_yaml::to_string(&settings).unwrap()).unwrap();

        // This is the shape emitted by the current UI when it submits model B
        // after loading the old stable `flowix` route.
        store
            .add_deepseek_harness_config(&AiConfigFile {
                model: AiModelConfig {
                    provider: "zai-coding-cn".into(),
                    provider_id: "zai-coding-cn".into(),
                    display_name: "zai-coding-cn".into(),
                    model: "model-b".into(),
                    models: vec![AiModelEntry {
                        id: "model-b".into(),
                        name: "Model B".into(),
                    }],
                    api_url: "https://open.bigmodel.cn/api/coding/paas/v4".into(),
                    ..AiModelConfig::default()
                },
            })
            .unwrap();

        let saved: DeepSeekHarnessSettingsFile =
            serde_yaml::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(saved.llm_pi_ai.providers.len(), 1);
        assert_eq!(
            saved
                .llm_pi_ai
                .providers
                .get("flowix")
                .unwrap()
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["model-a", "model-b"]
        );
    }

    #[test]
    fn adding_a_second_catalog_provider_creates_a_separate_llm_pi_ai_route() {
        let home = tempfile::tempdir().unwrap();
        let store = test_user_config_store(home.path().to_path_buf());
        store
            .set_deepseek_harness_config(&AiConfigFile {
                model: AiModelConfig {
                    provider: "deepseek".into(),
                    model: "deepseek-chat".into(),
                    models: vec![AiModelEntry {
                        id: "deepseek-chat".into(),
                        name: "DeepSeek Chat".into(),
                    }],
                    api_url: "https://api.deepseek.com".into(),
                    ..AiModelConfig::default()
                },
            })
            .unwrap();

        store
            .add_deepseek_harness_config(&AiConfigFile {
                model: AiModelConfig {
                    provider: "zai".into(),
                    display_name: "GLM".into(),
                    model: "glm-4.5-air".into(),
                    models: vec![AiModelEntry {
                        id: "glm-4.5-air".into(),
                        name: "GLM 4.5 Air".into(),
                    }],
                    api_url: "https://open.bigmodel.cn/api/coding/paas/v4".into(),
                    ..AiModelConfig::default()
                },
            })
            .unwrap();

        let path = home
            .path()
            .join(USER_CONFIG_DIR_NAME)
            .join(DSH_SETTINGS_FILE_NAME);
        let saved: DeepSeekHarnessSettingsFile =
            serde_yaml::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(saved.llm_pi_ai.providers.len(), 2);
        assert_eq!(
            saved
                .llm_pi_ai
                .providers
                .get("deepseek")
                .unwrap()
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["deepseek-chat"]
        );
        assert_eq!(
            saved
                .llm_pi_ai
                .providers
                .get("zai")
                .unwrap()
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["glm-4.5-air"]
        );

        let configs = store.get_deepseek_harness_configs().unwrap();
        assert_eq!(configs.len(), 2);
        assert_eq!(configs[0].model.provider, "deepseek");
        assert_eq!(configs[1].model.provider, "zai");
    }

    #[test]
    fn same_base_url_does_not_merge_distinct_custom_routes() {
        let home = tempfile::tempdir().unwrap();
        let store = test_user_config_store(home.path().to_path_buf());
        let endpoint = "https://shared-gateway.example/v1";

        store
            .set_deepseek_harness_config(&AiConfigFile {
                model: AiModelConfig {
                    provider: "provider-a".into(),
                    provider_id: "provider-a".into(),
                    display_name: "Provider A".into(),
                    model: "model-a".into(),
                    models: vec![AiModelEntry {
                        id: "model-a".into(),
                        name: "Model A".into(),
                    }],
                    api_url: endpoint.into(),
                    ..AiModelConfig::default()
                },
            })
            .unwrap();
        store
            .set_deepseek_harness_config(&AiConfigFile {
                model: AiModelConfig {
                    provider: "provider-b".into(),
                    provider_id: "provider-b".into(),
                    display_name: "Provider B".into(),
                    model: "model-b".into(),
                    models: vec![AiModelEntry {
                        id: "model-b".into(),
                        name: "Model B".into(),
                    }],
                    api_url: endpoint.into(),
                    ..AiModelConfig::default()
                },
            })
            .unwrap();

        let configs = store.get_deepseek_harness_configs().unwrap();
        assert_eq!(configs.len(), 2);
        assert!(configs
            .iter()
            .any(|config| config.model.provider_id == "provider-a"));
        assert!(configs
            .iter()
            .any(|config| config.model.provider_id == "provider-b"));
    }

    #[test]
    fn adding_a_catalog_provider_repairs_mixed_legacy_flowix_models() {
        let home = tempfile::tempdir().unwrap();
        let store = test_user_config_store(home.path().to_path_buf());
        let path = home
            .path()
            .join(USER_CONFIG_DIR_NAME)
            .join(DSH_SETTINGS_FILE_NAME);
        let mut settings = DeepSeekHarnessSettingsFile::default();
        settings.llm_pi_ai.providers.insert(
            "flowix".into(),
            DeepSeekHarnessProviderSettings {
                display_name: "deepseek".into(),
                api_key_env: "DSH_API_KEY".into(),
                api: "openai-completions".into(),
                base_url: "https://api.deepseek.com".into(),
                models: vec![
                    DeepSeekHarnessModelSettings {
                        id: "deepseek-chat".into(),
                        name: String::new(),
                    },
                    DeepSeekHarnessModelSettings {
                        id: "glm-4.5-air".into(),
                        name: String::new(),
                    },
                ],
            },
        );
        std::fs::write(&path, serde_yaml::to_string(&settings).unwrap()).unwrap();

        store
            .add_deepseek_harness_config(&AiConfigFile {
                model: AiModelConfig {
                    provider: "zai".into(),
                    display_name: "GLM".into(),
                    model: "glm-4.5-air".into(),
                    models: vec![AiModelEntry {
                        id: "glm-4.5-air".into(),
                        name: String::new(),
                    }],
                    api_url: "https://open.bigmodel.cn/api/coding/paas/v4".into(),
                    ..AiModelConfig::default()
                },
            })
            .unwrap();

        let saved: DeepSeekHarnessSettingsFile =
            serde_yaml::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(
            saved
                .llm_pi_ai
                .providers
                .get("flowix")
                .unwrap()
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["deepseek-chat"]
        );
        assert_eq!(
            saved
                .llm_pi_ai
                .providers
                .get("zai")
                .unwrap()
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["glm-4.5-air"]
        );
    }

    #[test]
    fn saving_one_harness_provider_preserves_other_llm_pi_ai_routes() {
        let home = tempfile::tempdir().unwrap();
        let store = test_user_config_store(home.path().to_path_buf());
        let path = home
            .path()
            .join(USER_CONFIG_DIR_NAME)
            .join(DSH_SETTINGS_FILE_NAME);
        let mut settings = DeepSeekHarnessSettingsFile::default();
        settings.llm_pi_ai.providers.insert(
            "other-route".into(),
            DeepSeekHarnessProviderSettings {
                display_name: "Other Route".into(),
                api_key_env: "OTHER_KEY".into(),
                api: "openai-completions".into(),
                base_url: "https://other.example/v1".into(),
                models: vec![DeepSeekHarnessModelSettings {
                    id: "other-model".into(),
                    name: "Other Model".into(),
                }],
            },
        );
        std::fs::write(&path, serde_yaml::to_string(&settings).unwrap()).unwrap();

        store
            .set_deepseek_harness_config(&AiConfigFile {
                model: AiModelConfig {
                    provider: "Acme".into(),
                    provider_id: "acme".into(),
                    model: "acme-model".into(),
                    models: vec![AiModelEntry {
                        id: "acme-model".into(),
                        name: String::new(),
                    }],
                    api_url: "https://acme.example/v1".into(),
                    ..AiModelConfig::default()
                },
            })
            .unwrap();

        let saved: DeepSeekHarnessSettingsFile =
            serde_yaml::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert!(saved.llm_pi_ai.providers.contains_key("other-route"));
        assert!(saved.llm_pi_ai.providers.contains_key("acme"));
    }

    #[test]
    fn deleting_last_custom_harness_model_removes_provider_route() {
        let home = tempfile::tempdir().unwrap();
        let store = test_user_config_store(home.path().to_path_buf());
        let config = AiConfigFile {
            model: AiModelConfig {
                provider: "acme-gateway".into(),
                provider_id: "acme-gateway".into(),
                display_name: "Acme Gateway".into(),
                api_protocol: "openai-completions".into(),
                model: String::new(),
                models: Vec::new(),
                api_url: "https://gateway.acme.example/v1".into(),
                ..AiModelConfig::default()
            },
        };

        store.set_deepseek_harness_config(&config).unwrap();

        let loaded = store.get_deepseek_harness_config().unwrap();
        assert!(loaded.model.provider_id.is_empty());
        assert!(loaded.model.provider.is_empty());
        assert!(loaded.model.models.is_empty());
    }
}
