# 验证记录（2026-09-26）

已执行：

- `go vet ./...`：通过。
- `./scripts/test-integration.sh`：通过，包含 `go test -race ./...`，使用隔离 Docker PostgreSQL 17.6 与 SeaweedFS 3.85，不使用本地 PostgreSQL 服务。
- gRPC 服务认证、Describe、账号认证拒绝与 health 检查。
- Provider JSON fixtures、无效响应、限流、URL 规范化、Telegram UTF-16 分段和相册文件回退。
- 并发首次身份绑定、同租户多渠道共享、跨租户私有收藏/图片隔离、任务/保存游标权限、Connection 归属与认证能力拒绝。
- public 内容跨租户合并采集、共享版本更新与 Blob、各自回传及保存列表；private 内容与 public 分开存储，Provider 可见性缺失或不匹配时拒绝发布。
- 重复提交合并、历史版本、投递版本固定、重复执行恢复、上传后模拟中断、并发配额预留、垃圾对象回收、最终尝试中断后的失败协调。
- 真实 River 队列处理 100 个租户、1,000 个采集任务，全部完成；此为功能负载测试，不是生产吞吐承诺。
- Docker S3 签名读写，以及数据库 dump 恢复到第二个数据库、原图恢复到独立 bucket 后的内容、hash、身份和 RLS 验证。
- `docker build -t monitor:mvp .` 与 Compose 配置校验：通过。
- 独立 core/adapter 容器：health、租户 token、REST 提交与查询、采集失败重试、失败后零预留额度检查通过。

联调范围：

- 本地已配置 Telegram Bot 并验证身份；SDK、编辑消息、相册回退和按钮回调使用本地模拟 API 验证，不自动向真实用户发送测试消息。

所有验证用容器均可移除，测试脚本自动清理自身容器。生产 S3 和 Bot 凭据需按 README 配置；未连接用户的真实平台账号。
