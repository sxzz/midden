# 运维

## 部署结构

生产环境使用 `compose.yaml` 运行同一个镜像的两个容器，镜像内含 Node.js 26，不含其他程序（缩略图与媒体尺寸来自平台，见[架构](architecture.md#缩略图)）：`midden` 是网页进程（`MIDDEN_ROLE=web`：HTTP、Telegram Bot、Litestream 心跳），`midden-worker` 运行任务队列和定时的维护（`MIDDEN_ROLE=worker`），见[架构](architecture.md#进程)。两个容器读同一个 `.env`，以非 root 用户运行，数据目录都挂载到 `/data`。`midden-worker` 等 `midden` 健康后才启动（迁移由网页进程应用），它的健康检查是容器内 `127.0.0.1:8082/healthz`，不对外发布端口。可选的第三个容器 `litestream` 把数据库持续复制到 R2，见「Litestream」。

对外访问需要 HTTPS 反向代理（例如 Cloudflare Tunnel），把一个域名整个转发到服务端口。网页与 API 可以在同一个域名：本服务在 `/` 提供网页（构建时不设 `VITE_API_URL`），在 `/v1/`、`/media/`、`/agent/v1/`、`/healthz` 提供 API，网页的 `/agent.md` 是给 AI agent 的说明。也可以分开（见下面的「网页单独部署」）。Mini App 与通行密钥都要求 HTTPS。

## 网页登录

浏览器用通行密钥登录，Telegram 中的 Mini App 照旧自动登录。

- 网页可以登录的域名：`WEB_APP_URL` 的域名，加上在网页「设置 → 管理员面板 → 域名」中添加的域名。不在列表中的域名不能登录，也不能写入。
- 第一次登录：在 Telegram 私聊 Bot 发送 `/passkey`，点开要登录的域名对应的按钮，在打开的页面上创建通行密钥，创建后即已登录。链接 10 分钟内有效，只能用一次。
- 通行密钥只能在创建它的域名上使用。每个域名各需要一个：在该域名上用 `/passkey` 的链接创建，或在已登录的页面「设置 → 通行密钥」中添加。
- 通行密钥全部删除后，再发送 `/passkey` 即可添加新的。
- 新增域名：在已登录的域名上打开「设置 → 管理员面板 → 域名」，输入新域名的 https 地址添加；然后在 Telegram 发送 `/passkey`，点开新域名的按钮，在那里创建它的第一个通行密钥。
- 删除域名：同时删除这个域名的通行密钥，之前发出的这个域名的 `/passkey` 链接失效。`WEB_APP_URL` 的域名不能删除。添加和删除域名时 Bot 给所有者发一条消息。

用户（见[多用户设计](design/multi-user.md)）：所有者是唯一的管理员；其他人是查看者，只能读，不能采集、更新、整理（标签、备注、收藏夹）、分享或删除，网页上也不显示这些操作。

- 邀请：管理员在「设置 → 管理员面板 → 用户」点「邀请」，填备注（1 到 32 字，也是新用户默认的名字），生成一次性链接 `WEB_APP_URL` 下的 `/invite#<令牌>`。链接只显示一次，7 天内有效，只能注册一次；未用的邀请列在用户下面，可以撤销。
- 注册：朋友打开链接，填名字和通行密钥名称，创建通行密钥后即以查看者登录。多用户只在 `WEB_APP_URL` 的域名上：注册只在这个来源上接受，查看者的通行密钥也只能在这里登录。链接失效（过期、已用、已撤销）时页面写「邀请链接已失效」。Bot 不发通知。
- 查看者看到的：导航只有「探索」「关系」「设置」；收藏夹只有公开中的（看不到它们的条件，在收藏夹内筛选由服务端以收藏夹为起点）；没有标签和「我的整理」；设置只有「通行密钥」（含已登录的设备）、「API 令牌」、「关于」。Mini App 只给管理员。
- 管理：「用户」页列出每个用户的通行密钥、已登录设备和令牌各有几个。「改名」；「撤销」删除他的通行密钥、登录和令牌，他从下一个请求起退出，用户保留为「已撤销」，不能恢复，要再用就重新邀请；「删除」连用户一起删除。管理员自己没有这些操作。用户和邀请只能由管理员的网页会话管理，令牌不能。
- 查看者丢了所有通行密钥只能重新邀请。在钥匙串里删掉被删除用户的通行密钥，否则登录时还会列出它。

### 网页单独部署

生产环境的网页在 Cloudflare 静态托管（`pnpm --filter @midden/web run deploy`，`https://web.example.com/`），API 在另一个域名（`https://api.example.com`，隧道转发到本服务）：

- 构建时 `VITE_API_URL` 设为 API 的来源，网页的请求都发到那里，带上 API 域名的会话 Cookie（`credentials: 'include'`）；`scripts/prepare-web-assets.ts` 把它加进 CSP 的 `connect-src`、`img-src`、`media-src`；构建时还要设 `MIDDEN_MEDIA_URL` 为媒体的公开域名（`MEDIA_PUBLIC_URL` 的来源），没有设置时构建失败。
- `WEB_APP_URL` 是网页的地址（`https://web.example.com/`）：API 只对它和「域名」中添加的来源回答 CORS。网页的域名与 API 必须是同一个站点（同一个注册域名，如这里的 `example.com`），否则阻止第三方 Cookie 的浏览器（Safari 等）不会把 Cookie 发给 API，网页无法登录。
- 网页的地址是根下的普通路径（如 `/settings/admin/jobs`），不是文件的路径都返回 `index.html`：Cloudflare 上由 `web/wrangler.json` 的 `not_found_handling: "single-page-application"` 回答，随部署生效，不需要在控制台另外设置。其他静态托管也需要同样的回退。
- 以前的 `/app/…` 地址由 `_redirects`（`scripts/prepare-web-assets.ts`）永久重定向到根下同样的路径。网页域名上旧的 API 路径（`/v1/` 等）不再转发也不重定向：重定向到另一个来源时客户端会去掉 `Authorization`，调用的地方要改成 API 的域名。
- 会话 Cookie 只属于 API 的域名，所以网页或 API 换了域名后要重新登录一次；通行密钥属于网页的域名（RP ID），网页域名不变就照常可用。

## API 令牌

脚本和 AI agent 用 API 令牌访问 `/v1` 与 `/agent/v1`（见[架构](architecture.md#agent-api)；给 agent 的说明在网页的 `/agent.md`，把它的地址、API 的地址和令牌交给它；网页创建或轮换令牌后给出这三行，一次复制）。

- 网页「设置 → API 令牌」：创建（名称、只读或读写、过期时间或永不过期），令牌只显示一次；之后可改名称和过期时间、轮换、撤销，并看到上次使用时间和最近 30 天的请求次数。每个用户只看到、只管理自己的令牌，只能在网页会话中管理，令牌自己不能。
- 查看者的令牌：表单没有权限的选择，只能建只读令牌，只能用于 `/agent/v1`（在 `/v1` 上答 403）；能读到的与他在网页上看到的相同（没有标签、备注，收藏夹只有公开中的），并发与管理员分开。撤销或删除这个用户时他的令牌一起删除。
- 命令行：`midden token create | list | revoke | expires`，见下一节「命令行」。

- 令牌不能删除收藏、媒体、标签、收藏夹、定期更新等，也不能管理令牌、已登录的设备、通行密钥，不能添加或删除域名，所以令牌换不来网页会话；只读令牌不能写入；读写令牌可以取消公开分享、移除采集账号（不删除内容）。agent 接口所有令牌合计同时最多 2 个请求。
- 这个版本之前创建的令牌迁移为读写、永不过期，原来的名字成为名称，原令牌照常可用。
- 本地开发服务器（`.local/dev.sh`）的 Vite 代理用 `.local/dev-token` 中的令牌替网页登录。它迁移为读写令牌后照常可用；开发模式（不设 `NODE_ENV=production`）下读写令牌在 `/v1` 上等同网页会话，所以开发服务器上的删除和令牌管理也照常可用。生产环境没有这个例外。

## 命令行

管理命令在容器里运行，镜像里有 `midden` 这个命令（`/usr/local/bin/midden`，等价于 `node server/src/cli.ts`，后一种写法照常可用）：

```sh
docker compose exec -T midden midden --help               # 全部命令
docker compose exec -T midden midden token create --help  # 某个命令的选项
docker compose exec -T midden midden --version            # 镜像的提交（本地开发为 dev）
```

本地开发用 `pnpm --filter @midden/server cli <命令>`（读取仓库根目录的 `.env`）。下面的示例省略 `docker compose exec -T midden`。

约定，方便脚本和 AI agent 使用：

- 标准输出只有数据（令牌、列表、JSON、文件路径、原始字节），说明和错误写在标准错误；没有输出数据时不输出空行。
- 退出码：0 成功；1 操作失败（找不到令牌、过期时间无效、MEDIA_STORE 不是 r2 等）；2 命令行写错（未知命令或选项、缺少参数），原因和用法提示在标准错误。
- 列表类命令有 `--json`：输出一行 JSON，字段名固定（下表）。
- `--help` 和 `--version` 不需要配置（`SECRET_KEY` 等）；其余命令按 `.env` 读取配置，数据库在 `DATA_DIR` 下。

| 命令                                                                          | 作用                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token create --ro\|--rw [--label 名称] [--expires 时间]`                     | 创建令牌。`--ro` 或 `--rw` 必须给一个；`--label` 默认 `cli`（1 到 64 字）；`--expires` 是 ISO 时间、`30m`/`12h`/`7d` 这样从现在算起的时长，或 `never`（默认）。标准输出只有令牌本身，名称、权限和过期时间写在标准错误。令牌只显示这一次 |
| `token list [--json]`                                                         | 列出令牌，最早创建的在前：名称、权限、id 前缀、创建时间、过期时间（已过期的标注）、上次使用时间、今天（UTC）的请求数。不会也不可能输出令牌本身，因为数据库里只有它的摘要；id 只显示足以区分的前缀                                       |
| `token revoke <id或名称> [--json]`                                            | 撤销令牌：令牌和它的用量记录立即删除，原来的令牌值马上失效。名称对应多个令牌时不撤销，在标准错误列出它们的 id 前缀，用前缀再来一次                                                                                                      |
| `token expires <id或名称> <时间> [--json]`                                    | 改过期时间，写法同 `--expires`（可提前、延后或 `never`；已过期的令牌设一个更晚的时间即恢复可用）。名称对应多个令牌时同样拒绝                                                                                                            |
| `backup <目录> [--json]`                                                      | 在线备份数据库（服务运行中即可）到 `<目录>/midden-<时间>.db`，标准输出是文件路径                                                                                                                                                        |
| `media-migrate [--dry-run] [--concurrency N] [--verify-download] [--limit N]` | 把本地媒体原文件上传到 R2，见「迁移现有媒体」。需要 `MEDIA_STORE=r2`                                                                                                                                                                    |
| `media-prune-local [--dry-run] [--concurrency N] [--verify-download]`         | 删除 R2 里已有可验证副本的本地原文件。需要 `MEDIA_STORE=r2`                                                                                                                                                                             |
| `raw-get <抓取 id> [序号] [--json]`                                           | 列出一次抓取的原始响应；给序号则把那一条的原始字节写到标准输出                                                                                                                                                                          |
| `maintain [--vacuum] [--rebuild-search]`                                      | 离线整理数据库，网页进程、worker 和 Litestream 都停止时才能运行，见「数据库整理」                                                                                                                                                       |

`token list --json` 的每个元素：

```json
{
  "id": "01a21bb2-ad",
  "label": "research",
  "permission": "ro",
  "created_at": "2026-11-27T06:30:24.392Z",
  "expires_at": "2026-11-27T07:30:24.392Z",
  "expired": false,
  "last_used_at": null,
  "requests_today": 0
}
```

`expires_at` 和 `last_used_at` 为 `null` 表示永不过期、从未使用；`id` 是前缀，可直接用于 `token revoke` 和 `token expires`。`raw-get --json` 是 `[{"position","location","size","content_type","source_url"}]`；`backup --json` 是 `{"file"}`；`token revoke --json` 是 `{"revoked": 名称}`；`token expires --json` 是 `{"label","expires_at"}`。`media-*` 和 `maintain` 的报告是给人看的文本，写在标准输出。

示例：

```sh
# 给 agent 一个读写令牌，7 天后过期
midden token create --rw --label sync --expires 7d
# 看有哪些令牌、谁在用
midden token list
midden token list --json | jq '.[] | select(.requests_today > 0) | .label'
# 延长 / 取消过期
midden token expires sync 30d
midden token expires sync never
# 撤销
midden token revoke sync
```

冒烟测试（部署后确认 agent 接口可用），令牌 1 小时后自动过期，用完立即撤销：

```sh
SECRET=$(docker compose exec -T midden midden token create --ro --label smoke --expires 1h)
curl -fsS -H "Authorization: Bearer $SECRET" https://<API 的域名>/agent/v1/whoami
docker compose exec -T midden midden token revoke smoke
```

## 发布

- 镜像：`main` 上每次推送，`test` 工作流的 `image` 任务与检查、浏览器测试同时在 arm64 运行器上构建 arm64 镜像（生产环境是 Apple 芯片的 Mac，只发布 arm64），立即推送 `ghcr.io/sxzz/midden:sha-<提交>`；三者都通过后，`publish` 任务把 `ghcr.io/sxzz/midden:latest` 指向它（在镜像仓库中复制清单，不重新构建）。部署读的是 `latest`，所以没通过检查的提交不会部署。其他分支与 PR 只构建并做健康检查，不发布。服务器上用 `docker compose pull && docker compose up -d` 更新。
- 网页：`test` 在 `main` 上通过后，`web` 工作流把网页部署到 Cloudflare 静态托管（仓库变量 `MIDDEN_WEB_HOSTNAME` 指定域名，路由 `<域名>/*`；仓库变量 `MIDDEN_API_URL` 是构建进网页的 API 地址，`MIDDEN_MEDIA_URL` 是媒体的公开域名（与服务的 `MEDIA_PUBLIC_URL` 相同，写进网页的 CSP），任一没有设置时部署失败）。

## 日常操作

```sh
docker compose ps
docker compose logs --tail=100 midden          # 网页进程
docker compose logs --tail=100 midden-worker   # 任务
docker compose logs --tail=100 litestream      # 启用 Litestream 时
docker compose pull && docker compose up -d    # 更新（自动部署见下）
```

手动 `docker compose up -d` 先换网页进程（它应用迁移），再换 worker；其间旧的 worker 若发现数据库有它不认识的迁移，就停止取任务，等被换掉。自动部署先停 worker，见下。

暂停后台任务（例如在数据库上做别的事之前）：网页「设置 → 管理员面板 → 后台任务」的「暂停全部」，或只暂停上传、原始响应移出；采集记录页可以暂停单次更新。暂停存在数据库中，重启和部署后仍然有效，要手动「继续」。`docker compose stop midden-worker` 也能停下全部任务（正在运行的回到队列），网页照常服务，新的任务排队等它回来。

服务启动的顺序见 [架构](architecture.md#启动顺序)：先监听 HTTP，Telegram Bot 在后台启动，Telegram 慢或不可用不影响 `/healthz`。`compose.yaml` 的健康检查超时 10 秒，启动后 2 分钟内（`start_period`）的失败不计入；两个容器都一样。

数据库迁移在网页进程启动时自动应用；随后补齐收藏列表的索引表 `catalog` 中缺失的行（首次部署或导入数据后可能需要几秒）。worker 等迁移应用完再开始。

日志也写在数据目录：网页进程 `logs/midden.log`，worker `logs/worker.log`。

## 自动部署

`main` 的 test 工作流通过后会发布镜像 `ghcr.io/sxzz/midden:latest` 与 `:sha-<提交>`。部署机上的 webhook 收到这次运行完成的事件后，从 `origin/main` 取出 `scripts/deploy.ts` 执行：

1. 确认部署目录（默认 `~/midden`）没有本地改动，最新镜像的提交在 `origin/main` 上，且与正在运行的版本不同；
2. 依次停掉正在运行的 worker（`docker compose stop midden-worker`，正在运行的任务回到队列；那个版本没有 worker 时跳过，由它的 `compose.yaml` 判断：`docker compose config --services`）、网页进程，启用 Litestream 时随后停掉它（在服务之后：服务关闭时它还持有数据库，服务的关闭就不是最后一个连接，不会把 WAL 写回并重置；它先把服务最后写的内容复制走，自己关闭时再把 WAL 写回数据库）。部署本来就要重启服务，停下来再复制，不会像在线备份那样在运行中的服务旁持有一个读事务好几分钟（那会让 WAL 涨过 500 MB，Litestream 随之做阻塞的 TRUNCATE 检查点，服务的写入因 `database is locked` 失败）；旧的 worker 也不会在新版本迁移之后继续写；
3. 备份数据库到 `data/backups/deploy/`：把 `midden.db` 和不为空的 `-wal` 复制过去（`copyFile` 的 `COPYFILE_FICLONE`：APFS 上是写时复制的克隆，几 GB 也立即完成，文件系统不支持时普通复制）。全部停止时两者合起来是一致的。不做检查点：截短 WAL 会让 Litestream 找不到它上次同步到的位置，重新上传整个数据库（见「Litestream」的「部署与 WAL 中的位置」）。保留最近 2 份：这次的与上一次的；启用 Litestream 时只保留这次的 1 份，因为上一次的只用于新版本运行一段时间后才发现问题的情况，Litestream 可以恢复到那之前的任一时刻。复制失败时重新启动原来的版本（与 Litestream），结果为 `failed: could not back up the database; … is running again`；
4. 切换到该提交。启用 Litestream 时先启动它（`docker compose up -d litestream`，`litestream.yml` 有改动时加 `--force-recreate`，compose 看不到文件内容的变化），再等它的一次 `monitor-interval`（从该提交的 `litestream.yml` 读取，读不到时按 10 秒）加 5 秒：它启动后第一次同步时核对并占住自己在 WAL 中的位置，此前服务的写入可能从头覆盖 WAL，让它重新上传整个数据库。它启动失败不算部署失败，不再等待，结果末尾加上 `; litestream did not start`。然后用 `:sha-<提交>` 镜像 `docker compose up -d --wait midden`，并检查 `/healthz`：最多 5 次，间隔 6 秒（约 30 秒），一次没有回应不算不健康。然后 `docker compose up -d --wait midden-worker`（该版本有 worker 时），它的健康检查不通过也算不健康；
5. 新版本不健康时停掉它（先 worker 后网页进程），换回第 3 步的副本（连同复制的 `-wal`，删掉 `-shm`），切回原来的版本，先启动网页进程、再启动 worker。启用 Litestream 时：先停 Litestream 再停服务（它一直打开着数据库和 WAL，换文件时不能在运行）；换回数据库后删除它的本地状态 `data/.midden.db-litestream/`；切回后同样先启动 Litestream（即使原来的版本随后启动失败，它也在运行）。Litestream 发现本地数据库落后于存储桶，从存储桶取得位置，把换回的数据库整个作为下一个事务上传，回滚前的历史仍可恢复（见「Litestream」）。

服务在第 2 步到第 4 步之间停止，通常不到一分钟，启用 Litestream 时多约 15 秒。部署不会让 Litestream 重新上传整个数据库；回滚会（换回的数据库与它的位置对不上）。

结果通过 Bot 发给 `DEPLOY_NOTIFY_CHAT_ID`（默认 `OWNER_TELEGRAM_ID`），日志在 `.local/deploy-webhook/`。每次发送超时 10 秒；网络错误、超时、429（按 `retry_after` 等待，最长 60 秒）和 5xx 最多重试 3 次，间隔 2、5、15 秒；其他 4xx 不重试。每次失败在 webhook 的 stderr 写一行带 ISO 时间的记录（错误、`cause.code`、`cause.message`、HTTP 状态与 Telegram 的 `description`，不含 token 和 chat id），最终结果（`notification sent` 或 `notification failed after N attempts: …`）也写入该次部署的日志文件。webhook 启动时设置 `dns.setDefaultResultOrder('ipv4first')`：部署机到 api.telegram.org 的 IPv6 不通，让 IPv4 地址排在前面；只改变顺序，没有 IPv4 的主机仍可连接。也可以手动运行：

```sh
node scripts/deploy.ts --check   # 只检查，不改动
node scripts/deploy.ts
```

安装 webhook（macOS LaunchAgent，复制到 `~/.local/share/midden/`，监听 `127.0.0.1:18090/hooks/deploy`）：

```sh
node scripts/install-deploy-webhook.ts --dir ~/midden
```

GitHub 仓库的 webhook 发送 Workflow runs 事件到 `https://<API 的域名>/hooks/deploy`，密钥与 `.local/deploy-webhook.secret` 相同；隧道把该路径转发到 18090 端口。网页的域名整个由 Cloudflare 静态托管回答，不能用它。升级 Node 后重新运行安装命令。修改 `scripts/deploy-webhook.ts` 后同样要重新运行安装命令：安装的是副本，安装脚本会 `bootout` 再 `bootstrap` LaunchAgent `org.midden.deploy-webhook`，即重启它。

## 依赖更新

Renovate（账号级安装的 GitHub App）按 `.github/renovate.json5` 每周开一批 PR：配置继承 `github>sxzz/renovate-config`（每周、非主版本合并为一个 PR），并开启 `automerge`。PR 的 test 工作流通过后自动合并，合并到 `main` 即触发上面的自动部署。`third_party/**`（vendored 的 Atmosphere）不在更新范围内。GitHub Actions 的更新保持开启：工作流按提交摘要固定并带版本注释，Renovate 会同时更新摘要和注释。

预设不会更新 `package.json` 的 `devEngines`（Node、pnpm 版本）和 Dockerfile 的 `ALPINE_VERSION`，这些需要手动升级。

## 媒体存储（Cloudflare R2）

默认 `MEDIA_STORE=local`：媒体只在数据目录的 `media/` 中，网页通过本服务的签名链接 `/media/…` 读取。设为 `r2` 后：

- 原文件（图片、视频）存到 R2 存储桶，对象键与本地路径相同：`ab/cd/<sha256>`。浏览器直接从公开域名读取 `MEDIA_PUBLIC_URL/ab/cd/<sha256>`（`https://media.example.com/ab/cd/<sha256>`），由 Cloudflare 边缘缓存；每个对象都带 `Content-Type` 与 `Cache-Control: public, max-age=31536000, immutable`。
- 新下载直接流式写入 R2，不写本地文件（8 MiB 以内一次 PUT，更大的分段上传到 `incoming/<uuid>` 再在服务端复制到哈希键，见[架构](architecture.md#媒体链接)）；读回确认后记下 `remote_at`，接口立即给出公开地址。写入失败时这次下载失败，由下载任务重试（`job will retry`，`jobType: download`），不留下临时对象。
- 生命周期规则（一次性设置）：在「R2 → midden → Settings → Object lifecycle rules」加一条，前缀 `incoming/`，删除 1 天以前的对象，并中止 1 天以前未完成的分段上传（R2 默认 7 天）。只在进程在分段上传或复制的中途退出时才会留下这些，正常的失败会自己清理。
- 这一版之前下载、仍在本地 `media/` 的原文件由后台任务 `upload` 上传。上传带 `Content-MD5` 和签名的 SHA-256，R2 收到的内容不符会拒绝；R2 中已有相同字节的对象时不再上传；上传后读回大小、ETag（即 MD5）和两个响应头，确认后才在 `blobs.remote_at` 记下，接口从此给出公开地址，之前仍给本地签名链接。上传失败从 30 秒起翻倍重试、最长间隔 1 小时，共 12 次（约 7 小时），每次记 `job will retry`，放弃时记 `media upload gave up; the file stays local`，这些媒体由 `media-migrate` 补传。
- 上传确认、记下 `remote_at` 后，同一个 `upload` 任务立即删除本地原文件（这一版之前下载的），此后 R2 中是唯一的一份（没有其他备份，见「R2 的保护」）。删除在这个媒体的键的锁内进行（下载写入、回收删除同一个键时也取这个锁），并在锁内再次确认 `remote_at` 仍在。这个键同时是某个还没移到 R2 的缩略图的文件时不删除（它从本地提供，移走后再删）；缩略图从平台下载，不读原文件，所以不必等它。

  删除失败时任务按上传的间隔重试（记 `job will retry`），`remote_at` 不会被清除；重试用完时记 `deleting the local copy of uploaded media gave up; media-prune-local removes it`。

- 删除时正在读这个文件的地方不受影响：Telegram 发送、带文件名的下载和 `/media/…` 都先打开文件再读，已打开的文件删除后仍能读完；打开前已删除时改从 R2 读。之后再下载到相同内容（已在 R2 中的媒体）时不再写本地文件。
- 缩略图同样存到 R2（同名键），确认后删除本地文件，浏览器从公开域名读取（原因见[架构](architecture.md#缩略图)）。下载时随即上传，失败的和这一版之前只在本地的缩略图由维护任务在 worker 空闲时移走（见「维护任务」），日志 `moved thumbnails to the remote store`（`moved` 个数）；R2 中已有相同字节的对象（以前 rclone 复制过去的）直接沿用，不再上传。还没移走的缩略图经本服务提供，响应头为 `Cache-Control: public, max-age=31536000, immutable`（视频和带文件名的下载仍为 `private`，不进 CDN）。本地和 R2 中都找不到缩略图文件时，请求它的 `/media/…` 当场从平台再下载一次（资产记下的 `thumbnail_url`）并移到 R2；字节不同时记在新的键下，并把请求重定向过去。平台不再提供时（Instagram 的地址会过期、帖子已删除），图片重定向到原文件，视频返回 404。
- 带文件名的下载经本服务从本地或 R2 流式返回，带 `Content-Disposition`。服务端的读取（Telegram 发送、下载）都先读本地，没有时通过 S3 API 读 R2，不经公开域名。
- 不另设本地原文件缓存：缩略图从平台下载，不读原文件；Telegram 按 `file_id` 复用已上传的文件；其余读取（第一次发送到 Telegram、带文件名的下载）在本地原文件删除后都读 R2。
- 设为 `r2` 并运行后，不能再改回 `local`：本地实现不读 R2，已删除本地原文件的媒体会缺失。要回退，先把存储桶下载回 `media/`（如 `rclone copy r2:<bucket> ~/midden/data/media`）再改。
- 删除：不再被引用的媒体（删除收藏、删除媒体）24 小时后删除本地文件（还在时）；R2 中有对象时先清除其公开地址的边缘缓存（`purge_cache`），再删除对象。清除失败时对象保留，稍后重试；没有设置 `CF_ZONE_ID` 时记 `cache purge skipped: no CF_ZONE_ID configured` 并跳过清除。
- 存储类别为存储桶默认的 Standard。

### 配置

| 变量               | 说明                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `MEDIA_STORE`      | `local`（默认）或 `r2`                                                                       |
| `R2_ACCOUNT_ID`    | Cloudflare 账户 ID（32 位十六进制）；S3 端点为 `https://<ID>.r2.cloudflarestorage.com`       |
| `R2_BUCKET`        | 存储桶名，如 `<bucket>`                                                                      |
| `MEDIA_PUBLIC_URL` | 存储桶的公开域名，如 `https://media.example.com`                                         |
| `CF_API_TOKEN`     | Cloudflare 账户 API token（见下）：R2 的 S3 密钥由它派生，清除缓存与存储用量的分析数据也用它 |
| `CF_ZONE_ID`       | 公开域名所在 zone 的 ID；不设置则删除时不清除边缘缓存                                        |

`MEDIA_STORE=r2` 时前五项必填，缺少时启动失败并列出缺少的变量；错误信息不含密钥。启动日志 `media store` 写明当前的 `store`。

S3 密钥由 `CF_API_TOKEN` 派生（[Cloudflare 文档](https://developers.cloudflare.com/r2/api/tokens/)）：Access Key ID 是这个 token 的 id，Secret Access Key 是 token 值的 SHA-256（十六进制）。服务启动时、开始监听之前请求 `GET https://api.cloudflare.com/client/v4/accounts/<R2_ACCOUNT_ID>/tokens/verify` 取得 id（每次请求 10 秒超时；网络错误、超时、5xx、429 时共试 3 次，最多约 33 秒），进程运行期间一直使用。成功记 `cloudflare token verified`；失败记 `cloudflare token verification failed`（error，`reason` 是状态码与 Cloudflare 的错误信息），随后以 `Invalid configuration: CF_API_TOKEN could not be verified: …` 退出，与缺少变量一样：`/healthz` 不会响应，自动部署因此回滚。日志与错误信息都不含 token 和派生的密钥。`media-migrate`、`media-prune-local` 同样先验证。

`CF_API_TOKEN` 与 `R2_ACCOUNT_ID` 都设置时（不论 `MEDIA_STORE`），「存储用量」读取 R2 的分析数据，见「存储用量」。

### Cloudflare

需要配置：存储桶 `<bucket>` 绑定自定义域名（如 `media.example.com`）；该域名的 Cache Rule（Edge TTL 忽略源站、1 年，300–526 不缓存，Browser TTL 遵循源站，缓存键忽略查询串）；Response Header Transform Rule 给所有响应（包括缓存命中）加 `Access-Control-Allow-Origin: *`。

还需要：

1. Smart Tiered Cache：`<zone>` zone →「Caching → Tiered Cache」，选 Smart Tiered Caching。边缘未命中时先问上层节点，减少回源 R2 的读取次数。
2. 一个账户 API token（Account API Tokens 中自定义创建），权限：
   - **Workers R2 Storage Bucket Item Write**，存储桶 `<bucket>` 与备份存储桶；
   - Zone → **Cache Purge**，zone `<zone>`；
   - **Account Analytics Read**。

   token 值填入 `CF_API_TOKEN`；zone 的 Overview 页右侧的 Zone ID 填入 `CF_ZONE_ID`。rclone 用由它派生的 S3 密钥，见「迁移现有媒体」。

3. 缩略图的边缘缓存（可选，只用于还没移到 R2 的旧缩略图，全部移走后可删）：在应用所在域名加一条 Cache Rule，匹配路径以 `/media/` 开头，Eligible for cache，Edge TTL 选「Use cache-control header if present」，这样 `private` 的视频与下载不进缓存；缓存键保留查询串（签名在其中）。

### 迁移现有媒体

`media-migrate` 处理所有尚未记为在 R2 中的媒体（`blobs` 中的原文件，不含缩略图）：

1. 计算本地文件的 SHA-256 与 MD5，SHA-256 与键不符时报告 `hash mismatch` 并跳过，不上传。
2. 读取 R2 中同键对象的大小和响应头（HEAD）：
   - 不存在，或大小不同：上传，读回确认。
   - 大小相同：用对象带的校验值与本地比较，依次是 `x-amz-checksum-sha256`、ETag（单段上传时即 MD5；分段上传的 ETag 带 `-<段数>`，不能用）、rclone 为分段上传记下的 `x-amz-meta-md5chksum`。有一项不符就重新上传；都相符则保留，不重新传输。一项都没有时重新上传（记 `replacing <哈希>: no checksum to compare`，计入 `replaced`），因为记下后本地文件随即删除，只按大小认定不够；加 `--verify-download` 则改为下载并计算 SHA-256，相符就保留。
   - 保留的对象 `Content-Type` 或 `Cache-Control` 不对时，在服务端把对象复制到自身（`CopyObject`，`x-amz-metadata-directive: REPLACE`）改正，其他元数据照旧，不重新传输，再读回确认。
3. 在 `blobs.remote_at` 记下，网页从此使用公开地址。
4. 删除本地原文件，规则与上传任务相同：同时是缩略图文件的保留（汇总中计入 `kept … for thumbnails`）。

本地文件缺失时，只有加 `--verify-download` 且 R2 中的对象哈希相符才记下，否则报告 `missing locally`。命令与服务同时运行：服务的上传任务在此期间已记下（并删除本地文件）的媒体计入 `by the server meanwhile`，不算问题。可以随时中断，再次运行时跳过已记下的，其余重新检查，已上传但未记下的按校验值保留；中断在记下与删除之间、或删除失败（计入 `failed`）时，本地文件留给 `media-prune-local`。`--dry-run` 不上传、不写入、不删除，汇总中的 `would delete N local files` 是会删除的本地原文件数与大小。`--concurrency N`（默认 4）同时处理的数量，`--limit N` 只处理前 N 个。每 5 秒输出一次进度，结束时输出汇总，并给出一个已记下媒体的公开地址；有失败、哈希不符或缺失时退出码为 1。R2 中不属于任何媒体的对象（如 rclone 一并复制的缩略图）不会被读取或修改；它们的键以后被回收时随之删除。

`media-prune-local` 删除已记为在 R2 中、且再次确认过的本地原文件：对象存在，大小、`Content-Type`、`Cache-Control` 正确，并且上述校验值之一与本地文件相符（或加 `--verify-download` 后下载比较）。没有校验值的对象保留本地文件并列出；对象不对时保留本地文件、清除 `remote_at`（网页改回本地链接，下次 `media-migrate` 重新上传）。还没移到 R2 的缩略图（包括同时是这种缩略图的原文件）保留。上传任务和 `media-migrate` 已经自动删除本地原文件，这个命令只处理剩下的：在自动删除之前就已记下的、以前为等缩略图生成而保留的、删除失败或中断留下的。

预先用 rclone 复制（可选，代码上线前即可进行）。rclone 不会自己派生密钥，先在 macOS 的终端算出这一对（`jq` 用 `brew install jq` 安装；Linux 上把 `shasum -a 256` 换成 `sha256sum`）：

```sh
read -rs TOKEN    # 粘贴 CF_API_TOKEN 后回车，不显示、不进 shell 历史
ACCOUNT=0123456789abcdef0123456789abcdef
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
endpoint = https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com
region = auto
no_check_bucket = true
```

```sh
rclone copy ~/midden/data/media r2:<bucket> \
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
2. 部署：`docker compose up -d --force-recreate`（或推送后自动部署），日志中 `media store` 的 `store` 应为 `r2`。此后新下载的媒体直接写入 R2，已有的本地原文件由上传任务上传后删除；从这一步起不能再改回 `local`（见上）。
3. 迁移：

   ```sh
   docker compose exec -T midden midden media-migrate --dry-run
   docker compose exec -T midden midden media-migrate --limit 20
   docker compose exec -T midden midden media-migrate --concurrency 8
   ```

   先试运行看汇总（会读取所有本地文件并对每个对象做 HEAD，不写入、不删除，列出会删除的本地文件数），再迁移少量抽查，最后全部迁移。每个媒体记下后即删除本地原文件。中断后重新运行即可。

4. 抽查汇总中给出的地址（或网页中任一原图的地址），连续请求两次：

   ```sh
   curl -s -o /dev/null -D - https://media.example.com/ab/cd/<sha256>
   ```

   应看到 `content-type` 为媒体类型、`cache-control: public, max-age=31536000, immutable`、`access-control-allow-origin: *`，第二次 `cf-cache-status: HIT`。带 `Range: bytes=0-1` 请求视频应返回 206。

5. 不需要单独切换：每个媒体在上传确认后即改用 R2 地址。
6. 不需要单独删除本地原文件：新上传的媒体由上传任务删除，迁移的由 `media-migrate` 删除。`media-prune-local` 只处理剩下的（见上），可以在迁移之后运行一次，以后偶尔再运行：

   ```sh
   docker compose exec -T midden midden media-prune-local --dry-run
   docker compose exec -T midden midden media-prune-local
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
   - 上传：采集一个带图片的帖子。上传任务先 PUT 再读回（HEAD）确认，所以几秒后网页中这张图的地址变为 `https://media.example.com/…` 就说明写和读都可用；失败时日志有 `jobType` 为 `upload` 的 `job will retry`，带 `S3 PutObject failed: 403` 之类的原因。
   - 清除缓存：用同一个 token 直接请求一次（清除一个不存在的地址无害）：

     ```sh
     ZONE=$(grep '^CF_ZONE_ID=' .env | cut -d= -f2-)
     curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
       -d '{"files":["https://media.example.com/cutover-check"]}' \
       "https://api.cloudflare.com/client/v4/zones/$ZONE/purge_cache" | jq .success
     ```

     应为 `true`。服务回收媒体时清除成功记 `cache purged`。

   - 分析数据：「设置 → 管理员面板 → 存储用量」显示 R2 的两个存储桶和「本月费用」；日志中没有 `storage analytics unavailable`。

4. 从 `.env` 删去 `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`CF_PURGE_TOKEN`（服务已不读它们，不必重启），`unset TOKEN`。rclone 的配置改用派生的一对（见「迁移现有媒体」）。
5. 在 Cloudflare 撤销旧 token：「R2 → Manage API tokens」中媒体用的那个（`<bucket>` 的 Object Read & Write），以及「My Profile → API Tokens」中清除缓存的那个。Litestream 的 token 保留：它仍用自己的密钥（见「Litestream」）；只有把 `LITESTREAM_*` 改成由 `CF_API_TOKEN` 派生的一对、`docker compose up -d litestream` 之后心跳正常，才可以撤销它。

### R2 的保护

R2 没有对象版本，被删除或覆盖的对象不能恢复，这里也没有其他媒体备份。R2 提供存储桶锁（Bucket locks），可以作为一个选项，媒体的存储桶可以不配置（备份存储桶的快照建议配置一条，见「Litestream」）：一条规则让某个前缀（或整个存储桶）下的对象在一段时间内（按对象存在的时长、到某个日期或无限期）不能被删除或覆盖，对现有和以后的对象都生效，优先于生命周期规则。在 Cloudflare 的「R2 → 存储桶 → Settings → Bucket lock rules」中添加，或用 `npx wrangler r2 bucket lock add <存储桶>`。

启用前要知道：

- 被锁住的对象删除时返回 409（`ObjectLockedByBucketPolicy`）。回收不再引用的媒体（删除收藏、删除媒体之后）会失败并按 `media_garbage` 的间隔重试，直到保留期结束才删掉，期间日志有 `maintenance step failed`，存储照常计费；清除边缘缓存在删除之前，每次重试都会再清除一次。
- 覆盖同样被拒绝：`media-migrate` 改正响应头（复制到自身）和重新上传（`replaced`）会失败，所以要在迁移完成之后再启用。删除后在保留期内又下载到相同内容时，上传任务的上传也是覆盖，会失败，媒体留在本地；`media-migrate` 按校验值保留 R2 中的对象并记下。
- 按存在时长的规则（如 30 天）能挡住这段时间内的误删，代价是删除的媒体在 R2 中多留这么久；无限期规则会让回收永远失败，不适合这里。

## 原始响应（R2）

默认原始响应在数据库中（正文在 `source_response_bodies`，元数据在 `source_responses`）。设置 `RAW_R2_BUCKET` 后，每次抓取完成即把原始响应移到这个私有存储桶的 `raw/` 下（zstd 压缩，按内容的 SHA-256 命名），数据库只留下 `source_responses` 中的元数据，正文行随之删去，见架构文档「原始响应」。移走之前它们占数据库的大部分（2026-11-25：`source_responses` 878 MB，其中正文 732 MB，128,844 条）。

| 变量                            | 说明                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `RAW_R2_BUCKET`                 | 私有存储桶，如 `<backup-bucket>`（与 Litestream 的 `db/` 共用，各在自己的前缀下）                                                 |
| `R2_ACCOUNT_ID`、`CF_API_TOKEN` | 与媒体共用：S3 密钥由 token 派生（见「媒体存储」的「配置」），token 要有这个存储桶的写权限，上面的 token 已包括 `<backup-bucket>` |

部署这一版本时的迁移给 `source_responses` 加 `remote_at` 列和按 `sha256` 的索引，与是否设置这些变量无关；建索引要读一遍整张表，在 128,844 条、757 MB 的合成副本上约 2.3 秒。

设置了 `RAW_R2_BUCKET` 才启用；还需要 `R2_ACCOUNT_ID` 和 `CF_API_TOKEN`，缺少时启动失败并列出缺少的变量；`RAW_R2_BUCKET` 不能是公开的媒体存储桶 `R2_BUCKET`。服务在开始监听之前验证 `CF_API_TOKEN`（与媒体相同），验证失败就不启动，自动部署因此回滚。启动日志 `raw responses store` 的 `store` 为 `r2`（未启用时为 `database`）。`raw-get` 同样先验证。

- 存储桶必须是私有的（不绑定域名、不开公开访问）：原始响应中有平台给登录账号看的内容。用 `<backup-bucket>` 时，它的生命周期规则不能删除 `raw/` 下的对象（那是原始响应唯一的一份；Litestream 自己管理 `db/` 下的文件）。中止未完成分段上传的规则（见「Litestream」）不删除对象，不受影响；原始响应都是一次上传，不用分段。
- 不需要新的密钥：S3 密钥由 `CF_API_TOKEN` 派生，它要对这个存储桶有读写权限。R2 的密钥不能限定前缀，所以它也能读写 `db/`。
- 费用：按 4 倍压缩，现有的约 180 MB，存储每月约 $0.003；移走已有的约 13 万条用了同样多的 PUT 和 HEAD，在每月免费额度内。之后每条新的原始响应一次 PUT、一次 HEAD，删除时一次 DELETE。「存储用量」中 `<backup-bucket>` 的存储和操作次数包括 `raw/`。
- 读取一条：`docker compose exec -T midden midden raw-get <抓取 id>` 列出这次抓取的原始响应（序号、`bucket` 或 `database`、大小、类型、地址），加上序号输出那一条的原始字节。
- 关闭：删去 `RAW_R2_BUCKET` 即可，之后新的原始响应留在数据库中；已在存储桶中的仍在那里，读取它们（`raw-get`）和回收删除都需要这个存储桶，所以只在不再需要它们时关闭。

### 启用

1. 在部署目录的 `.env` 中加上 `RAW_R2_BUCKET=<backup-bucket>`（已设置 `R2_ACCOUNT_ID` 与 `CF_API_TOKEN` 时只需这一行）。
2. `docker compose up -d`（或推送后自动部署），日志中 `raw responses store` 的 `store` 应为 `r2`。此后完成的抓取由 worker 的 `raw-upload` 任务移走。
3. 已在数据库中的原始响应不需要手动处理。worker 的维护任务每分钟找出一小时以前、仍在数据库中、没有上传任务的原始响应，按抓取排 `raw-upload` 任务，同时等待的最多 500 个；它们在 `raw` 队列中只在 worker 空闲时运行，受节流，优先级与维护相同，所以积压逐步移走，不挤占采集。这一步从只含仍在数据库中的正文的 `source_response_bodies` 查起，全部移走后几乎不花时间。排了任务时记 `queued raw responses still in the database for upload`（`captures` 为这次排的抓取数）。
   - 同样内容（同一个 SHA-256）的原始响应共用一个对象：任务在这个键的锁内存储，然后把仍在数据库中、内容相同的所有行一起记下并删去正文，所以每个内容只上传一次，同一个键不会同时写入（R2 对同一个键的写入每秒约一次，更快的回答 429）。
   - 上传任务放弃（12 次后）的原始响应记在 `raw_upload_failures`：一小时后再排，每放弃一次等待加倍，最长一天，存储桶长时间不可用之后会自己恢复。
   - 与哈希不符的原始响应不上传，也不再尝试：记在 `raw_upload_failures`（`retry_at` 为空），记一次 `raw response does not match its hash; it stays in the database and is not retried`（error），字节原样留在数据库中。
4. 抽查：

   ```sh
   docker compose run --rm --entrypoint sqlite3 litestream -readonly /data/midden.db \
     "SELECT r.id NOT IN (SELECT response_id FROM source_response_bodies), count(*), sum(size)
        FROM source_responses r GROUP BY 1;
      SELECT retry_at IS NULL, count(*) FROM raw_upload_failures GROUP BY 1;
      SELECT capture_id FROM source_responses
        WHERE id NOT IN (SELECT response_id FROM source_response_bodies) LIMIT 1;"
   docker compose exec -T midden midden raw-get <抓取 id>
   docker compose exec -T midden midden raw-get <抓取 id> 0 | head -c 300
   ```

   第一条给出仍在数据库中（`0`）和已在存储桶中（`1`）的条数与原始大小，积压移走后前者只剩最近的、正在等待重试的和与哈希不符的；第二条是等待重试（`0`）和与哈希不符（`1`）的条数；第三条是一个已移走的抓取 id，`raw-get` 列出它的原始响应（应为 `bucket`），再输出第一条，应是原始的 JSON。

5. 数据库变小：清空的原始响应留下的页面成为空闲页面，维护任务每 15 分钟最多还给文件系统 16 MiB（见「维护任务」），不需要 `VACUUM`。在 147,000 条抓取、128,844 条原始响应（757 MB）的合成副本上（迁移后 1,369 MB），全部移走后空闲页面约 877 MB，55 次（约 14 小时）后数据库降到 492 MB，`source_responses` 只剩 27 MB。生产环境的数据库因此应从 2.32 GB 降到约 1.4–1.5 GB（减去 `source_responses` 的约 850 MB），在积压移走之后约 13–14 小时到达。日志 `released free database pages` 的 `free` 逐次减少，降到 1024 以下就停止。这些改动照常经 Litestream 复制：当时每条记下的行移到表尾，并改动它的索引项、原来所在的页面和空闲页面列表（现在正文在自己的表中，记下只删除正文行）；在同一个合成副本上，每批 100 行地移走全部积压写入约 3.2 GB 的 WAL，incremental vacuum 追上又写入约 0.9 GB。Litestream 的每个文件中同一页面只存一次，并以 LZ4 压缩，所以上传的量少于这个数；多出的 L1、L2 文件按保留期在约 9 天后删除。

恢复较早的数据库（见「恢复」）时，那之后被删除的原始响应会回到数据库中，而它们在存储桶中的对象在删除 24 小时后就被回收了，读取这些原始响应会失败；其他原始响应不受影响。原始响应在存储桶中只有这一份，与 R2 中的媒体一样没有其他备份。

## 备份与恢复

需要备份的是数据库、媒体与 `.env`（原始响应移到存储桶后只在那里，见「原始响应（R2）」）：

- 数据库：Litestream 持续复制到 R2 的私有存储桶 `<backup-bucket>`，可以恢复到最近 7 天内的任一时刻，见「Litestream」。不启用时，自己定期做在线备份（服务运行中即可）：

  ```sh
  docker compose exec -T midden midden backup /data/backups
  ```

  这个命令也用于一次性的副本，例如改动数据之前。

- 媒体：使用 R2 时原文件只在 R2 中（见「R2 的保护」），本地只剩正在上传的原文件和还没移到 R2 的缩略图，不复制。`MEDIA_STORE=local` 时 `media/` 中的文件写入后不再修改，增量复制即可：

  ```sh
  rsync -a data/media/ <备份位置>/media/
  ```

- `.env`：不在任何自动备份中。其中的 `SECRET_KEY` 用于解密已保存的账号凭据，没有它，恢复的数据库中的账号要重新添加。改动后自己另存一份（例如密码管理器），Litestream 的 token 也在其中，在另一台机器上恢复时需要它。

### Litestream

`compose.yaml` 中的 `litestream` 服务运行官方镜像 `litestream/litestream`（版本和摘要固定），与服务共用数据目录，按仓库根目录的 `litestream.yml` 把 `data/midden.db` 的改动持续复制到 `s3://<backup-bucket>/db`（R2 的 S3 端点）。它是单独的容器：出问题时服务照常运行，部署也不等它。以 midden 的用户（1000）运行，它在数据库旁边建的文件服务也能写。

启用：

1. Cloudflare「R2」中建私有存储桶 `<backup-bucket>`（不绑定域名、不开公开访问）；「R2 → Manage API tokens → Create API token」，权限 **Object Read & Write**，范围只选 `<backup-bucket>`。

   Litestream 只认 S3 的一对密钥，不能像服务那样由 `CF_API_TOKEN` 派生，所以它有自己的两个变量。值可以是这个 R2 token 的 Access Key ID 与 Secret Access Key，也可以是由 `CF_API_TOKEN` 派生的一对（那个 token 也有 `<backup-bucket>` 的权限，算法见「迁移现有媒体」）；用后者时 `CF_API_TOKEN` 轮换后要一并更新，否则 Litestream 上传失败、心跳停止。

2. 部署目录的 `.env`：

   ```sh
   COMPOSE_PROFILES=litestream
   LITESTREAM_ACCESS_KEY_ID=<Access Key ID>
   LITESTREAM_SECRET_ACCESS_KEY=<Secret Access Key>
   LITESTREAM_BUCKET=<backup-bucket>
   R2_ACCOUNT_ID=<账户 ID>
   ```

   `COMPOSE_PROFILES` 让 compose 启动 `litestream` 服务，没有它就没有这个容器；服务读到 `LITESTREAM_ACCESS_KEY_ID` 就等待 Litestream 的心跳（见「监控」）。`litestream.yml` 用 `LITESTREAM_BUCKET` 与 `R2_ACCOUNT_ID` 拼出存储桶和 S3 端点。两个密钥只传给 Litestream 的容器和服务（`.env` 整个传给服务），不写入日志。

3. `docker compose up -d`：创建 `litestream` 容器，并重建服务的容器以读入新变量。Litestream 第一次启动时上传整个数据库，日志中有 `snapshot complete`。
4. 检查（见「检查复制」），几天后按「恢复」试一次。

关闭：先 `docker compose rm -sf litestream`，再删去这三行，`docker compose up -d`（服务不再等待心跳）。存储桶中的文件不会自动删除。

`litestream.yml` 改动后 `docker compose restart litestream`；自动部署在它有改动时会重建容器。

#### 设置

Litestream 0.5 把 WAL 中新提交的页面写成 LTX 文件（按页 LZ4 压缩），每个文件一个事务编号（TXID），连续递增；文件逐级合并，每天另做一份完整快照。

| 设置                                  | 值                      | 原因                                                                                                                                                            |
| ------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `monitor-interval`                    | `10s`                   | 每 10 秒检查一次 WAL，有新页面就写一个 L0 文件，每个文件是一次 PUT。默认 1 秒时持续写入的一天有 86,400 个，10 秒最多 8,640 个。机器损坏时最多丢失约 10 秒的写入 |
| `sync-interval`                       | `1s`                    | 文件写好后 1 秒内上传。0.5 中 PUT 的次数由上一项决定，这一项只是上传的间隔                                                                                      |
| `concurrency`、`part-size`            | `2`、`5MiB`             | 分段上传（每天的快照）同时上传 2 段、每段 5 MiB，是 0.5.18 对 R2 的默认值，写出来以便调整（见「网络」）                                                         |
| `levels`                              | `1m`                    | 每分钟把 L0 合并成一个 L1 文件，它们是保留期内的恢复点。合并读的是本地的 L0 文件，不下载。没有每小时的 L2，见「网络」                                           |
| `snapshot`                            | 每 `24h`，保留 `192h`   | 每天 00:00 UTC 一份完整快照，保留 8 天：最近 7 天内的任一时刻之前都有一份快照可用。比最早保留的快照更早的 L1 文件随之删除。不能短于存储桶锁的 7 天（见下）      |
| `l0-retention-check-interval`         | `1h`                    | 每次检查都列出存储桶中全部 L1 文件（每 1000 个一次 Class A 操作），默认每 15 秒一次太多                                                                         |
| `heartbeat-url`、`heartbeat-interval` | 服务的 8081 端口，`5m`  | 见「监控」                                                                                                                                                      |
| `truncate-page-n`                     | `1000000`（约 3.8 GiB） | 见「检查点」。`checkpoint-interval`（`1m`）、`min-checkpoint-page-count`（1000 页）用默认值                                                                     |

恢复点：最近 5 分钟到 1 小时内（L0 文件还在）约每 10 秒一个，更早的每分钟一个（L1 的边界），8 天前的不能恢复。没有写入的时段没有文件。恢复时下载最近的一份快照和它之后的 L1 文件，最多约一天的 1,440 个。

存储桶锁：`<backup-bucket>` 建议配置一条存储桶锁规则，`db/0009/`（快照）下的对象存在 7 天内不能删除或覆盖，误删或被盗用的密钥也删不掉最近的快照。这个时长必须不超过 `snapshot` 的 `retention`（现在 192 小时，7 天是 168 小时）：否则 Litestream 删除过期快照时收到 409（`ObjectLockedByBucketPolicy`），日志记 `retention enforcement failed`，旧快照和更早的 L1 文件都留下。锁同样挡住中止分段上传：`db/0009/` 下没传完的分段上传在锁到期之前不能中止。存储桶另建议配一条生命周期规则，分段上传开始 1 天后仍未完成的，自动中止 `db/` 下的这些上传。它只删除没传完的分段，从不删除对象，所以不影响任何快照或 L1 文件；`db/0009/` 下没传完的分段上传在 7 天的存储桶锁到期之前仍不能中止。

#### 检查点

两个进程的连接都用 WAL、`synchronous = NORMAL`；网页进程 busy timeout 2 秒、关闭自动检查点，worker 10 秒、保留 SQLite 默认的自动检查点（WAL 超过 1000 页时，PASSIVE）。Litestream 一直持有一个读事务，只有它自己的检查点能让 WAL 从头开始写；PASSIVE 检查点越不过它的读事务，所以 worker 的自动检查点不影响复制，把 WAL 页面写回数据库的实际是 Litestream 的检查点。它做 PASSIVE 检查点时持有写锁（向 `_litestream_lock` 写一行作为屏障），把上次以来的 WAL 页面写回数据库，写入在这期间等待：`monitor-interval` 为 10 秒时最多是 10 秒的写入量，几十到几百毫秒，两个进程的 busy timeout 都足够。服务中没有 `wal_checkpoint(RESTART)`、`wal_checkpoint(TRUNCATE)` 和 `VACUUM`：前两者会让 Litestream 重新上传整个数据库，`VACUUM` 把每一页写进 WAL，都不要加；整理数据库在服务全部停止时做（见「数据库整理」）。`PRAGMA optimize`（启动时和每 6 小时）和 `PRAGMA incremental_vacuum`（见「维护任务」）是普通的写事务；`cli.ts backup`（手动的在线备份，部署不再用它）只读数据库，但运行期间一直持有读事务。数据库变小的事务（incremental vacuum 截短文件）在 Litestream 0.5.2 中会让同步报 `page number X out-of-bounds for commit size Y`（#875），之后由 #881 修复，固定的 0.5.18 已包含；用 0.5.18 在本地试过：一边复制，一边清空大量数据并分批 incremental vacuum，最新状态与其间三个时刻的恢复都通过完整性检查，最新状态的页数和内容与源数据库相同。

WAL 的大小：Litestream 做快照时（每天 00:00 UTC；以及它丢了在 WAL 中的位置、重新上传整个数据库时，见「部署与 WAL 中的位置」）直到上传完都不做检查点，WAL 随写入一直变大，负载高时几分钟就超过 1 GB。WAL 超过 `truncate-page-n` 时它先试 PASSIVE，不行再做阻塞的 TRUNCATE；0.5.18 在 TRUNCATE 之后总要在持有写锁的情况下把整个数据库写成一份快照（`checkpoint boundary snapshot`），这期间服务的每个写入都在等待，超过 busy timeout 就以 `database is locked` 失败，并且又上传一次整个数据库。默认的阈值约 500 MB，快照期间的增长就会越过它；一个持续几分钟的读事务（例如每天的数据库组成）也会，所以组成只在 worker 空闲时读（网页上点「重新统计」除外）。`litestream.yml` 把它设为 1,000,000 页（约 3.8 GiB），只作为最后的保护：快照或读事务结束后，下一次普通的 PASSIVE 检查点（WAL 超过 1000 页时，每次同步之后）把 WAL 写回数据库并从头开始。这个检查点期间 Litestream 也持有写锁，WAL 越大越久。磁盘上要留出 WAL 的空间。设为 `0` 不能关闭它：0.5.16 起 0 表示默认值（#1348），与 Litestream 的文档不同。

负载测试（`server/scripts/bench-load.ts`，见 CONTRIBUTING）中，一边做 3,000 条帖子的更新、一边持有 60 秒读事务：默认的阈值下 WAL 涨到 2.3 GB，Litestream 强制 TRUNCATE 9 次；阈值提高后 0 次，读事务结束后 WAL 照常从头开始。

Litestream 在数据库中建两张表 `_litestream_seq`、`_litestream_lock`，恢复出的数据库中也有，不影响服务。

#### 部署与 WAL 中的位置

Litestream 重新启动后的第一次同步（启动一个 `monitor-interval` 之后）核对自己上次同步到的位置（`db.go` 的 `verify`）：上次最后一个 L0 文件记下的 WAL 偏移处，那一帧的盐值和页面内容必须与它当时写出的一致（`lastPageMatch`）。WAL 比这个偏移短（被截短或删除，日志 `wal truncated by another process`），或那一帧已被覆盖（`last page does not exist in last ltx file, wal overwritten by another process`），或 WAL 从头开始而它只同步到第一帧（`wal header salt reset, snapshotting`），它就把整个数据库作为一个新的 L0 文件上传（`snap=true`），每分钟的合并再把它写成同样大的 L1 文件，在存储桶中留到比它更早的快照都过期。

以前每次部署都这样：部署的检查点 `wal_checkpoint(TRUNCATE)` 截短了 WAL（它的结果 `log` 总是 0，因为 TRUNCATE 在读计数之前就重置了 WAL，并不说明 WAL 原本是空的）；即使不截短，服务先于 Litestream 启动，第一次写入发现 WAL 已全部写回，就从头开始写，写过 Litestream 的偏移后同样如此。Litestream 用 `PERSIST_WAL` 打开数据库，自己最后关闭时把 WAL 写回数据库但保留文件和内容，位置因此还在。所以部署：先停服务、再停 Litestream，复制时不做检查点，先启动 Litestream、等它同步一次（它这时持有读事务，服务的写入接在 WAL 后面，不再从头开始），再启动服务。在本地用 Litestream 0.5.18 和 S3 兼容的服务器试过这个顺序：一边每秒写入约 2 MB、一边部署三次，没有新的完整上传；不等待就启动服务时一次就重新上传，带检查点时也是；从存储桶恢复出的数据库与原库行数一致、通过完整性检查。

仍会重新上传整个数据库的情况：回滚（换回的数据库与它的位置对不上，删去本地状态后从存储桶取得位置）；Litestream 没有运行时服务在写（例如单独 `docker compose stop litestream` 很久，或 Litestream 启动失败）；本地状态 `data/.midden.db-litestream/` 丢失。数据不会缺，只多一次约 1.4 GB 的上传，和一个同样大的 L1 文件。

#### 网络

合并到某一级时，Litestream 一次打开上一级中所有待合并的文件（`compactor.go` 的 `Compact`：每个文件一个 GET，各占一个连接，同时流式读到合并结束），没有限制同时打开的数目，也不能分段读取。L1 文件不在本地，所以以前每小时合并 L2 都要同时下载至少 60 个 L1 文件；L2 一旦失败，下一次要合并的就是从上次成功以来的全部 L1 文件（其中还有部署后重新上传的、每个约 1.4 GB 的文件），同时打开的连接数以千计。部署机（OrbStack 的网络栈）上这时 `netstat -m` 的 requests for memory denied 大增，Tailscale 报 `no buffer space`，GET 与分段上传以 `StatusCode: 0, request send failed … EOF` 失败（重试 8 次后放弃，`s3/replica_client.go` 的 `transportRetryMaxAttempts`），同时进行的每日快照也失败。在本地数过：合并 L2 时客户端到 S3 的连接数等于待合并的 L1 文件数，只保留 L1 时始终只有 1 个。所以不再有 L2：L1 由本地的 L0 文件合并，快照读本地的数据库，Litestream 平时不再从存储桶下载任何东西，只有恢复时下载。

上传的设置：快照分段上传，同时 `concurrency` 段（2）、每段 `part-size`（5 MiB），这是 0.5.18 对 R2 的默认值（按端点识别 R2，`sign-payload` 也默认开启，R2 需要签名的请求体）；同时在途的数据不超过约 15 MiB。还有网络缓冲不足的迹象时，先把 `concurrency` 降到 1；`part-size` 越大请求越少，但每段在内存中缓冲。改动 `litestream.yml` 后自动部署会重建它的容器。

不再使用的 L2：存储桶中以前的 `db/0002/` 文件 Litestream 不再管理（保留只按配置中的级别执行），也不再写入新的；恢复时仍可能用到其中与快照衔接的文件，结果正确。比最早的快照更早之后可以手动删除。

#### 费用

R2 Standard：存储 $0.015/GB·月，Class A 操作（PUT、分段上传、LIST）$4.50/百万次，Class B（GET、HEAD）$0.36/百万次，流出免费。每月免费 10 GB·月、100 万次 Class A、1000 万次 Class B，与媒体的存储桶 `midden` 共用。按数据库 2.3 GB、LZ4 后约 52%（开发库实测）估计，一份完整副本约 1.2 GB：

- 存储：8 份快照约 9.6 GB；L1 保留约 9 天的增量，按每天 100–300 MB 改动估计约 1–2 GB；启用后、每次回滚后和 Litestream 重新上传整个数据库（见上）后的 9 天内，L1 中多一份完整副本（约 1.2 GB）。平时约 11–12 GB，约 $0.18/月（媒体已用完免费额度时；否则更少）。
- Class A，最坏情况（整月每 10 秒都有写入）：L0 上传 259,200；L1 合并 43,200 次写入加 43,200 次列出 L0；L0 保留检查约 10,000；快照分段上传（每段 5 MiB）约 7,000；快照保留清理约 450。合计约 36 万次，在免费额度内；全部计费也只有约 $1.7/月。写入是间歇的，实际应在一半以下。
- Class B：平时没有下载，只有恢复时的下载。

#### 监控

`litestream.yml` 的 `heartbeat-url` 指向服务的 8081 端口（`server/src/litestream.ts`；compose 只发布 8080，这个端口只有同一网络中的容器能访问）。Litestream 只在最近 5 分钟内的同步都成功时每 5 分钟发一次心跳：容器没有运行、token 错误、网络或 R2 故障时都没有心跳。数据库没有写入时仍有心跳：Litestream 0.5.18 的复制循环在没有新数据时按 `sync-interval` 空转一次，没有文件要上传也记为同步成功（`replica.go`，注释「so idle databases continue recording sync health for heartbeats」），所以不需要服务定期写一行来保持心跳；只有从未写入过的空数据库不发。

服务设置了 `LITESTREAM_ACCESS_KEY_ID` 时监听这个端口：超过「备份心跳超时」（默认 20 分钟，从服务启动时算起）没有收到心跳，就由 Bot 告诉所有者「数据库备份：20 分钟没有收到 Litestream 的心跳」，日志记 `litestream heartbeat missing`（error）；之后收到心跳时发「数据库备份：Litestream 的心跳已恢复」，记 `litestream heartbeat resumed`。服务启动后的第一次心跳记 `litestream heartbeat received`（info），之后的心跳不记日志，所以确认备份在工作不必再等 20 分钟：看这条日志，或看下面的管理员面板。Litestream 上传失败后按 1 秒起翻倍、最长 5 分钟的间隔重试，所以故障排除后几分钟内才恢复。没有配置 Bot 时只记日志。服务重启后重新计时，故障持续时每次部署后会再提醒一次。

「备份心跳超时」是管理员设置，不是环境变量：网页「设置 → 管理员面板 → 数据库备份」中修改，存在数据库的 `settings` 表（键 `litestream_timeout_minutes`，整数 1 到 1440 分钟，没有设置时为 20），监控每次检查时读取，改后立即生效，不必重启。Litestream 每 5 分钟发一次心跳（`litestream.yml` 的 `heartbeat-interval`），低于 5 分钟的值会让正常的备份也被报告，只在测试告警时有意义。

同一面板显示「上次心跳 3 分钟前」，超时则显示「超过 20 分钟没有心跳」；`GET /v1/instance` 的 `litestream` 字段给出同样的内容：`enabled`、`last_heartbeat_at`（没有收到过为 `null`）、`stale`、`stale_after_minutes`；没有设置 `LITESTREAM_ACCESS_KEY_ID` 时 `enabled` 为 `false`，面板不显示这一部分。`PUT /v1/instance/litestream` 修改超时（`{"stale_after_minutes": 20}`）。上次心跳的时间也存在 `settings` 表（`litestream_last_heartbeat_at`），重启后仍能显示，但超时仍从服务启动时算起。每次心跳（每 5 分钟）写一次这一行，Litestream 随之多上传一个很小的文件。

部署时 Litestream 启动失败，部署消息末尾有 `; litestream did not start`。整台机器离线时这些都发不出来，服务本身也不可用。

#### 检查复制

```sh
docker compose ps litestream
docker compose logs --tail=50 litestream                                # sync error、monitor error、compaction failed、retention enforcement failed
docker compose logs litestream | grep -E 'snap=true|reason='            # 整个数据库重新上传的原因（需要 debug 日志）
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

使用 R2 时，回收不再引用的媒体会同时删除 R2 中的对象，所以恢复较早的数据库后，在那之后删除的媒体不能再显示。`MEDIA_STORE=local` 时数据库与媒体分别备份，可能有少量新媒体在数据库备份中尚未出现（无害），或数据库引用了刚被回收的旧媒体，后者在维护时会被清理；需要严格一致时，先 `docker compose stop` 再备份。缩略图丢失时在请求时从平台重新下载（见「媒体存储（Cloudflare R2）」）。

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
   rclone check ~/backups/midden/auto/media r2:<bucket> --one-way
   ```

   不应有内容不同（`differences`）的文件；R2 中缺少的只应是还没移走的缩略图和已被回收删除的媒体。

4. 删除：`rm -rf ~/backups/midden/auto/media`。

此后 R2 中的原文件是唯一的一份（见「R2 的保护」）。

## 存储用量

「设置 → 管理员面板 → 存储用量」（`GET /v1/storage`，代码在 `server/src/usage/`）分为几组：

- R2：每个存储桶的存储（最近一天的最大值，载荷加元数据）、对象数、本月的 Class A 与 Class B 次数，以及读取分析数据的时间；「刷新」立即重读（距上次不到 1 分钟时不重读）。
- 本月费用：存储、Class A、Class B 各自的已用量、免费额度、已用比例和金额，以及合计（见「费用」）。
- 本机：可用磁盘与总容量、数据库文件（空闲页与 WAL）、缩略图、媒体目录（每天统计）、部署前的数据库备份，以及「按占用空间排列收藏」（收藏库按占用空间排序，`/?sort=storage`）。
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
- 缩略图：`blob_thumbnails` 中已生成的个数与 `size` 之和，加上已移除的媒体保留的缩略图（`removed_media` 的 `thumbnail_key`，同一个文件只算一次，不在 `blob_thumbnails` 中的才算；大小是标记记下的 `thumbnail_size`，记下大小之前的标记只计个数）。其中还没移到 R2 的单独给出（`local_count`、`local_bytes`），网页写成「缩略图 N 个，本机 M 个（大小），其余在 R2」，全部移走后只写个数；移走的缩略图在 R2 的存储中也计入一次。
- 媒体目录：随每次数据库组成在 worker 线程中遍历 `media/`，统计文件数与大小（使用 R2 时就是还没移走的缩略图和尚未上传完的原文件）。
- 部署前的数据库备份：`data/backups/deploy/` 中的文件。
- 可用磁盘：数据目录所在卷的 `statfs`（容器内看到的卷；GB 为 2^30 字节，与网页中其他大小相同）。

### 数据库组成

在 worker 线程中用单独的只读连接运行 `SELECT name, pgsize FROM dbstat WHERE aggregate = TRUE`（聚合模式，每个 b-tree 一行），线程的 nice 值设为 19。生产库（2.3 GB）约 18 秒，期间服务的事件循环和写入照常进行（WAL 下读不阻塞写），但它在一个读事务中读遍每一页，WAL 不能从头开始。所以 worker 自己发起的统计只在空闲时进行；只有网页上点「重新统计」是立即的。网页进程从不运行 `dbstat`，只写请求。

结果存在 `settings` 表的 `db_composition`（最大的 15 个、其余合计、总计、耗时、统计时的最新迁移 `migration` 与数据库文件大小 `file_bytes`、媒体目录），页面上写「统计于 3 小时前（时间）」。日志 `database composition read`（带 `reason`、`seconds`、`ms`），失败记 `database composition failed`，失败后 worker 自己的统计 10 分钟内不再试。

重新统计的时机（worker 每分钟检查，空闲时才开始；`reason` 是日志中的原因）：

| `reason`     | 条件                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `missing`    | 还没有统计                                                                                                          |
| `old`        | 距上次满 24 小时                                                                                                    |
| `marked`     | 离线维护（`cli.ts maintain`）成功结束时在 `settings` 的 `db_composition_stale` 做了标记，下一个空闲时刻读，读完清除 |
| `migrations` | 统计时的最新迁移与现在数据库中的不同（部署带来了迁移；升级前的旧统计没有这个字段，也算）                            |
| `size`       | 数据库文件大小与统计时相比变了 10% 以上（原始响应搬到 R2、清理后等）                                                |
| `requested`  | 网页上点了「重新统计」                                                                                              |

「重新统计」（`POST /v1/storage/composition`）在 `settings` 的 `db_composition_job` 写 `{ state: 'queued', at }`，一条语句完成，所以已有排队或正在运行的请求时不会再写一条，返回现有的。worker 每 5 秒看一次这个键（不等分钟计时器），取到后改为 `running`，不管是否空闲立即开始，结束后删除（读的过程中又来的请求保留，再读一次）。15 分钟没有被处理的请求视为丢失（worker 没在运行），可以再点。页面在请求存在期间每 2 秒读一次报告（`composition_job`），按钮显示「统计中…」，完成后显示新的数字。

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

worker 每分钟运行一次维护。标 _空闲时_ 的步骤只为腾出空间，只在 worker 空闲时做（其他任务 10 秒内都没有运行，且没有在节流），大批更新期间等它结束：

- 超过 1 小时仍未完成且没有对应任务的抓取标记为中断；
- 删除不再保存、也没有进行中抓取的收藏及其独有内容（_空闲时_；每批之间停一下，让网页进程能写入）；
- 没有产生新版本的抓取，其原始响应保留 3 天，之后只要不是这个收藏最新一次的抓取就删除；产生了新版本的抓取的原始响应一直保留（_空闲时_）；
- 不再被引用的媒体文件 24 小时后删除（使用 R2 时同时删除对象并清除边缘缓存）；
- 不再有任何原始响应使用的存储桶对象 24 小时后删除（见「原始响应（R2）」，_空闲时_）；
- 设置了 `RAW_R2_BUCKET` 时，为一小时以前仍在数据库中、没有上传任务的原始响应排上传任务，同时等待的最多 500 个（见「原始响应（R2）」）；
- 删除抓取结束一天以上仍留着的暂存数据（`capture_staging`，没能提交的列表目标的预取）；
- 为缩略图补记文件头中的宽高（记下尺寸之前生成的缩略图，_空闲时_）；
- 为查询语言补齐旧收藏的话题标签、提及、链接域名与语言（_空闲时_；每批 500 行，进度存在 `settings` 的 `facets_backfill`，做完记 `facets filled`；见[架构](architecture.md#查询语言)）；
- 使用 R2 时，把还只在本地的缩略图移到 R2（_空闲时_，每次最多 20 秒，受节流；见[架构](architecture.md#缩略图)）；
- 清理过期的网页会话、通行密钥挑战与 `/passkey` 链接；
- 每 15 分钟读取存储用量并检查提醒，每天一次以及数据库变动后统计数据库组成（见「存储用量」，worker 自己发起的统计在 _空闲时_）；
- 把空闲页面还给文件系统（_空闲时_）：空闲页面达到 1024 页（4 MiB）时运行 `PRAGMA incremental_vacuum(4096)`，每次最多 16 MiB，两次之间至少 15 分钟，所以积压最多每小时释放 64 MiB；日志 `released free database pages` 给出这次释放的页数、剩余空闲页数（`free`）和总页数（`pages`）。这要求数据库是 `auto_vacuum = INCREMENTAL`：新建的数据库默认如此，已有的数据库要 `VACUUM` 一次才能切换（生产环境已于 2026-11-25 切换；`cli.ts maintain --vacuum` 也会切换），否则这一步什么也不做。

## 定期更新

worker 每分钟检查一次到时间的定期更新（见[架构](architecture.md#定期更新)），开始的每次运行是一条普通的更新记录，没有 Telegram 消息。

- 日志：`watch run started`（`watchId`、`updateId`）；`watch slot skipped: its last run still goes`（上一次还没结束，这次跳过）；`watch run not started`（带原因，如收藏夹是空的，原因也显示在设置页）。
- 间隔最短 5 分钟。运行比间隔还长时，其间的时刻都跳过（日志 `watch slot skipped`），不排队、不叠加；很大的收藏夹用很短的间隔只会一直跳过。
- 每月、每年的定期更新按保存时浏览器的时区计算日期，月底按当月最后一天；改了时区要重新保存一次。
- 同时最多 2 个定期更新在进行，多出的仍是到期状态，等前面的结束。全部暂停或账号限流期间，已开始的运行等着，之后到期的会因为上一次还没结束而跳过，恢复后不会补跑。
- 部署和重启不影响时间：下一次运行的时刻存在 `watches.next_run_at`，停机期间错过的只补一次。
- 要立即运行一次，在账号或收藏夹上手动「更新」即可；手动的更新不影响定期更新的时刻。

## 数据库整理

`cli.ts maintain` 在网页进程、worker 和 Litestream 全部停止时整理数据库（`server/src/db/maintain.ts`）。平时不需要：删除留下的空闲页面由维护任务的 incremental vacuum 归还。用于一次性收回大量空闲页面和半空的页面（例如原始响应移走之后），或怀疑数据库、搜索索引有问题时。

它做的事：

1. 独占打开数据库（`locking_mode = EXCLUSIVE`，取得文件的排他锁）。WAL 模式下每个打开着数据库的连接都持有共享锁，空闲的也一样，所以网页进程、worker 或 Litestream 还开着它时立即失败（`could not take the database for itself …`），什么都不改；整理期间别的进程也打不开它。这个版本有未应用的迁移、或数据库已被更新的版本迁移过时同样拒绝。
2. 完整性检查（`PRAGMA integrity_check`），不通过就停止，数据库不变。
3. 带 `--vacuum` 时：`VACUUM INTO` 在同一目录写出整理后的副本 `midden.db.vacuum-<时间>`，设为 `auto_vacuum = INCREMENTAL`。不用原地的 `VACUUM`：它先写一个临时数据库，再把每一页经 WAL 写回（WAL 涨到与数据库一样大）；`VACUUM INTO` 只写一遍，原文件不动，它就是备份。
4. 在副本上（不带 `--vacuum` 时在原数据库上）：检查搜索索引，两个 FTS5 表的文档与 catalog 的 `id` 一一对应（按 `<表>_docsize`），并通过 FTS5 自己的 `integrity-check`；不对应（或带 `--rebuild-search`）时从 catalog 重建（`delete-all` 后重新插入），再检查一次。然后合并索引段（FTS5 的 `optimize`）、`PRAGMA incremental_vacuum` 归还空闲页面、`ANALYZE`（`analysis_limit = 400`，与服务的 `PRAGMA optimize` 一样），再做一次完整性检查。
5. 都通过后换上副本：原数据库（连同 WAL）移到 `data/backups/maintain/midden-<时间>.db`，副本改名为 `midden.db`，删去旧的 `-shm`；`backups/maintain/` 中更早的备份删除，只留这一份。任何一步失败都删去副本，原数据库不变（输出 `the original database is unchanged`）。
6. 输出每一步的耗时，以及前后的大小（页面、其中空闲的、文件与 WAL）。成功时在结果数据库的 `settings` 标记「数据库组成」过时（`db_composition_stale`），worker 启动后在空闲时重新统计，见「存储用量」。

磁盘上要有副本的空间，约为数据库中有效数据的大小；原数据库留到下一次整理。

耗时：在 3.1 GB 的合成数据库上（开发库加上它所有普通表的 5 份副本，有效数据 2.0 GiB、空闲 0.9 GiB，放在 macOS 的目录中经 OrbStack 访问，与部署机相同）两次分别用了 33 秒和 37 秒：完整性检查 10.6–16.0 秒，`VACUUM INTO` 6.9–8.4 秒，检查搜索索引 0.2 秒（6 万行的 catalog，强制重建 0.8 秒），统计 1 秒，再次完整性检查 9.6–10.9 秒；结果 2.0 GiB。同一个库上原地 `VACUUM` 一步就要 38 秒，并写出 2 GiB 的 WAL。生产环境的 2.8 GB 预计整理 1 分钟左右（文件不在缓存中时读得慢些，按 2 分钟准备），加上停止（worker 最多等 30 秒）与启动（Litestream 15 秒、网页进程和 worker 的健康检查），服务中断约 2–4 分钟。

### 步骤

`scripts/maintain.ts` 在部署机上做完全部步骤，与自动部署用同一个锁（`.local/deploy.lock`，整理期间不会部署），停止与启动的顺序与部署相同：

```sh
cd ~/midden && node scripts/maintain.ts
```

加 `--rebuild-search` 总是重建搜索索引，`--no-vacuum` 不整理文件、只做检查、搜索索引和统计。它：

1. 取得部署锁，读出正在运行的版本（整理用这个版本的镜像，它的迁移与数据库一致；没有在运行的版本时不做）；
2. 依次停掉 worker、网页进程、Litestream（同「自动部署」第 2 步：Litestream 最后停，先把服务最后写的内容复制走）；
3. `docker compose run --rm --no-deps -T midden node server/src/cli.ts maintain --vacuum`，镜像为 `:sha-<正在运行的提交>`；
4. 删去 Litestream 的本地状态 `data/.midden.db-litestream/`（整理失败时也删：停止期间的任何写入都让它对不上位置）；
5. 先启动 Litestream，等一次 `monitor-interval` 加 5 秒，再启动网页进程并检查 `/healthz`，然后启动 worker（同「自动部署」第 4 步）；
6. 最后一行是结果：`result: maintained the database; <提交> is running again`，失败时 `result: failed: maintenance did not finish (…); <提交> is running again`，此时数据库不变。

手动做时（命令与脚本相同）：

```sh
cd ~/midden
mkdir .local/deploy.lock      # 挡住自动部署
REV=$(docker image inspect "$(docker inspect "$(docker compose ps -q midden)" --format '{{.Image}}')" \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
export MIDDEN_IMAGE=ghcr.io/sxzz/midden:sha-$REV
docker compose stop midden-worker && docker compose stop midden && docker compose stop litestream
docker compose run --rm --no-deps -T midden node server/src/cli.ts maintain --vacuum
rm -rf data/.midden.db-litestream
docker compose up -d litestream && sleep 15
docker compose up -d --wait midden && docker compose up -d --wait midden-worker
rmdir .local/deploy.lock
```

### Litestream

整理换掉了整个文件，Litestream 在 WAL 中的位置随之失效。删去本地状态后，它启动时从存储桶取得位置，把整理后的数据库整个作为下一个事务上传（约为整理后的大小，预计 1.5–2 GB，与回滚之后相同，见「部署与 WAL 中的位置」），每分钟的合并再写成一个同样大的 L1 文件，留到比它更早的快照都过期（约 9 天），这期间存储桶多占同样的空间。这次上传可以接受，但每次整理都有一次，所以不要经常整理。上传期间 Litestream 不做检查点，WAL 随写入变大（见「WAL 的大小」），所以选没有大批更新的时候。整理之前的任一时刻仍可从存储桶恢复，历史不中断。

不启用 Litestream 时没有这些：脚本只停、启服务。

### 回退

整理后的数据库有问题时，换回 `data/backups/maintain/` 中的原数据库（整理之后的写入随之丢失）：与部署的回滚一样，先停 Litestream 再停服务，换上文件并删去新数据库的 `-wal`、`-shm` 和 Litestream 的本地状态，再按顺序启动：

```sh
docker compose stop litestream && docker compose stop midden-worker && docker compose stop midden
rm -f data/midden.db-wal data/midden.db-shm
mv data/backups/maintain/midden-<时间>.db data/midden.db   # 有 -wal 时一并改名为 data/midden.db-wal
rm -rf data/.midden.db-litestream
docker compose up -d litestream && sleep 15
docker compose up -d --wait midden && docker compose up -d --wait midden-worker
```

## 从 Go 版迁移

2026-11-24 起生产环境运行本实现。旧的 Go 多服务版本（PostgreSQL、SeaweedFS、gRPC adapter）保存在 `golang` 分支；其数据由 `import-legacy` 分支中的导入工具（`tools/import-legacy/`）迁入 SQLite 与 `media/`，导入后会重建 `catalog`。旧版的 Bot 按钮、REST token、媒体链接不再可用。

## 排查

- 两个进程：`docker compose ps` 中 `midden` 与 `midden-worker` 都应是 healthy。worker 不健康或没在运行时网页照常服务，任务排队；管理员面板「后台任务」显示「后台进程没有响应」。
- 网页慢：日志 `slow request`（超过 500 毫秒的请求，带路径和毫秒数；`thread: true` 是在读线程上运行的，`waitMs` 是等线程的时间、`runMs` 是执行的时间，它不挡别的请求）和 `event loop lag`（网页进程停顿超过 200 毫秒），各自 10 秒内最多一条，`skipped` 是其间省略的条数；「后台任务」页显示最近一分钟的请求耗时和主线程、读线程各有几个慢请求。worker 的 `slow write transaction`（持有写锁超过 200 毫秒或等锁超过 1 秒，带任务）、`worker slowing down`（节流降低并发，带原因：`web lag`、`slow web requests`、`lock wait`、`write duty`）说明是谁在占用数据库；降低并发时「后台任务」页写出原因。`database is locked` 是等写锁超过 busy timeout（网页进程 2 秒，worker 10 秒）。
- 查询慢：读取线程上 300 毫秒以上的语句记 `slow query`（路由、查询或筛选、SQL、参数、毫秒数、行数，2 秒内最多一条，`skipped` 是其间省略的条数），最新 500 条留在 `slow_queries` 表中，「后台任务」页的「慢查询」列出最新的 100 条。要加索引时先看这里：同一条 SQL 反复出现的，用 `EXPLAIN QUERY PLAN` 和其中的参数在数据库副本上试。
- `GET /healthz` 返回 `ok` 表示 HTTP 服务与数据库正常，不含 Telegram；Bot 的状态看 `GET /v1/instance` 的 `bot`，或日志中的 `telegram bot started`、`telegram bot start failed; retrying`、`telegram bot could not start`。
- 日志为 JSON，`job failed` 表示任务最终失败，`delivery rejected` 表示 Telegram 拒绝了某条消息。
- 抓取失败：每次尝试都有记录，自动重试不会覆盖之前的日志。`upstream request failed` 是失败的上游请求：`upstream` 中有来源（`fxtwitter`、`x-graphql`、`instagram` 等）、接口、去掉凭据与查询 token 的 URL、状态码、`retry-after` 与 `x-rate-limit-*` 等响应头、响应开头 2 KB（已遮盖 token），另有任务编号与次数、`captureId`、目标和错误分类（`errorCode`、`retryable`、`final`）。之后还会重试的为 warn，不再重试的为 error，抓取最终仍成功的为 info。`job will retry` / `job failed` 是任务每次失败的结果与耗时，`capture failed` 是抓取记录最终失败。平台代码处理掉、没有让抓取失败的错误（时间线读到一半中断、锁推账号的帖子看不到、某条帖子无法解析而略去）记为 `platform call went on past an error`（warn），带同样的任务字段（`captureId`、`platform`、采集账号 `connectionId`）、错误（`errorCode`、`errorMessage`，以及 `errorDetails` 中上游另外说的：GraphQL 的 `typename` 如 `UserUnavailable`、错误码 `graphqlErrors`）和此前最后一个请求（`upstream`，含状态码与响应开头），记录上只写简短的原因（如「帖子获取中断：来源平台限流。」）。抓关系网的任务（`jobType` 为 `relations`）带 `relationFetchId`、`list` 与 `providerId`（`fxtwitter` 或 `x-session`）；用采集账号读时，查询限流后的切换记为 `relations query rate-limited; switching to the other query`，两个查询都限流时记为 `both relations queries rate-limited; waiting for the earlier reset`。
- 限流：接口回答 429（或 X 的错误 88、Instagram 的「please wait」）时，用到它的任务等到限流结束，日志 `job waits for a rate limit`（带 `scope`、`until`），不算尝试。「后台任务」页的「限流」一栏列出仍在限流中的范围、恢复时间和等待的任务数，「解除」立即放行（见架构文档「限流」）。没有结束时间的限流按 15 分钟（采集账号）或 5 分钟（FxTwitter）计。
- 日志位置：容器标准输出（`docker compose logs`，json-file 按 10 MB × 5 轮转，部署重建容器后清空），以及数据目录中的 `logs/midden.log`（网页进程）和 `logs/worker.log`（任务，抓取失败在这里），各按 10 MB 轮转，保留 5 个文件，跨部署保留。查找某个账号的失败：

  ```sh
  grep -h xiaomouzovo data/logs/worker.log* | grep -E '"level":(40|50)'
  ```

- 缩略图下载失败记 `thumbnail download failed`（warn，带 `assetId`、`blobId`），不影响原文件和抓取；服务器忙时随下载任务重试（`job will retry`）。
- Cloudflare：`cloudflare token verification failed` 表示启动时 `CF_API_TOKEN` 没有通过验证，服务随即退出（见「配置」）；`storage analytics unavailable` 表示存储用量读不到分析数据，页面只显示本机部分。
- Litestream：`litestream heartbeat missing` 表示超过「备份心跳超时」（默认 20 分钟）没有收到它的心跳，看 `docker compose logs litestream` 中的 `monitor error`、`sync error`（如 token 错误时的 403、网络错误）；`litestream heartbeat listener failed` 表示服务没能监听 8081 端口。见「Litestream」。
