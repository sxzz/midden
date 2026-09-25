package xdown

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/html"
	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/durationpb"

	pb "monitor/api/adapter/v1"
	"monitor/internal/domain"
)

const Version = "0.1.0"

type Server struct {
	pb.UnimplementedAdapterServer
	Client   *http.Client
	Endpoint string
}

func (s *Server) Describe(context.Context, *pb.DescribeRequest) (*pb.DescribeResponse, error) {
	return &pb.DescribeResponse{ProtocolVersion: "1", AdapterId: "x", Version: Version, Hosts: []string{"x.com", "twitter.com", "www.x.com", "www.twitter.com", "mobile.x.com", "mobile.twitter.com"}, Providers: []*pb.Provider{{Id: "xdown", Authentication: "none"}}, Capabilities: []string{"fetch_url", "text", "image"}}, nil
}

func (s *Server) Fetch(ctx context.Context, r *pb.FetchRequest) (*pb.FetchResponse, error) {
	if r.ConnectionId != "" || r.ProviderId != "xdown" || r.AccessScope != "public" {
		return nil, status.Error(codes.Unimplemented, "account authentication is not supported")
	}
	t, e := domain.Normalize(r.Url)
	if e != nil || t.ExternalID != r.ExternalId {
		return nil, status.Error(codes.InvalidArgument, "invalid post URL")
	}
	endpoint := s.Endpoint
	if endpoint == "" {
		endpoint = "https://xdown.app/api/ajaxSearch"
	}
	req, e := http.NewRequestWithContext(ctx, "POST", endpoint, strings.NewReader(url.Values{"q": {t.URL}, "lang": {"zh-cn"}}.Encode()))
	if e != nil {
		return nil, status.Error(codes.Internal, "request construction failed")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "https://xdown.app")
	req.Header.Set("Referer", "https://xdown.app/")
	req.Header.Set("User-Agent", "Mozilla/5.0")
	req.Header.Set("Accept", "application/json")
	resp, e := s.Client.Do(req)
	if e != nil {
		return nil, status.Error(codes.Unavailable, "provider request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode == 429 || resp.StatusCode >= 500 {
		st := status.New(codes.Unavailable, "provider temporarily unavailable")
		d := retryAfter(resp.Header.Get("Retry-After"))
		if d > 0 {
			st, _ = st.WithDetails(&errdetails.RetryInfo{RetryDelay: durationpb.New(d)})
		}
		return nil, st.Err()
	}
	if resp.StatusCode != 200 {
		return nil, status.Error(codes.FailedPrecondition, "provider rejected request")
	}
	b, e := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024+1))
	if e != nil || len(b) > 2*1024*1024 {
		return nil, status.Error(codes.Unavailable, "invalid provider response")
	}
	var data struct {
		Status string `json:"status"`
		Data   string `json:"data"`
	}
	if json.Unmarshal(b, &data) != nil || data.Status != "ok" || data.Data == "" {
		return nil, status.Error(codes.FailedPrecondition, "provider returned no usable result")
	}
	out, e := Parse(data.Data)
	if e != nil {
		return nil, status.Error(codes.FailedPrecondition, e.Error())
	}
	out.ExternalId = t.ExternalID
	out.ProviderId = "xdown"
	out.AdapterVersion = Version
	return out, nil
}

func retryAfter(s string) time.Duration {
	if n, e := strconv.Atoi(s); e == nil && n > 0 {
		return time.Duration(n) * time.Second
	}
	if t, e := http.ParseTime(s); e == nil && time.Until(t) > 0 {
		return time.Until(t)
	}
	return 0
}

func Parse(src string) (*pb.FetchResponse, error) {
	root, e := html.Parse(strings.NewReader(src))
	if e != nil {
		return nil, e
	}
	out := &pb.FetchResponse{TextKind: "provider_summary", Warnings: []string{"第三方来源 xdown；文字可能仅为标题或摘要，完整性未经验证。"}}
	seen := map[string]bool{}
	unsupported := false
	var text func(*html.Node) string
	text = func(n *html.Node) string {
		if n.Type == html.TextNode {
			return n.Data
		}
		s := ""
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			s += text(c)
		}
		return s
	}
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if n.Data == "h3" && out.Text == "" {
				out.Text = strings.TrimSpace(text(n))
			}
			if n.Data == "a" {
				attrs := map[string]string{}
				for _, a := range n.Attr {
					attrs[a.Key] = a.Val
				}
				class := " " + attrs["class"] + " "
				if strings.Contains(class, " tw-button-dl ") || strings.Contains(class, " abutton ") {
					label := strings.ToLower(text(n))
					if strings.Contains(label, "mp4") || strings.Contains(label, "gif") {
						unsupported = true
					} else if strings.Contains(label, "下载图片") || strings.Contains(label, "download photo") || strings.Contains(label, "download image") {
						u, e := url.Parse(attrs["href"])
						if e == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != "" && u.User == nil && !seen[u.String()] {
							seen[u.String()] = true
							out.Resources = append(out.Resources, &pb.Resource{Url: u.String(), Kind: "image"})
						}
					}
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)
	if unsupported {
		out.Warnings = append(out.Warnings, "视频或 GIF 不在本期归档范围。")
	}
	if out.Text == "" && len(out.Resources) == 0 {
		return nil, fmt.Errorf("provider returned no supported text or images")
	}
	return out, nil
}
