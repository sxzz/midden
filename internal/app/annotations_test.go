package app

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"monitor/internal/domain"
	"monitor/internal/store"
)

func testAnnotations(t *testing.T, s *Service, admin *store.Store, a, b, id, secondID string) {
	t.Helper()
	ctx := context.Background()
	names := []string{"  研究  ", "研究"}
	first, e := s.UpdateAnnotation(ctx, a, id, AnnotationUpdate{TagNames: &names})
	must(t, e)
	if len(first.Tags) != 1 {
		t.Fatal("names not deduplicated", first)
	}
	tag := first.Tags[0]
	duplicate, e := s.UpdateAnnotation(ctx, a, id, AnnotationUpdate{TagNames: &names})
	must(t, e)
	if duplicate.Tags[0].ID != tag.ID {
		t.Fatal("tag ID changed")
	}
	tags, e := s.Tags(ctx, b)
	must(t, e)
	if len(tags) != 0 {
		t.Fatal("tag isolation", tags)
	}
	note := "我的备注"
	ids := []string{tag.ID, tag.ID}
	annotation, e := s.UpdateAnnotation(ctx, a, id, AnnotationUpdate{Note: &note, TagIDs: &ids})
	must(t, e)
	if annotation.Note != note || len(annotation.Tags) != 1 {
		t.Fatal(annotation)
	}
	if _, e = s.Annotation(ctx, b, id); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("unsaved collection exposed", e)
	}
	if _, e = s.UpdateAnnotation(ctx, b, id, AnnotationUpdate{Note: &note}); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("unsaved collection writable", e)
	}
	// Two tenants save the same public collection, but retain separate annotations.
	_, e = admin.Pool.Exec(ctx, `INSERT INTO tenant_collections(tenant_id,collection_id,provider_id,adapter_id) SELECT $1,collection_id,provider_id,adapter_id FROM tenant_collections WHERE tenant_id=$2 AND collection_id=$3`, b, a, id)
	must(t, e)
	annotation, e = s.Annotation(ctx, b, id)
	must(t, e)
	if annotation.Note != "" || len(annotation.Tags) != 0 {
		t.Fatal("shared content leaked annotation", annotation)
	}
	otherAnnotation, e := s.UpdateAnnotation(ctx, b, id, AnnotationUpdate{TagNames: &names})
	must(t, e)
	other := otherAnnotation.Tags[0]
	if other.ID == tag.ID {
		t.Fatal("tags shared across tenants")
	}
	changed := "must roll back"
	foreign := []string{other.ID}
	if _, e = s.UpdateAnnotation(ctx, a, id, AnnotationUpdate{Note: &changed, TagIDs: &foreign}); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("foreign tag accepted", e)
	}
	annotation, e = s.Annotation(ctx, a, id)
	must(t, e)
	if annotation.Note != note || len(annotation.Tags) != 1 || annotation.Tags[0].ID != tag.ID {
		t.Fatal("failed mutation was not atomic", annotation)
	}
	page, e := s.Collections(ctx, a, CollectionFilter{Tag: tag.ID}, "")
	must(t, e)
	if len(page.Items) != 1 || page.Items[0].ID != id {
		t.Fatal("tag filter", page)
	}
	page, e = s.Collections(ctx, b, CollectionFilter{Tag: tag.ID}, "")
	must(t, e)
	if len(page.Items) != 0 {
		t.Fatal("cross tenant tag filter", page)
	}
	if _, e = s.Collections(ctx, a, CollectionFilter{Tag: "bad"}, ""); !errors.Is(e, ErrInvalidFilter) {
		t.Fatal(e)
	}
	// Database constraints enforce tenant ownership even without service validation.
	e = s.DB.Tx(ctx, a, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `INSERT INTO collection_tags(tenant_id,collection_id,tag_id) VALUES($1,$2,$3)`, a, id, other.ID)
		return e
	})
	if e == nil {
		t.Fatal("cross tenant foreign key accepted")
	}
	e = s.DB.Tx(ctx, a, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `INSERT INTO tags(tenant_id,name) VALUES($1,'forged')`, b)
		return e
	})
	if e == nil {
		t.Fatal("RLS accepted foreign tenant")
	}
	// Shared tags survive until the last collection removes them.
	_, e = s.UpdateAnnotation(ctx, a, secondID, AnnotationUpdate{TagNames: &names})
	must(t, e)
	empty := []string{}
	annotation, e = s.UpdateAnnotation(ctx, a, id, AnnotationUpdate{TagIDs: &empty})
	must(t, e)
	if annotation.Note != note || len(annotation.Tags) != 0 {
		t.Fatal("clear tags changed note", annotation)
	}
	tags, e = s.Tags(ctx, a)
	must(t, e)
	if len(tags) != 1 || tags[0].ID != tag.ID {
		t.Fatal("shared tag removed", tags)
	}
	_, e = s.UpdateAnnotation(ctx, a, secondID, AnnotationUpdate{TagNames: &empty})
	must(t, e)
	tags, e = s.Tags(ctx, a)
	must(t, e)
	if len(tags) != 0 {
		t.Fatal("unused tags retained", tags)
	}
	tags, e = s.Tags(ctx, b)
	must(t, e)
	if len(tags) != 1 {
		t.Fatal("another tenant's tag deleted", tags)
	}
	// Remove the extra subscription so the parent fixture remains unchanged.
	must(t, s.DeleteCollection(ctx, b, id))
	tags, e = s.Tags(ctx, b)
	must(t, e)
	if len(tags) != 0 {
		t.Fatal("deleting collection retained orphan tag", tags)
	}
}

func TestAnnotationValidation(t *testing.T) {
	s := &Service{}
	for _, name := range []string{"", "  ", strings.Repeat("字", 65), "a\x00b"} {
		if _, e := s.UpdateAnnotation(context.Background(), "", "", AnnotationUpdate{TagNames: &[]string{name}}); !errors.Is(e, ErrInvalidAnnotation) {
			t.Fatal(name, e)
		}
	}
	for _, note := range []string{strings.Repeat("字", 10001), "a\x00b"} {
		if _, e := s.UpdateAnnotation(context.Background(), "", "", AnnotationUpdate{Note: &note}); !errors.Is(e, ErrInvalidAnnotation) {
			t.Fatal(e)
		}
	}
	for _, ids := range [][]string{{"invalid"}, make([]string, 101)} {
		if _, e := s.UpdateAnnotation(context.Background(), "", uuid.NewString(), AnnotationUpdate{TagIDs: &ids}); !errors.Is(e, ErrInvalidAnnotation) {
			t.Fatal(e)
		}
	}
}
