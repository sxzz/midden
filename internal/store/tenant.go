package store

import (
	"context"
	"errors"
)

var ErrTenantInUse = errors.New("tenant still has saved collections or running captures")

// DeleteTenant removes a tenant that saves nothing. Content it fetched stays
// available to others; only its account data and private raw responses go.
// It needs the administrative connection, which bypasses row security.
func (s *Store) DeleteTenant(ctx context.Context, tenant string) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id string
	if err = tx.QueryRow(ctx, `SELECT id FROM tenants WHERE id=$1 FOR UPDATE`, tenant).Scan(&id); err != nil {
		return translate(err)
	}
	var busy bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM tenant_collections WHERE tenant_id=$1) OR EXISTS(SELECT FROM captures WHERE tenant_id=$1 AND state IN ('queued','downloading'))`, tenant).Scan(&busy); err != nil {
		return err
	}
	if busy {
		return ErrTenantInUse
	}
	for _, statement := range []string{
		// Shared content keeps its history without the departed executor.
		`UPDATE captures SET tenant_id=NULL,connection_id=NULL WHERE tenant_id=$1`,
		`DELETE FROM source_responses WHERE tenant_id=$1 AND visibility='private'`,
		`UPDATE source_responses SET tenant_id=NULL WHERE tenant_id=$1`,
		`DELETE FROM channel_work WHERE tenant_id=$1`,
		`DELETE FROM replies WHERE tenant_id=$1`,
		`DELETE FROM inbox WHERE tenant_id=$1`,
		`DELETE FROM submissions WHERE tenant_id=$1`,
		`DELETE FROM identities WHERE tenant_id=$1`,
		`DELETE FROM tags WHERE tenant_id=$1`,
		`DELETE FROM tokens WHERE tenant_id=$1`,
		`DELETE FROM tenant_preferences WHERE tenant_id=$1`,
		`DELETE FROM connections WHERE tenant_id=$1`,
		`DELETE FROM account_credentials WHERE tenant_id=$1`,
		`DELETE FROM tenants WHERE id=$1`,
	} {
		if _, err = tx.Exec(ctx, statement, tenant); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
