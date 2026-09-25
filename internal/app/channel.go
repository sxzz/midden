package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"monitor/internal/domain"
	"monitor/internal/store"
	"monitor/internal/telegram"
)

func (s *Service) Poll(ctx context.Context, c *telegram.Client, channel string) error {
	conn, e := s.DB.Pool.Acquire(ctx)
	if e != nil {
		return e
	}
	var ok bool
	e = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtext($1),-2)`, channel).Scan(&ok)
	if e != nil || !ok {
		conn.Release()
		return fmt.Errorf("channel poller already running")
	}
	defer release(conn, channel, -2)
	for ctx.Err() == nil {
		var offset int64
		if e = conn.QueryRow(ctx, `SELECT next_offset FROM channels WHERE id=$1`, channel).Scan(&offset); e != nil {
			return e
		}
		updates, err := c.Updates(ctx, offset)
		if err != nil {
			d := 5 * time.Second
			var a *telegram.APIError
			if errors.As(err, &a) && a.RetryAfter > d {
				d = a.RetryAfter
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(d):
				continue
			}
		}
		for _, u := range updates {
			m := u.PrivateMessage()
			if m == nil {
				if _, e = conn.Exec(ctx, `UPDATE channels SET next_offset=$2 WHERE id=$1`, channel, u.ID+1); e != nil {
					return e
				}
				continue
			}
			identity, err := s.DB.Resolve(ctx, channel, strconv.FormatInt(m.From.ID, 10), s.Config.Quota)
			if err != nil {
				return err
			}
			raw, _ := json.Marshal(u)
			e = s.DB.Tx(ctx, identity.TenantID, func(tx pgx.Tx) error {
				var id string
				e := tx.QueryRow(ctx, `INSERT INTO inbox(tenant_id,channel_id,update_id,payload) VALUES($1,$2,$3,$4) ON CONFLICT(channel_id,update_id) DO NOTHING RETURNING id`, identity.TenantID, channel, u.ID, raw).Scan(&id)
				if e != nil && !errors.Is(e, pgx.ErrNoRows) {
					return e
				}
				if e == nil {
					if e = s.Enqueue(ctx, tx, identity.TenantID, id, "inbox"); e != nil {
						return e
					}
				}
				_, e = tx.Exec(ctx, `UPDATE channels SET next_offset=$2 WHERE id=$1`, channel, u.ID+1)
				return e
			})
			if e != nil {
				return e
			}
			if u.Callback != nil {
				short, cancel := context.WithTimeout(ctx, 2*time.Second)
				_ = c.Answer(short, u.Callback.ID)
				cancel()
			}
		}
	}
	return ctx.Err()
}

func (s *Service) processInbox(ctx context.Context, t store.Task) error {
	var raw []byte
	var channel, state string
	e := s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT payload,channel_id,state FROM inbox WHERE id=$1`, t.ID).Scan(&raw, &channel, &state)
	})
	if e != nil || state != "pending" {
		return e
	}
	var u telegram.Update
	if e = json.Unmarshal(raw, &u); e != nil {
		return &PermanentError{"invalid persisted update"}
	}
	m := u.PrivateMessage()
	if m == nil {
		return nil
	}
	chat := strconv.FormatInt(m.Chat.ID, 10)
	var identity string
	e = s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT id FROM identities WHERE channel_id=$1 AND external_id=$2`, channel, chat).Scan(&identity)
	})
	if e != nil {
		return e
	}
	origin := domain.Origin{IdentityID: identity, ChannelID: channel, ChatID: chat}
	text := ""
	buttons := menuButtons()
	previous := int64(0)
	input := m.Text
	if u.Callback != nil {
		input = u.Callback.Data
		previous = m.ID
		// Keep navigation replies separate from a still-active progress message.
		var active bool
		if err := s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM submissions WHERE channel_id=$1 AND chat_id=$2 AND message_id=$3 AND state='pending' AND progress=0)`, channel, chat, previous).Scan(&active)
		}); err != nil {
			return err
		}
		if active {
			previous = 0
		}
		if !validCallback(input) {
			input = "/help"
		}
	}
	stopAction := keepAction(ctx, s.sender(channel), chat, "typing")
	defer stopAction()
	fields := strings.Fields(input)
	cmd := ""
	arg := ""
	if len(fields) > 0 {
		cmd = strings.Split(fields[0], "@")[0]
	}
	if len(fields) > 1 {
		arg = fields[1]
	}

	request := &commandRequest{Task: t, Origin: origin, Argument: arg, Buttons: buttons, Previous: previous}
	if command, ok := lookupCommand(cmd); ok {
		if len(fields) > 2 || !command.Validate(arg) {
			request.Text = strings.TrimSpace("用法：/" + command.Name + " " + command.Usage)
		} else if err := command.Handle(s, ctx, request); err != nil {
			return err
		}
	} else if err := s.submitMessageURLs(ctx, request, m); err != nil {
		return err
	}
	text, buttons, previous = request.Text, request.Buttons, request.Previous

	return s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		if text == "" {
			_, e := tx.Exec(ctx, `UPDATE inbox SET state='processed' WHERE id=$1`, t.ID)
			return e
		}
		encoded, err := json.Marshal(buttons)
		if err != nil {
			return err
		}
		var rid string
		e := tx.QueryRow(ctx, `INSERT INTO replies(tenant_id,inbox_id,chat_id,text,message_id,buttons) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(inbox_id) DO NOTHING RETURNING id`, t.Tenant, t.ID, chat, text, previous, encoded).Scan(&rid)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		if e == nil {
			if e = s.Enqueue(ctx, tx, t.Tenant, rid, "reply"); e != nil {
				return e
			}
		}
		_, e = tx.Exec(ctx, `UPDATE inbox SET state='processed' WHERE id=$1`, t.ID)
		return e
	})
}

func submitMessage(e error) string {
	switch {
	case errors.Is(e, domain.ErrQuota):
		return "存储额度不足。"
	case errors.Is(e, domain.ErrRate):
		return "采集请求过于频繁，请稍后重试。"
	case errors.Is(e, domain.ErrNotFound):
		return "归档不存在或无权限。"
	default:
		return "请求未能提交，请检查链接或稍后重试。"
	}
}

func (s *Service) reply(ctx context.Context, t store.Task) error {
	var chat, text, state, channel string
	var mid int64
	var rawButtons []byte
	e := s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT r.chat_id,r.text,r.state,r.message_id,i.channel_id,r.buttons FROM replies r JOIN inbox i ON i.id=r.inbox_id AND i.tenant_id=r.tenant_id WHERE r.id=$1`, t.ID).Scan(&chat, &text, &state, &mid, &channel, &rawButtons)
	})
	if e != nil || state == "sent" {
		return e
	}
	sender := s.sender(channel)
	if sender == nil {
		return fmt.Errorf("channel sender unavailable")
	}
	var buttons telegram.Keyboard
	if e = json.Unmarshal(rawButtons, &buttons); e != nil {
		return e
	}
	id, e := sendInteractive(ctx, sender, chat, text, mid, buttons)
	if e != nil {
		return telegramError(e)
	}
	return s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `UPDATE replies SET state='sent',message_id=$2 WHERE id=$1`, t.ID, id)
		return e
	})
}

func telegramError(e error) error {
	var a *telegram.APIError
	if errors.As(e, &a) {
		if a.Code == 429 {
			return &RetryError{After: a.RetryAfter, Err: e}
		}
		if a.Code >= 400 && a.Code < 500 {
			return &PermanentError{"Telegram rejected delivery"}
		}
	}
	return e
}

func (s *Service) deliver(ctx context.Context, t store.Task) error {
	unlock, err := s.lockSubmission(ctx, t.ID)
	if err != nil {
		return err
	}
	defer unlock()
	var cid, chat, state, channel string
	var mid int64
	var progress int
	e := s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT capture_id,chat_id,state,message_id,progress,channel_id FROM submissions WHERE id=$1`, t.ID).Scan(&cid, &chat, &state, &mid, &progress, &channel)
	})
	if e != nil || state == "sent" {
		return e
	}
	j, e := s.Job(ctx, t.Tenant, cid)
	if e != nil {
		return e
	}
	if j.State == "queued" || j.State == "downloading" {
		return nil
	}
	text := jobState(j.State) + "\n任务 " + j.ID
	buttons := menuButtons()
	var aa []domain.Asset
	if j.State == "failed" {
		text += "\n" + j.Error
		buttons = append(telegram.Keyboard{{{Text: "重试", Data: "/refresh " + j.ArchiveID}}}, buttons...)
	} else {
		a, err := s.CaptureArchive(ctx, t.Tenant, cid)
		if err != nil {
			return err
		}
		text += "\n归档 " + a.ID + "\n" + a.URL + "\n" + a.Text + "\n" + strings.Join(a.Warnings, "\n")
		aa = a.Assets
		buttons = archiveButtons(a.ID, a.URL)
		for _, v := range aa {
			if v.State == "failed" {
				text += "\n图片未归档：" + v.Error
			}
		}
	}
	sender := s.sender(channel)
	if sender == nil {
		return fmt.Errorf("channel sender unavailable")
	}
	chunks := telegram.Split(text)
	ready := []domain.Asset{}
	for _, a := range aa {
		if a.State == "ready" {
			ready = append(ready, a)
		}
	}
	groups := [][]domain.Asset{}
	for len(ready) > 0 {
		n := min(10, len(ready))
		groups = append(groups, ready[:n])
		ready = ready[n:]
	}
	total := len(chunks) + len(groups)
	for progress < total {
		var id int64
		if progress < len(chunks) {
			previous := int64(0)
			if progress == 0 {
				previous = mid
			}
			if progress == 0 {
				id, e = sendInteractive(ctx, sender, chat, chunks[progress], previous, buttons)
			} else {
				id, e = sender.Send(ctx, chat, chunks[progress], previous)
			}
		} else {
			stop := keepAction(ctx, sender, chat, "upload_photo")
			id, e = sender.Images(ctx, chat, groups[progress-len(chunks)])
			stop()
		}
		if e != nil {
			return telegramError(e)
		}
		progress++
		if progress == 1 {
			mid = id
		}
		e = s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
			_, e := tx.Exec(ctx, `UPDATE submissions SET progress=$2,message_id=$3 WHERE id=$1`, t.ID, progress, mid)
			return e
		})
		if e != nil {
			return e
		}
	}
	return s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `UPDATE submissions SET state='sent' WHERE id=$1`, t.ID)
		return e
	})
}
