# Flowix Native iOS

SwiftUI/UIKit 原生客户端目标。它与现有 `app/flowix-mobile` 并行，暂时不替换 Tauri 移动端。

当前原生实现使用与旧 Tauri 版本相同的 App Store Connect Bundle ID `com.flowix.app.mobile`，营销版本为 `1.1.15`，因此上传后会作为原 TestFlight App 的更新版本。TestFlight 发布使用仓库根目录的 `scripts/build-and-upload-ios-native-testflight.sh`，不要使用 Tauri 专用的 `scripts/build-and-upload-testflight.sh`。

编辑器资源由 `app/flowix-web` 构建，再通过 `npm run stage:ios-editor` 放入 `Resources/EditorWebView`。该目录中的 bundle 是生成物，已通过 `.gitignore` 排除。

当前版本使用 Rust API 提供真实笔记列表、打开、保存、切换 notebook、创建、删除和收藏操作；编辑器资源仍由 Web 前端构建后嵌入 WKWebView。

## TestFlight

使用现有 `com.flowix.app.mobile` 的 Apple Distribution certificate、App Store provisioning profile 和 App Store Connect API key，然后设置：

```bash
export APPLE_TEAM_ID="XXXXXXXXXX"
export IOS_CERT_P12_PATH="$HOME/.flowix-signing/devid-ios.p12"
export IOS_CERT_P12_PASSWORD="..."
export IOS_NATIVE_MOBILE_PROVISION_PATH="$HOME/.flowix-signing/Flowix_iOS_AppStore.mobileprovision"
export APPLE_ASC_API_KEY_ID="XXXXXXXXXX"
export APPLE_ASC_API_ISSUER_ID="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
export APPLE_ASC_API_KEY_PATH="$HOME/.flowix-signing/appstoreconnect/AuthKey_XXXXXXXXXX.p8"

npm run ios-native:build:testflight
```

只构建并校验、不上传时设置 `SKIP_UPLOAD=1`。每次上传都必须使用新的 `IOS_BUILD_NUMBER`，默认值为当前 Unix 时间戳。
