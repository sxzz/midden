# Midden

将 X 帖子、Profile、图片和视频保存到自己的服务器，通过 Telegram 或 REST API 提交、查看和重新抓取。

- Telegram 私聊或群聊发送链接，每条消息最多 200 个链接。
- 自动保存图片与视频，按内容去重；重复提交可直接读取已有收藏。
- 默认通过 FxTwitter 公共 API 采集，无需配置 X 账号。公开内容共享收藏、媒体及后续更新，各自的保存列表和消息回复保持独立；个人账号获取的私密内容按租户隔离。
- 采集状态实时更新，支持通过按钮查看历史、翻页和重新抓取。
- 重新抓取时保留发生变化前的版本。
- 每个用户的保存列表和存储额度独立，重启服务后收藏继续保留。

## 快速启动

需要 Docker Compose 和 Node.js。在项目目录执行：

```sh
node scripts/configure-local-storage.mjs
docker compose pull
docker compose up -d
```

脚本生成 `.env` 和 `.local/s3.json`，配置本地数据库、服务密钥和对象存储。Compose 启动 PostgreSQL、SeaweedFS、收藏服务及 X 采集服务，自动创建存储桶。本地 S3 数据默认保存在宿主机的 `.local/seaweedfs/`，可通过 `S3_DATA_PATH` 指定其他宿主机目录。切换路径会使用目标位置的数据，已有部署需先迁移数据或明确重置。

本地对象存储配置 32 个 32 MiB 分卷，媒体容量约 1 GiB（元数据另占少量空间），不按 Docker 剩余磁盘自动扩容。

| 地址                            | 用途                       |
| ------------------------------- | -------------------------- |
| `http://127.0.0.1:8080`         | REST API                   |
| `http://127.0.0.1:9090/healthz` | 服务健康检查               |
| `http://127.0.0.1:9090/metrics` | Prometheus 指标            |
| `http://127.0.0.1:8333`         | 本地 S3 端点，需要存储凭据 |

查看运行状态：

```sh
docker compose ps
docker compose logs --tail=100 core adapter
```

数据通过本地目录挂载：PostgreSQL 使用 `.local/postgres/`，内部 TLS 证书使用 `.local/adapter-tls/`，本地 S3 默认使用 `.local/seaweedfs/`。这些目录已被 Git 忽略，`docker compose down` 和 `docker compose down -v` 均不会删除其中的数据。

从旧版 Docker 命名卷升级时，先停止服务，将原 `postgres-data`、`adapter-tls`、`s3-data` 卷中的内容复制到对应目录（保留文件权限和所有者；已自定义 S3 路径的无需迁移该目录），再启动服务。迁移并验证数据前不要运行 `docker compose down -v`，以免删除旧卷。

### 使用已有对象存储

复制 `.env.example` 为 `.env`，填写随机生成的 `POSTGRES_PASSWORD`、`APP_DB_PASSWORD`、`ADAPTER_TOKEN`，以及 S3 端点、存储桶和凭据。存储桶需提前创建，凭据需要读、写和删除对象的权限。

使用已有 S3 时，`.env` 中的 `COMPOSE_FILE` 应设置为 `compose.yaml`，然后运行 `docker compose pull` 和 `docker compose up -d`。

## 更新部署

已有数据的服务运行 `./scripts/deploy.sh --pull`：更新 Git 代码、拉取对应提交的 GHCR 镜像、停止核心、备份数据库、执行待应用迁移，成功后启动服务。镜像由 GitHub Actions 在测试通过后构建，支持 amd64 和 arm64；服务器无需编译。迁移失败时核心保持停止，数据库备份路径会显示在终端。详细备份和恢复步骤见 [运维文档](docs/operations.md)。

## 接入 Telegram

1. 通过 BotFather 创建 Bot，取得 token 和 Bot 的数字 ID（可通过 Telegram `getMe` 接口查询）。
2. 生成一个固定的 Channel UUID，并注册 Bot：

   ```sh
   docker compose run --rm --entrypoint monitorctl migrate channel-create <channel-uuid> <bot-numeric-id>
   ```

3. 将渠道 ID 和 token 保存到数据库配置。token 可通过标准输入传入，避免出现在命令参数中：

   ```sh
   docker compose run --rm --entrypoint monitorctl migrate config-set telegram_channel_id <channel-uuid>
   docker compose run --rm -T --entrypoint monitorctl migrate config-set telegram_bot_token --stdin
   ```

   第二条命令启动后输入 token，再用 Ctrl-D 结束输入。`config-list` 会将已配置的 token 显示为 `[redacted]`。

4. 在 `.env` 设置 `TELEGRAM_CHANNEL_ID=<channel-uuid>`，然后显式启动渠道：

   ```sh
   docker compose up -d --force-recreate core
   docker compose --profile telegram up -d telegram
   ```

群聊中必须 @Bot 才会响应，例如 `@Bot用户名 帖子链接` 或 `/usage@Bot用户名`；直接发送链接、无指向的命令或仅回复 Bot 消息不会触发。已有交互按钮仍可直接点击。

群聊和私聊都可使用 `/save <帖子或 Profile 链接…>`，每次最多 200 个链接；群聊菜单提供 `/save`，`/start` 仅用于私聊。

启动后会自动同步 Bot 命令菜单。私聊 Bot 并发送 `/start`，随后发送 X 帖子链接即可。采集完成后，有媒体的收藏以图片、视频或混合相册发送，正文作为说明；说明放不下时，先发送全部媒体，再将剩余文字另发消息。纯文字收藏直接发送文字。

群聊按发消息的人分别管理保存记录和额度，与其私聊数据共用；按钮仅限发起者操作，公开收藏的「我也要存」除外：其他群员可直接保存同一份内容，仅通过 toast 提示结果，不重新采集或在群内发消息。群聊不提供 `/list` 和收藏列表入口，请在私聊中查看列表；`/show` 等其他命令可正常使用。群内回复会关联触发消息，点击按钮产生的新回复会关联被点击的 Bot 消息。普通聊天不会触发回复。将 Bot 隐私模式关闭，或将 Bot 设为管理员，即可接收群内普通链接消息；匿名身份消息不受支持。

使用消息按钮可以查看收藏、打开原帖、重新抓取，以及浏览历史。命令菜单和 `/help` 提供可用命令及参数说明。

收藏内容消息以等宽代码显示收藏 ID，可复制后用于 `/show <收藏 ID>`。帖文作者名链接到已保存的 Profile，正文以引用格式显示；无正文时显示普通文本「空」。Profile 详情单独显示头像、链接到主页的名字、@handle 和普通文本简介。私聊使用 `/list` 查看收藏列表，通过按钮查看收藏或原帖。

使用 `/delete_all` 并确认，可删除自己的全部保存记录，释放对应占用；共享内容仍按保留期清理，不影响其他人的保存记录。

使用 `/delete <收藏 ID>` 删除自己保存的收藏并释放额度，不影响其他人保存的收藏。REST 对应 `DELETE /v1/collections/{id}`。

`core` 默认只运行 Web/API 和后台采集。`telegram` 是可选独立进程，只通过内部 HTTP API 访问 core；停止它不会影响网页访问、登录签名校验或采集任务。core 与 channel 之间不使用服务认证，内部端口 8081 不映射、不代理到公网。详见 [渠道协议](docs/channel-api.md)。

同一个 Bot 只运行一个接收者；若该 Bot 已配置 webhook，先通过 Telegram `deleteWebhook` 移除。更换 token 时保留原 Channel UUID。

支持保存文字、JPEG／PNG／WebP 静态图片及 MP4／WebM 视频（包括 X 的 GIF 动画）。超过媒体大小或数量限制、下载失败及不支持的媒体会在结果中说明。

发送 X Profile 链接会更新该用户的资料，并连续翻页采集约 100 条帖子，回复会持续显示已保存、内容不完整、失败和进行中数量。抓取过程中可点击「中止」，停止后续翻页和任务派发；已经提交的任务会完成收尾，已保存内容保留。首次请求和「抓取更多」均使用 count=100，内部连续翻页直到累计至少 100 条或到达末尾；最后一页完整保留，实际条数可能超过 100。公开账号始终使用 FxTwitter 公共实例，即使已选择采集账号；受保护账号的帖子使用所选采集账号。公开账号另有「抓取1000条」，从当前进度分批继续，累计约 1000 条或到达末尾，最后一页完整保留，统一显示进度。帖子分别保存为收藏，后台任务沿用当前账号及配额，不逐条发送完成消息。Profile 按稳定用户 ID 收藏，改名后继续保留在同一记录中。每次 Profile 批次都会重新检查本批次中的已有帖子，并重试缺失媒体；帖子图片和视频按媒体 ID 复用成功缓存（缺少 ID 时按完整 URL）；头像和主页封面按完整 URL 复用，只有未命中成功缓存时才下载。内容变化时保留新版本。部分保存或失败时汇总具体原因，相同原因只显示一次并标注受影响条数；单条收藏保留对应原因详情。

Profile 资料始终从公共实例获取。采集帖子前先读取作者 Profile，再按 protected 状态选择公共实例或已配置账号；距离上次成功采集不足一分钟则跳过。直接提交 Profile 链接始终更新，不受此间隔限制。Profile 及时间线接口的完整原始响应随采集保存；账号接口的原始响应保持私有。时间线读取失败时，Profile 仍会保存并显示缺失说明，可点击「重试本页」重试。

收藏同时保存作者 ID、用户名、昵称、简介等 Profile metadata、头像文件、帖子发布时间和可确定的编辑时间。完整上游 JSON 响应按每次采集保留，个人账号响应只对本人可见。历史收藏需要重新抓取才能补齐新增字段；上游未提供且无法确定的信息留空。

## Telegram 收藏网页

收藏网页使用 Vue Vapor，提供手机帖子流、正文与作者搜索、媒体和可见性筛选、保存日期范围、历史版本、重新抓取、删除及存储用量。首次登录从 Telegram 进入，与 Bot 共用保存记录和额度；独立浏览器登录暂未开放。

网页通过 Cloudflare Workers Static Assets 单独发布，`/app/*` 由 Cloudflare 直接提供静态资源，不执行 Worker 脚本。core 镜像不包含网页。将 core 的 8080 端口通过 HTTPS 反向代理或 Cloudflare Tunnel 公开，保留同域 `/v1/*` 指向 core；只为 `/app/*` 设置 Workers Route。具体发布配置见 [静态网页部署](docs/operations.md#cloudflare-静态网页部署)。设置公开地址后重启 core：

```sh
docker compose run --rm --entrypoint monitorctl migrate config-set web_app_url https://collection.example.com/app/
docker compose up -d --force-recreate core
```

启用的 `telegram` 服务也需重启以同步菜单。Bot 私聊菜单和 `/start` 消息会提供「打开」。在 BotFather 中按客户端要求配置该 HTTPS 域名。将 `web_app_url` 设置为空字符串并重启可关闭网页登录和入口，恢复命令菜单。会话有效期 12 小时，到期后从 Bot 重新打开。

图片在网页内放大查看，视频支持分段读取；浏览器无法播放的原文件可下载。日期筛选使用设备本地日期，筛选的是保存时间。网页只访问自己的收藏；删除后不能继续通过网页访问其历史和媒体。

## 可选：使用个人 X 账号

不配置个人账号也能使用全部公共收藏功能，无需运营者准备账号池或自部署 FxEmbed。

需要使用个人账号时，先由管理员按[账号接入说明](docs/operations.md#个人账号接入)配置加密密钥。在 Bot 私聊的 `/account` 列表点击对应平台的“添加账号”。也可以发送 `/account_add`，选择平台后按提示直接发送凭据。X 使用含 `auth_token` 和 `ct0` 的 Base64 Cookie。交互仅限私聊，10 分钟内有效，可点击“取消添加”。重复添加同一平台账号会更新原记录的凭据，保留内部 ID。验证成功后自动选中该账号，其他 Adapter 的选择不变；可使用 `/account` 切换账号，或选择“公共来源”继续使用 FxTwitter 公共 API。每个 Adapter 独立选择公共来源或一个账号，不同平台的账号可同时使用。选择在同一用户的私聊和群聊中通用，只影响新提交；重新抓取沿用该保存记录原来的来源。

在私聊 `/account` 列表点击账号旁的“删除”，或使用 `/account_delete`，确认后移除采集凭据。已有收藏保留；删除当前账号后，新保存使用公共来源，原有账号任务与重新采集不会自动切换来源。

群聊和私聊均可保存、展示个人账号可访问的私密收藏。私密收藏的保存记录只属于发起者，但发送到群内的消息可由群成员看到；“我也要存”仅出现在公开收藏上。账号失效时需重新导入会话，系统不会自动改用其他账号或公共 API。

管理员可为租户启用“不限额”身份，同一租户的所有渠道身份共享此设置：

```sh
docker compose run --rm --entrypoint monitorctl migrate tenant-unlimited <tenant-uuid> on
# 恢复普通限制
docker compose run --rm --entrypoint monitorctl migrate tenant-unlimited <tenant-uuid> off
```

不限额租户跳过采集频率、租户采集并发和存储配额检查，仍记录实际用量；账号并发、全局 Worker 数量、单文件大小和上游限制继续生效。Telegram 的 `/usage` 会显示“不限额”。REST 用量响应的 `unlimited=true` 表示 `limit_bytes` 不生效。

## 使用 REST API

创建租户及访问 token：

```sh
docker compose run --rm --entrypoint monitorctl migrate tenant-create
docker compose run --rm --entrypoint monitorctl migrate token-create <tenant-uuid>
```

token 明文只显示一次，请妥善保存。将其设置为 `MONITOR_TOKEN` 环境变量，提交采集：

```sh
curl -H "Authorization: Bearer $MONITOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: my-first-capture' \
  -d '{"url":"https://x.com/<username>/status/<post-id>"}' \
  http://127.0.0.1:8080/v1/captures
```

用实际帖子 URL 替换示例。响应包含任务 ID，可通过 `GET /v1/jobs/{id}` 查询状态。收藏列表使用 `GET /v1/collections`，收藏详情使用 `GET /v1/collections/{id}`。

完整接口、参数和响应结构见 [API 文档](docs/openapi.yaml)。

## 默认限额

| 项目               | 默认值  |
| ------------------ | ------- |
| 每租户存储空间     | 1 GiB   |
| 每租户每分钟新采集 | 10 次   |
| 每租户同时采集     | 2 个    |
| 每帖媒体数         | 20 个   |
| 每张图片大小       | 20 MiB  |
| 每个视频大小       | 512 MiB |

存储额度按各租户保存的收藏所引用的文字版本和媒体计量，包含历史版本；同租户内重复媒体只算一次。公开内容在服务器上只存一份，但每个保存者分别计量。删除只释放自己的占用，仍被自己其他保存记录引用的媒体继续计量。

共享更新会同步增加保存者的用量。若被动更新导致超额，仍可读取和删除，但不能新增保存或主动采集。进行中的任务会临时预留额度。无人保存的收藏默认保留 7 天，到期且没有采集或待发送结果时才会清理；期间重新保存会取消清理。

保留天数、额度和并发等运行参数保存在数据库 `config` 表中。查看配置或将保留期改为 30 天：

```sh
docker compose run --rm --entrypoint monitorctl migrate config-list
docker compose run --rm --entrypoint monitorctl migrate config-set collection_retention_days 30
```

保留期修改在下一次清理时生效，无需重启。其他运行参数及 Telegram 配置修改后重启核心。数据库、S3、Adapter 的启动连接配置和凭据通过环境变量提供。

## 管理与维护

- [运维文档](docs/operations.md)：配置、限额、监控、备份和恢复。
- [服务架构与数据库](docs/architecture.md)：组件、处理流程和数据关系。
- [开发指南](CONTRIBUTING.md)：构建、测试和扩展命令。

更新服务：

```sh
docker compose pull
docker compose up -d
```

备份应同时包含 PostgreSQL、对象存储和配置文件，具体步骤见运维文档。

视频保存最高分辨率、同分辨率最高码率的 MP4／WebM 版本。`max_video_bytes`、`max_image_bytes` 和 `max_media` 可通过配置命令调整；超过 Telegram 50 MB 回传限制的文件仍可保存，通过 API 下载。

媒体的 `altText` 会随收藏保存，并附在 Telegram 预览中。视频按平台媒体 ID 与文件规格缓存，同一作用域内刷新或其他帖子引用同一视频时直接复用；不同规格和私有访问范围分别缓存。文件仍按 SHA-256 去重。

Telegram 会复用同一 Bot 已上传的媒体，减少重复上传。来源标记为敏感的图片和视频会以 spoiler 遮罩发送；文件形式正常发送，不添加遮罩。

## 许可证

[MIT](LICENSE)。第三方代码保留其原有许可证与版权声明。
