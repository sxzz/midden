package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

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
			m := u.ActorMessage()
			if m != nil && m.Chat.ID < 0 && u.Callback == nil && !groupTrigger(m, c.Username) {
				m = nil
			}
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
			raw, deleteInput, err := s.prepareUpdate(u, identity.TenantID, channel, c.Username)
			if err != nil {
				return err
			}
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
			if deleteInput {
				deleteAccountInput(ctx, c, strconv.FormatInt(m.Chat.ID, 10), m.ID)
			}
			if u.Callback != nil && !sharedSaveCallback(u.Callback.Data) {
				short, cancel := context.WithTimeout(ctx, 2*time.Second)
				_ = c.Answer(short, u.Callback.ID)
				cancel()
			}
		}
	}
	return ctx.Err()
}

func groupTrigger(m *telegram.Message, username string) bool {
	text, addressed := m.AddressedText(username)
	if !addressed {
		return false
	}
	if fields := strings.Fields(text); len(fields) > 0 {
		if parts := strings.SplitN(fields[0], "@", 2); len(parts) == 2 && !strings.EqualFold(parts[1], username) {
			return false
		}
		if _, ok := lookupCommand(strings.Split(fields[0], "@")[0]); ok {
			return true
		}
	}
	for _, raw := range telegram.URLs(m) {
		if _, err := domain.Normalize(raw); err == nil {
			return true
		}
	}
	return false
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
	var u persistedUpdate
	if e = json.Unmarshal(raw, &u); e != nil {
		return &PermanentError{"invalid persisted update"}
	}
	m := u.ActorMessage()
	if m == nil {
		return &PermanentError{"unsupported Telegram actor"}
	}
	chat := strconv.FormatInt(m.Chat.ID, 10)
	if u.AccountImport != nil && m.Chat.Type == "private" && (len(u.AccountImport.Ciphertext) > 0 || u.AccountImport.Error != "") {
		deleteAccountInput(ctx, s.sender(channel), chat, m.ID)
	}

	var identity string
	e = s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT id FROM identities WHERE channel_id=$1 AND external_id=$2`, channel, strconv.FormatInt(m.From.ID, 10)).Scan(&identity)
	})
	if e != nil {
		return e
	}
	if u.Callback != nil && sharedSaveCallback(u.Callback.Data) {
		return s.saveSharedCallback(ctx, t, channel, m, u.Callback)
	}
	origin := domain.Origin{IdentityID: identity, ChannelID: channel, ChatID: chat}
	if m.Chat.ID < 0 {
		origin.ReplyToMessageID = m.ID
	}
	text := ""
	buttons := menuButtons()
	previous := int64(0)
	input := m.Text
	if u.Callback != nil {
		input = u.Callback.Data
		previous = m.ID
		if m.Chat.ID < 0 {
			previous = 0
		}
		// Never replace archive content; progress messages also own their own updates.
		var protected bool
		if err := s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM submissions WHERE channel_id=$1 AND chat_id=$2 AND message_id=$3 )`, channel, chat, previous).Scan(&protected)
		}); err != nil {
			return err
		}
		if protected {
			previous = 0
		}
		if !validCallback(input) {
			input = "/help"
		}
	}
	stopAction := keepAction(ctx, s.sender(channel), chat, "typing")
	defer stopAction()
	if m.Chat.ID < 0 && u.Callback == nil {
		if c, ok := s.sender(channel).(*telegram.Client); ok {
			input, _ = m.AddressedText(c.Username)
		}
	}
	fields := strings.Fields(input)
	cmd := ""
	arg := ""
	if len(fields) > 0 {
		cmd = strings.Split(fields[0], "@")[0]
	}
	if len(fields) > 1 {
		arg = strings.Join(fields[1:], " ")
	}

	request := &commandRequest{AccountImport: u.AccountImport, Message: m, Task: t, Origin: origin, Argument: arg, Buttons: buttons, Previous: previous}
	allowed := true
	if m.Chat.ID < 0 && u.Callback != nil {
		if err := s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT EXISTS(
                SELECT FROM submissions WHERE channel_id=$1 AND chat_id=$2 AND message_id=$3 AND identity_id=$4
                UNION ALL
                SELECT FROM replies r JOIN inbox i ON i.id=r.inbox_id AND i.tenant_id=r.tenant_id
                WHERE i.channel_id=$1 AND r.chat_id=$2 AND r.message_id=$3
                  AND coalesce(i.payload#>>'{callback_query,from,id}',i.payload#>>'{message,from,id}')=$5
            )`, channel, chat, m.ID, identity, strconv.FormatInt(m.From.ID, 10)).Scan(&allowed)
		}); err != nil {
			return err
		}
	}
	if !allowed {
		request.Text = "这条消息仅限发起者操作。"
		request.Buttons = nil
	} else if command, ok := lookupCommand(cmd); ok {
		if m.Chat.ID < 0 && command.PrivateOnly {
			request.Text = "请在私聊中使用 /" + command.Name + "。"
		} else if !command.Validate(arg) {
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
			_, e := tx.Exec(ctx, `UPDATE inbox SET state='processed',payload=payload-'account_import' WHERE id=$1`, t.ID)
			return e
		}
		encoded, err := json.Marshal(buttons)
		if err != nil {
			return err
		}
		encodedEntities, err := json.Marshal(request.Entities)
		if err != nil {
			return err
		}
		var rid string
		e := tx.QueryRow(ctx, `INSERT INTO replies(tenant_id,inbox_id,chat_id,text,message_id,buttons,reply_to_message_id,entities) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(inbox_id) DO NOTHING RETURNING id`, t.Tenant, t.ID, chat, text, previous, encoded, origin.ReplyToMessageID, encodedEntities).Scan(&rid)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		if e == nil {
			if e = s.Enqueue(ctx, tx, t.Tenant, rid, "reply"); e != nil {
				return e
			}
		}
		_, e = tx.Exec(ctx, `UPDATE inbox SET state='processed',payload=payload-'account_import' WHERE id=$1`, t.ID)
		return e
	})
}

func submitMessage(e error) string {
	switch {
	case errors.Is(e, ErrConnection):
		return "账号不可用，请使用 /account 选择公共来源或重新授权。"
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
	var mid, replyTo int64
	var progress int
	var rawButtons, rawEntities []byte
	e := s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT r.chat_id,r.text,r.state,r.message_id,i.channel_id,r.buttons,r.reply_to_message_id,r.entities,r.progress FROM replies r JOIN inbox i ON i.id=r.inbox_id AND i.tenant_id=r.tenant_id WHERE r.id=$1`, t.ID).Scan(&chat, &text, &state, &mid, &channel, &rawButtons, &replyTo, &rawEntities, &progress)
	})
	if e != nil || state == "sent" {
		return e
	}
	sender := s.replySender(channel, replyTo)
	if sender == nil {
		return fmt.Errorf("channel sender unavailable")
	}
	var entities []telegram.Entity
	if e = json.Unmarshal(rawEntities, &entities); e != nil {
		return e
	}
	var buttons telegram.Keyboard
	if e = json.Unmarshal(rawButtons, &buttons); e != nil {
		return e
	}
	if mid != 0 {
		var protected bool
		if err := s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM submissions WHERE channel_id=$1 AND chat_id=$2 AND message_id=$3)`, channel, chat, mid).Scan(&protected)
		}); err != nil {
			return err
		}
		if protected {
			mid = 0
		}
	}

	offset := 0
	for i, part := range telegram.Split(text) {
		size := len(utf16.Encode([]rune(part)))
		if i >= progress {
			formatted := sender
			if c, ok := sender.(*telegram.Client); ok {
				var partEntities []telegram.Entity
				for _, entity := range entities {
					if entity.Offset >= offset && entity.Offset+entity.Length <= offset+size {
						entity.Offset -= offset
						partEntities = append(partEntities, entity)
					}
				}
				formatted = c.WithEntities(partEntities)
			}
			previous := int64(0)
			var keyboard telegram.Keyboard
			if i == 0 {
				previous = mid
				keyboard = buttons
			}
			id, err := sendInteractive(ctx, formatted, chat, part, previous, keyboard)
			if err != nil {
				return telegramError(err)
			}
			if i == 0 {
				mid = id
			}
			if err := s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
				_, err := tx.Exec(ctx, `UPDATE replies SET progress=$2,message_id=$3 WHERE id=$1`, t.ID, i+1, mid)
				return err
			}); err != nil {
				return err
			}
		}
		offset += size
	}
	return s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `UPDATE replies SET state='sent' WHERE id=$1`, t.ID)
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
	var cid, chat, state, channel, input string
	var mid, replyTo int64
	var progress int
	e := s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT capture_id,chat_id,state,message_id,progress,channel_id,reply_to_message_id,input FROM submissions WHERE id=$1`, t.ID).Scan(&cid, &chat, &state, &mid, &progress, &channel, &replyTo, &input)
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
	text := jobState(j.State)
	buttons := menuButtons()
	var aa []domain.Asset
	if j.State == "failed" {
		if input == "" {
			if err := s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
				return tx.QueryRow(ctx, `SELECT url FROM archives WHERE id=$1`, j.ArchiveID).Scan(&input)
			}); err != nil {
				return err
			}
		}
		text += "\n输入：" + input + "\n\n" + j.Error
		buttons = append(telegram.Keyboard{{{Text: "重试", Data: "/retry " + j.ArchiveID}}}, buttons...)
	} else {
		a, err := s.CaptureArchive(ctx, t.Tenant, cid)
		if err != nil {
			return err
		}
		text = archiveMessage(a, j.State)
		aa = a.Assets
		buttons = archiveButtons(a.ID, a.URL)
		if strings.HasPrefix(chat, "-") && a.Visibility == "public" {
			buttons = append(buttons, []telegram.Button{{Text: "我也要存", Data: "/save " + a.ID}})
		}
	}
	sender := s.replySender(channel, replyTo)
	if sender == nil {
		return fmt.Errorf("channel sender unavailable")
	}
	parts := deliveryParts(text, aa)
	headerPart := -1
	for i, part := range parts {
		if part.text != "" {
			headerPart = i
			break
		}
	}
	// Progress text is replaced by the new captioned media, never by editing old content.
	if len(parts) > 0 && parts[0].kind == "media" && progress == 0 && mid != 0 {
		if c, ok := sender.(*telegram.Client); ok {
			if err := c.DeleteProgress(ctx, chat, mid); err != nil {
				return telegramError(err)
			}
		}
		if err := s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `UPDATE submissions SET message_id=0 WHERE id=$1`, t.ID)
			return err
		}); err != nil {
			return err
		}
		mid = 0
	}
	for progress < len(parts) {
		part := parts[progress]
		formatted := sender
		if c, ok := sender.(*telegram.Client); ok && progress == headerPart && j.State != "failed" {
			client := c.WithCode(j.ArchiveID)
			formatted = client
		}
		var id int64
		switch part.kind {
		case "text":
			if progress == 0 {
				id, e = sendInteractive(ctx, formatted, chat, part.text, mid, buttons)
			} else {
				id, e = formatted.Send(ctx, chat, part.text, 0)
			}
		case "media":
			action := "upload_photo"
			for _, a := range part.assets {
				if a.MIME == "video/mp4" {
					action = "upload_video"
					break
				}
			}
			stop := keepAction(ctx, sender, chat, action)
			id, e = formatted.Media(ctx, chat, part.assets, part.text)
			stop()
		case "buttons":
			if c, ok := sender.(*telegram.Client); ok {
				e = c.SetButtons(ctx, chat, mid, channelButtons(chat, buttons))
			}
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
