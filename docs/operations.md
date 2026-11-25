# 运维

## 部署结构

生产环境使用 `compose.yaml` 运行一个容器，镜像内含 Node.js 26 与 ffmpeg（用于缩略图和视频尺寸探测）。容器以非 root 用户运行，数据目录挂载到 `/data`。可选的第二个容器 `litestream` 把数据库持续复制到 R2，见「Litestream」。

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
docker compose logs --tail=100 litestream     # 启用 Litestream 时
docker compose pull && docker compose up -d   # 更新
```

服务启动的顺序见 [架构](architecture.md#启动顺序)：先监听 HTTP，Telegram Bot 在后台启动，Telegram 慢或不可用不影响 `/healthz`。`compose.yaml` 的健康检查超时 10 秒，启动后 2 分钟内（`start_period`）的失败不计入。

数据库迁移在启动时自动应用；随后补齐收藏列表的索引表 `catalog` 中缺失的行（首次部署或导入数据后可能需要几秒）。

## 自动部署

`main` 的 test 工作流通过后会发布镜像 `ghcr.io/sxzz/midden:latest` 与 `:sha-<提交>`。部署机上的 webhook 收到这次运行完成的事件后，从 `origin/main` 取出 `scripts/deploy.ts` 执行：

1. 确认部署目录（默认 `~/midden`）没有本地改动，最新镜像的提交在 `origin/main` 上，且与正在运行的版本不同；
2. 停掉正在运行的服务，启用 Litestream 时随后停掉它（在服务之后：它先把服务最后写的内容复制走）。部署本来就要重启服务，停下来再复制，不会像在线备份那样在运行中的服务旁持有一个读事务好几分钟（那会让 WAL 涨过 500 MB，Litestream 随之做阻塞的 TRUNCATE 检查点，服务的写入因 `database is locked` 失败）；
3. 备份数据库到 `data/backups/deploy/`：`-wal` 不为空时先用原来版本的镜像在一次性容器中（`docker compose run --rm --no-deps --entrypoint node midden -e …`）执行 `PRAGMA wal_checkpoint(TRUNCATE)`，再把 `midden.db` 复制过去（`copyFile` 的 `COPYFILE_FICLONE`：APFS 上是写时复制的克隆，几 GB 也立即完成，文件系统不支持时普通复制）。检查点失败时连同 `-wal` 一起复制，两者合起来是一致的。保留最近 2 份：这次的与上一次的；启用 Litestream 时只保留这次的 1 份，因为上一次的只用于新版本运行一段时间后才发现问题的情况，Litestream 可以恢复到那之前的任一时刻。复制失败时重新启动原来的版本（与 Litestream），结果为 `failed: could not back up the database; … is running again`；
4. 切换到该提交，用 `:sha-<提交>` 镜像 `docker compose up -d --wait midden`，并检查 `/healthz`：最多 5 次，间隔 6 秒（约 30 秒），一次没有回应不算不健康。启用 Litestream 时随后再启动它（`docker compose up -d litestream`（`litestream.yml` 有改动时加 `--force-recreate`，compose 看不到文件内容的变化）；它启动失败不算部署失败，结果末尾加上 `; litestream did not start`；
5. 新版本不健康时停掉它，换回第 3 步的副本（连同复制的 `-wal`，删掉 `-shm`），切回原来的版本。启用 Litestream 时：它这时还没有启动，同样先停 Litestream 再停服务（它一直打开着数据库和 WAL，换文件时不能在运行）；换回数据库后删除它的本地状态 `data/.midden.db-litestream/`；原来的版本启动后（即使启动失败）再启动 Litestream。Litestream 发现本地数据库落后于存储桶，从存储桶取得位置，把换回的数据库整个作为下一个事务上传，回滚前的历史仍可恢复（见「Litestream」）。

服务在第 2 步到第 4 步之间停止，通常不到一分钟。Litestream 停止后 WAL 从头开始写，它再启动时上传一份完整快照（见「Litestream」）。

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
- 上传确认、记下 `remote_at` 后，同一个 `upload` 任务立即删除本地原文件，此后 R2 中是唯一的一份（没有其他备份，见「R2 的保护」）。删除在这个媒体的键的锁内进行（下载写入、回收删除同一个键时也取这个锁），并在锁内再次确认 `remote_at` 仍在。以下情况暂不删除：
  - 这个媒体的缩略图任务还没结束：缩略图要从本地文件生成。缩略图任务结束（生成成功或失败）后会再排一个 `upload` 任务，那时删除；
  - 这个键同时是某个缩略图的文件（缩略图只存本地）。

  删除失败时任务按上传的间隔重试（记 `job will retry`），`remote_at` 不会被清除；重试用完时记 `deleting the local copy of uploaded media gave up; media-prune-local removes it`。

- 删除时正在读这个文件的地方不受影响：Telegram 发送、带文件名的下载和 `/media/…` 都先打开文件再读，已打开的文件删除后仍能读完；打开前已删除时改从 R2 读。ffmpeg、ffprobe 拿到的是本地路径，若在它们打开之前文件被删，就改用预签名 URL 再运行一次。之后再下载到相同内容（已在 R2 中的媒体）时不再写本地文件。
- 缩略图只存本地，作为缓存，经本服务提供，响应头为 `Cache-Control: public, max-age=31536000, immutable`（图片同样；视频和带文件名的下载仍为 `private`，不进 CDN）。缩略图文件丢失时，请求它的 `/media/…` 当场从原文件重新生成：原文件在本地就读本地，否则 ffmpeg 通过预签名 URL 只读取需要的字节范围。生成的字节不同（例如换了 ffmpeg）时记在新的键下，并把请求重定向过去。
- 带文件名的下载经本服务从本地或 R2 流式返回，带 `Content-Disposition`。服务端的读取（Telegram 发送、缩略图、下载）都先读本地，没有时通过 S3 API 读 R2，不经公开域名。
- 不另设本地原文件缓存：缩略图在删除本地原文件之前从本地文件生成；Telegram 按 `file_id` 复用已上传的文件；其余读取（第一次发送到 Telegram、缩略图丢失、带文件名的下载）在本地原文件删除后都读 R2，视频只读部分字节。
- 设为 `r2` 并运行后，不能再改回 `local`：本地实现不读 R2，已删除本地原文件的媒体会缺失。要回退，先把存储桶下载回 `media/`（如 `rclone copy r2:midden ~/midden/data/media`）再改。
- 删除：不再被引用的媒体（删除收藏、删除媒体）24 小时后删除本地文件（还在时）；R2 中有对象时先清除其公开地址的边缘缓存（`purge_cache`），再删除对象。清除失败时对象保留，稍后重试；没有设置 `CF_ZONE_ID` 时记 `cache purge skipped: no CF_ZONE_ID configured` 并跳过清除。
- 存储类别为存储桶默认的 Standard。

### 配置

| 变量               | 说明                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `MEDIA_STORE`      | `local`（默认）或 `r2`                                                                       |
| `R2_ACCOUNT_ID`    | Cloudflare 账户 ID（32 位十六进制）；S3 端点为 `https://<ID>.r2.cloudflarestorage.com`       |
| `R2_BUCKET`        | 存储桶名，如 `midden`                                                                        |
| `MEDIA_PUBLIC_URL` | 存储桶的公开域名，如 `https://midden-media.sxzz.moe`                                         |
| `CF_API_TOKEN`     | Cloudflare 账户 API token（见下）：R2 的 S3 密钥由它派生，清除缓存与存储用量的分析数据也用它 |
| `CF_ZONE_ID`       | 公开域名所在 zone 的 ID；不设置则删除时不清除边缘缓存                                        |

`MEDIA_STORE=r2` 时前五项必填，缺少时启动失败并列出缺少的变量；错误信息不含密钥。启动日志 `media store` 写明当前的 `store`。

S3 密钥由 `CF_API_TOKEN` 派生（[Cloudflare 文档](https://developers.cloudflare.com/r2/api/tokens/)）：Access Key ID 是这个 token 的 id，Secret Access Key 是 token 值的 SHA-256（十六进制）。服务启动时、开始监听之前请求 `GET https://api.cloudflare.com/client/v4/accounts/<R2_ACCOUNT_ID>/tokens/verify` 取得 id（每次请求 10 秒超时；网络错误、超时、5xx、429 时共试 3 次，最多约 33 秒），进程运行期间一直使用。成功记 `cloudflare token verified`；失败记 `cloudflare token verification failed`（error，`reason` 是状态码与 Cloudflare 的错误信息），随后以 `Invalid configuration: CF_API_TOKEN could not be verified: …` 退出，与缺少变量一样：`/healthz` 不会响应，自动部署因此回滚。日志与错误信息都不含 token 和派生的密钥。`media-migrate`、`media-prune-local` 同样先验证。

`CF_API_TOKEN` 与 `R2_ACCOUNT_ID` 都设置时（不论 `MEDIA_STORE`），「存储用量」读取 R2 的分析数据，见「存储用量」。

### Cloudflare

已配置：存储桶 `midden` 绑定自定义域名 `midden-media.sxzz.moe`；该域名的 Cache Rule（Edge TTL 忽略源站、1 年，300–526 不缓存，Browser TTL 遵循源站，缓存键忽略查询串）；Response Header Transform Rule 给所有响应（包括缓存命中）加 `Access-Control-Allow-Origin: *`。

还需要：

1. Smart Tiered Cache：`sxzz.moe` zone →「Caching → Tiered Cache」，选 Smart Tiered Caching。边缘未命中时先问上层节点，减少回源 R2 的读取次数。
2. 一个账户 API token（Account API Tokens 中自定义创建），权限：
   - **Workers R2 Storage Bucket Item Write**，存储桶 `midden` 与 `midden-backup`；
   - Zone → **Cache Purge**，zone `sxzz.moe`；
   - **Account Analytics Read**。

   token 值填入 `CF_API_TOKEN`；zone 的 Overview 页右侧的 Zone ID 填入 `CF_ZONE_ID`。rclone 用由它派生的 S3 密钥，见「迁移现有媒体」。

3. 缩略图的边缘缓存（可选）：在应用所在域名加一条 Cache Rule，匹配路径以 `/media/` 开头，Eligible for cache，Edge TTL 选「Use cache-control header if present」，这样 `private` 的视频与下载不进缓存；缓存键保留查询串（签名在其中）。

### 迁移现有媒体

`media-migrate` 处理所有尚未记为在 R2 中的媒体（`blobs` 中的原文件，不含缩略图）：

1. 计算本地文件的 SHA-256 与 MD5，SHA-256 与键不符时报告 `hash mismatch` 并跳过，不上传。
2. 读取 R2 中同键对象的大小和响应头（HEAD）：
   - 不存在，或大小不同：上传，读回确认。
   - 大小相同：用对象带的校验值与本地比较，依次是 `x-amz-checksum-sha256`、ETag（单段上传时即 MD5；分段上传的 ETag 带 `-<段数>`，不能用）、rclone 为分段上传记下的 `x-amz-meta-md5chksum`。有一项不符就重新上传；都相符则保留，不重新传输。一项都没有时重新上传（记 `replacing <哈希>: no checksum to compare`，计入 `replaced`），因为记下后本地文件随即删除，只按大小认定不够；加 `--verify-download` 则改为下载并计算 SHA-256，相符就保留。
   - 保留的对象 `Content-Type` 或 `Cache-Control` 不对时，在服务端把对象复制到自身（`CopyObject`，`x-amz-metadata-directive: REPLACE`）改正，其他元数据照旧，不重新传输，再读回确认。
3. 在 `blobs.remote_at` 记下，网页从此使用公开地址。
4. 删除本地原文件，规则与上传任务相同：缩略图任务还没结束的、同时是缩略图文件的保留（汇总中计入 `kept … for thumbnails`），之后由缩略图任务或 `media-prune-local` 删除。

本地文件缺失时，只有加 `--verify-download` 且 R2 中的对象哈希相符才记下，否则报告 `missing locally`。命令与服务同时运行：服务的上传任务在此期间已记下（并删除本地文件）的媒体计入 `by the server meanwhile`，不算问题。可以随时中断，再次运行时跳过已记下的，其余重新检查，已上传但未记下的按校验值保留；中断在记下与删除之间、或删除失败（计入 `failed`）时，本地文件留给 `media-prune-local`。`--dry-run` 不上传、不写入、不删除，汇总中的 `would delete N local files` 是会删除的本地原文件数与大小。`--concurrency N`（默认 4）同时处理的数量，`--limit N` 只处理前 N 个。每 5 秒输出一次进度，结束时输出汇总，并给出一个已记下媒体的公开地址；有失败、哈希不符或缺失时退出码为 1。R2 中不属于任何媒体的对象（如 rclone 一并复制的缩略图）不会被读取或修改；它们的键以后被回收时随之删除。

`media-prune-local` 删除已记为在 R2 中、且再次确认过的本地原文件：对象存在，大小、`Content-Type`、`Cache-Control` 正确，并且上述校验值之一与本地文件相符（或加 `--verify-download` 后下载比较）。没有校验值的对象保留本地文件并列出；对象不对时保留本地文件、清除 `remote_at`（网页改回本地链接，下次 `media-migrate` 重新上传）。缩略图（包括同时是缩略图的原文件）一律保留，缩略图任务还没结束的原文件也暂时保留。上传任务和 `media-migrate` 已经自动删除本地原文件，这个命令只处理剩下的：在自动删除之前就已记下的、当时因缩略图保留而缩略图任务之后没有删掉的、删除失败或中断留下的。

预先用 rclone 复制（可选，代码上线前即可进行）。rclone 不会自己派生密钥，先在 macOS 的终端算出这一对（`jq` 用 `brew install jq` 安装；Linux 上把 `shasum -a 256` 换成 `sha256sum`）：

```sh
read -rs TOKEN    # 粘贴 CF_API_TOKEN 后回车，不显示、不进 shell 历史
ACCOUNT=9183b1c394e4cd2f0a7d3c978bc53a29
# access_key_id：token 的 id
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/tokens/verify" | jq -r .result.id
# secret_access_key：token 值的 SHA-256
printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1
unset TOKEN
```

`printf %s` 不带换行；用 `echo` 会多一个换行，算出的值就不对。`CF_API_TOKEN` 换了（轮换或重新创建）之后这一对随之改变，要重新计算。

```ini
# ~/.config/rclone/rclone.conf
[r2]
type = s3
provider = Cloudflare
access_key_id = <token 的 id>
secret_access_key = <token 值的 SHA-256>
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

1. 在部署目录的 `.env` 中设置上面的变量（`MEDIA_STORE=r2`、R2 的变量、`CF_API_TOKEN` 与 `CF_ZONE_ID`）。
2. 部署：`docker compose up -d --force-recreate`（或推送后自动部署），日志中 `media store` 的 `store` 应为 `r2`。此后新下载的媒体会自动上传，确认后删除本地原文件；从这一步起不能再改回 `local`（见上）。
3. 迁移：

   ```sh
   docker compose exec midden node server/src/cli.ts media-migrate --dry-run
   docker compose exec midden node server/src/cli.ts media-migrate --limit 20
   docker compose exec midden node server/src/cli.ts media-migrate --concurrency 8
   ```

   先试运行看汇总（会读取所有本地文件并对每个对象做 HEAD，不写入、不删除，列出会删除的本地文件数），再迁移少量抽查，最后全部迁移。每个媒体记下后即删除本地原文件。中断后重新运行即可。

4. 抽查汇总中给出的地址（或网页中任一原图的地址），连续请求两次：

   ```sh
   curl -s -o /dev/null -D - https://midden-media.sxzz.moe/ab/cd/<sha256>
   ```

   应看到 `content-type` 为媒体类型、`cache-control: public, max-age=31536000, immutable`、`access-control-allow-origin: *`，第二次 `cf-cache-status: HIT`。带 `Range: bytes=0-1` 请求视频应返回 206。

5. 不需要单独切换：每个媒体在上传确认后即改用 R2 地址。
6. 不需要单独删除本地原文件：新上传的媒体由上传任务删除，迁移的由 `media-migrate` 删除。`media-prune-local` 只处理剩下的（见上），可以在迁移之后运行一次，以后偶尔再运行：

   ```sh
   docker compose exec midden node server/src/cli.ts media-prune-local --dry-run
   docker compose exec midden node server/src/cli.ts media-prune-local
   ```

7. 原来的每日备份脚本已删除，它留下的媒体镜像确认 R2 无误后手动删除，见「旧的每日备份」。

### 改用 `CF_API_TOKEN`（一次性的切换）

从这个版本起服务只读 `CF_API_TOKEN`，不再读 `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`CF_PURGE_TOKEN`，也不兼容它们；`MEDIA_STORE=r2` 而没有 `CF_API_TOKEN`，或它验证失败时，新版本不启动。所以顺序是：

1. **推送之前**，在部署目录（`~/midden`）的 `.env` 中加上 `CF_API_TOKEN=<token>`。旧的三个变量先留着：在切换前仍在运行的旧版本用它们，新版本忽略它们。先在部署机上确认这个 token 有效：

   ```sh
   cd ~/midden
   TOKEN=$(grep '^CF_API_TOKEN=' .env | cut -d= -f2-)
   ACCOUNT=$(grep '^R2_ACCOUNT_ID=' .env | cut -d= -f2-)
   curl -s -H "Authorization: Bearer $TOKEN" \
     "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/tokens/verify" | jq '{success, status: .result.status}'
   ```

   应为 `"success": true`、`"status": "active"`。

2. 推送到 `main`。自动部署用新镜像重建容器（同时读入新的 `.env`），日志中应有 `cloudflare token verified` 和 `listening`。没有 `CF_API_TOKEN` 或验证失败时新版本退出，`/healthz` 不响应，部署回滚到旧版本，Bot 发来 `rolled back …`；改好 `.env` 后在部署目录运行 `node scripts/deploy.ts` 重新部署。
3. 验证：
   - 上传：采集一个带图片的帖子。上传任务先 PUT 再读回（HEAD）确认，所以几秒后网页中这张图的地址变为 `https://midden-media.sxzz.moe/…` 就说明写和读都可用；失败时日志有 `jobType` 为 `upload` 的 `job will retry`，带 `S3 PutObject failed: 403` 之类的原因。
   - 清除缓存：用同一个 token 直接请求一次（清除一个不存在的地址无害）：

     ```sh
     ZONE=$(grep '^CF_ZONE_ID=' .env | cut -d= -f2-)
     curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
       -d '{"files":["https://midden-media.sxzz.moe/cutover-check"]}' \
       "https://api.cloudflare.com/client/v4/zones/$ZONE/purge_cache" | jq .success
     ```

     应为 `true`。服务回收媒体时清除成功记 `cache purged`。

   - 分析数据：「设置 → 管理员面板 → 存储用量」显示 R2 的两个存储桶和「本月费用」；日志中没有 `storage analytics unavailable`。

4. 从 `.env` 删去 `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`CF_PURGE_TOKEN`（服务已不读它们，不必重启），`unset TOKEN`。rclone 的配置改用派生的一对（见「迁移现有媒体」）。
5. 在 Cloudflare 撤销旧 token：「R2 → Manage API tokens」中媒体用的那个（`midden` 的 Object Read & Write），以及「My Profile → API Tokens」中清除缓存的那个。Litestream 的 token 保留：它仍用自己的密钥（见「Litestream」）；只有把 `LITESTREAM_*` 改成由 `CF_API_TOKEN` 派生的一对、`docker compose up -d litestream` 之后心跳正常，才可以撤销它。

### R2 的保护

R2 没有对象版本，被删除或覆盖的对象不能恢复，这里也没有其他媒体备份。R2 提供存储桶锁（Bucket locks），可以作为一个选项，目前没有配置：一条规则让某个前缀（或整个存储桶）下的对象在一段时间内（按对象存在的时长、到某个日期或无限期）不能被删除或覆盖，对现有和以后的对象都生效，优先于生命周期规则。在 Cloudflare 的「R2 → 存储桶 → Settings → Bucket lock rules」中添加，或用 `npx wrangler r2 bucket lock add <存储桶>`。

启用前要知道：

- 被锁住的对象删除时返回 409（`ObjectLockedByBucketPolicy`）。回收不再引用的媒体（删除收藏、删除媒体之后）会失败并按 `media_garbage` 的间隔重试，直到保留期结束才删掉，期间日志有 `maintenance step failed`，存储照常计费；清除边缘缓存在删除之前，每次重试都会再清除一次。
- 覆盖同样被拒绝：`media-migrate` 改正响应头（复制到自身）和重新上传（`replaced`）会失败，所以要在迁移完成之后再启用。删除后在保留期内又下载到相同内容时，上传任务的上传也是覆盖，会失败，媒体留在本地；`media-migrate` 按校验值保留 R2 中的对象并记下。
- 按存在时长的规则（如 30 天）能挡住这段时间内的误删，代价是删除的媒体在 R2 中多留这么久；无限期规则会让回收永远失败，不适合这里。

## 原始响应（R2）

默认原始响应在数据库中（`source_responses.body`）。设置 `RAW_R2_BUCKET` 后，每次抓取完成即把原始响应移到这个私有存储桶的 `raw/` 下（zstd 压缩，按内容的 SHA-256 命名），数据库只留下元数据和 `remote_at`，见架构文档「原始响应」。生产环境中它们占数据库的大部分（2026-11-25：`source_responses` 878 MB，其中 `body` 732 MB，128,844 条）。

| 变量                                               | 说明                                                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `RAW_R2_BUCKET`                                    | 私有存储桶，如 `midden-backup`（与 Litestream 的 `db/` 共用，各在自己的前缀下）                                                 |
| `R2_ACCOUNT_ID`、`CF_API_TOKEN`                    | 与媒体共用：S3 密钥由 token 派生（见「媒体存储」的「配置」），token 要有这个存储桶的写权限，上面的 token 已包括 `midden-backup` |
| `RAW_R2_ACCESS_KEY_ID`、`RAW_R2_SECRET_ACCESS_KEY` | 可选，这个存储桶自己的一对 S3 密钥，需同时设置；设置后不用 `CF_API_TOKEN`                                                       |

部署这一版本时的迁移给 `source_responses` 加 `remote_at` 列和按 `sha256` 的索引，与是否设置这些变量无关；建索引要读一遍整张表，在 128,844 条、757 MB 的合成副本上约 2.3 秒。

设置了 `RAW_R2_BUCKET` 才启用；还需要 `R2_ACCOUNT_ID`，以及 `CF_API_TOKEN` 或那一对密钥，缺少时启动失败并列出缺少的变量；`RAW_R2_BUCKET` 不能是公开的媒体存储桶 `R2_BUCKET`。用 `CF_API_TOKEN` 时，服务在开始监听之前验证它（与媒体相同），验证失败就不启动，自动部署因此回滚。启动日志 `raw responses store` 的 `store` 为 `r2`（未启用时为 `database`）。`raw-migrate`、`raw-get` 同样先验证。

- 存储桶必须是私有的（不绑定域名、不开公开访问）：原始响应中有平台给登录账号看的内容。用 `midden-backup` 时，不要给它加作用于整个存储桶的生命周期规则（Litestream 自己管理 `db/` 下的文件）。
- 已设置 `CF_API_TOKEN` 时不需要新的密钥。单独的一对密钥可以在「R2 → Manage API tokens → Create API token」中创建（Object Read & Write，只选这个存储桶），或沿用 Litestream 那一对；R2 的密钥不能限定前缀，所以它们也能读写 `db/`。
- 费用：按 4 倍压缩，现有的约 180 MB，存储每月约 $0.003；回填约 13 万次 PUT 和同样多的 HEAD，在每月免费额度内。之后每条新的原始响应一次 PUT、一次 HEAD，删除时一次 DELETE。「存储用量」中 `midden-backup` 的存储和操作次数包括 `raw/`。
- 读取一条：`docker compose exec midden node server/src/cli.ts raw-get <抓取 id>` 列出这次抓取的原始响应（序号、`bucket` 或 `database`、大小、类型、地址），加上序号输出那一条的原始字节。
- 关闭：删去 `RAW_R2_BUCKET`（和那一对密钥）即可，之后新的原始响应留在数据库中；已在存储桶中的仍在那里，读取它们（`raw-get`）和回收删除都需要这个存储桶，所以只在不再需要它们时关闭。

### 启用与回填

1. 在部署目录的 `.env` 中加上 `RAW_R2_BUCKET=midden-backup`（已设置 `R2_ACCOUNT_ID` 与 `CF_API_TOKEN` 时只需这一行）。
2. `docker compose up -d`（或推送后自动部署），日志中 `raw responses store` 的 `store` 应为 `r2`。此后完成的抓取由服务自己移走。
3. 回填已有的原始响应：

   ```sh
   docker compose exec midden node server/src/cli.ts raw-migrate --dry-run
   docker compose exec midden node server/src/cli.ts raw-migrate --limit 100
   docker compose exec midden node server/src/cli.ts raw-migrate --concurrency 16
   ```

   试运行不访问存储桶、不改动数据库，读出所有还在数据库中的原始响应并在本地压缩，汇总条数、原始大小与压缩后的大小。`--limit 100` 先移 100 条抽查（见第 4 步），最后全部移走。每条先压缩、上传、读回核对（大小、ETag 即压缩后字节的 MD5、元数据中的 SHA-256），每批最多 100 条在一个事务中记下并清空，所以任何时候中断都不会丢失：已上传还没记下的，下次重新上传（同一个键，同样的内容）。重新运行即从剩下的继续。只处理 10 分钟以前的行，更新的留给服务。每 5 秒输出一次进度，结束时输出汇总；有失败或与哈希不符的行时退出码为 1，这些行原样留在数据库中，重新运行即可。服务照常运行，抓取不受影响。13 万条在一台本地的模拟存储桶上约 4 分钟，实际取决于到 R2 的延迟（每条两次请求），`--concurrency 16` 时估计半小时左右。

4. 抽查：

   ```sh
   docker compose run --rm --entrypoint sqlite3 litestream -readonly /data/midden.db \
     "SELECT remote_at IS NOT NULL, count(*), sum(size) FROM source_responses GROUP BY 1;
      SELECT capture_id FROM source_responses WHERE remote_at IS NOT NULL LIMIT 1;"
   docker compose exec midden node server/src/cli.ts raw-get <抓取 id>
   docker compose exec midden node server/src/cli.ts raw-get <抓取 id> 0 | head -c 300
   ```

   第一条给出仍在数据库中（`0`）和已在存储桶中（`1`）的条数与原始大小，回填结束后前者只剩最近 10 分钟的，以及一个已移走的抓取 id；`raw-get` 列出它的原始响应（应为 `bucket`），再输出第一条，应是原始的 JSON。回填结束后 `raw-migrate --dry-run` 应显示 `0 raw responses in the database to move`。

5. 数据库变小：清空的原始响应留下的页面成为空闲页面，维护任务每 15 分钟最多还给文件系统 16 MiB（见「维护任务」），不需要 `VACUUM`。在 147,000 条抓取、128,844 条原始响应（757 MB）的合成副本上（迁移后 1,369 MB），回填后空闲页面约 877 MB，55 次（约 14 小时）后数据库降到 492 MB，`source_responses` 只剩 27 MB。生产环境的数据库因此应从 2.32 GB 降到约 1.4–1.5 GB（减去 `source_responses` 的约 850 MB），约 13–14 小时后到达。日志 `released free database pages` 的 `free` 逐次减少，降到 1024 以下就停止。这些改动照常经 Litestream 复制：在同一个合成副本上，回填共写入约 3.2 GB 的 WAL（每批记下的行移到表尾，并改动它们的索引项、所在的页面和空闲页面列表），incremental vacuum 追上又写入约 0.9 GB。Litestream 的每个文件中同一页面只存一次，并以 LZ4 压缩，所以上传的量少于这个数；多出的 L1、L2 文件按保留期在约 9 天后删除。

恢复较早的数据库（见「恢复」）时，那之后被删除的原始响应会回到数据库中，而它们在存储桶中的对象在删除 24 小时后就被回收了，读取这些原始响应会失败；其他原始响应不受影响。原始响应在存储桶中只有这一份，与 R2 中的媒体一样没有其他备份。

## 备份与恢复

需要备份的是数据库、媒体与 `.env`（原始响应移到存储桶后只在那里，见「原始响应（R2）」）：

- 数据库：Litestream 持续复制到 R2 的私有存储桶 `midden-backup`，可以恢复到最近 7 天内的任一时刻，见「Litestream」。不启用时，自己定期做在线备份（服务运行中即可）：

  ```sh
  docker compose exec midden node server/src/cli.ts backup /data/backups
  ```

  这个命令也用于一次性的副本，例如改动数据之前。

- 媒体：使用 R2 时原文件只在 R2 中（见「R2 的保护」），本地只剩缩略图和正在上传的原文件，不复制。`MEDIA_STORE=local` 时 `media/` 中的文件写入后不再修改，增量复制即可：

  ```sh
  rsync -a data/media/ <备份位置>/media/
  ```

- `.env`：不在任何自动备份中。其中的 `SECRET_KEY` 用于解密已保存的账号凭据，没有它，恢复的数据库中的账号要重新添加。改动后自己另存一份（例如密码管理器），Litestream 的 token 也在其中，在另一台机器上恢复时需要它。

### Litestream

`compose.yaml` 中的 `litestream` 服务运行官方镜像 `litestream/litestream`（版本和摘要固定），与服务共用数据目录，按仓库根目录的 `litestream.yml` 把 `data/midden.db` 的改动持续复制到 `s3://midden-backup/db`（R2 的 S3 端点）。它是单独的容器：出问题时服务照常运行，部署也不等它。以 midden 的用户（1000）运行，它在数据库旁边建的文件服务也能写。

启用：

1. Cloudflare「R2」中建私有存储桶 `midden-backup`（不绑定域名、不开公开访问）；「R2 → Manage API tokens → Create API token」，权限 **Object Read & Write**，范围只选 `midden-backup`。

   Litestream 只认 S3 的一对密钥，不能像服务那样由 `CF_API_TOKEN` 派生，所以它有自己的两个变量。值可以是这个 R2 token 的 Access Key ID 与 Secret Access Key，也可以是由 `CF_API_TOKEN` 派生的一对（那个 token 也有 `midden-backup` 的权限，算法见「迁移现有媒体」）；用后者时 `CF_API_TOKEN` 轮换后要一并更新，否则 Litestream 上传失败、心跳停止。

2. 部署目录的 `.env`：

   ```sh
   COMPOSE_PROFILES=litestream
   LITESTREAM_ACCESS_KEY_ID=<Access Key ID>
   LITESTREAM_SECRET_ACCESS_KEY=<Secret Access Key>
   ```

   `COMPOSE_PROFILES` 让 compose 启动 `litestream` 服务，没有它就没有这个容器；服务读到 `LITESTREAM_ACCESS_KEY_ID` 就等待 Litestream 的心跳（见「监控」）。两个密钥只传给 Litestream 的容器和服务（`.env` 整个传给服务），不写入日志。

3. `docker compose up -d`：创建 `litestream` 容器，并重建服务的容器以读入新变量。Litestream 第一次启动时上传整个数据库，日志中有 `snapshot complete`。
4. 检查（见「检查复制」），几天后按「恢复」试一次。

关闭：先 `docker compose rm -sf litestream`，再删去这三行，`docker compose up -d`（服务不再等待心跳）。存储桶中的文件不会自动删除。

`litestream.yml` 改动后 `docker compose restart litestream`；自动部署在它有改动时会重建容器。

#### 设置

Litestream 0.5 把 WAL 中新提交的页面写成 LTX 文件（按页 LZ4 压缩），每个文件一个事务编号（TXID），连续递增；文件逐级合并，每天另做一份完整快照。

| 设置                                  | 值                     | 原因                                                                                                                                                            |
| ------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `monitor-interval`                    | `10s`                  | 每 10 秒检查一次 WAL，有新页面就写一个 L0 文件，每个文件是一次 PUT。默认 1 秒时持续写入的一天有 86,400 个，10 秒最多 8,640 个。机器损坏时最多丢失约 10 秒的写入 |
| `sync-interval`                       | `1s`                   | 文件写好后 1 秒内上传。0.5 中 PUT 的次数由上一项决定，这一项只是上传的间隔                                                                                      |
| `levels`                              | `1m`、`1h`             | 每分钟把 L0 合并成一个 L1 文件，它们是保留期内的恢复点；每小时再合并成 L2，恢复时少下载文件                                                                     |
| `snapshot`                            | 每 `24h`，保留 `192h`  | 每天 00:00 UTC 一份完整快照，保留 8 天：最近 7 天内的任一时刻之前都有一份快照可用                                                                               |
| `l0-retention-check-interval`         | `1h`                   | 每次检查都列出存储桶中全部 L1 文件（每 1000 个一次 Class A 操作），默认每 15 秒一次太多                                                                         |
| `heartbeat-url`、`heartbeat-interval` | 服务的 8081 端口，`5m` | 见「监控」                                                                                                                                                      |

恢复点：最近 5 分钟到 1 小时内（L0 文件还在）约每 10 秒一个，更早的每分钟一个（L1 的边界），8 天前的不能恢复。没有写入的时段没有文件。

#### 检查点

服务的连接用 WAL、`synchronous = NORMAL`、5 秒的 busy timeout，保留 SQLite 默认的自动检查点（WAL 超过 1000 页时，PASSIVE）。Litestream 一直持有一个读事务，只有它自己的检查点能让 WAL 从头开始写（它做 PASSIVE 检查点时短暂持有写锁，写入在这期间等待，busy timeout 足够）；PASSIVE 检查点越不过它的读事务，所以服务的自动检查点不影响复制。服务中没有 `wal_checkpoint(RESTART)`、`wal_checkpoint(TRUNCATE)` 和 `VACUUM`：前两者会让 Litestream 重新上传整个数据库，`VACUUM` 把每一页写进 WAL，都不要加。`PRAGMA optimize`（启动时和每 6 小时）和 `PRAGMA incremental_vacuum`（见「维护任务」）是普通的写事务；`cli.ts backup`（手动的在线备份，部署不再用它）只读数据库，但运行期间一直持有读事务。数据库变小的事务（incremental vacuum 截短文件）在 Litestream 0.5.2 中会让同步报 `page number X out-of-bounds for commit size Y`（#875），之后由 #881 修复，固定的 0.5.18 已包含；用 0.5.18 在本地试过：一边复制，一边清空大量数据并分批 incremental vacuum，最新状态与其间三个时刻的恢复都通过完整性检查，最新状态的页数和内容与源数据库相同。

WAL 的大小：Litestream 做快照时（启动后 WAL 是新的时，例如每次部署之后；以及每天 00:00 UTC）直到上传完都不做检查点，WAL 随写入一直变大，负载高时几分钟就超过 1 GB。WAL 超过 `truncate-page-n` 时它先试 PASSIVE，不行再做阻塞的 TRUNCATE；0.5.18 在 TRUNCATE 之后总要在持有写锁的情况下把整个数据库写成一份快照（`checkpoint boundary snapshot`），这期间服务的每个写入都在等待，超过 5 秒就以 `database is locked` 失败，并且又上传一次整个数据库。默认的阈值约 500 MB，快照期间的增长就会越过它，所以 `litestream.yml` 把它设为 1,000,000 页（约 3.8 GiB），只作为最后的保护：快照结束后，下一次普通的 PASSIVE 检查点（WAL 超过 1000 页时，每次同步之后）把 WAL 写回数据库并从头开始。这个检查点期间 Litestream 也持有写锁，WAL 越大越久。磁盘上要留出 WAL 的空间。

Litestream 在数据库中建两张表 `_litestream_seq`、`_litestream_lock`，恢复出的数据库中也有，不影响服务。

Litestream 停止期间服务继续写入；服务做的检查点让 WAL 从头开始写之后，Litestream 再启动时上传一份完整快照（日志中 `snap=true`）。整套服务停止时（例如重启 Mac），服务的连接若最后关闭会删除 WAL，也是这样。数据不会缺，只多一次约 1.2 GB 的上传。

#### 费用

R2 Standard：存储 $0.015/GB·月，Class A 操作（PUT、分段上传、LIST）$4.50/百万次，Class B（GET、HEAD）$0.36/百万次，流出免费。每月免费 10 GB·月、100 万次 Class A、1000 万次 Class B，与媒体的存储桶 `midden` 共用。按数据库 2.3 GB、LZ4 后约 52%（开发库实测）估计，一份完整副本约 1.2 GB：

- 存储：8 份快照约 9.6 GB；L1、L2 保留约 9 天的增量，按每天 100–300 MB 改动估计约 1–2 GB；启用后、每次回滚后和 Litestream 重新上传整个数据库（见上）后的 9 天内，L1、L2 中各多一份完整副本（约 2.4 GB）。平时约 11–12 GB，约 $0.18/月（媒体已用完免费额度时；否则更少）。
- Class A，最坏情况（整月每 10 秒都有写入）：L0 上传 259,200；L1 合并 43,200 次写入加 43,200 次列出 L0；L2 合并 720 次写入加约 9,400 次列出 L1；L0 保留检查约 10,000；快照分段上传（每段 5 MiB）约 7,000；快照保留清理约 450。合计约 37 万次，在免费额度内；全部计费也只有约 $1.7/月。写入是间歇的，实际应在一半以下。
- Class B：L2 合并时下载 L1 文件，每月最多约 4.3 万次，另有恢复时的下载，免费额度内。

#### 监控

`litestream.yml` 的 `heartbeat-url` 指向服务的 8081 端口（`server/src/litestream.ts`；compose 只发布 8080，这个端口只有同一网络中的容器能访问）。Litestream 只在最近 5 分钟内的同步都成功时每 5 分钟发一次心跳：容器没有运行、token 错误、网络或 R2 故障时都没有心跳。数据库没有写入时仍有心跳：Litestream 0.5.18 的复制循环在没有新数据时按 `sync-interval` 空转一次，没有文件要上传也记为同步成功（`replica.go`，注释「so idle databases continue recording sync health for heartbeats」），所以不需要服务定期写一行来保持心跳；只有从未写入过的空数据库不发。

服务设置了 `LITESTREAM_ACCESS_KEY_ID` 时监听这个端口：超过「备份心跳超时」（默认 20 分钟，从服务启动时算起）没有收到心跳，就由 Bot 告诉所有者「数据库备份：20 分钟没有收到 Litestream 的心跳」，日志记 `litestream heartbeat missing`（error）；之后收到心跳时发「数据库备份：Litestream 的心跳已恢复」，记 `litestream heartbeat resumed`。服务启动后的第一次心跳记 `litestream heartbeat received`（info），之后的心跳不记日志，所以确认备份在工作不必再等 20 分钟：看这条日志，或看下面的管理员面板。Litestream 上传失败后按 1 秒起翻倍、最长 5 分钟的间隔重试，所以故障排除后几分钟内才恢复。没有配置 Bot 时只记日志。服务重启后重新计时，故障持续时每次部署后会再提醒一次。

「备份心跳超时」是管理员设置，不是环境变量：网页「设置 → 管理员面板 → 数据库备份」中修改，存在数据库的 `settings` 表（键 `litestream_timeout_minutes`，整数 1 到 1440 分钟，没有设置时为 20），监控每次检查时读取，改后立即生效，不必重启。Litestream 每 5 分钟发一次心跳（`litestream.yml` 的 `heartbeat-interval`），低于 5 分钟的值会让正常的备份也被报告，只在测试告警时有意义。

同一面板显示「上次心跳 3 分钟前」，超时则显示「超过 20 分钟没有心跳」；`GET /v1/instance` 的 `litestream` 字段给出同样的内容：`enabled`、`last_heartbeat_at`（没有收到过为 `null`）、`stale`、`stale_after_minutes`；没有设置 `LITESTREAM_ACCESS_KEY_ID` 时 `enabled` 为 `false`，面板不显示这一部分。`PUT /v1/instance/litestream` 修改超时（`{"stale_after_minutes": 20}`）。上次心跳的时间也存在 `settings` 表（`litestream_last_heartbeat_at`），重启后仍能显示，但超时仍从服务启动时算起。每次心跳（每 5 分钟）写一次这一行，Litestream 随之多上传一个很小的文件。

部署时 Litestream 启动失败，部署消息末尾有 `; litestream did not start`。整台机器离线时这些都发不出来，服务本身也不可用。

#### 检查复制

```sh
docker compose ps litestream
docker compose logs --tail=50 litestream                                # sync error、monitor error、compaction failed
docker compose exec litestream litestream ltx -level 9 /data/midden.db    # 快照：应有一份当天 00:00 UTC 之后的
docker compose exec litestream litestream ltx -level all /data/midden.db  # 全部文件：有写入时 L0 的最新时间应在一分钟内
docker compose exec litestream litestream status                          # 本地 TXID 与 WAL 大小
```

Litestream 0.5 没有 0.3 的 `generations`、`snapshots` 命令：不再分 generation，事务编号一直连续；快照就是 `ltx -level 9` 列出的文件。

### 恢复

Litestream 的恢复在一个临时的 `litestream` 容器中运行（`docker compose run`，同样的镜像、配置和 token），写到数据目录中的新文件，服务照常运行。

1. 恢复到新文件：

   ```sh
   # 最新的状态
   docker compose run --rm litestream restore -integrity-check full \
     -o /data/restore/midden.db /data/midden.db
   # 某一时刻之前的最后一个恢复点（UTC，RFC 3339）
   docker compose run --rm litestream restore -integrity-check full \
     -timestamp 2026-11-20T08:00:00Z -o /data/restore/midden.db /data/midden.db
   ```

   加 `-dry-run` 先列出要下载的文件。`-o` 的文件不能已存在，每次换一个文件名或先删掉。`-integrity-check full` 在恢复后运行 `PRAGMA integrity_check`，日志中应有 `post-restore integrity check passed`。

2. 检查恢复的文件：

   ```sh
   docker compose run --rm --entrypoint sqlite3 litestream /data/restore/midden.db \
     "PRAGMA integrity_check; SELECT count(*), datetime(max(created_at) / 1000, 'unixepoch') FROM captures"
   ```

   应输出 `ok`，最后一次抓取的时间（UTC）应在恢复点之前不久。

3. 换上，先停 Litestream 再停服务：

   ```sh
   docker compose stop litestream
   docker compose stop midden
   mkdir data/before-restore && mv data/midden.db* data/before-restore/
   mv data/restore/midden.db* data/
   rm -rf data/.midden.db-litestream
   docker compose up -d
   ```

   原来的数据库连同 WAL 留在 `data/before-restore/`，确认无误后删除。删去 Litestream 的本地状态后，它把换上的数据库整个作为下一个事务上传，换之前的历史仍可恢复。

在另一台机器上恢复：取出仓库，放回 `.env`（同一个 `SECRET_KEY` 和 Litestream 的 token），把第 1 步的 `-o` 换成 `/data/midden.db` 直接恢复到空的数据目录，再 `docker compose up -d`。

部署前的快照（`data/backups/deploy/`）同样按第 3 步换上，把 `mv data/restore/midden.db* data/` 换成 `cp data/backups/deploy/<文件> data/midden.db`（有同名的 `-wal` 时也复制为 `data/midden.db-wal`）。

使用 R2 时，回收不再引用的媒体会同时删除 R2 中的对象，所以恢复较早的数据库后，在那之后删除的媒体不能再显示。`MEDIA_STORE=local` 时数据库与媒体分别备份，可能有少量新媒体在数据库备份中尚未出现（无害），或数据库引用了刚被回收的旧媒体，后者在维护时会被清理；需要严格一致时，先 `docker compose stop` 再备份。缩略图在请求时重新生成。

### 旧的每日备份

`scripts/backup.ts` 与 `install-backup.ts` 已删除：数据库由 Litestream 复制，媒体在 R2。已安装的 LaunchAgent 这样卸载：

```sh
launchctl bootout gui/$(id -u)/org.midden.backup
rm ~/Library/LaunchAgents/org.midden.backup.plist
```

它留下的 `~/backups/midden/auto/`：`daily/` 中是每天的数据库快照（`midden.db.gz`）和 `.env`，Litestream 运行几天、按「恢复」试过一次后可以删除，`.env` 另存一份。`media/` 是改为 R2 之前的媒体镜像，确认 R2 无误后删除：

1. `media-migrate --dry-run` 显示 `0 blobs not yet in the bucket`，最后一次迁移的汇总没有 `missing`、`hash mismatch`、`failed`；
2. 按「步骤」第 4 步抽查过几个公开地址，网页中的图片和视频正常；
3. 可选，逐个核对镜像中的文件在 R2 中的内容（单段上传的对象按 MD5 比较）：

   ```sh
   rclone check ~/backups/midden/auto/media r2:midden --one-way
   ```

   不应有内容不同（`differences`）的文件；R2 中缺少的只应是缩略图（迁移不上传）和已被回收删除的媒体。

4. 删除：`rm -rf ~/backups/midden/auto/media`。

此后 R2 中的原文件是唯一的一份（见「R2 的保护」）。

## 存储用量

「设置 → 管理员面板 → 存储用量」（`GET /v1/storage`，代码在 `server/src/usage/`）分为几组：

- R2：每个存储桶的存储（最近一天的最大值，载荷加元数据）、对象数、本月的 Class A 与 Class B 次数，以及读取分析数据的时间；「刷新」立即重读（距上次不到 1 分钟时不重读）。
- 本月费用：存储、Class A、Class B 各自的已用量、免费额度、已用比例和金额，以及合计（见「费用」）。
- 本机：可用磁盘与总容量、数据库文件（空闲页与 WAL）、缩略图、媒体目录（每天统计）、部署前的数据库备份，以及「按占用空间排列收藏」（收藏库按占用空间排序，`#/?sort=storage`）。
- 数据库：最大的 15 个表和索引及占比、其余合计、总计和统计时间。
- 趋势：每天一点的折线图（与「统计趋势」同一个图表），30 天、90 天或全部：每个存储桶的存储、每天的 Class A 与 Class B 次数、数据库文件、缩略图、可用磁盘。少于两天读数的不画。
- 提醒阈值：见「提醒」。

分析数据不可用时（没有设置 `CF_API_TOKEN` 或 `R2_ACCOUNT_ID`、token 没有 Account Analytics Read、请求失败），页面只有本机的部分：没有 R2、本月费用、R2 的趋势和 R2 的两个阈值。失败记 `storage analytics unavailable`（warn，`reason` 是 Cloudflare 的错误信息）。

### 数据来源

Cloudflare 的 GraphQL Analytics API（`POST https://api.cloudflare.com/client/v4/graphql`，Bearer `CF_API_TOKEN`，[文档](https://developers.cloudflare.com/r2/platform/metrics-analytics/)），一次请求两个数据集：

- `r2StorageAdaptiveGroups`：`max { objectCount payloadSize metadataSize }`，按 `dimensions { date bucketName }` 分组，即每个存储桶每天的最大值（R2 按每天的峰值计费）。
- `r2OperationsAdaptiveGroups`：`sum { requests }`，按 `dimensions { date bucketName actionType }` 分组。`actionType` 按价格页的列表归为 Class A、Class B 或免费（`DeleteObject`、`DeleteBucket`、`AbortMultipartUpload`）；列表外的按名称归类：`Get`、`Head` 开头为 B，`Delete`、`Abort` 开头为免费，其余为 A。成功与失败的请求都计入。

一次查询最多 31 天、每个数据集最多 10000 行（返回达到上限时算作失败）。服务第一次读取时还查询账户的 `settings`（两个数据集的 `maxDuration`、`notOlderThan`），起点取较小的范围与保留期之内第一个完整 UTC 日的 0 点，终点是现在（今天到此刻）；查不到时按 31 天。每 15 分钟读一次（服务每分钟的维护计时器，到时才读），服务启动后第一次打开页面时若还没读过就先读。

### 历史

`storage_snapshots` 每个 UTC 日一行：`r2`（JSON，每个存储桶的 `bytes`、`objects`、`class_a`、`class_b`）、`db_bytes`、`thumbnail_bytes`、`free_bytes`。每次读到分析数据，覆盖其中每一天的 `r2`：过去的日子已是定值，今天的随之增长；分析数据已不覆盖的日子保留原值，所以历史比数据集的保留期长。第一次读取会补出之前约 30 天的 R2 数据。本机的三项每 15 分钟写入今天这一行（当天最后一次的读数），从部署这个版本开始有。每次写入 Litestream 随之多传一个很小的文件。

### 费用

价格是 `server/src/usage/cost.ts` 中的常量 `R2_PRICES`（R2 Standard，[价格页](https://developers.cloudflare.com/r2/pricing/)）：存储 $0.015/GB·月，每月免费 10 GB·月；Class A $4.50/百万次，免费 100 万次；Class B $0.36/百万次，免费 1000 万次；流出免费。只算本月（UTC）到今天，不预测整月：

- GB·月：每天把各存储桶的最大值相加，按 1 GB = 10^9 字节（Cloudflare 的 R2 价格计算器如此；价格页没写明）换算，除以本月的天数后累加。到月底就是每天峰值的月平均。
- 每项金额 = max(0, 已用 − 每月免费额度) × 单价，免费额度按整月扣，账户内的存储桶共用。不按账单的进位（不足一个计费单位按一个算）。
- 例：11 月前 15 天每天 40 GB，累计 15 × 40 / 30 = 20 GB·月，计费 10 GB·月，$0.15。

### 本机

- 数据库文件：`PRAGMA page_count × page_size`，空闲页 `freelist_count`，以及 `midden.db-wal` 的大小。
- 缩略图：`blob_thumbnails` 中已生成的个数与 `size` 之和。
- 媒体目录：每天随数据库组成在 worker 线程中遍历 `media/`，统计文件数与大小（使用 R2 时就是缩略图和尚未上传完的原文件）。
- 部署前的数据库备份：`data/backups/deploy/` 中的文件。
- 可用磁盘：数据目录所在卷的 `statfs`（容器内看到的卷；GB 为 2^30 字节，与网页中其他大小相同）。

### 数据库组成

每天一次（距上次满 24 小时；服务启动后第一分钟就会检查），在 worker 线程中用单独的只读连接运行 `SELECT name, pgsize FROM dbstat WHERE aggregate = TRUE`，线程的 nice 值设为 19。生产库（2.3 GB）约 18 秒，期间服务的事件循环和写入照常进行（WAL 下读不阻塞写）。结果存在 `settings` 表的 `db_composition`（最大的 15 个、其余合计、总计、耗时、媒体目录），日志 `database composition read`，失败记 `database composition failed`。

### 提醒

阈值是管理员设置，存在 `settings` 表，在页面中修改（`PUT /v1/storage/alerts`）：

| 键                           | 默认 | 条件                                                                        |
| ---------------------------- | ---- | --------------------------------------------------------------------------- |
| `storage_alert_cost_usd`     | 5    | 本月 R2 费用超过（美元，0.01–10000）                                        |
| `storage_alert_ops_percent`  | 80   | 本月 Class A 或 Class B 次数超过各自免费额度的这个百分比（1–100，分别提醒） |
| `storage_alert_free_disk_gb` | 10   | 可用磁盘低于（GB，1–100000）                                                |
| `storage_alert_db_gb`        | 5    | 数据库文件超过（GB，1–100000）                                              |

每 15 分钟检查一次。越过阈值时 Bot 给所有者发一条，如「存储用量：本月 R2 费用 $5.12，超过 $5」「存储用量：数据盘可用 9.5 GB，低于 10 GB」「存储用量：数据库文件 5.5 GB，超过 5 GB」「存储用量：本月 R2 Class A 操作 812,345 次，超过免费额度 100 万次的 80%」；回到阈值以内时再发一条「…，不再超过 …」（磁盘为「不再低于」）。条件一直成立时不重复。已提醒的状态存在 `settings` 表的 `storage_alert_state`，重启后不会重发。按月的三项（费用、两类操作）到下个月自动结束，不发回落的消息。分析数据不可用时不检查这三项，状态不变。阈值修改在下一次检查时生效，调高阈值使条件不再成立时也会发回落的消息。没有配置 Bot 时不发。

## 维护任务

服务每分钟运行一次维护：

- 超过 1 小时仍未完成且没有对应任务的抓取标记为中断；
- 删除不再保存、也没有进行中抓取的收藏及其独有内容；
- 没有产生新版本的抓取，其原始响应保留 3 天，之后只要不是这个收藏最新一次的抓取就删除；产生了新版本的抓取的原始响应一直保留；
- 不再被引用的媒体文件 24 小时后删除（使用 R2 时同时删除对象并清除边缘缓存）；
- 不再有任何原始响应使用的存储桶对象 24 小时后删除（见「原始响应（R2）」）；
- 删除抓取结束一天以上仍留着的暂存数据（`capture_staging`，没能提交的列表目标的预取）；
- 为缺少缩略图的媒体补做缩略图；
- 清理过期的网页会话、通行密钥挑战与 `/passkey` 链接；
- 每 15 分钟读取存储用量并检查提醒，每天一次统计数据库组成（见「存储用量」）；
- 把空闲页面还给文件系统：空闲页面达到 1024 页（4 MiB）时运行 `PRAGMA incremental_vacuum(4096)`，每次最多 16 MiB，两次之间至少 15 分钟，所以积压最多每小时释放 64 MiB；日志 `released free database pages` 给出这次释放的页数、剩余空闲页数（`free`）和总页数（`pages`）。这要求数据库是 `auto_vacuum = INCREMENTAL`：新建的数据库默认如此，已有的数据库要 `VACUUM` 一次才能切换（生产环境已于 2026-11-25 切换），否则这一步什么也不做。

## 从 Go 版迁移

2026-11-24 起生产环境运行本实现。旧的 Go 多服务版本（PostgreSQL、SeaweedFS、gRPC adapter）保存在 `golang` 分支；其数据由 `import-legacy` 分支中的导入工具（`tools/import-legacy/`）迁入 SQLite 与 `media/`，导入后会重建 `catalog`。旧版的 Bot 按钮、REST token、媒体链接不再可用。

## 排查

- `GET /healthz` 返回 `ok` 表示 HTTP 服务与数据库正常，不含 Telegram；Bot 的状态看 `GET /v1/instance` 的 `bot`，或日志中的 `telegram bot started`、`telegram bot start failed; retrying`、`telegram bot could not start`。
- 日志为 JSON，`job failed` 表示任务最终失败，`delivery rejected` 表示 Telegram 拒绝了某条消息。
- 抓取失败：每次尝试都有记录，自动重试不会覆盖之前的日志。`upstream request failed` 是失败的上游请求：`upstream` 中有来源（`fxtwitter`、`x-graphql`、`instagram` 等）、接口、去掉凭据与查询 token 的 URL、状态码、`retry-after` 与 `x-rate-limit-*` 等响应头、响应开头 2 KB（已遮盖 token），另有任务编号与次数、`captureId`、目标和错误分类（`errorCode`、`retryable`、`final`）。之后还会重试的为 warn，不再重试的为 error，抓取最终仍成功的为 info。`job will retry` / `job failed` 是任务每次失败的结果与耗时，`capture failed` 是抓取记录最终失败。抓关系网的任务（`jobType` 为 `relations`）带 `relationFetchId`、`list` 与 `providerId`（`fxtwitter` 或 `x-session`）；用采集账号读时，查询限流后的切换记为 `relations query rate-limited; switching to the other query`，两个查询都限流时记为 `both relations queries rate-limited; waiting for the earlier reset`。
- 日志位置：容器标准输出（`docker compose logs`，json-file 按 10 MB × 5 轮转，部署重建容器后清空），以及数据目录中的 `logs/midden.log`（按 10 MB 轮转，保留 `midden.log` 与 `.1`～`.4` 共 5 个文件，跨部署保留）。查找某个账号的失败：

  ```sh
  grep -h xiaomouzovo data/logs/midden.log* | grep -E '"level":(40|50)'
  ```

- 找不到 ffmpeg 时启动日志会提示，缩略图停用；之后装上 ffmpeg，维护任务会补做缩略图。
- Cloudflare：`cloudflare token verification failed` 表示启动时 `CF_API_TOKEN` 没有通过验证，服务随即退出（见「配置」）；`storage analytics unavailable` 表示存储用量读不到分析数据，页面只显示本机部分。
- Litestream：`litestream heartbeat missing` 表示超过「备份心跳超时」（默认 20 分钟）没有收到它的心跳，看 `docker compose logs litestream` 中的 `monitor error`、`sync error`（如 token 错误时的 403、网络错误）；`litestream heartbeat listener failed` 表示服务没能监听 8081 端口。见「Litestream」。
