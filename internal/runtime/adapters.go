package runtime

import (
	"encoding/json"
	"fmt"
	"strings"
)

type adapterEndpointConfig struct {
	Address string
	Token   string
	TLSCA   string `json:"tls_ca"`
}

func adapterEndpoints(primary adapterEndpointConfig, additional, bundled string) ([]adapterEndpointConfig, error) {
	var extra []adapterEndpointConfig
	if json.Unmarshal([]byte(additional), &extra) != nil {
		return nil, fmt.Errorf("invalid additional_adapters config")
	}
	endpoints := append([]adapterEndpointConfig{primary}, extra...)
	for _, address := range strings.Split(bundled, ",") {
		if address = strings.TrimSpace(address); address != "" {
			endpoints = append(endpoints, adapterEndpointConfig{Address: address, Token: primary.Token, TLSCA: primary.TLSCA})
		}
	}
	unique := make([]adapterEndpointConfig, 0, len(endpoints))
	seen := make(map[string]adapterEndpointConfig)
	for _, endpoint := range endpoints {
		if previous, ok := seen[endpoint.Address]; ok {
			if previous != endpoint {
				return nil, fmt.Errorf("conflicting adapter authentication for %s", endpoint.Address)
			}
			continue
		}
		seen[endpoint.Address] = endpoint
		unique = append(unique, endpoint)
	}
	return unique, nil
}
