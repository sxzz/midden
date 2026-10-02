package tgchannel

import (
	"fmt"
	"net/url"
	"strings"
	"unicode/utf16"

	"monitor/internal/domain"
	"monitor/internal/telegram"
)

func jobState(state string) string {
	switch state {
	case "queued":
		return "正在采集"
	case "downloading":
		return "正在保存媒体"
	case "complete":
		return "收藏完成"
	case "partial":
		return "已收藏，部分资源缺失"
	case "failed":
		return "收藏失败"
	}
	return state
}

func collectionButtons(id, sourceURL, webURL string) telegram.Keyboard {
	keys := telegram.Keyboard{
		{{Text: "原帖", URL: sourceURL}, {Text: "重新抓取", Data: "/refresh " + id}},
		{{Text: "删除", Data: "/delete " + id}},
		{{Text: "收藏列表", Data: "/list"}},
	}
	return appendMiniAppButton(keys, id, webURL)
}

func appendMiniAppButton(keys telegram.Keyboard, id, webURL string) telegram.Keyboard {
	if webURL != "" {
		if entry, err := url.Parse(webURL); err == nil && entry.Scheme == "https" && entry.Host != "" {
			entry.Fragment = "/collection/" + id
			keys = append(keys, []telegram.Button{{Text: "在小程序中打开", WebApp: &telegram.WebAppInfo{URL: entry.String()}}})
		}
	}
	return keys
}

func usageText(u domain.Usage) string {
	mib := func(n int64) string {
		if n >= 1<<30 {
			return fmt.Sprintf("%.1f GiB", float64(n)/(1<<30))
		}
		return fmt.Sprintf("%.1f MiB", float64(n)/(1<<20))
	}
	// An unlimited tenant has no limit worth printing.
	text := "已用 " + mib(u.Used) + "，共 " + mib(u.Limit)
	if u.Unlimited {
		text = "已用 " + mib(u.Used) + "，不限额"
	}
	if u.Reserved > 0 {
		text += "\n保存中 " + mib(u.Reserved)
	}
	return text
}

func collectionMessage(a domain.Collection, state string) string {
	header := a.ID
	author := strings.TrimSpace(a.AuthorName)
	if author == "" {
		author = "未知作者"
	}
	body := strings.TrimSpace(a.Text)
	if body == "" {
		body = "空"
	}
	parts := []string{header, author + "：\n" + body}
	if text, _, _, ok := telegram.ProfilePresentation(a); ok {
		parts = []string{text}
	}
	if state == "partial" {
		parts = append(parts, "部分内容未保存")
	}
	for _, asset := range a.Assets {
		if alt := strings.TrimSpace(asset.AltText); alt != "" {
			parts = append(parts, fmt.Sprintf("媒体 %d 描述：%s", asset.Position+1, alt))
		}
	}
	seen := map[string]bool{}
	addReason := func(reason string) {
		reason = failureReason(reason)
		if reason != "" && !seen[reason] {
			seen[reason] = true
			parts = append(parts, "未完整保存原因："+reason)
		}
	}
	for _, warning := range a.Warnings {
		addReason(warning)
	}
	for _, asset := range a.Assets {
		if asset.State == "failed" {
			addReason(asset.Error)
		}
	}
	return strings.Join(parts, "\n\n")
}

func collectionMessageEntities(a domain.Collection) []telegram.Entity {
	if _, entities, _, ok := telegram.ProfilePresentation(a); ok {
		return entities
	}
	size := func(s string) int { return len(utf16.Encode([]rune(s))) }
	author := strings.TrimSpace(a.AuthorName)
	if author == "" {
		author = "未知作者"
	}
	entities := []telegram.Entity{{Type: "code", Offset: 0, Length: size(a.ID)}}
	if url := telegram.CollectionAuthorURL(a); url != "" {
		entities = append(entities, telegram.Entity{Type: "text_link", Offset: size(a.ID + "\n\n"), Length: size(author), URL: url})
	}
	if body := strings.TrimSpace(a.Text); body != "" {
		entities = append(entities, telegram.Entity{Type: "blockquote", Offset: size(a.ID + "\n\n" + author + "：\n"), Length: size(body)})
	}
	return entities
}

func collectionListSummary(summary, text string) string {
	if strings.TrimSpace(summary) == "" {
		summary = text
	}
	summary = strings.Join(strings.Fields(summary), " ")
	if summary == "" {
		return "无文字内容"
	}
	const limit = 100
	chars := []rune(summary)
	if len(chars) > limit {
		// Retain adapter-provided media indicators even when the text is long.
		suffix := ""
		prefix := summary
		for {
			marker := ""
			for _, candidate := range []string{"[图片]", "[视频]"} {
				if strings.HasSuffix(prefix, candidate) {
					marker = candidate
					break
				}
			}
			if marker == "" {
				break
			}
			suffix = marker + suffix
			prefix = strings.TrimSuffix(prefix, marker)
		}
		budget := limit - len([]rune(suffix)) - 1
		if suffix != "" && budget > 0 {
			return string([]rune(prefix)[:budget]) + "…" + suffix
		}
		return string(chars[:limit-1]) + "…"
	}
	return summary
}

func failureReason(reason string) string {
	switch strings.TrimSpace(reason) {
	case "storage quota exceeded":
		return "存储配额不足"
	case "account cannot access this post":
		return "采集账号无权访问该帖子"
	case "account is suspended":
		return "账号已被封禁，解封后可重新抓取"
	case "profile not found":
		return "账号不存在或已改名"
	case "post not found or deleted":
		return "帖子不存在或已删除"
	case "provider cannot access this post":
		return "无法获取该帖子"
	case "provider cannot access this profile":
		return "无法获取该账号资料"
	case "account request signing unavailable":
		return "采集账号请求签名不可用"
	case "context deadline exceeded":
		return "请求超时"
	case "job exhausted retries or was interrupted":
		return "任务重试次数已用尽或执行被中断"
	case "operation failed; retry or inspect service health":
		return "服务内部错误"
	case "resource omitted: unsupported type or resource limit":
		return "部分资源类型不支持或资源数量超过限制"
	default:
		return strings.TrimSpace(reason)
	}
}
