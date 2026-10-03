package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
	"monitor/internal/blob"
	"monitor/internal/credentials"
	"monitor/internal/domain"
	"monitor/internal/store"
)

type Config struct {
	ConnectionConcurrency int
	Quota                 int64
	Rate                  int
	TenantConcurrency     int
	CaptureWorkers        int
	DownloadWorkers       int
	ControlWorkers        int
	MaxMedia              int
}

func Defaults() Config {
	return Config{ConnectionConcurrency: 1, Quota: 1 << 30, Rate: 10, TenantConcurrency: 2, CaptureWorkers: 4, DownloadWorkers: 8, ControlWorkers: 4, MaxMedia: 20}
}

type Service struct {
	Registry      *AdapterRegistry
	Adapters      map[string]AdapterBinding
	Descriptor    *pb.DescribeResponse
	EntitySchemas map[string]adapter.EntitySchema
	Vault         *credentials.Vault
	AdapterTLS    bool
	DB            *store.Store
	Queue         *river.Client[pgx.Tx]
	Adapter       pb.AdapterClient
	Providers     []*pb.Provider
	Blobs         blob.Storage
	HTTP          *http.Client
	Config        Config
}

func (s *Service) Enqueue(ctx context.Context, tx pgx.Tx, tenant, id, kind string) error {
	if kind == "deliver" || kind == "status" {
		return enqueueChannel(ctx, tx, tenant, id)
	}
	_, e := s.Queue.InsertTx(ctx, tx, store.Task{Tenant: tenant, ID: id, Type: kind}, nil)
	return e
}

func lockTenant(ctx context.Context, tx pgx.Tx, tenant string) error {
	var id string
	return tx.QueryRow(ctx, `SELECT id FROM tenants WHERE id=$1 FOR UPDATE`, tenant).Scan(&id)
}

// Discovery is shared by the running service and administration CLI.
func (s *Service) requireProvider(ctx context.Context, id, capability string) (*pb.Provider, error) {
	d, err := s.descriptor(ctx)
	if err != nil {
		return nil, err
	}
	providers := d.Providers
	for _, p := range providers {
		if p.GetId() == id && adapter.Supports(p, capability, 1, 0) {
			return p, nil
		}
	}
	return nil, fmt.Errorf("%w: provider does not support %s version 1", domain.ErrUnsupported, capability)
}

// Provider policy is obtained from the trusted adapter, never from a user's request.
func (s *Service) providerVisibility(ctx context.Context, id string) (string, error) {
	p, err := s.requireProvider(ctx, id, adapter.CaptureFetch)
	if err != nil {
		return "", err
	}
	if p.Authentication == "session" {
		return "private", nil
	}
	if p.Authentication != "none" || len(p.Visibilities) != 1 {
		return "", domain.ErrUnsupported
	}
	switch p.Visibilities[0] {
	case pb.Visibility_VISIBILITY_PUBLIC:
		return "public", nil
	case pb.Visibility_VISIBILITY_PRIVATE:
		return "private", nil
	}
	return "", domain.ErrUnsupported
}

func (s *Service) Submit(ctx context.Context, tenant string, in domain.CaptureInput) (out domain.Job, err error) {
	if s.Registry != nil || len(s.adapterBindings()) > 0 {
		var scoped *Service
		if in.RefreshID != "" {
			var id string
			err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
				return tx.QueryRow(ctx, "SELECT adapter_id FROM tenant_collections WHERE collection_id=$1", in.RefreshID).Scan(&id)
			})
			if err != nil {
				return out, err
			}
			scoped, err = s.forAdapter(id)
		} else {
			scoped, err = s.forURL(ctx, in.URL)
		}
		if err != nil {
			return out, err
		}
		return scoped.Submit(ctx, tenant, in)
	}
	desc, err := s.descriptor(ctx)
	if err != nil {
		return out, err
	}

	if in.ConnectionID != "" {
		id, e := uuid.Parse(in.ConnectionID)
		if e != nil {
			return out, ErrConnection
		}
		in.ConnectionID = id.String()
	}
	if in.RefreshID != "" {
		err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT a.url,t.provider_id,coalesce(t.connection_id::text,'') FROM tenant_collections t JOIN collections a ON a.id=t.collection_id WHERE t.collection_id=$1`, in.RefreshID).Scan(&in.URL, &in.ProviderID, &in.ConnectionID)
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return out, domain.ErrNotFound
		}
		if err != nil {
			return out, err
		}
	}
	if in.ConnectionID != "" {
		_, provider, e := s.connectionProvider(ctx, tenant, in.ConnectionID)
		if e != nil {
			return out, e
		}
		if in.ProviderID != "" && in.ProviderID != provider {
			return out, ErrConnection
		}
		in.ProviderID = provider
	} else if in.ProviderID == "" {
		p, e := s.defaultProvider(ctx, "none")
		if e != nil {
			return out, e
		}
		in.ProviderID = p.Id
	}
	policy, e := s.requireProvider(ctx, in.ProviderID, adapter.CaptureFetch)
	if e != nil {
		return out, e
	}
	if (in.ConnectionID == "") != (policy.Authentication == "none") {
		return out, ErrConnection
	}
	target, e := s.Resolve(ctx, in.URL)
	if e != nil {
		return out, e
	}
	if in.CollectionLimit > 1000 || in.PageSize > 1000 {
		return out, domain.ErrUnsupported
	}
	switch in.UpdateMode {
	case "":
		in.UpdateMode = "full"
	case "full", "append":
	default:
		return out, domain.ErrUnsupported
	}
	var changedAt *time.Time
	if in.UpdatedAt != "" {
		if t, e := time.Parse(time.RFC3339Nano, in.UpdatedAt); e == nil {
			changedAt = &t
		}
	}
	if len(in.PageCursor) > 4096 || ((in.PageCursor != "" || in.CollectionLimit > 0 || in.PageSize > 0) && (in.Automatic || !target.Collection || !adapter.Supports(policy, adapter.CapturePage, 1, 0))) {
		return out, domain.ErrUnsupported
	}
	if in.Input == "" {
		in.Input = in.URL
	}
	in.URL = target.URL
	if in.Key == "" {
		in.Key = uuid.NewString()
	}
	if len(in.Key) > 200 {
		return out, fmt.Errorf("idempotency key too long")
	}
	visibility, err := s.providerVisibility(ctx, in.ProviderID)
	if err != nil {
		return out, err
	}
	err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		if e := lockTenant(ctx, tx, tenant); e != nil {
			return e
		}
		recheck := false
		appendOnly := in.UpdateMode == "append"
		if in.ParentSubmission != "" {
			var stopped bool
			var parentMode string
			if e := tx.QueryRow(ctx, `SELECT s.collection_stopped,c.is_collection,s.update_mode FROM submissions s JOIN captures c ON c.id=s.capture_id WHERE s.id=$1`, in.ParentSubmission).Scan(&stopped, &recheck, &parentMode); e != nil {
				return e
			}
			if stopped {
				return errCollectionStopped
			}
			// Members of an appending collection refresh are reused when unchanged.
			appendOnly = appendOnly || recheck && parentMode == "append"
		}
		if in.ConnectionID != "" {
			if !s.AdapterTLS || s.Vault == nil {
				return ErrConnection
			}
			var state string
			if e := tx.QueryRow(ctx, `SELECT state FROM connections WHERE id=$1 AND tenant_id=$2 AND provider_id=$3`, in.ConnectionID, tenant, in.ProviderID).Scan(&state); e != nil || state != "ready" {
				return ErrConnection
			}
		}
		if in.Origin.IdentityID != "" {
			var channel, user string
			e := tx.QueryRow(ctx, `SELECT channel_id,external_id FROM identities WHERE id=$1 AND tenant_id=$2`, in.Origin.IdentityID, tenant).Scan(&channel, &user)
			if e != nil {
				return e
			}
			chatID, chatErr := strconv.ParseInt(in.Origin.ChatID, 10, 64)
			if channel != in.Origin.ChannelID || (user != in.Origin.ChatID && !(chatErr == nil && chatID < 0 && in.Origin.ReplyToMessageID > 0)) {
				return fmt.Errorf("invalid response destination")
			}
		}
		var aid string
		scope := "public"
		if in.ConnectionID != "" {
			scope = "connection:" + in.ConnectionID
		}
		if in.RefreshID != "" && in.ConnectionID == "" {
			aid = in.RefreshID
		}
		if in.Input == "" {
			in.Input = in.URL
		}
		fingerprint := store.Hash(desc.AdapterId + "|" + target.Platform + "|" + target.Kind + "|" + target.ObjectScope + "|" + target.ExternalID + "|" + in.ProviderID + "|" + scope + "|" + in.RefreshID + "|" + in.PageCursor + fmt.Sprintf("|%d|%d", in.PageSize, in.CollectionLimit) + appendFingerprint(in.UpdateMode))
		var existing, f string
		e = tx.QueryRow(ctx, `SELECT capture_id,fingerprint FROM submissions WHERE tenant_id=$1 AND idem_key=$2`, tenant, in.Key).Scan(&existing, &f)
		if e == nil {
			if f != fingerprint {
				return domain.ErrConflict
			}
			return scanJob(ctx, tx, existing, &out)
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		// Serialize all submissions for one content identity, including different tenants.
		if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 1))`, target.Platform+"|"+target.Kind+"|"+target.ObjectScope+"|"+target.ExternalID); e != nil {
			return e
		}
		if aid == "" {
			// One collection per adapter object, whichever source stored it.
			e = tx.QueryRow(ctx, `INSERT INTO collections(external_id,url,provider_id,platform,kind,object_scope) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(platform,kind,object_scope,external_id) DO UPDATE SET unreferenced_at=collections.unreferenced_at RETURNING id`, target.ExternalID, target.URL, in.ProviderID, target.Platform, target.Kind, target.ObjectScope).Scan(&aid)
			if e != nil {
				return e
			}
		}
		// Hold the collection row through subscription creation so finalization cannot miss a subscriber.
		if e = tx.QueryRow(ctx, `SELECT id FROM collections WHERE id=$1 FOR UPDATE`, aid).Scan(&aid); e != nil {
			return e
		}
		tag, e := tx.Exec(ctx, `INSERT INTO tenant_collections(tenant_id,collection_id,provider_id,connection_id,adapter_id) SELECT $1,$2,$3,nullif($4,'')::uuid,$6 WHERE $5='' OR $5=$2::uuid::text ON CONFLICT DO NOTHING`, tenant, aid, in.ProviderID, in.ConnectionID, in.RefreshID, desc.AdapterId)
		if e != nil {
			return e
		}
		if tag.RowsAffected() > 0 {
			var within bool
			if e = tx.QueryRow(ctx, `SELECT tenant_unlimited() OR tenant_usage()+reserved_bytes<=quota_bytes FROM tenants WHERE id=$1`, tenant).Scan(&within); e != nil {
				return e
			}
			if !within {
				return domain.ErrQuota
			}
		}
		if _, e = tx.Exec(ctx, `UPDATE collections SET unreferenced_at=NULL WHERE id=$1`, aid); e != nil {
			return e
		}

		var cid string
		mode := "fetch"
		e = tx.QueryRow(ctx, `SELECT id FROM captures WHERE collection_id=$1 AND provider_id=$2 AND coalesce(connection_id::text,'')=$3 AND adapter_id=$4 AND state IN('queued','downloading') AND page_cursor=$5 AND (NOT $6 OR NOT automatic) AND page_size=$7`, aid, in.ProviderID, in.ConnectionID, desc.AdapterId, in.PageCursor, target.Collection && !in.Automatic, in.PageSize).Scan(&cid)
		// Appending never skips the collection itself: its listing is what
		// reveals new members.
		appendOnly = appendOnly && (in.Automatic || !target.Collection && !target.RefreshOnSubmit)
		if errors.Is(e, pgx.ErrNoRows) && in.PageCursor == "" && (appendOnly || !recheck && in.RefreshID == "" && (in.Automatic || !target.RefreshOnSubmit)) {
			// Reuse the newest version this tenant can read. When another source
			// stored a newer version this tenant cannot read yet, an account can
			// prove access instead of fetching the content again.
			var visible *string
			var hidden, fresh, complete, unchanged bool
			if e = tx.QueryRow(ctx, `SELECT r.capture_id,has_hidden_revision(a.id),$2::bigint=0 OR a.observed_at > now()-make_interval(secs=>$2::double precision),coalesce(c.state='complete',false),$3::timestamptz IS NULL OR a.observed_at>=$3 FROM collections a LEFT JOIN LATERAL (SELECT head.* FROM revisions head WHERE head.collection_id=a.id ORDER BY head.created_at DESC,head.id DESC LIMIT 1) r ON TRUE LEFT JOIN captures c ON c.id=r.capture_id WHERE a.id=$1`, aid, in.RefreshAfterSeconds, changedAt).Scan(&visible, &hidden, &fresh, &complete, &unchanged); e != nil {
				return e
			}
			// Appending refetches what was saved incompletely or changed upstream
			// after the last observation, and everything not saved yet.
			if appendOnly && !(complete && unchanged) {
				fresh = false
			}
			switch {
			case fresh && hidden && in.ConnectionID != "" && adapter.Supports(policy, adapter.CaptureAccess, 1, 0):
				mode = "check"
				e = pgx.ErrNoRows
			case fresh && visible != nil:
				cid = *visible
			default:
				e = pgx.ErrNoRows
			}
		}
		if errors.Is(e, pgx.ErrNoRows) {
			var unlimited bool
			var used, reserved, quota int64
			var count int
			var start time.Time
			if e = tx.QueryRow(ctx, `SELECT tenant_unlimited(),tenant_usage(),reserved_bytes,quota_bytes,rate_count,rate_start FROM tenants WHERE id=$1`, tenant).Scan(&unlimited, &used, &reserved, &quota, &count, &start); e != nil {
				return e
			}
			if !unlimited && used+reserved >= quota {
				return domain.ErrQuota
			}
			if time.Since(start) >= time.Minute {
				count = 0
				start = time.Now()
			}
			if !unlimited && count >= s.Config.Rate {
				return domain.ErrRate
			}
			if _, e = tx.Exec(ctx, `UPDATE tenants SET rate_count=$2,rate_start=$3 WHERE id=$1`, tenant, count+1, start); e != nil {
				return e
			}
			// Account captures start private until the adapter classifies the result.
			e = tx.QueryRow(ctx, `INSERT INTO captures(tenant_id,collection_id,provider_id,scope,visibility,connection_id,refresh_from,adapter_id,automatic,page_cursor,is_collection,page_size,mode) VALUES($1,$2,$3,$4,$5,nullif($6,'')::uuid,nullif($7,'')::uuid,$8,$9,$10,$11,$12,$13) RETURNING id`, tenant, aid, in.ProviderID, scope, visibility, in.ConnectionID, in.RefreshID, desc.AdapterId, in.Automatic, in.PageCursor, target.Collection && !in.Automatic, in.PageSize, mode).Scan(&cid)
			if e != nil {
				return e
			}
			if e = s.Enqueue(ctx, tx, tenant, cid, "capture"); e != nil {
				return e
			}
		} else if e != nil {
			return e
		}
		var sid string
		e = tx.QueryRow(ctx, `INSERT INTO submissions(tenant_id,capture_id,identity_id,channel_id,chat_id,idem_key,fingerprint,reply_to_message_id,input,collection_limit,parent_submission,update_mode) VALUES($1,$2,nullif($3,'')::uuid,nullif($4,'')::uuid,nullif($5,''),$6,$7,$8,$9,$10,nullif($11,'')::uuid,$12) RETURNING id`, tenant, cid, in.Origin.IdentityID, in.Origin.ChannelID, in.Origin.ChatID, in.Key, fingerprint, in.Origin.ReplyToMessageID, in.Input, in.CollectionLimit, in.ParentSubmission, in.UpdateMode).Scan(&sid)
		if e != nil {
			return e
		}
		expandRelated := !in.Automatic
		if in.Automatic && !target.Collection && !target.RefreshOnSubmit && in.ParentSubmission != "" {
			// A collection's direct child can hydrate its references. Never
			// recursively expand references of references or automatic collections.
			if e = tx.QueryRow(ctx, `SELECT s.parent_submission IS NULL OR c.is_collection FROM submissions s JOIN captures c ON c.id=s.capture_id WHERE s.id=$1`, in.ParentSubmission).Scan(&expandRelated); e != nil {
				return e
			}
		}
		if expandRelated && adapter.Supports(policy, adapter.CaptureRelated, 1, 0) {
			if _, e = tx.Exec(ctx, `UPDATE submissions SET related_provider=$2,related_connection=nullif($3,'')::uuid,related_adapter=$4,related_state='pending',related_source_collection=$5 WHERE id=$1`, sid, in.ProviderID, in.ConnectionID, desc.AdapterId, aid); e != nil {
				return e
			}
			if e = s.Enqueue(ctx, tx, tenant, sid, "related"); e != nil {
				return e
			}
		}
		if e = scanJob(ctx, tx, cid, &out); e != nil {
			return e
		}
		if in.Origin.ChatID != "" && (out.State == "complete" || out.State == "partial" || out.State == "failed") {
			return s.Enqueue(ctx, tx, tenant, sid, "deliver")
		}
		if in.Origin.ChatID != "" {
			return s.Enqueue(ctx, tx, tenant, sid, "status")
		}
		return nil
	})
	return
}

// DeleteCollection removes only this tenant's collection reference. Shared content remains readable.
func (s *Service) DeleteCollection(ctx context.Context, tenant, id string) error {
	return s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		if e := lockTenant(ctx, tx, tenant); e != nil {
			return e
		}
		ids, e := savedIdentityIDs(ctx, tx, id)
		if errors.Is(e, pgx.ErrNoRows) {
			return domain.ErrNotFound
		}
		if e != nil {
			return e
		}
		// Lock every member in a stable order before removing the logical save.
		for _, member := range ids {
			var locked string
			if e := tx.QueryRow(ctx, `SELECT id FROM collections WHERE id=$1 FOR UPDATE`, member).Scan(&locked); e != nil {
				return e
			}
		}
		if _, e = tx.Exec(ctx, `DELETE FROM tenant_collections WHERE tenant_id=$1 AND collection_id=ANY($2::uuid[])`, tenant, ids); e != nil {
			return e
		}
		if err := pruneTags(ctx, tx); err != nil {
			return err
		}
		// The restricted function checks references belonging to every tenant.
		for _, member := range ids {
			if _, e = tx.Exec(ctx, `SELECT mark_unreferenced($1)`, member); e != nil {
				return e
			}
		}
		return nil
	})
}

// Full refreshes keep the fingerprints stored before update modes existed.
func appendFingerprint(mode string) string {
	if mode == "append" {
		return "|append"
	}
	return ""
}

func scanJob(ctx context.Context, tx pgx.Tx, id string, j *domain.Job) error {
	return tx.QueryRow(ctx, `SELECT id,collection_id,state,error,provider_id,coalesce(connection_id::text,''),scope,created_at FROM captures WHERE id=$1 AND (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid OR EXISTS(SELECT FROM submissions WHERE capture_id=captures.id))`, id).Scan(&j.ID, &j.CollectionID, &j.State, &j.Error, &j.ProviderID, &j.ConnectionID, &j.AccessScope, &j.CreatedAt)
}

func (s *Service) Job(ctx context.Context, t, id string) (j domain.Job, e error) {
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error { return scanJob(ctx, tx, id, &j) })
	return
}

// JobProgress adds member progress to a collection capture, following this
// tenant's newest submission of it through its continuation pages.
func (s *Service) JobProgress(ctx context.Context, t, id string) (j domain.Job, e error) {
	var submission *string
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		if err := scanJob(ctx, tx, id, &j); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `SELECT (SELECT s.id FROM submissions s WHERE s.capture_id=c.id AND s.related_state<>'none' ORDER BY s.created_at DESC LIMIT 1) FROM captures c WHERE c.id=$1 AND c.is_collection`, id).Scan(&submission)
	})
	if errors.Is(e, domain.ErrNotFound) && j.ID != "" {
		return j, nil
	}
	if e != nil || submission == nil {
		return
	}
	c, e := s.channelCollection(ctx, t, *submission)
	if e != nil {
		return j, e
	}
	j.Members = &domain.MemberProgress{Total: c.Total, Complete: c.Complete, Partial: c.Partial, Failed: c.Failed, Pending: c.Pending, Done: c.Done || c.Stopped}
	return
}

func (s *Service) Usage(ctx context.Context, t string) (u domain.Usage, e error) {
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT tenant_usage(),reserved_bytes,quota_bytes,tenant_unlimited() FROM tenants WHERE id=$1`, t).Scan(&u.Used, &u.Reserved, &u.Limit, &u.Unlimited)
	})
	return
}

func collection(ctx context.Context, tx pgx.Tx, id string) (domain.Collection, error) {
	loaded, err := collectionsByID(ctx, tx, []string{id})
	if err != nil {
		return domain.Collection{}, err
	}
	a, ok := loaded[id]
	if !ok {
		return domain.Collection{}, pgx.ErrNoRows
	}
	return a, nil
}

func (s *Service) Collection(ctx context.Context, t, id string) (a domain.Collection, e error) {
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		var err error
		a, err = collection(ctx, tx, id)
		if err == nil {
			a.StorageBytes, err = collectionStorage(ctx, tx, id)
		}
		return err
	})
	return
}

func assets(ctx context.Context, tx pgx.Tx, cid string) ([]domain.Asset, error) {
	loaded, err := assetsByCapture(ctx, tx, []string{cid})
	return loaded[cid], err
}

func assetsByCapture(ctx context.Context, tx pgx.Tx, cids []string) (out map[string][]domain.Asset, e error) {
	rows, e := tx.Query(ctx, `SELECT a.capture_id,a.id,a.purpose,a.position,a.alt_text,a.sensitive,a.state,a.error,coalesce(b.hash,''),coalesce(b.mime,''),coalesce(b.size,0),coalesce(b.object_key,''),EXISTS(SELECT FROM blob_thumbnails t WHERE t.blob_id=a.blob_id AND t.state='ready') FROM assets a LEFT JOIN blobs b ON b.id=a.blob_id WHERE a.capture_id=ANY($1::uuid[]) ORDER BY a.capture_id,a.position`, cids)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out = make(map[string][]domain.Asset, len(cids))
	for _, cid := range cids {
		out[cid] = []domain.Asset{}
	}
	for rows.Next() {
		var a domain.Asset
		var cid string
		if e = rows.Scan(&cid, &a.ID, &a.Purpose, &a.Position, &a.AltText, &a.Sensitive, &a.State, &a.Error, &a.Hash, &a.MIME, &a.Size, &a.Key, &a.Thumbnail); e != nil {
			return nil, e
		}
		out[cid] = append(out[cid], a)
	}
	return out, rows.Err()
}

func (s *Service) Asset(ctx context.Context, t, id string) (a domain.Asset, e error) {
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT a.id,b.object_key,b.mime,b.size,b.hash FROM assets a JOIN blobs b ON b.id=a.blob_id WHERE a.id=$1 AND a.state='ready'`, id).Scan(&a.ID, &a.Key, &a.MIME, &a.Size, &a.Hash)
	})
	return
}

// Thumbnail resolves the small derived image of a ready asset, if one was made.
func (s *Service) Thumbnail(ctx context.Context, t, id string) (a domain.Asset, e error) {
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT a.id,th.object_key,th.mime,th.size FROM assets a JOIN blob_thumbnails th ON th.blob_id=a.blob_id AND th.state='ready' WHERE a.id=$1 AND a.state='ready'`, id).Scan(&a.ID, &a.Key, &a.MIME, &a.Size)
	})
	// Object keys are never reused, so the key identifies these bytes for caching.
	a.Hash = store.Hash(a.Key)
	return
}

func parseCollectionCursor(cursor string) (*string, bool, error) {
	if cursor == "" {
		return nil, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return nil, false, fmt.Errorf("invalid cursor")
	}
	value := string(raw)
	backwards := strings.HasPrefix(value, "p:")
	id, err := uuid.Parse(strings.TrimPrefix(value, "p:"))
	if err != nil {
		return nil, false, fmt.Errorf("invalid cursor")
	}
	canonical := id.String()
	return &canonical, backwards, nil
}

func (s *Service) Recent(ctx context.Context, t, cursor string) (p domain.Page, e error) {
	p.Items = []domain.Collection{}
	anchor, backwards, err := parseCollectionCursor(cursor)
	if err != nil {
		return p, err
	}
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		if anchor != nil {
			var x string
			if err := tx.QueryRow(ctx, `SELECT a.id FROM collections a JOIN tenant_collections t ON t.collection_id=a.id WHERE a.id=$1 AND visible_head(a.id) IS NOT NULL`, *anchor).Scan(&x); err != nil {
				return err
			}
		}
		comparison, order := "<", "DESC"
		if backwards {
			comparison, order = ">", "ASC"
		}
		rows, err := tx.Query(ctx, fmt.Sprintf(`SELECT a.id FROM collections a JOIN tenant_collections t ON t.collection_id=a.id WHERE `+latestIdentitySQL+` AND visible_head(a.id) IS NOT NULL AND ($1::uuid IS NULL OR (t.created_at,a.id)%s(SELECT created_at,collection_id FROM tenant_collections WHERE collection_id=$1)) ORDER BY t.created_at %s,a.id %s LIMIT 10`, comparison, order, order), anchor)
		if err != nil {
			return err
		}
		var ids []string
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if backwards {
			slices.Reverse(ids)
		}
		if len(ids) > 0 {
			var previous, next bool
			err := tx.QueryRow(ctx, `SELECT
				EXISTS(SELECT 1 FROM tenant_collections t JOIN collections a ON a.id=t.collection_id WHERE `+latestIdentitySQL+` AND visible_head(a.id) IS NOT NULL AND (t.created_at,a.id)>(SELECT created_at,collection_id FROM tenant_collections WHERE collection_id=$1)),
				EXISTS(SELECT 1 FROM tenant_collections t JOIN collections a ON a.id=t.collection_id WHERE `+latestIdentitySQL+` AND visible_head(a.id) IS NOT NULL AND (t.created_at,a.id)<(SELECT created_at,collection_id FROM tenant_collections WHERE collection_id=$2))`, ids[0], ids[len(ids)-1]).Scan(&previous, &next)
			if err != nil {
				return err
			}
			if previous {
				p.PreviousCursor = base64.RawURLEncoding.EncodeToString([]byte("p:" + ids[0]))
			}
			if next {
				p.NextCursor = base64.RawURLEncoding.EncodeToString([]byte(ids[len(ids)-1]))
			}
		}
		for _, id := range ids {
			a, err := collection(ctx, tx, id)
			if err != nil {
				return err
			}
			a.StorageBytes, err = savedIdentityStorage(ctx, tx, id)
			if err != nil {
				return err
			}
			p.Items = append(p.Items, a)
		}
		return nil
	})
	return
}

type Payload struct {
	AuthorName        string              `json:"author_name,omitempty"`
	PublishedAt       string              `json:"published_at,omitempty"`
	Summary           string              `json:"summary,omitempty"`
	Graph             *domain.EntityGraph `json:"graph,omitempty"`
	MediaSensitive    []bool              `json:"media_sensitive,omitempty"`
	MediaDescriptions []string            `json:"media_descriptions,omitempty"`
	Text              string              `json:"text"`
	TextKind          string              `json:"text_kind"`
	Warnings          []string            `json:"warnings"`
	Version           string              `json:"adapter_version"`
	TextSource        string              `json:"text_source,omitempty"`
	Incomplete        bool                `json:"incomplete,omitempty"`
}

// CaptureCollection pins delivery to the revision produced (or reused) by that capture.
func (s *Service) CaptureCollection(ctx context.Context, t, cid string) (a domain.Collection, e error) {
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		var raw []byte
		var assetCapture string
		err := tx.QueryRow(ctx, `SELECT a.id,a.url,a.external_id,a.provider_id,r.visibility,r.visibility,r.id,r.payload,r.capture_id,a.observed_at,a.created_at FROM captures c JOIN collections a ON a.id=c.collection_id JOIN revisions r ON r.id=c.revision_id WHERE c.id=$1`, cid).Scan(&a.ID, &a.URL, &a.ExternalID, &a.ProviderID, &a.AccessScope, &a.Visibility, &a.RevisionID, &raw, &assetCapture, &a.ObservedAt, &a.CreatedAt)
		if err != nil {
			return err
		}
		var p Payload
		if err = json.Unmarshal(raw, &p); err != nil {
			return err
		}
		a.AuthorName = p.AuthorName
		a.PublishedAt = p.PublishedAt
		a.Summary = p.Summary
		a.Text = p.Text
		a.TextKind = p.TextKind
		a.TextSource = p.TextSource
		a.AdapterVersion = p.Version
		a.Warnings = p.Warnings
		all, err := assets(ctx, tx, assetCapture)
		hydrateGraph(&a, p, all)
		return err
	})
	return
}
