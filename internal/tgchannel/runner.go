package tgchannel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"monitor/internal/channelapi"
	"monitor/internal/domain"
	"monitor/internal/telegram"
)

type Runner struct {
	API    *Client
	Bot    *telegram.Client
	Config channelapi.Config
}

func (r *Runner) Run(ctx context.Context) error {
	cfg, e := r.API.Config(ctx)
	if e != nil {
		return e
	}
	r.Config = cfg
	if r.Bot == nil {
		r.Bot = &telegram.Client{}
	}
	r.Bot.Token = cfg.Token
	r.Bot.Cache = r.API
	id, e := r.Bot.Me(ctx)
	if e != nil {
		return e
	}
	if id != cfg.BotID {
		return fmt.Errorf("bot identity does not match channel")
	}
	if e = r.Bot.ConfigureCommands(ctx, Commands(false), Commands(true)); e != nil {
		return e
	}
	if e = r.Bot.ConfigureWebMenu(ctx, cfg.WebURL); e != nil {
		return e
	}
	child, cancel := context.WithCancel(ctx)
	defer cancel()
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); r.poll(child, cfg.Offset) }()
	defer wg.Wait()
	for child.Err() == nil {
		w, e := r.API.Claim(child)
		if e != nil {
			if child.Err() != nil {
				break
			}
			slog.Warn("channel work unavailable")
			if !pause(child, 2*time.Second) {
				break
			}
			continue
		}
		if w == nil {
			continue
		}
		r.runWork(child, *w)
	}
	return nil
}

func pause(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func (r *Runner) poll(ctx context.Context, offset int64) {
	for ctx.Err() == nil {
		updates, e := r.Bot.Updates(ctx, offset)
		if e != nil {
			pause(ctx, 3*time.Second)
			continue
		}
		for _, u := range updates {
			event := Normalize(u, r.Bot.Username)
			for ctx.Err() == nil {
				secret, err := r.API.Event(ctx, event)
				if err != nil {
					pause(ctx, 2*time.Second)
					continue
				}
				if secret && event.MessageID != 0 {
					_ = r.Bot.DeleteProgress(ctx, event.Chat, event.MessageID)
				}
				if u.Callback != nil && event.Command != "save_shared" {
					_ = r.Bot.Answer(ctx, u.Callback.ID)
				}
				offset = u.ID + 1
				break
			}
		}
	}
}

func (r *Runner) runWork(ctx context.Context, w channelapi.Work) {
	workCtx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	var mu sync.Mutex
	checkpoint := channelapi.Ack{Progress: w.Progress, MessageID: w.MessageID}
	// Heartbeats never race a checkpoint or terminal acknowledgement.
	save := func(a channelapi.Ack) error {
		mu.Lock()
		defer mu.Unlock()
		e := r.API.Ack(workCtx, w, a)
		if e == nil {
			checkpoint = a
		}
		return e
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(25 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-workCtx.Done():
				return
			case <-ticker.C:
				mu.Lock()
				a := checkpoint
				a.Done = false
				a.RetrySeconds = 0
				e := r.API.Ack(workCtx, w, a)
				mu.Unlock()
				if e != nil {
					cancel()
					return
				}
			}
		}
	}()
	var e error
	if w.Kind == "event" {
		e = r.event(workCtx, w, save)
	} else {
		e = r.deliver(workCtx, w, save)
	}
	cancel()
	wg.Wait()
	if e != nil && ctx.Err() == nil {
		mu.Lock()
		a := checkpoint
		mu.Unlock()
		a.Done = false
		a.RetrySeconds = 5
		var tg *telegram.APIError
		var api *APIError
		if errors.As(e, &tg) {
			if tg.Code == 429 {
				a.RetrySeconds = max(1, int(tg.RetryAfter.Seconds()))
			} else if tg.Code >= 400 && tg.Code < 500 {
				a.Permanent = true
			}
		}
		if errors.As(e, &api) && api.Status == 404 {
			return
		}
		_ = r.API.Ack(ctx, w, a)
		slog.Warn("channel work postponed", "kind", w.Kind)
	}
}

func (r *Runner) event(ctx context.Context, w channelapi.Work, save func(channelapi.Ack) error) error {
	var v channelapi.Event
	if e := json.Unmarshal(w.Payload, &v); e != nil {
		return e
	}
	var legacy struct {
		Legacy json.RawMessage `json:"legacy"`
	}
	_ = json.Unmarshal(w.Payload, &legacy)
	if len(legacy.Legacy) > 0 {
		var update telegram.Update
		if e := json.Unmarshal(legacy.Legacy, &update); e != nil {
			return e
		}
		v = Normalize(update, r.Bot.Username)
		if e := r.API.call(ctx, "POST", "/work/"+w.ID+"/normalize", w.Lease, v, &v); e != nil {
			return e
		}
	}
	out, e := r.command(ctx, w, v)
	if e != nil {
		var api *APIError
		if !errors.As(e, &api) || api.Status >= 500 || api.Status == 429 {
			return e
		}
		out = response{Text: "操作失败，使用 /help 查看用法。", Buttons: menuButtons()}
	}
	if out.Toast != "" {
		_ = r.Bot.AnswerToast(ctx, v.CallbackID, out.Toast)
	}
	if !v.Private {
		out.Buttons = groupButtons(out.Buttons)
	}
	if out.Text == "" {
		return save(channelapi.Ack{Done: true, Progress: w.Progress, MessageID: w.MessageID})
	}
	sender := r.Bot.WithReplyTo(0)
	if !v.Private {
		sender = r.Bot.WithReplyTo(v.MessageID)
	}
	parts := deliveryParts(out.Text, nil)
	formatDeliveryParts(parts, out.Entities)
	mid := w.MessageID
	for i := w.Progress; i < len(parts); i++ {
		previous := int64(0)
		var buttons telegram.Keyboard
		if i == 0 {
			previous = out.Previous
			buttons = out.Buttons
		}
		id, e := sender.WithEntities(parts[i].entities).SendInteractive(ctx, v.Chat, parts[i].text, previous, buttons)
		if e != nil {
			return e
		}
		if i == 0 {
			mid = id
		}
		if e = save(channelapi.Ack{Progress: i + 1, MessageID: mid}); e != nil {
			return e
		}
	}
	return save(channelapi.Ack{Done: true, Progress: len(parts), MessageID: mid})
}

func (r *Runner) deliver(ctx context.Context, w channelapi.Work, save func(channelapi.Ack) error) error {
	d, e := r.API.Delivery(ctx, w)
	if e != nil {
		return e
	}
	if d.Paused {
		return save(channelapi.Ack{Progress: w.Progress, MessageID: w.MessageID, RetrySeconds: 30})
	}
	bot := *r.Bot
	bot.Blobs = mediaReader{r.API, w}
	sender := bot.WithReplyTo(d.ReplyTo)
	mid := w.MessageID
	if d.Batch != nil {
		// One message for the whole batch, edited until every capture finished.
		id, e := sender.SendInteractive(ctx, d.Chat, batchMessage(*d.Batch), mid, nil)
		if e != nil {
			return e
		}
		return save(channelapi.Ack{MessageID: id, Done: d.Batch.Done, RetrySeconds: 5})
	}
	if len(d.Legacy) > 0 && string(d.Legacy) != "null" {
		var old struct {
			Text     string
			Buttons  telegram.Keyboard
			Entities []telegram.Entity
		}
		if e = json.Unmarshal(d.Legacy, &old); e != nil {
			return e
		}
		parts := deliveryParts(old.Text, nil)
		formatDeliveryParts(parts, old.Entities)
		for i := w.Progress; i < len(parts); i++ {
			previous := int64(0)
			var keys telegram.Keyboard
			if i == 0 {
				if !d.Protected {
					previous = mid
				}
				keys = old.Buttons
			}
			id, e := sender.WithEntities(parts[i].entities).SendInteractive(ctx, d.Chat, parts[i].text, previous, keys)
			if e != nil {
				return e
			}
			if i == 0 {
				mid = id
			}
			if e = save(channelapi.Ack{Progress: i + 1, MessageID: mid}); e != nil {
				return e
			}
		}
		return save(channelapi.Ack{Done: true, Progress: len(parts), MessageID: mid})
	}
	if d.State == "sent" || d.State == "failed" {
		return save(channelapi.Ack{Done: true, Progress: w.Progress, MessageID: mid})
	}
	if d.ProgressDetails != nil {
		text, keys := collectionProgressMessage(w.Resource, d, r.Config.WebURL)
		id, e := sender.SendInteractive(ctx, d.Chat, text, mid, buttonsForChat(d.Chat, keys))
		if e != nil {
			return e
		}
		return save(channelapi.Ack{MessageID: id, Done: d.ProgressDetails.Done, RetrySeconds: 5})
	}
	if d.Job.State == "queued" || d.Job.State == "downloading" {
		text := jobState(d.Job.State) + "…"
		if d.Input != "" {
			text += "\n" + d.Input
		}
		id, e := sender.SendInteractive(ctx, d.Chat, text, mid, telegram.Keyboard{{{Text: "查看状态", Data: "/status " + d.Job.ID}}})
		if e != nil {
			return e
		}
		return save(channelapi.Ack{MessageID: id, RetrySeconds: 5})
	}
	text := jobState(d.Job.State) + "\n输入：" + d.Input + "\n" + failureReason(d.Job.Error)
	keys := telegram.Keyboard{{{Text: "重试", Data: "/retry " + d.Job.CollectionID}}}
	var entities []telegram.Entity
	parts := deliveryParts(text, nil)
	if d.Collection != nil {
		a := *d.Collection
		if _, _, assets, ok := telegram.ProfilePresentation(a); ok {
			a.Assets = assets
		}
		for i := range a.Assets {
			a.Assets[i].Key = a.Assets[i].ID
		}
		text = collectionMessage(a, d.Job.State)
		entities = collectionMessageEntities(a)
		parts = deliveryParts(text, a.Assets)
		keys = collectionButtons(a.ID, a.URL, r.Config.WebURL)
		if telegram.IsProfileCollection(a) {
			keys[0][0].Text = "在 X 查看主页"
		}
		if strings.HasPrefix(d.Chat, "-") && a.Visibility == "public" {
			keys = append(keys, []telegram.Button{{Text: "我也要存", Data: "/save " + a.ID}})
		}
	}
	formatDeliveryParts(parts, entities)
	header := -1
	for i, p := range parts {
		if p.text != "" {
			header = i
			break
		}
	}
	if len(parts) > 0 && parts[0].kind == "media" && w.Progress == 0 && mid != 0 {
		if e = sender.DeleteProgress(ctx, d.Chat, mid); e != nil {
			return e
		}
		mid = 0
		if e = save(channelapi.Ack{MessageID: 0}); e != nil {
			return e
		}
	}
	for i := w.Progress; i < len(parts); i++ {
		p := parts[i]
		formatted := sender.WithEntities(p.entities)
		var id int64
		switch p.kind {
		case "text":
			if i == header {
				previous := int64(0)
				if i == 0 {
					previous = mid
				}
				id, e = formatted.SendInteractive(ctx, d.Chat, p.text, previous, buttonsForChat(d.Chat, keys))
			} else {
				id, e = formatted.Send(ctx, d.Chat, p.text, 0)
			}
		case "media":
			id, e = formatted.Media(ctx, d.Chat, p.assets, p.text)
		case "buttons":
			e = formatted.SetButtons(ctx, d.Chat, mid, buttonsForChat(d.Chat, keys))
		}
		if e != nil {
			return e
		}
		if i == header {
			mid = id
		}
		if e = save(channelapi.Ack{Progress: i + 1, MessageID: mid}); e != nil {
			return e
		}
	}
	return save(channelapi.Ack{Done: true, Progress: len(parts), MessageID: mid})
}

// maxBatchItems bounds the items listed in a batch message.
const maxBatchItems = 5

func batchMessage(b domain.RefreshBatch) string {
	mode := "完整更新"
	if b.UpdateMode == "append" {
		mode = "附加更新"
	}
	counts := func(parts ...any) string {
		var out []string
		for i := 0; i < len(parts); i += 2 {
			if n := parts[i+1].(int); n > 0 {
				out = append(out, fmt.Sprintf("%s %d", parts[i], n))
			}
		}
		return strings.Join(out, " · ")
	}
	fetched := max(b.Complete-b.Reused, 0)
	// Profiles' posts finish after the profiles themselves.
	posts := func(m domain.MemberProgress, done bool) string {
		if done {
			return counts("已保存", m.Complete, "不完整", m.Partial, "失败", m.Failed)
		}
		// The total is known once a listing is fetched, before its posts run.
		if m.Total == 0 {
			return ""
		}
		finished := m.Complete + m.Partial + m.Failed
		text := fmt.Sprintf("%d/%d", finished, max(m.Total, finished+m.Pending))
		if c := counts("抓取中", m.Pending, "已保存", m.Complete, "不完整", m.Partial, "失败", m.Failed); c != "" {
			text += " · " + c
		}
		return text
	}
	summary := ""
	if p := posts(b.Members, b.Done); p != "" {
		summary = "\n帖子：" + p
	}
	switch {
	case b.State == "failed" && b.Done:
		reason := "采集服务不可用"
		if b.Error == "storage quota exceeded" {
			reason = "存储空间不足"
		}
		return fmt.Sprintf("批量%s已中止：%s\n已提交 %d/%d", mode, reason, b.Submitted, b.Total) + summary
	case !b.Done:
		text := fmt.Sprintf("批量%s中…\n已提交 %d/%d", mode, b.Submitted, b.Total)
		if c := counts("抓取中", b.Running, "已抓取", fetched, "无变化", b.Reused, "失败", b.Failed); c != "" {
			text += " · " + c
		}
		text += summary
		if len(b.Active) > 0 {
			text += "\n\n进行中："
		}
		for i, item := range b.Active {
			if i == maxBatchItems {
				text += fmt.Sprintf("\n另有 %d 项", len(b.Active)-i)
				break
			}
			var parts []string
			if item.Running {
				parts = append(parts, "抓取中")
			}
			if p := posts(item.Members, false); p != "" {
				parts = append(parts, "帖子 "+p)
			} else if !item.Running {
				parts = append(parts, "提交帖子中")
			}
			text += fmt.Sprintf("\n• %s：%s", strings.TrimPrefix(strings.TrimPrefix(item.URL, "https://"), "http://"), strings.Join(parts, " · "))
		}
		return text
	}
	text := fmt.Sprintf("批量%s完成，共 %d 项", mode, b.Total)
	if c := counts("已抓取", fetched, "无变化", b.Reused, "不完整", b.Partial, "失败", b.Failed, "无法更新", b.Rejected); c != "" {
		text += "\n" + c
	}
	return text + summary
}

func collectionProgressMessage(id string, d channelapi.Delivery, webURL string) (string, telegram.Keyboard) {
	c := d.ProgressDetails
	text := fmt.Sprintf("正在采集…\n%s\n\n本次 %d 项：已保存 %d · 内容不完整 %d · 失败 %d · 进行中 %d", c.URL, c.Total, c.Complete, c.Partial, c.Failed, max(0, c.Total-c.Complete-c.Partial-c.Failed))
	if c.Done {
		text = strings.Replace(text, "正在采集…", "采集完成", 1)
	}
	if c.Stopped {
		text = strings.Replace(text, "采集完成", "采集已中止", 1)
		text = strings.Replace(text, "正在采集…", "采集已中止", 1)
	}
	if d.Job.State == "failed" {
		text = "帖子列表获取失败\n输入：" + d.Input + "\n" + failureReason(d.Job.Error)
	}
	if c.Error != "" {
		text += "\n部分页面获取失败。"
	}
	if len(c.Reasons) > 0 {
		text += "\n\n未完整保存原因："
		for i, reason := range c.Reasons {
			if i == 8 {
				text += fmt.Sprintf("\n另有 %d 类原因。", len(c.Reasons)-i)
				break
			}
			message := []rune(failureReason(reason.Reason))
			if len(message) > 180 {
				message = append(message[:180], '…')
			}
			text += fmt.Sprintf("\n• %s（%d 条）", string(message), reason.Count)
		}
	}
	keys := telegram.Keyboard{{{Text: "在 X 查看主页", URL: c.URL}}}
	if !c.Stopped && c.Done && c.Next != "" {
		keys = append(keys, []telegram.Button{{Text: "抓取更多", Data: "/more " + id}})
		if c.MaxBatch >= 1000 {
			keys = append(keys, []telegram.Button{{Text: "抓取1000条", Data: "/more1000 " + id}})
		}
	}
	if !c.Stopped && c.Done && (c.Error != "" || d.Job.State == "failed" || d.Job.State == "partial") {
		keys = append(keys, []telegram.Button{{Text: "重试本页", Data: "/page_retry " + id}})
	}
	if !c.Done && !c.Stopped {
		keys = append(keys, []telegram.Button{{Text: "中止", Data: "/collection_stop " + id}})
	}
	keys = append(keys, []telegram.Button{{Text: "查看已保存资料", Data: "/show " + c.CollectionID}}, []telegram.Button{{Text: "收藏列表", Data: "/list"}})
	return text, appendMiniAppButton(keys, c.CollectionID, webURL)
}
