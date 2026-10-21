# 第三方资源

## markdown-it 15.0.3

- 用途：本地解析 Markdown 为 tokens；应用通过固定标签和 textContent 创建 DOM，不使用解析器的 HTML 输出。
- 上游：https://github.com/markdown-it/markdown-it
- 官方包：https://registry.npmjs.org/markdown-it/-/markdown-it-15.0.3.tgz
- npm integrity：`sha512-+Az7Ojz3iRGu8KYMvJ6xVhvrxP3eE+vEtJX75Ow88XBpcQNV/0lGX5ZynIIBftREo4DC2jsveAMDaeltmm8QvQ==`
- 本地资源：`web/vendor/markdown-it.min.js`，复制自包内 `dist/browser/markdown-it.umd.min.js`，未修改。
- 许可：MIT，完整许可位于 `web/vendor/markdown-it.LICENSE`，随客户端一并打包。

资源在打包时内置，运行时不访问 npm、CDN 或其他外部站点。没有增加 npm 安装或前端构建步骤。

## 大肥鱼本地表情

8张WebP源自1cyberlangke1的[原投稿](https://github.com/lmy414/ai-girl-stickers/issues/32)，投稿者声明自行创作或生成并标注CC0。收录固定提交、原图链接和SHA256见 `web/assets/stickers/sources.json`。本项目不主张第三方角色或品牌所有权，不冒称官方素材；食物图是面包。
