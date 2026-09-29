package app

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"monitor/internal/domain"
	"monitor/internal/store"
	"monitor/internal/telegram"
)

type interactiveSender interface {
	SendInteractive(context.Context, string, string, int64, telegram.Keyboard) (int64, error)
	Action(context.Context, string, string) error
	Answer(context.Context, string) error
}

func (s *Service) replySender(channel string, replyTo int64) Sender {
	sender := s.sender(channel)
	if c, ok := sender.(*telegram.Client); ok {
		return c.WithReplyTo(replyTo)
	}
	return sender
}

func menuButtons() telegram.Keyboard {
	return telegram.Keyboard{{{Text: "归档列表", Data: "/list"}, {Text: "存储用量", Data: "/usage"}}}
}

func channelButtons(chat string, buttons telegram.Keyboard) telegram.Keyboard {
	if strings.HasPrefix(chat, "-") {
		var filtered telegram.Keyboard
		for _, row := range buttons {
			var kept []telegram.Button
			for _, button := range row {
				fields := strings.Fields(button.Data)
				if len(fields) > 0 {
					if command, ok := lookupCommand(fields[0]); ok && command.PrivateOnly {
						continue
					}
				}
				kept = append(kept, button)
			}
			if len(kept) > 0 {
				filtered = append(filtered, kept)
			}
		}
		buttons = filtered
	}
	return buttons
}

func sendInteractive(ctx context.Context, sender Sender, chat, text string, mid int64, buttons telegram.Keyboard) (int64, error) {
	buttons = channelButtons(chat, buttons)

	if c, ok := sender.(interactiveSender); ok {
		return c.SendInteractive(ctx, chat, text, mid, buttons)
	}
	return sender.Send(ctx, chat, text, mid)
}

func chatAction(ctx context.Context, sender Sender, chat, action string) {
	if c, ok := sender.(interactiveSender); ok {
		short, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		_ = c.Action(short, chat, action)
	}
}

// Chat actions expire after a few seconds; stop refreshing as soon as work ends.
func keepAction(ctx context.Context, sender Sender, chat, action string) func() {
	if _, ok := sender.(interactiveSender); !ok {
		return func() {}
	}
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(4 * time.Second)
		defer ticker.Stop()
		for {
			chatAction(ctx, sender, chat, action)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return func() { cancel(); <-done }
}

// Status and final delivery share a lock so a stale progress edit cannot overwrite the result.
func (s *Service) lockSubmission(ctx context.Context, id string) (func(), error) {
	c, e := s.DB.Pool.Acquire(ctx)
	if e != nil {
		return nil, e
	}
	var ok bool
	if e = c.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtext($1),-3)`, id).Scan(&ok); e != nil {
		c.Release()
		return nil, e
	}
	if !ok {
		c.Release()
		return nil, river.JobSnooze(time.Second)
	}
	return func() { release(c, id, -3) }, nil
}

func (s *Service) submissionStatus(ctx context.Context, t store.Task) error {
	unlock, e := s.lockSubmission(ctx, t.ID)
	if e != nil {
		return e
	}
	defer unlock()
	var cid, chat, channel, state, last string
	var mid, replyTo int64
	e = s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT capture_id,chat_id,channel_id,state,message_id,status_text,reply_to_message_id FROM submissions WHERE id=$1`, t.ID).Scan(&cid, &chat, &channel, &state, &mid, &last, &replyTo)
	})
	if e != nil || state == "sent" {
		return e
	}
	if handled, err := s.collectionProgress(ctx, t); handled || err != nil {
		return err
	}
	sender := s.replySender(channel, replyTo)
	if _, ok := sender.(interactiveSender); !ok {
		return nil
	}
	job, e := s.Job(ctx, t.Tenant, cid)
	if e != nil {
		return e
	}
	if job.State != "queued" && job.State != "downloading" {
		return nil
	}
	text := "正在采集帖子…"
	if job.State == "downloading" {
		text = "正在保存媒体…"
	}
	var sourceURL string
	if err := s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT url FROM archives WHERE id=$1`, job.ArchiveID).Scan(&sourceURL)
	}); err != nil {
		return err
	}
	text += "\n" + sourceURL

	if text != last || mid == 0 {
		buttons := telegram.Keyboard{{{Text: "查看状态", Data: "/status " + job.ID}, {Text: "归档列表", Data: "/list"}}}
		id, err := sendInteractive(ctx, sender, chat, text, mid, buttons)
		if err != nil {
			return telegramError(err)
		}
		if e = s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `UPDATE submissions SET message_id=$2,status_text=$3 WHERE id=$1`, t.ID, id, text)
			return err
		}); e != nil {
			return e
		}
	}
	chatAction(ctx, sender, chat, "typing")
	return river.JobSnooze(5 * time.Second)
}

func jobState(state string) string {
	switch state {
	case "queued":
		return "正在采集"
	case "downloading":
		return "正在保存媒体"
	case "complete":
		return "归档完成"
	case "partial":
		return "已归档，部分资源缺失"
	case "failed":
		return "归档失败"
	}
	return state
}

func archiveButtons(id, url string) telegram.Keyboard {
	return telegram.Keyboard{
		{{Text: "原帖", URL: url}, {Text: "重新抓取", Data: "/refresh " + id}},
		{{Text: "删除", Data: "/delete " + id}},
		{{Text: "归档列表", Data: "/list"}},
	}
}

func usageText(used, reserved, limit int64) string {
	return fmt.Sprintf("已使用 %.1f MiB / %.1f MiB\n处理中预留 %.1f MiB", float64(used)/(1<<20), float64(limit)/(1<<20), float64(reserved)/(1<<20))
}

func archiveMessage(a domain.Archive, state string) string {
	header := a.ID
	author := strings.TrimSpace(a.AuthorName)
	if author == "" {
		author = "未知作者"
	}
	body := strings.TrimSpace(a.Text)
	if body == "" {
		body = "空"
	}
	parts := []string{header, author + "：\n" + body}
	if text, _, _, ok := telegram.ProfilePresentation(a); ok {
		parts = []string{text}
	}
	if state == "partial" {
		parts = append(parts, "部分内容未保存")
	}
	for _, asset := range a.Assets {
		if alt := strings.TrimSpace(asset.AltText); alt != "" {
			parts = append(parts, fmt.Sprintf("媒体 %d 描述：%s", asset.Position+1, alt))
		}
	}
	for _, warning := range a.Warnings {
		parts = append(parts, warning)
	}
	for _, asset := range a.Assets {
		if asset.State == "failed" {
			parts = append(parts, "媒体未保存："+asset.Error)
		}
	}
	return strings.Join(parts, "\n\n")
}

func archiveMessageEntities(a domain.Archive) []telegram.Entity {
	if _, entities, _, ok := telegram.ProfilePresentation(a); ok {
		return entities
	}
	size := func(s string) int { return len(utf16.Encode([]rune(s))) }
	author := strings.TrimSpace(a.AuthorName)
	if author == "" {
		author = "未知作者"
	}
	entities := []telegram.Entity{{Type: "code", Offset: 0, Length: size(a.ID)}}
	if url := telegram.ArchiveAuthorURL(a); url != "" {
		entities = append(entities, telegram.Entity{Type: "text_link", Offset: size(a.ID + "\n\n"), Length: size(author), URL: url})
	}
	if body := strings.TrimSpace(a.Text); body != "" {
		entities = append(entities, telegram.Entity{Type: "blockquote", Offset: size(a.ID + "\n\n" + author + "：\n"), Length: size(body)})
	}
	return entities
}
