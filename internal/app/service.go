package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	pb "monitor/api/adapter/v1"
	"monitor/internal/blob"
	"monitor/internal/domain"
	"monitor/internal/store"
)

type Config struct {
	Quota             int64
	Rate              int
	TenantConcurrency int
	CaptureWorkers    int
	DownloadWorkers   int
	MaxImageBytes     int64
	MaxImages         int
}

func Defaults() Config { return Config{1 << 30, 10, 2, 4, 8, 20 << 20, 20} }

type Sender interface {
	Send(context.Context, string, string, int64) (int64, error)
	Image(context.Context, string, domain.Asset) (int64, error)
	Images(context.Context, string, []domain.Asset) (int64, error)
}

type Service struct {
	DB      *store.Store
	Queue   *river.Client[pgx.Tx]
	Adapter pb.AdapterClient
	Blobs   blob.Storage
	HTTP    *http.Client
	Config  Config
	Sender  Sender
	Senders map[string]Sender
}

func (s *Service) Enqueue(ctx context.Context, tx pgx.Tx, tenant, id, kind string) error {
	_, e := s.Queue.InsertTx(ctx, tx, store.Task{Tenant: tenant, ID: id, Type: kind}, nil)
	return e
}

func lockTenant(ctx context.Context, tx pgx.Tx, tenant string) error {
	var id string
	return tx.QueryRow(ctx, `SELECT id FROM tenants WHERE id=$1 FOR UPDATE`, tenant).Scan(&id)
}

func (s *Service) Submit(ctx context.Context, tenant string, in domain.CaptureInput) (out domain.Job, err error) {
	if in.ProviderID == "" {
		in.ProviderID = "xdown"
	}
	if in.Key == "" {
		in.Key = uuid.NewString()
	}
	if len(in.Key) > 200 {
		return out, fmt.Errorf("idempotency key too long")
	}
	err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		if e := lockTenant(ctx, tx, tenant); e != nil {
			return e
		}
		if in.ConnectionID != "" {
			var p string
			if e := tx.QueryRow(ctx, `SELECT provider_id FROM connections WHERE tenant_id=$1 AND id=$2`, tenant, in.ConnectionID).Scan(&p); e != nil {
				return e
			}
			return domain.ErrUnsupported
		}
		if in.ProviderID != "xdown" {
			return domain.ErrUnsupported
		}
		if in.Origin.IdentityID != "" {
			var channel, user string
			e := tx.QueryRow(ctx, `SELECT channel_id,external_id FROM identities WHERE id=$1 AND tenant_id=$2`, in.Origin.IdentityID, tenant).Scan(&channel, &user)
			if e != nil {
				return e
			}
			if channel != in.Origin.ChannelID || user != in.Origin.ChatID {
				return fmt.Errorf("invalid response destination")
			}
		}
		var aid, scope, connection string
		scope = "public"
		if in.RefreshID != "" {
			if e := tx.QueryRow(ctx, `SELECT id,url,scope,provider_id,coalesce(connection_id::text,'') FROM archives WHERE id=$1 AND tenant_id=$2`, in.RefreshID, tenant).Scan(&aid, &in.URL, &scope, &in.ProviderID, &connection); e != nil {
				return e
			}
			if connection != "" || in.ProviderID != "xdown" || scope != "public" {
				return domain.ErrUnsupported
			}
		}
		target, e := domain.Normalize(in.URL)
		if e != nil {
			return e
		}
		fingerprint := store.Hash(target.ExternalID + "|" + in.ProviderID + "|" + scope + "|" + in.RefreshID)
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
		if aid == "" {
			e = tx.QueryRow(ctx, `INSERT INTO archives(tenant_id,external_id,url,provider_id,scope) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,platform,scope,kind,object_scope,external_id) DO UPDATE SET url=archives.url RETURNING id`, tenant, target.ExternalID, target.URL, in.ProviderID, scope).Scan(&aid)
			if e != nil {
				return e
			}
		}
		var cid string
		e = tx.QueryRow(ctx, `SELECT id FROM captures WHERE tenant_id=$1 AND archive_id=$2 AND state IN('queued','downloading')`, tenant, aid).Scan(&cid)
		if errors.Is(e, pgx.ErrNoRows) && in.RefreshID == "" {
			e = tx.QueryRow(ctx, `SELECT r.capture_id FROM archives a JOIN revisions r ON r.id=a.current_revision AND r.tenant_id=a.tenant_id WHERE a.id=$1`, aid).Scan(&cid)
		}
		if errors.Is(e, pgx.ErrNoRows) {
			var used, reserved, quota int64
			var count int
			var start time.Time
			if e = tx.QueryRow(ctx, `SELECT used_bytes,reserved_bytes,quota_bytes,rate_count,rate_start FROM tenants WHERE id=$1`, tenant).Scan(&used, &reserved, &quota, &count, &start); e != nil {
				return e
			}
			if used+reserved >= quota {
				return domain.ErrQuota
			}
			if time.Since(start) >= time.Minute {
				count = 0
				start = time.Now()
			}
			if count >= s.Config.Rate {
				return domain.ErrRate
			}
			if _, e = tx.Exec(ctx, `UPDATE tenants SET rate_count=$2,rate_start=$3 WHERE id=$1`, tenant, count+1, start); e != nil {
				return e
			}
			e = tx.QueryRow(ctx, `INSERT INTO captures(tenant_id,archive_id,provider_id,scope) VALUES($1,$2,$3,$4) RETURNING id`, tenant, aid, in.ProviderID, scope).Scan(&cid)
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
		e = tx.QueryRow(ctx, `INSERT INTO submissions(tenant_id,capture_id,identity_id,channel_id,chat_id,idem_key,fingerprint) VALUES($1,$2,nullif($3,'')::uuid,nullif($4,'')::uuid,nullif($5,''),$6,$7) RETURNING id`, tenant, cid, in.Origin.IdentityID, in.Origin.ChannelID, in.Origin.ChatID, in.Key, fingerprint).Scan(&sid)
		if e != nil {
			return e
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

func scanJob(ctx context.Context, tx pgx.Tx, id string, j *domain.Job) error {
	return tx.QueryRow(ctx, `SELECT id,archive_id,state,error,provider_id,coalesce(connection_id::text,''),scope,created_at FROM captures WHERE id=$1`, id).Scan(&j.ID, &j.ArchiveID, &j.State, &j.Error, &j.ProviderID, &j.ConnectionID, &j.AccessScope, &j.CreatedAt)
}

func (s *Service) Job(ctx context.Context, t, id string) (j domain.Job, e error) {
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error { return scanJob(ctx, tx, id, &j) })
	return
}

func (s *Service) Usage(ctx context.Context, t string) (u domain.Usage, e error) {
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT used_bytes,reserved_bytes,quota_bytes FROM tenants WHERE id=$1`, t).Scan(&u.Used, &u.Reserved, &u.Limit)
	})
	return
}

func archive(ctx context.Context, tx pgx.Tx, id string) (a domain.Archive, e error) {
	var payload []byte
	var cid string
	e = tx.QueryRow(ctx, `SELECT a.id,a.url,a.external_id,a.provider_id,a.scope,r.id,r.payload,r.capture_id,a.observed_at,a.created_at FROM archives a JOIN revisions r ON r.id=a.current_revision AND r.tenant_id=a.tenant_id WHERE a.id=$1`, id).Scan(&a.ID, &a.URL, &a.ExternalID, &a.ProviderID, &a.AccessScope, &a.RevisionID, &payload, &cid, &a.ObservedAt, &a.CreatedAt)
	if e != nil {
		return
	}
	var p Payload
	if e = json.Unmarshal(payload, &p); e != nil {
		return
	}
	a.Text = p.Text
	a.TextKind = p.TextKind
	a.TextSource = p.TextSource
	a.AdapterVersion = p.Version
	a.Warnings = archiveWarnings(p.Warnings)
	a.Assets, e = assets(ctx, tx, cid)
	return
}

func (s *Service) Archive(ctx context.Context, t, id string) (a domain.Archive, e error) {
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error { var err error; a, err = archive(ctx, tx, id); return err })
	return
}

func assets(ctx context.Context, tx pgx.Tx, cid string) (out []domain.Asset, e error) {
	rows, e := tx.Query(ctx, `SELECT a.id,a.position,a.state,a.error,coalesce(b.hash,''),coalesce(b.mime,''),coalesce(b.size,0),coalesce(b.object_key,'') FROM assets a LEFT JOIN blobs b ON b.id=a.blob_id AND b.tenant_id=a.tenant_id WHERE a.capture_id=$1 ORDER BY a.position`, cid)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out = []domain.Asset{}
	for rows.Next() {
		var a domain.Asset
		if e = rows.Scan(&a.ID, &a.Position, &a.State, &a.Error, &a.Hash, &a.MIME, &a.Size, &a.Key); e != nil {
			return nil, e
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Service) Asset(ctx context.Context, t, id string) (a domain.Asset, e error) {
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT a.id,b.object_key,b.mime,b.size,b.hash FROM assets a JOIN blobs b ON b.id=a.blob_id AND b.tenant_id=a.tenant_id WHERE a.id=$1 AND a.state='ready'`, id).Scan(&a.ID, &a.Key, &a.MIME, &a.Size, &a.Hash)
	})
	return
}

func (s *Service) Recent(ctx context.Context, t, cursor string) (p domain.Page, e error) {
	p.Items = []domain.Archive{}
	var before *string
	if cursor != "" {
		b, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil {
			return p, fmt.Errorf("invalid cursor")
		}
		id := string(b)
		if _, err = uuid.Parse(id); err != nil {
			return p, fmt.Errorf("invalid cursor")
		}
		before = &id
	}
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		if before != nil {
			var x string
			if err := tx.QueryRow(ctx, `SELECT id FROM archives WHERE id=$1 AND current_revision IS NOT NULL`, *before).Scan(&x); err != nil {
				return err
			}
		}
		rows, err := tx.Query(ctx, `SELECT id FROM archives WHERE current_revision IS NOT NULL AND ($1::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM archives WHERE id=$1)) ORDER BY created_at DESC,id DESC LIMIT 11`, before)
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
		if len(ids) > 10 {
			p.NextCursor = base64.RawURLEncoding.EncodeToString([]byte(ids[9]))
			ids = ids[:10]
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
	Text       string   `json:"text"`
	TextKind   string   `json:"text_kind"`
	Warnings   []string `json:"warnings"`
	Version    string   `json:"adapter_version"`
	TextSource string   `json:"text_source,omitempty"`
	Incomplete bool     `json:"incomplete,omitempty"`
}

// Hide the retired provider disclaimer in existing snapshots as well.
func archiveWarnings(warnings []string) []string {
	var result []string
	for _, warning := range warnings {
		if warning != "第三方来源 xdown；文字可能仅为标题或摘要，完整性未经验证。" {
			result = append(result, warning)
		}
	}
	return result
}

// CaptureArchive pins delivery to the revision produced (or reused) by that capture.
func (s *Service) CaptureArchive(ctx context.Context, t, cid string) (a domain.Archive, e error) {
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		var raw []byte
		var assetCapture string
		err := tx.QueryRow(ctx, `SELECT a.id,a.url,a.external_id,a.provider_id,a.scope,r.id,r.payload,r.capture_id,a.observed_at,a.created_at FROM captures c JOIN archives a ON a.id=c.archive_id AND a.tenant_id=c.tenant_id JOIN revisions r ON r.id=c.revision_id AND r.tenant_id=c.tenant_id WHERE c.id=$1`, cid).Scan(&a.ID, &a.URL, &a.ExternalID, &a.ProviderID, &a.AccessScope, &a.RevisionID, &raw, &assetCapture, &a.ObservedAt, &a.CreatedAt)
		if err != nil {
			return err
		}
		var p Payload
		if err = json.Unmarshal(raw, &p); err != nil {
			return err
		}
		a.Text = p.Text
		a.TextKind = p.TextKind
		a.TextSource = p.TextSource
		a.AdapterVersion = p.Version
		a.Warnings = archiveWarnings(p.Warnings)
		a.Assets, err = assets(ctx, tx, assetCapture)
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
