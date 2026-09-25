# 验证记录（2026-09-26）

已执行：

- `go vet ./...`：通过。
- `./scripts/test-integration.sh`：通过，包含 `go test -race ./...`，使用隔离 Docker PostgreSQL 17.6 与 SeaweedFS 3.85，不使用本地 PostgreSQL 服务。
- gRPC 服务认证、Describe、账号认证拒绝与 health 检查。
- Provider HTML fixtures、无效响应、限流、URL 规范化、非公共地址拦截、Telegram UTF-16 分段和相册文件回退。
- 并发首次身份绑定、同租户多渠道共享、跨租户任务/归档/图片/游标隔离、Connection 归属与认证能力拒绝。
- 重复提交合并、历史版本、投递版本固定、重复执行恢复、上传后模拟中断、并发配额预留、垃圾对象回收、最终尝试中断后的失败协调。
- 真实 River 队列处理 100 个租户、1,000 个采集任务，全部完成；此为功能负载测试，不是生产吞吐承诺。
- Docker S3 签名读写，以及数据库 dump 恢复到第二个数据库、原图恢复到独立 bucket 后的内容、hash、身份和 RLS 验证。
- `docker build -t monitor:mvp .` 与 Compose 配置校验：通过。
- 独立 core/adapter 容器：health、租户 token、REST 提交与查询、采集失败重试、失败后零预留额度检查通过。

真实上游的已知限制：

- 宿主机对公开示例帖子 `https://x.com/jack/status/20` 请求 xdown，返回 `status: ok`，但没有参考实现需要的 HTML `data`；没有据此报告图文归档成功。
- 实际 adapter 容器中，当前网络将 `xdown.app` 解析为 `198.18.2.174`（fake-IP 地址）。安全 HTTP 客户端拒绝该非公共目的地址，任务最终明确失败。部署需使用返回真实公共地址的 DNS/网络，不应为抓取而解除内部地址保护。
- 尚未配置真实 Telegram Bot token，因此 Telegram API 行为通过本地 HTTP 测试验证，未向真实 Telegram 用户发送消息。

所有验证用容器均可移除，测试脚本自动清理自身容器。生产 S3 和 Bot 凭据需按 README 配置；未连接用户的真实平台账号。
