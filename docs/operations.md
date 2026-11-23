# 运维

## 部署结构

生产环境使用 `compose.yaml` 运行一个容器，镜像内含 Node.js 26 与 ffmpeg（用于缩略图和视频尺寸探测）。容器以非 root 用户运行，数据目录挂载到 `/data`。

对外访问需要 HTTPS 反向代理（例如 Cloudflare Tunnel），把整个域名转发到服务端口，至少包括 `/app/`、`/v1/`、`/media/`。Mini App 与 Telegram 登录都要求 HTTPS。

网页也可以继续单独部署在 Cloudflare 静态托管（`pnpm --filter @midden/web run deploy`），此时代理需把同域的 `/v1/` 与 `/media/` 转发到本服务。

## 日常操作

```sh
docker compose ps
docker compose logs --tail=100 midden
docker compose pull && docker compose up -d   # 更新
```

数据库迁移在启动时自动应用；随后补齐收藏列表的索引表 `catalog` 中缺失的行（首次部署或导入数据后可能需要几秒）。

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

恢复时停止服务，将备份的数据库文件放回 `data/midden.db`，媒体放回 `data/media/`，使用原来的 `SECRET_KEY` 启动。

数据库与媒体分别备份时，可能有少量新媒体在数据库备份中尚未出现（无害），或数据库引用了刚被回收的旧媒体；后者在维护时会被清理。需要严格一致时，先 `docker compose stop` 再备份。

## 维护任务

服务每分钟运行一次维护：

- 超过 1 小时仍未完成且没有对应任务的抓取标记为中断；
- 删除不再保存、也没有进行中抓取的收藏及其独有内容；
- 原始响应保留 7 天；没有产生新版本、也不是最新一次的抓取，其原始响应随后删除；
- 不再被引用的媒体文件 24 小时后删除；
- 为缺少缩略图的媒体补做缩略图；
- 清理过期的网页会话。

## 排查

- `GET /healthz` 返回 `ok` 表示进程正常。
- 日志为 JSON，`job failed` 表示任务最终失败，`delivery rejected` 表示 Telegram 拒绝了某条消息。
- 找不到 ffmpeg 时启动日志会提示，缩略图停用；之后装上 ffmpeg，维护任务会补做缩略图。
