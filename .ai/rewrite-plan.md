# TypeScript 重写计划

本文件是重写期间的工作约定，供代理在上下文压缩后继续工作时对照；不是用户文档。旧实现保存在 `golang` 分支，worktree 位于 `~/workspace/midden-go`，移植时以其代码和测试为准。

## 目标变化

- 只有一个用户（所有者），不做多租户、额度和并发限制。
- 不做插件：X、Instagram 采集直接在同一进程内调用，不用 gRPC。

## 已确定的决策

| 项目     | 决定                                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 运行时   | Node 26 LTS；开发时直接在容器里运行，prod 继续用 Docker Compose（一个镜像，含 ffmpeg）                                                        |
| 数据库   | SQLite，使用 Node 内置 `node:sqlite`；Drizzle `1.0.0-rc` 的 `node-sqlite` 驱动，drizzle-kit 生成迁移。不用 better-sqlite3，除非内置驱动出问题 |
| 媒体     | `BlobStore` 接口，当前只实现本地目录，保留以后换远端／S3 的口子                                                                               |
| 媒体读取 | 签名 URL 直连：fs 实现由应用签发并提供 HMAC 链接，S3 实现将来返回预签名链接                                                                   |
| HTTP     | Hono + `@hono/node-server`                                                                                                                    |
| 校验     | valibot                                                                                                                                       |
| Bot      | grammY，长轮询，与 HTTP 同一进程                                                                                                              |
| 日志     | pino，JSON 输出到 stdout                                                                                                                      |
| 测试     | vitest                                                                                                                                        |
| 包名     | `@midden/*`                                                                                                                                   |
| 兼容性   | 不保留：旧 Bot 消息按钮、旧 REST token、`/v1/assets/{id}` 媒体读取均不兼容                                                                    |
| 数据导入 | 暂不编写导入脚本                                                                                                                              |
| 筛选性能 | 冗余索引表 `catalog`（`library/catalog.ts`），由 finalize 与原始响应清理维护；`server/scripts/bench-list.ts` 造数据并计时                     |

## Git 与发布

- 新代码在无历史的 `ts` 分支上开发，推送到 `origin/ts`；GitHub 默认分支已改为 `ts`。`main` 保持旧版不变，prod 仍从 `main` 自动部署。
- 基本迁移完成后再把 `main` 切换到 `ts` 的历史（需要用户确认，届时处理部署 webhook）。
- 按迁移阶段自行提交，每个提交范围小；提交信息英文，格式 `type(scope): ...`，不加 AI 署名。
- `main` 已指向 `ts` 的历史；`main` 上 `test` 通过后由 `images` 发布 `ghcr.io/sxzz/midden`。服务器的自动部署由用户关闭，部署手动进行。
- 每次提交后立即推送到 `origin/ts`（用户已授权）；推送 `main` 仍需用户确认。

## 工程约定

- 前端不用 `$` 开头的 Vue API（`$emit`、`$event`、`app.$` 等）：事件用 `defineEmits` 返回的 `emit`，事件参数用箭头函数接收。

- 先完成移植，不考虑与旧数据的兼容（库内格式、内容哈希可以自由设计）；旧采集数据如何复用等移植完再定。HTTP API 可以重新设计，`web/` 的前端逻辑跟着一起改写，不必迁就旧接口。

- 实体数据不再按平台声明的 JSON Schema 校验，也不存 schema：采集代码与 core 同进程，由 TS 类型保证；实体版本去重哈希只覆盖数据与媒体。

- `scripts/` 下的脚本一律用 `.ts`，由 Node 26 直接运行。
- lint 在根目录执行 `eslint --max-warnings=0 .`，只有一份根配置；`third_party/` 是上游代码，不参与 lint。
- server 不编译，Node 直接运行 `.ts`；只能用可擦除的 TS 语法（`erasableSyntaxOnly`）。包内导入用 `#` 子路径（如 `#db/client.ts`）。
- Drizzle 1.0 RC 的命名风格在建表函数上设置（`sqliteTableCreator(..., 'snake_case')`）；`node-sqlite` 驱动的事务回调是同步的，里面不能 `await`。

## 功能范围

保留（行为与旧版一致）：

- X：FxTwitter 公共来源与 `x-session` 账号来源；Instagram：`instagram-session`。
- 帖子与 Profile 采集、翻页（每批约 100 条；X 每次最多 15 个上游页，Instagram 12 个）、失败重试、停止、继续翻页。
- 版本历史、重新抓取、批量刷新（refresh batches）、内容哈希去重。
- ffmpeg 缩略图、标签与备注、相关收藏、作者列表、敏感媒体、原始响应查看。
- 采集账号管理（凭据加密）、账号选择。
- Telegram Bot 私聊与群聊 @Bot；Mini App、Telegram 登录、REST Bearer token、删除全部收藏。
- 网页 `web/`，只修改媒体 URL 相关部分。

删除：

- 租户、`tenant_collections`、`access_grants`、`revision_access_requirements`、可见性传递、RLS、额度与用量限制。
- adapter registry、`additional_adapters`、gRPC、TLS 证书、内部 Channel API、channel UUID。
- 群聊「我也要存」及按成员区分的保存记录。
- Prometheus 指标（保留 `/healthz`）、租户管理命令、数据库 `config` 表（配置改为环境变量）。
- PostgreSQL、SeaweedFS、River、migrate／tls-init／storage-init 服务。

默认处理：

- REST 路径保持 `/v1/...`，媒体改为响应中直接返回签名 URL；`docs/openapi.yaml` 同步更新。
- 应用自身在 `/app/` 提供网页，Cloudflare 静态部署保留；Tunnel 需额外转发 `/media/*`。
- 删除收藏立即从收藏库消失；没有进行中采集的未保存收藏由维护任务立即物理删除（不再有 `collection_retention_days`）；不再被引用的媒体文件 24 小时后删除。
- 「已保存」沿用旧 `tenant_collections` 的语义，改为不带租户的 `library` 表：每次非刷新的提交（包括自动采集的成员和引用）都会保存。
- 媒体不设大小上限（旧版额度去掉后本来就没有）；每次采集最多 20 个内容媒体、16 个带 purpose 的媒体。
- 旧行为照搬：Instagram 404 会重试 3 次；带采集选项的「继续」会一直翻到时间线末尾。
- `/usage` 只显示已用空间。
- 网页会话不迁移；作者是否锁定（`protected`）作为内容数据保留，用于「可见性」筛选。
- 群聊只处理所有者发出且 @Bot 的消息；私聊只接受所有者。
- 文档继续用中文。

## 认证与配置

- `OWNER_TELEGRAM_ID`：Telegram 登录与 Mini App initData 用 bot token 校验，只接受该用户。
- REST token 以哈希保存，由 CLI 生成。
- 环境变量（valibot 校验）：`DATA_DIR`、`TELEGRAM_BOT_TOKEN`、`OWNER_TELEGRAM_ID`、`WEB_APP_URL`、`SECRET_KEY`（派生凭据加密和 URL 签名子密钥）等。

## 结构

```
server/src/
  config.ts      环境变量
  db/            schema、迁移、连接（WAL、busy_timeout、foreign_keys）
  blob/          BlobStore 接口、fs 实现、URL 签名
  jobs/          SQLite 持久化队列（租约、重试退避、按类型并发、启动恢复）与定时维护
  platforms/     x、instagram（由 adapters/ 移入，去掉 gRPC）
  capture/       采集 → 版本与实体 → 下载 → 缩略图 → finalize → related
  library/       列表与筛选
  http/          Hono 路由与认证
  telegram/      grammY Bot
shared/          server 与 web 共用的类型（valibot schema）
third_party/atmosphere/  原样保留
web/             现有网页
```

后台任务种类沿用旧版：`capture`、`download`、`thumbnail`、`finalize`、`related`、`refresh_batch`。定时维护对应旧版 `Maintain`：卡住采集的恢复、未引用媒体回收、原始响应清理。

数据表去掉 `tenant_id` 与可见性访问控制字段，其余结构基本照搬；ID 保留 UUID 文本；时间存整数毫秒。

媒体：`media/ab/cd/<sha256>`，临时文件 → fsync → rename。接口 `put`、`stat`、`read(range)`、`delete`、`url(hash, { expiresIn, filename, disposition })`。签名过期时间按固定窗口取整，使同一窗口内 URL 稳定、浏览器缓存有效。

## 采集移植

旧 Go 采集链路的行为规格见 `.ai/capture-spec.md`（带 `golang` 分支的文件与行号引用），移植时以它为准，有疑问再查 `~/workspace/midden-go`。第 3 阶段按以下顺序分步提交：

1. 业务表结构。
2. 规范化 JSON、计数字段拆分、实体图校验。
3. 提交（Submit）。
4. capture 任务与 finalize（版本签名与去重）。
5. 下载、MIME 识别、媒体缓存、缩略图。
6. related 展开与自动续页、停止。
7. 采集记录、进度、成员重试。
8. 批量刷新、删除、标签备注、账号与凭据、定时维护。

## 进度

- 第 1–6 阶段已完成：采集链路、HTTP API 与读取侧、网页改用签名媒体链接、Telegram Bot（`server/src/telegram/`，规格见 `.ai/telegram-spec.md`）、定时维护。用真实 FxTwitter 帖子端到端验证过采集与 API；Bot 只有假 API 的测试，尚未接真实 Bot 验证。
- 第 7 阶段：Dockerfile（`node:26.13.1-alpine`，升级 Node 时与 `devEngines` 一起改）、`compose.yaml`、`.env.example`、`cli.ts token create` / `backup`、README 与 `docs/`、`CONTRIBUTING.md` 已完成。CI 的 `image` 任务只构建并做健康检查，不发布。
- Bot 实现与旧版的差异：正文为空时只显示 ID 与作者（不显示"空"）；按钮提示真正显示；链接先去重再按 200 计数；非所有者的按钮静默应答；`/show` 直接按收藏投递；投递每 5 秒轮询，不由采集事件唤醒。
- 本地检查：依次运行 `pnpm lint`、`pnpm typecheck`、`FFMPEG=ffmpeg pnpm --filter @midden/server exec vitest run`（容器里有 apt 装的 ffmpeg）。本机下载不了 Playwright 浏览器，e2e 看 CI。
- dev：仓库根目录 `.env`（不提交）配置测试 Bot @kevinspiderbot 与 `WEB_APP_URL=https://devbox.beago-mine.ts.net/app/`；`tailscale serve` 把 tailnet 内的 HTTPS 转发到 8080；`pnpm dev` 启动。
- 第 8 阶段：`main` 已切换，镜像发布工作流已加入；prod 的部署与 Cloudflare `/app/` 静态部署（`web` 工作流）由用户决定何时恢复。旧数据由另一个代理写的导入脚本迁移。

## 阶段

1. 骨架：pnpm workspace（`server/`、`shared/`、`web/`、`third_party/atmosphere/`），lint／format／typecheck／vitest，CI。
2. 存储层：schema 与迁移、BlobStore fs 与 URL 签名、任务队列。
3. 采集：接入 X 与 Instagram，下载、去重、缩略图、版本、Profile 翻页。
4. HTTP API：逐个对照旧路由实现，修改网页的媒体 URL，跑通 web 测试与 e2e。
5. Telegram Bot：全部命令与按钮。
6. 定时维护：恢复、回收、清理。
7. 部署与文档：Dockerfile、compose、deploy／backup 脚本，重写 README、`docs/architecture.md`、`docs/operations.md`、`CONTRIBUTING.md`。
8. 切换 main 与 prod：需要用户确认。

测试按行为移植，重点覆盖去重、版本、翻页、重新抓取、相关收藏、认证和 Bot 命令解析；adapter 的 TS 测试与 fixtures 沿用。
