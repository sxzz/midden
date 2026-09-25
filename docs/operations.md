# 运维与恢复

## 服务边界

`core` 仅使用非超级用户、非表所有者且不具备 BYPASSRLS 的 `monitor_app`。迁移和 CLI 使用管理员连接，管理员密码不注入核心或 adapter。S3 bucket 必须私有，图片经租户授权 API 读取，不暴露永久公开链接。

默认 Compose 仅将 API 和监控映射到宿主机 loopback。外网访问 API 使用 TLS 反向代理。adapter 默认明文 gRPC 仅适用于可信私有网络；跨主机、不可信网络时同时设置服务端证书/密钥和客户端 CA。

同一 Bot 一个接收者通过 PostgreSQL session advisory lock 保证；租户采集槽与图片任务也使用 session lock。进程退出后锁自动释放。每个持锁 worker 需要一个池连接，执行短事务时还会获取连接；应为控制任务和 API 保留连接余量。

## 观察与故障处理

`http://127.0.0.1:9090/metrics`：

- `monitor_task_duration_seconds`：按任务类别的执行耗时。
- `monitor_task_results_total`：采集、下载、投递等成功/失败次数。
- `monitor_queue_jobs`：按队列和状态的数量，每分钟更新。
- `monitor_queue_oldest_seconds`：最老等待任务年龄。

`/healthz` 检查数据库。Adapter 提供带服务认证的 gRPC health；启动时 Core 还验证 Describe 契约。每租户存储使用由 `/v1/usage` 查询，避免在 Prometheus 导出无界租户标签。

关注持续队列积压、provider 失败率、图片失败及 Telegram 429。失败信息对用户脱敏，不输出远端响应、token、Bot API 请求 URL。xdown 返回成功标志但没有可用内容时，采集仍然失败；不要将其判定为源帖子删除。

任务最多执行三次。进程中断的 River 任务由 stuck-job rescue 恢复；达到最终尝试后被丢弃的任务由每分钟 reconciliation 转成明确业务失败并释放预留额度。图片下载预留在重试间保留，资源失败或成功时释放。业务事务与 River 入队原子提交。

投递进度按已确认的文本/图片批次记录。Telegram 接收成功而客户端丢失响应时，重试仍可能重复发送。用户可 `/show` 再次请求归档；不要依赖 Telegram 文件作为唯一备份。

## 数据和对象备份

一致备份采用短暂停写：停止核心接收和所有 worker（默认都在 core），保持 PostgreSQL 与对象存储运行；等待核心优雅退出。必须先备份全部对象和数据库，随后再恢复写入。不要只备份当前版本对应对象，旧版本同样需要保留。

示例使用 AWS CLI（配置独立的备份凭据）与 Docker 内的 PostgreSQL 工具：

```sh
docker compose stop core
mkdir -p backup/objects
chmod 700 backup
docker compose exec -T postgres pg_dump -U postgres -d monitor -Fc > backup/database.dump
aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 sync "s3://$BACKUP_S3_BUCKET/" backup/objects/
docker compose start core
```

备份目录含用户内容，应加密存放并限制权限。管理员/服务密钥单独保管。数据库逻辑额度不包含备份副本。S3 生命周期策略不能自行删除 `tenant/objects/` 下仍被引用的内容；业务回收器只删除已标记垃圾且经过 24 小时宽限期的对象。

## 恢复到独立环境

1. 在隔离的 Docker PostgreSQL 中创建空数据库与 `monitor_app` 角色，设置新密码；本版本迁移所有者为 PostgreSQL 管理员，恢复使用同名角色或显式映射。
2. 在不启动核心的前提下，将 SQL dump 恢复到空数据库。保留权限、函数和 RLS；不要使用会丢弃这些授权的恢复方式。
3. 将对象同步到新的私有 bucket，保持对象 key 完全不变。
4. 配置新数据库、bucket 和服务认证。验证原 Channel UUID、Bot ID、身份映射、归档 ID、原图 hash、旧版本和跨租户不可见性。
5. 原环境仍在线时，不启动第二个相同 Bot 接收者。切换前先停止原接收者。

```sh
# 空数据库和角色已准备，核心尚未启动。
docker compose exec -T postgres pg_restore -U postgres -d monitor --exit-on-error < backup/database.dump
aws --endpoint-url "$RESTORE_S3_ENDPOINT" s3 sync backup/objects/ "s3://$RESTORE_S3_BUCKET/"
```

`make integration` 自动执行一个小规模真实演练：在 Docker PostgreSQL/S3 保存图文和身份，导出数据库及原图，恢复到第二个数据库与独立 bucket，再校验文本、图片 hash、身份和 RLS。演练使用测试容器，不会操作生产数据。

## 管理命令

```sh
monitorctl migrate
monitorctl app-password                  # APP_DB_PASSWORD 环境变量
monitorctl tenant-create
monitorctl token-create <tenant-uuid>    # 仅本次输出明文 token
monitorctl token-revoke <token-uuid>
monitorctl channel-create <stable-channel-uuid> <bot-numeric-id>
```

所有命令使用 `ADMIN_DATABASE_URL`。已有租户的 quota_bytes 可由管理员在核对租户 ID 后更新；更改默认 TENANT_QUOTA_BYTES 仅影响之后新建的租户。多渠道身份关联及账号 Connection 的管理尚未开放，不通过未经验证的用户名、昵称或任意客户端 tenant_id 执行绑定。
