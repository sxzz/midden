package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/channelapi"
	"monitor/internal/domain"
)

func enqueueChannel(ctx context.Context, tx pgx.Tx, tenant, id string) error {
	_, e := tx.Exec(ctx, `INSERT INTO channel_work(tenant_id,channel_id,kind,resource) SELECT $1,channel_id,'delivery',$2 FROM submissions WHERE id=$2::text::uuid AND channel_id IS NOT NULL ON CONFLICT(channel_id,kind,resource) DO UPDATE SET available_at=least(channel_work.available_at,now()) WHERE channel_work.state='pending'`, tenant, id)
	return e
}

func (s *Service) ChannelConfig(ctx context.Context, channel string) (v channelapi.Config, e error) {
	e = s.DB.Pool.QueryRow(ctx, `SELECT c.external_id,c.next_offset,t.value,w.value FROM channels c JOIN config t ON t.key='telegram_bot_token' JOIN config w ON w.key='web_app_url' JOIN config k ON k.key='telegram_channel_id' AND k.value=c.id::text WHERE c.id=$1 AND c.kind='telegram'`, channel).Scan(&v.BotID, &v.Offset, &v.Token, &v.WebURL)
	return
}

func (s *Service) ChannelEvent(ctx context.Context, channel string, in channelapi.Event) (bool, error) {
	if in.UpdateID < 0 {
		return false, fmt.Errorf("invalid update")
	}
	// Ignored Telegram updates still advance the durable polling offset.
	if in.Actor == "" {
		_, e := s.DB.Pool.Exec(ctx, `UPDATE channels SET next_offset=greatest(next_offset,$2) WHERE id=$1`, channel, in.UpdateID+1)
		return false, e
	}
	actor, e := strconv.ParseInt(in.Actor, 10, 64)
	if e != nil || actor <= 0 {
		return false, fmt.Errorf("invalid actor")
	}
	if _, e = strconv.ParseInt(in.Chat, 10, 64); e != nil {
		return false, fmt.Errorf("invalid chat")
	}
	identity, e := s.DB.Resolve(ctx, channel, in.Actor, s.Config.Quota)
	if e != nil {
		return false, e
	}
	id := uuid.NewSHA1(uuid.NameSpaceOID, []byte("channel-event:"+channel+":"+strconv.FormatInt(in.UpdateID, 10))).String()
	in.Ciphertext, in.Flow, in.Problem = nil, "", ""
	in.Sensitive, in.Protected = false, false
	secret := in.Credential != ""
	// Establish a dialog at ingress so a credential in the same polling batch
	// cannot overtake the queued prompt.
	promptAdapter := ""
	if in.Private && in.Command == "account_add" && !secret {
		list, err := s.channelAccounts(ctx, identity.TenantID)
		if err != nil {
			return false, err
		}
		selected := in.Adapter
		if selected == "" && len(list.Platforms) == 1 {
			selected = list.Platforms[0].ID
		}
		for _, p := range list.Platforms {
			if p.ID == selected && p.CanAdd {
				promptAdapter = p.ID
				in.Adapter = p.ID
			}
		}
	}
	e = s.DB.Tx(ctx, identity.TenantID, func(tx pgx.Tx) error {
		if err := lockTenant(ctx, tx, identity.TenantID); err != nil {
			return err
		}
		var previous []byte
		err := tx.QueryRow(ctx, `SELECT payload FROM channel_work WHERE channel_id=$1 AND kind='event' AND resource=$2`, channel, strconv.FormatInt(in.UpdateID, 10)).Scan(&previous)
		if err == nil {
			var old channelapi.Event
			_ = json.Unmarshal(previous, &old)
			secret = secret || old.Sensitive || len(old.Ciphertext) > 0
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if in.Private && in.CallbackID != "" {
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM submissions WHERE channel_id=$1 AND chat_id=$2 AND message_id=$3)`, channel, in.Chat, in.MessageID).Scan(&in.Protected); err != nil {
				return err
			}
		}
		if !in.Private && in.CallbackID != "" && in.Command != "save_shared" {
			var allowed bool
			err := tx.QueryRow(ctx, `SELECT EXISTS(
 SELECT FROM submissions WHERE channel_id=$1 AND chat_id=$2 AND message_id=$3 AND identity_id=$4
 UNION ALL SELECT FROM channel_work WHERE channel_id=$1 AND kind='event' AND message_id=$3 AND payload->>'chat'=$2 AND payload->>'actor'=$5
 UNION ALL SELECT FROM replies r JOIN inbox i ON i.id=r.inbox_id WHERE i.channel_id=$1 AND r.chat_id=$2 AND r.message_id=$3 AND coalesce(i.payload#>>'{callback_query,from,id}',i.payload#>>'{message,from,id}')=$5
 )`, channel, in.Chat, in.MessageID, identity.ID, in.Actor).Scan(&allowed)
			if err != nil {
				return err
			}
			if !allowed {
				in.Problem = "foreign_message"
			}
		}
		if promptAdapter != "" {
			in.Flow = id
			if _, err := tx.Exec(ctx, `INSERT INTO account_dialogs(tenant_id,identity_id,chat_id,flow_id,adapter_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes') ON CONFLICT(tenant_id,identity_id,chat_id) DO UPDATE SET flow_id=excluded.flow_id,adapter_id=excluded.adapter_id,expires_at=excluded.expires_at`, identity.TenantID, identity.ID, in.Chat, id, promptAdapter); err != nil {
				return err
			}
		}
		if in.Private && in.Command == "account_cancel" {
			if _, err := tx.Exec(ctx, `DELETE FROM account_dialogs WHERE identity_id=$1 AND chat_id=$2`, identity.ID, in.Chat); err != nil {
				return err
			}
		}
		if in.Private && in.Command == "" {
			var adapter, flow string
			var expired bool
			err := tx.QueryRow(ctx, `SELECT adapter_id,flow_id,expires_at<=now() FROM account_dialogs WHERE identity_id=$1 AND chat_id=$2`, identity.ID, in.Chat).Scan(&adapter, &flow, &expired)
			if err == nil {
				in.Command = "account_add"
				in.Adapter = adapter
				in.Flow = flow
				in.Credential = in.Text
				in.Text = ""
				in.URLs = nil
				secret = true
				if expired {
					in.Problem = "dialog_expired"
					in.Credential = ""
				}
			}
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
		if in.Credential != "" {
			secret = true
			if !in.Private || s.Vault == nil {
				in.Problem = "credentials_unavailable"
			} else {
				ciphertext, err := s.Vault.Seal(identity.TenantID, id, &pb.Credential{Data: []byte(in.Credential)})
				if err != nil {
					in.Problem = "invalid_credentials"
				} else {
					in.Ciphertext = ciphertext
				}
			}
			in.Credential = ""
			in.Text = ""
			in.Argument = ""
			in.URLs = nil
		}
		in.Sensitive = secret
		raw, err := json.Marshal(in)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO channel_work(id,tenant_id,channel_id,kind,resource,payload) VALUES($1,$2,$3,'event',$4,$5) ON CONFLICT DO NOTHING`, id, identity.TenantID, channel, strconv.FormatInt(in.UpdateID, 10), raw); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE channels SET next_offset=greatest(next_offset,$2) WHERE id=$1`, channel, in.UpdateID+1)
		return err
	})
	return secret, e
}

func (s *Service) ClaimChannel(ctx context.Context, channel string) (*channelapi.Work, error) {
	var w channelapi.Work
	e := s.DB.Pool.QueryRow(ctx, `SELECT id,lease,kind,resource,payload,progress,message_id,created_at FROM claim_channel_work($1)`, channel).Scan(&w.ID, &w.Lease, &w.Kind, &w.Resource, &w.Payload, &w.Progress, &w.MessageID, &w.CreatedAt)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	return &w, e
}

func (s *Service) ChannelTenant(ctx context.Context, channel, id, lease string) (string, error) {
	var tenant *string
	e := s.DB.Pool.QueryRow(ctx, `SELECT channel_work_tenant($1,$2,$3)`, channel, id, lease).Scan(&tenant)
	if e != nil {
		return "", e
	}
	if tenant == nil {
		return "", domain.ErrNotFound
	}
	return *tenant, nil
}

func (s *Service) AckChannel(ctx context.Context, channel, id string, a channelapi.Ack) error {
	tenant, e := s.ChannelTenant(ctx, channel, id, a.Lease)
	if e != nil {
		return e
	}
	return s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		var kind, resource, state string
		if e := tx.QueryRow(ctx, `SELECT kind,resource,state FROM channel_work WHERE id=$1 AND lease=$2 FOR UPDATE`, id, a.Lease).Scan(&kind, &resource, &state); e != nil {
			return e
		}
		if state != "pending" {
			return nil
		}
		next := "pending"
		if a.Done {
			next = "done"
		}
		if a.Permanent {
			next = "failed"
		}
		if a.Progress < 0 || a.RetrySeconds < 0 || a.RetrySeconds > 86400 {
			return fmt.Errorf("invalid acknowledgement")
		}
		// A zero delay renews the lease and records a delivery checkpoint.
		_, e := tx.Exec(ctx, `UPDATE channel_work SET state=$3,progress=greatest(progress,$4),message_id=$5,lease_until=CASE WHEN $6>0 THEN NULL ELSE now()+interval '90 seconds' END,available_at=now()+$6*interval '1 second',payload=CASE WHEN $3 IN ('done','failed') AND kind='event' THEN jsonb_build_object('sensitive',coalesce((payload->>'sensitive')::boolean,false),'actor',payload->'actor','chat',payload->'chat') ELSE payload END WHERE id=$1 AND lease=$2`, id, a.Lease, next, a.Progress, a.MessageID, a.RetrySeconds)
		if e != nil {
			return e
		}
		if kind == "delivery" {
			_, e = tx.Exec(ctx, `UPDATE submissions SET progress=greatest(progress,$2),message_id=$3,state=CASE WHEN $4 THEN 'sent' WHEN $5 THEN 'failed' ELSE state END WHERE id=$1`, resource, a.Progress, a.MessageID, a.Done, a.Permanent)
		}
		if kind == "reply" {
			_, e = tx.Exec(ctx, `UPDATE replies SET progress=greatest(progress,$2),message_id=$3,state=CASE WHEN $4 THEN 'sent' WHEN $5 THEN 'failed' ELSE state END WHERE id=$1`, resource, a.Progress, a.MessageID, a.Done, a.Permanent)
		}
		if kind == "event" && a.Done {
			_, e = tx.Exec(ctx, `UPDATE inbox SET state='processed',payload=payload-'account_import' WHERE id=$1`, id)
		}
		return e
	})
}

func (s *Service) ChannelWork(ctx context.Context, channel, id, lease string) (string, channelapi.Work, error) {
	tenant, e := s.ChannelTenant(ctx, channel, id, lease)
	var w channelapi.Work
	if e != nil {
		return "", w, e
	}
	e = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT id,lease,kind,resource,payload,progress,message_id,created_at FROM channel_work WHERE id=$1 AND lease=$2 AND state='pending' AND lease_until>now()`, id, lease).Scan(&w.ID, &w.Lease, &w.Kind, &w.Resource, &w.Payload, &w.Progress, &w.MessageID, &w.CreatedAt)
	})
	return tenant, w, e
}

// Delivery payloads contain saved data and progress, never Telegram markup.
func (s *Service) ChannelDelivery(ctx context.Context, channel, id, lease string) (channelapi.Delivery, error) {
	tenant, w, e := s.ChannelWork(ctx, channel, id, lease)
	var d channelapi.Delivery
	if e != nil {
		return d, e
	}
	if w.Kind == "reply" {
		e = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT r.chat_id,r.reply_to_message_id,to_jsonb(r),EXISTS(SELECT FROM submissions s WHERE s.channel_id=$2 AND s.chat_id=r.chat_id AND s.message_id=r.message_id) FROM replies r WHERE id=$1`, w.Resource, channel).Scan(&d.Chat, &d.ReplyTo, &d.Legacy, &d.Protected)
		})
		return d, e
	}
	if w.Kind != "delivery" {
		return d, domain.ErrNotFound
	}
	var capture string
	var collection bool
	e = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT s.capture_id,s.chat_id,s.reply_to_message_id,s.state,s.input,s.status_text,c.paused,c.is_collection AND s.related_state<>'none' FROM submissions s JOIN captures c ON c.id=s.capture_id WHERE s.id=$1`, w.Resource).Scan(&capture, &d.Chat, &d.ReplyTo, &d.State, &d.Input, &d.LastText, &d.Paused, &collection)
	})
	if e != nil {
		return d, e
	}
	d.Job, e = s.Job(ctx, tenant, capture)
	if e != nil {
		return d, e
	}
	if d.Job.State == "complete" || d.Job.State == "partial" {
		a, err := s.CaptureCollection(ctx, tenant, capture)
		if err != nil {
			return d, err
		}
		d.Collection = &a
	}
	if collection {
		d.ProgressDetails, e = s.channelCollection(ctx, tenant, w.Resource)
	}
	return d, e
}

func (s *Service) channelCollection(ctx context.Context, tenant, id string) (*channelapi.CollectionProgress, error) {
	c := &channelapi.CollectionProgress{}
	var batchPending, batchFailed bool
	var state string
	e := s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, collectionChainSQL+`,jobs AS (SELECT DISTINCT child.capture_id FROM submissions child JOIN pages ON child.idem_key LIKE 'related:'||pages.id::text||':%')
 SELECT (SELECT a.url FROM pages p JOIN captures c ON c.id=p.capture_id JOIN collections a ON a.id=c.collection_id ORDER BY depth LIMIT 1),
 (SELECT c.collection_id FROM pages p JOIN captures c ON c.id=p.capture_id ORDER BY depth LIMIT 1),
 (SELECT c.state FROM pages p JOIN captures c ON c.id=p.capture_id ORDER BY depth LIMIT 1),
 (SELECT count(*) FROM jobs JOIN captures c ON c.id=jobs.capture_id WHERE c.state='complete'),
 (SELECT count(*) FROM jobs JOIN captures c ON c.id=jobs.capture_id WHERE c.state='partial'),
 (SELECT count(*) FROM jobs JOIN captures c ON c.id=jobs.capture_id WHERE c.state='failed'),
 (SELECT count(*) FROM jobs JOIN captures c ON c.id=jobs.capture_id WHERE c.state IN ('queued','downloading')),
 (SELECT count(DISTINCT target->>'url') FROM pages JOIN captures c ON c.id=pages.capture_id CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.related_targets)='array' THEN c.related_targets ELSE '[]' END) target),
 EXISTS(SELECT FROM pages JOIN captures c ON c.id=pages.capture_id WHERE c.state IN ('queued','downloading') OR (c.state<>'failed' AND pages.related_state='pending')),
 EXISTS(SELECT FROM pages JOIN captures c ON c.id=pages.capture_id WHERE c.state IN ('failed','partial') OR pages.related_state='failed'),
 (SELECT c.next_page_cursor FROM pages JOIN captures c ON c.id=pages.capture_id ORDER BY depth DESC LIMIT 1),
 (SELECT c.max_batch_size FROM pages JOIN captures c ON c.id=pages.capture_id ORDER BY depth DESC LIMIT 1),
 EXISTS(SELECT FROM pages WHERE collection_stopped)
 `, id).Scan(&c.URL, &c.CollectionID, &state, &c.Complete, &c.Partial, &c.Failed, &c.Pending, &c.Total, &batchPending, &batchFailed, &c.Next, &c.MaxBatch, &c.Stopped)
	})
	c.Done = state == "failed" || ((state == "complete" || state == "partial") && !batchPending && c.Pending == 0)
	if batchFailed {
		c.Error = "partial_pages"
	}
	return c, e
}
