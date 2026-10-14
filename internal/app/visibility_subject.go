package app

import (
	pb "monitor/api/adapter/v1"
)

// visibilitySubjects reads the account a private result is private for and the
// accounts the fetch observed public. Both stay on the result's own platform.
func visibilitySubjects(r *pb.FetchResponse, platform string) (*objectRef, []objectRef, error) {
	valid := func(s *pb.ObjectRef) bool {
		return s != nil && s.Platform == platform && s.Kind != "" && s.ExternalId != "" && len(s.Kind)+len(s.ObjectScope)+len(s.ExternalId) <= 512
	}
	var private *objectRef
	if s := r.PrivateSubject; s != nil {
		if !valid(s) || r.Visibility != pb.Visibility_VISIBILITY_PRIVATE {
			return nil, nil, &PermanentError{"invalid private subject"}
		}
		private = &objectRef{s.Platform, s.Kind, s.ObjectScope, s.ExternalId}
	}
	if len(r.PublicSubjects) > 64 {
		return nil, nil, &PermanentError{"too many public subjects"}
	}
	public := make([]objectRef, 0, len(r.PublicSubjects))
	for _, s := range r.PublicSubjects {
		if !valid(s) {
			return nil, nil, &PermanentError{"invalid public subject"}
		}
		public = append(public, objectRef{s.Platform, s.Kind, s.ObjectScope, s.ExternalId})
	}
	return private, public, nil
}
