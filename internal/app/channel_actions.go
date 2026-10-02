package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
	"monitor/internal/channelapi"
	"monitor/internal/domain"
	"monitor/internal/store"
)

// ChannelAction exposes business operations, independent of Telegram rendering.
// The event supplies the actor; callers cannot substitute a tenant ID.
func (s *Service) ChannelAction(ctx context.Context, channel string, in channelapi.Action) (channelapi.Result, error) {
	var result channelapi.Result
	tenant, w, e := s.ChannelWork(ctx, channel, in.WorkID, in.Lease)
	if e != nil {
		return result, e
	}
	if w.Kind != "event" {
		return result, domain.ErrNotFound
	}
	var event channelapi.Event
	if e = json.Unmarshal(w.Payload, &event); e != nil {
		return result, e
	}
	if event.Problem == "foreign_message" {
		return result, domain.ErrNotFound
	}
	// Legacy inputs are normalized by the new channel before calling this endpoint.
	if event.Actor == "" {
		return result, domain.ErrNotFound
	}
	identity, e := s.DB.Resolve(ctx, channel, event.Actor, s.Config.Quota)
	if e != nil {
		return result, e
	}
	origin := domain.Origin{IdentityID: identity.ID, ChannelID: channel, ChatID: event.Chat}
	if !event.Private {
		origin.ReplyToMessageID = event.MessageID
	}
	var cached []byte
	e = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT result FROM channel_work WHERE id=$1`, w.ID).Scan(&cached)
	})
	if e != nil {
		return result, e
	}
	if len(cached) > 0 && string(cached) != "null" {
		e = json.Unmarshal(cached, &result)
		return result, e
	}
	arg := event.Argument
	switch in.Name {
	case "status", "show", "save_shared", "refresh", "retry", "delete", "more", "more1000", "page_retry", "collection_stop":
		if _, err := uuid.Parse(arg); err != nil {
			return result, domain.ErrNotFound
		}
	}
	switch in.Name {
	case "list":
		p, err := s.Recent(ctx, tenant, arg)
		result.Page = &p
		e = err
	case "usage":
		v, err := s.Usage(ctx, tenant)
		result.Usage = &v
		e = err
	case "status":
		j, err := s.Job(ctx, tenant, arg)
		result.Job = &j
		e = err
	case "show":
		a, err := s.Collection(ctx, tenant, arg)
		if err != nil {
			return result, err
		}
		e = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
			var id string
			err := tx.QueryRow(ctx, `INSERT INTO submissions(tenant_id,capture_id,identity_id,channel_id,chat_id,idem_key,fingerprint,reply_to_message_id) SELECT $1,capture_id,$3,$4,$5,$6,$6,$7 FROM revisions WHERE id=$2 ON CONFLICT(tenant_id,idem_key) DO UPDATE SET idem_key=excluded.idem_key RETURNING id`, tenant, a.RevisionID, origin.IdentityID, channel, origin.ChatID, "show:"+w.ID, origin.ReplyToMessageID).Scan(&id)
			if err != nil {
				return err
			}
			return enqueueChannel(ctx, tx, tenant, id)
		})
	case "save_shared":
		_, e = s.SavePublicCollection(ctx, tenant, arg)
		result.Code = "saved"
	case "save":
		seen := map[string]bool{}
		if len(event.URLs) > 200 {
			return result, domain.ErrUnsupported
		}
		for _, raw := range event.URLs {
			target, err := s.Resolve(ctx, raw)
			if err != nil {
				continue
			}
			key := target.Platform + "|" + target.Kind + "|" + target.ObjectScope + "|" + target.ExternalID
			if seen[key] {
				continue
			}
			seen[key] = true
			connection, err := s.connectionForURL(ctx, tenant, target.URL)
			if err != nil {
				return result, err
			}
			_, err = s.Submit(ctx, tenant, domain.CaptureInput{URL: target.URL, Input: raw, ConnectionID: connection, Key: w.ID + ":" + store.Hash(key), Origin: origin})
			if err != nil {
				result.Errors = append(result.Errors, safeError(err))
			} else {
				result.Count++
			}
		}
	case "refresh", "retry":
		var url, state string
		e = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT a.url,coalesce((SELECT c.state FROM captures c WHERE c.collection_id=a.id AND (c.tenant_id=$2 OR EXISTS(SELECT FROM submissions s WHERE s.capture_id=c.id AND s.tenant_id=$2)) ORDER BY c.created_at DESC,c.id DESC LIMIT 1),'') FROM collections a JOIN tenant_collections t ON t.collection_id=a.id WHERE a.id=$1`, arg, tenant).Scan(&url, &state)
		})
		if e != nil {
			return result, e
		}
		capture := domain.CaptureInput{RefreshID: arg, Key: "refresh:" + w.ID, Origin: origin}
		if in.Name == "retry" || state == "failed" {
			connection, err := s.connectionForURL(ctx, tenant, url)
			if err != nil {
				return result, err
			}
			capture = domain.CaptureInput{URL: url, Input: url, ConnectionID: connection, Key: "retry:" + w.ID, Origin: origin}
		}
		j, err := s.Submit(ctx, tenant, capture)
		result.Job = &j
		e = err
	case "delete":
		e = s.DeleteCollection(ctx, tenant, arg)
		if errors.Is(e, domain.ErrNotFound) {
			e = nil
		}
		result.Code = "deleted"
	case "delete_all":
		if arg != "confirm" {
			result.Code = "confirm_delete_all"
			break
		}
		result.Count, e = s.DeleteAllCollections(ctx, tenant, w.CreatedAt)
		result.Code = "deleted_all"
	case "collection_stop":
		e = s.StopCollection(ctx, tenant, arg)
		result.Code = "collection_stopped"
	case "more", "more1000", "page_retry":
		result, e = s.channelPage(ctx, tenant, origin, w.ID, arg, in.Name)
	case "account", "account_delete":
		if !event.Private && in.Name != "account" {
			return result, domain.ErrUnsupported
		}
		result, e = s.channelAccount(ctx, tenant, event, in.Name)
	default:
		return result, domain.ErrUnsupported
	}
	if e != nil {
		return result, e
	}
	raw, e := json.Marshal(result)
	if e != nil {
		return result, e
	}
	e = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE channel_work SET result=$2 WHERE id=$1 AND lease=$3`, w.ID, raw, w.Lease)
		return err
	})
	return result, e
}

func (s *Service) channelPage(ctx context.Context, tenant string, origin domain.Origin, key, id, op string) (channelapi.Result, error) {
	var out channelapi.Result
	var url, provider, connection, cursor string
	var maxBatch, remaining, pageSize uint32
	retry := op == "page_retry"
	var limit uint32
	if op == "more1000" {
		limit = 1000
	}
	e := s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, collectionChainSQL+` SELECT a.url,p.related_provider,coalesce(p.related_connection::text,''),CASE WHEN $2 THEN c.page_cursor ELSE c.next_page_cursor END,c.max_batch_size,p.collection_limit,c.page_size FROM pages p JOIN captures c ON c.id=p.capture_id JOIN collections a ON a.id=c.collection_id JOIN tenant_collections owned ON owned.collection_id=a.id WHERE c.is_collection AND EXISTS(SELECT FROM submissions WHERE id=$1 AND state='sent' AND related_state<>'none') ORDER BY depth DESC LIMIT 1`, id, retry).Scan(&url, &provider, &connection, &cursor, &maxBatch, &remaining, &pageSize)
	})
	if e != nil {
		return out, e
	}
	if !retry && limit > maxBatch {
		return out, domain.ErrUnsupported
	}
	if cursor == "" && !retry {
		out.Code = "no_more"
		return out, nil
	}
	if retry {
		limit = remaining
	} else {
		pageSize = limit
	}
	idem := "more:" + id
	if retry {
		idem = "page-retry:" + key
	}
	_, e = s.Submit(ctx, tenant, domain.CaptureInput{URL: url, ProviderID: provider, ConnectionID: connection, PageCursor: cursor, PageSize: pageSize, CollectionLimit: limit, Key: idem, Origin: origin})
	return out, e
}

func (s *Service) channelAccounts(ctx context.Context, tenant string) (channelapi.AccountList, error) {
	out := channelapi.AccountList{Accounts: []channelapi.Account{}, Platforms: []channelapi.Platform{}}
	ids := s.adapterIDs()
	if len(ids) == 0 && s.Registry == nil && s.Adapter != nil {
		d, e := s.descriptor(ctx)
		if e != nil {
			return out, e
		}
		ids = []string{d.AdapterId}
	}
	for _, id := range ids {
		scoped, e := s.forAdapter(id)
		if e != nil {
			continue
		}
		d, e := scoped.descriptor(ctx)
		if e != nil {
			continue
		}
		p := channelapi.Platform{ID: id, Name: adapterDisplayName(d)}
		_, e = scoped.defaultProvider(ctx, "none")
		p.Public = e == nil
		provider, e := scoped.defaultProvider(ctx, "session")
		p.CanAdd = e == nil && scoped.AdapterTLS && scoped.Vault != nil && adapter.Supports(provider, adapter.CredentialPrepare, 1, 0) && adapter.Supports(provider, adapter.ConnectionCheck, 1, 0)
		if provider != nil {
			p.Help = provider.CredentialHelp
		}
		e = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT coalesce((SELECT default_connection_id::text FROM tenant_preferences WHERE adapter_id=$1),'')`, id).Scan(&p.Selected)
		})
		if e != nil {
			return out, e
		}
		out.Platforms = append(out.Platforms, p)
	}
	e := s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, `SELECT id,name,state,coalesce(username,''),coalesce(account_id,''),adapter_id FROM connections WHERE state<>'revoked' ORDER BY name,id`)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var a channelapi.Account
			if e = rows.Scan(&a.ID, &a.Name, &a.State, &a.Username, &a.AccountID, &a.Adapter); e != nil {
				return e
			}
			for _, p := range out.Platforms {
				if p.Selected == a.ID {
					a.Selected = true
				}
			}
			out.Accounts = append(out.Accounts, a)
		}
		return rows.Err()
	})
	return out, e
}

func (s *Service) channelAccount(ctx context.Context, tenant string, event channelapi.Event, op string) (channelapi.Result, error) {
	var out channelapi.Result
	arg := event.Argument
	if op == "account_delete" && arg != "" {
		id := strings.TrimPrefix(arg, "confirm:")
		if _, err := uuid.Parse(id); err != nil {
			return out, domain.ErrNotFound
		}
		var a channelapi.Account
		e := s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT id,name,state,coalesce(username,''),coalesce(account_id,''),adapter_id FROM connections WHERE id=$1`, id).Scan(&a.ID, &a.Name, &a.State, &a.Username, &a.AccountID, &a.Adapter)
		})
		if e != nil {
			return out, e
		}
		out.Account = &a
		out.Code = "confirm_account_delete"
		if strings.HasPrefix(arg, "confirm:") {
			e = s.RevokeConnection(ctx, tenant, id)
			out.Code = "account_deleted"
		}
		return out, e
	}
	if op == "account" && arg != "" {
		platform, connection := "", arg
		if strings.HasPrefix(arg, "public") {
			platform, connection = strings.TrimPrefix(arg, "public:"), ""
			if arg == "public" && len(s.adapterIDs()) == 1 {
				platform = s.adapterIDs()[0]
			}
		}
		if e := s.SelectAccount(ctx, tenant, platform, connection); e != nil {
			return out, e
		}
	}
	list, e := s.channelAccounts(ctx, tenant)
	out.Accounts = &list
	return out, e
}

func adapterDisplayName(d *pb.DescribeResponse) string {
	if d.GetDisplayName() != "" {
		return d.GetDisplayName()
	}
	return d.GetAdapterId()
}
