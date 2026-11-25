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

## 媒体存储（Cloudflare R2）

默认 `MEDIA_STORE=local`：媒体只在数据目录的 `media/` 中，网页通过本服务的签名链接 `/media/…` 读取。设为 `r2` 后：

- 原文件（图片、视频）另存到 R2 存储桶，对象键与本地路径相同：`ab/cd/<sha256>`。浏览器直接从公开域名读取 `MEDIA_PUBLIC_URL/ab/cd/<sha256>`（`https://midden-media.sxzz.moe/ab/cd/<sha256>`），由 Cloudflare 边缘缓存；每个对象都带 `Content-Type` 与 `Cache-Control: public, max-age=31536000, immutable`。
- 新下载先写入本地 `media/`，再由后台任务 `upload` 上传。上传带 `Content-MD5` 和签名的 SHA-256，R2 收到的内容不符会拒绝；上传后读回大小、ETag（即 MD5）和两个响应头，确认后才在 `blobs.remote_at` 记下，接口从此给出公开地址，之前仍给本地签名链接。上传失败从 30 秒起翻倍重试、最长间隔 1 小时，共 12 次（约 7 小时），每次记 `job will retry`，放弃时记 `media upload gave up; the file stays local`，这些媒体由 `media-migrate` 补传。
- 上传后本地文件保留，直到运行 `media-prune-local`。
- 缩略图只存本地，作为缓存，经本服务提供，响应头为 `Cache-Control: public, max-age=31536000, immutable`（图片同样；视频和带文件名的下载仍为 `private`，不进 CDN）。缩略图文件丢失时，请求它的 `/media/…` 当场从原文件重新生成：原文件在本地就读本地，否则 ffmpeg 通过预签名 URL 只读取需要的字节范围。生成的字节不同（例如换了 ffmpeg）时记在新的键下，并把请求重定向过去。
- 带文件名的下载经本服务从本地或 R2 流式返回，带 `Content-Disposition`。服务端的读取（Telegram 发送、缩略图、下载）都先读本地，没有时通过 S3 API 读 R2，不经公开域名。
- 不另设本地原文件缓存：新媒体在本地保留到 prune，缩略图在下载时就从本地文件生成，Telegram 按 `file_id` 复用已上传的文件，只有缩略图丢失、下载和第一次发送旧媒体时才读 R2，视频只读部分字节。
- 删除：不再被引用的媒体（删除收藏、删除媒体）24 小时后删除本地文件；R2 中有对象时先清除其公开地址的边缘缓存（`purge_cache`），再删除对象。清除失败时对象保留，稍后重试；没有配置清除用的 token 时记 `cache purge skipped: no purge token configured` 并跳过清除。
- 存储类别为存储桶默认的 Standard。

### 配置

| 变量                                       | 说明                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `MEDIA_STORE`                              | `local`（默认）或 `r2`                                                                 |
| `R2_ACCOUNT_ID`                            | Cloudflare 账户 ID（32 位十六进制）；S3 端点为 `https://<ID>.r2.cloudflarestorage.com` |
| `R2_BUCKET`                                | 存储桶名，如 `midden`                                                                  |
| `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY` | R2 API token 的访问密钥                                                                |
| `MEDIA_PUBLIC_URL`                         | 存储桶的公开域名，如 `https://midden-media.sxzz.moe`                                   |
| `CF_ZONE_ID`、`CF_PURGE_TOKEN`             | 公开域名所在 zone 的 ID 和清除缓存的 token，需同时设置；不设置则删除时不清除边缘缓存   |

`MEDIA_STORE=r2` 时前五项必填，缺少时启动失败并列出缺少的变量；错误信息不含密钥。启动日志 `media store` 写明当前的 `store`。

### Cloudflare

已配置：存储桶 `midden` 绑定自定义域名 `midden-media.sxzz.moe`；该域名的 Cache Rule（Edge TTL 忽略源站、1 年，300–526 不缓存，Browser TTL 遵循源站，缓存键忽略查询串）；Response Header Transform Rule 给所有响应（包括缓存命中）加 `Access-Control-Allow-Origin: *`。

还需要：

1. Smart Tiered Cache：`sxzz.moe` zone →「Caching → Tiered Cache」，选 Smart Tiered Caching。边缘未命中时先问上层节点，减少回源 R2 的读取次数。
2. R2 API token：「R2 → Manage API tokens → Create API token」，权限 **Object Read & Write**，范围只选存储桶 `midden`（不需要 Admin 权限）。得到的 Access Key ID 与 Secret Access Key 填入 `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`；rclone 也用这一对。
3. 清除缓存的 token：「My Profile → API Tokens → Create Custom Token」，权限 **Zone → Cache Purge → Purge**，Zone Resources 为 Include → Specific zone → `sxzz.moe`。填入 `CF_PURGE_TOKEN`；zone 的 Overview 页右侧的 Zone ID 填入 `CF_ZONE_ID`。
4. 缩略图的边缘缓存（可选）：在应用所在域名加一条 Cache Rule，匹配路径以 `/media/` 开头，Eligible for cache，Edge TTL 选「Use cache-control header if present」，这样 `private` 的视频与下载不进缓存；缓存键保留查询串（签名在其中）。

### 迁移现有媒体

`media-migrate` 处理所有尚未记为在 R2 中的媒体（`blobs` 中的原文件，不含缩略图）：

1. 计算本地文件的 SHA-256 与 MD5，SHA-256 与键不符时报告 `hash mismatch` 并跳过，不上传。
2. 读取 R2 中同键对象的大小和响应头（HEAD）：
   - 不存在，或大小不同：上传，读回确认。
   - 大小相同：用对象带的校验值与本地比较，依次是 `x-amz-checksum-sha256`、ETag（单段上传时即 MD5；分段上传的 ETag 带 `-<段数>`，不能用）、rclone 为分段上传记下的 `x-amz-meta-md5chksum`。有一项不符就重新上传；都相符则保留，不重新传输。一项都没有时只能按大小认定（汇总中记为 `by size`）；加 `--verify-download` 则下载并计算 SHA-256。
   - 保留的对象 `Content-Type` 或 `Cache-Control` 不对时，在服务端把对象复制到自身（`CopyObject`，`x-amz-metadata-directive: REPLACE`）改正，其他元数据照旧，不重新传输，再读回确认。
3. 在 `blobs.remote_at` 记下，网页从此使用公开地址。

本地文件缺失时，只有加 `--verify-download` 且 R2 中的对象哈希相符才记下，否则报告 `missing locally`。从不删除本地文件；可以随时中断，再次运行时跳过已记下的，其余重新检查，已上传但未记下的按校验值保留。`--concurrency N`（默认 4）同时处理的数量，`--limit N` 只处理前 N 个。每 5 秒输出一次进度，结束时输出汇总，并给出一个已记下媒体的公开地址；有失败、哈希不符或缺失时退出码为 1。R2 中不属于任何媒体的对象（如 rclone 一并复制的缩略图）不会被读取或修改；它们的键以后被回收时随之删除。

`media-prune-local` 删除已记为在 R2 中、且再次确认过的本地原文件：对象存在，大小、`Content-Type`、`Cache-Control` 正确，并且上述校验值之一与本地文件相符（或加 `--verify-download` 后下载比较）。没有校验值的对象保留本地文件并列出；对象不对时保留本地文件、清除 `remote_at`（网页改回本地链接，下次 `media-migrate` 重新上传）。缩略图（包括同时是缩略图的原文件）一律保留。新媒体上传后同样留在本地，可以定期再运行一次。

预先用 rclone 复制（可选，代码上线前即可进行）：

```ini
# ~/.config/rclone/rclone.conf
[r2]
type = s3
provider = Cloudflare
access_key_id = <R2_ACCESS_KEY_ID>
secret_access_key = <R2_SECRET_ACCESS_KEY>
endpoint = https://9183b1c394e4cd2f0a7d3c978bc53a29.r2.cloudflarestorage.com
region = auto
no_check_bucket = true
```

```sh
rclone copy ~/midden/data/media r2:midden \
  --header-upload "Cache-Control: public, max-age=31536000, immutable" \
  --s3-upload-cutoff 4Gi --checksum \
  --transfers 16 --checkers 32 --progress
```

- 必须是 `media/` 目录本身对应存储桶根目录，键才是 `ab/cd/<sha256>`；用 `copy`，不要用 `sync`。
- `--s3-upload-cutoff 4Gi`：4 GiB 以下单段上传，ETag 就是 MD5，`media-migrate` 不必下载即可核对内容。不要加 `--s3-disable-checksum`，否则分段上传的文件没有 `md5chksum`。
- `--checksum`：rclone 按 MD5 判断是否已复制，重复运行只补缺的；上传后 rclone 也会比对 MD5。
- 文件没有扩展名，rclone 给的 `Content-Type` 是 `application/octet-stream`，由 `media-migrate` 按数据库中的类型改正。

### 步骤

1. 在部署目录的 `.env` 中设置上面的变量（`MEDIA_STORE=r2` 及 R2、清除缓存的变量）。
2. 部署：`docker compose up -d --force-recreate`（或推送后自动部署），日志中 `media store` 的 `store` 应为 `r2`。此后新下载的媒体会自动上传。
3. 迁移：

   ```sh
   docker compose exec midden node server/src/cli.ts media-migrate --dry-run
   docker compose exec midden node server/src/cli.ts media-migrate --limit 20
   docker compose exec midden node server/src/cli.ts media-migrate --concurrency 8
   ```

   先试运行看汇总（会读取所有本地文件并对每个对象做 HEAD，不写入），再迁移少量抽查，最后全部迁移。中断后重新运行即可。

4. 抽查汇总中给出的地址（或网页中任一原图的地址），连续请求两次：

   ```sh
   curl -s -o /dev/null -D - https://midden-media.sxzz.moe/ab/cd/<sha256>
   ```

   应看到 `content-type` 为媒体类型、`cache-control: public, max-age=31536000, immutable`、`access-control-allow-origin: *`，第二次 `cf-cache-status: HIT`。带 `Range: bytes=0-1` 请求视频应返回 206。

5. 不需要单独切换：每个媒体在上传确认后即改用 R2 地址。
6. 确认无误后（可以过一段时间）：

   ```sh
   docker compose exec midden node server/src/cli.ts media-prune-local --dry-run
   docker compose exec midden node server/src/cli.ts media-prune-local
   ```

prune 之前可以改回 `MEDIA_STORE=local` 回退，网页回到本地链接；prune 之后本地已没有这些原文件，不能再改回 `local`。prune 后自动备份的 `rsync` 只复制仍在本地的文件，已删除的原文件以 R2 为准（备份目录中原有的副本不会被删除）。

## 备份与恢复

需要备份的是数据目录与 `.env`（其中的 `SECRET_KEY` 用于解密账号凭据）。

1. 数据库：服务运行中即可做一致的在线备份：

   ```sh
   docker compose exec midden node server/src/cli.ts backup /data/backups
   ```

2. 媒体：`media/` 中的文件写入后不再修改，增量复制即可（使用 R2 并 prune 后，原文件以 R2 为准，见上）：

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
- 不再被引用的媒体文件 24 小时后删除（使用 R2 时同时删除对象并清除边缘缓存）；
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
