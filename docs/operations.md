# 运维与恢复

## 服务边界

`core` 仅使用非超级用户、非表所有者且不具备 BYPASSRLS 的 `monitor_app`。迁移和 CLI 使用管理员连接，管理员密码不注入核心或 adapter。S3 bucket 必须私有，图片经租户授权 API 读取，不暴露永久公开链接。

默认 Compose 仅将 API 和监控映射到宿主机 loopback。外网访问 API 使用 TLS 反向代理。默认 Compose 由 `tls-init` 生成内部证书，通过 `adapter-tls` volume 提供给 Adapter 和核心，使用带服务认证的 TLS gRPC。证书有效期两年；到期前替换证书和密钥并重启 Adapter、核心。个人账号执行禁止使用明文 RPC。

同一 Bot 一个接收者通过 PostgreSQL session advisory lock 保证；租户采集槽与图片任务也使用 session lock。进程退出后锁自动释放。账号采集同时持有租户槽和 Connection 槽，各需要一个池连接，执行短事务时还会获取连接；应为控制任务和 API 保留连接余量。

## 服务器部署与升级

首次部署按 README 配置 `.env` 和 S3，再运行 `docker compose up --build -d`。迁移服务成功退出后核心才启动。

已有 Git 部署执行 `./scripts/deploy.sh --pull`，以 fast-forward 方式拉取当前分支后，从服务器上的源码构建 Docker 镜像。已更新代码时也可执行 `./scripts/deploy.sh`，可用第一个参数指定新的备份目录。脚本按顺序构建所有镜像（包括迁移镜像），停止核心后导出数据库，再执行应用与 River 迁移并更新数据库角色密码，成功后重建 Adapter 和核心。迁移失败会立即退出并保持核心停止；修复未成功的迁移后可重跑。每个迁移事务失败都会回滚，已成功提交的迁移保留，重跑不会重复执行。迁移过程需要停机窗口。

私有仓库部署建议为服务器配置仅此仓库可用的只读 SSH deploy key，将私钥保存在服务器 `~/.ssh`，不要放进仓库或镜像。`.env`、本地 S3 凭据和备份不纳入 Git。

低内存服务器可使用 `DEPLOY_STOP_BEFORE_BUILD=1 ./scripts/deploy.sh --pull`，先停止核心和 Adapter 为编译腾出内存。构建或迁移失败时保持停止，排错后重新执行脚本。若进程被强制终止，确认没有部署仍在运行后可删除空目录 `.local/deploy.lock` 再重试。

`compose.server.yaml` 提供较低的运行内存上限，并将 API、监控、S3 映射到本机 `18080`、`19090`、`18333` 端口。使用本地 S3 的服务器可在 `.env` 设置 `COMPOSE_FILE=compose.yaml:compose.local.yaml:compose.server.yaml`。已有部署应保持原 `COMPOSE_PROJECT_NAME`，以继续使用原来的容器和数据卷。

升级前还应按照下文备份对象存储，并安全保管 `.env` 中的 `CREDENTIAL_KEY` 及部署凭据。迁移脚本只自动备份数据库；账号密文恢复需要原加密密钥。备份默认写入 `.local/backups`，权限仅限当前用户，需另行复制到服务器外。

当前基线已经包含全部现有字段。从此基线部署或恢复的数据库都携带 `schema_migrations`；不支持从更早的开发 schema 自动升级。协议保持 `1.0`、schema 保持 `1`，迁移记录单独管理。已执行迁移的校验和不允许改变；旧构建缺少数据库已执行的迁移时拒绝迁移，不做自动降级。需要退回版本时，应恢复升级前数据库及配套对象备份，再运行匹配的旧构建。

## 观察与故障处理

`http://127.0.0.1:9090/metrics`：

- `monitor_task_duration_seconds`：按任务类别的执行耗时。
- `monitor_task_results_total`：采集、下载、投递等成功/失败次数。
- `monitor_provider_requests_total` / `monitor_provider_duration_seconds`：按 Provider 记录 RPC 状态及耗时，不记录账号或租户标签。
- `monitor_queue_jobs`：按队列和状态的数量，每分钟更新。
- `monitor_queue_oldest_seconds`：最老等待任务年龄。

`/healthz` 检查数据库。Adapter 提供带服务认证的 gRPC health；启动时 Core 还验证 Describe 契约。每租户存储使用由 `/v1/usage` 查询，避免在 Prometheus 导出无界租户标签。

关注持续队列积压、provider 失败率、图片失败及 Telegram 429。失败信息对用户脱敏，不输出远端响应、token、Bot API 请求 URL。FxTwitter 返回成功状态但没有可用图文时，采集仍然失败；不要将其判定为源帖子删除。

任务最多执行三次。进程中断的 River 任务由 stuck-job rescue 恢复；达到最终尝试后被丢弃的任务由每分钟 reconciliation 转成明确业务失败并释放预留额度。图片下载预留在重试间保留，资源失败或成功时释放。业务事务与 River 入队原子提交。

投递进度按已确认的文本/图片批次记录。Telegram 接收成功而客户端丢失响应时，重试仍可能重复发送。用户可 `/show` 再次请求归档；不要依赖 Telegram 文件作为唯一备份。

## 数据和对象备份

一致备份采用短暂停写：停止核心接收和所有 worker（默认都在 core），保持 PostgreSQL 与对象存储运行；等待核心优雅退出。必须先备份全部对象和数据库，随后再恢复写入。不要只备份当前版本对应对象，旧版本同样需要保留。

示例使用 AWS CLI（配置独立的备份凭据）与 Docker 内的 PostgreSQL 工具：

```sh
docker compose stop core
mkdir -p backup/objects
chmod 700 backup
docker compose exec -T postgres pg_dump -U postgres -d monitor -Fc > backup/database.dump
aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 sync "s3://$BACKUP_S3_BUCKET/" backup/objects/
docker compose start core
```

备份目录含用户内容，应加密存放并限制权限。管理员/服务密钥单独保管。数据库逻辑额度不包含备份副本。S3 生命周期策略不能自行删除 `tenant/objects/` 下仍被引用的内容；业务回收器只删除已标记垃圾且超过配置的最小存活时间（`object_gc_grace_hours`，默认 24 小时）的对象。

## 恢复到独立环境

1. 在隔离的 Docker PostgreSQL 中创建空数据库与 `monitor_app` 角色，设置新密码；本版本迁移所有者为 PostgreSQL 管理员，恢复使用同名角色或显式映射。
2. 在不启动核心的前提下，将 SQL dump 恢复到空数据库。保留权限、函数和 RLS；不要使用会丢弃这些授权的恢复方式。
3. 将对象同步到新的私有 bucket，保持对象 key 完全不变。
4. 配置新数据库、bucket 和服务认证。验证原 Channel UUID、Bot ID、身份映射、归档 ID、原图 hash、历史版本、公开内容共享以及私有内容和保存记录的租户隔离。
5. 原环境仍在线时，不启动第二个相同 Bot 接收者。切换前先停止原接收者。

```sh
# 空数据库和角色已准备，核心尚未启动。
docker compose exec -T postgres pg_restore -U postgres -d monitor --exit-on-error < backup/database.dump
aws --endpoint-url "$RESTORE_S3_ENDPOINT" s3 sync backup/objects/ "s3://$RESTORE_S3_BUCKET/"
```

`make integration` 自动执行一个小规模真实演练：在 Docker PostgreSQL/S3 保存图文和身份，导出数据库及原图，恢复到第二个数据库与独立 bucket，再校验文本、图片 hash、身份和 RLS。演练使用测试容器，不会操作生产数据。

## 管理命令

```sh
monitorctl migrate
monitorctl app-password                  # APP_DB_PASSWORD 环境变量
monitorctl tenant-create
monitorctl token-create <tenant-uuid>    # 仅本次输出明文 token
monitorctl token-revoke <token-uuid>
monitorctl channel-create <stable-channel-uuid> <bot-numeric-id>
```

所有命令使用 `ADMIN_DATABASE_URL`。已有租户的 quota_bytes 可由管理员在核对租户 ID 后更新；更改默认 `tenant_quota_bytes` 仅影响之后新建的租户。

## 限额与并发配置

运行参数和 Telegram 凭据保存在全局 `config` 表中，仅管理员可写，核心业务角色只读。使用 `monitorctl config-list` 查看，使用 `monitorctl config-set <key> <value>` 修改；凭据推荐使用 `--stdin` 输入。数值配置必须为正整数；未知键或越界值会拒绝。归档保留天数至少为 1，不支持立即删除。配置表记录值的类型及敏感标记，CLI 列表会对敏感值脱敏。

| 配置键                   | 默认值       | 用途                         |
| ------------------------ | ------------ | ---------------------------- |
| `archive_retention_days` | `7`          | 最后一条保存记录删除后保留天数 |
| `object_gc_grace_hours`  | `24`         | 垃圾上传对象的最小存活小时数 |
| `tenant_quota_bytes`     | `1073741824` | 新租户存储额度               |
| `capture_rate`           | `10`         | 每租户每分钟新采集数         |
| `tenant_concurrency`     | `2`          | 每租户同时执行的采集         |
| `capture_workers`        | `4`          | 采集 worker 数               |
| `download_workers`       | `8`          | 图片下载 worker 数           |
| `control_workers`        | `4`          | 控制任务 worker 数           |
| `delivery_workers`       | `2`          | 消息投递 worker 数           |
| `max_image_bytes`        | `20971520`   | 单图最大字节数               |
| `max_video_bytes`       | `536870912`  | 单个视频最大字节数           |
| `max_media`             | `20`         | 每帖最多媒体数               |

两个保留期参数在下一轮维护任务生效，默认每分钟运行一次。更改归档保留期会应用于所有尚未清理的归档，时间从最后一条保存记录删除时开始计算；已物理清理的内容不会恢复。其他参数由核心启动时加载，修改后执行 `docker compose restart core`。CLI 创建租户直接使用数据库中的默认额度。

`telegram_bot_token` 和 `telegram_channel_id` 为文本配置，默认均为空。token 为空时不启动 Bot；启用时必须配置已注册的 Channel UUID。token 作为敏感值保存在数据库中，CLI 不回显明文。数据库备份也包含这些凭据，应沿用加密和访问限制。配置表不提供租户写接口。

环境变量用于数据库、对象存储、Adapter 的启动连接配置、凭据及进程监听地址。数据库连接凭据必须在数据库外提供。

修改默认存储额度不影响已有租户，已有租户使用 `tenants.quota_bytes`。读取归档不受剩余额度限制。

增加 worker 数时，按核心启动时的连接池校验要求调整 `DATABASE_URL` 中的 `pool_max_conns`，给持锁任务、业务事务和 API 留出连接余量。Adapter 跨主机部署时，可设置服务端 `ADAPTER_TLS_CERT`、`ADAPTER_TLS_KEY` 和核心 `ADAPTER_TLS_CA`。

## 个人账号接入

公共 FxTwitter API 不需要 X 账号，也不要求配置加密主密钥。只有启用个人账号时，才在 `.env` 设置 `CREDENTIAL_KEY` 为 32 个随机字节的 Base64 编码（可用 `openssl rand -base64 32` 生成），然后重新创建核心服务：

```sh
docker compose up -d --force-recreate core
```

非 Compose 部署也可通过 `CREDENTIAL_KEY_FILE` 读取 secret 文件。主密钥须单独备份，恢复数据库后仍需同一密钥才能解密；不要直接替换主密钥，否则既有凭据无法读取。更换个人账号会话使用下面的更新命令，不改变主密钥。

配置好密钥后，用户可直接在 Bot 私聊发送 `/account_add <Base64 Cookie> [名称]`。Base64 解码后的格式为 `auth_token=...; ct0=...;`，允许包含其他 Cookie，但系统只提取这两个字段。命令不支持群聊。Bot 尝试删除含凭据的私聊消息，验证成功后提供“使用此账号”按钮，默认来源不会自动改变。Base64 只是编码，不是加密；请仅向你信任的 Bot 发送会话。

下面是管理员 CLI 的另一种导入方式。

`tenant-id` 使用 `identities` 表中对应渠道身份的 `tenant_id`，不是 Telegram user ID。管理员可按已配置的 `channel_id` 和 Telegram 用户 ID（`external_id`）精确查询。

将账号浏览器会话保存为仅管理员可读的本地 JSON 文件，字段为 `auth_token` 和 `ct0`。导入时通过标准输入传入，不写入命令行参数：

```sh
docker compose run --rm -T --entrypoint monitorctl migrate connection-import <tenant-id> <显示名称> - < account.json
docker compose run --rm --entrypoint monitorctl migrate connection-list <tenant-id>
docker compose run --rm --entrypoint monitorctl migrate connection-check <tenant-id> <connection-id>
docker compose run --rm -T --entrypoint monitorctl migrate connection-import <tenant-id> <显示名称> - <connection-id> < account.json
docker compose run --rm --entrypoint monitorctl migrate connection-revoke <tenant-id> <connection-id>
```

导入验证成功后输出 Connection ID；账号列表不输出凭据。更新凭据沿用 Connection ID。撤销不会静默清除用户默认选择：用户下一次保存会收到账号不可用提示，可用 `/account` 选择公共来源。

REST 新提交省略 `connection_id` 时始终调用公共 API；指定时使用 `x-session`（可省略 `provider_id` 由核心推导）。刷新使用租户保存记录中的原选择。TLS、加密主密钥或会话无效时明确拒绝账号操作，不影响公共采集。

`config.connection_concurrency` 控制每 Connection 并发，默认 1；修改后重启核心。运行日志不保存会话、原始上游响应或个人账号身份。受保护帖子端到端验收需提供有访问权限的测试会话；自动测试使用固定响应。
