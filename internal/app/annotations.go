package app

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"monitor/internal/domain"
)

var ErrInvalidAnnotation = errors.New("invalid note or tags")

type Tag struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type Annotation struct {
	Note string `json:"note"`
	Tags []Tag  `json:"tags"`
}
type AnnotationUpdate struct {
	Note     *string   `json:"note"`
	TagIDs   *[]string `json:"tag_ids"`
	TagNames *[]string `json:"tag_names"`
}

func (s *Service) Tags(ctx context.Context, tenant string) (tags []Tag, err error) {
	tags = []Tag{}
	err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, `SELECT id,name FROM tags ORDER BY name,id`)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var tag Tag
			if e = rows.Scan(&tag.ID, &tag.Name); e != nil {
				return e
			}
			tags = append(tags, tag)
		}
		return rows.Err()
	})
	return
}

// All annotation mutations and collection deletions hold lockTenant first.
func pruneTags(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `DELETE FROM tags t WHERE NOT EXISTS (SELECT FROM collection_tags ct WHERE ct.tenant_id=t.tenant_id AND ct.tag_id=t.id)`)
	return err
}

func readAnnotation(ctx context.Context, tx pgx.Tx, id string) (a Annotation, err error) {
	a.Tags = []Tag{}
	ids, err := savedIdentityIDs(ctx, tx, id)
	if err != nil {
		return a, err
	}
	// Retain distinct existing notes when formerly separate captures are unified.
	if err = tx.QueryRow(ctx, `SELECT coalesce(string_agg(note,E'\n\n' ORDER BY first_saved,note),'') FROM (SELECT note,min(created_at) first_saved FROM tenant_collections WHERE collection_id=ANY($1::uuid[]) AND note<>'' GROUP BY note) notes`, ids).Scan(&a.Note); err != nil {
		return a, err
	}
	rows, err := tx.Query(ctx, `SELECT DISTINCT t.id,t.name FROM tags t JOIN collection_tags ct ON ct.tenant_id=t.tenant_id AND ct.tag_id=t.id WHERE ct.collection_id=ANY($1::uuid[]) ORDER BY t.name,t.id`, ids)
	if err != nil {
		return a, err
	}
	defer rows.Close()
	for rows.Next() {
		var tag Tag
		if err = rows.Scan(&tag.ID, &tag.Name); err != nil {
			return a, err
		}
		a.Tags = append(a.Tags, tag)
	}
	return a, rows.Err()
}

func (s *Service) Annotation(ctx context.Context, tenant, id string) (a Annotation, err error) {
	err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		var e error
		a, e = readAnnotation(ctx, tx, id)
		return e
	})
	return
}

func (s *Service) UpdateAnnotation(ctx context.Context, tenant, id string, in AnnotationUpdate) (a Annotation, err error) {
	if in.Note != nil && (utf8.RuneCountInString(*in.Note) > 10000 || strings.ContainsRune(*in.Note, 0)) {
		return a, ErrInvalidAnnotation
	}
	if in.TagNames != nil {
		if len(*in.TagNames) > 100 || in.TagIDs != nil {
			return a, ErrInvalidAnnotation
		}
		for _, name := range *in.TagNames {
			name = strings.TrimSpace(name)
			if name == "" || utf8.RuneCountInString(name) > 64 || strings.ContainsRune(name, 0) {
				return a, ErrInvalidAnnotation
			}
		}
	}
	if in.TagIDs != nil {
		if len(*in.TagIDs) > 100 {
			return a, ErrInvalidAnnotation
		}
		for _, id := range *in.TagIDs {
			if _, e := uuid.Parse(id); e != nil {
				return a, ErrInvalidAnnotation
			}
		}
	}
	err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		if e := lockTenant(ctx, tx, tenant); e != nil {
			return e
		}
		members, e := savedIdentityIDs(ctx, tx, id)
		if e != nil {
			return e
		}
		if in.Note != nil {
			if _, e := tx.Exec(ctx, `UPDATE tenant_collections SET note=$2 WHERE collection_id=ANY($1::uuid[])`, members, *in.Note); e != nil {
				return e
			}
		}
		if in.TagNames != nil {
			ids := []string{}
			for _, name := range *in.TagNames {
				var tag string
				if e := tx.QueryRow(ctx, `INSERT INTO tags(tenant_id,name) VALUES($1,$2) ON CONFLICT (tenant_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, tenant, strings.TrimSpace(name)).Scan(&tag); e != nil {
					return e
				}
				ids = append(ids, tag)
			}
			in.TagIDs = &ids
		}
		if in.TagIDs != nil {
			for _, tag := range *in.TagIDs {
				var found bool
				if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM tags WHERE id=$1)`, tag).Scan(&found); e != nil {
					return e
				}
				if !found {
					return domain.ErrNotFound
				}
			}
			if _, e := tx.Exec(ctx, `DELETE FROM collection_tags WHERE collection_id=ANY($1::uuid[])`, members); e != nil {
				return e
			}
			for _, tag := range *in.TagIDs {
				if _, e := tx.Exec(ctx, `INSERT INTO collection_tags(tenant_id,collection_id,tag_id) SELECT $1,unnest($2::uuid[]),$3 ON CONFLICT DO NOTHING`, tenant, members, tag); e != nil {
					return e
				}
			}
		}
		if e := pruneTags(ctx, tx); e != nil {
			return e
		}
		a, e = readAnnotation(ctx, tx, id)
		return e
	})
	return
}
