use serde::Serialize;
use std::sync::Arc;
use tauri::State;

use crate::device_registration::DeviceRegistry;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootFeatures {
    pub experimental: bool,
}

#[tauri::command]
pub fn get_boot_features(registry: State<'_, Arc<DeviceRegistry>>) -> BootFeatures {
    BootFeatures {
        experimental: registry.experimental(),
    }
}
