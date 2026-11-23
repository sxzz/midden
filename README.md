# Midden

将 X 与 Instagram 的帖子、Profile、图片和视频保存到自己的服务器，通过 Telegram、网页或 REST API 提交和查看。

此分支正在从 Go 多服务架构重写为单进程 TypeScript 应用，功能尚未完整。旧实现见 `golang` 分支。

## 开发

需要 pnpm；Node.js 26 由 `package.json` 的 `devEngines` 自动下载。

```sh
pnpm install
pnpm dev        # 启动服务端
pnpm lint
pnpm typecheck
pnpm test
```
