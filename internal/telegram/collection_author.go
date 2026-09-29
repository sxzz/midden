package telegram

import (
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf16"

	"monitor/internal/domain"
)

var (
	xHandle = regexp.MustCompile(`^[A-Za-z0-9_]{1,15}$`)
	xUserID = regexp.MustCompile(`^[0-9]+$`)
)

// X presentation belongs to the Telegram channel, not the collection store or core protocol.
func CollectionAuthorURL(a domain.Collection) string {
	if a.Graph == nil {
		return ""
	}
	key := a.Graph.Root
	for _, relation := range a.Graph.Relations {
		if relation.Source == a.Graph.Root && relation.Type == "authored_by" {
			key = relation.Target
			break
		}
	}
	for _, entity := range a.Graph.Entities {
		if entity.Key != key || entity.Type != "x.profile" {
			continue
		}
		var profile struct {
			Username string `json:"username"`
		}
		if json.Unmarshal(entity.Data, &profile) == nil && xHandle.MatchString(profile.Username) {
			return "https://x.com/" + profile.Username
		}
		if xUserID.MatchString(entity.ExternalID) {
			return "https://x.com/i/user/" + entity.ExternalID
		}
	}
	return ""
}

func IsProfileCollection(a domain.Collection) bool {
	if a.Graph != nil {
		for _, entity := range a.Graph.Entities {
			if entity.Key == a.Graph.Root && entity.Type == "x.profile" {
				return true
			}
		}
	}
	return false
}

// ProfilePresentation reads the adapter-owned profile entity for Telegram display.
func ProfilePresentation(a domain.Collection) (string, []Entity, []domain.Asset, bool) {
	if !IsProfileCollection(a) {
		return "", nil, nil, false
	}
	for _, entity := range a.Graph.Entities {
		if entity.Key != a.Graph.Root {
			continue
		}
		var profile struct {
			Name     string `json:"name"`
			Username string `json:"username"`
			Metadata struct {
				Description string `json:"description"`
			} `json:"metadata"`
		}
		_ = json.Unmarshal(entity.Data, &profile)
		name := strings.TrimSpace(profile.Name)
		if name == "" {
			name = strings.TrimSpace(a.AuthorName)
		}
		if name == "" {
			name = "未知作者"
		}
		text := name
		if profile.Username != "" {
			text += "\n@" + profile.Username
		}
		if bio := strings.TrimSpace(profile.Metadata.Description); bio != "" {
			text += "\n\n" + bio
		}
		var entities []Entity
		if url := CollectionAuthorURL(a); url != "" {
			entities = append(entities, Entity{Type: "text_link", Length: len(utf16.Encode([]rune(name))), URL: url})
		}
		var assets []domain.Asset
		for _, asset := range entity.Assets {
			if asset.Purpose == "avatar" {
				assets = append(assets, asset)
				break
			}
		}
		return text, entities, assets, true
	}
	return "", nil, nil, false
}
