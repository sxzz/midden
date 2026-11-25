# 开发指南

## 环境

工具链由 mise 按根目录 `mise.toml` 提供（`mise trust && mise install`）：Node.js 与 pnpm 的版本只写在 `package.json` 的 `devEngines` 中，由 mise 读取；ffmpeg 的版本写在 `mise.toml`。不用 mise 时需自备 pnpm，它会按 `devEngines` 自动下载 Node.js。缩略图相关测试需要 ffmpeg，通过环境变量 `FFMPEG` 指定路径（用 mise 时为 `FFMPEG=ffmpeg`），未设置时跳过。

```sh
pnpm install
pnpm build          # 构建 Atmosphere 与网页
SECRET_KEY=$(openssl rand -base64 48) pnpm dev   # 启动服务端，数据在 server/data
pnpm --filter @midden/web dev                     # 网页开发服务器，代理 /v1 到 8080
```

server 不编译：Node 直接运行 `.ts`，因此只能使用可擦除的 TypeScript 语法（不能用 enum、参数属性）。包内导入使用 `#` 子路径，如 `#db/client.ts`。

## 检查

提交前运行：

```sh
pnpm lint
pnpm typecheck
pnpm test
```

`pnpm install` 会通过 simple-git-hooks 安装 pre-commit 钩子（命令在根目录 `package.json` 的 `simple-git-hooks` 字段）：每次提交前对暂存的文件运行 lint，并对整个仓库运行 typecheck（测试不在其中）。确需跳过时用 `git commit --no-verify`。

lint 在根目录对整个仓库运行，只有一份配置；`third_party/` 是上游代码，`server/drizzle/` 是生成的迁移，均不参与。`scripts/` 下的脚本使用 `.ts`。e2e 测试：`pnpm --filter @midden/web test:e2e`。

e2e 默认由 Playwright 启动自己的 Vite，端口由当前工作目录路径的哈希决定（20000–39999），不同 worktree 同时运行互不干扰；端口已被占用时直接报错，不会复用。可用 `E2E_PORT` 指定端口。要对手动启动的服务器运行，设置 `E2E_REUSE_SERVER=1` 并让 `E2E_PORT` 指向它（服务器需提供 `/app/`），此时需自行确认它来自当前 worktree。CI 不受影响。

## 数据库

表结构在 `server/src/db/schema.ts`。修改后生成迁移：

```sh
pnpm --filter @midden/server db:generate --name <说明>
```

Drizzle 使用 Node 内置的 `node:sqlite`，查询与事务都是同步的，事务回调中不能 `await`。原生 `sql` 表达式返回的整数是 BigInt，需要 `.mapWith(Number)`。

## 测试

采集相关测试使用 `server/src/testing/` 中的内存数据库上下文与假平台（`fake.test`），通过真实的任务队列驱动抓取，不访问网络。Telegram 测试使用记录调用的假 API。

## 文档

- `README.md`：部署与使用。
- `docs/architecture.md`：已实现的结构。
- `docs/operations.md`：运维。
- `.ai/`：旧实现的行为规格，供开发参考。
