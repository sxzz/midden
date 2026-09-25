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
			ready = append(ready, a)
		}
	}
	var parts []deliveryPart
	if len(ready) > 0 {
		caption, remainder := telegram.SplitCaption(text)
		first := true
		for len(ready) > 0 {
			n := min(10, len(ready))
			part := deliveryPart{kind: "images", assets: ready[:n]}
			if first {
				part.text = caption
			}
			parts = append(parts, part)
			if first {
				parts = append(parts, deliveryPart{kind: "buttons"})
				first = false
			}
			ready = ready[n:]
		}
		text = remainder
	}
	if text != "" {
		for _, chunk := range telegram.Split(text) {
			parts = append(parts, deliveryPart{kind: "text", text: chunk})
		}
	}
	return parts
}
