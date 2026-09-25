# Monitor

Go 常驻图文归档服务。Telegram 私聊发送 X 帖子 URL，异步保存 xdown 返回的摘要和静态图片，支持历史查询。核心与 X adapter 独立运行；不包含 Web UI 或 TypeScript SDK。

## 启动

需要 Docker Compose 和已有的 S3 兼容 bucket。开发构建使用 Go 1.27.1；生成的 protobuf Go 文件已经提交，正常编译无需 protoc。

1. 复制 `.env.example` 为 `.env`，设置三个随机密码/服务密钥和 S3 配置。bucket 需预先创建，S3 凭据需具备该 bucket 的 Get/Put/Delete 权限。
2. `docker compose up --build -d`。迁移容器使用管理员角色，业务核心使用独立 `monitor_app` 角色；API 监听本机 8080，内部监控监听本机 9090。
3. Telegram 可暂留空，先通过 REST 验证归档。使用下列 CLI 创建租户与租户 API token：

```sh
docker compose run --rm --entrypoint monitorctl migrate tenant-create
docker compose run --rm --entrypoint monitorctl migrate token-create <tenant-uuid>
```

CLI 的服务名是 `migrate`，它有管理员连接。token 仅在创建时输出；保存 token ID 以便撤销。不要给核心配置管理员连接。

```sh
curl -H "Authorization: Bearer $MONITOR_TOKEN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: example-1' \
  -d '{"url":"https://x.com/jack/status/20"}' \
  http://127.0.0.1:8080/v1/captures
```

该示例链接仅说明提交方式，不保证 xdown 能返回内容。完整接口见 [OpenAPI](docs/openapi.yaml)。

## Docker 本地对象存储

没有现成 S3 服务时，使用持久化的 SeaweedFS 容器：

```sh
python3 scripts/configure-local-storage.py
docker compose up --build -d
```

脚本在 `.env` 中启用 `compose.local.yaml`，生成并保存本地 S3 凭据到忽略的 `.local/s3.json`；不会覆盖已配置的 Bot token 或轮换有效密码。`storage-init` 自动创建 `monitor` bucket，并验证读、写、删除。核心通过 `http://s3:8333` 访问，宿主机端点为 `http://127.0.0.1:8333`。未签名请求被拒绝。

数据位于 Compose 的 `s3-data` volume，普通 `docker compose down` 不删除数据；`down -v` 会删除数据库与对象存储的数据卷。备份时同时保留 `.env`、`.local/s3.json` 和数据备份，并限制凭据文件权限。若已设置 Bot token，首次启动前仍需按下节注册 Channel。

## Telegram

从 BotFather 获取 Bot token，确认 `getMe` 返回的 Bot 数字 ID，并生成一个固定 Channel UUID。注册后设置 `.env` 中 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHANNEL_ID`，重建 core：

```sh
docker compose run --rm --entrypoint monitorctl migrate channel-create <channel-uuid> <bot-numeric-id>
docker compose up -d --force-recreate core
```

同一 Bot 只能有一个 long-polling 接收者，启用前移除既有 webhook。Channel UUID 跨重启、token 轮换保持不变。核心校验实际 Bot ID 与注册记录，避免误用新 Bot 接管旧身份。

仅私聊创建身份和个人租户。发送最多 5 个 X URL，使用 `/recent`、`/show <id>`、`/status <id>`、`/refresh <id>`、`/usage`。租户 ID 独立于 Telegram ID；模型支持一个租户绑定多个 Channel 身份，跨渠道绑定界面/接口尚未实现。不要手工将互不相关的身份合并。

## 采集范围

当前仅 xdown Provider，参考 [twitter.py](https://github.com/LoCCai/nonebot-plugin-parser-m/blob/master/src/nonebot_plugin_parser/parsers/twitter.py) 的请求与解析方式重新实现。保存其实际返回的文字，标记为 Provider 摘要，不虚构作者、发布时间或完整正文。JPEG/PNG/WebP 保存原始字节，视频/GIF 不下载。

真实探测中，xdown 对一个公开帖子返回了 `status: ok` 但没有 `data` 字段；这种情况会明确失败。固定 fixtures 验证解析与完整归档链路，不能据此保证第三方当前对所有帖子可用。没有浏览器抓取或账号服务作为隐式回退。

Provider 和 Connection 分离；Connection 属于租户、可跨渠道共享。模型预留账号状态和不透明凭据引用，但本期没有凭据录入、token 存储、OAuth 或账号 Provider；此类请求返回 422。未来凭据须由专门服务加密管理，不能写入任务/归档/日志。

## 持久化与运行

- PostgreSQL RLS + 租户关联外键，普通业务角色不能绕过 RLS。初次身份解析通过限定的 SECURITY DEFINER 入口执行。
- 提交幂等、同租户在途采集合并、每次提交独立投递；所有渠道共用租户额度。
- River 与业务数据同事务入队；采集、下载、归档完成和 Telegram 投递独立恢复。重试最多三次，遵循 Retry-After。
- 图片流式下载到权限受限临时文件后上传，SHA-256 租户内去重。上传前持久记录对象 key，失败重用同一 key；重复及失败对象等待至少 24 小时回收。
- 历史版本保留，临时下载 URL 变化不生成内容版本；图文结果投递绑定原采集版本。读归档不访问上游。
- Telegram API 不提供通用幂等发送；响应丢失时可能重复回传，不能保证展示严格一次。数据库归档与扣费仍幂等。
- 图片 URL 的每个连接/重定向都进行公共地址校验，实际拨号使用已校验 IP；不继承 HTTP_PROXY 来绕过检查。
- `/metrics` 包含任务耗时、结果、队列量与最老等待时间；`/healthz` 检查数据库。监控端口只供可信运维访问。

默认额度：每租户 1 GiB、10 次新采集/分钟、2 个采集并发；全局采集 4、下载 8；单图 20 MiB、单帖 20 图。可通过 `TENANT_QUOTA_BYTES`、`CAPTURE_RATE`、`TENANT_CONCURRENCY`、`CAPTURE_WORKERS`、`DOWNLOAD_WORKERS`、`MAX_IMAGE_BYTES`、`MAX_IMAGES` 配置。租户额度在创建时持久化，调整已有租户额度需管理员更新数据库。Compose 中需要添加对应环境变量才能覆盖默认值。

扩容优先增加 worker 资源，保留一个 Bot poller。数据库连接池需要大于所有占用 session lock 的 worker 加控制/API 余量，启动时会校验。大幅增加 worker 时通过 DATABASE_URL 的 `pool_max_conns` 配置连接池。公网部署需 TLS 反向代理；跨不可信网络运行 adapter 时配置 `ADAPTER_TLS_CERT`、`ADAPTER_TLS_KEY` 和核心 `ADAPTER_TLS_CA`。

## 验证

```sh
make fmt
make test
make vet
make integration
```

`make integration` 仅使用隔离 Docker PostgreSQL 与 SeaweedFS S3 容器，随机映射本机端口，结束删除测试容器，不使用本地 PostgreSQL 服务。包含真实 RLS、并发身份、跨渠道共享、版本、故障恢复、S3、REST、gRPC 与 100 租户/1000 任务测试。没有测试环境变量时，依赖数据库的测试明确 skip。

备份恢复说明见 [运维文档](docs/operations.md)。核心协议源见 `api/adapter/v1/adapter.proto`，可用 `make generate` 再生成代码。

格式化使用 `make fmt`：Go import 分组与 gofumpt、pgFormatter（`pg_format`）、Ruff、shfmt 和 Prettier。需准备 Go、Node/npm、uv 及 pgFormatter；在 macOS 可用 `brew install pgformatter` 安装 SQL 格式化工具。工具命令不读取本地凭据文件。
