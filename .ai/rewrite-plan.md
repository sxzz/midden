# TypeScript 重写计划

本文件是重写期间的工作约定，供代理在上下文压缩后继续工作时对照；不是用户文档。旧实现保存在 `golang` 分支，worktree 位于 `~/workspace/midden-go`，移植时以其代码和测试为准。

## 目标变化

- 只有一个用户（所有者），不做多租户、额度和并发限制。
- 不做插件：X、Instagram 采集直接在同一进程内调用，不用 gRPC。

## 已确定的决策

| 项目     | 决定                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------------------- |
| 运行时   | Node 26 LTS；开发时直接在容器里运行，prod 继续用 Docker Compose（一个镜像，含 ffmpeg）                                      |
| 数据库   | SQLite，使用 Node 内置 `node:sqlite`；Drizzle `1.0.0-rc` 的 `node-sqlite` 驱动，drizzle-kit 生成迁移。不用 better-sqlite3，除非内置驱动出问题 |
| 媒体     | `BlobStore` 接口，当前只实现本地目录，保留以后换远端／S3 的口子                                                             |
| 媒体读取 | 签名 URL 直连：fs 实现由应用签发并提供 HMAC 链接，S3 实现将来返回预签名链接                                                 |
| HTTP     | Hono + `@hono/node-server`                                                                                                  |
| 校验     | valibot                                                                                                                     |
| Bot      | grammY，长轮询，与 HTTP 同一进程                                                                                            |
| 日志     | pino，JSON 输出到 stdout                                                                                                    |
| 测试     | vitest                                                                                                                      |
| 包名     | `@midden/*`                                                                                                                 |
| 兼容性   | 不保留：旧 Bot 消息按钮、旧 REST token、`/v1/assets/{id}` 媒体读取均不兼容                                                 |
| 数据导入 | 暂不编写导入脚本                                                                                                            |
| 筛选性能 | 本次不处理；列表查询集中在 `library/` 模块，以后加冗余索引表只改这里                                                       |

## Git 与发布

- 新代码在无历史的 `ts` 分支上开发，推送到 `origin/ts`；`main` 保持不变，旧版可继续自动部署。
- 基本迁移完成后再把 `main` 切换到 `ts` 的历史（需要用户确认，届时处理部署 webhook）。
- 按迁移阶段自行提交，每个提交范围小；提交信息英文，格式 `type(scope): ...`，不加 AI 署名。
- 在切换前，`ts` 的 CI 只跑检查和测试，不发布镜像、不触发部署。
- 推送每次都先问用户。

## 功能范围

保留（行为与旧版一致）：

- X：FxTwitter 公共来源与 `x-session` 账号来源；Instagram：`instagram-session`。
- 帖子与 Profile 采集、翻页（每批约 100 条、最多 12 页）、失败重试、停止、继续翻页。
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
- 删除收藏立即生效；不再被引用的媒体 24 小时后回收；去掉 `collection_retention_days`。
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
