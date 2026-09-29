# 运维与恢复

## 服务边界

`core` 仅使用非超级用户、非表所有者且不具备 BYPASSRLS 的 `monitor_app`。迁移和 CLI 使用管理员连接，管理员密码不注入核心或 adapter。S3 bucket 必须私有，图片经租户授权 API 读取，不暴露永久公开链接。

默认 Compose 仅将 API 和监控映射到宿主机 loopback。外网访问 API 使用 TLS 反向代理。默认 Compose 由 `tls-init` 生成内部证书，通过宿主机 `.local/adapter-tls/` 目录挂载提供给 Adapter 和核心，使用带服务认证的 TLS gRPC。证书有效期两年；到期前替换证书和密钥并重启 Adapter、核心。个人账号执行禁止使用明文 RPC。

同一 Bot 一个接收者通过 PostgreSQL session advisory lock 保证；租户采集槽与图片任务也使用 session lock。进程退出后锁自动释放。账号采集同时持有租户槽和 Connection 槽，各需要一个池连接，执行短事务时还会获取连接；应为控制任务和 API 保留连接余量。

## 服务器部署与升级

首次部署按 README 配置 `.env` 和 S3，再运行 `docker compose pull && docker compose up -d`。迁移服务成功退出后核心才启动。

GitHub Actions 在 main 分支测试通过后构建并发布 `ghcr.io/sxzz/midden-core` 和 `ghcr.io/sxzz/midden-adapter`，支持 amd64、arm64。镜像同时包含 `latest` 标签和不可变部署选择 `sha-<完整提交 SHA>`。

服务器可安装独立的一键更新脚本：

```sh
cp scripts/deploy-latest.sh ~/deploy-midden.sh
chmod +x ~/deploy-midden.sh
~/deploy-midden.sh --check  # 检查最新镜像，不切换服务
~/deploy-midden.sh          # 部署最新已发布版本
```

脚本默认使用 `~/monitor`，可通过 `MIDDEN_DIR` 指定仓库目录。它从 GHCR Core 的 `latest` 读取提交号，确认同一提交的 Core、Adapter 镜像均可用，再将干净仓库切换到该提交、备份数据库、执行迁移并更新应用。仓库会处于 detached HEAD；以后继续运行仓库外的脚本即可。最终以健康检查成功为部署完成。镜像发布尚未齐全时会在停止服务前退出，稍后重试即可。该脚本更新 Core 和 Adapter，数据库及对象存储容器的配置调整由运营者另行执行。

已有部署运行 `./scripts/deploy.sh --pull`：fast-forward 拉取当前分支，下载该提交对应的镜像，停止核心后导出数据库，再执行迁移并启动 Adapter 和核心。服务器不执行镜像构建。如果 CI 尚未发布对应镜像，拉取失败，旧服务继续运行。迁移失败时保持核心停止，修复后重新部署。成功后将本次镜像标签写入 `.env`，日常重启保持相同版本。

仓库及镜像公开，服务器可以匿名 HTTPS 拉取。`.env`、S3 凭据和备份不纳入 Git。若部署进程被强制终止，确认没有部署仍在运行后可删除空目录 `.local/deploy.lock` 再重试。

`compose.server.yaml` 提供较低的运行内存上限，并将 API、监控、S3 映射到本机 `18080`、`19090`、`18333`。使用本地 S3 的服务器可设置 `COMPOSE_FILE=compose.yaml:compose.local.yaml:compose.server.yaml`。已有部署保持原 `COMPOSE_PROJECT_NAME`，以继续管理原容器；数据通过项目下的 `.local/` 目录挂载，移动项目时需同步迁移该目录，并保留文件权限和所有者。旧版命名卷部署需先按 README 迁移数据。

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

投递进度按已确认的文本/图片批次记录。Telegram 接收成功而客户端丢失响应时，重试仍可能重复发送。用户可 `/show` 再次请求收藏；不要依赖 Telegram 文件作为唯一备份。

## 数据和对象备份

一致备份采用短暂停写：停止 Telegram channel、核心 API 和所有 worker，保持 PostgreSQL 与对象存储运行；等待进程优雅退出。必须先备份全部对象和数据库，随后再恢复写入。不要只备份当前版本对应对象，旧版本同样需要保留。

示例使用 AWS CLI（配置独立的备份凭据）与 Docker 内的 PostgreSQL 工具：

```sh
docker compose stop telegram core
mkdir -p backup/objects
chmod 700 backup
docker compose exec -T postgres pg_dump -U postgres -d monitor -Fc > backup/database.dump
aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 sync "s3://$BACKUP_S3_BUCKET/" backup/objects/
docker compose start core
# 原本启用 Telegram 时再恢复
docker compose --profile telegram start telegram
```

备份目录含用户内容，应加密存放并限制权限。管理员/服务密钥单独保管。数据库逻辑额度不包含备份副本。S3 生命周期策略不能自行删除 `tenant/objects/` 下仍被引用的内容；业务回收器只删除已标记垃圾且超过配置的最小存活时间（`object_gc_grace_hours`，默认 24 小时）的对象。

## 恢复到独立环境

1. 在隔离的 Docker PostgreSQL 中创建空数据库与 `monitor_app` 角色，设置新密码；本版本迁移所有者为 PostgreSQL 管理员，恢复使用同名角色或显式映射。
2. 在不启动核心的前提下，将 SQL dump 恢复到空数据库。保留权限、函数和 RLS；不要使用会丢弃这些授权的恢复方式。
3. 将对象同步到新的私有 bucket，保持对象 key 完全不变。
4. 配置新数据库、bucket 和服务认证。验证原 Channel UUID、Bot ID、身份映射、收藏 ID、原图 hash、历史版本、公开内容共享以及私有内容和保存记录的租户隔离。
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

运行参数和 Telegram 凭据保存在全局 `config` 表中，仅管理员可写，核心业务角色只读。使用 `monitorctl config-list` 查看，使用 `monitorctl config-set <key> <value>` 修改；凭据推荐使用 `--stdin` 输入。数值配置必须为正整数；未知键或越界值会拒绝。收藏保留天数至少为 1，不支持立即删除。配置表记录值的类型及敏感标记，CLI 列表会对敏感值脱敏。

| 配置键                   | 默认值       | 用途                         |
| ------------------------ | ------------ | ---------------------------- |
| `collection_retention_days` | `7`          | 最后一条保存记录删除后保留天数 |
| `object_gc_grace_hours`  | `24`         | 垃圾上传对象的最小存活小时数 |
| `tenant_quota_bytes`     | `1073741824` | 新租户存储额度               |
| `capture_rate`           | `10`         | 每租户每分钟新采集数         |
| `tenant_concurrency`     | `2`          | 每租户同时执行的采集         |
| `capture_workers`        | `4`          | 采集 worker 数               |
| `download_workers`       | `8`          | 图片下载 worker 数           |
| `control_workers`        | `4`          | 控制任务 worker 数           |
| `delivery_workers`       | `2`          | 旧投递 worker 配置，独立 channel 不使用           |
| `max_image_bytes`        | `20971520`   | 单图最大字节数               |
| `max_video_bytes`       | `536870912`  | 单个视频最大字节数           |
| `max_media`             | `20`         | 每帖最多媒体数               |

两个保留期参数在下一轮维护任务生效，默认每分钟运行一次。更改收藏保留期会应用于所有尚未清理的收藏，时间从最后一条保存记录删除时开始计算；已物理清理的内容不会恢复。其他参数由核心启动时加载，修改后执行 `docker compose restart core`。CLI 创建租户直接使用数据库中的默认额度。

`telegram_bot_token` 和 `telegram_channel_id` 为文本配置，默认均为空。core 不再启动 Bot；启用独立 `telegram` 服务时必须配置已注册的 Channel UUID。token 作为敏感值保存在数据库中，CLI 不回显明文。数据库备份也包含这些凭据，应沿用加密和访问限制。配置表不提供租户写接口。

环境变量用于数据库、对象存储、Adapter 的启动连接配置、凭据及进程监听地址。数据库连接凭据必须在数据库外提供。

修改默认存储额度不影响已有租户，已有租户使用 `tenants.quota_bytes`。读取收藏不受剩余额度限制。

增加 worker 数时，按核心启动时的连接池校验要求调整 `DATABASE_URL` 中的 `pool_max_conns`，给持锁任务、业务事务和 API 留出连接余量。Adapter 跨主机部署时，可设置服务端 `ADAPTER_TLS_CERT`、`ADAPTER_TLS_KEY` 和核心 `ADAPTER_TLS_CA`。

## 个人账号接入

公共 FxTwitter API 不需要 X 账号，也不要求配置加密主密钥。只有启用个人账号时，才在 `.env` 设置 `CREDENTIAL_KEY` 为 32 个随机字节的 Base64 编码（可用 `openssl rand -base64 32` 生成），然后重新创建核心服务：

```sh
docker compose up -d --force-recreate core
```

非 Compose 部署也可通过 `CREDENTIAL_KEY_FILE` 读取 secret 文件。主密钥须单独备份，恢复数据库后仍需同一密钥才能解密；不要直接替换主密钥，否则既有凭据无法读取。更换个人账号会话使用下面的更新命令，不改变主密钥。

配置好密钥后，用户可在 Bot 私聊发送 `/account_add`，选择平台后按提示直接发送凭据。Base64 解码后的格式为 `auth_token=...; ct0=...;`，允许包含其他 Cookie，但系统只提取这两个字段。命令不支持群聊。Bot 尝试删除含凭据的私聊消息，验证通过 X Viewer API 获取账号 ID 与 handle，保存后在账号列表显示 `@handle` 和自定义名称；重新验证会更新 handle。验证成功后提供“使用此账号”按钮，默认来源不会自动改变。Base64 只是编码，不是加密；请仅向你信任的 Bot 发送会话。

下面是管理员 CLI 的另一种导入方式。

`tenant-id` 使用 `identities` 表中对应渠道身份的 `tenant_id`，不是 Telegram user ID。管理员可按已配置的 `channel_id` 和 Telegram 用户 ID（`external_id`）精确查询。

将 Adapter 支持的凭据输入保存为仅管理员可读的本地文件。X Adapter 支持 Base64 Cookie 字符串，也支持含 `auth_token` 和 `csrf_token` 的 JSON。导入时通过标准输入传入，不写入命令行参数：

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

## 多 Adapter 与账号选择

主 Adapter 仍由 `ADAPTER_ADDRESS`、`ADAPTER_TOKEN`、`ADAPTER_TLS_CA` 配置。其他端点存放在 config 表的 `additional_adapters`，值为 JSON 数组：

```json
[
  {"address":"notes-adapter:9091","token":"replace-with-service-token","tls_ca":"/run/secrets/notes-ca.pem"}
]
```

使用 `monitorctl config-set additional_adapters --stdin` 从受保护文件导入，然后重启核心。该配置按敏感值处理，`config-list` 不显示内容。TLS CA 路径需在核心容器中可读。每个 Adapter 的 ID 必须为 1–32 个字母、数字、下划线或连字符；host 声明不能重叠，Provider ID 可以相同。

`/account` 按 Adapter 显示账号，各平台分别选择一个账号或公共来源。添加按钮显示该平台的凭据说明，下一条私聊消息直接发送凭据即可；只有一个平台时自动进入该平台。输入有效期为 10 分钟，可随时点击“取消添加”或发送 `/account_cancel`。同一条消息中的不同平台链接使用各自的选择。删除账号仅清除该平台的当前选择；已有任务保留原 Adapter 和账号，不自动回退。

## Mini App 部署

core 镜像包含网页静态产物。反向代理须同时转发同域的 `/app/` 和 `/v1/`，保留 `Origin`、Cookie、Range 和响应 Content-Range；认证与媒体响应禁止共享缓存。设置数据库配置 `web_app_url` 为完整 HTTPS `/app/` 地址并重启 core 和已启用的 telegram 服务以同步私聊入口。不要把 Bot token 放入网页环境变量。

关闭入口：将 `web_app_url` 设为空字符串并重启，Cookie 登录随之停用。已有 REST token 不受影响。会话过期后由维护任务清理；更换域名会使旧 Origin 无法进行 Cookie 写操作。

Adapter 不可达时仍可浏览、搜索和删除已有收藏。后台每轮发现结束后等待 15 秒重试，日志记录可用性变化；`/healthz` 仍表示数据库及核心读取服务健康。配置或协议错误会终止进程。网页刷新是否可用由对应收藏的 availability 接口给出。

上线验收需在 Telegram iOS、Android 和 Desktop 检查入口、会话、主题、返回和视频拖动。Telegram Web 内嵌页面若被浏览器禁止第三方 Cookie，可能无法保持会话；可使用原生 Telegram 客户端。

## 独立 Telegram channel

`telegram` 与 core 共用发布镜像、使用不同入口程序。启动需 `CORE_CHANNEL_URL`（默认 `http://127.0.0.1:8081`）和 `TELEGRAM_CHANNEL_ID`；无需数据库、S3、Adapter 或服务认证凭据。Bot token 仍由数据库配置管理，经内部接口读取。更改 token、channel 或网页菜单地址后重启相应服务；菜单同步由 telegram 执行。

Compose 默认不启动 Telegram，需 `docker compose --profile telegram up -d telegram`。内部端口 8081 仅供受信任的本机或容器网络使用，不映射、不代理到公网；公共 8080 的 Bearer/Web 会话认证保持不变。关闭 channel 后，待发任务留在 core，重新启动继续领取；同一个 Bot 只部署一个轮询实例。

从合并进程升级时，先停止旧 core 与已存在的 telegram 服务，再备份、执行迁移、启动新 core，最后按需启用 telegram。迁移保留未处理 inbox、待发回复和投递批次进度，并取消旧 River 渠道任务。不要让旧 core 和新 channel 同时处理队列。渠道交付为至少一次：Telegram 接收成功但确认丢失时可能重复；已有确认的批次会跳过。

### 收藏命名迁移

`20260930030000_collection_naming.sql` 原地重命名内容表、关联字段与回收函数，保留 ID、租户归属、RLS 和内容；保留期限配置改为 `collection_retention_days`。升级前停止旧 core 和 Telegram channel，备份数据库，再执行迁移并启动新版本。

REST 客户端同步改用 `/v1/collections` 和 `collection_id`；Web 详情路由为 `#/collection/{id}`。旧路径不保留别名，core、Web 和 Telegram channel 应一起升级。历史迁移文件保持原样，以便校验已有数据库。
