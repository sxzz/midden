package buildinfo

import "runtime/debug"

// Revision is supplied by the image build; local Go builds use embedded VCS data.
var Revision string

func Version() string {
	if Revision != "" {
		return Revision
	}
	revision, modified := "", false
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, setting := range info.Settings {
			switch setting.Key {
			case "vcs.revision":
				revision = setting.Value
			case "vcs.modified":
				modified = setting.Value == "true"
			}
		}
	}
	if revision == "" {
		return "dev"
	}
	if modified {
		revision += "-dirty"
	}
	return revision
}
