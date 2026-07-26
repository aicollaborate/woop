# flowix-sync

`flowix-sync` 是 Flowix Cloud 的独立 Rust 同步模块，负责 Cloud API、会话、会员状态、笔记本映射、revision 与冲突处理。它不依赖 Tauri，也不直接展示系统 UI。

边界约定：

- macOS “通过 Apple 登录”系统面板由 `flowix-desktop/src/apple_sign_in.rs` 调用 `AuthenticationServices`。
- 本 crate 先获取 Cloud challenge，再交换 Apple Identity Token 与 Authorization Code。
- Apple 首次授权才返回姓名；后续请求会省略 `displayName`。
- Access Token 只驻留内存；轮换后的 Refresh Token 由桌面层持久化，不进入 Web IPC。
- 同步状态保存在独立 SQLite 中，并按 Cloud workspace 隔离 notebook link、cursor 与 note revision。
- 云端 revision 冲突保留本地原件并生成 Cloud conflict 副本；远端删除遇到未上传的本地修改时，先生成 Local conflict 副本再落地删除。

验证：

```bash
cd app
cargo test -p flowix-sync
```
