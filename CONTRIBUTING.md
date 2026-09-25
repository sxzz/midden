# 开发指南

## 开发环境

使用 Go 1.27.1、Docker Compose。生成的 Protobuf Go 代码已提交，日常构建不需要 protoc。

```sh
make build
make test
make vet
make integration
```

`make integration` 启动独立的 Docker PostgreSQL 和 SeaweedFS，使用随机本地端口，结束后删除测试容器。测试覆盖租户隔离、身份并发、版本与配额、Telegram 交互、River 队列和数据库／对象存储恢复。缺少测试数据库环境变量时，数据库测试会跳过。

`make fmt` 运行 goimports、gofumpt、pgFormatter、Ruff、shfmt 和 Prettier。需要 Go、Node/npm、uv 和 `pg_format`。

修改 `api/adapter/v1/adapter.proto` 后，安装 protoc 并运行 `make generate`。

## Telegram 命令

命令在 `internal/app/commands.go` 的 `channelCommands` 中注册。每项包含名称、描述、参数说明、参数校验、是否接受按钮回调及处理函数。

命令路由、`/help`、回调校验和 Telegram 命令菜单均读取这份注册表。新增命令时实现处理函数并注册，无需另行修改菜单。启动时核心调用 Telegram SDK 的 `setMyCommands` 同步菜单。

按钮数据只指定动作与资源 ID。处理函数必须使用渠道身份解析出的租户上下文查询资源。

## 文档约定

- `README.md`：安装、配置和使用。
- `docs/operations.md`：部署和运维。
- `docs/architecture.md`：已经实现的服务与数据库结构。
- `CONTRIBUTING.md`：开发和测试流程。
- `.ai/`：工作记录和代理上下文，不作为产品使用说明。

开发过程、临时排查结果和未来设想不放入 README。
