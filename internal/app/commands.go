package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"monitor/internal/domain"
	"monitor/internal/store"
	"monitor/internal/telegram"
)

type commandRequest struct {
	Entities      []telegram.Entity
	AccountImport *accountImport
	Message       *telegram.Message
	Task          store.Task
	Origin        domain.Origin
	Argument      string
	Text          string
	Buttons       telegram.Keyboard
	Previous      int64
}

type channelCommand struct {
	Name        string
	Description string
	Usage       string
	Callback    bool
	PrivateOnly bool
	Validate    func(string) bool
	Handle      func(*Service, context.Context, *commandRequest) error
}

// Routing, Telegram's command menu, help and callback validation share this registry.
var channelCommands []channelCommand

func init() {
	channelCommands = []channelCommand{
		{"start", "开始使用", "", false, true, noArgument, (*Service).commandHelp},
		{"save", "保存帖子", "<帖子链接…>", false, false, func(string) bool { return true }, (*Service).commandSave},
		{"recent", "查看最近归档", "[游标]", true, true, validCursorArgument, (*Service).commandRecent},
		{"show", "查看指定归档", "<归档 ID>", true, false, validIDArgument, (*Service).commandShow},
		{"status", "查看采集状态", "<任务 ID>", true, false, validIDArgument, (*Service).commandStatus},
		{"refresh", "重新抓取帖子", "<归档 ID>", true, false, validIDArgument, (*Service).commandRefresh},
		{"delete", "删除", "<归档 ID>", true, false, validIDArgument, (*Service).commandDelete},
		{"delete_all", "删除全部保存记录", "[confirm]", true, false, func(s string) bool { return s == "" || s == "confirm" }, (*Service).commandDeleteAll},
		{"account_add", "添加 X 采集账号", "<Base64 Cookie> [名称]", true, true, func(string) bool { return true }, (*Service).commandAccountAdd},
		{"account_delete", "删除采集账号", "[账号 ID]", true, true, validAccountDeleteArgument, (*Service).commandAccountDelete},
		{"account", "选择采集账号", "", true, false, func(s string) bool { return s == "" || s == "public" || validIDArgument(s) }, (*Service).commandAccount},
		{"usage", "查看存储用量", "", true, false, noArgument, (*Service).commandUsage},
		{"help", "查看使用帮助", "", true, false, noArgument, (*Service).commandHelp},
	}
}

func TelegramCommands(group bool) []telegram.Command {
	commands := make([]telegram.Command, 0, len(channelCommands))
	for _, c := range channelCommands {
		if group && c.PrivateOnly {
			continue
		}
		commands = append(commands, telegram.Command{Command: c.Name, Description: c.Description})
	}
	return commands
}

func lookupCommand(name string) (channelCommand, bool) {
	for _, c := range channelCommands {
		if "/"+c.Name == name {
			return c, true
		}
	}
	return channelCommand{}, false
}

func noArgument(s string) bool      { return s == "" }
func validIDArgument(s string) bool { _, err := uuid.Parse(s); return err == nil }
func validCursorArgument(s string) bool {
	_, _, err := parseArchiveCursor(s)
	return err == nil
}

// Callback data selects an action; resource lookups use the authenticated actor's tenant.
func validCallback(data string) bool {
	if len(data) > 64 {
		return false
	}
	fields := strings.Fields(data)
	if len(fields) < 1 || len(fields) > 2 {
		return false
	}
	c, ok := lookupCommand(fields[0])
	if !ok || !c.Callback {
		return false
	}
	arg := ""
	if len(fields) == 2 {
		arg = fields[1]
	}
	// Account callbacks only open instructions; credentials must arrive in a private message.
	if c.Name == "account_add" {
		return arg == ""
	}
	return c.Validate(arg)
}

func (s *Service) commandHelp(_ context.Context, r *commandRequest) error {
	var b strings.Builder
	b.WriteString("发送 X 帖子链接保存图文（每次最多 200 个）。")
	for _, c := range channelCommands {
		if strings.HasPrefix(r.Origin.ChatID, "-") && c.PrivateOnly {
			continue
		}
		b.WriteString("\n/" + c.Name)
		if c.Usage != "" {
			b.WriteString(" " + c.Usage)
		}
		b.WriteString(" — " + c.Description)
	}
	r.Text = b.String()
	return nil
}

func (s *Service) commandUsage(ctx context.Context, r *commandRequest) error {
	v, err := s.Usage(ctx, r.Task.Tenant)
	if err != nil {
		return err
	}
	r.Text = usageText(v.Used, v.Reserved, v.Limit)
	return nil
}

func (s *Service) commandRecent(ctx context.Context, r *commandRequest) error {
	p, err := s.Recent(ctx, r.Task.Tenant, r.Argument)
	if err != nil {
		r.Text = "无效游标或无权限。"
		return nil
	}
	r.Buttons = nil
	for i, a := range p.Items {
		if i > 0 {
			r.Text += "\n\n"
		}
		r.Text += fmt.Sprintf("%d. ", i+1)
		summary := archiveListSummary(a.Summary, a.Text)
		r.Entities = append(r.Entities, telegram.Entity{Type: "text_link", Offset: len(utf16.Encode([]rune(r.Text))), Length: len(utf16.Encode([]rune(summary))), URL: a.URL})
		r.Text += summary
		r.Buttons = append(r.Buttons, []telegram.Button{{Text: fmt.Sprintf("查看第%d条", i+1), Data: "/show " + a.ID}, {Text: fmt.Sprintf("查看第%d条原帖", i+1), URL: a.URL}})
	}
	if r.Text == "" {
		r.Text = "暂无归档。"
		r.Buttons = menuButtons()
	}
	var navigation []telegram.Button
	if p.PreviousCursor != "" {
		navigation = append(navigation, telegram.Button{Text: "← 上一页", Data: "/recent " + p.PreviousCursor})
	}
	if p.NextCursor != "" {
		navigation = append(navigation, telegram.Button{Text: "下一页 →", Data: "/recent " + p.NextCursor})
	}
	if len(navigation) > 0 {
		r.Buttons = append(r.Buttons, navigation)
	}
	return nil
}

func (s *Service) commandStatus(ctx context.Context, r *commandRequest) error {
	j, err := s.Job(ctx, r.Task.Tenant, r.Argument)
	if err != nil {
		r.Text = "任务不存在或无权限。"
		return nil
	}
	r.Text = strings.TrimSpace(jobState(j.State) + "\n" + j.Error)
	r.Buttons = telegram.Keyboard{{{Text: "更新状态", Data: "/status " + j.ID}}}
	if j.State == "complete" || j.State == "partial" {
		r.Buttons = append(r.Buttons, []telegram.Button{{Text: "查看归档", Data: "/show " + j.ArchiveID}})
	}
	return nil
}

func (s *Service) commandShow(ctx context.Context, r *commandRequest) error {
	a, err := s.Archive(ctx, r.Task.Tenant, r.Argument)
	if err != nil {
		r.Text = "归档不存在或无权限。"
		return nil
	}
	return s.DB.Tx(ctx, r.Task.Tenant, func(tx pgx.Tx) error {
		var sid string
		err := tx.QueryRow(ctx, `INSERT INTO submissions(tenant_id,capture_id,identity_id,channel_id,chat_id,idem_key,fingerprint,reply_to_message_id) SELECT $1,capture_id,$3,$4,$5,$6,$6,$7 FROM revisions WHERE id=$2 ON CONFLICT(tenant_id,idem_key) DO NOTHING RETURNING id`, r.Task.Tenant, a.RevisionID, r.Origin.IdentityID, r.Origin.ChannelID, r.Origin.ChatID, "show:"+r.Task.ID, r.Origin.ReplyToMessageID).Scan(&sid)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		return s.Enqueue(ctx, tx, r.Task.Tenant, sid, "deliver")
	})
}

func (s *Service) commandRefresh(ctx context.Context, r *commandRequest) error {
	r.Previous = 0
	_, err := s.Submit(ctx, r.Task.Tenant, domain.CaptureInput{RefreshID: r.Argument, Key: "refresh:" + r.Task.ID, Origin: r.Origin})
	if err != nil {
		r.Text = submitMessage(err) + "\n输入：/refresh " + r.Argument
	}
	return nil
}

func (s *Service) commandDelete(ctx context.Context, r *commandRequest) error {
	r.Previous = 0
	if err := s.DeleteArchive(ctx, r.Task.Tenant, r.Argument); err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			r.Text = "你尚未保存这条内容。"
			return nil
		}
		return err
	}
	r.Text = "已删除，并释放对应额度。"
	return nil
}

func (s *Service) commandDeleteAll(ctx context.Context, r *commandRequest) error {
	if r.Argument != "confirm" {
		r.Text = "删除你保存的全部归档？删除后将释放对应额度，不影响其他用户的保存记录。"
		r.Buttons = telegram.Keyboard{{{Text: "确认删除全部", Data: "/delete_all confirm"}, {Text: "取消", Data: "/help"}}}
		return nil
	}
	var before time.Time
	if err := s.DB.Tx(ctx, r.Task.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT created_at FROM inbox WHERE id=$1`, r.Task.ID).Scan(&before)
	}); err != nil {
		return err
	}
	n, err := s.DeleteAllArchives(ctx, r.Task.Tenant, before)
	if err != nil {
		return err
	}
	r.Previous = 0
	r.Text = fmt.Sprintf("已删除 %d 条保存记录。", n)
	return nil
}

func (s *Service) submitMessageURLs(ctx context.Context, r *commandRequest, m *telegram.Message) error {
	var targets []domain.Target
	inputs := map[string]string{}
	seen := map[string]bool{}
	for _, url := range telegram.URLs(m) {
		target, err := domain.Normalize(url)
		if err == nil && !seen[target.ExternalID] {
			seen[target.ExternalID] = true
			targets = append(targets, target)
			inputs[target.ExternalID] = url
		}
	}
	if len(targets) == 0 {
		if m.Chat.ID < 0 {
			return nil
		}
		r.Text = "请发送支持的 X 帖子 URL，或使用 /help。"
		return nil
	}
	if len(targets) > 200 {
		r.Text = "一次最多 200 个不同帖子，请拆分发送。"
		return nil
	}
	connection, err := s.DefaultConnection(ctx, r.Task.Tenant)
	if err != nil {
		return err
	}
	for _, target := range targets {
		_, err := s.Submit(ctx, r.Task.Tenant, domain.CaptureInput{Input: inputs[target.ExternalID], URL: target.URL, ConnectionID: connection, Key: r.Task.ID + ":" + target.ExternalID, Origin: r.Origin})
		if err != nil {
			r.Text += submitMessage(err) + "\n输入：" + inputs[target.ExternalID] + "\n\n"
		}
	}
	return nil
}

func (s *Service) commandSave(ctx context.Context, r *commandRequest) error {
	if r.Message != nil {
		for _, url := range telegram.URLs(r.Message) {
			if _, err := domain.Normalize(url); err == nil {
				return s.submitMessageURLs(ctx, r, r.Message)
			}
		}
	}
	r.Text = "请在 /save 后附上 X 帖子链接，每次最多 200 个。群聊中请使用 /save@Bot用户名。"
	return nil
}

// Telegram keeps each list entry compact; the complete summary stays in storage.
func archiveListSummary(summary, text string) string {
	if strings.TrimSpace(summary) == "" {
		summary = text
	}
	summary = strings.Join(strings.Fields(summary), " ")
	if summary == "" {
		return "无文字内容"
	}
	const limit = 100
	chars := []rune(summary)
	if len(chars) > limit {
		// Retain adapter-provided media indicators even when the text is long.
		suffix := ""
		prefix := summary
		for {
			marker := ""
			for _, candidate := range []string{"[图片]", "[视频]"} {
				if strings.HasSuffix(prefix, candidate) {
					marker = candidate
					break
				}
			}
			if marker == "" {
				break
			}
			suffix = marker + suffix
			prefix = strings.TrimSuffix(prefix, marker)
		}
		budget := limit - len([]rune(suffix)) - 1
		if suffix != "" && budget > 0 {
			return string([]rune(prefix)[:budget]) + "…" + suffix
		}
		return string(chars[:limit-1]) + "…"
	}
	return summary
}
