package app

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"monitor/internal/store"
	"monitor/internal/telegram"
)

type interactiveSender interface {
	SendInteractive(context.Context, string, string, int64, telegram.Keyboard) (int64, error)
	Action(context.Context, string, string) error
	Answer(context.Context, string) error
}

func menuButtons() telegram.Keyboard {
	return telegram.Keyboard{{{Text: "最近归档", Data: "/recent"}, {Text: "存储用量", Data: "/usage"}}}
}

func sendInteractive(ctx context.Context, sender Sender, chat, text string, mid int64, buttons telegram.Keyboard) (int64, error) {
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
	var mid int64
	e = s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT capture_id,chat_id,channel_id,state,message_id,status_text FROM submissions WHERE id=$1`, t.ID).Scan(&cid, &chat, &channel, &state, &mid, &last)
	})
	if e != nil || state == "sent" {
		return e
	}
	sender := s.sender(channel)
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
		text = "正在保存图片…"
	}
	text += "\n任务 " + job.ID
	if text != last || mid == 0 {
		buttons := telegram.Keyboard{{{Text: "查看状态", Data: "/status " + job.ID}, {Text: "最近归档", Data: "/recent"}}}
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
		return "正在保存图片"
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
		{{Text: "查看归档", Data: "/show " + id}, {Text: "重新抓取", Data: "/refresh " + id}},
		{{Text: "原帖", URL: url}, {Text: "最近归档", Data: "/recent"}},
	}
}

func usageText(used, reserved, limit int64) string {
	return fmt.Sprintf("已使用 %.1f MiB / %.1f MiB\n处理中预留 %.1f MiB", float64(used)/(1<<20), float64(limit)/(1<<20), float64(reserved)/(1<<20))
}
