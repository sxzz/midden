package store

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/google/uuid"
)

func TestDeleteTenantKeepsSharedContent(t *testing.T) {
	if os.Getenv("TEST_ADMIN_DATABASE_URL") == "" {
		t.Skip("Docker database required")
	}
	ctx := context.Background()
	admin, err := Open(ctx, os.Getenv("TEST_ADMIN_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := admin.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	gone, kept, collection, capture, revision, credential, connection := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	exec(`INSERT INTO tenants(id) VALUES($1),($2)`, gone, kept)
	exec(`INSERT INTO account_credentials(id,tenant_id,ciphertext) VALUES($1,$2,'x')`, credential, gone)
	exec(`INSERT INTO connections(id,tenant_id,adapter_id,provider_id,name,state,credential_ref) VALUES($1,$2,'fixture','account','fixture','ready',$3)`, connection, gone, credential)
	exec(`INSERT INTO collections(id,platform,kind,external_id,url,provider_id) VALUES($1,'fixture','item',$2,'https://example.test/item','fixture')`, collection, collection)
	exec(`INSERT INTO captures(id,tenant_id,connection_id,visibility,collection_id,provider_id,scope,adapter_id,state) VALUES($1,$2,$3,'private',$4,'account','connection','fixture','complete')`, capture, gone, connection, collection)
	exec(`INSERT INTO revisions(id,visibility,collection_id,capture_id,content_hash,payload,content_bytes) VALUES($1,'public',$2,$3,'h','{}',2)`, revision, collection, capture)
	exec(`INSERT INTO source_responses(tenant_id,capture_id,position,visibility,body,content_type,source_url,sha256,size) VALUES($1,$2,0,'private','{}','application/json','','h',2),($1,$2,1,'public','{}','application/json','','h',2)`, gone, capture)
	exec(`INSERT INTO access_grants(tenant_id,platform,kind,object_scope,external_id,method) VALUES($1,'fixture','item','',$2,'fetch')`, gone, collection)
	exec(`INSERT INTO tenant_collections(tenant_id,collection_id,provider_id,adapter_id) VALUES($1,$2,'fixture','fixture')`, gone, collection)
	if err := admin.DeleteTenant(ctx, gone); !errors.Is(err, ErrTenantInUse) {
		t.Fatal("deleted a tenant that still saves content", err)
	}
	exec(`DELETE FROM tenant_collections WHERE tenant_id=$1`, gone)
	exec(`INSERT INTO tenant_collections(tenant_id,collection_id,provider_id,adapter_id) VALUES($1,$2,'fixture','fixture')`, kept, collection)
	if err := admin.DeleteTenant(ctx, gone); err != nil {
		t.Fatal(err)
	}
	var tenants, grants, revisions, private, public int
	if err := admin.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM tenants WHERE id=$1),(SELECT count(*) FROM access_grants WHERE tenant_id=$1),(SELECT count(*) FROM revisions WHERE id=$2),(SELECT count(*) FROM source_responses WHERE capture_id=$3 AND visibility='private'),(SELECT count(*) FROM source_responses WHERE capture_id=$3 AND visibility='public')`, gone, revision, capture).Scan(&tenants, &grants, &revisions, &private, &public); err != nil {
		t.Fatal(err)
	}
	if tenants != 0 || grants != 0 || revisions != 1 || private != 0 || public != 1 {
		t.Fatal("unexpected state after deletion", tenants, grants, revisions, private, public)
	}
}
