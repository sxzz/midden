# 运维

## 部署结构

生产环境使用 `compose.yaml` 运行一个容器，镜像内含 Node.js 26 与 ffmpeg（用于缩略图和视频尺寸探测）。容器以非 root 用户运行，数据目录挂载到 `/data`。

对外访问需要 HTTPS 反向代理（例如 Cloudflare Tunnel），把整个域名转发到服务端口，至少包括 `/app/`、`/v1/`、`/media/`。Mini App 与 Telegram 登录都要求 HTTPS。

网页也可以继续单独部署在 Cloudflare 静态托管（`pnpm --filter @midden/web run deploy`），此时代理需把同域的 `/v1/` 与 `/media/` 转发到本服务。

## 发布

- 镜像：`main` 上每次推送，`test` 工作流的 `image` 任务在检查与浏览器测试通过后构建 amd64 与 arm64 镜像，发布为 `ghcr.io/sxzz/midden:latest` 和 `ghcr.io/sxzz/midden:sha-<提交>`。其他分支与 PR 只构建并做健康检查，不发布。服务器上用 `docker compose pull && docker compose up -d` 更新。
- 网页：`test` 在 `main` 上通过后，`web` 工作流把网页部署到 Cloudflare 静态托管（仓库变量 `MIDDEN_WEB_HOSTNAME` 指定域名，路由 `<域名>/app/*`）。

## 日常操作

```sh
docker compose ps
docker compose logs --tail=100 midden
docker compose pull && docker compose up -d   # 更新
```

数据库迁移在启动时自动应用；随后补齐收藏列表的索引表 `catalog` 中缺失的行（首次部署或导入数据后可能需要几秒）。

## 自动部署

`main` 的 test 工作流通过后会发布镜像 `ghcr.io/sxzz/midden:latest` 与 `:sha-<提交>`。部署机上的 webhook 收到这次运行完成的事件后，从 `origin/main` 取出 `scripts/deploy.ts` 执行：

1. 确认部署目录（默认 `~/midden`）没有本地改动，最新镜像的提交在 `origin/main` 上，且与正在运行的版本不同；
2. 在线备份数据库到 `data/backups/deploy/`（保留最近 5 份）；
3. 切换到该提交，用 `:sha-<提交>` 镜像 `docker compose up -d --wait`，并检查 `/healthz`；
4. 新版本不健康时停掉它，恢复部署前的数据库，切回原来的版本。

结果通过 Bot 发给 `DEPLOY_NOTIFY_CHAT_ID`（默认 `OWNER_TELEGRAM_ID`），日志在 `.local/deploy-webhook/`。也可以手动运行：

```sh
node scripts/deploy.ts --check   # 只检查，不改动
node scripts/deploy.ts
```

安装 webhook（macOS LaunchAgent，复制到 `~/.local/share/midden/`，监听 `127.0.0.1:18090/hooks/deploy`）：

```sh
node scripts/install-deploy-webhook.ts --dir ~/midden
```

GitHub 仓库的 webhook 发送 Workflow runs 事件到 `https://<域名>/hooks/deploy`，密钥与 `.local/deploy-webhook.secret` 相同；隧道把该路径转发到 18090 端口。升级 Node 后重新运行安装命令。

## 备份与恢复

需要备份的是数据目录与 `.env`（其中的 `SECRET_KEY` 用于解密账号凭据）。

1. 数据库：服务运行中即可做一致的在线备份：

   ```sh
   docker compose exec midden node server/src/cli.ts backup /data/backups
   ```

2. 媒体：`media/` 中的文件写入后不再修改，增量复制即可：

   ```sh
   rsync -a data/media/ <备份位置>/media/
   ```

### 自动备份

`scripts/backup.ts` 每天备份一次：

- 数据库：服务在线备份，检查完整性后 gzip 压缩，与 `.env` 及当前提交一起存到 `<目标>/daily/<时间>/`，保留 7 天（最新一份总是保留）；
- 媒体：`rsync` 增量镜像到 `<目标>/media/`，不删除；
- 部署进行中时等部署结束；失败时通过 Bot 通知 `DEPLOY_NOTIFY_CHAT_ID`（默认 `OWNER_TELEGRAM_ID`）。

目标默认 `~/backups/midden/auto`。安装为每天 12:00 运行的 LaunchAgent，直接运行部署目录里的脚本，随部署更新：

```sh
node scripts/install-backup.ts --dir ~/midden            # --to <目标> --at HH:MM
launchctl kickstart gui/$(id -u)/org.midden.backup      # 立即运行一次
```

日志在 `.local/backup/`。升级 Node 后重新运行安装命令。

### 恢复

恢复时停止服务，将备份的数据库文件放回 `data/midden.db`（自动备份的 `midden.db.gz` 先 `gunzip`），删除旁边的 `midden.db-wal` 与 `midden.db-shm`，媒体放回 `data/media/`，使用原来的 `SECRET_KEY` 启动。

数据库与媒体分别备份时，可能有少量新媒体在数据库备份中尚未出现（无害），或数据库引用了刚被回收的旧媒体；后者在维护时会被清理。需要严格一致时，先 `docker compose stop` 再备份。

## 维护任务

服务每分钟运行一次维护：

- 超过 1 小时仍未完成且没有对应任务的抓取标记为中断；
- 删除不再保存、也没有进行中抓取的收藏及其独有内容；
- 原始响应保留 7 天；没有产生新版本、也不是最新一次的抓取，其原始响应随后删除；
- 不再被引用的媒体文件 24 小时后删除；
- 为缺少缩略图的媒体补做缩略图；
- 清理过期的网页会话。

## 从 Go 版迁移

2026-11-24 起生产环境运行本实现。旧的 Go 多服务版本（PostgreSQL、SeaweedFS、gRPC adapter）保存在 `golang` 分支；其数据由 `import-legacy` 分支中的导入工具（`tools/import-legacy/`）迁入 SQLite 与 `media/`，导入后会重建 `catalog`。旧版的 Bot 按钮、REST token、媒体链接不再可用。

## 排查

- `GET /healthz` 返回 `ok` 表示进程正常。
- 日志为 JSON，`job failed` 表示任务最终失败，`delivery rejected` 表示 Telegram 拒绝了某条消息。
- 找不到 ffmpeg 时启动日志会提示，缩略图停用；之后装上 ffmpeg，维护任务会补做缩略图。
