# 开发指南

## 开发环境

使用 Go 1.27.1、pnpm 12、Node.js 24、FFmpeg（提供 ffprobe）、Docker Compose。生成的 Protobuf Go/TS 代码已提交，日常构建不需要 protoc。首次运行 `pnpm install --frozen-lockfile --ignore-scripts` 和 `pnpm build`；Go 的跨语言测试使用构建后的 TS Adapter。

包管理器和 Node.js 版本由根目录 `package.json` 的 `devEngines` 声明，解析结果及校验和保存在 `pnpm-lock.yaml`。工作区在 `pnpm-workspace.yaml` 定义，内部依赖使用 `workspace:` 协议。CI 和 Docker 使用冻结锁文件安装。升级 pnpm 时需同步更新 `scripts/install-pnpm.mjs` 中官方 Linux 发布包的 SHA-256；升级 Node.js 时需同步 Docker 基础镜像版本。

```sh
make build
make test
make vet
make integration
```

`make integration` 启动独立的 Docker PostgreSQL 和 SeaweedFS，使用随机本地端口，结束后删除测试容器。测试覆盖租户隔离、身份并发、版本与配额、Telegram 交互、River 队列和数据库／对象存储恢复。缺少测试数据库环境变量时，数据库测试会跳过。

`make fmt` 运行 goimports、gofumpt、pgFormatter、Ruff、shfmt 和 Prettier。需要 Go、Node/pnpm、uv 和 `pg_format`。

修改 `api/adapter/v1/adapter.proto` 后，安装 protoc 并运行 `make generate`。

## 发布前数据库变更

Protocol 固定为 `1.0`，schema 固定为 `1`，正式发布前不因新增字段或功能递增。当前完整结构是 `internal/store/migrations/0001_initial.sql` 基线，不保留此前的升级路径。

从此基线开始，需要保留服务器数据。新增数据库变更放入 `internal/store/migrations/YYYYMMDDHHMMSS_description.sql`，按文件名排序；迁移文件名是执行顺序，不是 schema 版本号。已经部署的 SQL 不修改、不删除、不插入到已执行历史之前。迁移和校验和存入 `schema_migrations`，重复部署跳过已执行文件，修改历史或降级到缺少已执行文件的构建会报错。每个文件在一个事务中执行，不在文件内写 BEGIN/COMMIT，不使用不能在事务内执行的 DDL。需要更新已有 SQL 函数时在新文件内使用 CREATE OR REPLACE。

新建配置用 INSERT ... ON CONFLICT DO NOTHING，避免覆盖运营者设置。数据修复与结构修改一起写入迁移，并测试带数据升级、重复执行、失败回滚。数据库及对象存储使用 Docker。

Provider 必须声明支持的 public/private，并在结果中返回实际可见性，不能由用户请求控制。共享内容测试使用 public Provider，隔离测试使用 private Provider。

## Telegram 命令

命令定义在 `internal/tgchannel/event.go`，文字、按钮和媒体展示在 `internal/tgchannel/`。该包只使用 `channelapi` 协议、通用收藏类型和 Telegram SDK，不引入数据库、对象存储或 Adapter 客户端。业务动作在 core 的 `internal/app/channel_actions.go` 实现。

独立 `cmd/telegram` 启动时同步命令菜单。内部 HTTP 接口与公网 API 使用不同监听端口；协议测试用 `httptest` 模拟 Telegram，不需要真实 Bot。共享数据库集成测试串行运行各 Go 包，避免另一个包的 River worker 消费当前测试的任务。

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

FxTwitter 响应结构见其 [API v2 文档](https://docs.fxembed.com/api/twitter/operations/2statusid/)。正文必须匹配请求的帖子 ID；测试使用本地固定响应，不依赖在线服务。Fixture 使用合成作者、帖子 ID 和内容，媒体地址使用 `.test` 域名；不要提交真实用户资料、帖子链接、Cookie 或诊断响应。

## 协议变更

Adapter 契约见 [架构文档](docs/architecture.md#adapter-协议与能力发现)。修改 proto 后运行 `make generate`，同时提交 Go 与 TypeScript 生成文件。协议 major/minor 与 Provider 能力 major/minor 独立；新增可选操作无需所有 Adapter 实现。添加操作时同时定义能力、调用前检查、未知能力处理和缺少能力时不产生副作用的测试。发布后的 protobuf 字段号不得复用；不兼容语义使用新的 major/package。当前尚未发布，protocol 保持 `1.0`，不引入旧格式兼容分支，也不为纯协议变更调整数据库 schema 版本。

## 实体结构

公共 proto 只定义实体图、Schema 声明、资源引用和可选展示字段，不添加平台专属 message。新增实体类型在 Adapter 中定义 JSON Schema 2020-12，通过 Describe 声明，在 Provider 上声明 entity.graph 与支持的类型列表。Schema 使用内置定义与本地引用，不依赖外部 Schema 服务。Fetch 返回实体数据、图内关系和资源索引；核心无需增加平台字段或专用表。测试应覆盖 Schema 校验、实体身份与作用域隔离、历史快照、关系和关联资源；通用渠道展示不能解析平台 data。

## 本地开发部署

按 README 初始化本地 Docker 服务后，使用：

```sh
./scripts/dev.sh          # Go 核心：增量编译、执行迁移、重启 core
./scripts/dev.sh telegram # 显式启动／更新 Telegram channel
./scripts/dev.sh adapter  # TS Adapter：缓存构建、仅重启 adapter
./scripts/dev.sh all      # 更新两者
```

核心使用宿主机 Go 编译缓存，针对 Docker 的 Linux 架构编译到忽略提交的 `.local/dev/bin`，通过 `compose.dev.yaml` 挂载到已有运行时镜像，不需要每次重建镜像。首次缺少运行时镜像时自动构建。数据库、对象存储和配置保持原样；本地服务须已启动。修改运行时镜像依赖时需重新构建 core 镜像。

后续本地更新继续使用此脚本；手动运行 Compose 时包含 `-f compose.yaml -f compose.local.yaml -f compose.dev.yaml`，以保留二进制挂载。普通 Compose 配置不包含此开发挂载。

完整镜像构建仍可使用：

```sh
docker compose -f compose.yaml -f compose.local.yaml -f compose.build.yaml build core adapter
```

镜像 CI 按 core/adapter 分开缓存 BuildKit 构建层；core 额外将 Go 编译缓存挂载持久化到 GitHub Actions Cache，以便源码变化时仍能复用编译结果。测试 CI 缓存 Go 模块、编译结果及 pnpm 下载。

生产 Compose 使用 GHCR 镜像。GitHub Actions 在 main 测试通过后发布两个架构的镜像。服务器部署使用完整提交 SHA 标签，与迁移文件保持一致。

## 平台逻辑边界

URL 规范化、平台对象标识、Cookie 解析、上游请求和媒体缓存键由 Adapter 实现。Go 核心负责通用存储、权限、调度和不透明凭据加密，不根据平台名称或 Provider ID 分支。Telegram 渠道可提供 X 专属交互，但必须检查 Adapter 能力；更换 Adapter 不应要求修改核心。新增平台功能应同时增加非 X fixture 的回归覆盖。

## 收藏网页开发

`web/` 是独立 pnpm 工作区，使用锁定版本的 Vue 3.6 RC Vapor、TypeScript 和 Vite。组件使用 `<script setup vapor lang="ts">`，不依赖 VDOM 互操作；平台展示逻辑放在前端展示器中，公共 API 客户端和数据类型不依赖 Telegram SDK。

```sh
pnpm --filter @midden/web dev
pnpm --filter @midden/web build
pnpm --filter @midden/web test
pnpm --filter @midden/web exec playwright install chromium
pnpm --filter @midden/web test:e2e
```

Vite 将 `/v1` 代理到本地 core。真实 Telegram 登录需要同域 HTTPS；浏览器测试使用合成数据和模拟 API，不需要生产凭据。可用 `PLAYWRIGHT_CHANNEL=chrome` 使用已安装的 Chrome。Vitest 显式加载 Vue bundler 运行时，避免 Node 入口缺少 Vapor 导出。

`pnpm build` 包含网页构建。core 从 `WEB_DIST` 读取静态文件，未设置时使用 `web/dist`；发布镜像自带前端产物。`scripts/dev.sh` 会构建并挂载本地网页。前端产物和浏览器测试输出不提交。
