package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
)

var ErrAdapterUnavailable = errors.New("adapter temporarily unavailable")

type AdapterEndpoint struct {
	Client pb.AdapterClient
	TLS    bool
}
type AdapterRegistry struct {
	mu        sync.RWMutex
	bindings  map[string]AdapterBinding
	available map[string]bool
	ids       map[int]string
	Endpoints []AdapterEndpoint
}

func NewAdapterRegistry(endpoints []AdapterEndpoint) *AdapterRegistry {
	return &AdapterRegistry{bindings: map[string]AdapterBinding{}, available: map[string]bool{}, ids: map[int]string{}, Endpoints: endpoints}
}
func (r *AdapterRegistry) snapshot() map[string]AdapterBinding {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.bindings
}
func (s *Service) adapterBindings() map[string]AdapterBinding {
	if s.Registry != nil {
		return s.Registry.snapshot()
	}
	return s.Adapters
}
func (r *AdapterRegistry) Refresh(ctx context.Context) error {
	r.mu.RLock()
	bindings := map[string]AdapterBinding{}
	for k, v := range r.bindings {
		bindings[k] = v
	}
	available := map[string]bool{}
	ids := map[int]string{}
	for k, v := range r.ids {
		ids[k] = v
	}
	r.mu.RUnlock()
	for i, endpoint := range r.Endpoints {
		call, cancel := context.WithTimeout(ctx, 5*time.Second)
		d, e := endpoint.Client.Describe(call, &pb.DescribeRequest{})
		cancel()
		if e != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			code := status.Code(e)
			if code != codes.Unavailable && code != codes.DeadlineExceeded {
				return fmt.Errorf("adapter discovery failed: %s", code)
			}
			continue
		}
		if e = adapter.Validate(d); e != nil {
			return e
		}
		if !validAdapterID(d.AdapterId) {
			return fmt.Errorf("invalid adapter ID")
		}
		if old := ids[i]; old != "" && old != d.AdapterId {
			return fmt.Errorf("adapter changed identity")
		}
		for other, id := range ids {
			if other != i && id == d.AdapterId {
				return fmt.Errorf("duplicate adapter ID")
			}
		}
		schemas, e := adapter.CompileEntityTypes(d)
		if e != nil {
			return e
		}
		ids[i] = d.AdapterId
		bindings[d.AdapterId] = AdapterBinding{Client: endpoint.Client, Descriptor: d, TLS: endpoint.TLS, Schemas: schemas}
		available[d.AdapterId] = true
	}
	hosts := map[string]bool{}
	for _, b := range bindings {
		for _, host := range b.Descriptor.Hosts {
			host = strings.ToLower(host)
			if hosts[host] {
				return fmt.Errorf("overlapping adapter host")
			}
			hosts[host] = true
		}
	}
	r.mu.Lock()
	for id := range bindings {
		if available[id] != r.available[id] {
			slog.Info("adapter availability changed", "adapter", id, "available", available[id])
		}
	}
	r.bindings = bindings
	r.available = available
	r.ids = ids
	r.mu.Unlock()
	return nil
}
func (s *Service) CaptureAvailable(ctx context.Context, tenant, id string) (bool, error) {
	var adapterID string
	e := s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT adapter_id FROM tenant_archives WHERE archive_id=$1`, id).Scan(&adapterID)
	})
	if e != nil {
		return false, e
	}
	if s.Registry == nil {
		return s.Adapter != nil || s.adapterBindings()[adapterID].Client != nil, nil
	}
	s.Registry.mu.RLock()
	defer s.Registry.mu.RUnlock()
	return s.Registry.available[adapterID], nil
}

func (r *AdapterRegistry) Descriptions() []*pb.DescribeResponse {
	bindings := r.snapshot()
	ids := make([]string, 0, len(bindings))
	for id := range bindings {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]*pb.DescribeResponse, 0, len(ids))
	for _, id := range ids {
		out = append(out, bindings[id].Descriptor)
	}
	return out
}
