package credentials

import (
	"encoding/base64"
	"testing"

	pb "monitor/api/adapter/v1"
)

func TestVault(t *testing.T) {
	v, e := New(base64.StdEncoding.EncodeToString(make([]byte, 32)))
	if e != nil {
		t.Fatal(e)
	}
	c := &pb.Credential{Data: []byte("opaque-fixture-credential")}
	b, e := v.Seal("tenant", "ref", c)
	if e != nil {
		t.Fatal(e)
	}
	out, e := v.Open("tenant", "ref", b)
	if e != nil || string(out.Data) != string(c.Data) {
		t.Fatal(e)
	}
	if _, e = v.Open("other", "ref", b); e == nil {
		t.Fatal("AAD failed")
	}
	b[len(b)-1] ^= 1
	if _, e = v.Open("tenant", "ref", b); e == nil {
		t.Fatal("tampering accepted")
	}
	if v, e := New(""); e != nil || v != nil {
		t.Fatal("public mode requires key")
	}
}
