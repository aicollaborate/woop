use serde::Serialize;
use std::sync::Arc;
use tauri::State;

use crate::device_registration::DeviceRegistry;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootFeatures {
    pub experimental: bool,
    pub is_introduct_displayed: bool,
}

#[tauri::command]
pub fn get_boot_features(registry: State<'_, Arc<DeviceRegistry>>) -> BootFeatures {
    BootFeatures {
        experimental: registry.experimental(),
        is_introduct_displayed: registry.is_introduct_displayed(),
    }
}

#[tauri::command]
pub fn set_boot_intro_displayed(registry: State<'_, Arc<DeviceRegistry>>) -> Result<(), String> {
    registry.set_introduct_displayed(true)
}
