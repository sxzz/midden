package adapter

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"

	"github.com/santhosh-tekuri/jsonschema/v6"

	pb "monitor/api/adapter/v1"
)

const EntityGraph = "entity.graph"

var EntityName = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,127}$`)

type EntitySchema struct {
	JSON     json.RawMessage
	Compiled *jsonschema.Schema
}

type noSchemaLoader struct{}

func (noSchemaLoader) Load(string) (any, error) {
	return nil, fmt.Errorf("entity schemas must be self-contained")
}

// Compile once at discovery. Schemas are bundled so execution never depends on
// an external schema registry or interprets a platform field in the core.
func CompileEntityTypes(d *pb.DescribeResponse) (map[string]EntitySchema, error) {
	out := map[string]EntitySchema{}
	if len(d.EntityTypes) > 128 {
		return nil, fmt.Errorf("too many entity types")
	}
	for _, def := range d.EntityTypes {
		if def == nil || !EntityName.MatchString(def.Name) || len(def.JsonSchema) > 256<<10 {
			return nil, fmt.Errorf("invalid entity type")
		}
		if _, exists := out[def.Name]; exists {
			return nil, fmt.Errorf("duplicate entity type")
		}
		value, err := jsonschema.UnmarshalJSON(bytes.NewReader(def.JsonSchema))
		data, object := value.(map[string]any)
		if err != nil || !object || data["$schema"] != "https://json-schema.org/draft/2020-12/schema" {
			return nil, fmt.Errorf("entity type requires JSON Schema 2020-12")
		}
		c := jsonschema.NewCompiler()
		c.UseLoader(noSchemaLoader{})
		c.AssertFormat()
		uri := "https://schemas.invalid/" + def.Name
		if err := c.AddResource(uri, data); err != nil {
			return nil, fmt.Errorf("invalid entity schema %s", def.Name)
		}
		compiled, err := c.Compile(uri)
		if err != nil {
			return nil, fmt.Errorf("invalid entity schema %s: %w", def.Name, err)
		}
		raw, _ := json.Marshal(data)
		out[def.Name] = EntitySchema{JSON: raw, Compiled: compiled}
	}
	for _, p := range d.Providers {
		seen := map[string]bool{}
		for _, name := range p.EntityTypes {
			if _, ok := out[name]; !ok || seen[name] {
				return nil, fmt.Errorf("provider has undeclared or duplicate entity type")
			}
			seen[name] = true
		}
		if Supports(p, EntityGraph, 1, 0) && len(p.EntityTypes) == 0 {
			return nil, fmt.Errorf("entity.graph requires declared entity types")
		}
	}
	return out, nil
}

func (s EntitySchema) Validate(raw []byte) (json.RawMessage, error) {
	value, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	if err = s.Compiled.Validate(value); err != nil {
		return nil, err
	}
	return json.Marshal(value)
}
