# Swift 原生 iOS 客户端迁移计划

目标：保留现有 Tiptap 编辑器能力，把移动端列表、导航、账户、搜索和系统交互迁移到 SwiftUI/UIKit；现有 Tauri 移动端在迁移完成前继续作为基线。

## 路线

```text
SwiftUI/UIKit
  ├── Library / Drawer / Search / Account / Settings
  ├── Native document shell and save state
  └── WKWebView
        └── React + Tiptap editor bundle

Rust native API
  ├── flowix-core
  └── flowix-sync
```

## 分阶段实施

1. 新增 Swift 原生工程，建立原生列表、文档页和编辑器 WebView 的可运行闭环。
2. 为 Tiptap 建立独立 `editor-webview` 构建入口和 Swift ↔ JavaScript 消息协议。
3. 从 Tauri command 中抽出无 Tauri 依赖的 Rust API，先接通笔记列表、打开和保存。
4. 接通草稿恢复、冲突检测、附件上传和同步账户状态。
5. 按现有移动端设计迁移抽屉、搜索、账户、云同步和新建/删除/收藏操作。
6. 使用真实数据在模拟器和真机上回归，确认旧 Tauri 移动端不受影响后再考虑下线。

## 当前状态

- [x] `app/flowix-ios-native` SwiftUI 工程骨架
- [x] 原生列表、抽屉占位和文档页
- [x] 独立 Tiptap WebView bundle 构建入口
- [x] Swift ↔ WebView 的 `ready` / `setContent` / `changed` 最小协议
- [x] Rust 原生 API / FFI：列表、打开、保存、切换 notebook、创建/删除/收藏笔记
- [x] 真实笔记列表与保存
- [x] 原生 notebook 抽屉、搜索、收藏和删除入口第一版
- [x] 模拟器 smoke：Tiptap ready、changed 回传、保存、重开校验并恢复原文
- [x] 草稿恢复、冲突处理、附件分块上传和受控资源加载
- [x] 原生账户登录/恢复/退出、Keychain 刷新令牌和同步状态页面
- [x] 原生 Library 筛选、Notebook 新建/重命名/删除
- [x] 云端 V2 远端变更的原生落盘同步（通过无 Tauri Rust FFI adapter）
- [ ] 旧 Tauri 数据目录的一键迁移向导

当前原生编辑器的正文闭环为：SwiftUI 文档页 → WKWebView → React/Tiptap → Swift 消息桥 → Rust FFI。
附件上传已从 Tiptap 编辑器中抽成能力注入；现有 Tauri 移动端继续注入 Tauri 实现，原生客户端通过 WKWebView 消息桥按 512 KB 分块写入 Rust 临时文件，并由 `flowix-asset://` Scheme Handler 受控读取。

原生客户端已接入 `flowix-sync` 的登录、恢复、退出、CloudState 查询和立即同步。同步时先纳入远端 Notebook，再生成本地 Markdown/附件快照，调用 V2 引擎并在 Rust FFI 内应用远端报告；旧 Tauri Mobile 的同步实现继续保留，作为同一 V2 协议的回归基线。

原生数据目录为 App 私有 `Application Support/Flowix`，不会静默读取或覆盖旧 Tauri 容器中的数据。发布前应增加显式导入/迁移入口，并在迁移成功后保留旧数据备份。

`--editor-smoke` 会在启动时追加一个临时纯文本标记，验证 changed / Rust 写入 / 重开后再恢复原文；普通启动不会执行该测试，也不会显示诊断状态。

## 常用命令

```bash
npm run build:ios-editor
npm run stage:ios-editor
npm run build:ios-native-api
cd app/flowix-ios-native
xcodegen generate --spec project.yml
xcodebuild -project FlowixIOS.xcodeproj -scheme FlowixIOS \
  -sdk iphonesimulator -configuration Debug \
  -derivedDataPath .build/DerivedData CODE_SIGNING_ALLOWED=NO build
```
