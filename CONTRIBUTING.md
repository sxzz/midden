# 开发指南

## 环境

工具链由 mise 按根目录 `mise.toml` 提供（`mise trust && mise install`）：Node.js 与 pnpm 的版本只写在 `package.json` 的 `devEngines` 中，由 mise 读取；ffmpeg 的版本写在 `mise.toml`。不用 mise 时需自备 pnpm，它会按 `devEngines` 自动下载 Node.js。缩略图相关测试需要 ffmpeg，通过环境变量 `FFMPEG` 指定路径（用 mise 时为 `FFMPEG=ffmpeg`），未设置时跳过。

```sh
pnpm install
pnpm build          # 构建 Atmosphere 与网页
SECRET_KEY=$(openssl rand -base64 48) pnpm dev   # 启动服务端，数据在 server/data
pnpm --filter @midden/web dev                     # 网页开发服务器，代理 /v1 到 8080
```

`pnpm dev` 在一个进程中运行全部（`MIDDEN_ROLE` 默认 `all`），测试也是这样。生产环境分成网页进程和 worker 两个进程（见 `docs/architecture.md`「进程」），本地要试时在两个终端分别运行 `MIDDEN_ROLE=web pnpm dev` 与 `MIDDEN_ROLE=worker pnpm dev`，数据目录相同；worker 的健康检查端口是 `WORKER_HEALTH_PORT`（默认 8082）。

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

负载测试：`server/scripts/bench-load.ts` 在数据库副本上做一次大批更新（假平台每页 100 条帖子，每条有图片、一成有视频，媒体上传到假的 R2，原始响应移到假的存储桶，缩略图用 ffmpeg），同时从外面每 100 毫秒请求 `/healthz`、每 500 毫秒请求一页收藏、每秒改一次备注，最后给出各自的 p50 / p95 / p99 / 最长、`database is locked` 的次数等，存在数据目录的 `bench/result.json`。可以一并运行 Litestream（`litestream=<可执行文件>`，复制到本地目录，用 `litestream.yml` 的检查点设置）和一个持续若干秒的读事务（`pin=60`，模拟备份）：

```sh
cp server/data/midden.db /tmp/bench/ && cd server
FFMPEG=ffmpeg node scripts/bench-load.ts /tmp/bench split profiles=10 count=300 litestream=/path/to/litestream pin=60
```

`split` 是两个进程，`all` 是一个进程；`entry=<文件>` 运行另一个版本的单进程入口（它要接受 `scripts/bench-load/fakes.ts` 的假对象），用来和旧版本比较。

`scripts/` 的测试（`scripts/*.test.ts`）用 Node 自带的 `node --test` 运行，`pnpm test` 包含它们。`deploy.test.ts` 用记录调用的假命令代替 docker、git 与 curl，数据目录是临时目录。

## 文档

- `README.md`：部署与使用。
- `docs/architecture.md`：已实现的结构。
- `docs/operations.md`：运维。
- `.ai/`：旧实现的行为规格，供开发参考。
