package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"monitor/internal/domain"
	"monitor/internal/store"
)

var ErrInvalidFilter = errors.New("invalid collection filters")

type (
	CollectionFilter struct{ Q, Media, Visibility, From, Before, Sort, Order string }
	collectionCursor struct {
		Time       time.Time
		ID, Filter string
	}
)

type CollectionItem struct {
	domain.Collection
	SavedAt time.Time `json:"saved_at"`
}
type CollectionPage struct {
	Items []CollectionItem `json:"items"`
	Next  string           `json:"next_cursor,omitempty"`
}

func (s *Service) Collections(ctx context.Context, t string, f CollectionFilter, cursor string) (p CollectionPage, e error) {
	p.Items = []CollectionItem{}
	if (f.Order != "" && f.Order != "desc" && f.Order != "asc") || (f.Sort != "" && f.Sort != "captured" && f.Sort != "published") || utf8.RuneCountInString(f.Q) > 500 || (f.Media != "" && f.Media != "image" && f.Media != "video" && f.Media != "text") || (f.Visibility != "" && f.Visibility != "public" && f.Visibility != "private") {
		return p, ErrInvalidFilter
	}
	var from, before *time.Time
	for _, v := range []struct {
		raw string
		out **time.Time
	}{{f.From, &from}, {f.Before, &before}} {
		if v.raw != "" {
			x, err := time.Parse(time.RFC3339, v.raw)
			if err != nil {
				return p, ErrInvalidFilter
			}
			*v.out = &x
		}
	}
	if from != nil && before != nil && !from.Before(*before) {
		return p, ErrInvalidFilter
	}
	raw, _ := json.Marshal(f)
	fingerprint := store.Hash(string(raw))
	var anchor *time.Time
	var aid *string
	if cursor != "" {
		b, err := base64.RawURLEncoding.DecodeString(cursor)
		var c collectionCursor
		if err != nil || json.Unmarshal(b, &c) != nil || c.Filter != fingerprint || c.Time.IsZero() {
			return p, fmt.Errorf("invalid cursor")
		}
		if _, err = uuid.Parse(c.ID); err != nil {
			return p, fmt.Errorf("invalid cursor")
		}
		anchor = &c.Time
		aid = &c.ID
	}
	q := "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(strings.TrimSpace(f.Q)) + "%"
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		query := `SELECT a.id,ta.created_at,ordering.at FROM tenant_collections ta JOIN collections a ON a.id=ta.collection_id JOIN revisions r ON r.id=a.current_revision CROSS JOIN LATERAL (SELECT CASE WHEN $8='published' AND pg_input_is_valid(r.payload->>'published_at','timestamp with time zone') THEN (r.payload->>'published_at')::timestamptz ELSE a.observed_at END AS at) ordering WHERE ($1='%%' OR concat_ws(' ',r.payload->>'text',r.payload->>'summary',r.payload->>'author_name') ILIKE $1) AND ($2='' OR a.visibility=$2) AND ($3::timestamptz IS NULL OR ta.created_at >= $3) AND ($4::timestamptz IS NULL OR ta.created_at < $4) AND ($5::timestamptz IS NULL OR (ordering.at,a.id)<($5,$6::uuid)) AND ($7='' OR ($7='text' AND NOT EXISTS(SELECT FROM assets m WHERE m.capture_id=r.capture_id AND m.purpose='')) OR EXISTS(SELECT FROM assets m JOIN blobs b ON b.id=m.blob_id WHERE m.capture_id=r.capture_id AND m.purpose='' AND (($7='image' AND b.mime LIKE 'image/%') OR ($7='video' AND b.mime LIKE 'video/%')))) ORDER BY ordering.at DESC,a.id DESC LIMIT 21`
		if f.Order == "asc" {
			query = strings.ReplaceAll(query, "(ordering.at,a.id)<", "(ordering.at,a.id)>")
			query = strings.ReplaceAll(query, "ordering.at DESC,a.id DESC", "ordering.at ASC,a.id ASC")
		}
		rows, err := tx.Query(ctx, query, q, f.Visibility, from, before, anchor, aid, f.Media, f.Sort)
		if err != nil {
			return err
		}
		type entry struct {
			id    string
			at    time.Time
			saved time.Time
		}
		entries := []entry{}
		for rows.Next() {
			var x entry
			if err = rows.Scan(&x.id, &x.saved, &x.at); err != nil {
				rows.Close()
				return err
			}
			entries = append(entries, x)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if len(entries) > 20 {
			entries = entries[:20]
			last := entries[19]
			b, _ := json.Marshal(collectionCursor{last.at, last.id, fingerprint})
			p.Next = base64.RawURLEncoding.EncodeToString(b)
		}
		for _, v := range entries {
			a, err := collection(ctx, tx, v.id)
			if err != nil {
				return err
			}
			p.Items = append(p.Items, CollectionItem{a, v.saved})
		}
		return nil
	})
	return
}

type RevisionInfo struct {
	ID        string    `json:"id"`
	CreatedAt time.Time `json:"created_at"`
}
type RevisionPage struct {
	Items []RevisionInfo `json:"items"`
	Next  string         `json:"next_cursor,omitempty"`
}

func (s *Service) Revisions(ctx context.Context, t, id, cursor string) (p RevisionPage, e error) {
	p.Items = []RevisionInfo{}
	var at *time.Time
	var rid *string
	if cursor != "" {
		b, err := base64.RawURLEncoding.DecodeString(cursor)
		var c collectionCursor
		if err != nil || json.Unmarshal(b, &c) != nil || c.Filter != id || c.Time.IsZero() {
			return p, fmt.Errorf("invalid cursor")
		}
		if _, err = uuid.Parse(c.ID); err != nil {
			return p, fmt.Errorf("invalid cursor")
		}
		at = &c.Time
		rid = &c.ID
	}
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM tenant_collections WHERE collection_id=$1)`, id).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return domain.ErrNotFound
		}
		rows, err := tx.Query(ctx, `SELECT id,created_at FROM revisions WHERE collection_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 21`, id, at, rid)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v RevisionInfo
			if err = rows.Scan(&v.ID, &v.CreatedAt); err != nil {
				return err
			}
			p.Items = append(p.Items, v)
		}
		return rows.Err()
	})
	if len(p.Items) > 20 {
		p.Items = p.Items[:20]
		v := p.Items[19]
		b, _ := json.Marshal(collectionCursor{v.CreatedAt, v.ID, id})
		p.Next = base64.RawURLEncoding.EncodeToString(b)
	}
	return
}

func (s *Service) Revision(ctx context.Context, t, id, rid string) (a domain.Collection, e error) {
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		var raw []byte
		var cid string
		err := tx.QueryRow(ctx, `SELECT a.id,a.url,a.external_id,a.provider_id,a.scope,a.visibility,r.id,r.payload,r.capture_id,r.created_at,a.created_at FROM collections a JOIN tenant_collections ta ON ta.collection_id=a.id JOIN revisions r ON r.collection_id=a.id WHERE a.id=$1 AND r.id=$2`, id, rid).Scan(&a.ID, &a.URL, &a.ExternalID, &a.ProviderID, &a.AccessScope, &a.Visibility, &a.RevisionID, &raw, &cid, &a.ObservedAt, &a.CreatedAt)
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
		all, err := assets(ctx, tx, cid)
		if err != nil {
			return err
		}
		hydrateGraph(&a, p, all)
		return nil
	})
	return
}

// Web sessions browse only saved content, even when the underlying content is public.
func (s *Service) WebAccess(ctx context.Context, t, kind, id string) error {
	return s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		var yes bool
		var query string
		switch kind {
		case "collections":
			query = `SELECT EXISTS(SELECT FROM tenant_collections WHERE collection_id=$1)`
		case "assets":
			query = `SELECT EXISTS(SELECT FROM assets m JOIN revisions r ON r.capture_id=m.capture_id JOIN tenant_collections ta ON ta.collection_id=r.collection_id WHERE m.id=$1)`
		case "entities":
			query = `SELECT EXISTS(SELECT FROM entity_versions ev JOIN revision_entities re ON re.entity_version_id=ev.id JOIN revisions r ON r.id=re.revision_id JOIN tenant_collections ta ON ta.collection_id=r.collection_id WHERE ev.entity_id=$1)`
		default:
			return domain.ErrNotFound
		}
		if err := tx.QueryRow(ctx, query, id).Scan(&yes); err != nil {
			return err
		}
		if !yes {
			return domain.ErrNotFound
		}
		return nil
	})
}

func (s *Service) SavedCollection(ctx context.Context, tenant, id string) (item CollectionItem, err error) {
	err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		if e := tx.QueryRow(ctx, `SELECT created_at FROM tenant_collections WHERE collection_id=$1`, id).Scan(&item.SavedAt); e != nil {
			return e
		}
		var e error
		item.Collection, e = collection(ctx, tx, id)
		return e
	})
	return
}
