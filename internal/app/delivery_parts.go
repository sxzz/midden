package app

import (
	"monitor/internal/domain"
	"monitor/internal/telegram"
)

type deliveryPart struct {
	kind   string
	text   string
	assets []domain.Asset
}

func deliveryParts(text string, assets []domain.Asset) []deliveryPart {
	var ready []domain.Asset
	for _, a := range assets {
		if a.State == "ready" {
			if a.Size > 50000000 {
				text += "\n\n文件已保存，但超过 Telegram 回传大小限制，可通过 API 下载。"
				continue
			}
			ready = append(ready, a)
		}
	}
	var parts []deliveryPart
	if len(ready) == 1 {
		caption, remainder := telegram.SplitCaption(text)
		parts = append(parts, deliveryPart{kind: "media", assets: ready, text: caption}, deliveryPart{kind: "buttons"})
		text = remainder
	} else if len(ready) > 1 {
		for len(ready) > 0 {
			n := 1
			for n < len(ready) && n < 10 && (ready[n].MIME == "video/webm") == (ready[0].MIME == "video/webm") {
				n++
			}
			parts = append(parts, deliveryPart{kind: "media", assets: ready[:n]})
			ready = ready[n:]
		}
	}
	if text != "" {
		for _, chunk := range telegram.Split(text) {
			parts = append(parts, deliveryPart{kind: "text", text: chunk})
		}
	}
	return parts
}
