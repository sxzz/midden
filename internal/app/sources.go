package app

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/domain"
	"monitor/internal/store"
)

// maxSourceBytes bounds the raw response bodies one capture keeps. Their number
// is not limited: an adapter may read as many pages as fit.
const maxSourceBytes = 4 << 20

// keepSourceResponses keeps the raw responses that fit maxSourceBytes, in the
// order the adapter returned them, and reports how many it dropped. Raw
// responses only record how content was fetched; losing some must not discard
// the content.
func keepSourceResponses(r *pb.FetchResponse) int {
	n := 0
	for i, v := range r.SourceResponses {
		if v != nil {
			n += len(v.Body)
		}
		if n > maxSourceBytes {
			dropped := len(r.SourceResponses) - i
			r.SourceResponses = r.SourceResponses[:i]
			return dropped
		}
	}
	return 0
}

func sourceBytes(r *pb.FetchResponse, account bool) (int, error) {
	n := 0
	for _, v := range r.SourceResponses {
		if v == nil || len(v.Body) == 0 || !json.Valid(v.Body) || v.ContentType == "" || len(v.SourceUrl) > 8192 {
			return 0, &PermanentError{"invalid source response"}
		}
		if v.Visibility != pb.Visibility_VISIBILITY_PUBLIC && v.Visibility != pb.Visibility_VISIBILITY_PRIVATE {
			return 0, &PermanentError{"missing source visibility"}
		}
		if account && v.Visibility != pb.Visibility_VISIBILITY_PRIVATE {
			return 0, &PermanentError{"account source response must be private"}
		}
		n += len(v.Body)
	}
	if n > maxSourceBytes {
		return 0, &PermanentError{"source responses exceed limit"}
	}
	return n, nil
}

func persistSources(ctx context.Context, tx pgx.Tx, tenant, cid string, r *pb.FetchResponse) error {
	for i, v := range r.SourceResponses {
		visibility := "private"
		if v.Visibility == pb.Visibility_VISIBILITY_PUBLIC {
			visibility = "public"
		}
		if _, e := tx.Exec(ctx, `INSERT INTO source_responses(tenant_id,capture_id,position,visibility,body,content_type,source_url,sha256,size,unreferenced_at) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $4='private' AND NOT EXISTS(SELECT FROM tenant_collections ta JOIN captures c ON c.collection_id=ta.collection_id WHERE c.id=$2 AND ta.tenant_id=$1) THEN now() END ON CONFLICT(capture_id,position) DO NOTHING`, tenant, cid, i, visibility, v.Body, v.ContentType, v.SourceUrl, store.Hash(string(v.Body)), len(v.Body)); e != nil {
			return e
		}
	}
	return nil
}

func (s *Service) Sources(ctx context.Context, tenant, collection string) (out []domain.SourceResponse, err error) {
	out = []domain.SourceResponse{}
	err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		var owns bool
		if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM tenant_collections WHERE collection_id=$1)`, collection).Scan(&owns); e != nil {
			return e
		}
		if !owns {
			return domain.ErrNotFound
		}
		rows, e := tx.Query(ctx, `SELECT sr.id,sr.capture_id,c.provider_id,c.adapter_version,sr.visibility,sr.content_type,sr.source_url,sr.sha256,sr.size,sr.created_at FROM source_responses sr JOIN captures c ON c.id=sr.capture_id WHERE c.collection_id=$1 AND c.state IN ('complete','partial') ORDER BY sr.created_at DESC,sr.id DESC LIMIT 100`, collection)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var v domain.SourceResponse
			if e = rows.Scan(&v.ID, &v.CaptureID, &v.ProviderID, &v.AdapterVersion, &v.Visibility, &v.ContentType, &v.SourceURL, &v.SHA256, &v.Size, &v.CreatedAt); e != nil {
				return e
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	return
}

func (s *Service) Source(ctx context.Context, tenant, id string) (v domain.SourceResponse, e error) {
	e = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT sr.id,sr.body,sr.content_type FROM source_responses sr JOIN captures c ON c.id=sr.capture_id JOIN tenant_collections ta ON ta.collection_id=c.collection_id WHERE sr.id=$1 AND c.state IN ('complete','partial')`, id).Scan(&v.ID, &v.Body, &v.ContentType)
	})
	return
}
