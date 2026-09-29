package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"monitor/internal/domain"
	"monitor/internal/store"
	"monitor/internal/telegram"
)

// Collection reports are task progress, never archive content messages.
// Callers hold the submission lock across sending and persisting message IDs.
func (s *Service) collectionProgress(ctx context.Context, task store.Task) (bool, error) {
	var collection, batchPending, batchFailed, stopped bool
	var maxBatch, limit int
	var cid, state, expansion, problem, next, url, chat, channel, last, archive, captureError, input string
	var mid, replyTo int64
	var total, complete, partial, failed, pending int
	err := s.DB.Tx(ctx, task.Tenant, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `SELECT s.collection_stopped,c.is_collection AND s.related_state<>'none',c.id,c.state,s.related_state,s.related_error,c.next_page_cursor,a.url,s.chat_id,s.channel_id,s.message_id,s.reply_to_message_id,s.status_text,a.id,c.error,coalesce(nullif(s.input,''),a.url),s.collection_limit,CASE WHEN jsonb_typeof(c.related_targets)='array' THEN jsonb_array_length(c.related_targets) ELSE 0 END FROM submissions s JOIN captures c ON c.id=s.capture_id JOIN archives a ON a.id=c.archive_id WHERE s.id=$1`, task.ID).Scan(&stopped, &collection, &cid, &state, &expansion, &problem, &next, &url, &chat, &channel, &mid, &replyTo, &last, &archive, &captureError, &input, &limit, &total); err != nil {
			return err
		}
		if !collection {
			return nil
		}
		return tx.QueryRow(ctx, collectionChainSQL+`
 , jobs AS (SELECT DISTINCT child.capture_id FROM submissions child JOIN pages ON child.idem_key LIKE 'related:'||pages.id::text||':%')
 SELECT (SELECT count(*) FROM jobs JOIN captures c ON c.id=jobs.capture_id WHERE c.state='complete'),
 (SELECT count(*) FROM jobs JOIN captures c ON c.id=jobs.capture_id WHERE c.state='partial'),
 (SELECT count(*) FROM jobs JOIN captures c ON c.id=jobs.capture_id WHERE c.state='failed'),
 (SELECT count(*) FROM jobs JOIN captures c ON c.id=jobs.capture_id WHERE c.state IN('queued','downloading')),
 (SELECT count(DISTINCT target->>'url') FROM pages JOIN captures c ON c.id=pages.capture_id CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.related_targets)='array' THEN c.related_targets ELSE '[]' END) target),
 EXISTS(SELECT FROM pages JOIN captures c ON c.id=pages.capture_id WHERE c.state IN('queued','downloading') OR (c.state<>'failed' AND pages.related_state='pending')),
 EXISTS(SELECT FROM pages JOIN captures c ON c.id=pages.capture_id WHERE c.state IN('failed','partial') OR pages.related_state='failed'),
 (SELECT c.next_page_cursor FROM pages JOIN captures c ON c.id=pages.capture_id ORDER BY depth DESC LIMIT 1),
 (SELECT c.max_batch_size FROM pages JOIN captures c ON c.id=pages.capture_id ORDER BY depth DESC LIMIT 1)
 `, task.ID).Scan(&complete, &partial, &failed, &pending, &total, &batchPending, &batchFailed, &next, &maxBatch)
	})
	if err != nil || !collection {
		return collection, err
	}
	done := state == "failed" || ((state == "complete" || state == "partial") && !batchPending && pending == 0)
	text := "正在获取帖子列表…\n" + url
	if state == "complete" || state == "partial" {
		text = fmt.Sprintf("正在保存帖子…\n%s\n\n本次 %d 条：已保存 %d · 部分保存 %d · 失败 %d · 待完成 %d", url, total, complete, partial, failed, max(0, total-complete-partial-failed))
		if done {
			text = strings.Replace(text, "正在保存帖子…", "帖子抓取完成", 1)
		}
		a, e := s.CaptureArchive(ctx, task.Tenant, cid)
		if e != nil {
			return true, e
		}
		if len(a.Warnings) > 0 {
			text += "\n\n" + strings.Join(a.Warnings, "\n")
		}
	}
	if state == "failed" {
		text = "帖子列表获取失败\n输入：" + input + "\n\n" + captureError
	}
	if batchFailed {
		if problem == "" {
			problem = "部分页面获取失败，可重试继续。"
		}
		text += "\n\n采集已停止：" + problem
	}
	if limit > 0 {
		text += fmt.Sprintf("\n\n本次目标：约 %d 条", limit)
	}
	if !done && batchPending && complete+partial+failed == total {
		text += "\n正在获取后续页面…"
	}
	if stopped {
		done = !batchPending && pending == 0
		title := "正在中止抓取…"
		if done {
			title = "帖子抓取已中止"
		}
		text = fmt.Sprintf("%s\n%s\n\n已保存 %d · 部分保存 %d · 失败 %d · 收尾中 %d\n已保存的帖子会保留。", title, url, complete, partial, failed, pending)
	}
	buttons := telegram.Keyboard{{{Text: "查看主页", URL: url}}}
	if !stopped && done && next != "" && state != "failed" {
		buttons = append(buttons, []telegram.Button{{Text: "抓取更多", Data: "/more " + task.ID}})
	}
	if !stopped && done && next != "" && maxBatch >= 1000 {
		buttons = append(buttons, []telegram.Button{{Text: "抓取1000条", Data: "/more1000 " + task.ID}})
	}
	if !stopped && done && (state == "failed" || state == "partial" || batchFailed) {
		buttons = append(buttons, []telegram.Button{{Text: "重试本页", Data: "/page_retry " + task.ID}})
	}
	if !done && !stopped {
		buttons = append(buttons, []telegram.Button{{Text: "中止", Data: "/collection_stop " + task.ID}})
	}
	buttons = append(buttons, []telegram.Button{{Text: "查看 Profile", Data: "/show " + archive}}, []telegram.Button{{Text: "归档列表", Data: "/list"}})
	sender := s.replySender(channel, replyTo)
	if sender == nil {
		return true, fmt.Errorf("channel sender unavailable")
	}
	if text != last || mid == 0 || done {
		id, e := sendInteractive(ctx, sender, chat, text, mid, buttons)
		if e != nil {
			return true, telegramError(e)
		}
		if e = s.DB.Tx(ctx, task.Tenant, func(tx pgx.Tx) error {
			_, e := tx.Exec(ctx, `UPDATE submissions SET message_id=$2,status_text=$3,state=CASE WHEN $4 THEN 'sent' ELSE state END WHERE id=$1`, task.ID, id, text, done)
			return e
		}); e != nil {
			return true, e
		}
	}
	if !done {
		return true, river.JobSnooze(5 * time.Second)
	}
	return true, nil
}

func (s *Service) commandMore(ctx context.Context, r *commandRequest) error {
	return s.collectionPage(ctx, r, false, 0)
}

func (s *Service) commandPageRetry(ctx context.Context, r *commandRequest) error {
	return s.collectionPage(ctx, r, true, 0)
}

func (s *Service) collectionPage(ctx context.Context, r *commandRequest, retry bool, limit uint32) error {
	var url, provider, connection, cursor string
	var maxBatch, remaining, pageSize uint32
	err := s.DB.Tx(ctx, r.Task.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, collectionChainSQL+` SELECT a.url,p.related_provider,coalesce(p.related_connection::text,''),CASE WHEN $2 THEN c.page_cursor ELSE c.next_page_cursor END,c.max_batch_size,p.collection_limit,c.page_size FROM pages p JOIN captures c ON c.id=p.capture_id JOIN archives a ON a.id=c.archive_id JOIN tenant_archives owned ON owned.archive_id=a.id WHERE c.is_collection AND EXISTS(SELECT FROM submissions WHERE id=$1 AND state='sent' AND related_state<>'none') ORDER BY depth DESC LIMIT 1`, r.Argument, retry).Scan(&url, &provider, &connection, &cursor, &maxBatch, &remaining, &pageSize)
	})
	if err != nil {
		return err
	}
	if !retry && limit > maxBatch {
		return domain.ErrUnsupported
	}
	if cursor == "" && !retry {
		r.Text = "没有更多帖子了。"
		return nil
	}
	if retry {
		limit = remaining
	} else {
		pageSize = limit
	}
	key := "more:" + r.Argument
	if retry {
		key = "page-retry:" + r.Task.ID
	}
	_, err = s.Submit(ctx, r.Task.Tenant, domain.CaptureInput{URL: url, ProviderID: provider, ConnectionID: connection, PageCursor: cursor, PageSize: pageSize, CollectionLimit: limit, Key: key, Origin: r.Origin})
	return err
}

func (s *Service) commandMore1000(ctx context.Context, r *commandRequest) error {
	return s.collectionPage(ctx, r, false, 1000)
}

const collectionChainSQL = `WITH RECURSIVE pages AS (
 SELECT s.*,0 AS depth FROM submissions s WHERE id=$1
 UNION ALL SELECT s.*,p.depth+1 FROM submissions s JOIN pages p ON s.id=p.next_submission WHERE p.depth<1000
)`

var errCollectionStopped = errors.New("collection stopped")

func (s *Service) commandCollectionStop(ctx context.Context, r *commandRequest) error {
	err := s.DB.Tx(ctx, r.Task.Tenant, func(tx pgx.Tx) error {
		if err := lockTenant(ctx, tx, r.Task.Tenant); err != nil {
			return err
		}
		var collection bool
		if err := tx.QueryRow(ctx, `SELECT c.is_collection FROM submissions s JOIN captures c ON c.id=s.capture_id WHERE s.id=$1`, r.Argument).Scan(&collection); err != nil {
			return err
		}
		if !collection {
			return domain.ErrUnsupported
		}
		// The tenant lock also guards Submit, so no new descendants can escape this checkpoint.
		_, err := tx.Exec(ctx, `WITH RECURSIVE stopped AS (
            SELECT id,next_submission FROM submissions WHERE id=$1
            UNION SELECT s.id,s.next_submission FROM submissions s JOIN stopped p ON s.parent_submission=p.id OR s.id=p.next_submission OR s.idem_key='batch:'||p.id::text
        ) UPDATE submissions SET collection_stopped=true,related_state=CASE WHEN related_state='pending' THEN 'complete' ELSE related_state END WHERE id IN(SELECT id FROM stopped)`, r.Argument)
		if err != nil {
			return err
		}
		return s.Enqueue(ctx, tx, r.Task.Tenant, r.Argument, "status")
	})
	if err == nil {
		r.Text = "已中止后续抓取。已提交的任务会完成收尾，已保存内容保留。"
	}
	return err
}
