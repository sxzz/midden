# Midden

将 X 帖子的文字、图片和视频保存到自己的服务器，通过 Telegram 或 REST API 提交、查看和重新抓取。

- Telegram 私聊或群聊发送链接，每条消息最多 200 个帖子。
- 自动保存图片与视频，按内容去重；重复提交可直接读取已有归档。
- 默认通过 FxTwitter 公共 API 采集，无需配置 X 账号。公开内容共享归档、媒体及后续更新，各自的保存列表和消息回复保持独立；个人账号获取的私密内容按租户隔离。
- 采集状态实时更新，支持通过按钮查看历史、翻页和重新抓取。
- 重新抓取时保留发生变化前的版本。
- 每个用户的保存列表和存储额度独立，重启服务后归档继续保留。

## 快速启动

需要 Docker Compose 和 Python 3。在项目目录执行：

```sh
python3 scripts/configure-local-storage.py
docker compose pull
docker compose up -d
```

脚本生成 `.env` 和 `.local/s3.json`，配置本地数据库、服务密钥和对象存储。Compose 启动 PostgreSQL、SeaweedFS、归档服务及 X 采集服务，自动创建存储桶。

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

数据保存在 Docker 数据卷中。`docker compose down` 停止服务并保留数据；`docker compose down -v` 会删除数据卷。

### 使用已有对象存储

复制 `.env.example` 为 `.env`，填写随机生成的 `POSTGRES_PASSWORD`、`APP_DB_PASSWORD`、`ADAPTER_TOKEN`，以及 S3 端点、存储桶和凭据。存储桶需提前创建，凭据需要读、写和删除对象的权限。

使用已有 S3 时，`.env` 中的 `COMPOSE_FILE` 应设置为 `compose.yaml`，然后运行 `docker compose pull
docker compose up -d`。

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

4. 更新服务：

   ```sh
   docker compose up -d --force-recreate core
   ```

群聊中必须 @Bot 才会响应，例如 `@Bot用户名 帖子链接` 或 `/usage@Bot用户名`；直接发送链接、无指向的命令或仅回复 Bot 消息不会触发。已有交互按钮仍可直接点击。

群聊和私聊都可使用 `/save <帖子链接…>`，每次最多 200 个帖子；群聊菜单提供 `/save`，`/start` 仅用于私聊。

启动后会自动同步 Bot 命令菜单。私聊 Bot 并发送 `/start`，随后发送 X 帖子链接即可。采集完成后，有媒体的归档以图片、视频或混合相册发送，正文作为说明；说明放不下时，先发送全部媒体，再将剩余文字另发消息。纯文字归档直接发送文字。

群聊按发消息的人分别管理保存记录和额度，与其私聊数据共用；按钮仅限发起者操作，公开归档的「我也要存」除外：其他群员可直接保存同一份内容，仅通过 toast 提示结果，不重新采集或在群内发消息。群聊不提供 `/recent` 和最近归档入口，请在私聊中查看列表；`/show` 等其他命令可正常使用。群内回复会关联触发消息，点击按钮产生的新回复会关联被点击的 Bot 消息。普通聊天不会触发回复。将 Bot 隐私模式关闭，或将 Bot 设为管理员，即可接收群内普通链接消息；匿名身份消息不受支持。

使用消息按钮可以查看归档、打开原帖、重新抓取，以及浏览历史。命令菜单和 `/help` 提供可用命令及参数说明。

归档内容消息以等宽代码显示归档 ID，可复制后用于 `/show <归档 ID>`。私聊的最近归档列表提供查看按钮及可复制的 `/show` 命令。

使用 `/delete_all` 并确认，可删除自己的全部保存记录，释放对应占用；共享内容仍按保留期清理，不影响其他人的保存记录。

使用 `/delete <归档 ID>` 删除自己保存的归档并释放额度，不影响其他人保存的归档。REST 对应 `DELETE /v1/archives/{id}`。

同一个 Bot 只运行一个接收者；若该 Bot 已配置 webhook，先通过 Telegram `deleteWebhook` 移除。更换 token 时保留原 Channel UUID。

支持保存文字、JPEG／PNG／WebP 静态图片及 MP4／WebM 视频（包括 X 的 GIF 动画）。超过媒体大小或数量限制、下载失败及不支持的媒体会在结果中说明。

归档同时保存作者 ID、用户名、昵称、简介等 Profile metadata、头像文件、帖子发布时间和可确定的编辑时间。完整上游 JSON 响应按每次采集保留，个人账号响应只对本人可见。历史归档需要重新抓取才能补齐新增字段；上游未提供且无法确定的信息留空。

## 可选：使用个人 X 账号

不配置个人账号也能使用全部公共归档功能，无需运营者准备账号池或自部署 FxEmbed。

需要使用个人账号时，先由管理员按[账号接入说明](docs/operations.md#个人账号接入)配置加密密钥。在 Bot 私聊发送 `/account_add <Base64 Cookie> [名称]`，Cookie 需包含 `auth_token` 和 `ct0`。验证成功后点击“使用此账号”，或使用 `/account` 选择该账号，或选择“公共来源”继续使用 FxTwitter 公共 API。选择在同一用户的私聊和群聊中通用，只影响新提交；重新抓取沿用该保存记录原来的来源。

群聊和私聊均可保存、展示个人账号可访问的私密归档。私密归档的保存记录只属于发起者，但发送到群内的消息可由群成员看到；“我也要存”仅出现在公开归档上。账号失效时需重新导入会话，系统不会自动改用其他账号或公共 API。

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

用实际帖子 URL 替换示例。响应包含任务 ID，可通过 `GET /v1/jobs/{id}` 查询状态。归档列表使用 `GET /v1/archives`，归档详情使用 `GET /v1/archives/{id}`。

完整接口、参数和响应结构见 [API 文档](docs/openapi.yaml)。

## 默认限额

| 项目               | 默认值 |
| ------------------ | ------ |
| 每租户存储空间     | 1 GiB  |
| 每租户每分钟新采集 | 10 次  |
| 每租户同时采集     | 2 个   |
| 每帖媒体数         | 20 个  |
| 每张图片大小       | 20 MiB |
| 每个视频大小       | 512 MiB |

存储额度按各租户保存的归档所引用的文字版本和媒体计量，包含历史版本；同租户内重复媒体只算一次。公开内容在服务器上只存一份，但每个保存者分别计量。删除只释放自己的占用，仍被自己其他保存记录引用的媒体继续计量。

共享更新会同步增加保存者的用量。若被动更新导致超额，仍可读取和删除，但不能新增保存或主动采集。进行中的任务会临时预留额度。无人保存的归档默认保留 7 天，到期且没有采集或待发送结果时才会清理；期间重新保存会取消清理。

保留天数、额度和并发等运行参数保存在数据库 `config` 表中。查看配置或将保留期改为 30 天：

```sh
docker compose run --rm --entrypoint monitorctl migrate config-list
docker compose run --rm --entrypoint monitorctl migrate config-set archive_retention_days 30
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

媒体的 `altText` 会随归档保存，并附在 Telegram 预览中。视频按平台媒体 ID 与文件规格缓存，同一作用域内刷新或其他帖子引用同一视频时直接复用；不同规格和私有访问范围分别缓存。文件仍按 SHA-256 去重。

Telegram 会复用同一 Bot 已上传的媒体，减少重复上传。来源标记为敏感的图片和视频会以 spoiler 遮罩发送；文件形式正常发送，不添加遮罩。

## 许可证

[MIT](LICENSE)。第三方代码保留其原有许可证与版权声明。
