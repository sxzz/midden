# Midden

将 X 与 Instagram 的帖子、Profile、图片和视频保存到自己的服务器，通过 Telegram、网页或 REST API 提交和查看。只供一位所有者使用。

- 在 Telegram 私聊 Bot 发送链接即可保存，每条消息最多 200 个链接；群聊中需 @Bot。
- 自动下载图片与视频，按内容去重；重新抓取时保留内容变化前的版本。
- X 默认通过 FxTwitter 公共接口采集，无需账号；也可添加自己的 X 账号。Instagram 需要添加自己的账号。
- Profile 会连同时间线中的帖子一起保存，可按条件筛选、继续翻页或中止。
- 网页（含 Telegram Mini App）用于浏览、筛选、批量更新、标签与备注、管理采集账号。

所有数据保存在一个目录中：SQLite 数据库 `midden.db` 和按内容哈希存放的 `media/`。

## 部署

需要 Docker Compose。在一个空目录中放入本仓库的 `compose.yaml`，并按 `.env.example` 创建 `.env`：

```sh
cp .env.example .env
# 填写 SECRET_KEY（至少 32 个随机字符，例如 openssl rand -base64 48）
docker compose up -d
```

服务监听本机 `127.0.0.1:8080`：

| 路径 | 用途 |
| --- | --- |
| `/app/` | 网页 |
| `/v1/` | REST API |
| `/media/` | 签名的媒体链接 |
| `/healthz` | 健康检查 |

数据保存在 `./data`（可用 `DATA_PATH` 修改）。`SECRET_KEY` 用于加密已保存的账号凭据和签名媒体链接：务必与数据一起备份，更换后已保存的账号需要重新添加。

### 配置

| 变量 | 说明 |
| --- | --- |
| `SECRET_KEY` | 必填，见上 |
| `TELEGRAM_BOT_TOKEN`、`OWNER_TELEGRAM_ID` | Telegram Bot 的 token 与所有者的用户 ID，需同时设置；不设置则不启动 Bot，网页也无法登录 |
| `WEB_APP_URL` | 网页的公开 HTTPS 地址，以 `/app/` 结尾；设置后才能用 Telegram 登录网页 |
| `DATA_PATH` | 宿主机上的数据目录，默认 `./data` |
| `PORT` | 宿主机端口，默认 `8080` |
| `LOG_LEVEL` | 日志级别，默认 `info` |

### 接入 Telegram

1. 通过 BotFather 创建 Bot，取得 token；通过 [@userinfobot](https://t.me/userinfobot) 等方式查到自己的用户 ID。
2. 填入 `TELEGRAM_BOT_TOKEN` 和 `OWNER_TELEGRAM_ID`，重新启动：`docker compose up -d`。
3. 网页需通过 HTTPS 对外提供（例如 Cloudflare Tunnel，把整个域名转发到本服务），并设置 `WEB_APP_URL`。在 BotFather 中对 Bot 执行 `/setdomain`，填入该域名，浏览器中才会出现 Telegram 登录按钮。

Bot 只回应所有者：私聊中直接发送链接或命令；群聊中需 @Bot 或使用 `/命令@Bot`，其他成员的消息和按钮一律忽略。命令菜单会在启动时自动同步，`/help` 查看说明。

### REST API

REST API 使用 Bearer token：

```sh
docker compose exec midden node server/src/cli.ts token create 脚本名称
```

token 只显示这一次。例如保存一个链接：

```sh
curl -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"url":"https://x.com/jack/status/20"}' http://127.0.0.1:8080/v1/captures
```

### 更新与备份

```sh
docker compose pull && docker compose up -d
```

备份数据库（服务运行中即可）：

```sh
docker compose exec midden node server/src/cli.ts backup /data/backups
```

媒体文件写入后不再修改，用 `rsync` 等工具增量复制 `data/media/` 即可。详见 [运维文档](docs/operations.md)。

## 开发

见 [CONTRIBUTING.md](CONTRIBUTING.md)。架构说明见 [docs/architecture.md](docs/architecture.md)。

旧的 Go 多服务实现保存在 `golang` 分支。
