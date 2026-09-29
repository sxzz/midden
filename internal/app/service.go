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
	DeliveryWorkers       int
	MaxImageBytes         int64
	MaxVideoBytes         int64
	MaxMedia              int
}

func Defaults() Config {
	return Config{ConnectionConcurrency: 1, Quota: 1 << 30, Rate: 10, TenantConcurrency: 2, CaptureWorkers: 4, DownloadWorkers: 8, ControlWorkers: 4, DeliveryWorkers: 2, MaxImageBytes: 20 << 20, MaxVideoBytes: 512 << 20, MaxMedia: 20}
}

type Sender interface {
	Send(context.Context, string, string, int64) (int64, error)
	MediaItem(context.Context, string, domain.Asset) (int64, error)
	Media(context.Context, string, []domain.Asset, string) (int64, error)
}

type Service struct {
	Registry      *AdapterRegistry
	WebURL        string
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
	Sender        Sender
	Senders       map[string]Sender
}

func (s *Service) Enqueue(ctx context.Context, tx pgx.Tx, tenant, id, kind string) error {
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
				return tx.QueryRow(ctx, "SELECT adapter_id FROM tenant_archives WHERE archive_id=$1", in.RefreshID).Scan(&id)
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
			return tx.QueryRow(ctx, `SELECT a.url,t.provider_id,coalesce(t.connection_id::text,'') FROM tenant_archives t JOIN archives a ON a.id=t.archive_id WHERE t.archive_id=$1`, in.RefreshID).Scan(&in.URL, &in.ProviderID, &in.ConnectionID)
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
		if in.ParentSubmission != "" {
			var stopped bool
			if e := tx.QueryRow(ctx, `SELECT collection_stopped FROM submissions WHERE id=$1`, in.ParentSubmission).Scan(&stopped); e != nil {
				return e
			}
			if stopped {
				return errCollectionStopped
			}
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
		fingerprint := store.Hash(desc.AdapterId + "|" + target.Platform + "|" + target.Kind + "|" + target.ObjectScope + "|" + target.ExternalID + "|" + in.ProviderID + "|" + scope + "|" + in.RefreshID + "|" + in.PageCursor + fmt.Sprintf("|%d|%d", in.PageSize, in.CollectionLimit))
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
		dataScope := "00000000-0000-0000-0000-000000000000"
		if visibility == "private" {
			dataScope = tenant
		}
		if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 1))`, dataScope+"|"+target.Platform+"|"+scope+"|"+target.Kind+"|"+target.ObjectScope+"|"+target.ExternalID); e != nil {
			return e
		}
		if aid == "" && in.ConnectionID != "" {
			e = tx.QueryRow(ctx, `SELECT a.id FROM captures c JOIN archives a ON a.id=c.archive_id WHERE c.tenant_id=$1 AND c.connection_id=$2 AND a.external_id=$3 AND a.platform=$4 AND a.kind=$5 AND a.object_scope=$6 AND c.state IN('queued','downloading') LIMIT 1`, tenant, in.ConnectionID, target.ExternalID, target.Platform, target.Kind, target.ObjectScope).Scan(&aid)
			if e != nil && !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
		}
		if aid == "" && in.ConnectionID != "" && in.RefreshID == "" {
			e = tx.QueryRow(ctx, `SELECT a.id FROM tenant_archives t JOIN archives a ON a.id=t.archive_id WHERE a.external_id=$1 AND t.connection_id=$2 AND a.platform=$3 AND a.kind=$4 AND a.object_scope=$5 AND a.current_revision IS NOT NULL ORDER BY t.created_at DESC LIMIT 1`, target.ExternalID, in.ConnectionID, target.Platform, target.Kind, target.ObjectScope).Scan(&aid)
			if e != nil && !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
		}
		if aid == "" {
			e = tx.QueryRow(ctx, `SELECT id FROM archives WHERE data_scope=$1 AND platform=$4 AND scope=$2 AND kind=$5 AND object_scope=$6 AND external_id=$3`, dataScope, scope, target.ExternalID, target.Platform, target.Kind, target.ObjectScope).Scan(&aid)
			if errors.Is(e, pgx.ErrNoRows) {
				e = tx.QueryRow(ctx, `INSERT INTO archives(tenant_id,visibility,external_id,url,provider_id,scope,platform,kind,object_scope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, tenant, visibility, target.ExternalID, target.URL, in.ProviderID, scope, target.Platform, target.Kind, target.ObjectScope).Scan(&aid)
			}
			if e != nil {
				return e
			}
		}
		// Hold the archive row through subscription creation so finalization cannot miss a subscriber.
		if e = tx.QueryRow(ctx, `SELECT id FROM archives WHERE id=$1 FOR UPDATE`, aid).Scan(&aid); e != nil {
			return e
		}
		tag, e := tx.Exec(ctx, `INSERT INTO tenant_archives(tenant_id,archive_id,provider_id,connection_id,adapter_id) SELECT $1,$2,$3,nullif($4,'')::uuid,$6 WHERE $5='' OR $5=$2::uuid::text ON CONFLICT DO NOTHING`, tenant, aid, in.ProviderID, in.ConnectionID, in.RefreshID, desc.AdapterId)
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
		if _, e = tx.Exec(ctx, `UPDATE archives SET unreferenced_at=NULL WHERE id=$1`, aid); e != nil {
			return e
		}

		var cid string
		e = tx.QueryRow(ctx, `SELECT id FROM captures WHERE archive_id=$1 AND provider_id=$2 AND coalesce(connection_id::text,'')=$3 AND adapter_id=$4 AND state IN('queued','downloading') AND page_cursor=$5 AND (NOT $6 OR NOT automatic) AND page_size=$7`, aid, in.ProviderID, in.ConnectionID, desc.AdapterId, in.PageCursor, target.Collection && !in.Automatic, in.PageSize).Scan(&cid)
		if errors.Is(e, pgx.ErrNoRows) && in.PageCursor == "" && in.RefreshID == "" && (in.Automatic || !target.RefreshOnSubmit) {
			e = tx.QueryRow(ctx, `SELECT r.capture_id FROM archives a JOIN revisions r ON r.id=a.current_revision WHERE a.id=$1 AND ($2::bigint=0 OR a.observed_at > now()-make_interval(secs=>$2::double precision))`, aid, in.RefreshAfterSeconds).Scan(&cid)
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
			e = tx.QueryRow(ctx, `INSERT INTO captures(tenant_id,archive_id,provider_id,scope,visibility,connection_id,refresh_from,adapter_id,automatic,page_cursor,is_collection,page_size) VALUES($1,$2,$3,$4,$5,nullif($6,'')::uuid,nullif($7,'')::uuid,$8,$9,$10,$11,$12) RETURNING id`, tenant, aid, in.ProviderID, scope, visibility, in.ConnectionID, in.RefreshID, desc.AdapterId, in.Automatic, in.PageCursor, target.Collection && !in.Automatic, in.PageSize).Scan(&cid)
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
		e = tx.QueryRow(ctx, `INSERT INTO submissions(tenant_id,capture_id,identity_id,channel_id,chat_id,idem_key,fingerprint,reply_to_message_id,input,collection_limit,parent_submission) VALUES($1,$2,nullif($3,'')::uuid,nullif($4,'')::uuid,nullif($5,''),$6,$7,$8,$9,$10,nullif($11,'')::uuid) RETURNING id`, tenant, cid, in.Origin.IdentityID, in.Origin.ChannelID, in.Origin.ChatID, in.Key, fingerprint, in.Origin.ReplyToMessageID, in.Input, in.CollectionLimit, in.ParentSubmission).Scan(&sid)
		if e != nil {
			return e
		}
		if !in.Automatic && adapter.Supports(policy, adapter.CaptureRelated, 1, 0) {
			if _, e = tx.Exec(ctx, `UPDATE submissions SET related_provider=$2,related_connection=nullif($3,'')::uuid,related_adapter=$4,related_state='pending',related_source_archive=$5 WHERE id=$1`, sid, in.ProviderID, in.ConnectionID, desc.AdapterId, aid); e != nil {
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

// DeleteArchive removes only this tenant's collection reference. Shared content remains readable.
func (s *Service) DeleteArchive(ctx context.Context, tenant, id string) error {
	return s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		if e := lockTenant(ctx, tx, tenant); e != nil {
			return e
		}
		var aid string
		if e := tx.QueryRow(ctx, `SELECT id FROM archives WHERE id=$1 FOR UPDATE`, id).Scan(&aid); e != nil {
			return e
		}
		tag, e := tx.Exec(ctx, `DELETE FROM tenant_archives WHERE tenant_id=$1 AND archive_id=$2`, tenant, id)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return domain.ErrNotFound
		}
		// The restricted function checks references belonging to every tenant.
		_, e = tx.Exec(ctx, `SELECT mark_unreferenced($1)`, id)
		return e
	})
}

func scanJob(ctx context.Context, tx pgx.Tx, id string, j *domain.Job) error {
	return tx.QueryRow(ctx, `SELECT id,archive_id,state,error,provider_id,coalesce(connection_id::text,''),scope,created_at FROM captures WHERE id=$1 AND (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid OR EXISTS(SELECT FROM submissions WHERE capture_id=captures.id))`, id).Scan(&j.ID, &j.ArchiveID, &j.State, &j.Error, &j.ProviderID, &j.ConnectionID, &j.AccessScope, &j.CreatedAt)
}

func (s *Service) Job(ctx context.Context, t, id string) (j domain.Job, e error) {
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error { return scanJob(ctx, tx, id, &j) })
	return
}

func (s *Service) Usage(ctx context.Context, t string) (u domain.Usage, e error) {
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT tenant_usage(),reserved_bytes,quota_bytes,tenant_unlimited() FROM tenants WHERE id=$1`, t).Scan(&u.Used, &u.Reserved, &u.Limit, &u.Unlimited)
	})
	return
}

func archive(ctx context.Context, tx pgx.Tx, id string) (a domain.Archive, e error) {
	var payload []byte
	var cid string
	e = tx.QueryRow(ctx, `SELECT a.id,a.url,a.external_id,a.provider_id,a.scope,a.visibility,r.id,r.payload,r.capture_id,a.observed_at,a.created_at FROM archives a JOIN revisions r ON r.id=a.current_revision WHERE a.id=$1`, id).Scan(&a.ID, &a.URL, &a.ExternalID, &a.ProviderID, &a.AccessScope, &a.Visibility, &a.RevisionID, &payload, &cid, &a.ObservedAt, &a.CreatedAt)
	if e != nil {
		return
	}
	var p Payload
	if e = json.Unmarshal(payload, &p); e != nil {
		return
	}
	a.AuthorName = p.AuthorName
	a.PublishedAt = p.PublishedAt
	a.Summary = p.Summary
	a.Text = p.Text
	a.TextKind = p.TextKind
	a.TextSource = p.TextSource
	a.AdapterVersion = p.Version
	a.Warnings = p.Warnings
	all, err := assets(ctx, tx, cid)
	e = err
	hydrateGraph(&a, p, all)
	return
}

func (s *Service) Archive(ctx context.Context, t, id string) (a domain.Archive, e error) {
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error { var err error; a, err = archive(ctx, tx, id); return err })
	return
}

func assets(ctx context.Context, tx pgx.Tx, cid string) (out []domain.Asset, e error) {
	rows, e := tx.Query(ctx, `SELECT a.id,a.purpose,a.position,a.alt_text,a.sensitive,a.state,a.error,coalesce(b.hash,''),coalesce(b.mime,''),coalesce(b.size,0),coalesce(b.object_key,'') FROM assets a LEFT JOIN blobs b ON b.id=a.blob_id WHERE a.capture_id=$1 ORDER BY a.position`, cid)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out = []domain.Asset{}
	for rows.Next() {
		var a domain.Asset
		if e = rows.Scan(&a.ID, &a.Purpose, &a.Position, &a.AltText, &a.Sensitive, &a.State, &a.Error, &a.Hash, &a.MIME, &a.Size, &a.Key); e != nil {
			return nil, e
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Service) Asset(ctx context.Context, t, id string) (a domain.Asset, e error) {
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT a.id,b.object_key,b.mime,b.size,b.hash FROM assets a JOIN blobs b ON b.id=a.blob_id WHERE a.id=$1 AND a.state='ready'`, id).Scan(&a.ID, &a.Key, &a.MIME, &a.Size, &a.Hash)
	})
	return
}

func parseArchiveCursor(cursor string) (*string, bool, error) {
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
	p.Items = []domain.Archive{}
	anchor, backwards, err := parseArchiveCursor(cursor)
	if err != nil {
		return p, err
	}
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		if anchor != nil {
			var x string
			if err := tx.QueryRow(ctx, `SELECT a.id FROM archives a JOIN tenant_archives t ON t.archive_id=a.id WHERE a.id=$1 AND a.current_revision IS NOT NULL`, *anchor).Scan(&x); err != nil {
				return err
			}
		}
		comparison, order := "<", "DESC"
		if backwards {
			comparison, order = ">", "ASC"
		}
		rows, err := tx.Query(ctx, fmt.Sprintf(`SELECT a.id FROM archives a JOIN tenant_archives t ON t.archive_id=a.id WHERE a.current_revision IS NOT NULL AND ($1::uuid IS NULL OR (t.created_at,a.id)%s(SELECT created_at,archive_id FROM tenant_archives WHERE archive_id=$1)) ORDER BY t.created_at %s,a.id %s LIMIT 10`, comparison, order, order), anchor)
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
				EXISTS(SELECT 1 FROM tenant_archives t JOIN archives a ON a.id=t.archive_id WHERE a.current_revision IS NOT NULL AND (t.created_at,a.id)>(SELECT created_at,archive_id FROM tenant_archives WHERE archive_id=$1)),
				EXISTS(SELECT 1 FROM tenant_archives t JOIN archives a ON a.id=t.archive_id WHERE a.current_revision IS NOT NULL AND (t.created_at,a.id)<(SELECT created_at,archive_id FROM tenant_archives WHERE archive_id=$2))`, ids[0], ids[len(ids)-1]).Scan(&previous, &next)
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
			a, err := archive(ctx, tx, id)
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

// CaptureArchive pins delivery to the revision produced (or reused) by that capture.
func (s *Service) CaptureArchive(ctx context.Context, t, cid string) (a domain.Archive, e error) {
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		var raw []byte
		var assetCapture string
		err := tx.QueryRow(ctx, `SELECT a.id,a.url,a.external_id,a.provider_id,a.scope,a.visibility,r.id,r.payload,r.capture_id,a.observed_at,a.created_at FROM captures c JOIN archives a ON a.id=c.archive_id JOIN revisions r ON r.id=c.revision_id WHERE c.id=$1`, cid).Scan(&a.ID, &a.URL, &a.ExternalID, &a.ProviderID, &a.AccessScope, &a.Visibility, &a.RevisionID, &raw, &assetCapture, &a.ObservedAt, &a.CreatedAt)
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

func (s *Service) sender(channel string) Sender {
	if s.Senders != nil {
		return s.Senders[channel]
	}
	return s.Sender
}
