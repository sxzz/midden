package app

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"monitor/internal/domain"
)

// SavePublicCollection adds only a tenant reference, without fetching or delivering content.
func (s *Service) SavePublicCollection(ctx context.Context, tenant, id string) (added bool, err error) {
	if _, e := uuid.Parse(id); e != nil {
		return false, domain.ErrNotFound
	}
	if s.Registry != nil || len(s.adapterBindings()) > 0 {
		var raw string
		err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, "SELECT url FROM collections WHERE id=$1 AND visibility='public'", id).Scan(&raw)
		})
		if err != nil {
			return false, err
		}
		scoped, e := s.forURL(ctx, raw)
		if e != nil {
			return false, e
		}
		return scoped.SavePublicCollection(ctx, tenant, id)
	}
	d, err := s.descriptor(ctx)
	if err != nil {
		return false, err
	}
	p, err := s.defaultProvider(ctx, "none")
	if err != nil {
		return false, err
	}
	err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		if err := lockTenant(ctx, tx, tenant); err != nil {
			return err
		}
		var collection string
		if err := tx.QueryRow(ctx, `SELECT id FROM collections WHERE id=$1 AND visibility='public' AND current_revision IS NOT NULL FOR UPDATE`, id).Scan(&collection); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return domain.ErrNotFound
			}
			return err
		}
		tag, err := tx.Exec(ctx, `INSERT INTO tenant_collections(tenant_id,collection_id,provider_id,adapter_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, tenant, collection, p.Id, d.AdapterId)
		if err != nil {
			return err
		}
		added = tag.RowsAffected() > 0
		if added {
			var within bool
			if err := tx.QueryRow(ctx, `SELECT tenant_unlimited() OR tenant_usage()+reserved_bytes<=quota_bytes FROM tenants WHERE id=$1`, tenant).Scan(&within); err != nil {
				return err
			}
			if !within {
				return domain.ErrQuota
			}
		}
		_, err = tx.Exec(ctx, `UPDATE collections SET unreferenced_at=NULL WHERE id=$1`, collection)
		return err
	})
	if err != nil {
		added = false
	}
	return
}
