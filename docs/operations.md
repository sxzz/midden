# 运维

## 部署结构

生产环境使用 `compose.yaml` 运行一个容器，镜像内含 Node.js 26 与 ffmpeg（用于缩略图和视频尺寸探测）。容器以非 root 用户运行，数据目录挂载到 `/data`。

对外访问需要 HTTPS 反向代理（例如 Cloudflare Tunnel），把整个域名转发到服务端口，至少包括 `/app/`、`/v1/`、`/media/`。Mini App 与通行密钥都要求 HTTPS。

## 网页登录

浏览器用通行密钥登录，Telegram 中的 Mini App 照旧自动登录。

- 网页可以登录的域名：`WEB_APP_URL` 的域名，加上在网页「设置 → 管理员面板 → 域名」中添加的域名。不在列表中的域名不能登录，也不能写入。
- 第一次登录：在 Telegram 私聊 Bot 发送 `/passkey`，点开要登录的域名对应的按钮，在打开的页面上创建通行密钥，创建后即已登录。链接 10 分钟内有效，只能用一次。
- 通行密钥只能在创建它的域名上使用。每个域名各需要一个：在该域名上用 `/passkey` 的链接创建，或在已登录的页面「设置 → 通行密钥」中添加。
- 通行密钥全部删除后，再发送 `/passkey` 即可添加新的。
- 新增域名：在已登录的域名上打开「设置 → 管理员面板 → 域名」，输入新域名的 https 地址添加；然后在 Telegram 发送 `/passkey`，点开新域名的按钮，在那里创建它的第一个通行密钥。
- 删除域名：同时删除这个域名的通行密钥，之前发出的这个域名的 `/passkey` 链接失效。`WEB_APP_URL` 的域名不能删除。添加和删除域名时 Bot 给所有者发一条消息。

网页也可以继续单独部署在 Cloudflare 静态托管（`pnpm --filter @midden/web run deploy`），此时代理需把同域的 `/v1/` 与 `/media/` 转发到本服务。

## 发布

- 镜像：`main` 上每次推送，`test` 工作流的 `image` 任务在检查与浏览器测试通过后在 arm64 运行器上构建 arm64 镜像（生产环境是 Apple 芯片的 Mac，只发布 arm64），发布为 `ghcr.io/sxzz/midden:latest` 和 `ghcr.io/sxzz/midden:sha-<提交>`。其他分支与 PR 只构建并做健康检查，不发布。服务器上用 `docker compose pull && docker compose up -d` 更新。
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
- 清理过期的网页会话、通行密钥挑战与 `/passkey` 链接。

## 从 Go 版迁移

2026-11-24 起生产环境运行本实现。旧的 Go 多服务版本（PostgreSQL、SeaweedFS、gRPC adapter）保存在 `golang` 分支；其数据由 `import-legacy` 分支中的导入工具（`tools/import-legacy/`）迁入 SQLite 与 `media/`，导入后会重建 `catalog`。旧版的 Bot 按钮、REST token、媒体链接不再可用。

## 排查

- `GET /healthz` 返回 `ok` 表示进程正常。
- 日志为 JSON，`job failed` 表示任务最终失败，`delivery rejected` 表示 Telegram 拒绝了某条消息。
- 抓取失败：每次尝试都有记录，自动重试不会覆盖之前的日志。`upstream request failed` 是失败的上游请求：`upstream` 中有来源（`fxtwitter`、`x-graphql`、`instagram` 等）、接口、去掉凭据与查询 token 的 URL、状态码、`retry-after` 与 `x-rate-limit-*` 等响应头、响应开头 2 KB（已遮盖 token），另有任务编号与次数、`captureId`、目标和错误分类（`errorCode`、`retryable`、`final`）。之后还会重试的为 warn，不再重试的为 error，抓取最终仍成功的为 info。`job will retry` / `job failed` 是任务每次失败的结果与耗时，`capture failed` 是抓取记录最终失败。抓关系网的任务（`jobType` 为 `relations`）带 `relationFetchId`、`list` 与 `providerId`（`fxtwitter` 或 `x-session`）；用采集账号读时，查询限流后的切换记为 `relations query rate-limited; switching to the other query`，两个查询都限流时记为 `both relations queries rate-limited; waiting for the earlier reset`。
- 日志位置：容器标准输出（`docker compose logs`，json-file 按 10 MB × 5 轮转，部署重建容器后清空），以及数据目录中的 `logs/midden.log`（按 10 MB 轮转，保留 `midden.log` 与 `.1`～`.4` 共 5 个文件，跨部署保留）。查找某个账号的失败：

  ```sh
  grep -h xiaomouzovo data/logs/midden.log* | grep -E '"level":(40|50)'
  ```

- 找不到 ffmpeg 时启动日志会提示，缩略图停用；之后装上 ffmpeg，维护任务会补做缩略图。
