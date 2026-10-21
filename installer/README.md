# Windows EXE 安装包

`client/` 保存本项目可直接运行的完整客户端，`release/` 保存 EXE 安装包及 SHA256 校验文件。不要单独复制 Workroom.exe；它需要同目录依赖与 host 子目录。

已有发布目录后运行 `pwsh -NoProfile -File .\Build-Installer.ps1`。它读取 `work/latest-client-build.json`，复制并逐项校验发布文件到 client，生成精确安装/卸载清单，再编译 installer/Workroom.nsi。重新生成客户端时先运行 Build-Client.ps1；已有安装包不会被覆盖，可用 -Version 指定新版本。

本机编译工具为便携 NSIS 3.13，位于 `work/installer-tools/nsis-3.13/makensis.exe`，不安装全局工具或改 PATH。也可用 -NsisCompiler 指定已有编译器。

源码仓库不包含本机 `work/` 工具目录、客户端或安装包。新克隆先安装构建依赖并运行 `Build-Client.ps1`，再使用 `Build-Installer.ps1 -Version 1.4.4 -NsisCompiler '你的 makensis.exe 路径'`；脚本会在项目内生成新的 `dist/`、`client/` 与 `release/`，这些产物继续排除在 Git 提交之外。

工具包来源：[Tauri 维护的 NSIS 分发包](https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip)，与 [Tauri 上游打包源码](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs) 公布的 SHA1 `DB14F8AF2EA346B786C6AE19343F61AAF5E09B8E` 核对一致。本次下载 SHA256 为 `BA63DFFC4410EE89193E1CB5A41989991BD77C61068DA17E3156D136B7B0B3D8`。

安装包提供中文向导，默认按当前用户安装到 `%LOCALAPPDATA%\Programs\DeepSeekAssistWorkspace`，可另选目录；开始菜单与卸载入口随安装生成，桌面图标可选。无需管理员权限，不设置开机启动。WebView2 Runtime 继续由系统提供，当前电脑已验证存在。

卸载仅移除本版本打包的文件、产品快捷方式及产品注册表键，保留用户额外文件、真实群聊记录、偏好和模型凭据。运行中需先从托盘退出，以免安装或卸载碰到正在使用的文件。

安装包没有代码签名证书；未设置任何安全软件绕过或系统策略改动。
