package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"monitor/internal/adapter"
	"monitor/internal/domain"
	"monitor/internal/store"
)

var ErrInvalidFilter = errors.New("invalid collection filters")

type (
	CollectionFilter struct {
		Q, EntityType, Media, Visibility, From, Before, Sort, Order, Sensitive, Tag, RelatedTo string
		// Stable author keys, never display names. See authorIdentity.
		Authors []string
	}
	collectionCursor struct {
		Time       time.Time
		Bytes      int64
		ID, Filter string
	}
)

type CollectionItem struct {
	domain.Collection
	SavedAt time.Time `json:"saved_at"`
}
type CollectionPage struct {
	Items             []CollectionItem `json:"items"`
	Next              string           `json:"next_cursor,omitempty"`
	TotalStorageBytes *int64           `json:"total_storage_bytes,omitempty"`
}

func (s *Service) Collections(ctx context.Context, t string, f CollectionFilter, cursor string) (p CollectionPage, e error) {
	p.Items = []CollectionItem{}
	if len(f.Authors) > 100 {
		return p, ErrInvalidFilter
	}
	platforms, kinds, externals := []string{}, []string{}, []string{}
	for _, key := range f.Authors {
		author, ok := parseAuthorKey(key)
		if !ok {
			return p, ErrInvalidFilter
		}
		platforms, kinds, externals = append(platforms, author.Platform), append(kinds, author.Kind), append(externals, author.External)
	}
	if (f.Order != "" && f.Order != "desc" && f.Order != "asc") || (f.Sort != "" && f.Sort != "captured" && f.Sort != "published" && f.Sort != "storage") || utf8.RuneCountInString(f.Q) > 500 || !validMediaFilter(f.Media) || (f.Visibility != "" && f.Visibility != "public" && f.Visibility != "private") || (f.Sensitive != "" && f.Sensitive != "contains" && f.Sensitive != "not_contains") {
		return p, ErrInvalidFilter
	}
	if f.EntityType != "" {
		for _, kind := range strings.Split(f.EntityType, ",") {
			if !adapter.EntityName.MatchString(kind) {
				return p, ErrInvalidFilter
			}
		}
	}
	if f.RelatedTo != "" {
		if _, err := uuid.Parse(f.RelatedTo); err != nil {
			return p, ErrInvalidFilter
		}
	}
	if f.Tag != "" {
		if _, err := uuid.Parse(f.Tag); err != nil {
			return p, ErrInvalidFilter
		}
	}
	var from, before *time.Time
	for _, v := range []struct {
		raw string
		out **time.Time
	}{{f.From, &from}, {f.Before, &before}} {
		if v.raw != "" {
			x, err := time.Parse(time.RFC3339, v.raw)
			if err != nil {
				return p, ErrInvalidFilter
			}
			*v.out = &x
		}
	}
	if from != nil && before != nil && !from.Before(*before) {
		return p, ErrInvalidFilter
	}
	raw, _ := json.Marshal(f)
	fingerprint := store.Hash(string(raw))
	var anchor *time.Time
	var aid *string
	var byteAnchor *int64
	if cursor != "" {
		b, err := base64.RawURLEncoding.DecodeString(cursor)
		var c collectionCursor
		if err != nil || json.Unmarshal(b, &c) != nil || c.Filter != fingerprint || (f.Sort != "storage" && c.Time.IsZero()) || c.Bytes < 0 {
			return p, fmt.Errorf("invalid cursor")
		}
		if _, err = uuid.Parse(c.ID); err != nil {
			return p, fmt.Errorf("invalid cursor")
		}
		anchor = &c.Time
		byteAnchor = &c.Bytes
		aid = &c.ID
	}
	q := "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(strings.TrimSpace(f.Q)) + "%"
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		if f.RelatedTo != "" {
			var total int64
			// Calculate across all matching collections, independently of pagination.
			query := `SELECT COALESCE(SUM(` + collectionStorageSQL + `),0)::bigint FROM tenant_collections ta JOIN collections a ON a.id=ta.collection_id CROSS JOIN LATERAL (SELECT head.* FROM revisions head WHERE head.collection_id=a.id ORDER BY head.created_at DESC,head.id DESC LIMIT 1) r WHERE a.id<>$1::uuid AND EXISTS(` + strings.ReplaceAll(relatedCollectionSQL, "NULLIF($16,'')", "$1") + `) AND ($2='' OR EXISTS(SELECT FROM revision_entities re JOIN entity_versions ev ON ev.id=re.entity_version_id JOIN entities en ON en.id=ev.entity_id WHERE re.revision_id=r.id AND re.is_root AND en.kind=$2))`
			if err := tx.QueryRow(ctx, query, f.RelatedTo, f.EntityType).Scan(&total); err != nil {
				return err
			}
			p.TotalStorageBytes = &total
		}
		query := `SELECT a.id,ta.created_at,ordering.at,storage.bytes FROM tenant_collections ta JOIN collections a ON a.id=ta.collection_id CROSS JOIN LATERAL (SELECT head.* FROM revisions head WHERE head.collection_id=a.id ORDER BY head.created_at DESC,head.id DESC LIMIT 1) r CROSS JOIN LATERAL (SELECT CASE WHEN $8='published' AND pg_input_is_valid(r.payload->>'published_at','timestamp with time zone') THEN (r.payload->>'published_at')::timestamptz ELSE a.observed_at END AS at) ordering CROSS JOIN LATERAL (SELECT ` + identityStorageSQL + ` AS bytes) storage WHERE ` + latestIdentitySQL + ` AND (cardinality($11::text[])=0 OR EXISTS(` + authorMatchSQL + `)) AND ($14='' OR ($14='contains')=EXISTS(SELECT FROM assets m WHERE m.capture_id=r.capture_id AND m.purpose='' AND m.sensitive)) AND ($1='%%' OR concat_ws(' ',r.payload->>'text',r.payload->>'summary',r.payload->>'author_name') ILIKE $1) AND ($2='' OR r.visibility=$2) AND ($3::timestamptz IS NULL OR ta.created_at >= $3) AND ($4::timestamptz IS NULL OR ta.created_at < $4) AND (($8='storage' AND ($10::bigint IS NULL OR (storage.bytes,a.id)<($10,$6::uuid))) OR ($8<>'storage' AND ($5::timestamptz IS NULL OR (ordering.at,a.id)<($5,$6::uuid)))) AND ($7='' OR ('text'=ANY(string_to_array($7,',')) AND NOT EXISTS(SELECT FROM assets m WHERE m.capture_id=r.capture_id AND m.purpose='')) OR EXISTS(SELECT FROM assets m JOIN blobs b ON b.id=m.blob_id WHERE m.capture_id=r.capture_id AND m.purpose='' AND (('image'=ANY(string_to_array($7,',')) AND b.mime LIKE 'image/%') OR ('video'=ANY(string_to_array($7,',')) AND b.mime LIKE 'video/%')))) AND ($9='' OR EXISTS(SELECT FROM revision_entities re JOIN entity_versions ev ON ev.id=re.entity_version_id JOIN entities en ON en.id=ev.entity_id WHERE re.revision_id=r.id AND re.is_root AND en.kind=ANY(string_to_array($9,',')))) AND ($16='' OR (a.id<>NULLIF($16,'')::uuid AND EXISTS(` + relatedCollectionSQL + `))) AND ($15='' OR EXISTS(SELECT FROM collection_tags ct JOIN collections tagged ON tagged.id=ct.collection_id JOIN tenant_collections saved_tagged ON saved_tagged.collection_id=tagged.id WHERE (tagged.platform,tagged.kind,tagged.object_scope,tagged.external_id)=(a.platform,a.kind,a.object_scope,a.external_id) AND ct.tenant_id=ta.tenant_id AND ct.tag_id=NULLIF($15,'')::uuid)) ORDER BY CASE WHEN $8='storage' THEN storage.bytes END DESC,CASE WHEN $8<>'storage' THEN ordering.at END DESC,a.id DESC LIMIT 21`
		if f.Order == "asc" {
			query = strings.ReplaceAll(query, "(ordering.at,a.id)<", "(ordering.at,a.id)>")
			query = strings.ReplaceAll(query, "(storage.bytes,a.id)<", "(storage.bytes,a.id)>")
			query = strings.ReplaceAll(query, " DESC", " ASC")
		}
		rows, err := tx.Query(ctx, query, q, f.Visibility, from, before, anchor, aid, f.Media, f.Sort, f.EntityType, byteAnchor, platforms, kinds, externals, f.Sensitive, f.Tag, f.RelatedTo)
		if err != nil {
			return err
		}
		type entry struct {
			id    string
			at    time.Time
			saved time.Time
			bytes int64
		}
		entries := []entry{}
		for rows.Next() {
			var x entry
			if err = rows.Scan(&x.id, &x.saved, &x.at, &x.bytes); err != nil {
				rows.Close()
				return err
			}
			entries = append(entries, x)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if len(entries) > 20 {
			entries = entries[:20]
			last := entries[19]
			b, _ := json.Marshal(collectionCursor{Time: last.at, Bytes: last.bytes, ID: last.id, Filter: fingerprint})
			p.Next = base64.RawURLEncoding.EncodeToString(b)
		}
		ids := make([]string, len(entries))
		for i, v := range entries {
			ids[i] = v.id
		}
		loaded, err := collectionsByID(ctx, tx, ids)
		if err != nil {
			return err
		}
		if err = annotateCollectionRelations(ctx, tx, f.RelatedTo, ids, loaded); err != nil {
			return err
		}
		for _, v := range entries {
			a, ok := loaded[v.id]
			if !ok {
				return pgx.ErrNoRows
			}
			a.StorageBytes = v.bytes
			p.Items = append(p.Items, CollectionItem{a, v.saved})
		}
		return nil
	})
	return
}

type RevisionInfo struct {
	ID        string    `json:"id"`
	CreatedAt time.Time `json:"created_at"`
}
type RevisionPage struct {
	Items []RevisionInfo `json:"items"`
	Next  string         `json:"next_cursor,omitempty"`
}

func (s *Service) Revisions(ctx context.Context, t, id, cursor string) (p RevisionPage, e error) {
	p.Items = []RevisionInfo{}
	var at *time.Time
	var rid *string
	if cursor != "" {
		b, err := base64.RawURLEncoding.DecodeString(cursor)
		var c collectionCursor
		if err != nil || json.Unmarshal(b, &c) != nil || c.Filter != id || c.Time.IsZero() {
			return p, fmt.Errorf("invalid cursor")
		}
		if _, err = uuid.Parse(c.ID); err != nil {
			return p, fmt.Errorf("invalid cursor")
		}
		at = &c.Time
		rid = &c.ID
	}
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM tenant_collections WHERE collection_id=$1)`, id).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return domain.ErrNotFound
		}
		rows, err := tx.Query(ctx, `SELECT id,created_at FROM revisions WHERE collection_id IN (`+savedIdentityMembersSQL+`) AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 21`, id, at, rid)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v RevisionInfo
			if err = rows.Scan(&v.ID, &v.CreatedAt); err != nil {
				return err
			}
			p.Items = append(p.Items, v)
		}
		return rows.Err()
	})
	if len(p.Items) > 20 {
		p.Items = p.Items[:20]
		v := p.Items[19]
		b, _ := json.Marshal(collectionCursor{Time: v.CreatedAt, ID: v.ID, Filter: id})
		p.Next = base64.RawURLEncoding.EncodeToString(b)
	}
	return
}

func (s *Service) Revision(ctx context.Context, t, id, rid string) (a domain.Collection, e error) {
	e = s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		var raw []byte
		var cid string
		err := tx.QueryRow(ctx, `SELECT a.id,a.url,a.external_id,a.provider_id,r.visibility,r.visibility,r.id,r.payload,r.capture_id,r.created_at,a.created_at FROM collections a JOIN tenant_collections ta ON ta.collection_id=a.id JOIN revisions r ON r.collection_id=a.id WHERE a.id IN (`+savedIdentityMembersSQL+`) AND r.id=$2`, id, rid).Scan(&a.ID, &a.URL, &a.ExternalID, &a.ProviderID, &a.AccessScope, &a.Visibility, &a.RevisionID, &raw, &cid, &a.ObservedAt, &a.CreatedAt)
		if err != nil {
			return err
		}
		var p Payload
		if err = json.Unmarshal(raw, &p); err != nil {
			return err
		}
		a.AuthorName = p.AuthorName
		a.PublishedAt = p.PublishedAt
		a.Summary = p.Summary
		a.Text = p.Text
		a.TextKind = p.TextKind
		a.TextSource = p.TextSource
		a.AdapterVersion = p.Version
		a.Warnings = p.Warnings
		all, err := assets(ctx, tx, cid)
		if err != nil {
			return err
		}
		hydrateGraph(&a, p, all)
		if err = linkSavedEntities(ctx, tx, &a); err != nil {
			return err
		}
		if err = attachIncomingRelations(ctx, tx, &a); err != nil {
			return err
		}
		a.StorageBytes, err = savedIdentityStorage(ctx, tx, id)
		return err
	})
	return
}

// Web sessions browse only saved content, even when the underlying content is public.
func (s *Service) WebAccess(ctx context.Context, t, kind, id string) error {
	return s.DB.Tx(ctx, t, func(tx pgx.Tx) error {
		var yes bool
		var query string
		switch kind {
		case "collections":
			query = `SELECT EXISTS(SELECT FROM tenant_collections WHERE collection_id=$1)`
		case "assets":
			query = `SELECT EXISTS(SELECT FROM assets m JOIN revisions r ON r.capture_id=m.capture_id JOIN tenant_collections ta ON ta.collection_id=r.collection_id WHERE m.id=$1)`
		case "entities":
			query = `SELECT EXISTS(SELECT FROM entity_versions ev JOIN revision_entities re ON re.entity_version_id=ev.id JOIN revisions r ON r.id=re.revision_id JOIN tenant_collections ta ON ta.collection_id=r.collection_id WHERE ev.entity_id=$1)`
		default:
			return domain.ErrNotFound
		}
		if err := tx.QueryRow(ctx, query, id).Scan(&yes); err != nil {
			return err
		}
		if !yes {
			return domain.ErrNotFound
		}
		return nil
	})
}

func (s *Service) SavedCollection(ctx context.Context, tenant, id string) (item CollectionItem, err error) {
	err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		if e := tx.QueryRow(ctx, `SELECT MIN(created_at) FROM tenant_collections WHERE collection_id IN (`+savedIdentityMembersSQL+`) HAVING COUNT(*)>0`, id).Scan(&item.SavedAt); e != nil {
			return e
		}
		var e error
		var latest string
		if e = tx.QueryRow(ctx, savedIdentityMembersSQL+` AND visible_head(member.id) IS NOT NULL ORDER BY member.observed_at DESC,member.id DESC LIMIT 1`, id).Scan(&latest); e != nil {
			return e
		}
		item.Collection, e = collection(ctx, tx, latest)
		if e == nil {
			e = attachIncomingRelations(ctx, tx, &item.Collection)
		}
		if e == nil {
			item.StorageBytes, e = savedIdentityStorage(ctx, tx, id)
		}
		return e
	})
	return
}

// The comma-separated choices are ORed: a collection may match any selected type.
func validMediaFilter(raw string) bool {
	if raw == "" {
		return true
	}
	for _, media := range strings.Split(raw, ",") {
		if media != "image" && media != "video" && media != "text" {
			return false
		}
	}
	return true
}

// Same accounting units as tenant_usage(), scoped to one collection. Shared blobs
// are deduplicated within this collection, not apportioned across collections.
const collectionStorageSQL = `(
 COALESCE((SELECT SUM(rv.content_bytes) FROM revisions rv WHERE rv.collection_id=a.id),0)
 + COALESCE((SELECT SUM(media.size) FROM (
   SELECT DISTINCT b.hash,b.size FROM revisions rv
   JOIN assets m ON m.capture_id=rv.capture_id JOIN blobs b ON b.id=m.blob_id
   WHERE rv.collection_id=a.id
 ) media),0)
 + COALESCE((SELECT SUM(sr.size) FROM source_responses sr
   JOIN captures c ON c.id=sr.capture_id
   WHERE c.collection_id=a.id AND c.state IN ('complete','partial')
   AND (sr.visibility='public' OR sr.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)),0)
)::bigint`

func collectionStorage(ctx context.Context, tx pgx.Tx, id string) (n int64, err error) {
	err = tx.QueryRow(ctx, `SELECT `+collectionStorageSQL+` FROM collections a WHERE a.id=$1`, id).Scan(&n)
	return
}

// An author is whichever entity the adapter's own graph points at with an
// authored_by relation from the root. Identity is that entity's declared type
// and external id inside the platform namespace it was captured from — never
// its display name, so a renamed account stays one author and two accounts that
// happen to share a name stay apart.
const authorRelation = "authored_by"

type authorIdentity struct{ Platform, Kind, External string }

// Key is the wire form of an identity. Each part is escaped, so the joined key
// is unambiguous no matter what an adapter puts in an external id.
func (a authorIdentity) Key() string {
	return url.PathEscape(a.Platform) + "/" + url.PathEscape(a.Kind) + "/" + url.PathEscape(a.External)
}

// Only the canonical encoding addresses an identity: two spellings of one
// author would otherwise produce two cursor fingerprints for the same page.
func parseAuthorKey(key string) (authorIdentity, bool) {
	parts := strings.Split(key, "/")
	if len(parts) != 3 {
		return authorIdentity{}, false
	}
	for i, part := range parts {
		v, err := url.PathUnescape(part)
		if err != nil || v == "" || utf8.RuneCountInString(v) > 500 || strings.ContainsRune(v, 0) {
			return authorIdentity{}, false
		}
		parts[i] = v
	}
	author := authorIdentity{parts[0], parts[1], parts[2]}
	return author, author.Key() == key
}

// The author entity of one revision, read from the stored adapter graph.
const authorEntitySQL = `SELECT a.platform AS platform,entity->>'type' AS kind,entity->>'external_id' AS external FROM jsonb_array_elements(r.payload->'graph'->'relations') relation JOIN jsonb_array_elements(r.payload->'graph'->'entities') entity ON entity->>'key'=relation->>'target' WHERE relation->>'type'='` + authorRelation + `' AND relation->>'source'=r.payload->'graph'->>'root' LIMIT 1`

const authorMatchSQL = `SELECT FROM (` + authorEntitySQL + `) author JOIN unnest($11::text[],$12::text[],$13::text[]) AS choice(platform,kind,external) ON choice.platform=author.platform AND choice.kind=author.kind AND choice.external=author.external`

type CollectionAuthor struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// CollectionAuthors lists the stable author identities behind this tenant's
// saved collections, each labelled with the most recent display name that was
// actually captured for it. Collections the tenant has not saved never appear.
func (s *Service) CollectionAuthors(ctx context.Context, tenant string) (authors []CollectionAuthor, err error) {
	authors = []CollectionAuthor{}
	err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, `SELECT platform,kind,external,name FROM (SELECT DISTINCT ON (author.platform,author.kind,author.external) author.platform,author.kind,author.external,btrim(coalesce(r.payload->>'author_name','')) AS name FROM tenant_collections ta JOIN collections a ON a.id=ta.collection_id CROSS JOIN LATERAL (SELECT head.* FROM revisions head WHERE head.collection_id=a.id ORDER BY head.created_at DESC,head.id DESC LIMIT 1) r CROSS JOIN LATERAL (`+authorEntitySQL+`) author WHERE author.kind<>'' AND author.external<>'' ORDER BY author.platform,author.kind,author.external,(btrim(coalesce(r.payload->>'author_name',''))<>'') DESC,r.created_at DESC,r.id DESC) latest ORDER BY name,platform,kind,external`)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var author authorIdentity
			var name string
			if e = rows.Scan(&author.Platform, &author.Kind, &author.External, &name); e != nil {
				return e
			}
			if name == "" {
				// Nothing was ever captured to show; the adapter's own id is the
				// only honest label, and merging blank names would merge authors.
				name = author.External
			}
			authors = append(authors, CollectionAuthor{ID: author.Key(), Name: name})
		}
		return rows.Err()
	})
	return
}

// Resolve related objects by platform/type/external identity across source scopes,
// restricted on both sides to this tenant's saved collections. Historical profile
// graphs retain timeline pages that have since moved out of the current snapshot.
var relatedCollectionSQL = `SELECT relation.kind FROM revision_entities related
 JOIN entity_relations relation ON relation.revision_id=related.revision_id AND relation.target_key=related.entity_key
 JOIN revision_entities candidate_root ON candidate_root.revision_id=relation.revision_id AND candidate_root.entity_key=relation.source_key AND candidate_root.is_root
 JOIN entity_versions related_version ON related_version.id=related.entity_version_id
 JOIN entities related_identity ON related_identity.id=related_version.entity_id
 JOIN revision_entities target ON target.is_root
 JOIN entity_versions target_version ON target_version.id=target.entity_version_id
 JOIN entities target_identity ON target_identity.id=target_version.entity_id
 JOIN revisions target_head ON target_head.id=target.revision_id
 JOIN collections target_collection ON target_collection.id=target_head.collection_id AND visible_head(target_collection.id)=target_head.id
 JOIN tenant_collections saved_target ON saved_target.collection_id=target_collection.id
 WHERE ` + relatedIdentityMatchSQL + ` AND related.revision_id=r.id AND target_collection.id IN (` + strings.ReplaceAll(savedIdentityMembersSQL, "$1", "NULLIF($16,'')::uuid") + `)
 UNION ALL
 SELECT relation.kind FROM revision_entities related
 JOIN entity_versions related_version ON related_version.id=related.entity_version_id
 JOIN entities related_identity ON related_identity.id=related_version.entity_id
 JOIN entity_relations relation ON true
 JOIN revision_entities owner_root ON owner_root.revision_id=relation.revision_id AND owner_root.entity_key=relation.source_key AND owner_root.is_root
 JOIN revision_entities target ON target.revision_id=relation.revision_id AND target.entity_key=relation.target_key
 JOIN entity_versions target_version ON target_version.id=target.entity_version_id
 JOIN entities target_identity ON target_identity.id=target_version.entity_id
 JOIN revisions target_revision ON target_revision.id=target.revision_id
 JOIN collections target_collection ON target_collection.id=target_revision.collection_id
 JOIN tenant_collections saved_target ON saved_target.collection_id=target_collection.id
 WHERE ` + relatedCandidateIdentityMatchSQL + ` AND related.revision_id=r.id AND related.is_root AND target_collection.id IN (` + strings.ReplaceAll(savedIdentityMembersSQL, "$1", "NULLIF($16,'')::uuid") + `)`

const relatedIdentityMatchSQL = `(target_identity.platform=related_identity.platform AND target_identity.kind=related_identity.kind AND (
 target_identity.external_id=related_identity.external_id OR EXISTS(
 SELECT FROM collection_identity_aliases alias WHERE alias.collection_id=target_collection.id
 AND (alias.platform,alias.kind,alias.object_scope)=(target_collection.platform,target_collection.kind,target_collection.object_scope)
 AND alias.external_id=related_identity.external_id)))`

// The reverse edge points to the candidate, so any provisional target identity
// must resolve through that candidate's aliases, not the owner's profile aliases.
const relatedCandidateIdentityMatchSQL = `(target_identity.platform=related_identity.platform AND target_identity.kind=related_identity.kind AND (
 target_identity.external_id=related_identity.external_id OR EXISTS(
 SELECT FROM collection_identity_aliases alias WHERE alias.collection_id=a.id
 AND (alias.platform,alias.kind,alias.object_scope)=(a.platform,a.kind,a.object_scope)
 AND alias.external_id=target_identity.external_id)))`
