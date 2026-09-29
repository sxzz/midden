# Macmini 固定域名与 Cloudflare Tunnel

本方案将一个已属于 Cloudflare zone 的固定域名连接到 Macmini 的 `http://127.0.0.1:18080`，同时提供 Mini App `/app/` 与 REST `/v1/`。管理端口 19090、内部渠道端口 8081 和 S3 端口均不进入隧道。

使用 locally-managed tunnel 和当前用户的 LaunchAgent，无需 sudo。LaunchAgent 在该用户登录 macOS 后运行，注销时停止；机器重启后需要用户登录，不能代替开机即运行的系统服务。[Cloudflare macOS 服务说明](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/as-a-service/macos/)、[Apple LaunchAgent 生命周期](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)。

## 准备账户资源

在 Macmini 安装 Node.js 和 `cloudflared`。先完成浏览器授权，然后创建专用 tunnel 与 DNS 记录；下面命令会修改 Cloudflare 账户资源，应使用所选正式域名：

```sh
cloudflared tunnel login
cloudflared tunnel create midden
cloudflared tunnel route dns <tunnel-uuid> midden.example.com
```

创建结果包含 tunnel UUID 和本机 credentials JSON 路径。不要将 credentials JSON 或登录产生的 `cert.pem` 提交 Git、打印到日志或发送到聊天。[官方创建流程](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/)。

## 安装当前用户服务

在已登录 macOS 的用户下运行；通过 SSH 操作时，仍需同一用户已有图形登录 session：

```sh
node scripts/install-cloudflare-tunnel.mjs \
  midden.example.com \
  <tunnel-uuid> \
  /Users/kevin/.cloudflared/<tunnel-uuid>.json
```

脚本仅安装本机 connector，不创建 tunnel、不修改 DNS，也不修改其他 cloudflared 服务。它校验凭据中的 UUID，将凭据复制到权限为 0700 的 `~/.cloudflared/midden/` 目录，配置及凭据权限为 0600。配置仅匹配指定域名，并以 404 规则兜底；这是 Cloudflare 要求的 ingress 结构。[配置说明](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/)。

运行 `--prepare-only` 可仅生成配置和 plist，不注册服务；通过 `--cloudflared /opt/homebrew/bin/cloudflared` 可指定程序路径。脚本会先校验配置，再更新自身的 `org.midden.cloudflared` LaunchAgent。重复安装会重新载入该服务，有短暂连接中断。

文件位置：

- 配置：`~/.cloudflared/midden/config.yml`
- 凭据：`~/.cloudflared/midden/credentials.json`
- 服务：`~/Library/LaunchAgents/org.midden.cloudflared.plist`
- 日志：`~/.cloudflared/midden/stdout.log`、`stderr.log`

注册成功只表示 launchd 已接受配置，尚不能证明 DNS、Cloudflare 连接或源站健康。校验：

```sh
launchctl print "gui/$(id -u)/org.midden.cloudflared"
tail -n 30 ~/.cloudflared/midden/stderr.log
curl -fsS http://127.0.0.1:19090/healthz
curl -fsS -o /dev/null -w '%{http_code}\n' https://midden.example.com/app/
```

如注册失败，先确认当前用户图形 session 存在，查看本地日志，再重新运行安装命令。日志文件由 launchd 追加，日常运维需按实际增长量轮换。

## 绑定正式 Bot

确认 HTTPS 页面可访问后，将数据库 `web_app_url` 设为完整地址并重启 core 和 Telegram：

```sh
docker compose run --rm --no-deps --entrypoint monitorctl migrate \
  config-set web_app_url https://midden.example.com/app/
docker compose restart core
docker compose --profile telegram restart telegram
```

从 Telegram 私聊检查「打开」菜单。Web 登录仍使用 Bot 验签和会话认证；不要为 `/v1/` 的认证或媒体响应设置共享缓存。部署与菜单排查参见 [运维文档](operations.md#mini-app-部署)。

## 停止与卸载

```sh
launchctl bootout "gui/$(id -u)/org.midden.cloudflared"
rm ~/Library/LaunchAgents/org.midden.cloudflared.plist
```

上述操作保留私密配置和凭据，以及 Cloudflare 的 tunnel/DNS 资源。是否删除这些资源需另行决定。
