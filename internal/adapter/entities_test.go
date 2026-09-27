package adapter

import (
	"bytes"
	"testing"

	pb "monitor/api/adapter/v1"
)

func TestEntitySchemasRespectUnknownCapabilitiesAndPrecision(t *testing.T) {
	d := &pb.DescribeResponse{ProtocolVersion: "1.0", AdapterId: "weather", EntityTypes: []*pb.EntityType{{Name: "weather.report", JsonSchema: []byte(`{"$schema":"https://json-schema.org/draft/2020-12/schema","const":9007199254740993}`)}}, Providers: []*pb.Provider{{Id: "weather", EntityTypes: []string{"weather.report"}, Capabilities: []*pb.Capability{{Name: EntityGraph, Major: 2}}}}}
	if err := Validate(d); err != nil {
		t.Fatal("unknown capability must not block discovery", err)
	}
	schemas, err := CompileEntityTypes(d)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = schemas["weather.report"].Validate([]byte(`9007199254740992`)); err == nil {
		t.Fatal("schema precision lost")
	}
	data, err := schemas["weather.report"].Validate([]byte(`9007199254740993`))
	if err != nil || !bytes.Equal(data, []byte(`9007199254740993`)) {
		t.Fatal("data precision lost", err)
	}
	d.EntityTypes[0].JsonSchema = []byte(`{"$schema":"https://json-schema.org/draft/2020-12/schema","$ref":"https://schemas.example/report"}`)
	if _, err = CompileEntityTypes(d); err == nil {
		t.Fatal("unbundled schema accepted")
	}
}
