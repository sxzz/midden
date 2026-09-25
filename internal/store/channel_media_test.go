package store

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
)

func TestChannelMediaCachePersistsAndSeparatesAccounts(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("Docker database required")
	}
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	hash := uuid.NewString()
	defer func() { db.Pool.Exec(ctx, `DELETE FROM channel_media_cache WHERE hash=$1`, hash); db.Close() }()
	for _, v := range [][4]string{{"telegram", "bot1", "video", "v1"}, {"telegram", "bot2", "video", "v2"}, {"telegram", "bot1", "document", "d1"}, {"another-channel", "bot1", "video", "other"}} {
		if err := db.PutChannelMedia(ctx, v[0], v[1], hash, v[2], v[3]); err != nil {
			t.Fatal(err)
		}
	}
	other, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	for _, v := range [][4]string{{"telegram", "bot1", "video", "v1"}, {"telegram", "bot2", "video", "v2"}, {"telegram", "bot1", "document", "d1"}, {"another-channel", "bot1", "video", "other"}} {
		got, err := other.GetChannelMedia(ctx, v[0], v[1], hash, v[2])
		if err != nil || got != v[3] {
			t.Fatal(got, err)
		}
	}
	if err := db.DeleteChannelMedia(ctx, "telegram", "bot1", hash, "video", "stale-id"); err != nil {
		t.Fatal(err)
	}
	got, err := other.GetChannelMedia(ctx, "telegram", "bot1", hash, "video")
	if err != nil || got != "v1" {
		t.Fatal("stale invalidation removed new reference")
	}
	if err := db.DeleteChannelMedia(ctx, "telegram", "bot1", hash, "video", "v1"); err != nil {
		t.Fatal(err)
	}
	got, err = other.GetChannelMedia(ctx, "telegram", "bot1", hash, "video")
	if err != nil || got != "" {
		t.Fatal(got, err)
	}
}
