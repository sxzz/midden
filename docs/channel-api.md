# Core / channel 内部协议

本接口只挂载于 `CHANNEL_LISTEN`，默认 `127.0.0.1:8081`。Compose 中为 `:8081`，仅容器网络可达。公共 `:8080` 不注册内部路由。内部接口不要求 Authorization；携带浏览器 Origin 的请求被拒绝。租约字段仅用于防止过期任务确认，不是服务认证。

所有路径以 `/internal/v1/channels/{channel_id}` 开头。渠道必须与 core 数据库配置的 Telegram channel 一致；租户由已登记渠道和输入 actor 解析，请求不接受 tenant ID。完整类型见 `internal/channelapi/types.go`。

| 方法与后缀                      | 用途                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `GET /config`                   | Bot 配置、Web URL、持久化轮询 offset                                            |
| `POST /events`                  | 持久化规范化输入；按渠道与 update_id 去重；返回是否删除凭据原消息               |
| `POST /work/claim`              | 最长等待 20 秒；返回 work 和 90 秒租约，无任务返回 204                          |
| `POST /work/{id}/ack`           | 续租、批次进度、message_id、完成或延后重试；重复完成确认幂等                    |
| `POST /actions`                 | 在 event 的 actor 上下文执行业务动作并保存结果；重试返回已存结果                |
| `GET /work/{id}/delivery`       | 收藏、任务暂停状态和集合进度（含中止状态）；由 channel 生成 Telegram 文本与按钮 |
| `GET /work/{id}/assets/{asset}` | 校验领取任务的租户与资源权限后代理私有对象数据，支持 Range                      |
| `GET/PUT/DELETE /media-cache`   | 当前 Bot 的媒体远端引用缓存；缓存不作为内容授权依据                             |
| `POST /work/{id}/normalize`     | 仅升级时使用，将旧 inbox 输入转成规范化 event                                   |

领取返回的 lease 用于动作和确认请求；读取任务资源时置于 `X-Work-Lease`。每 25 秒续租。崩溃后租约到期可重新领取，progress 和 message_id 保留。TG channel 不连接 PostgreSQL、S3 或 gRPC Adapter。

输入确认和 offset 更新处于同一个数据库事务。账号凭据在持久化之前由 core 加密，完成或永久失败后清除暂存密文。账号对话存在数据库中，因此两个进程重启都不会丢失对话。已确认的媒体批次不会再次发送；发送成功但 HTTP/TG 确认丢失仍可能重复，协议不承诺恰好一次。

Web 继续使用公共 `/v1` API，Telegram initData 的签名在 core 本地校验，不需要 channel 在线。已有收藏的查询与下载也不需要 Adapter 在线；采集和凭据校验才调用 Adapter。

`internal/app` 不处理 Telegram Update、SDK 调用或消息排版。历史 inbox 的解析在 channel 完成，core 的 `/normalize` 仅处理升级数据与凭据密文；历史 reply 的已存内容由 channel 发送。新任务统一进入 `channel_work`，不再生成 River 投递任务。
