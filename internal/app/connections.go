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
	"monitor/internal/domain"
	"monitor/internal/telegram"
)

var ErrConnection = errors.New("account unavailable; choose a source or authorize again")

type Connection struct{ ID, Name, State, AccountID string }

func (s *Service) ImportConnection(ctx context.Context, tenant, id, name string, c *pb.SessionCredential) (string, error) {
	return s.importConnection(ctx, tenant, id, name, c, false)
}

func (s *Service) importConnection(ctx context.Context, tenant, id, name string, c *pb.SessionCredential, createOnly bool) (string, error) {
	if !s.AdapterTLS || s.Vault == nil {
		return "", fmt.Errorf("account connections require TLS and credential encryption")
	}
	if _, e := s.requireProvider(ctx, "x-session", adapter.ConnectionCheck); e != nil {
		return "", e
	}
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
	result, e := s.Adapter.CheckConnection(call, &pb.CheckConnectionRequest{ProviderId: "x-session", Credential: c})
	if e != nil {
		return "", fmt.Errorf("account verification failed: %w", e)
	}
	e = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		if e := lockTenant(ctx, tx, tenant); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, `INSERT INTO account_credentials(id,tenant_id,ciphertext) VALUES($1,$2,$3)`, ref, tenant, encrypted); e != nil {
			return e
		}
		conflict := " ON CONFLICT(id) DO UPDATE SET name=excluded.name,account_id=excluded.account_id,state='ready',credential_ref=excluded.credential_ref,revision=connections.revision+1 WHERE connections.tenant_id=$2"
		if createOnly {
			conflict = " ON CONFLICT(id) DO NOTHING"
		}
		tag, e := tx.Exec(ctx, `INSERT INTO connections(id,tenant_id,adapter_id,provider_id,name,account_id,state,credential_ref) VALUES($1,$2,'x','x-session',$3,$4,'ready',$5)`+conflict, id, tenant, name, result.AccountId, ref)
		if e != nil {
			return e
		}
		if tag.RowsAffected() != 1 && !createOnly {
			return domain.ErrNotFound
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
		_, e = tx.Exec(ctx, `DELETE FROM account_credentials c WHERE c.tenant_id=$1 AND NOT EXISTS(SELECT FROM connections n WHERE n.credential_ref=c.id)`, tenant)
		return e
	})
}

func (s *Service) session(ctx context.Context, tenant, id string) (*pb.SessionCredential, int64, error) {
	if !s.AdapterTLS || s.Vault == nil {
		return nil, 0, ErrConnection
	}
	var ref string
	var raw []byte
	var revision int64
	e := s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT c.credential_ref,v.ciphertext,c.revision FROM connections c JOIN account_credentials v ON v.id=c.credential_ref AND v.tenant_id=c.tenant_id WHERE c.id=$1 AND c.adapter_id='x' AND c.provider_id='x-session' AND c.state='ready' AND c.tenant_id=$2`, id, tenant).Scan(&ref, &raw, &revision)
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
	e := tx.QueryRow(ctx, `SELECT revision,state FROM connections WHERE id=$1 AND adapter_id='x' AND provider_id='x-session' FOR SHARE`, id).Scan(&current, &state)
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
	if _, e := s.requireProvider(ctx, "x-session", adapter.ConnectionCheck); e != nil {
		return e
	}
	c, revision, e := s.session(ctx, tenant, id)
	if e != nil {
		return e
	}
	call, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	_, e = s.Adapter.CheckConnection(call, &pb.CheckConnectionRequest{ProviderId: "x-session", Credential: c})
	if status.Code(e) == codes.Unauthenticated {
		s.markReauth(ctx, tenant, id, revision)
	}
	return e
}

func (s *Service) markReauth(ctx context.Context, tenant, id string, revision int64) {
	_ = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `UPDATE connections SET state='reauth_required' WHERE id=$1 AND revision=$2 AND state='ready'`, id, revision)
		return e
	})
}

func (s *Service) DefaultConnection(ctx context.Context, tenant string) (string, error) {
	var id string
	e := s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT coalesce((SELECT default_connection_id::text FROM tenant_preferences),'')`).Scan(&id)
	})
	return id, e
}

func (s *Service) commandAccount(ctx context.Context, r *commandRequest) error {
	return s.DB.Tx(ctx, r.Task.Tenant, func(tx pgx.Tx) error {
		if e := lockTenant(ctx, tx, r.Task.Tenant); e != nil {
			return e
		}
		if r.Argument != "" {
			id := r.Argument
			if id == "public" {
				id = ""
			} else {
				if !s.AdapterTLS || s.Vault == nil {
					r.Text = "个人账号接入尚未配置。"
					return nil
				}
				var state string
				e := tx.QueryRow(ctx, `SELECT state FROM connections WHERE id=$1 AND adapter_id='x' AND provider_id='x-session'`, id).Scan(&state)
				if e != nil || state != "ready" {
					r.Text = "账号不可用，请重新授权或选择公共来源。"
					return nil
				}
			}
			if _, e := tx.Exec(ctx, `INSERT INTO tenant_preferences(tenant_id,default_connection_id) VALUES($1,nullif($2,'')::uuid) ON CONFLICT(tenant_id) DO UPDATE SET default_connection_id=excluded.default_connection_id`, r.Task.Tenant, id); e != nil {
				return e
			}
		}
		var selected string
		if e := tx.QueryRow(ctx, `SELECT coalesce((SELECT default_connection_id::text FROM tenant_preferences),'')`).Scan(&selected); e != nil {
			return e
		}
		r.Text = "选择保存新链接时使用的来源。此设置在私聊和群聊中通用。"
		label := "公共来源 · 无需账号"
		if selected == "" {
			label = "✓ " + label
		}
		r.Buttons = telegram.Keyboard{{{Text: label, Data: "/account public"}}}
		rows, e := tx.Query(ctx, `SELECT id,name,state FROM connections WHERE adapter_id='x' AND provider_id='x-session' ORDER BY name,id`)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var id, name, state string
			if e = rows.Scan(&id, &name, &state); e != nil {
				return e
			}
			if selected == id {
				name = "✓ " + name
			}
			if state != "ready" {
				name += "（需重新授权）"
			}
			r.Buttons = append(r.Buttons, []telegram.Button{{Text: name, Data: "/account " + id}})
		}
		if !strings.HasPrefix(r.Origin.ChatID, "-") {
			r.Buttons = append(r.Buttons, []telegram.Button{{Text: "添加账号", Data: "/account_add"}})
		}
		return rows.Err()
	})
}
