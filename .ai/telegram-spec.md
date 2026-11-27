# Telegram bot: behavioral specification of the Go implementation

This spec describes how the old Go Telegram bot (`<old Go checkout>`, branch `golang`) behaves. It is detailed enough to reimplement the bot in grammY without reading the Go code again. Capture internals (Submit, related expansion, continuation pages, refresh batches) live in `.ai/capture-spec.md`; this file covers only what the bot sends, receives and decides. Where the rewrite decided to differ, the difference is stated; open questions are marked **Decide**.

## 0. Conventions and scope

### Citations

Paths are relative to `<old Go checkout>`.

| short    | file                         |
| -------- | ---------------------------- |
| `tgc/`   | `internal/tgchannel/`        |
| `tg/`    | `internal/telegram/`         |
| `app/`   | `internal/app/`              |
| `deploy` | `scripts/deploy-webhook.mjs` |

### Architecture in Go, and what changes

- Go runs two processes. `core` owns the DB. `cmd/telegram` (`cmd/telegram/main.go:15-33`) polls Telegram and talks to core over an internal HTTP API (`internal/channelapi`, `internal/httpapi/channel.go`).
- Every update becomes an `event` work item; every outgoing capture message is a `delivery` work item (or `batch` for refresh batches). Both live in `channel_work`, are claimed with a lease and acknowledged with a checkpoint (`app/channel_api.go:108-180`).
- The rewrite runs grammY long polling in the same process as the HTTP API and the capture pipeline. The internal API, leases and channel UUIDs disappear. The **delivery semantics** (§6) still matter: resumable, checkpointed, at-least-once.

### Dropped features (one line each, only where they touch flow)

- **Multi-tenancy / identities.** `ChannelEvent` resolves the actor to a tenant and stores the actor's profile (`app/channel_api.go:43-74`). Rewrite: accept only `OWNER_TELEGRAM_ID`; drop everything else before any work.
- **Requester-only buttons in groups.** A group callback from someone other than the requester got `problem=foreign_message` (`app/channel_api.go:80-93`) and the reply `仅限发起者操作。` (`tgc/commands.go:25-27`). Rewrite: non-owner callbacks are ignored (see §2.1).
- **「我也要存」(save too).** Group collection messages of public content carried `/save <collection id>` (`tgc/runner.go:352-354`), normalized to `save_shared` (`tgc/event.go:103-105`), toast `已保存。` (`tgc/commands.go:117-119`). Dropped.
- **Channel API, inbox/replies queues, legacy envelopes.** `tgc/runner.go:196-209`, `tgc/runner.go:276-308`, `app/channel_legacy.go`. Dropped, including old messages' callback data compatibility.
- **Bot identity check.** Startup compared `getMe` with the configured channel's bot ID (`tgc/runner.go:35-41`). Dropped.
- **Quota.** `/usage` printed the limit and reserved bytes. The rewrite prints only used space (rewrite plan).

## 1. Startup

Order (`tgc/runner.go:24-60`):

1. Load config: bot token, web app URL, persisted polling offset.
2. `getMe`, to learn the bot username. The username is needed for group addressing (§2.3).
3. Sync the command menus (§3.2).
4. Set the menu button (§8).
5. Start polling and two serial workers.
   - The **event** lane answers commands.
   - The **delivery** lane sends capture messages.
   - The comment at `tgc/runner.go:53-55` explains the split: a delivery can spend minutes uploading media, and commands must still be answered. Each lane is serial, so messages to a chat keep their order.

Rewrite: grammY handlers replace the event lane. Keep a separate serial delivery worker, so a slow upload never blocks command replies.

## 2. Update intake

### 2.1 Polling and who is accepted

- **Polling.** `getUpdates` with `timeout=30`, `limit=100`, `allowed_updates=["message","callback_query"]` (`tg/client.go:182-198`). The HTTP timeout is 75 s (`tg/client.go:63`). On error, pause 3 s (`tgc/runner.go:96-98`).
  - `edited_message`, `channel_post` and other update types are never received.
- **Offset.** The offset is durable. Core stores `next_offset = max(next_offset, update_id+1)`, also for ignored updates (`app/channel_api.go:31-35,102`). It is loaded at startup (`app/channel_api.go:22-25`).
  - It advances only after the event is stored. A crash re-delivers the update. The event's ID is `uuid5(channel, update_id)` and the insert is `ON CONFLICT DO NOTHING`, so a re-delivered update is not processed twice (`app/channel_api.go:47,56-65,99`; test `internal/httpapi/channel_test.go:100-111`).
  - Rewrite: grammY's runner/polling confirms offsets itself. To keep exactly-once handling across a crash, either accept the rare duplicate or store processed `update_id`s.
- **Actor filter** (`ActorMessage`, `tg/client.go:151-180`; test `tg/group_test.go:16-43`). An update has no actor, and is dropped, when any of these holds:
  - the message is missing;
  - `from.is_bot` is true;
  - `from.id <= 0`;
  - `sender_chat` is set (anonymous admin or channel identity);
  - the chat type is not one of `private`, `group`, `supergroup`;
  - a private chat has `chat.id != from.id`;
  - a group has `chat.id >= 0`.
- **Callbacks.** The actor is `callback_query.from`, applied to the callback's message (`tg/client.go:153-163`). A callback without a message, or from a bot, is dropped.
  - Test `tg/client_test.go:160-203`: in a private chat, a callback from a user other than the chat's user is rejected.
- **Rewrite.** Additionally require `from.id == OWNER_TELEGRAM_ID`.
  - Private chats with anyone else are ignored.
  - In groups, only the owner's addressed messages (§2.3) and the owner's callbacks are handled.
  - **Decide:** whether to answer a non-owner's callback silently (recommended, so the spinner stops) or not at all. Go answered every stored callback (§4.1).

### 2.2 Normalization (`Normalize`, `tgc/event.go:52-111`)

Input text:

- Private message: `message.text`. Captions are not used as the input text, but their URLs are extracted.
- Group message: the addressed text, with the bot mention blanked out (§2.3).
- Callback: `callback_query.data`.

Parsing:

- **Command.** If the first whitespace field starts with `/`, the command is that field without the `/` and without any `@suffix`. The argument is the rest of the input, trimmed (`tgc/event.go:86-90`).
  - In private chats an `@OtherBot` suffix is not checked.
- **No command.** The operation is `save` (`tgc/commands.go:37-40`).
- **URLs** come from `URLs(message)` (§2.4). For callbacks, the URLs come from the bot's message the button sits on. They are unused, because callbacks always carry a command.
- **`/account_add`** is retired (`tgc/event.go:91-102`; test `tgc/runner_test.go:107-114`).
  - Anything after it (minus a leading `@platform` token) is treated as a pasted credential.
  - Text, argument and URLs are cleared, so the credential never reaches any other field.
  - A non-empty credential causes the user's message to be deleted (§4.2).
- **Invalid callback data** (`validCallback` false) becomes `help` with no argument (`tgc/event.go:106-109`). See §5.1 for the grammar.

### 2.3 Group addressing (`groupTrigger`, `tgc/event.go:142-164`; `AddressedText`, `tg/mention.go:10-42`)

A group message is handled only if **both** of these hold:

1. **It is addressed to the bot.** Entities are scanned in both text and caption, with offsets and lengths in UTF-16 units. Out-of-range entities are skipped.
   - A `mention` entity whose value equals `@<botusername>` (case-insensitive) addresses the bot. That mention is replaced with spaces in the text, and the text is trimmed.
   - A `bot_command` entity whose `@suffix` equals the bot username (case-insensitive) addresses the bot.
   - Plain-text `@Bot` without an entity does not count. Neither does a `code` entity, or a longer username that starts with the bot's (`@OurBotExtra`).
2. **It is a command or carries a link.**
   - Either the first field of the addressed text is `/` + a known command (§3.1), with any `@suffix` equal to the bot username;
   - or the message contains at least one URL (§2.4) that passes `ValidateURL`: http/https, has a host, no userinfo (`internal/domain/domain.go:33-39`).
   - A first field of `/cmd@OtherBot` rejects the message (`tgc/event.go:147-151` and again `tgc/event.go:69-77`).

Ignored in groups:

- bare links;
- bare `/usage` without `@bot`;
- `@bot hello` with no link and no command;
- replies to the bot's messages without a mention;
- anything addressed to another bot.

Callbacks in groups are always accepted. They are not subject to the trigger.

Test cases (`tgc/group_trigger_test.go:9-36`, `tgc/runner_test.go:87-106`):

| input                               | entities          | handled               |
| ----------------------------------- | ----------------- | --------------------- |
| `https://x.com/a/status/20`         | none              | no                    |
| `/usage`                            | bot_command(0,6)  | no                    |
| `/usage@OurBot`                     | bot_command(0,13) | yes                   |
| `/usage@OtherBot`                   | bot_command(0,15) | no                    |
| `@OurBot https://x.com/a/status/20` | mention(0,7)      | yes                   |
| `@OurBotExtra https://…`            | mention(0,12)     | no                    |
| `@OurBot https://…`                 | code(0,7)         | no                    |
| `@ourbot /usage`                    | mention(0,7)      | yes (command `usage`) |
| `😀 @OurBot https://…`              | mention(3,7)      | yes (UTF-16 offsets)  |
| caption `@OurBot https://…`         | caption mention   | yes                   |

### 2.4 Link extraction (`URLs`, `tg/client.go:468-492`; test `tg/client_test.go:20-26`)

For the text and then the caption, in that order:

1. Every `text_link` entity contributes its `url`. Hidden links count.
2. Every `url` entity contributes its substring, taken by UTF-16 offset and length. Out-of-range entities are skipped.
3. Every whitespace-separated word, after trimming the characters `<>[]()，。！,!` from both ends, contributes itself if it starts with `https://` or `http://`.

There is no de-duplication here. A plain link with a `url` entity therefore appears **twice**.

Limits and de-duplication for `save`:

- If more than 200 extracted URLs remain, the reply is `每次最多 200 个链接。` and nothing is saved (`tgc/commands.go:63-66`; checked again in `app/channel_actions.go:98-100`).
  - Because of the duplication above, about 101 distinct linked URLs already exceed the limit. **Decide:** de-duplicate before counting in the rewrite (recommended); the help text promises 200.
- Each URL is resolved by the platform adapters (`app/channel_actions.go:101-110`).
  - URLs that fail to resolve are silently skipped.
  - Resolved targets are de-duplicated by `platform|kind|object_scope|external_id`.
  - Each unique target is submitted with the selected account for its platform. The idempotency key is `<event id>:<hash(key)>` and the input is the raw URL.
  - Submit errors are collected as display strings (`safeError`, `app/worker.go:135-160`); successes are counted.

## 3. Commands

### 3.1 Command table (`tgc/event.go:22-35`)

The menu descriptions are verbatim. "Private-only" commands are omitted from the group menu and the group help. In a group they reply `请在私聊中使用此命令。` (`tgc/commands.go:31-36`). The `Usage` strings exist in the table but are never displayed anywhere.

| command          | menu description | usage (unused) | private-only |
| ---------------- | ---------------- | -------------- | ------------ |
| `start`          | 开始使用         |                | yes          |
| `save`           | 保存帖子         | `<帖子链接…>`  | no           |
| `list`           | 查看收藏列表     | `[游标]`       | yes          |
| `show`           | 查看指定收藏     | `<收藏 ID>`    | no           |
| `status`         | 查看采集状态     | `<任务 ID>`    | no           |
| `retry`          | 使用当前账号重试 | `<收藏 ID>`    | no           |
| `refresh`        | 重新抓取帖子     | `<收藏 ID>`    | no           |
| `delete`         | 删除             | `<收藏 ID>`    | no           |
| `account_delete` | 删除采集账号     | `[账号 ID]`    | yes          |
| `account`        | 选择采集账号     |                | no           |
| `usage`          | 查看存储用量     |                | no           |
| `help`           | 查看使用帮助     |                | no           |

Other operations exist only as callback data, though typing them in a private chat also works: `more`, `more1000`, `page_retry`, `collection_stop`, `batch_retry`. In groups they are not "known commands", so a typed `/more@Bot` is not triggered.

An unknown command, e.g. `/foo` in private, reaches the action layer, fails as unsupported, and gets the generic failure reply (§7.2).

### 3.2 Menu sync (`tg/client.go:543-550`)

At startup:

- `setMyCommands` with the default scope gets all 12 commands, in table order.
- `setMyCommands` with scope `all_group_chats` gets the 9 commands that are not private-only (`tgc/event.go:37-46`).
- No language code is set.

### 3.3 Reply conventions for event replies (`tgc/runner.go:191-253`, `tgc/commands.go:23-30`)

- **Default keyboard.** Unless a command replaces it, a reply carries `menuButtons`: one row `[收藏列表 → /list] [存储用量 → /usage]` (`tgc/event.go:48-50`).
- **Edit in place vs new message.**
  - A reply to a **callback in a private chat** edits the message the button is on (`previous = callback message id`), unless that message is a capture message.
  - "Capture message" means any message stored as `submissions.message_id`: a status, collection or progress message. Such messages are `protected` (`app/channel_api.go:75-79`) and get a new message instead.
  - These replies always send a new message (`previous=0`): `start` with a web URL, `save`, `collection_stop`, `delete`, `batch_retry`.
  - Typed commands always send new messages.
  - Rewrite: track the bot's capture message IDs, the equivalent of `submissions.message_id`, to keep this rule.
- **Groups.**
  - Replies never edit.
  - New messages are sent as replies (`reply_to_message_id`) to the triggering message. For callbacks, that is the bot message holding the button (`tgc/runner.go:227-230`).
  - Keyboards pass through `groupButtons` (§5.3).
- **Empty text.** If the reply text is empty, nothing is sent (`tgc/runner.go:224-226`).
- **Long replies.** Text is split into parts (§5.5). Only the first part carries the keyboard and may edit; the rest are new messages (`tgc/runner.go:231-252`).
- **Formatting.** No `parse_mode` anywhere. Formatting uses explicit `entities` with UTF-16 offsets. Link previews are always disabled (`disable_web_page_preview=true`, `tg/client.go:293,313`).

### 3.4 Per-command behavior

Every text below is verbatim. `\n` is a newline.

#### `/start`, `/help` (`tgc/commands.go:41-59`)

- **Text.** `发送支持的平台链接保存内容（每次最多 200 个）。`, then for each command (only non-private ones in groups) a line `\n/<name> — <description>`. The separator is an em dash with spaces.
- **`/start` only.**
  - It appends `\n\n版本：<version>`, with a `code` entity over `<version>`.
  - The version is the build revision, the VCS revision (`-dirty` if modified), or `dev` (`internal/buildinfo/version.go:8-30`).
- **Keyboard.** The menu buttons. With `/start` and a non-empty web URL, a second row `[打开]` is added as a `web_app` button to the web URL.
  - This check is only "non-empty", unlike the https check in §5.4.
  - That reply is always a new message.
- **Invalid callbacks.** Any invalid callback answers with the `/help` text.

#### `save` (plain message with links, or `/save …`) (`tgc/commands.go:111-116`)

- **More than 200 URLs.** `每次最多 200 个链接。` + menu buttons.
- **Something saved.**
  - Private: no reply text if at least one link was submitted and there were no errors. The capture's status message (§4.3) is the feedback.
  - Otherwise the reply text is the joined errors (newline-separated, from `safeError`).
- **Nothing saved, private.** `count==0` and no errors (no supported link, plain text, or a bare `/save`): `请发送支持的链接，或使用 /help。`
- **Nothing saved, group.** Nothing is sent unless there are errors.
- **Error strings.** These may be Chinese (`此平台需要账号，请先添加并选择自己的采集凭据。`, `账号不可用，请在采集账号中选择可用账号或重新授权。`, `app/worker.go:142-147`) or raw English (`provider operation unsupported`, adapter `PermanentError` messages, gRPC status messages, `operation failed; retry or inspect service health`).

#### `/list [cursor]` (private-only) (`tgc/commands.go:72-98`; paging `app/service.go:572-660`)

- **Page.** 10 saved collections, newest saved first, ordered by `(saved_at, id)`.
- **Cursors.** Base64url without padding.
  - Next page: of `<last id>`.
  - Previous page: of `p:<first id>`.
- **Text.** For item `i` (1-based), separated by blank lines: `<i>. <summary>`.
  - A `text_link` entity covers `<summary>` and links to the collection's source URL.
  - `<summary>` is the collection `summary`, falling back to `text`, with whitespace collapsed to single spaces.
  - An empty summary becomes `无文字内容`.
  - If longer than 100 runes, it is cut to 99 runes + `…`. When the text ends with a run of `[图片]`/`[视频]` markers, those are kept: the prefix is cut to `100 - len(markers) - 1` runes, then `…`, then the markers.
  - Counting is in Unicode code points, not UTF-16 (`tgc/presentation.go:137-172`; test `tgc/presentation_test.go:42-55`).
- **Keyboard.** The menu buttons are **removed**.
  - Per item: a row `[查看第<i>条 → /show <id>] [原文 → url]`.
  - Then a nav row, if any: `[← 上一页 → /list <prev>]` and/or `[下一页 → → /list <next>]`. The button label is literally `下一页 →`.
- **Empty.** `暂无收藏。` with no keyboard. An empty `inline_keyboard: []` is sent, never `null` (`tg/client.go:212-238`; test `tg/client_test.go:132-158`).
- **Paging edits.** Paging from a list message's buttons in private edits that message.
- **Bad cursor.** An invalid or unknown cursor fails, and gets the generic failure reply.
- **Groups.** Not available: private-only. `/list` buttons are also stripped from group keyboards.

#### `/show <收藏 ID>` (`app/channel_actions.go:80-92`)

- Loads the collection. If it is missing or not a UUID, the generic failure reply (§7.2) is sent.
- Creates a "show" submission: no input, idempotency key `show:<event id>`, origin chat plus the reply-to in groups. That queues a **delivery**.
- The collection is then delivered as a new message exactly like a finished capture (§4.4). It is not a capture record.
- There is no text reply.

#### `/status <任务 ID>` (task ID = capture/job ID) (`tgc/commands.go:103-110`)

- **Text.** `<jobState(state)>\n<job.error>`. The error is the **raw** stored error string, not translated.
- **Keyboard.** `[更新状态 → /status <job id>]`. When the state is `complete` or `partial`, a second row `[查看收藏 → /show <collection id>]` is added.

`jobState` (`tgc/presentation.go:13-27`):

| state         | text                 |
| ------------- | -------------------- |
| `queued`      | 正在采集             |
| `downloading` | 正在保存媒体         |
| `complete`    | 收藏完成             |
| `partial`     | 已收藏，部分资源缺失 |
| `failed`      | 收藏失败             |
| other         | the raw state        |

#### `/retry <收藏 ID>` and `/refresh <收藏 ID>` (`app/channel_actions.go:122-133`; `app/capture_records.go:330-346`)

- **`refresh`.** Refetches through the source that saved the collection: `RefreshID`, no input. If the collection's newest capture failed, it starts over from the URL with the **currently selected** account instead.
- **`retry`.** Always starts over from the URL with the currently selected account, with input = URL.
- **Idempotency keys.** `retry:<event id>`, or `refresh:<event id>` when it became a refresh.
- **Feedback.** There is no text reply. The new submission gets its own status message, then delivery (§4).
- **Errors.** The collection must be saved, or the generic failure reply is sent.

#### `/delete <收藏 ID>` (`app/channel_actions.go:134-139`; `tgc/commands.go:123-125`)

- Removes the collection from the library. Not-found counts as success.
- Reply: `已删除。` as a new message, with the menu buttons.
- The collection message itself is left unchanged.

#### `/account` (`tgc/commands.go:147-199`; `app/channel_actions.go:286-324`)

- **No argument.** Lists sources.
- **Argument `<account uuid>`.** Selects that account for its platform. The account must exist and be `ready`; otherwise the generic failure reply is sent.
- **Argument `public:<platform>`.** Selects the platform's public source. If the platform has no public provider, the generic failure reply is sent.
- **Argument `public`.** Allowed only when exactly one adapter exists.
- **After a selection.** The list is re-rendered. From a button in private, this edits the list message in place.

List rendering:

- **Text.** `选择采集来源。`. Then, for each platform that has no public source and no selected account, the line `\n<平台名> 需要添加并选择自己的账号凭据后才能采集。`. Platform names come from the adapters: `X`, `Instagram`.
- **Keyboard** (no menu buttons):
  - **Public sources.** For each platform with a public source, a row `[<平台名> · 公共来源]` with data `/account public:<platform id>`. It is prefixed `✓ ` when the platform has no selected account, i.e. the public source is in use.
  - **Accounts.** For each non-revoked account, ordered by name and then id, a row with the account button and, in private only, `[删除 → /account_delete <id>]`.
    - The account button label is `@<username> · <name>`. It is `@<username>` if the name is empty, or `<name>` if there is no username.
    - It is prefixed `✓ ` if the account is selected and suffixed `（需重新授权）` if its state is not `ready`.
    - Its data is `/account <id>`.
  - **Add.** If any platform can add accounts, the chat is private, and the web URL is a valid https URL, a final row `[添加账号]` is added as a `web_app` button to `<web url>#/accounts` (`tgc/commands.go:220-227`).
  - Test `tgc/instagram_test.go:77-98`: Instagram (no public source) shows the hint line and no `public:instagram` button; X keeps `public:x`.

#### `/account_delete [账号 ID]` (private-only) (`tgc/commands.go:149-154`; `app/channel_actions.go:289-308`; test `internal/httpapi/channel_test.go:488-539`)

- **No argument.** Same list as `/account`.
- **`<id>`.** The text is `删除采集账号 <name>？`, with the keyboard `[确认删除 → /account_delete confirm:<id>] [取消 → /account]`. Nothing is deleted yet.
- **`confirm:<id>`.** Revokes the account. The text is `账号已删除。` with `[返回账号列表 → /account]`.
- **Errors.** An unknown or invalid id gets the generic failure reply.

#### `/account_add` (retired, not in the menu) (`tgc/commands.go:201-218`)

| case                               | text                                                                                     | keyboard                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| private, nothing after the command | `在网页中添加采集账号。`                                                                 | `[添加账号 → web_app #/accounts]`, `[返回账号列表 → /account]` |
| private, something pasted after it | `不要在聊天中发送凭据。在网页中添加采集账号。` (and the user's message is deleted, §4.2) | same                                                           |
| private, no valid https web URL    | `未配置网页入口。`                                                                       | `[返回账号列表]`                                               |
| group                              | `在私聊中打开网页添加采集账号。`                                                         | `[返回账号列表]`                                               |

Rewrite: the rewrite plan keeps account management. The Go bot does **not** add accounts via chat messages; it only points to the web page and deletes pasted credentials. **Decide** whether to keep `/account_add` at all.

#### `/usage` (`tgc/presentation.go:58-74`; test `tgc/usage_test.go:9-23`)

- Go output: `已用 <n>，共 <limit>`, or `已用 <n>，不限额` when unlimited. If bytes are reserved, `\n保存中 <n>` is appended.
- Sizes: if at least 1 GiB, `%.1f GiB`; otherwise `%.1f MiB`. For example `已用 3.0 MiB，共 1.0 GiB`.
- Rewrite (plan: only used space): `已用 <n>`, with the same size formatting.
- Keyboard: the menu buttons.

#### `more` / `more1000` / `page_retry` `<submission id>` (`tgc/commands.go:126-129`; `app/channel_actions.go:172-226`)

These continue the profile/timeline collection that the progress message tracks. The argument is the **root submission ID of the progress message**.

- **Precondition.** The submission's message must already be delivered (`state='sent'`) and the submission must have related expansion; otherwise the generic failure reply is sent. The page is taken from the deepest page of the chain (`collectionChainSQL`, `app/collection_progress.go:12-15`).
- **`more`.** Fetches the next page from `next_page_cursor`, with page size = the source's default.
  - There is no cursor? The reply is `没有更多帖子了。`.
  - The idempotency key is `more:<submission id>`, so pressing twice returns the same page (test `app/collection_progress_test.go:164-172`).
- **`more1000`.** Same key and cursor. The page size and collection limit are both 1000, and the capture auto-continues to about 1000 members.
  - If the source's `max_batch_size < 1000`, the operation is unsupported and the generic failure reply is sent.
- **`page_retry`.** Fetches the last page's own cursor again, with collection limit = the remaining limit. The key is `page-retry:<event id>`.
- **Options.** Capture options of the original record carry over.
- **Feedback.** The new page is a new submission with the chat as origin, so it gets its **own new progress message**.
  - The original progress message is protected, so `没有更多帖子了。` is sent as a new message.
  - There is no text reply on success.

#### `collection_stop <submission id>` (`tgc/commands.go:120-122`; `app/collection_progress.go:19-46`)

- Stops the collection and everything it spawned. This is idempotent.
- It wakes the progress delivery, which then shows `采集已中止` (§4.5).
- Reply: `已中止。` as a new message, with the menu buttons.
- On a non-collection, the generic failure reply is sent.

#### `batch_retry <batch id>` (`tgc/commands.go:130-140`; `app/batch.go:269-292`)

- Retries the failed, retryable members of a finished refresh batch. It reopens the batch message's delivery, so the same message is edited again.
- Toasts:
  - `批量更新仍在进行。` if the batch is still running.
  - `没有可重试的帖子。` if the count is 0.
  - Otherwise `正在重试 <n> 条失败的帖子。`.
- No message is sent.
- **Go bug.** The poller already answered the callback with no text (§4.1), so this second `answerCallbackQuery` fails silently and the toast never shows. Rewrite: answer the callback once, with the toast.

## 4. Message lifecycles

### 4.1 Callback answering (`tgc/runner.go:100-117`)

- Every accepted callback is answered with an empty `answerCallbackQuery` **as soon as the event is stored**, before the command runs. The only exception was `save_shared` (dropped).
- `AnswerToast` is called later for commands that set a toast (`tgc/runner.go:218-220`).
- Rewrite: answer each callback exactly once.
  - With a toast for `batch_retry`.
  - Empty otherwise, as early as possible.
  - Also answer callbacks that end in an error or the generic failure reply.

### 4.2 Credential deletion (`tgc/runner.go:108-110`; `app/channel_api.go:50-53,94`)

- If the event carried a pasted credential, the bot deletes the user's message with `deleteMessage`. "Message to delete not found" counts as success (`tg/client.go:568-579`).
- The credential is never stored or processed. Only a `sensitive` flag survives, including on replay (test `internal/httpapi/channel_test.go:142-158`).

### 4.3 Capture status message (`tgc/runner.go:255-404`)

A **delivery** exists per submission that has a chat:

- links saved from Telegram;
- `show`;
- `retry`/`refresh`;
- pages requested with `more`.

It is created or woken when the submission is made, whether the capture is new or already running (`app/service.go:418-423`). It is woken again whenever a capture of that submission finishes (`app/worker.go:740-764`).

On each run the delivery loads the submission and its capture and renders exactly one of the cases below, in this priority:

1. **Already `sent` or `failed`.** Mark done; nothing is sent (`tgc/runner.go:309-311`).
2. **Collection with related expansion** (profile/timeline, `is_collection AND related_state<>'none'`). Render the progress message (§4.5).
3. **Capture `queued` or `downloading`** (`tgc/runner.go:320-331`).
   - Text: `正在采集…` or `正在保存媒体…`. If the submission has input (the raw link), `\n<input>` follows.
   - Keyboard: `[查看状态 → /status <job id>]`, plus `[在小程序查看进度]` as a `web_app` button to `<web url>#/captures/<submission id>`.
   - Sent once, then **edited in place** on later runs. The run reschedules itself after **5 s**.
4. **Capture `failed`** (`tgc/runner.go:332-334`).
   - Text: `收藏失败\n输入：<input>\n<failureReason(error)>`.
   - Keyboard: `[重试 → /retry <collection id>]`, plus `[在小程序查看详情]` as a `web_app` button to `#/captures/<submission id>`.
   - Edits the status message.
5. **Capture `complete` or `partial`.** The final collection delivery (§4.4).

In groups, the `web_app` buttons are removed (test `tgc/runner_test.go:53-85`).

**Throttling.** There is no timer-based throttle. The status or progress message is re-rendered at most once per delivery run. A run that is not finished reschedules itself 5 s later. A state change can pull the next run forward to "now" (`app/channel_api.go:17-20`). Editing with identical content returns "message is not modified", which is treated as success (§7.1). Rewrite: an equivalent is "re-render on state-change events, coalesced to at most one edit per ~5 s per message, plus a 5 s poll while unfinished".

### 4.4 Final collection delivery (`tgc/runner.go:337-404`)

#### Inputs

- The saved collection: text, author, entity graph, assets.
- The job state (`complete` or `partial`).
- Profile collections (root entity `x.profile`/`instagram.profile`) are presented differently. Their assets are replaced by the single first `avatar`-purpose asset of the root entity (`tg/collection_author.go:85-129`).

#### Text: `collectionMessage` (`tgc/presentation.go:76-116`)

The text is built as blocks joined by `\n\n`:

1. **Post header.** The collection ID (UUID). For a profile, this and block 2 are replaced by the profile text (below).
2. **Author and body.**
   - The author is `<author name trimmed>`, or `未知作者` when empty.
   - If the body (text, trimmed) is non-empty, it follows as `：\n<body>`.
   - With an empty body the block is just the author name. The test asserts the exact text `ID\n\nAuthor` (`tgc/delivery_parts_test.go:80-121`, `tgc/presentation_test.go:27-38`).
   - README line 89 claims an empty body shows a plain `空`. **The code and tests do not do this**; the README is stale. **Decide** which to follow (the code is the tested behavior).
3. **Partial.** If the state is `partial`: `部分内容未保存`.
4. **Alt text.** For each asset with alt text: `媒体 <position+1> 描述：<alt>` (test `tgc/delivery_parts_test.go:62-67`).
5. **Reasons.** Each distinct translated reason, first from the collection's warnings and then from failed assets' errors: `未完整保存原因：<failureReason(reason)>`.
   - Duplicates are dropped after translation (test `tgc/presentation_test.go:57-63`).
   - Unknown reasons pass through as-is.

**Profile text** (`ProfilePresentation`; test `tg/collection_author_test.go:9-22`):

- `<name>`, then `\n@<username>` if a username exists, then `\n\n<bio>` if the bio is non-empty.
- `name` is the profile `name`, else the author name, else `未知作者`.

#### Entities: `collectionMessageEntities` (`tgc/presentation.go:118-135`)

All offsets and lengths are in UTF-16 units.

- **Post.**
  - `code` over the collection ID (offset 0).
  - `text_link` over the author name, at offset `len(ID+"\n\n")`, to the author URL, but only if one is derivable.
  - `blockquote` over the trimmed body, at offset `len(ID+"\n\n"+author+"：\n")`, if the body is non-empty.
- **Profile.** Only a `text_link` over `<name>` (offset 0) to the profile URL. There is no code entity.

#### Author URL (`CollectionAuthorURL`, `tg/collection_author.go:20-52`; test `tg/collection_author_test.go:24-49`)

The candidate entity is:

- the target of the root's `authored_by` relation; otherwise
- the root itself (for profiles).

Its URL is:

- **`instagram.profile`.** `https://www.instagram.com/<username>/`, if the username matches `^[A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?$` and contains no `..`. Otherwise none.
- **`x.profile`.** `https://x.com/<username>` if the username matches `^[A-Za-z0-9_]{1,15}$`. Otherwise `https://x.com/i/user/<external_id>` if the external ID is numeric. Otherwise none.
- **Any other type.** None.

#### Keyboard (`collectionButtons`, `tgc/presentation.go:29-56`)

1. `[原帖 → url (source URL)] [重新抓取 → /refresh <id>]`
2. `[删除 → /delete <id>]`
3. `[收藏列表 → /list]`
4. `[在小程序中打开]` as a `web_app` button to `<web url>#/collection/<id>`. Only if the web URL parses with scheme `https` and a host. The URL's existing fragment is replaced and its query is kept (test `tgc/presentation_test.go:65-88`).

For profiles, `原帖` is relabelled `在 X 查看主页` or `在 Instagram 查看主页` (`tg/collection_author.go:65-82`).

In groups:

- `/list` and `web_app` buttons are removed (§5.3).
- The Go-only `我也要存` row is dropped.

#### Splitting into parts (`deliveryParts`, `tgc/delivery_parts.go:17-49`; tests `tgc/delivery_parts_test.go:11-60`)

- **Ready assets.** Only assets in state `ready` are sent.
  - An asset larger than **50,000,000 bytes** is skipped. For each one, `\n\n文件超过 Telegram 大小限制，请在网页查看。` is appended to the end of the text.
- **Exactly one asset.** The parts are `[media (caption = first ≤1024 UTF-16 units of the text)]`, then `[buttons]`, then the remaining text in chunks of ≤3500 UTF-16 units.
  - The caption cut never splits a surrogate pair (`tg/client.go:581-595`).
  - Short text therefore lives entirely in the caption.
- **Two or more assets.** Albums of up to **10**. An album never mixes `video/webm` with non-webm items: webm is sent as documents, and Telegram forbids mixing documents with photos and videos.
  - Albums are cut greedily in order. A new album starts when the webm-ness changes.
  - Albums carry **no caption**. The whole text follows as text parts after all albums.
  - Asset order (position) is preserved (test `tgc/instagram_test.go:12-40`).
- **No assets.** Text parts only.
- **Chunks.** Text chunks are ≤3500 UTF-16 units. The split is by code point and never splits a surrogate pair (`tg/client.go:494-516`; test `tg/client_test.go:28-39`).

#### Entity distribution (`formatDeliveryParts`, `tgc/delivery_parts.go:53-66`)

- The parts' texts concatenate to exactly the full text.
- Each entity is clipped to each part's UTF-16 range and re-based to that part. An entity that straddles a caption or chunk boundary becomes two entities.
- Before sending, entities outside the text are dropped (`tg/client.go:261-275`).
- Test `tgc/delivery_parts_test.go:80-121`: across 0/1/2 media and very long bodies, the reassembled code, link and blockquote cover exactly the ID, the author and the body.

#### Sending sequence (`tgc/runner.go:357-404`)

- **Header part.** The header is the first part with non-empty text. Its message ID becomes the submission's `message_id`, which is used for "protected" (§3.3).
- **Media first.** If the first part is media, the progress is 0, and a status message exists:
  1. **Delete** the status message.
  2. Checkpoint `message_id=0`.
  3. Send.

  This way the album appears in order, below the user's link.

- **Text-only, or text first.** The header (part 0) **edits** the status message, with the keyboard. If the edit target is gone, it is sent new (§7.1).
- **Header text after albums.** Sent as a new message, with the keyboard.
- **Other text parts.** Plain new messages, without keyboard.
- **The `buttons` part** (single media only). `editMessageReplyMarkup` attaches the keyboard to the media message (`tg/client.go:552-566`). "Not modified" counts as success.
- **Checkpoints.** After each part, checkpoint `progress=i+1` and the header `message_id`. At the end, `done`.
- **Groups.** Every send uses `reply_to_message_id = origin message`. There is no `allow_sending_without_reply` (test `tg/group_test.go:45-91`).

### 4.5 Collection (profile/timeline) progress message (`collectionProgressMessage`, `tgc/runner.go:510-556`; data `app/channel_api.go:245-295`)

#### Data

Over the chain of pages for this submission (the root plus its `next_submission` pages):

| field                                      | meaning                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `URL`                                      | URL of the first page's collection                                                            |
| `CollectionID`                             | collection ID of the first page                                                               |
| `Total`                                    | distinct related target URLs over all pages                                                   |
| `Complete`, `Partial`, `Failed`, `Pending` | counts of member captures by state                                                            |
| `Next`                                     | the deepest page's next cursor                                                                |
| `MaxBatch`                                 | the deepest page's max batch size                                                             |
| `Stopped`                                  | any page stopped                                                                              |
| `Error`                                    | `partial_pages` if any page or capture failed or was partial, or any related expansion failed |
| `Reasons`                                  | grouped failure reasons with distinct-capture counts, ordered by count desc then reason       |

`Done` (`app/channel_api.go:290`) holds when the root capture failed, or when it is complete/partial and no page is still running or expanding and no member is pending.

#### Text

- **Base.**
  - `正在采集…\n<URL>\n\n本次 <Total> 项：已保存 <C> · 内容不完整 <P> · 失败 <F> · 进行中 <max(0, Total-C-P-F)>`.
  - "In progress" is derived from the total, not from `Pending`.
- **Done.** `正在采集…` becomes `采集完成`.
- **Stopped.** The heading becomes `采集已中止`, whether running or done.
- **Root capture failed.** The whole text becomes `帖子列表获取失败\n输入：<input>\n<failureReason(error)>`.
- **Page errors.** If `Error` is set: `\n部分页面获取失败。`.
- **Reasons.** If any: `\n\n未完整保存原因：`, then for each reason `\n• <failureReason(reason), cut to 180 runes + "…">（<n> 条）`.
  - At most 8 reasons are listed. After the 8th, `\n另有 <k> 类原因。` is added.
- Test `tgc/runner_test.go:246-254`: `内容不完整 2`, `失败 1`, `进行中 0`, `存储配额不足（2 条）`, `采集账号无权访问该帖子（1 条）`.

#### Keyboard (in this order)

| row | button                                    | data / target                          | shown when                                                            |
| --- | ----------------------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| 1   | `在 X 查看主页` / `在 Instagram 查看主页` | url = `URL`                            | always (label by host: instagram.com / www. / m. means Instagram)     |
| 2   | `抓取更多`                                | `/more <submission id>`                | done, not stopped, `Next` non-empty                                   |
| 3   | `抓取1000条`                              | `/more1000 <submission id>`            | as above and `MaxBatch >= 1000`                                       |
| 4   | `重试本页`                                | `/page_retry <submission id>`          | done, not stopped, and (`Error` set, or root failed, or root partial) |
| 5   | `中止`                                    | `/collection_stop <submission id>`     | not done and not stopped                                              |
| 6   | `查看已保存资料`                          | `/show <collection id>`                | always                                                                |
| 7   | `收藏列表`                                | `/list`                                | always (removed in groups)                                            |
| 8   | `在小程序查看进度`                        | web_app `#/captures/<submission id>`   | valid https web URL, private                                          |
| 9   | `在小程序中打开`                          | web_app `#/collection/<collection id>` | valid https web URL, private                                          |

Tests: `tgc/runner_test.go:204-244`, `tgc/instagram_test.go:42-75`.

#### Lifecycle

- Sent once, then edited in place every run (every 5 s) until `Done`. Then the delivery is marked done and is never edited again.
- A later `collection_stop` still re-renders it, because stopping marks the work pending again.
- The profile itself (avatar, name, bio) is not sent by this message. `查看已保存资料` sends it via `/show` (§4.4, profile form).

### 4.6 Refresh batch message (`batchMessage`, `tgc/runner.go:406-508`; `app/batch.go:25-70`)

- **Origin.** A batch refresh started from the web with a **Telegram-derived web session** (`internal/httpapi/server.go:189-199`) gets one message in the owner's **private** chat. API-token batches get none.
- **Lifecycle.** The message is edited every 5 s until done. `batch_retry` reopens it (`app/batch.go:288-290`).
- **Helpers.**
  - `counts(...)` joins only the non-zero `<label> <n>` pairs with `·`.
  - `fetched = max(Complete-Reused, 0)`.
- **Members line.** `summary = "\n帖子：" + posts(Members, Done)`, when non-empty.
  - Done: `counts(已保存, 不完整, 失败)`.
  - Running with `Total>0`: `<finished>/<max(Total, finished+Pending)>`, then `·` + `counts(抓取中, 已保存, 不完整, 失败)` if non-empty.
  - Otherwise empty.

| state              | text                                                                                                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| failed and done    | `批量更新已中止：<reason>\n已提交 <Submitted>/<Total>` + summary. The reason is `存储空间不足` for a quota error, else `采集服务不可用`.                                                                                                                  |
| running (not done) | `批量更新中…\n已提交 <S>/<T>` + (`·` + `counts(抓取中 Running, 已抓取 fetched, 无变化 Reused, 失败 Failed)`) + summary. Then, if there are active items, `\n\n进行中：`, and for each of the first 5: `\n• <name>\n  <status>`. After 5: `\n另有 <k> 项`. |
| done               | `批量更新完成，共 <T> 项` + (`\n` + `counts(已抓取, 无变化, 不完整 Partial, 失败, 无法更新 Rejected)`) + summary                                                                                                                                          |

Running-state details:

- **Item name.** The saved profile's first line, else the author name, else the URL without `https://`/`http://`.
- **Item status.** Built from `抓取中` (if running) and `帖子 <posts(item.Members)>` (if non-empty). If neither applies, it is `提交帖子中`. The parts are joined with `·`.
- **Item buttons.** Each listed item gets a URL button with label `name`, cut to 32 runes + `…`, linking to the item URL. The status goes on its own line because "Telegram would extend a URL over it".

Done-state keyboard: if `Retryable > 0`, one button `重试失败的帖子（<n>）` → `/batch_retry <batch id>`; otherwise no keyboard.

Tests: `tgc/batch_test.go:9-55`.

### 4.7 History browsing

The Go bot has no revision/history browsing. Version history exists only in the web app. Bot "browsing" is `/list` paging (§3.4) and `/show`.

## 5. Inline buttons

### 5.1 Callback data grammar (`validCallback`, `tgc/event.go:166-199`; test `tgc/presentation_test.go:13-25`)

Callback data is at most 64 bytes, has 1 or 2 whitespace fields, and must match one of these rows. Anything else is answered as `/help`.

| data                                                                                                                                               | argument rule                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `/show`, `/status`, `/refresh`, `/retry`, `/delete`, `/more`, `/more1000`, `/page_retry`, `/collection_stop`, `/batch_retry` (and dropped `/save`) | UUID required                                        |
| `/list`                                                                                                                                            | none, or base64url(no pad) of `<uuid>` or `p:<uuid>` |
| `/usage`, `/help`                                                                                                                                  | none                                                 |
| `/account_add`                                                                                                                                     | none or `@<adapter>` (`^[a-zA-Z0-9_-]{1,32}$`)       |
| `/account_delete`                                                                                                                                  | none, `<uuid>` or `confirm:<uuid>`                   |
| `/account`                                                                                                                                         | none, `public`, `<uuid>`, or `public:<adapter>`      |

`/start` as callback data is invalid.

Rewrite: no compatibility with old messages is required, so the format may change. The 64-byte limit is the binding constraint: `/account_delete confirm:<36>` is 60 bytes.

### 5.2 All buttons

The "Press →" column gives the result of pressing. Pressing a callback button produces the same result as typing the command.

| label (verbatim)                             | kind    | data / URL                      | appears on                             | press →             |
| -------------------------------------------- | ------- | ------------------------------- | -------------------------------------- | ------------------- |
| 收藏列表                                     | cb      | `/list`                         | menu row, collection msg, progress msg | list (§3.4)         |
| 存储用量                                     | cb      | `/usage`                        | menu row                               | usage               |
| 打开                                         | web_app | web URL                         | `/start` reply                         | opens Mini App      |
| 查看第N条                                    | cb      | `/show <id>`                    | list                                   | delivers collection |
| 原文                                         | url     | source URL                      | list                                   | —                   |
| ← 上一页 / 下一页 →                          | cb      | `/list <cursor>`                | list                                   | edits list          |
| 查看状态                                     | cb      | `/status <job>`                 | status msg                             | status reply        |
| 更新状态                                     | cb      | `/status <job>`                 | status reply                           | edits status reply  |
| 查看收藏                                     | cb      | `/show <collection>`            | status reply                           | delivers collection |
| 在小程序查看进度                             | web_app | `#/captures/<submission>`       | status msg, progress msg               | —                   |
| 在小程序查看详情                             | web_app | `#/captures/<submission>`       | failed msg                             | —                   |
| 重试                                         | cb      | `/retry <collection>`           | failed msg                             | new capture         |
| 原帖 / 在 X 查看主页 / 在 Instagram 查看主页 | url     | source URL                      | collection msg                         | —                   |
| 重新抓取                                     | cb      | `/refresh <collection>`         | collection msg                         | new capture         |
| 删除                                         | cb      | `/delete <collection>`          | collection msg                         | `已删除。`          |
| 在小程序中打开                               | web_app | `#/collection/<collection>`     | collection msg, progress msg           | —                   |
| 抓取更多                                     | cb      | `/more <submission>`            | progress msg                           | next page           |
| 抓取1000条                                   | cb      | `/more1000 <submission>`        | progress msg                           | ~1000 more          |
| 重试本页                                     | cb      | `/page_retry <submission>`      | progress msg                           | refetch last page   |
| 中止                                         | cb      | `/collection_stop <submission>` | progress msg                           | `已中止。`          |
| 查看已保存资料                               | cb      | `/show <collection>`            | progress msg                           | profile delivery    |
| (item name)                                  | url     | item URL                        | batch msg (running)                    | —                   |
| 重试失败的帖子（N）                          | cb      | `/batch_retry <batch>`          | batch msg (done)                       | toast               |
| `[✓ ]<平台> · 公共来源`                      | cb      | `/account public:<platform>`    | account list                           | select, re-render   |
| `[✓ ]@user · name[（需重新授权）]`           | cb      | `/account <id>`                 | account list                           | select, re-render   |
| 删除                                         | cb      | `/account_delete <id>`          | account list (private)                 | confirm prompt      |
| 添加账号                                     | web_app | `#/accounts`                    | account list, `/account_add`           | —                   |
| 确认删除                                     | cb      | `/account_delete confirm:<id>`  | confirm prompt                         | `账号已删除。`      |
| 取消 / 返回账号列表                          | cb      | `/account`                      | confirm prompt / results               | account list        |

**Who may press.** In Go, private-chat buttons can be pressed only by the chat's user. Group buttons can be pressed by the original requester (§0). Rewrite: the owner only.

### 5.3 Group keyboard filter (`groupButtons`, `tgc/event.go:113-140`)

In groups, these buttons are removed:

- every `web_app` button (Telegram does not allow them in groups);
- every button whose data is a private-only command (`/start`, `/list`, `/account_delete`, with or without argument).

Rows that become empty are dropped. Test `tgc/presentation_test.go:65-88`.

### 5.4 Mini App route buttons (`appendMiniAppRoute`, `tgc/presentation.go:48-56`)

These buttons are added only if the web URL parses with scheme `https` and a non-empty host. The route is put into the URL **fragment** (`#/collection/<id>`, `#/captures/<id>`, `#/accounts`), replacing any existing fragment.

When sending keyboards that contain `web_app` buttons, the raw JSON keyboard is serialized, for both sends and edits (`tg/client.go:288-321`). That was an SDK limitation, irrelevant in grammY.

## 6. Delivery semantics: at-least-once and idempotency

- **Checkpoint state.** Per delivery: `progress` (number of parts confirmed) and `message_id` (the header/status message).
  - Every confirmed part is checkpointed **before** the next is sent (`tgc/runner.go:399-403`).
  - On restart, parts are recomputed deterministically from the same data and sending resumes at `progress`. Confirmed parts are never resent (tests `tgc/runner_test.go:21-51`, `tgc/runner_test.go:117-187`).
  - Media-first deliveries checkpoint `message_id=0` right after deleting the status message, so the deletion is not repeated (`tgc/runner.go:364-372`).
- **Duplicates.** A part whose send succeeded but whose checkpoint failed is sent again. This is at-least-once.
- **Event replies** follow the same part/checkpoint loop (`tgc/runner.go:233-252`).
  - The business action's result is cached per event (`app/channel_actions.go:49-59,161-169`), so a retried event never re-runs the action.
  - Submits are also keyed: `<event>:<hash>`, `show:<event>`, `retry:`/`refresh:<event>`, `more:<submission>`, `page-retry:<event>`.
- **Edits are idempotent.** "message is not modified" counts as success (`tg/client.go:300-302`; test `tg/client_test.go:109-130`).
- **Leases.** Work leases last 90 s, renewed by a heartbeat every 25 s (`tgc/runner.go:137-158`). Not needed in a single process, but crash recovery still needs the persisted checkpoint.
- **Ordering.** The two lanes (events, deliveries) are each serial (§1). Deliveries are claimed oldest-first (`internal/store/migrations/20261015010000_channel_work_lanes.sql`).
- **Deleting all collections** marks their pending deliveries done (`app/delete_all.go:69`).
- **Paused captures** postpone delivery by 30 s without contacting Telegram (`tgc/runner.go:260-262`; test `tgc/runner_test.go:189-202`). `paused` is vestigial; see capture-spec §1.2.3.

## 7. Error handling

### 7.1 Telegram API errors

| situation                                                                   | behavior                                                                                                                                                        | ref                                                                           |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 429                                                                         | Retry the whole work after `retry_after` seconds (minimum 1). Also applies to uploads.                                                                          | `tgc/runner.go:177-178`; tests `tg/client_test.go:96-107,205-217`             |
| other 4xx (blocked bot 403, chat not found, message too long, bad request…) | **Permanent**. The work is marked failed (the submission's message state becomes `failed`) and not retried.                                                     | `tgc/runner.go:179-181`, `app/channel_api.go:151-153,170`                     |
| 5xx, transport error, timeout                                               | Retry with backoff: at least 5 s, doubled per consecutive failure, capped at 600 s. A Telegram `retry_after` larger than that wins. Progress resets the streak. | `app/channel_api.go:157-165`; test `internal/httpapi/channel_test.go:404-486` |
| edit: `message is not modified`                                             | Success; keeps the message ID.                                                                                                                                  | `tg/client.go:300-302`                                                        |
| edit: `message to edit not found` / `message can't be edited`               | Send as a new message instead, with the same reply-to.                                                                                                          | `tg/client.go:304-306`; test `tg/group_test.go:45-91`                         |
| editMessageReplyMarkup: not modified                                        | Success.                                                                                                                                                        | `tg/client.go:561-564`                                                        |
| deleteMessage: `message to delete not found`                                | Success.                                                                                                                                                        | `tg/client.go:575-577`                                                        |
| sending a photo/video fails with 400, or ffprobe cannot read a video        | Resend the same item or album **as documents** (§8).                                                                                                            | `tg/client.go:344-351,396-400`                                                |
| 400 with an invalid cached `file_id`                                        | Forget the cache entry, re-upload once.                                                                                                                         | `tg/client.go:369-372,427-439`                                                |

Messages that are too long cannot occur, because of the 3500 and 1024 limits. Transport errors are reported without the token-bearing URL (`tg/client.go:74-92`).

### 7.2 Core / action errors in event replies (`tgc/runner.go:210-217`)

- An action error that is a client error (4xx except 429) is answered with `操作失败，使用 /help 查看用法。` and the menu buttons. This covers not found, unsupported, invalid cursor, an unready account, and "no more pages" through `ErrNoMorePages` when not mapped.
- 5xx and 429 errors are retried like Telegram errors.
- Rewrite: map "not found / invalid argument / unsupported" to the generic reply, and retry or log unexpected errors.

## 8. Media sending (`tg/client.go:344-451`, `tg/send_media.go`, `tg/file_cache.go`, `tg/video.go`)

### 8.1 Representation per asset (`mediaKind`, `tg/file_cache.go:22-30`)

| MIME                                  | first try                                                | fallback   |
| ------------------------------------- | -------------------------------------------------------- | ---------- |
| `video/mp4`                           | `video` (`supports_streaming=true`, probed width/height) | `document` |
| `video/webm`                          | `document`                                               | —          |
| anything else (jpeg, png, webp, gif…) | `photo`                                                  | `document` |

- **Upload vs URL.** All bytes are **uploaded** (multipart). Nothing is sent by URL. The file name is `<sha256 hash><ext>`, where ext is `.webm`, `.mp4`, `.png`, `.webp`, otherwise `.jpg` (`tg/client.go:453-466`).
  - Rewrite: the plan's signed URLs could be used for `sendPhoto` by URL. Telegram then fetches from the public URL, with a 5 MB photo / 20 MB other limit. That is a behavior change; **Decide**. Uploading keeps parity.
- **Size limit.** An asset over 50,000,000 bytes is never sent (§4.4). There is no other limit. Telegram's own photo limit (10 MB, dimensions) triggers a 400, which falls back to document.
- **Spoiler.** `has_spoiler=true` when the asset is sensitive and the kind is not `document` (`tg/send_media.go:47`; tests `tg/file_cache_test.go:45-120,162-188`). A sensitive photo that falls back to document loses the spoiler. That is intended.
- **Caption.** Only on the first item of a single send or album, with its caption entities (`tg/send_media.go:48-51`). The delivery layer only uses captions for single items.
- **Thumbnails.** Not sent. Telegram generates its own. The app's ffmpeg thumbnails are not used by the bot.
- **GIFs.** There is no special path. X animated GIFs arrive as `video/mp4` and go out as video. A real `image/gif` goes as a photo, falling back to document on 400.
- **No chat action.** `sendChatAction` exists but is unused.

### 8.2 Video probing (`prepareVideo`, `tg/video.go:55-89`; tests `tg/video_test.go:19-85`)

- **Probe.** The bytes are copied to a temp file (`midden-video-*.mp4`). `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,sample_aspect_ratio:stream_side_data=rotation -of json` runs with a 15 s timeout. The original bytes are uploaded unmodified.
- **Display size.** The width is multiplied by the SAR when the SAR is valid and greater than 0. Width and height are swapped if the rotation is ±90 (mod 180). Examples: 720×576 with SAR 16:15 gives 768×576; 1920×1080 rotated -90 gives 1080×1920.
- **Failure.** If the probe fails, or the size is 0 or above 65535, the item is resent as a document.
- **Cleanup.** The temp file is always deleted.

### 8.3 Single item (`MediaItem`, `tg/client.go:344-377`)

- **Method.** `sendPhoto`, `sendVideo` or `sendDocument`, with `reply_to_message_id` in groups.
- **Fallback.** On a 400 or a probe failure, the item is sent once more as a document.
- **Errors.** 429 and other errors propagate to the delivery retry (§7.1).

### 8.4 Albums (`Media`, `tg/client.go:379-451`; tests `tg/client_test.go:52-94,252-298`)

- **Shape.** `sendMediaGroup` with 2–10 items. If any item is webm, the whole album goes as documents.
- **Fallback.** On a 400 or a probe failure, the whole album is resent once as documents (test: photo album 400 → document album).
- **Message ID.** The album's first message ID is returned.

### 8.5 `file_id` cache (`channel_media_cache`; `tg/file_cache.go`; tests `tg/file_cache_test.go:45-160`)

- **Key.** `(bot id, blob sha256, representation)`, where the representation is `photo`, `video` or `document`. Value: `file_id`.
  - Go table: `channel_media_cache(channel_kind, account_id, hash, representation, remote_id)` (`internal/store/migrations/0001_initial.sql:639-645,1033-1034`; `internal/store/channel_media.go`).
  - Rewrite: key by bot ID too, because a token change to another bot must not reuse IDs (test: `bot2` re-uploads).
- **Before upload.** A cached `file_id` is used instead of reading the blob. Albums can mix cached and uploaded items (`attach://media<i>` names).
- **After a successful send.**
  - The cache stores `video.file_id`, `document.file_id`, or the largest-area photo size's `file_id`.
  - For albums, entries are stored only if the response has one message per item.
  - A cache write failure is only logged. It must not fail a confirmed send.
- **Invalid `file_id`.** A 400 whose description contains `wrong file identifier`, `wrong remote file identifier`, `file_reference_expired`, `file reference expired`, `invalid file_id` or `file_id not found` (case-insensitive) is handled thus:
  1. Delete the entry, only if it still holds that same ID.
  2. Retry once with an upload (for an album, all cached entries are dropped and everything is uploaded).
- **Transient errors** (429, 5xx) never invalidate the cache.

## 9. Mini App entry (menu button)

- At startup, `setChatMenuButton` is sent without `chat_id`, which sets the default for all private chats (`tg/client.go:597-609`; test `tg/web_test.go:12-64`).
  - With a web URL: `{"type":"web_app","text":"打开","web_app":{"url":"<WEB_APP_URL>"}}`.
  - Without one: `{"type":"commands"}`.
  - Unlike route buttons, there is no https check here. The rewrite's `WEB_APP_URL` is already validated as `https://…/app/`.
- The same URL backs the `/start` `打开` button and all `web_app` route buttons (§5.4).
- Login and initData validation are in the HTTP layer and out of scope here. Rewrite: accept only `OWNER_TELEGRAM_ID`.

## 10. Deploy notifications (`DEPLOY_NOTIFY_CHAT_ID`)

These are **not part of the bot**. A separate host-side webhook script, `deploy` (`scripts/deploy-webhook.mjs:138-179,187-243`; `docs/operations.md:43`), sends them.

- **Recipient.** It reads `DEPLOY_NOTIFY_CHAT_ID` from `.env`; if empty, nothing is sent. The bot token is read from the DB config. The rewrite would read `TELEGRAM_BOT_TOKEN` from the environment.
- **Request.** A plain `sendMessage` with `{chat_id, text: text.slice(0, 4000)}`, with no entities or keyboard. Failures are only logged.
- **Messages.** `<sha7>` is the first 7 characters of the deployed revision. `<tail>` is the last 6 output lines.
  - `✅ midden 部署成功\n版本 <sha7>\n<tail>` (`deploy:226-229`).
  - `❌ midden 部署失败（版本 <sha7>）\n<tail>` (`deploy:231-234`).
  - `❌ midden 部署未开始\n<error message>` (`deploy:237`). The error message is `git fetch failed`, `deploy-latest.sh missing on main`, or `release check failed\n<last 5 lines>`.
- **Skipped.** Nothing is sent when the revision is already deployed (`deploy:219-222`).

## 11. All user-visible Chinese strings

### 11.1 Fixed texts and toasts

| string                                                                                                                                                                                                                    | where                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 开始使用 / 保存帖子 / 查看收藏列表 / 查看指定收藏 / 查看采集状态 / 使用当前账号重试 / 重新抓取帖子 / 删除 / 删除采集账号 / 选择采集账号 / 查看存储用量 / 查看使用帮助                                                     | command menu, help (`tgc/event.go:22-35`)                                        |
| 发送支持的平台链接保存内容（每次最多 200 个）。                                                                                                                                                                           | help/start (`tgc/commands.go:42`)                                                |
| `\n/<cmd> — <desc>`                                                                                                                                                                                                       | help lines (`tgc/commands.go:47`)                                                |
| `\n\n版本：`                                                                                                                                                                                                              | start (`tgc/commands.go:50`)                                                     |
| 仅限发起者操作。                                                                                                                                                                                                          | dropped (`tgc/commands.go:26`)                                                   |
| 请在私聊中使用此命令。                                                                                                                                                                                                    | private-only command in group (`tgc/commands.go:33`)                             |
| 每次最多 200 个链接。                                                                                                                                                                                                     | save (`tgc/commands.go:64`)                                                      |
| 操作失败，使用 /help 查看用法。                                                                                                                                                                                           | action error (`tgc/runner.go:216`)                                               |
| 暂无收藏。                                                                                                                                                                                                                | empty list (`tgc/commands.go:97`)                                                |
| `<i>. ` / 无文字内容 / `…`                                                                                                                                                                                                | list items (`tgc/commands.go:79`, `tgc/presentation.go:143`)                     |
| 请发送支持的链接，或使用 /help。                                                                                                                                                                                          | save, nothing found (`tgc/commands.go:113`)                                      |
| 已保存。                                                                                                                                                                                                                  | dropped toast (`tgc/commands.go:118`)                                            |
| 已中止。                                                                                                                                                                                                                  | stop (`tgc/commands.go:121`)                                                     |
| 已删除。                                                                                                                                                                                                                  | delete (`tgc/commands.go:124`)                                                   |
| 没有更多帖子了。                                                                                                                                                                                                          | more (`tgc/commands.go:128`)                                                     |
| 批量更新仍在进行。 / 没有可重试的帖子。 / 正在重试 %d 条失败的帖子。                                                                                                                                                      | batch_retry toasts (`tgc/commands.go:135-139`)                                   |
| 删除采集账号 %s？                                                                                                                                                                                                         | account delete prompt (`tgc/commands.go:151`)                                    |
| 账号已删除。                                                                                                                                                                                                              | account deleted (`tgc/commands.go:154`)                                          |
| 选择采集来源。                                                                                                                                                                                                            | account list (`tgc/commands.go:156`)                                             |
| `\n%s 需要添加并选择自己的账号凭据后才能采集。`                                                                                                                                                                           | account list (`tgc/commands.go:163`)                                             |
| ` · 公共来源`, `✓ `, `（需重新授权）`, `·`                                                                                                                                                                                | account buttons (`tgc/commands.go:166-186`)                                      |
| 在网页中添加采集账号。 / 不要在聊天中发送凭据。在网页中添加采集账号。 / 在私聊中打开网页添加采集账号。 / 未配置网页入口。                                                                                                 | account_add (`tgc/commands.go:204-215`)                                          |
| 正在采集 / 正在保存媒体 / 收藏完成 / 已收藏，部分资源缺失 / 收藏失败                                                                                                                                                      | `jobState` (`tgc/presentation.go:13-27`)                                         |
| `…` suffix, `\n输入：`                                                                                                                                                                                                    | status/failed messages (`tgc/runner.go:321,332`)                                 |
| 未知作者                                                                                                                                                                                                                  | collection/profile (`tgc/presentation.go:80,124`; `tg/collection_author.go:106`) |
| `：\n`                                                                                                                                                                                                                    | author/body separator (`tgc/presentation.go:85`)                                 |
| 部分内容未保存                                                                                                                                                                                                            | partial (`tgc/presentation.go:92`)                                               |
| 媒体 %d 描述：%s                                                                                                                                                                                                          | alt text (`tgc/presentation.go:96`)                                              |
| 未完整保存原因：                                                                                                                                                                                                          | reasons (`tgc/presentation.go:104`, `tgc/runner.go:527`)                         |
| `\n\n文件超过 Telegram 大小限制，请在网页查看。`                                                                                                                                                                          | oversize asset (`tgc/delivery_parts.go:22`)                                      |
| 已用 / ，共 / ，不限额 / 保存中                                                                                                                                                                                           | usage (`tgc/presentation.go:66-71`)                                              |
| 正在采集… / 采集完成 / 采集已中止 / 本次 %d 项：已保存 %d · 内容不完整 %d · 失败 %d · 进行中 %d / 帖子列表获取失败 / 部分页面获取失败。 / `• %s（%d 条）` / 另有 %d 类原因。                                              | progress message (`tgc/runner.go:512-538`)                                       |
| 批量更新已中止：/ 采集服务不可用 / 存储空间不足 / 已提交 %d/%d / 批量更新中… / 抓取中 / 已抓取 / 无变化 / 失败 / 不完整 / 已保存 / 无法更新 / 帖子： / 帖子 / 进行中： / 另有 %d 项 / 提交帖子中 / 批量更新完成，共 %d 项 | batch message (`tgc/runner.go:425-507`)                                          |
| 此平台需要账号，请先添加并选择自己的采集凭据。 / 账号不可用，请在采集账号中选择可用账号或重新授权。                                                                                                                       | save errors (`app/worker.go:142-147`)                                            |
| ✅ midden 部署成功 / 版本 / ❌ midden 部署失败（版本 …） / ❌ midden 部署未开始                                                                                                                                           | deploy script (`deploy:226-237`)                                                 |

### 11.2 Button labels

These are all listed in §5.2: 收藏列表, 存储用量, 打开, 查看第%d条, 原文, ← 上一页, 下一页 →, 查看状态, 更新状态, 查看收藏, 在小程序查看进度, 在小程序查看详情, 重试, 原帖, 在 X 查看主页, 在 Instagram 查看主页, 重新抓取, 删除, 在小程序中打开, 抓取更多, 抓取1000条, 重试本页, 中止, 查看已保存资料, 重试失败的帖子（%d）, 确认删除, 取消, 返回账号列表, 添加账号. The Go-only label 我也要存 is dropped.

The menu button text is 打开 (`tg/client.go:601`).

### 11.3 `failureReason` translations (`tgc/presentation.go:174-219`)

Used in failed messages, collection reasons and progress reasons. Unknown reasons are shown raw, trimmed.

| raw                                                                                                                                                                                                           | shown                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| storage quota exceeded                                                                                                                                                                                        | 存储配额不足                                                  |
| account cannot access this post                                                                                                                                                                               | 采集账号无权访问该帖子                                        |
| account is suspended                                                                                                                                                                                          | 账号已被封禁，解封后可重新抓取                                |
| profile not found                                                                                                                                                                                             | 账号不存在或已改名                                            |
| post not found or deleted                                                                                                                                                                                     | 帖子不存在或已删除                                            |
| provider cannot access this post                                                                                                                                                                              | 无法获取该帖子                                                |
| provider cannot access this profile                                                                                                                                                                           | 无法获取该账号资料                                            |
| account required; add and select your own credentials                                                                                                                                                         | 此平台需要账号，请先添加并选择自己的采集凭据。                |
| Instagram requires an account; select an Instagram account and retry / Instagram requires login                                                                                                               | Instagram 需要登录，请在采集账号中选择 Instagram 账号后重试。 |
| Instagram session expired; authorize again                                                                                                                                                                    | Instagram 登录已失效，请重新添加账号授权。                    |
| Instagram rate limited the request                                                                                                                                                                            | Instagram 请求过于频繁，请稍后重试。                          |
| Instagram access denied or browser verification required / Instagram requires browser verification / Instagram redirected to login or verification / Instagram requires login, verification, or a later retry | Instagram 要求登录验证或账号无权访问，请检查账号后重试。      |
| Instagram content not found or inaccessible                                                                                                                                                                   | Instagram 内容不存在或当前账号无权访问。                      |
| Instagram temporarily unavailable                                                                                                                                                                             | Instagram 暂时不可用，请稍后重试。                            |
| provider temporarily unavailable                                                                                                                                                                              | 来源平台暂时不可用，请稍后重试。                              |
| account request signing unavailable                                                                                                                                                                           | 采集账号请求签名不可用                                        |
| context deadline exceeded                                                                                                                                                                                     | 请求超时                                                      |
| job exhausted retries or was interrupted                                                                                                                                                                      | 任务重试次数已用尽或执行被中断                                |
| operation failed; retry or inspect service health                                                                                                                                                             | 服务内部错误                                                  |
| resource omitted: unsupported type or resource limit                                                                                                                                                          | 部分资源类型不支持或资源数量超过限制                          |

Note: `/status` shows `job.error` **untranslated** (`tgc/commands.go:105`), and save errors use `safeError`, not `failureReason`. Both can show English text. **Decide** whether to run them through `failureReason` too.

## 12. Subtle edge cases the tests check

1. **Entities.**
   - UTF-16 offsets everywhere, including emoji before a mention (`tgc/group_trigger_test.go:23`) and before a URL entity (`tg/client_test.go:20-26`).
   - Out-of-range entities are ignored, never crash.
   - Literal text is never interpreted as markup: there is no `parse_mode` (`tg/client_test.go:219-250,300-333`).
2. **Splitting.**
   - Text, caption and album splitting preserve every character. They never exceed 10 items, 1024 caption units or 3500 text units.
   - A single media item always comes first, with exactly one keyboard part.
   - Short text is not sent separately from a single media item.
   - Albums have no caption and no media keyboard (`tgc/delivery_parts_test.go:11-53`).
   - The code, author link and blockquote entities survive caption and chunk splits (`tgc/delivery_parts_test.go:80-121`).
3. **Delivery resume.**
   - Resuming at `progress=1` sends only the remaining parts and keeps the original header message ID (`tgc/runner_test.go:21-51`).
   - A transient text failure after an album does not resend the album or re-delete the status message (`tgc/runner_test.go:117-187`).
4. **Mixed albums.** A sensitive mp4 with a webm is split into two albums, so the mp4 keeps its spoiler (`tgc/delivery_parts_test.go:69-78`).
5. **Oversize.** A single 50,000,001-byte video gives text only, with the size notice (`tgc/delivery_parts_test.go:55-60`).
6. **Group reply.** The reply-to survives the edit→send fallback and the photo→document fallback. `allow_sending_without_reply` is never set (`tg/group_test.go:45-91`).
7. **Keyboards.**
   - An empty keyboard is serialized as `[]` on send and edit (`tg/client_test.go:132-158`).
   - A "not modified" edit is not followed by a new send (`tg/client_test.go:109-130`).
8. **Mini App buttons.**
   - Absent when the web URL is empty, `http://`, or unparsable. The query string is kept and the fragment replaced.
   - Never shown in groups (`tgc/presentation_test.go:65-88`, `tgc/runner_test.go:53-85`, `tgc/runner_test.go:204-244`).
9. **Progress controls.**
   - Stop is shown only while running.
   - `more`/`more1000` only when done with a cursor; `more1000` only if `MaxBatch>=1000`.
   - `page_retry` only when done with an error or a failed or partial root.
   - Nothing except navigation after a stop (`tgc/runner_test.go:204-244`, `tgc/instagram_test.go:42-75`).
10. **`more` twice** gives the same continuation page. A stop is idempotent and blocks further child submissions (`app/collection_progress_test.go:164-172,228-254`).
11. **Reasons** are de-duplicated after translation (`tgc/presentation_test.go:57-63`). Collection text never contains the revision ID or `/show` (`tgc/presentation_test.go:27-38`).
12. **List summary** truncation is in code points, keeping trailing `[图片]`/`[视频]` markers (`tgc/presentation_test.go:42-55`).
13. **Callback validation.** Missing or invalid UUIDs, bad cursors, `/start` and data over 64 bytes are all invalid, and become `/help` (`tgc/presentation_test.go:13-25`).
14. **Credentials.** A credential after `/account_add` is kept out of text, argument and URLs. It triggers deletion of the user's message, including on replay (`tgc/runner_test.go:107-114`; `internal/httpapi/channel_test.go:142-158`).
15. **Account deletion** needs the confirm step. Instagram without a public source shows the hint and no public button (`internal/httpapi/channel_test.go:488-539`, `tgc/instagram_test.go:77-98`).
16. **`file_id` cache.**
    - A repeat send reuses the ID; an invalid ID is replaced by one upload; another bot does not reuse it; a 429 does not invalidate it.
    - The spoiler is kept on cache hits.
    - Albums mix cached and uploaded items (`tg/file_cache_test.go:45-160`).
17. **Video.**
    - Dimensions honor SAR and rotation.
    - A non-probeable video goes as a document, with the caption kept.
    - Temp files never leak (`tg/video_test.go:19-85`).
18. **Duplicates.** A duplicate `update_id` creates one event. A stale lease cannot acknowledge. An end-to-end `/save` creates exactly one submission (`internal/httpapi/channel_test.go:86-306`).
19. **Batch message.**
    - The exact text formats in `tgc/batch_test.go:9-34`, including "a finished profile still waits for its posts".
    - At most 5 item buttons, labelled by author or by the URL without scheme.
    - No buttons when done, unless something is retryable (`tgc/batch_test.go:36-55`).
20. **Usage formatting.** MiB below 1 GiB, one decimal place (`tgc/usage_test.go:9-23`).
