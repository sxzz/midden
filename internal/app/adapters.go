package app

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
	"monitor/internal/domain"
)

type AdapterBinding struct {
	Client     pb.AdapterClient
	Descriptor *pb.DescribeResponse
	TLS        bool
	Schemas    map[string]adapter.EntitySchema
}

func (s *Service) forAdapter(id string) (*Service, error) {
	if len(s.adapterBindings()) == 0 {
		if s.Registry != nil {
			return nil, ErrAdapterUnavailable
		}
		return s, nil
	}
	b, ok := s.adapterBindings()[id]
	if !ok {
		if s.Registry != nil {
			return nil, ErrAdapterUnavailable
		}
		return nil, domain.ErrUnsupported
	}
	scoped := *s
	scoped.Adapters = nil
	scoped.Registry = nil
	scoped.Adapter = b.Client
	scoped.Descriptor = b.Descriptor
	scoped.Providers = b.Descriptor.Providers
	scoped.AdapterTLS = b.TLS
	scoped.EntitySchemas = b.Schemas
	return &scoped, nil
}

func (s *Service) adapterIDs() []string {
	ids := make([]string, 0, len(s.adapterBindings()))
	for id := range s.adapterBindings() {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func (s *Service) forURL(ctx context.Context, raw string) (*Service, error) {
	if len(s.adapterBindings()) == 0 {
		if s.Registry != nil {
			return nil, ErrAdapterUnavailable
		}
		return s, nil
	}
	u, e := url.Parse(raw)
	if e != nil {
		return nil, domain.ErrInvalidTarget
	}
	var selected *Service
	for _, id := range s.adapterIDs() {
		b := s.adapterBindings()[id]
		for _, host := range b.Descriptor.Hosts {
			if strings.EqualFold(u.Hostname(), host) {
				if selected != nil {
					return nil, fmt.Errorf("ambiguous adapter URL")
				}
				selected, e = s.forAdapter(id)
				if e != nil {
					return nil, e
				}
				break
			}
		}
	}
	if selected == nil {
		return nil, domain.ErrInvalidTarget
	}
	return selected, nil
}

func (s *Service) forConnection(ctx context.Context, tenant, id string) (*Service, error) {
	if len(s.adapterBindings()) == 0 {
		if s.Registry != nil {
			return nil, ErrAdapterUnavailable
		}
		return s, nil
	}
	var adapterID string
	e := s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, "SELECT adapter_id FROM connections WHERE id=$1", id).Scan(&adapterID)
	})
	if e != nil {
		return nil, ErrConnection
	}
	return s.forAdapter(adapterID)
}

func (s *Service) connectionForURL(ctx context.Context, tenant, raw string) (string, error) {
	scoped, e := s.forURL(ctx, raw)
	if e != nil {
		return "", e
	}
	return scoped.DefaultConnection(ctx, tenant)
}

func validAdapterID(id string) bool {
	return regexp.MustCompile(`^[a-zA-Z0-9_-]{1,32}$`).MatchString(id)
}
