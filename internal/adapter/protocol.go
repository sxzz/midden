package adapter

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	pb "monitor/api/adapter/v1"
)

const (
	ProtocolVersion   = "1.0"
	CaptureFetch      = "capture.fetch"
	ConnectionCheck   = "connection.check"
	CredentialPrepare = "credential.prepare"
)

var protocolPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

// Supports matches an operation's major and minimum additive minor revision.
// Unknown capabilities do not prevent discovery of supported operations.
func Supports(p *pb.Provider, name string, major, minor uint32) bool {
	for _, c := range p.GetCapabilities() {
		if c.GetName() == name && c.GetMajor() == major && c.GetMinor() >= minor {
			return true
		}
	}
	return false
}

func Validate(d *pb.DescribeResponse) error {
	if d == nil {
		return fmt.Errorf("missing adapter descriptor")
	}
	version := protocolPattern.FindStringSubmatch(d.ProtocolVersion)
	if version == nil {
		return fmt.Errorf("invalid adapter protocol version: expected major.minor")
	}
	major, e := strconv.ParseUint(version[1], 10, 32)
	if e != nil || major != 1 {
		return fmt.Errorf("incompatible adapter protocol major")
	}
	if _, e := strconv.ParseUint(version[2], 10, 32); e != nil {
		return fmt.Errorf("invalid adapter protocol minor")
	}
	if strings.TrimSpace(d.AdapterId) == "" {
		return fmt.Errorf("missing adapter ID")
	}
	hosts := map[string]bool{}
	for _, h := range d.Hosts {
		key := strings.ToLower(h)
		if strings.TrimSpace(h) == "" || hosts[key] {
			return fmt.Errorf("invalid or conflicting host rule")
		}
		hosts[key] = true
	}
	providers := map[string]bool{}
	defaults := map[string]bool{}
	for _, p := range d.Providers {
		if p == nil || strings.TrimSpace(p.Id) == "" || providers[p.Id] {
			return fmt.Errorf("invalid or duplicate provider")
		}
		providers[p.Id] = true
		if p.DefaultProvider {
			if defaults[p.Authentication] {
				return fmt.Errorf("duplicate default provider")
			}
			defaults[p.Authentication] = true
		}
		capabilities := map[string]bool{}
		for _, c := range p.Capabilities {
			if c == nil || strings.TrimSpace(c.Name) == "" || c.Major == 0 {
				return fmt.Errorf("invalid capability")
			}
			key := fmt.Sprintf("%s/%d", c.Name, c.Major)
			if capabilities[key] {
				return fmt.Errorf("duplicate capability")
			}
			capabilities[key] = true
		}
		// Only fetching content requires a declared visibility policy.
		if Supports(p, CaptureFetch, 1, 0) && len(p.Visibilities) == 0 {
			return fmt.Errorf("missing provider visibility")
		}
		seen := map[pb.Visibility]bool{}
		for _, v := range p.Visibilities {
			if (v != pb.Visibility_VISIBILITY_PUBLIC && v != pb.Visibility_VISIBILITY_PRIVATE) || seen[v] {
				return fmt.Errorf("invalid provider visibility")
			}
			seen[v] = true
		}
	}
	_, err := CompileEntityTypes(d)
	return err
}
