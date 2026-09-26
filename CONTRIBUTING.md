# 开发指南

## 开发环境

使用 Go 1.27.1、Node.js 24、Docker Compose。生成的 Protobuf Go/TS 代码已提交，日常构建不需要 protoc。首次运行 `npm ci --ignore-scripts` 和 `npm run build`；Go 的跨语言测试使用构建后的 TS Adapter。

```sh
make build
make test
make vet
make integration
```

`make integration` 启动独立的 Docker PostgreSQL 和 SeaweedFS，使用随机本地端口，结束后删除测试容器。测试覆盖租户隔离、身份并发、版本与配额、Telegram 交互、River 队列和数据库／对象存储恢复。缺少测试数据库环境变量时，数据库测试会跳过。

`make fmt` 运行 goimports、gofumpt、pgFormatter、Ruff、shfmt 和 Prettier。需要 Go、Node/npm、uv 和 `pg_format`。

修改 `api/adapter/v1/adapter.proto` 后，安装 protoc 并运行 `make generate`。

## 发布前数据库变更

首次发布前直接修改 `internal/store/schema.sql`，通过清空开发数据库和对象存储重新初始化验证。不维护旧数据兼容、迁移或旧 ID 映射，不因结构调整递增 schema 版本。数据库及对象存储使用 Docker。

Provider 必须声明支持的 public/private，并在结果中返回实际可见性，不能由用户请求控制。共享内容测试使用 public Provider，隔离测试使用 private Provider。

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

## X 解析器

图文结果组织参考 [nonebot-plugin-parser-m](https://github.com/LoCCai/nonebot-plugin-parser-m) 的 `BaseParser` / `ParseResult`。TS 实现使用公共 FxTwitter API 与可选账号 Provider，由核心统一下载和持久化媒体。Atmosphere 源码版本及本地补丁记录在 `third_party/atmosphere/UPSTREAM.md`。

FxTwitter 响应结构见其 [API v2 文档](https://docs.fxembed.com/api/twitter/operations/2statusid/)。正文必须匹配请求的帖子 ID；测试使用本地固定响应，不依赖在线服务。

## 协议变更

Adapter 契约见 [架构文档](docs/architecture.md#adapter-协议与能力发现)。修改 proto 后运行 `make generate`，同时提交 Go 与 TypeScript 生成文件。协议 major/minor 与 Provider 能力 major/minor 独立；新增可选操作无需所有 Adapter 实现。添加操作时同时定义能力、调用前检查、未知能力处理和缺少能力时不产生副作用的测试。发布后的 protobuf 字段号不得复用；不兼容语义使用新的 major/package。当前尚未发布，不引入旧格式兼容分支，也不为纯协议变更调整数据库 schema 版本。
