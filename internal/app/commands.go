package app

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"monitor/internal/domain"
	"monitor/internal/store"
	"monitor/internal/telegram"
)

type commandRequest struct {
	Task     store.Task
	Origin   domain.Origin
	Argument string
	Text     string
	Buttons  telegram.Keyboard
	Previous int64
}

type channelCommand struct {
	Name        string
	Description string
	Usage       string
	Callback    bool
	Validate    func(string) bool
	Handle      func(*Service, context.Context, *commandRequest) error
}

// Routing, Telegram's command menu, help and callback validation share this registry.
var channelCommands []channelCommand

func init() {
	channelCommands = []channelCommand{
		{"start", "开始收藏图文", "", false, noArgument, (*Service).commandHelp},
		{"recent", "查看最近归档", "[游标]", true, validCursorArgument, (*Service).commandRecent},
		{"show", "查看指定归档", "<归档 ID>", true, validIDArgument, (*Service).commandShow},
		{"status", "查看采集状态", "<任务 ID>", true, validIDArgument, (*Service).commandStatus},
		{"refresh", "重新抓取帖子", "<归档 ID>", true, validIDArgument, (*Service).commandRefresh},
		{"forget", "取消收藏", "<归档 ID>", true, validIDArgument, (*Service).commandForget},
		{"usage", "查看存储用量", "", true, noArgument, (*Service).commandUsage},
		{"help", "查看使用帮助", "", true, noArgument, (*Service).commandHelp},
	}
}

func TelegramCommands() []telegram.Command {
	commands := make([]telegram.Command, 0, len(channelCommands))
	for _, c := range channelCommands {
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
	if s == "" {
		return true
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	return err == nil && validIDArgument(string(raw))
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
	return c.Validate(arg)
}

func (s *Service) commandHelp(_ context.Context, r *commandRequest) error {
	var b strings.Builder
	b.WriteString("发送 X 帖子链接收藏图文（每次最多 5 个）。")
	for _, c := range channelCommands {
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
		r.Text += fmt.Sprintf("%d. %s\n", i+1, a.URL)
		r.Buttons = append(r.Buttons, []telegram.Button{{Text: fmt.Sprintf("查看第 %d 条", i+1), Data: "/show " + a.ID}})
	}
	if r.Text == "" {
		r.Text = "暂无归档。"
	}
	if p.NextCursor != "" {
		r.Buttons = append(r.Buttons, []telegram.Button{{Text: "下一页 →", Data: "/recent " + p.NextCursor}})
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
		err := tx.QueryRow(ctx, `INSERT INTO submissions(tenant_id,capture_id,identity_id,channel_id,chat_id,idem_key,fingerprint) SELECT $1,capture_id,$3,$4,$5,$6,$6 FROM revisions WHERE id=$2 ON CONFLICT(tenant_id,idem_key) DO NOTHING RETURNING id`, r.Task.Tenant, a.RevisionID, r.Origin.IdentityID, r.Origin.ChannelID, r.Origin.ChatID, "show:"+r.Task.ID).Scan(&sid)
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
		r.Text = submitMessage(err)
	}
	return nil
}

func (s *Service) commandForget(ctx context.Context, r *commandRequest) error {
	r.Previous = 0
	if err := s.Forget(ctx, r.Task.Tenant, r.Argument); err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			r.Text = "你尚未收藏这条内容。"
			return nil
		}
		return err
	}
	r.Text = "已取消收藏并释放对应额度，其他人的收藏不受影响。"
	return nil
}

func (s *Service) submitMessageURLs(ctx context.Context, r *commandRequest, m *telegram.Message) error {
	var targets []domain.Target
	seen := map[string]bool{}
	for _, url := range telegram.URLs(m) {
		target, err := domain.Normalize(url)
		if err == nil && !seen[target.ExternalID] {
			seen[target.ExternalID] = true
			targets = append(targets, target)
		}
	}
	if len(targets) == 0 {
		r.Text = "请发送支持的 X 帖子 URL，或使用 /help。"
		return nil
	}
	if len(targets) > 5 {
		r.Text = "一次最多 5 个不同帖子，请拆分发送。"
		return nil
	}
	for _, target := range targets {
		_, err := s.Submit(ctx, r.Task.Tenant, domain.CaptureInput{URL: target.URL, Key: r.Task.ID + ":" + target.ExternalID, Origin: r.Origin})
		if err != nil {
			r.Text += submitMessage(err) + "\n"
		}
	}
	return nil
}
