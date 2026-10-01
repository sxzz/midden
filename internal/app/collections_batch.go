package app

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	"monitor/internal/domain"
)

// Load only the selected page. Keep each one-to-many relation in a separate
// query so media and graph entities do not multiply the collection rows.
// The caller restores pagination order using the IDs from its selection query.
func collectionsByID(ctx context.Context, tx pgx.Tx, ids []string) (map[string]domain.Collection, error) {
	out := make(map[string]domain.Collection, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := tx.Query(ctx, `SELECT a.id,a.url,a.external_id,a.provider_id,r.visibility,r.visibility,r.id,r.payload,r.capture_id,a.observed_at,a.created_at FROM collections a CROSS JOIN LATERAL (SELECT head.* FROM revisions head WHERE head.collection_id=a.id ORDER BY head.created_at DESC,head.id DESC LIMIT 1) r WHERE a.id=ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, err
	}
	type entry struct {
		collection domain.Collection
		payload    Payload
		capture    string
	}
	entries := []entry{}
	captures := []string{}
	for rows.Next() {
		var v entry
		var raw []byte
		a := &v.collection
		if err = rows.Scan(&a.ID, &a.URL, &a.ExternalID, &a.ProviderID, &a.AccessScope, &a.Visibility, &a.RevisionID, &raw, &v.capture, &a.ObservedAt, &a.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		if err = json.Unmarshal(raw, &v.payload); err != nil {
			rows.Close()
			return nil, err
		}
		p := v.payload
		a.AuthorName = p.AuthorName
		a.PublishedAt = p.PublishedAt
		a.Summary = p.Summary
		a.Text = p.Text
		a.TextKind = p.TextKind
		a.TextSource = p.TextSource
		a.AdapterVersion = p.Version
		a.Warnings = p.Warnings
		entries = append(entries, v)
		captures = append(captures, v.capture)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return out, nil
	}
	media, err := assetsByCapture(ctx, tx, captures)
	if err != nil {
		return nil, err
	}
	collections := make([]*domain.Collection, len(entries))
	for i := range entries {
		v := &entries[i]
		hydrateGraph(&v.collection, v.payload, media[v.capture])
		collections[i] = &v.collection
	}
	if err = linkSavedEntities(ctx, tx, collections...); err != nil {
		return nil, err
	}
	for _, v := range entries {
		out[v.collection.ID] = v.collection
	}
	return out, nil
}
