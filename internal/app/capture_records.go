package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"monitor/internal/domain"
)

// A capture record is one request this tenant made: a link sent from any
// channel or the web, a refresh, or a further page of a collection. Captures a
// collection started for its members belong to that collection's record.
type (
	CaptureRecord struct {
		ID           string `json:"id"`
		JobID        string `json:"job_id"`
		CollectionID string `json:"collection_id"`
		// Saved is false once the collection left this tenant's library.
		Saved    bool   `json:"saved"`
		URL      string `json:"url"`
		Input    string `json:"input"`
		Platform string `json:"platform"`
		Kind     string `json:"kind"`
		State    string `json:"state"`
		Error    string `json:"error,omitempty"`
		// Media counts the images and videos of the record's own capture.
		Media      MediaProgress `json:"media"`
		CreatedAt  time.Time     `json:"created_at"`
		FinishedAt *time.Time    `json:"finished_at,omitempty"`
		// Members is set for a collection (such as a profile) and covers the
		// captures of its members across every page fetched for this record.
		Members *domain.MemberProgress `json:"members,omitempty"`
		Stopped bool                   `json:"stopped,omitempty"`
		// Retryable counts the failed members a finished collection record can
		// fetch again, leaving out those whose source reported them gone.
		Retryable int `json:"retryable,omitempty"`
		// Pages tells what a finished collection record can fetch next.
		Pages *RecordPages `json:"pages,omitempty"`
		// Done once the capture and every member capture have finished.
		Done bool `json:"done"`

		collection bool
	}
	RecordPages struct {
		// More is set while the listing has pages after the last one fetched.
		More bool `json:"more"`
		// More1000 is set when the source can fetch about 1000 at once.
		More1000 bool `json:"more_1000"`
		// Failed is set when the last page, or one before it, was not fetched.
		Failed bool `json:"failed"`
	}
	MediaProgress struct {
		Total  int `json:"total"`
		Ready  int `json:"ready"`
		Failed int `json:"failed"`
	}
	CaptureRecordPage struct {
		Items []CaptureRecord `json:"items"`
		Next  string          `json:"next_cursor,omitempty"`
	}
	CaptureMedia struct {
		Position int    `json:"position"`
		Kind     string `json:"kind"`
		Purpose  string `json:"purpose,omitempty"`
		State    string `json:"state"`
		Error    string `json:"error,omitempty"`
	}
	CaptureReason struct {
		Reason string `json:"reason"`
		Count  int    `json:"count"`
	}
	CaptureRecordDetail struct {
		CaptureRecord
		Warnings []string       `json:"warnings"`
		Items    []CaptureMedia `json:"media_items"`
		// Reasons groups why members failed or were saved incompletely.
		Reasons []CaptureReason `json:"reasons"`
	}
	CaptureMember struct {
		JobID        string   `json:"job_id"`
		CollectionID string   `json:"collection_id"`
		Saved        bool     `json:"saved"`
		URL          string   `json:"url"`
		State        string   `json:"state"`
		Error        string   `json:"error,omitempty"`
		Reasons      []string `json:"reasons"`
		// Gone when the source reported the content deleted or suspended.
		Gone      bool      `json:"gone,omitempty"`
		CreatedAt time.Time `json:"created_at"`
	}
	CaptureMemberPage struct {
		Items []CaptureMember `json:"items"`
		Next  string          `json:"next_cursor,omitempty"`
	}
)

const (
	captureRecordPage = 30
	captureMemberPage = 50
	captureMediaLimit = 500
)

// Records are the tenant's root submissions. One that only shows saved content
// again carries no input and is not a capture. A member or continuation page
// loses its parent when that is deleted, so their keys exclude them as well.
const captureRecordSQL = `SELECT s.id,s.input,s.created_at,c.is_collection AND s.related_state<>'none',c.id,c.collection_id,c.state,c.error,c.finished_at,a.url,a.platform,a.kind,EXISTS(SELECT FROM tenant_collections t WHERE t.collection_id=a.id),m.total,m.ready,m.failed
 FROM submissions s JOIN captures c ON c.id=s.capture_id JOIN collections a ON a.id=c.collection_id
 CROSS JOIN LATERAL (SELECT count(*) AS total,count(*) FILTER (WHERE x.state='ready') AS ready,count(*) FILTER (WHERE x.state='failed') AS failed FROM assets x WHERE x.capture_id=c.id) m
 WHERE s.tenant_id=current_tenant() AND ` + recordRootSQL

const recordRootSQL = `s.parent_submission IS NULL AND s.input<>'' AND s.idem_key NOT LIKE 'related:%' AND s.idem_key NOT LIKE 'related-expand:%' AND s.idem_key NOT LIKE 'batch:%' AND s.idem_key NOT LIKE 'retried:%'`

func scanCaptureRecords(rows pgx.Rows) ([]CaptureRecord, error) {
	defer rows.Close()
	items := []CaptureRecord{}
	for rows.Next() {
		var r CaptureRecord
		if e := rows.Scan(&r.ID, &r.Input, &r.CreatedAt, &r.collection, &r.JobID, &r.CollectionID, &r.State, &r.Error, &r.FinishedAt, &r.URL, &r.Platform, &r.Kind, &r.Saved, &r.Media.Total, &r.Media.Ready, &r.Media.Failed); e != nil {
			return nil, e
		}
		r.Done = r.State == "complete" || r.State == "partial" || r.State == "failed"
		items = append(items, r)
	}
	return items, rows.Err()
}

// memberProgress follows a collection record through its continuation pages.
func (s *Service) memberProgress(ctx context.Context, tenant string, r *CaptureRecord) ([]CaptureReason, error) {
	if !r.collection {
		return nil, nil
	}
	c, e := s.channelCollection(ctx, tenant, r.ID)
	if e != nil {
		return nil, e
	}
	r.Members = &domain.MemberProgress{Total: c.Total, Complete: c.Complete, Partial: c.Partial, Failed: c.Failed, Pending: c.Pending, Done: c.Done || c.Stopped}
	r.Stopped = c.Stopped
	r.Done = r.Members.Done
	if r.Done && !r.Stopped {
		r.Pages = &RecordPages{More: c.Next != "", More1000: c.Next != "" && c.MaxBatch >= 1000, Failed: c.Error != "" || r.State == "failed" || r.State == "partial"}
	}
	if r.Done {
		e = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, collectionChainSQL+` SELECT count(DISTINCT member.capture_id)`+retryableMembersSQL, r.ID).Scan(&r.Retryable)
		})
		if e != nil {
			return nil, e
		}
	}
	reasons := make([]CaptureReason, 0, len(c.Reasons))
	for _, reason := range c.Reasons {
		reasons = append(reasons, CaptureReason{Reason: reason.Reason, Count: reason.Count})
	}
	return reasons, nil
}

func parseRecordCursor(cursor, filter string) (*time.Time, *string, error) {
	if cursor == "" {
		return nil, nil, nil
	}
	b, e := base64.RawURLEncoding.DecodeString(cursor)
	var c collectionCursor
	if e != nil || json.Unmarshal(b, &c) != nil || c.Filter != filter || c.Time.IsZero() {
		return nil, nil, fmt.Errorf("invalid cursor")
	}
	if _, e = uuid.Parse(c.ID); e != nil {
		return nil, nil, fmt.Errorf("invalid cursor")
	}
	return &c.Time, &c.ID, nil
}

func recordCursor(at time.Time, id, filter string) string {
	b, _ := json.Marshal(collectionCursor{Time: at, ID: id, Filter: filter})
	return base64.RawURLEncoding.EncodeToString(b)
}

// CaptureRecords lists the tenant's capture requests, newest first.
func (s *Service) CaptureRecords(ctx context.Context, tenant, cursor string) (p CaptureRecordPage, e error) {
	p.Items = []CaptureRecord{}
	at, id, e := parseRecordCursor(cursor, "captures")
	if e != nil {
		return p, e
	}
	e = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, captureRecordSQL+` AND ($1::timestamptz IS NULL OR (s.created_at,s.id)<($1,$2::uuid)) ORDER BY s.created_at DESC,s.id DESC LIMIT $3`, at, id, captureRecordPage+1)
		if err != nil {
			return err
		}
		p.Items, err = scanCaptureRecords(rows)
		return err
	})
	if e != nil {
		return p, e
	}
	if len(p.Items) > captureRecordPage {
		p.Items = p.Items[:captureRecordPage]
		last := p.Items[captureRecordPage-1]
		p.Next = recordCursor(last.CreatedAt, last.ID, "captures")
	}
	for i := range p.Items {
		if _, e = s.memberProgress(ctx, tenant, &p.Items[i]); e != nil {
			return p, e
		}
	}
	return p, nil
}

// CaptureRecord adds what a record's own capture saved and why anything is missing.
func (s *Service) CaptureRecord(ctx context.Context, tenant, id string) (d CaptureRecordDetail, e error) {
	d.Warnings, d.Items, d.Reasons = []string{}, []CaptureMedia{}, []CaptureReason{}
	e = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, captureRecordSQL+` AND s.id=$1`, id)
		if err != nil {
			return err
		}
		items, err := scanCaptureRecords(rows)
		if err != nil {
			return err
		}
		if len(items) == 0 {
			return domain.ErrNotFound
		}
		d.CaptureRecord = items[0]
		if err = tx.QueryRow(ctx, `SELECT coalesce((SELECT array_agg(w) FROM revisions r CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.payload->'warnings')='array' THEN r.payload->'warnings' ELSE '[]'::jsonb END) w WHERE r.id=c.revision_id),'{}') FROM captures c WHERE c.id=$1`, d.JobID).Scan(&d.Warnings); err != nil {
			return err
		}
		media, err := tx.Query(ctx, `SELECT position,kind,purpose,state,error FROM assets WHERE capture_id=$1 ORDER BY position LIMIT $2`, d.JobID, captureMediaLimit)
		if err != nil {
			return err
		}
		d.Items, err = pgx.CollectRows(media, func(row pgx.CollectableRow) (m CaptureMedia, e error) {
			e = row.Scan(&m.Position, &m.Kind, &m.Purpose, &m.State, &m.Error)
			return
		})
		return err
	})
	if e != nil {
		return d, e
	}
	reasons, e := s.memberProgress(ctx, tenant, &d.CaptureRecord)
	if reasons != nil {
		d.Reasons = reasons
	}
	return d, e
}

// CaptureMembers pages through the captures a collection record started, in
// the order they were submitted. state narrows them to "failed", "partial",
// "complete", "pending", or "problem" for the failed and partial ones.
func (s *Service) CaptureMembers(ctx context.Context, tenant, id, state, cursor string) (p CaptureMemberPage, e error) {
	p.Items = []CaptureMember{}
	var states []string
	switch state {
	case "":
	case "problem":
		states = []string{"failed", "partial"}
	case "pending":
		states = []string{"queued", "downloading"}
	case "failed", "partial", "complete":
		states = []string{state}
	default:
		return p, ErrInvalidFilter
	}
	at, after, e := parseRecordCursor(cursor, "members:"+id+":"+state)
	if e != nil {
		return p, e
	}
	e = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		var root bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM (`+captureRecordSQL+` AND s.id=$1) r)`, id).Scan(&root); err != nil {
			return err
		}
		if !root {
			return domain.ErrNotFound
		}
		rows, err := tx.Query(ctx, collectionChainSQL+`,members AS (SELECT DISTINCT child.capture_id FROM pages CROSS JOIN LATERAL (SELECT member.capture_id FROM submissions member WHERE member.parent_submission=pages.id AND member.idem_key LIKE 'related:%' OFFSET 0) child)
 SELECT c.id,c.collection_id,a.url,c.state,c.error,c.created_at,EXISTS(SELECT FROM tenant_collections t WHERE t.collection_id=a.id),a.source_state IS NOT NULL,
 ARRAY(SELECT x.error FROM assets x WHERE x.capture_id=c.id AND x.state='failed' AND x.error<>''
  UNION SELECT w FROM revisions r CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.payload->'warnings')='array' THEN r.payload->'warnings' ELSE '[]'::jsonb END) w WHERE r.id=c.revision_id AND c.state='partial' ORDER BY 1)
 FROM members m JOIN captures c ON c.id=m.capture_id JOIN collections a ON a.id=c.collection_id
 WHERE ($2::text[] IS NULL OR c.state=ANY($2)) AND ($3::timestamptz IS NULL OR (c.created_at,c.id)>($3,$4::uuid))
 ORDER BY c.created_at,c.id LIMIT $5`, id, states, at, after, captureMemberPage+1)
		if err != nil {
			return err
		}
		p.Items, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (m CaptureMember, e error) {
			e = row.Scan(&m.JobID, &m.CollectionID, &m.URL, &m.State, &m.Error, &m.CreatedAt, &m.Saved, &m.Gone, &m.Reasons)
			return
		})
		return err
	})
	if e != nil {
		return p, e
	}
	if len(p.Items) > captureMemberPage {
		p.Items = p.Items[:captureMemberPage]
		last := p.Items[captureMemberPage-1]
		p.Next = recordCursor(last.CreatedAt, last.JobID, "members:"+id+":"+state)
	}
	return p, nil
}

// CaptureURL saves a link through the source the tenant selected for its
// platform, the way a link sent to a channel is saved.
func (s *Service) CaptureURL(ctx context.Context, tenant, raw, key string) (domain.Job, error) {
	target, e := s.Resolve(ctx, raw)
	if e != nil {
		return domain.Job{}, e
	}
	connection, e := s.connectionForURL(ctx, tenant, target.URL)
	if e != nil {
		return domain.Job{}, e
	}
	return s.Submit(ctx, tenant, domain.CaptureInput{URL: target.URL, Input: raw, ConnectionID: connection, Key: key})
}

// recaptureInput builds the capture that fetches a saved collection again. One
// whose last capture failed, or any when restart is set, starts over with the
// source selected now; otherwise it refreshes through the source that saved it.
func (s *Service) recaptureInput(ctx context.Context, tenant, collection string, restart bool) (domain.CaptureInput, error) {
	var url, state string
	e := s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT a.url,coalesce((SELECT c.state FROM captures c WHERE c.collection_id=a.id AND (c.tenant_id=$2 OR EXISTS(SELECT FROM submissions s WHERE s.capture_id=c.id AND s.tenant_id=$2)) ORDER BY c.created_at DESC,c.id DESC LIMIT 1),'') FROM collections a JOIN tenant_collections t ON t.collection_id=a.id WHERE a.id=$1`, collection, tenant).Scan(&url, &state)
	})
	if e != nil {
		return domain.CaptureInput{}, e
	}
	if !restart && state != "failed" {
		return domain.CaptureInput{RefreshID: collection}, nil
	}
	connection, e := s.connectionForURL(ctx, tenant, url)
	if e != nil {
		return domain.CaptureInput{}, e
	}
	return domain.CaptureInput{URL: url, Input: url, ConnectionID: connection}, nil
}

// RetryCaptureRecord captures a record's target again as a new record.
func (s *Service) RetryCaptureRecord(ctx context.Context, tenant, id, key string) (domain.Job, error) {
	var collection, url string
	var saved bool
	e := s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT a.id,a.url,EXISTS(SELECT FROM tenant_collections t WHERE t.collection_id=a.id) FROM submissions s JOIN captures c ON c.id=s.capture_id JOIN collections a ON a.id=c.collection_id WHERE s.id=$1 AND `+recordRootSQL, id).Scan(&collection, &url, &saved)
	})
	if e != nil {
		return domain.Job{}, e
	}
	// Deleted from the library since: saving it again is all that is left.
	if !saved {
		return s.CaptureURL(ctx, tenant, url, key)
	}
	in, e := s.recaptureInput(ctx, tenant, collection, false)
	if e != nil {
		return domain.Job{}, e
	}
	in.Key = key
	return s.Submit(ctx, tenant, in)
}

// RetryCaptureMembers fetches again the failed members of a collection record,
// or only the one whose capture is member, within the same record. It returns
// how many were retried; members whose source reported them gone are left.
func (s *Service) RetryCaptureMembers(ctx context.Context, tenant, id, member string) (n int64, err error) {
	var only *string
	if member != "" {
		only = &member
	}
	err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		if e := lockTenant(ctx, tx, tenant); e != nil {
			return e
		}
		var root bool
		if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM (`+captureRecordSQL+` AND s.id=$1) r)`, id).Scan(&root); e != nil {
			return e
		}
		if !root {
			return domain.ErrNotFound
		}
		var e error
		n, e = s.retryFailedMembers(ctx, tx, tenant, collectionChainSQL, ` AND ($2::uuid IS NULL OR member.capture_id=$2::uuid)`, id, only)
		return e
	})
	return
}

// CaptureRecordPage continues a finished collection record like the bot's
// buttons: "more", "more1000" or "page_retry". Its pages form a new record.
// Asking for more twice gives the same capture.
func (s *Service) CaptureRecordPage(ctx context.Context, tenant, id, op, key string) (domain.Job, error) {
	var r CaptureRecord
	e := s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, captureRecordSQL+` AND s.id=$1`, id)
		if err != nil {
			return err
		}
		items, err := scanCaptureRecords(rows)
		if err != nil {
			return err
		}
		if len(items) == 0 {
			return domain.ErrNotFound
		}
		r = items[0]
		return nil
	})
	if e != nil {
		return domain.Job{}, e
	}
	if _, e = s.memberProgress(ctx, tenant, &r); e != nil {
		return domain.Job{}, e
	}
	if r.Pages == nil {
		return domain.Job{}, domain.ErrUnsupported
	}
	idem := "more:" + id
	switch op {
	case "more", "more1000":
	case "page_retry":
		if key == "" {
			key = uuid.NewString()
		}
		idem = "page-retry:" + key
	default:
		return domain.Job{}, domain.ErrUnsupported
	}
	return s.collectionPage(ctx, tenant, domain.Origin{}, id, op, idem, false)
}
