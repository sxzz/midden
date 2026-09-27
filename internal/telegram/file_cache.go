package telegram

import (
	"context"
	"io"
	"log/slog"
	"strings"

	tg "github.com/go-telegram-bot-api/telegram-bot-api/v5"

	"monitor/internal/domain"
)

type preparedFile struct {
	width, height int
	data          tg.RequestFileData
	closer        io.Closer
	kind          string
	cachedID      string
}

func mediaKind(a domain.Asset, document bool) string {
	if document || a.MIME == "video/webm" {
		return "document"
	}
	if a.MIME == "video/mp4" {
		return "video"
	}
	return "photo"
}

func (c *Client) prepareFile(ctx context.Context, a domain.Asset, kind string, useCache bool) (preparedFile, error) {
	p := preparedFile{kind: kind}
	if useCache && c.Cache != nil && c.BotID != "" && a.Hash != "" {
		id, err := c.Cache.GetChannelMedia(ctx, "telegram", c.BotID, a.Hash, kind)
		if err != nil {
			return p, err
		}
		if id != "" {
			p.data = tg.FileID(id)
			p.cachedID = id
			return p, nil
		}
	}
	reader, err := c.Blobs.Get(ctx, a.Key)
	if err != nil {
		return p, err
	}
	if kind == "video" {
		defer reader.Close()
		return prepareVideo(ctx, reader, a.Hash+extension(a.MIME))
	}
	p.data = tg.FileReader{Name: a.Hash + extension(a.MIME), Reader: reader}
	p.closer = reader
	return p, nil
}

func (p preparedFile) close() {
	if p.closer != nil {
		p.closer.Close()
	}
}

func (c *Client) forgetFile(ctx context.Context, a domain.Asset, p preparedFile) {
	if p.cachedID != "" && c.Cache != nil {
		if err := c.Cache.DeleteChannelMedia(ctx, "telegram", c.BotID, a.Hash, p.kind, p.cachedID); err != nil {
			slog.Warn("Telegram file cache invalidation failed")
		}
	}
}

func (c *Client) rememberFile(ctx context.Context, a domain.Asset, kind string, m tg.Message) {
	if c.Cache == nil || c.BotID == "" || a.Hash == "" {
		return
	}
	id := ""
	switch kind {
	case "video":
		if m.Video != nil {
			id = m.Video.FileID
		}
	case "document":
		if m.Document != nil {
			id = m.Document.FileID
		}
	case "photo":
		area := 0
		for _, p := range m.Photo {
			if p.Width*p.Height >= area {
				area = p.Width * p.Height
				id = p.FileID
			}
		}
	}
	if id == "" {
		return
	}
	// A cache write failure must not turn a confirmed send into a delivery retry.
	if err := c.Cache.PutChannelMedia(ctx, "telegram", c.BotID, a.Hash, kind, id); err != nil {
		slog.Warn("Telegram file cache write failed")
	}
}

func invalidFileReference(description string) bool {
	text := strings.ToLower(description)
	return strings.Contains(text, "wrong file identifier") || strings.Contains(text, "wrong remote file identifier") || strings.Contains(text, "file_reference_expired") || strings.Contains(text, "file reference expired") || strings.Contains(text, "invalid file_id") || strings.Contains(text, "file_id not found")
}
