package telegram

import (
	"context"
	"fmt"
	"strconv"

	tg "github.com/go-telegram-bot-api/telegram-bot-api/v5"

	"monitor/internal/domain"
)

type inputMedia struct {
	Type      string             `json:"type"`
	Media     string             `json:"media"`
	Caption   string             `json:"caption,omitempty"`
	Entities  []tg.MessageEntity `json:"caption_entities,omitempty"`
	Streaming bool               `json:"supports_streaming,omitempty"`
	Spoiler   bool               `json:"has_spoiler,omitempty"`
}

// Use the SDK's parameter/upload APIs: v5.5.1 media configs omit has_spoiler.
func (c *Client) sendMedia(ctx context.Context, chat string, assets []domain.Asset, prepared []preparedFile, out any) error {
	if _, err := strconv.ParseInt(chat, 10, 64); err != nil {
		return err
	}
	params := tg.Params{"chat_id": chat}
	if c.replyTo != 0 {
		params["reply_to_message_id"] = strconv.FormatInt(c.replyTo, 10)
	}
	var files []tg.RequestFile
	var media []inputMedia
	for i, p := range prepared {
		name := p.kind
		if len(assets) > 1 {
			name = fmt.Sprintf("media%d", i)
		}
		ref := ""
		if p.data.NeedsUpload() {
			files = append(files, tg.RequestFile{Name: name, Data: p.data})
			ref = "attach://" + name
		} else {
			ref = p.data.SendData()
		}
		m := inputMedia{Type: p.kind, Media: ref, Streaming: p.kind == "video", Spoiler: assets[i].Sensitive && p.kind != "document"}
		if i == 0 {
			m.Caption = c.caption
			m.Entities = c.textEntities(c.caption)
		}
		media = append(media, m)
	}
	method := "sendMediaGroup"
	if len(media) == 1 {
		m := media[0]
		switch m.Type {
		case "photo":
			method = "sendPhoto"
		case "video":
			method = "sendVideo"
		case "document":
			method = "sendDocument"
		}
		if len(files) == 0 {
			params[m.Type] = m.Media
		}
		params.AddNonEmpty("caption", m.Caption)
		if err := params.AddInterface("caption_entities", m.Entities); err != nil {
			return err
		}
		if m.Streaming {
			params["supports_streaming"] = "true"
		}
		if m.Spoiler {
			params["has_spoiler"] = "true"
		}
	} else {
		if err := params.AddInterface("media", media); err != nil {
			return err
		}
	}
	sdk := c.sdk(ctx)
	var response *tg.APIResponse
	var err error
	if len(files) > 0 {
		response, err = sdk.UploadFiles(method, params, files)
	} else {
		response, err = sdk.MakeRequest(method, params)
	}
	return decodeResponse(response, err, out)
}
