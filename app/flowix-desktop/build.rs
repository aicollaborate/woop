fn main() {
    println!("cargo:rerun-if-env-changed=FLOWIX_DSH_UPDATE_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=FLOWIX_ALLOW_UNSIGNED");
    let release = std::env::var("PROFILE").as_deref() == Ok("release");
    let unsigned = std::env::var("FLOWIX_ALLOW_UNSIGNED").as_deref() == Ok("1");
    let has_dsh_public_key = std::env::var("FLOWIX_DSH_UPDATE_PUBLIC_KEY")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    if release && !unsigned && !has_dsh_public_key {
        panic!(
            "FLOWIX_DSH_UPDATE_PUBLIC_KEY is required for a signed production build; set FLOWIX_ALLOW_UNSIGNED=1 only for local unsigned packages"
        );
    }
    tauri_build::build()
}
