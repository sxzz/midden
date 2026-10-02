package app

import (
	"context"
	"encoding/base64"
	"os"
	"sync"
	"testing"

	"google.golang.org/grpc"

	pb "monitor/api/adapter/v1"
	"monitor/internal/credentials"
	"monitor/internal/store"
)

type sameAccountAdapter struct{ *fakeAdapter }

func (*sameAccountAdapter) CheckConnection(context.Context, *pb.CheckConnectionRequest, ...grpc.CallOption) (*pb.CheckConnectionResponse, error) {
	return &pb.CheckConnectionResponse{AccountId: "verified-user", Username: "current-handle"}, nil
}

func TestAccountUpsert(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("Docker required")
	}
	ctx := context.Background()
	db, e := store.Open(ctx, os.Getenv("TEST_DATABASE_URL"))
	must(t, e)
	defer db.Close()
	admin, e := store.Open(ctx, os.Getenv("TEST_ADMIN_DATABASE_URL"))
	must(t, e)
	defer admin.Close()
	var tenant, other string
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&tenant))
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&other))
	vault, e := credentials.New(base64.StdEncoding.EncodeToString(make([]byte, 32)))
	must(t, e)
	s := &Service{DB: db, Vault: vault, AdapterTLS: true, Adapter: &sameAccountAdapter{&fakeAdapter{}}, Providers: []*pb.Provider{{Id: "session", DefaultProvider: true, Authentication: "session", Capabilities: []*pb.Capability{{Name: "connection.check", Major: 1}, {Name: "credential.prepare", Major: 1}}}}}
	first, e := s.ImportConnection(ctx, tenant, "", "first", &pb.Credential{Data: []byte("old-credential")})
	must(t, e)
	selectTestAccount(t, s, tenant, first)
	second, e := s.ImportConnection(ctx, tenant, "", "updated", &pb.Credential{Data: []byte("new-credential")})
	must(t, e)
	if first != second {
		t.Fatal("duplicate account ID")
	}
	active, e := s.DefaultConnection(ctx, tenant)
	must(t, e)
	if active != first {
		t.Fatal("lost selection")
	}
	value, revision, e := s.session(ctx, tenant, first)
	must(t, e)
	if string(value.Data) != "new-credential" || revision != 2 {
		t.Fatal("credential not replaced")
	}
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id, e := s.ImportConnection(ctx, tenant, "", "fresh", &pb.Credential{Data: []byte("concurrent-credential")})
			if e != nil || id != first {
				t.Error("concurrent duplicate", e)
			}
		}()
	}
	wg.Wait()
	var count, blobs int
	must(t, admin.Pool.QueryRow(ctx, "SELECT (SELECT count(*) FROM connections WHERE tenant_id=$1),(SELECT count(*) FROM account_credentials WHERE tenant_id=$1)", tenant).Scan(&count, &blobs))
	if count != 1 || blobs != 1 {
		t.Fatal("duplicate or orphan credential", count, blobs)
	}
	foreign, e := s.ImportConnection(ctx, other, "", "other", &pb.Credential{Data: []byte("other-credential")})
	must(t, e)
	if foreign == first {
		t.Fatal("cross-tenant merge")
	}
}
