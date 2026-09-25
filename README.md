# Monitor

将 X 帖子的文字和图片保存到自己的服务器，通过 Telegram 或 REST API 提交、查看和重新抓取。

- Telegram 私聊发送链接，每条消息最多 5 个帖子。
- 自动保存图片，按内容去重；重复提交可直接读取已有归档。
- 当前采集内容均为公开数据：不同用户共享同一份归档、图片及后续更新，各自的收藏列表和消息回复保持独立。
- 采集状态实时更新，支持通过按钮查看历史、翻页和重新抓取。
- 重新抓取时保留发生变化前的版本。
- 每个用户的收藏列表和存储额度独立，重启服务后归档继续保留。

## 快速启动

需要 Docker Compose 和 Python 3。在项目目录执行：

```sh
python3 scripts/configure-local-storage.py
docker compose up --build -d
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

使用已有 S3 时，`.env` 中的 `COMPOSE_FILE` 应设置为 `compose.yaml`，然后运行 `docker compose up --build -d`。

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

启动后会自动同步 Bot 命令菜单。私聊 Bot 并发送 `/start`，随后发送 X 帖子链接即可。采集完成后，消息会更新为归档结果，并回传保存的图片。

使用消息按钮可以查看归档、打开原帖、重新抓取，以及浏览历史。命令菜单和 `/help` 提供可用命令及参数说明。

使用 `/forget <归档 ID>` 取消自己的收藏并释放额度，不影响其他人的收藏。REST 对应 `DELETE /v1/archives/{id}`。

同一个 Bot 只运行一个接收者；若该 Bot 已配置 webhook，先通过 Telegram `deleteWebhook` 移除。更换 token 时保留原 Channel UUID。

支持保存文字及 JPEG、PNG、WebP 静态图片。超过图片大小或数量限制、下载失败及不支持的媒体会在结果中说明。

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
| 每帖图片数         | 20 张  |
| 每张图片大小       | 20 MiB |

存储额度按各租户收藏所引用的文字版本和图片计量，包含历史版本；同租户内重复图片只算一次。公开内容在服务器上只存一份，但每个收藏者分别计量。取消收藏只释放自己的占用，仍被自己其他收藏引用的图片继续计量。

共享更新会同步增加收藏者的用量。若被动更新导致超额，仍可读取和取消收藏，但不能新增收藏或主动采集。进行中的任务会临时预留额度。无人收藏的归档默认保留 7 天，到期且没有采集或待发送结果时才会清理；期间重新收藏会取消清理。

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
docker compose up --build -d
```

备份应同时包含 PostgreSQL、对象存储和配置文件，具体步骤见运维文档。
