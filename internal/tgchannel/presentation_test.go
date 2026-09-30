package tgchannel

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/google/uuid"

	"monitor/internal/domain"
)

func TestCallbackValidation(t *testing.T) {
	id := uuid.NewString()
	for _, value := range []string{"/list", "/usage", "/show " + id, "/refresh " + id, "/list " + base64.RawURLEncoding.EncodeToString([]byte(id))} {
		if !validCallback(value) {
			t.Fatal(value)
		}
	}
	for _, value := range []string{"", "/refresh", "/show bad", "/list bad", "/start", strings.Repeat("x", 65)} {
		if validCallback(value) {
			t.Fatal(value)
		}
	}
}

func TestCollectionMessageIncludesOnlyCollectionID(t *testing.T) {
	a := domain.Collection{ID: uuid.NewString(), RevisionID: uuid.NewString(), Text: "原帖正文", AuthorName: "测试作者", URL: "https://x.com/i/status/20", PublishedAt: "2026-04-05T03:22:33Z", Assets: []domain.Asset{{State: "ready"}}}
	text := collectionMessage(a, "complete")
	if text != a.ID+"\n\n测试作者：\n原帖正文" {
		t.Fatal(text)
	}
	a.Text = ""
	a.Warnings = []string{"视频不支持"}
	a.Assets = append(a.Assets, domain.Asset{State: "failed", Error: "下载超时"})
	text = collectionMessage(a, "partial")
	if !strings.Contains(text, a.ID) || strings.Contains(text, "/show") || strings.Contains(text, a.RevisionID) || !strings.Contains(text, "视频不支持") || !strings.Contains(text, "下载超时") {
		t.Fatal(text)
	}
}

func TestCollectionListSummary(t *testing.T) {
	for _, tc := range []struct{ summary, text, want string }{
		{"作者：第一行\n第二行", "unused", "作者：第一行 第二行"},
		{"", "旧收藏\n正文", "旧收藏 正文"},
		{"", "", "无文字内容"},
		{strings.Repeat("字", 100), "", strings.Repeat("字", 100)},
		{strings.Repeat("🙂", 101), "", strings.Repeat("🙂", 99) + "…"},
		{strings.Repeat("字", 120) + "[图片][视频]", "", strings.Repeat("字", 91) + "…[图片][视频]"},
	} {
		if got := collectionListSummary(tc.summary, tc.text); got != tc.want {
			t.Fatalf("got %q, want %q", got, tc.want)
		}
	}
}

func TestCollectionReasonsDeduplicated(t *testing.T) {
	a := domain.Collection{Warnings: []string{"storage quota exceeded"}, Assets: []domain.Asset{{State: "failed", Error: "storage quota exceeded"}, {State: "failed", Error: "storage quota exceeded"}}}
	text := collectionMessage(a, "partial")
	if strings.Count(text, "存储配额不足") != 1 {
		t.Fatal(text)
	}
}

func TestCollectionMiniAppButton(t *testing.T) {
	id := uuid.NewString()
	keys := collectionButtons(id, "https://example.test/post", "https://collection.test/app/?theme=dark#/")
	button := keys[len(keys)-1][0]
	if button.Text != "在小程序中打开" || button.WebApp == nil || button.WebApp.URL != "https://collection.test/app/?theme=dark#/collection/"+id {
		t.Fatalf("unexpected mini app button: %+v", button)
	}
	for _, row := range buttonsForChat("-123", keys) {
		for _, b := range row {
			if b.WebApp != nil {
				t.Fatal("web app button leaked into group")
			}
		}
	}
	for _, address := range []string{"", "http://collection.test/app/", ":bad"} {
		for _, row := range collectionButtons(id, "https://example.test/post", address) {
			for _, b := range row {
				if b.WebApp != nil {
					t.Fatal("invalid web URL enabled mini app button")
				}
			}
		}
	}
}
