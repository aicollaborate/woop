# Flowix Native iOS

SwiftUI/UIKit 原生客户端目标。它与现有 `app/flowix-mobile` 并行，暂时不替换 Tauri 移动端。

编辑器资源由 `app/flowix-web` 构建，再通过 `npm run stage:ios-editor` 放入 `Resources/EditorWebView`。该目录中的 bundle 是生成物，已通过 `.gitignore` 排除。

当前版本使用 Rust API 提供真实笔记列表、打开、保存、切换 notebook、创建、删除和收藏操作；编辑器资源仍由 Web 前端构建后嵌入 WKWebView。
