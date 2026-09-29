package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
	"monitor/internal/credentials"
	"monitor/internal/domain"
)

var ErrConnection = errors.New("account unavailable; choose a source or authorize again")

type Connection struct{ ID, Name, State, AccountID, Username string }

func (s *Service) ImportConnection(ctx context.Context, tenant, id, name string, c *pb.Credential) (string, error) {
	return s.importConnection(ctx, tenant, id, name, c, false)
}

func (s *Service) importConnection(ctx context.Context, tenant, id, name string, c *pb.Credential, createOnly bool) (string, error) {
	if !s.AdapterTLS || s.Vault == nil {
		return "", fmt.Errorf("account connections require TLS and credential encryption")
	}
	if createOnly && id != "" {
		saved, e := s.importedConnection(ctx, tenant, id)
		if e == nil {
			return saved, nil
		}
		if !errors.Is(e, domain.ErrNotFound) && !errors.Is(e, pgx.ErrNoRows) {
			return "", e
		}
	}
	d, e := s.descriptor(ctx)
	if e != nil {
		return "", e
	}
	var p *pb.Provider
	if id != "" {
		var savedAdapter, savedProvider string
		err := s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, "SELECT adapter_id,provider_id FROM connections WHERE id=$1 AND tenant_id=$2", id, tenant).Scan(&savedAdapter, &savedProvider)
		})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) && !errors.Is(err, domain.ErrNotFound) {
			return "", err
		}
		if err == nil {
			if savedAdapter != d.AdapterId {
				return "", ErrConnection
			}
			p, e = s.requireProvider(ctx, savedProvider, adapter.ConnectionCheck)
			if e != nil {
				return "", e
			}
		}
	}
	if p == nil {
		p, e = s.defaultProvider(ctx, "session")
		if e != nil {
			return "", e
		}
	}
	if _, e = s.requireProvider(ctx, p.Id, adapter.ConnectionCheck); e != nil {
		return "", e
	}
	if _, e = s.requireProvider(ctx, p.Id, adapter.CredentialPrepare); e != nil {
		return "", e
	}
	callPrepare, stopPrepare := context.WithTimeout(ctx, 10*time.Second)
	prepared, e := s.Adapter.PrepareCredential(callPrepare, &pb.PrepareCredentialRequest{ProviderId: p.Id, Input: c.GetData()})
	stopPrepare()
	if e != nil {
		return "", e
	}
	if prepared == nil || credentials.Validate(prepared.Credential) != nil {
		return "", fmt.Errorf("adapter returned invalid credential")
	}
	c = prepared.Credential
	if name == "" || len(name) > 100 {
		return "", fmt.Errorf("account name must contain 1–100 bytes")
	}
	if id == "" {
		id = uuid.NewString()
	} else {
		if _, e := uuid.Parse(id); e != nil {
			return "", e
		}
	}
	ref := uuid.NewString()
	encrypted, e := s.Vault.Seal(tenant, ref, c)
	if e != nil {
		return "", e
	}
	call, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	result, e := s.Adapter.CheckConnection(call, &pb.CheckConnectionRequest{ProviderId: p.Id, Credential: c})
	if e != nil {
		return "", fmt.Errorf("account verification failed: %w", e)
	}
	if result == nil || strings.TrimSpace(result.AccountId) == "" {
		return "", fmt.Errorf("adapter returned no verified account identity")
	}
	requestID := id
	e = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		if e := lockTenant(ctx, tx, tenant); e != nil {
			return e
		}

		if createOnly {
			var saved string
			err := tx.QueryRow(ctx, "SELECT connection_id FROM connection_imports WHERE request_id=$1 AND tenant_id=$2", requestID, tenant).Scan(&saved)
			if err == nil {
				id = saved
				return nil
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
		var existingID string
		err := tx.QueryRow(ctx, `SELECT id FROM connections WHERE adapter_id=$1 AND provider_id=$2 AND account_id=$3 AND state<>'revoked' AND tenant_id=$4`, d.AdapterId, p.Id, result.AccountId, tenant).Scan(&existingID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if existingID != "" {
			id = existingID
		}
		var oldAccount string
		err = tx.QueryRow(ctx, "SELECT coalesce(account_id,'') FROM connections WHERE id=$1 AND tenant_id=$2", id, tenant).Scan(&oldAccount)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if oldAccount != "" && oldAccount != result.AccountId {
			return ErrConnection
		}
		if _, e := tx.Exec(ctx, `INSERT INTO account_credentials(id,tenant_id,ciphertext) VALUES($1,$2,$3)`, ref, tenant, encrypted); e != nil {
			return e
		}
		tag, e := tx.Exec(ctx, `INSERT INTO connections(id,tenant_id,adapter_id,provider_id,name,account_id,state,credential_ref,username) VALUES($1,$2,$7,$8,$3,$4,'ready',$5,$6)
   ON CONFLICT(id) DO UPDATE SET name=excluded.name,account_id=excluded.account_id,username=excluded.username,state='ready',credential_ref=excluded.credential_ref,revision=connections.revision+1
   WHERE connections.tenant_id=$2 AND connections.adapter_id=$7 AND connections.provider_id=$8`, id, tenant, name, result.AccountId, ref, result.Username, d.AdapterId, p.Id)
		if e != nil {
			return e
		}
		if tag.RowsAffected() != 1 {
			return domain.ErrNotFound
		}
		if createOnly {
			if _, e = tx.Exec(ctx, "INSERT INTO connection_imports(tenant_id,request_id,connection_id) VALUES($1,$2,$3)", tenant, requestID, id); e != nil {
				return e
			}
		}

		// Import and selection commit together; replay must preserve later choices.
		if _, e = tx.Exec(ctx, `INSERT INTO tenant_preferences(tenant_id,adapter_id,default_connection_id) VALUES($1,$2,$3) ON CONFLICT(tenant_id,adapter_id) DO UPDATE SET default_connection_id=excluded.default_connection_id`, tenant, d.AdapterId, id); e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `DELETE FROM account_credentials c WHERE c.tenant_id=$1 AND NOT EXISTS(SELECT FROM connections n WHERE n.credential_ref=c.id)`, tenant)
		return e
	})
	return id, e
}

func (s *Service) RevokeConnection(ctx context.Context, tenant, id string) error {
	return s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		if e := lockTenant(ctx, tx, tenant); e != nil {
			return e
		}
		tag, e := tx.Exec(ctx, `UPDATE connections SET state='revoked',credential_ref=NULL,revision=revision+1 WHERE id=$1 AND tenant_id=$2`, id, tenant)
		if e != nil {
			return e
		}
		if tag.RowsAffected() != 1 {
			return domain.ErrNotFound
		}
		if _, e = tx.Exec(ctx, `UPDATE tenant_preferences SET default_connection_id=NULL WHERE tenant_id=$1 AND default_connection_id=$2`, tenant, id); e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `DELETE FROM account_credentials c WHERE c.tenant_id=$1 AND NOT EXISTS(SELECT FROM connections n WHERE n.credential_ref=c.id)`, tenant)
		return e
	})
}

func (s *Service) session(ctx context.Context, tenant, id string) (*pb.Credential, int64, error) {
	if !s.AdapterTLS || s.Vault == nil {
		return nil, 0, ErrConnection
	}
	if _, _, e := s.connectionProvider(ctx, tenant, id); e != nil {
		return nil, 0, e
	}
	var ref string
	var raw []byte
	var revision int64
	e := s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT c.credential_ref,v.ciphertext,c.revision FROM connections c JOIN account_credentials v ON v.id=c.credential_ref AND v.tenant_id=c.tenant_id WHERE c.id=$1 AND c.state='ready' AND c.tenant_id=$2`, id, tenant).Scan(&ref, &raw, &revision)
	})
	if errors.Is(e, pgx.ErrNoRows) || errors.Is(e, domain.ErrNotFound) {
		return nil, 0, ErrConnection
	}
	if e != nil {
		return nil, 0, e
	}
	c, e := s.Vault.Open(tenant, ref, raw)
	return c, revision, e
}

func validateExecution(ctx context.Context, tx pgx.Tx, id string, revision int64) error {
	if id == "" {
		return nil
	}
	var current int64
	var state string
	e := tx.QueryRow(ctx, `SELECT revision,state FROM connections WHERE id=$1 FOR SHARE`, id).Scan(&current, &state)
	if errors.Is(e, pgx.ErrNoRows) || e == nil && (current != revision || state != "ready") {
		return ErrConnection
	}
	return e
}

func validateCaptureConnection(ctx context.Context, tx pgx.Tx, cid string) error {
	var id string
	var revision int64
	e := tx.QueryRow(ctx, `SELECT coalesce(connection_id::text,''),coalesce(credential_revision,0) FROM captures WHERE id=$1`, cid).Scan(&id, &revision)
	if e != nil {
		return e
	}
	return validateExecution(ctx, tx, id, revision)
}

func (s *Service) CheckConnection(ctx context.Context, tenant, id string) error {
	if s.Registry != nil || len(s.adapterBindings()) > 0 {
		scoped, e := s.forConnection(ctx, tenant, id)
		if e != nil {
			return e
		}
		return scoped.CheckConnection(ctx, tenant, id)
	}

	d, err := s.descriptor(ctx)
	if err != nil {
		return err
	}
	supported := false
	for _, p := range d.Providers {
		if adapter.Supports(p, adapter.ConnectionCheck, 1, 0) {
			supported = true
		}
	}
	if !supported {
		return domain.ErrUnsupported
	}

	_, provider, e := s.connectionProvider(ctx, tenant, id)
	if e != nil {
		return e
	}
	if _, e = s.requireProvider(ctx, provider, adapter.ConnectionCheck); e != nil {
		return e
	}
	c, revision, e := s.session(ctx, tenant, id)
	if e != nil {
		return e
	}
	call, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	result, e := s.Adapter.CheckConnection(call, &pb.CheckConnectionRequest{ProviderId: provider, Credential: c})
	if status.Code(e) == codes.Unauthenticated {
		s.markReauth(ctx, tenant, id, revision)
	}
	if e != nil {
		return e
	}
	return s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE connections SET username=$4 WHERE id=$1 AND revision=$2 AND state='ready' AND account_id=$3`, id, revision, result.AccountId, result.Username)
		if err == nil && tag.RowsAffected() != 1 {
			return ErrConnection
		}
		return err
	})
}

func (s *Service) markReauth(ctx context.Context, tenant, id string, revision int64) {
	_ = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `UPDATE connections SET state='reauth_required' WHERE id=$1 AND revision=$2 AND state='ready'`, id, revision)
		return e
	})
}

func (s *Service) DefaultConnection(ctx context.Context, tenant string) (string, error) {
	d, e := s.descriptor(ctx)
	if e != nil {
		return "", e
	}
	var id string
	e = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT coalesce((SELECT default_connection_id::text FROM tenant_preferences WHERE adapter_id=$1),'')`, d.AdapterId).Scan(&id)
	})
	return id, e
}

func (s *Service) importedConnection(ctx context.Context, tenant, request string) (string, error) {
	var id string
	e := s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT connection_id FROM connection_imports WHERE request_id=$1 AND tenant_id=$2 UNION ALL SELECT id FROM connections WHERE id=$1 AND tenant_id=$2 LIMIT 1`, request, tenant).Scan(&id)
	})
	return id, e
}
