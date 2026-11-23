# 旧版数据导入

把旧版（Go，PostgreSQL + SeaweedFS）的数据转成新版的数据目录（`midden.db` 与 `media/`），可直接作为 `DATA_DIR` 使用。

## 用法

在仓库根目录运行，`SECRET_KEY` 填新版的密钥：

```sh
# 旧版 scripts/backup.sh 生成的备份：数据库、bucket 对象和 .env 都从里面取
SECRET_KEY=... mise exec postgres@17 -- \
  node tools/import-legacy/src/main.ts --backup 20261124-030000.tgz \
    --tenant <所有者的租户 id> --out data

# 单独的 pg_dump -Fc 和对象目录（里面是 objects/<uuid>）
SECRET_KEY=... mise exec postgres@17 -- \
  node tools/import-legacy/src/main.ts --dump database.dump \
    --objects s3/monitor --legacy-env old.env --out data

# 直接连旧库，从 S3 读对象；S3_* 与 CREDENTIAL_KEY 取自旧 .env
SECRET_KEY=... node tools/import-legacy/src/main.ts \
  --database-url postgres://... --s3 --s3-endpoint http://127.0.0.1:18333 \
  --legacy-env old.env --out data
```

- `--backup`、`--dump` 会把 dump 恢复到一个临时 PostgreSQL 里再读，所以需要 PATH 上有 `initdb`、`pg_ctl`、`pg_restore`。用 `mise exec postgres@17 --` 即可。直接连库时只读，整个导入在一个只读快照里完成。
- 旧库的账号凭据要用旧的 `CREDENTIAL_KEY` 解密，它取自旧 `.env`，也可以用环境变量 `CREDENTIAL_KEY` 覆盖。凭据会用新 `SECRET_KEY` 重新加密，所以以后运行新版时必须用同一个 `SECRET_KEY`。
- `--out` 已存在时拒绝执行，加 `--force` 才替换。结果先写到 `<out>.partial`，全部成功后才改名为 `<out>`；失败时 `.partial` 留着供排查，下次运行会删掉。
- 每个对象复制时都会重新计算 sha256，与 `blobs.hash`、`blobs.size` 核对。不一致或缺少对象时报错退出（退出码 1）。加 `--allow-missing-media` 可以容忍缺失的对象，这些媒体在新版里会打不开。

完成后输出每张表的行数对比和媒体核对结果（以下是测试数据的输出）：

```
table                                    old rows  imported  note
collections                                     3         3
tenant_collections → library                    2         2
captures                                        4         4  1 queued/downloading → failed (capture was interrupted)
entities                                        3         2  1 without any referenced version skipped
entity_versions                                 4         2  1 unreferenced skipped; 1 merged into an equal version
...
blob_thumbnails                                 1         —  not imported; maintenance renders them again

media: 3 blobs, 3 copied (94.2 KiB), each checked against blobs.hash and blobs.size
  all hashes match
```

## 转换规则

- 新版只有一个用户。旧库有多个租户时必须用 `--tenant <uuid>` 指定所有者：收藏、备注、标签、账号、账号选择、采集记录和批量刷新只取这个租户的；帖子、版本、实体、媒体等内容全部导入，其中只有其他租户收藏的帖子会标为未引用，由新版维护任务删除。
- 去掉 `tenant_id`、可见性和 Telegram 投递相关的列。UUID 原样保留，时间存毫秒。
- `tenant_collections` → `library`，`tenant_preferences` → `account_selections`。
- 进行中的采集（`queued`、`downloading`）改为 `failed`，错误信息为 `capture was interrupted`；同时把它们待下载的媒体标为失败，并删掉它们的原始响应，与新版维护任务的做法一致。待展开的翻页（`related_state = 'pending'`）改为 `failed`，进行中的批量刷新改为 `failed`（`refresh was interrupted`），因为旧任务队列不会导入，没有任务会继续它们。
- `related_targets`、`capture_options` 改成新版的 camelCase 字段；`refresh_batches` 的 uuid 数组改成 JSON 数组。
- 版本载荷里的实体去掉 `schema`。实体版本与版本的 `content_hash` 都按新算法重算。旧哈希包含 JSON Schema，所以只有 schema 不同的版本会合并成最早的那个，引用随之改指。没有任何版本引用的实体版本以及没有版本的实体不导入（旧版的回收本来也会删掉它们）。
- 对象 key 可以是 `objects/<uuid>`，也可以是早期带租户前缀的 `<uuid>/objects/<uuid>`。
- `blobs` 没有创建时间，取第一个用到它的采集的创建时间；`connections` 的创建时间取导入时间。
- 不导入：缩略图（新版维护任务会补做）、任务队列、网页会话、token、租户与访问控制、Telegram 相关表、`config`、`objects`。

## 测试

测试从旧版的迁移（`test/legacy-migrations/`，取自旧版 `main` 的 6e078a0）建库，写入构造数据，再跑完整的导入。需要 PostgreSQL，没有时跳过：

```sh
mise exec postgres@17 -- pnpm --filter @midden/import-legacy test
```
