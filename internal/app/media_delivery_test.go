package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"monitor/internal/domain"
	"monitor/internal/store"
	"monitor/internal/telegram"
)

func TestMediaDeliveryResumesWithoutResendingAlbum(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("Docker required")
	}
	ctx := context.Background()
	admin, err := store.Open(ctx, os.Getenv("TEST_ADMIN_DATABASE_URL"))
	must(t, err)
	defer admin.Close()
	db, err := store.Open(ctx, os.Getenv("TEST_DATABASE_URL"))
	must(t, err)
	defer db.Close()
	channel := uuid.NewString()
	_, err = admin.Pool.Exec(ctx, `INSERT INTO channels(id,kind,external_id) VALUES($1,'test',$2)`, channel, channel)
	must(t, err)
	identity, err := db.Resolve(ctx, channel, "42", 1<<30)
	must(t, err)
	q, err := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, err)
	var img bytes.Buffer
	must(t, png.Encode(&img, image.NewRGBA(image.Rect(0, 0, 13, 17))))
	var mu sync.Mutex
	var methods []string
	var overflow []string
	attempts := 0
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/image" {
			w.Write(img.Bytes())
			return
		}
		if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/") {
			must(t, r.ParseMultipartForm(1<<20))
			defer r.MultipartForm.RemoveAll()
		} else {
			must(t, r.ParseForm())
		}
		mu.Lock()
		defer mu.Unlock()
		method := path.Base(r.URL.Path)
		if method == "sendChatAction" {
			fmt.Fprint(w, `{"ok":true,"result":true}`)
			return
		}
		methods = append(methods, method)
		switch method {
		case "sendMessage":
			if r.FormValue("reply_to_message_id") != "123" {
				t.Error("text lost group reply")
			}
			if strings.HasPrefix(r.FormValue("text"), "正在采集") {
				fmt.Fprint(w, `{"ok":true,"result":{"message_id":5}}`)
				return
			}
			if len(overflow) == 0 {
				if !strings.Contains(r.FormValue("reply_markup"), "我也要存") || strings.Contains(r.FormValue("reply_markup"), "/list") {
					t.Error("wrong text controls")
				}
				var entities []telegram.Entity
				must(t, json.Unmarshal([]byte(r.FormValue("entities")), &entities))
				if len(entities) != 2 || entities[0].Type != "code" || entities[1].Type != "blockquote" {
					t.Error("archive ID or body formatting missing", entities)
				}
				attempts++
				if attempts == 1 {
					fmt.Fprint(w, `{"ok":false,"error_code":500}`)
					return
				}
			} else if strings.Contains(r.FormValue("reply_markup"), "/refresh") {
				t.Error("overflow repeated controls")
			}
			overflow = append(overflow, r.FormValue("text"))
			fmt.Fprintf(w, `{"ok":true,"result":{"message_id":%d}}`, 8+len(overflow))
		case "deleteMessage":
			if r.FormValue("message_id") != "5" {
				t.Error("deleted something other than progress")
			}
			fmt.Fprint(w, `{"ok":true,"result":true}`)
		case "sendMediaGroup":
			var media []struct {
				Caption  string            `json:"caption"`
				Entities []telegram.Entity `json:"caption_entities"`
			}
			must(t, json.Unmarshal([]byte(r.FormValue("media")), &media))
			if len(media) != 2 || len(media[0].Entities) != 0 || media[0].Caption != "" || media[1].Caption != "" {
				t.Error("wrong album caption", media)
			}
			if r.FormValue("reply_to_message_id") != "123" {
				t.Error("album lost group reply")
			}
			fmt.Fprint(w, `{"ok":true,"result":[{"message_id":7},{"message_id":8}]}`)
		default:
			t.Error("unexpected method", method)
		}
	}))
	defer h.Close()
	blobs := &memoryBlob{m: map[string][]byte{}}
	sender := &telegram.Client{Token: "test", Base: h.URL, HTTP: h.Client(), Blobs: blobs}
	s := &Service{DB: db, Queue: q, Adapter: &fakeAdapter{public: true, text: strings.Repeat("长正文😀", 800), urls: []string{h.URL + "/image?1", h.URL + "/image?2"}}, Blobs: blobs, HTTP: h.Client(), Config: Defaults(), Senders: map[string]Sender{channel: sender}}
	j, err := s.Submit(ctx, identity.TenantID, domain.CaptureInput{URL: "https://x.com/i/status/98000000088", Origin: domain.Origin{IdentityID: identity.ID, ChannelID: channel, ChatID: "-42", ReplyToMessageID: 123}})
	must(t, err)
	var sid string
	must(t, db.Tx(ctx, identity.TenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT id FROM submissions WHERE capture_id=$1`, j.ID).Scan(&sid)
	}))
	task := store.Task{Tenant: identity.TenantID, ID: sid}
	if err := s.submissionStatus(ctx, task); err == nil {
		t.Fatal("expected pending status")
	}
	must(t, s.capture(ctx, store.Task{Tenant: identity.TenantID, ID: j.ID}))
	var aa []domain.Asset
	must(t, db.Tx(ctx, identity.TenantID, func(tx pgx.Tx) error { var err error; aa, err = assets(ctx, tx, j.ID); return err }))
	for _, asset := range aa {
		must(t, s.download(ctx, store.Task{Tenant: identity.TenantID, ID: asset.ID}))
	}
	must(t, s.finalize(ctx, identity.TenantID, j.ID))
	if err := s.deliver(ctx, task); err == nil {
		t.Fatal("expected keyboard failure")
	}
	restarted := *s
	must(t, restarted.deliver(ctx, task))
	must(t, restarted.deliver(ctx, task))
	a, err := s.Archive(ctx, identity.TenantID, j.ArchiveID)
	must(t, err)
	var mid int64
	must(t, db.Tx(ctx, identity.TenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT message_id FROM submissions WHERE id=$1`, sid).Scan(&mid)
	}))
	if mid != 9 {
		t.Fatalf("controls must belong to first text message, got %d", mid)
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(overflow, "") != archiveMessage(a, "complete") {
		t.Fatal("text lost content")
	}
	if strings.Join(methods, ",") != "sendMessage,deleteMessage,sendMediaGroup,sendMessage,sendMessage,sendMessage" {
		t.Fatal("album repeated or text sent before images", methods)
	}
}
