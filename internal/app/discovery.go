package app

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
	"monitor/internal/domain"
)

func (s *Service) descriptor(ctx context.Context) (*pb.DescribeResponse, error) {
	if s.Registry != nil {
		return nil, ErrAdapterUnavailable
	}
	if s.Descriptor != nil {
		return s.Descriptor, nil
	}
	if s.Adapter == nil {
		return nil, domain.ErrUnsupported
	}
	call, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	d, err := s.Adapter.Describe(call, &pb.DescribeRequest{})
	if err != nil {
		return nil, err
	}
	if err = adapter.Validate(d); err != nil {
		return nil, err
	}
	if s.Providers != nil {
		d.Providers = s.Providers
	}
	return d, nil
}

func (s *Service) defaultProvider(ctx context.Context, authentication string) (*pb.Provider, error) {
	d, err := s.descriptor(ctx)
	if err != nil {
		return nil, err
	}
	var found *pb.Provider
	for _, p := range d.Providers {
		if p.Authentication == authentication && p.DefaultProvider {
			if found != nil {
				return nil, fmt.Errorf("ambiguous default provider")
			}
			found = p
		}
	}
	if found == nil {
		return nil, domain.ErrUnsupported
	}
	return found, nil
}

func (s *Service) Resolve(ctx context.Context, raw string) (domain.Target, error) {
	var target domain.Target
	if s.Registry != nil || len(s.adapterBindings()) > 0 {
		scoped, e := s.forURL(ctx, raw)
		if e != nil {
			return target, e
		}
		return scoped.Resolve(ctx, raw)
	}
	if err := domain.ValidateURL(raw); err != nil {
		return target, domain.ErrInvalidTarget
	}
	if s.Adapter == nil {
		return target, domain.ErrUnsupported
	}
	d, err := s.descriptor(ctx)
	if err != nil {
		return target, err
	}
	enabled := false
	for _, p := range d.Providers {
		enabled = enabled || adapter.Supports(p, adapter.CaptureFetch, 1, 0)
	}
	if !enabled {
		return target, domain.ErrUnsupported
	}
	call, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	r, err := s.Adapter.Resolve(call, &pb.ResolveRequest{Url: raw})
	if status.Code(err) == codes.InvalidArgument {
		return target, domain.ErrInvalidTarget
	}
	if err != nil {
		return target, err
	}
	if r == nil || domain.ValidateURL(r.Url) != nil || strings.TrimSpace(r.Platform) == "" || strings.TrimSpace(r.Kind) == "" || strings.TrimSpace(r.ExternalId) == "" {
		return target, fmt.Errorf("adapter returned invalid target")
	}
	return domain.Target{URL: r.Url, ExternalID: r.ExternalId, Platform: r.Platform, Kind: r.Kind, ObjectScope: r.ObjectScope, RefreshOnSubmit: r.RefreshOnSubmit, Collection: r.Collection}, nil
}

func (s *Service) connectionProvider(ctx context.Context, tenant, id string) (string, string, error) {
	var adapterID, provider string
	err := s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, "SELECT adapter_id,provider_id FROM connections WHERE id=$1 AND tenant_id=$2", id, tenant).Scan(&adapterID, &provider)
	})
	if err != nil {
		return "", "", ErrConnection
	}
	d, err := s.descriptor(ctx)
	if err != nil {
		return "", "", err
	}
	if d.AdapterId != adapterID {
		return "", "", ErrConnection
	}
	return adapterID, provider, nil
}
