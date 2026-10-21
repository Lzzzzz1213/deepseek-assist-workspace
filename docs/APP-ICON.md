# 应用图标

本仓库的角色头像和应用 Logo 均由 AI 生成，随源码一并公开；表情包为第三方素材，来源另见 `THIRD-PARTY.md`。

应用 Logo 采用双角色 Q 版构图：蓝发、鲸鱼发饰角色与白发、绿眼、龙角角色同框，延续角色头像的画风，仅用于本项目。

使用内置 imagegen 生图工具，参考 `web/assets/avatars/deepseek.png` 和 `web/assets/avatars/chatgpt.png`。构建直接使用仓库内已选定资源，无需重新生图。

- `web/assets/app/workroom-source.png`：选定的 1254×1254 RGBA 原图，原样保存。
- `web/assets/app/workroom.png`：512×512 PNG，供应用资源使用。
- `web/assets/app/workroom.ico`：包含 16、20、24、32、40、48、64、128、256px 的 Windows 图标；保留透明通道。

PNG/ICO 仅做尺寸与格式导出。Windows 客户端将 ICO 嵌入可执行文件，窗口和托盘从本机程序资源读取；NSIS 的安装与卸载图标使用同一项目内文件。构建从项目目录读取资源，不依赖生图缓存目录。
