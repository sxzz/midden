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
			if u.Message == nil || u.Message.Chat.Type != "private" || u.Message.From.Bot || u.Message.Chat.ID != u.Message.From.ID {
				if _, e = conn.Exec(ctx, `UPDATE channels SET next_offset=$2 WHERE id=$1`, channel, u.ID+1); e != nil {
					return e
				}
				continue
			}
			identity, err := s.DB.Resolve(ctx, channel, strconv.FormatInt(u.Message.From.ID, 10), s.Config.Quota)
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
	m := u.Message
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
	fields := strings.Fields(m.Text)
	cmd := ""
	arg := ""
	if len(fields) > 0 {
		cmd = strings.Split(fields[0], "@")[0]
	}
	if len(fields) > 1 {
		arg = fields[1]
	}
	switch cmd {
	case "/start", "/help":
		text = "发送 X 帖子链接收藏图文（每次最多 5 个）。\n/recent [游标] 最近归档\n/show <归档 ID> 查看\n/status <任务 ID> 状态\n/refresh <归档 ID> 重新抓取\n/usage 用量\n来源 xdown，可能仅提供摘要；不保证完整。"
	case "/usage":
		v, err := s.Usage(ctx, t.Tenant)
		if err != nil {
			return err
		}
		text = fmt.Sprintf("已使用 %d 字节；预留 %d；额度 %d。", v.Used, v.Reserved, v.Limit)
	case "/recent":
		p, err := s.Recent(ctx, t.Tenant, arg)
		if err != nil {
			text = "无效游标或无权限。"
			break
		}
		for _, a := range p.Items {
			text += a.ID + "\n" + a.URL + "\n"
		}
		if text == "" {
			text = "暂无归档。"
		}
		if p.NextCursor != "" {
			text += "\n下一页：/recent " + p.NextCursor
		}
	case "/status":
		j, err := s.Job(ctx, t.Tenant, arg)
		if err != nil {
			text = "任务不存在或无权限。"
		} else {
			text = fmt.Sprintf("任务 %s：%s\n%s", j.ID, j.State, j.Error)
		}
	case "/show":
		a, err := s.Archive(ctx, t.Tenant, arg)
		if err != nil {
			text = "归档不存在或无权限。"
			break
		}
		e = s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
			var sid string
			e := tx.QueryRow(ctx, `INSERT INTO submissions(tenant_id,capture_id,identity_id,channel_id,chat_id,idem_key,fingerprint) SELECT $1,capture_id,$3,$4,$5,$6,$6 FROM revisions WHERE id=$2 ON CONFLICT(tenant_id,idem_key) DO NOTHING RETURNING id`, t.Tenant, a.RevisionID, identity, channel, chat, "show:"+t.ID).Scan(&sid)
			if errors.Is(e, pgx.ErrNoRows) {
				return nil
			}
			if e != nil {
				return e
			}
			return s.Enqueue(ctx, tx, t.Tenant, sid, "deliver")
		})
		if e != nil {
			return e
		}
		text = "正在读取归档 " + a.ID
	case "/refresh":
		j, err := s.Submit(ctx, t.Tenant, domain.CaptureInput{RefreshID: arg, Key: "refresh:" + t.ID, Origin: origin})
		if err != nil {
			text = submitMessage(err)
		} else {
			text = "已提交任务 " + j.ID
		}
	default:
		urls := telegram.URLs(m)
		targets := []domain.Target{}
		seen := map[string]bool{}
		for _, url := range urls {
			target, err := domain.Normalize(url)
			if err == nil && !seen[target.ExternalID] {
				seen[target.ExternalID] = true
				targets = append(targets, target)
			}
		}
		if len(targets) == 0 {
			text = "请发送支持的 X 帖子 URL，或使用 /help。"
		} else if len(targets) > 5 {
			text = "一次最多 5 个不同帖子，请拆分发送。"
		} else {
			for _, target := range targets {
				j, err := s.Submit(ctx, t.Tenant, domain.CaptureInput{URL: target.URL, Key: t.ID + ":" + target.ExternalID, Origin: origin})
				if err != nil {
					text += submitMessage(err) + "\n"
				} else {
					text += "任务 " + j.ID + "：" + j.State + "\n"
				}
			}
		}
	}
	return s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		var rid string
		e := tx.QueryRow(ctx, `INSERT INTO replies(tenant_id,inbox_id,chat_id,text) VALUES($1,$2,$3,$4) ON CONFLICT(inbox_id) DO NOTHING RETURNING id`, t.Tenant, t.ID, chat, text).Scan(&rid)
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
	e := s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT r.chat_id,r.text,r.state,r.message_id,i.channel_id FROM replies r JOIN inbox i ON i.id=r.inbox_id AND i.tenant_id=r.tenant_id WHERE r.id=$1`, t.ID).Scan(&chat, &text, &state, &mid, &channel)
	})
	if e != nil || state == "sent" {
		return e
	}
	sender := s.sender(channel)
	if sender == nil {
		return fmt.Errorf("channel sender unavailable")
	}
	id, e := sender.Send(ctx, chat, text, mid)
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
	text := "任务 " + j.ID + "：" + j.State
	var aa []domain.Asset
	if j.State == "failed" {
		text += "\n" + j.Error
	} else {
		a, err := s.CaptureArchive(ctx, t.Tenant, cid)
		if err != nil {
			return err
		}
		text += "\n归档 " + a.ID + "\n" + a.URL + "\n" + a.Text + "\n" + strings.Join(a.Warnings, "\n")
		aa = a.Assets
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
			id, e = sender.Send(ctx, chat, chunks[progress], previous)
		} else {
			id, e = sender.Images(ctx, chat, groups[progress-len(chunks)])
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
