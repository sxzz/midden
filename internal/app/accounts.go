package app

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
	"monitor/internal/domain"
)

var (
	ErrInvalidCredential = errors.New("invalid credentials")
	ErrInvalidAccount    = errors.New("invalid account request")
)

// AccountPlatform is one adapter's source choice as shown on the web.
type AccountPlatform struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Help     string `json:"help,omitempty"`
	Public   bool   `json:"public"`
	CanAdd   bool   `json:"can_add"`
	Selected string `json:"selected_account_id,omitempty"`
}

// Account never carries credential material.
type Account struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Username string `json:"username,omitempty"`
	State    string `json:"state"`
	Platform string `json:"platform"`
	Selected bool   `json:"selected"`
}

type Accounts struct {
	Platforms []AccountPlatform `json:"platforms"`
	Accounts  []Account         `json:"accounts"`
}

func (s *Service) Accounts(ctx context.Context, tenant string) (Accounts, error) {
	list, e := s.channelAccounts(ctx, tenant)
	out := Accounts{Platforms: []AccountPlatform{}, Accounts: []Account{}}
	for _, p := range list.Platforms {
		out.Platforms = append(out.Platforms, AccountPlatform{ID: p.ID, Name: p.Name, Help: p.Help, Public: p.Public, CanAdd: p.CanAdd, Selected: p.Selected})
	}
	for _, a := range list.Accounts {
		out.Accounts = append(out.Accounts, Account{ID: a.ID, Name: a.Name, Username: a.Username, State: a.State, Platform: a.Adapter, Selected: a.Selected})
	}
	return out, e
}

// AddAccount verifies and stores a credential, then selects it for its
// platform. Adding the same upstream account again replaces its credential.
func (s *Service) AddAccount(ctx context.Context, tenant, platform, name, credential string) (Account, error) {
	var out Account
	if credential == "" || len(name) > 100 {
		return out, ErrInvalidAccount
	}
	if name == "" {
		name = "采集账号"
	}
	list, e := s.channelAccounts(ctx, tenant)
	if e != nil {
		return out, e
	}
	allowed := false
	for _, p := range list.Platforms {
		if p.ID == platform && p.CanAdd {
			allowed = true
		}
	}
	if !allowed {
		return out, fmt.Errorf("%w: platform does not accept accounts", domain.ErrUnsupported)
	}
	scoped, e := s.forAdapter(platform)
	if e != nil {
		return out, e
	}
	id, e := scoped.ImportConnection(ctx, tenant, "", name, &pb.Credential{Data: []byte(credential)})
	if e != nil {
		switch status.Code(e) {
		case codes.InvalidArgument, codes.Unauthenticated, codes.PermissionDenied, codes.FailedPrecondition:
			return out, ErrInvalidCredential
		}
		return out, e
	}
	e = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT c.id,c.name,c.state,coalesce(c.username,''),c.adapter_id,coalesce(p.default_connection_id=c.id,false) FROM connections c LEFT JOIN tenant_preferences p ON p.adapter_id=c.adapter_id WHERE c.id=$1`, id).Scan(&out.ID, &out.Name, &out.State, &out.Username, &out.Platform, &out.Selected)
	})
	return out, e
}

// SelectAccount chooses the source for new captures on one platform; an empty
// connection selects the platform's public source.
func (s *Service) SelectAccount(ctx context.Context, tenant, platform, connection string) error {
	var scoped *Service
	var e error
	if connection == "" {
		scoped, e = s.forAdapter(platform)
		if e == nil {
			_, e = scoped.defaultProvider(ctx, "none")
		}
	} else {
		if _, err := uuid.Parse(connection); err != nil {
			return domain.ErrNotFound
		}
		scoped, e = s.forConnection(ctx, tenant, connection)
	}
	if e != nil {
		return e
	}
	d, e := scoped.descriptor(ctx)
	if e != nil {
		return e
	}
	if connection != "" && platform != "" && d.AdapterId != platform {
		return domain.ErrNotFound
	}
	return s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		if connection != "" {
			var state string
			e := tx.QueryRow(ctx, `SELECT state FROM connections WHERE id=$1`, connection).Scan(&state)
			if errors.Is(e, pgx.ErrNoRows) {
				return domain.ErrNotFound
			}
			if e != nil {
				return e
			}
			if state != "ready" {
				return ErrConnection
			}
		}
		_, e := tx.Exec(ctx, `INSERT INTO tenant_preferences(tenant_id,adapter_id,default_connection_id) VALUES($1,$2,nullif($3,'')::uuid) ON CONFLICT(tenant_id,adapter_id) DO UPDATE SET default_connection_id=excluded.default_connection_id`, tenant, d.AdapterId, connection)
		return e
	})
}
