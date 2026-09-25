package fxtwitter

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/durationpb"

	pb "monitor/api/adapter/v1"
)

type Client struct {
	HTTP     *http.Client
	Endpoint string
}
type media struct {
	Sensitive         bool   `json:"sensitive"`
	PossiblySensitive bool   `json:"possibly_sensitive"`
	ID                string `json:"id"`
	AltText           string `json:"altText"`
	Type              string `json:"type"`
	URL               string `json:"url"`
	Formats           []struct {
		Container string `json:"container"`
		Codec     string `json:"codec"`
		Width     int64  `json:"width"`
		Height    int64  `json:"height"`
		Bitrate   int64  `json:"bitrate"`
		URL       string `json:"url"`
	} `json:"formats"`
}
type mediaSet struct {
	All      []media         `json:"all"`
	Photos   []media         `json:"photos"`
	Videos   []media         `json:"videos"`
	External json.RawMessage `json:"external"`
}

func (c *Client) Fetch(ctx context.Context, id string) (*pb.FetchResponse, error) {
	endpoint := c.Endpoint
	if endpoint == "" {
		endpoint = "https://api.fxtwitter.com/2/status"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(endpoint, "/")+"/"+url.PathEscape(id), nil)
	if err != nil {
		return nil, status.Error(codes.Internal, "invalid provider endpoint")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Monitor/0.3")
	response, err := c.HTTP.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, status.FromContextError(ctx.Err()).Err()
		}
		return nil, status.Error(codes.Unavailable, "provider request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, responseError(response.StatusCode, response.Header.Get("Retry-After"))
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	if err != nil || len(body) > 2<<20 {
		return nil, status.Error(codes.Unavailable, "invalid provider response")
	}
	var data struct {
		Code   int `json:"code"`
		Status *struct {
			PossiblySensitive bool      `json:"possibly_sensitive"`
			Type              string    `json:"type"`
			ID                string    `json:"id"`
			Text              *string   `json:"text"`
			Media             *mediaSet `json:"media"`
			Author            struct {
				Protected bool `json:"protected"`
			} `json:"author"`
			Article json.RawMessage `json:"article"`
		} `json:"status"`
	}
	if json.Unmarshal(body, &data) != nil || data.Code == 0 {
		return nil, status.Error(codes.Unavailable, "invalid provider response")
	}
	if data.Code != 200 {
		return nil, responseError(data.Code, response.Header.Get("Retry-After"))
	}
	post := data.Status
	if post != nil && post.Type == "tombstone" {
		return nil, status.Error(codes.FailedPrecondition, "provider cannot access this post")
	}
	if post == nil || post.Type != "status" || post.ID != id || post.Text == nil {
		return nil, status.Error(codes.Unavailable, "invalid provider post")
	}
	if post.Author.Protected {
		return nil, status.Error(codes.FailedPrecondition, "public provider cannot archive private posts")
	}
	out := &pb.FetchResponse{ExternalId: id, ProviderId: "fxtwitter", Visibility: pb.Visibility_VISIBILITY_PUBLIC, Text: strings.TrimSpace(*post.Text), TextKind: "post_text", TextSource: "fxtwitter"}
	warn := func(message string) { out.Incomplete = true; out.Warnings = append(out.Warnings, message) }
	if post.Media == nil {
		warn("未能确认帖子媒体信息。")
	} else {
		items := post.Media.All
		if items == nil {
			items = append(append([]media{}, post.Media.Photos...), post.Media.Videos...)
		}
		seen := map[string]bool{}
		unsupported, invalid := false, false
		for _, item := range items {
			switch item.Type {
			case "photo", "video", "gif":
				kind := "image"
				if item.Type != "photo" {
					kind = "video"
					var best, pixels int64 = -1, -1
					selected := ""
					for _, f := range item.Formats {
						if (f.Container == "mp4" || f.Container == "webm") && f.URL != "" && (f.Width*f.Height > pixels || (f.Width*f.Height == pixels && f.Bitrate > best)) {
							selected, best, pixels = f.URL, f.Bitrate, f.Width*f.Height
						}
					}
					if selected != "" {
						item.URL = selected
					}
					u, err := url.Parse(item.URL)
					if err != nil || (!strings.HasSuffix(strings.ToLower(u.Path), ".mp4") && !strings.HasSuffix(strings.ToLower(u.Path), ".webm")) {
						invalid = true
						continue
					}
				}
				u, err := url.Parse(item.URL)
				if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "https" && u.Scheme != "http") {
					invalid = true
					continue
				}
				if !seen[item.URL] {
					seen[item.URL] = true
					key := ""
					if kind == "video" && item.ID != "" {
						key = item.ID + ":" + u.EscapedPath()
					}
					out.Resources = append(out.Resources, &pb.Resource{Url: item.URL, Kind: kind, ImmutableKey: key, AltText: strings.TrimSpace(item.AltText), Sensitive: post.PossiblySensitive || item.Sensitive || item.PossiblySensitive})
				}
			default:
				unsupported = true
			}
		}
		if len(post.Media.External) > 0 && string(post.Media.External) != "null" {
			unsupported = true
		}
		if unsupported {
			warn("此类媒体暂不支持归档。")
		}
		if invalid {
			warn("部分媒体缺少有效下载地址。")
		}
	}
	if len(post.Article) > 0 && string(post.Article) != "null" {
		warn("文章正文暂不支持归档。")
	}
	if out.Text == "" && len(out.Resources) == 0 {
		return nil, status.Error(codes.FailedPrecondition, "provider returned no supported text or media")
	}
	return out, nil
}

func responseError(code int, retry string) error {
	if code == 429 || code >= 500 {
		st := status.New(codes.Unavailable, "provider temporarily unavailable")
		var delay time.Duration
		if n, err := strconv.Atoi(retry); err == nil && n > 0 && n <= 86400 {
			delay = time.Duration(n) * time.Second
		} else if deadline, err := http.ParseTime(retry); err == nil {
			delay = time.Until(deadline)
		}
		if delay > 0 {
			st, _ = st.WithDetails(&errdetails.RetryInfo{RetryDelay: durationpb.New(delay)})
		}
		return st.Err()
	}
	return status.Error(codes.FailedPrecondition, "provider cannot access this post")
}
