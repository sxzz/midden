package runtime

import (
	"reflect"
	"testing"
)

func TestBundledAdapterEndpoints(t *testing.T) {
	primary := adapterEndpointConfig{Address: "adapter:9091", Token: "shared", TLSCA: "/tls/adapter.crt"}
	custom := adapterEndpointConfig{Address: "external:9093", Token: "separate", TLSCA: "/tls/external.crt"}
	for _, test := range []struct {
		name, additional, bundled string
		want                      []adapterEndpointConfig
		invalid                   bool
	}{
		{name: "legacy primary", additional: "[]", want: []adapterEndpointConfig{primary}},
		{name: "default bundle and custom", additional: `[{"Address":"external:9093","Token":"separate","tls_ca":"/tls/external.crt"}]`, bundled: " adapter:9092, ,adapter:9092,adapter:9091", want: []adapterEndpointConfig{primary, custom, {Address: "adapter:9092", Token: primary.Token, TLSCA: primary.TLSCA}}},
		{name: "existing bundle registration", additional: `[{"Address":"adapter:9092","Token":"shared","tls_ca":"/tls/adapter.crt"}]`, bundled: "adapter:9092", want: []adapterEndpointConfig{primary, {Address: "adapter:9092", Token: primary.Token, TLSCA: primary.TLSCA}}},
		{name: "invalid custom config", additional: "{", invalid: true},
		{name: "conflicting authentication", additional: `[{"Address":"adapter:9092","Token":"other"}]`, bundled: "adapter:9092", invalid: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			actual, err := adapterEndpoints(primary, test.additional, test.bundled)
			if (err != nil) != test.invalid {
				t.Fatal(err)
			}
			if !test.invalid && !reflect.DeepEqual(actual, test.want) {
				t.Fatalf("endpoints: %#v", actual)
			}
		})
	}
}
