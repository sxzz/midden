package tgchannel

import (
	"strings"
	"testing"
	"unicode/utf16"

	"monitor/internal/domain"
)

func TestDeliveryPartsKeepTextWithMedia(t *testing.T) {
	for _, size := range []int{0, 1, 2, 10, 11, 20} {
		for _, text := range []string{"正文", strings.Repeat("😀", 513) + "尾部", strings.Repeat("长正文", 2000)} {
			var assets []domain.Asset
			for i := 0; i < size; i++ {
				assets = append(assets, domain.Asset{State: "ready"})
			}
			assets = append(assets, domain.Asset{State: "failed"})
			parts := deliveryParts(text, assets)
			var joined string
			images, texts, buttons := 0, 0, 0
			for _, part := range parts {
				joined += part.text
				switch part.kind {
				case "media":
					if texts > 0 {
						t.Fatal("image scheduled after overflow text")
					}
					images += len(part.assets)
					if len(part.assets) > 10 || len(utf16.Encode([]rune(part.text))) > 1024 {
						t.Fatal("Telegram limit exceeded")
					}
				case "text":
					texts++
				case "buttons":
					buttons++
				}
			}
			if size > 1 && (buttons != 0 || texts == 0 || parts[0].text != "") {
				t.Fatal("albums must have separate text and no media keyboard")
			}
			if joined != text || images != size {
				t.Fatal("lost content")
			}
			if size == 1 && (parts[0].kind != "media" || buttons != 1) {
				t.Fatal("media must lead with one keyboard")
			}
			if size == 1 && len(utf16.Encode([]rune(text))) <= 1024 && texts != 0 {
				t.Fatal("short text sent separately")
			}
		}
	}
}

func TestOversizeVideoDelivery(t *testing.T) {
	parts := deliveryParts("正文", []domain.Asset{{State: "ready", MIME: "video/mp4", Size: 50000001}})
	if len(parts) != 1 || parts[0].kind != "text" || !strings.Contains(parts[0].text, "文件超过 Telegram 大小限制") {
		t.Fatal(parts)
	}
}

func TestCollectionMediaDescription(t *testing.T) {
	text := collectionMessage(domain.Collection{ID: "collection", Assets: []domain.Asset{{State: "ready", MIME: "video/mp4", AltText: "示例视频", Position: 0}}}, "complete")
	if !strings.Contains(text, "媒体 1 描述：示例视频") {
		t.Fatal(text)
	}
}

func TestSensitiveDocumentDelivery(t *testing.T) {
	parts := deliveryParts("text", []domain.Asset{{State: "ready", MIME: "video/webm", Sensitive: true}})
	if len(parts) != 2 || parts[0].kind != "media" || len(parts[0].assets) != 1 {
		t.Fatal(parts)
	}
	parts = deliveryParts("text", []domain.Asset{{State: "ready", MIME: "video/mp4", Sensitive: true}, {State: "ready", MIME: "video/webm"}})
	if len(parts) != 3 || len(parts[0].assets) != 1 || parts[1].assets[0].MIME != "video/webm" {
		t.Fatal("mixed document group could lose spoiler", parts)
	}
}

func TestCollectionEntitiesSurviveCaptionAndTextSplits(t *testing.T) {
	for _, body := range []string{"", " \n ", strings.Repeat("😀正文\n", 1800)} {
		for _, media := range []int{0, 1, 2} {
			a := domain.Collection{ID: "collection-id", AuthorName: "😀作者", Text: body, Graph: &domain.EntityGraph{
				Root: "post", Entities: []domain.Entity{{Key: "author", Type: "x.profile", Data: []byte(`{"username":"fixture"}`)}},
				Relations: []domain.EntityRelation{{Source: "post", Target: "author", Type: "authored_by"}},
			}}
			for i := 0; i < media; i++ {
				a.Assets = append(a.Assets, domain.Asset{State: "ready"})
			}
			text := collectionMessage(a, "complete")
			parts := deliveryParts(text, a.Assets)
			formatDeliveryParts(parts, collectionMessageEntities(a))
			var quoted, author, code string
			for _, part := range parts {
				units := utf16.Encode([]rune(part.text))
				for _, e := range part.entities {
					if e.Offset < 0 || e.Length <= 0 || e.Offset+e.Length > len(units) {
						t.Fatal("invalid entity", e)
					}
					content := string(utf16.Decode(units[e.Offset : e.Offset+e.Length]))
					switch e.Type {
					case "blockquote":
						quoted += content
					case "text_link":
						author += content
						if e.URL != "https://x.com/fixture" {
							t.Fatal(e.URL)
						}
					case "code":
						code += content
					}
				}
			}
			if code != a.ID || author != a.AuthorName || quoted != strings.TrimSpace(body) {
				t.Fatal("formatting lost across split", media)
			}
			if strings.TrimSpace(body) == "" && text != a.ID+"\n\n"+a.AuthorName {
				t.Fatal(text)
			}
		}
	}
}
