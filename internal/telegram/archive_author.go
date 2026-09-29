package telegram

import (
	"encoding/json"
	"regexp"

	"monitor/internal/domain"
)

var xHandle = regexp.MustCompile(`^[A-Za-z0-9_]{1,15}$`)
var xUserID = regexp.MustCompile(`^[0-9]+$`)

// X presentation belongs to the Telegram channel, not the archive store or core protocol.
func ArchiveAuthorURL(a domain.Archive) string {
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
