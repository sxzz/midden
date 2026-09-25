package app

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
			if joined != text || images != size {
				t.Fatal("lost content")
			}
			if size > 0 && (parts[0].kind != "media" || buttons != 1) {
				t.Fatal("media must lead with one keyboard")
			}
			if size > 0 && len(utf16.Encode([]rune(text))) <= 1024 && texts != 0 {
				t.Fatal("short text sent separately")
			}
		}
	}
}

func TestOversizeVideoDelivery(t *testing.T) {
	parts := deliveryParts("正文", []domain.Asset{{State: "ready", MIME: "video/mp4", Size: 50000001}})
	if len(parts) != 1 || parts[0].kind != "text" || !strings.Contains(parts[0].text, "文件已保存") {
		t.Fatal(parts)
	}
}

func TestArchiveMediaDescription(t *testing.T) {
	text := archiveMessage(domain.Archive{ID: "archive", Assets: []domain.Asset{{State: "ready", MIME: "video/mp4", AltText: "示例视频", Position: 0}}}, "complete")
	if !strings.Contains(text, "1 个视频") || !strings.Contains(text, "媒体 1 描述：示例视频") {
		t.Fatal(text)
	}
}
