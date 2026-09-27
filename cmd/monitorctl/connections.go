package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/google/uuid"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
	"monitor/internal/app"
	"monitor/internal/credentials"
	"monitor/internal/store"
)

func connectionCommand(ctx context.Context, db *store.Store, args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("connection-import TENANT NAME FILE|- [CONNECTION_ID] | connection-check TENANT ID | connection-revoke TENANT ID | connection-list TENANT")
	}
	tenant := args[1]
	parsed, e := uuid.Parse(tenant)
	if e != nil {
		return fmt.Errorf("invalid tenant ID")
	}
	tenant = parsed.String()
	s := &app.Service{DB: db}
	switch args[0] {
	case "connection-list":
		rows, e := db.Pool.Query(ctx, `SELECT id,name,state,coalesce(account_id,''),coalesce(username,'') FROM connections WHERE tenant_id=$1 ORDER BY name,id`, tenant)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var c app.Connection
			if e = rows.Scan(&c.ID, &c.Name, &c.State, &c.AccountID, &c.Username); e != nil {
				return e
			}
			fmt.Printf("%s\t%s\t%s\t%s\t%s\n", c.ID, c.Name, c.State, c.AccountID, c.Username)
		}
		return rows.Err()
	case "connection-revoke":
		if len(args) != 3 {
			return fmt.Errorf("connection-revoke TENANT ID")
		}
		return s.RevokeConnection(ctx, tenant, args[2])
	}
	ca := os.Getenv("ADAPTER_TLS_CA")
	if ca == "" {
		return fmt.Errorf("ADAPTER_TLS_CA is required for account connections")
	}
	vault, e := credentials.FromEnv()
	if e != nil {
		return e
	}
	if vault == nil {
		return fmt.Errorf("CREDENTIAL_KEY or CREDENTIAL_KEY_FILE is required")
	}
	address := os.Getenv("ADAPTER_ADDRESS")
	if address == "" {
		address = "adapter:9091"
	}
	conn, e := adapter.Dial(address, os.Getenv("ADAPTER_TOKEN"), ca)
	if e != nil {
		return e
	}
	defer conn.Close()
	s.Vault = vault
	s.AdapterTLS = true
	s.Adapter = pb.NewAdapterClient(conn)
	switch args[0] {
	case "connection-check":
		if len(args) != 3 {
			return fmt.Errorf("connection-check TENANT ID")
		}
		return s.CheckConnection(ctx, tenant, args[2])
	case "connection-import":
		if len(args) < 4 || len(args) > 5 {
			return fmt.Errorf("connection-import TENANT NAME FILE|- [CONNECTION_ID]")
		}
		input := io.Reader(os.Stdin)
		if args[3] != "-" {
			f, e := os.Open(args[3])
			if e != nil {
				return fmt.Errorf("cannot open credential file")
			}
			defer f.Close()
			input = f
		}
		raw, e := io.ReadAll(io.LimitReader(input, 16385))
		if e != nil || len(raw) > 16384 {
			return fmt.Errorf("invalid credential input")
		}
		var data struct {
			AuthToken string `json:"auth_token"`
			CSRFToken string `json:"ct0"`
		}
		if json.Unmarshal(raw, &data) != nil {
			return fmt.Errorf("expected JSON with auth_token and ct0")
		}
		id := ""
		if len(args) == 5 {
			id = args[4]
		}
		id, e = s.ImportConnection(ctx, tenant, id, args[2], &pb.SessionCredential{AuthToken: data.AuthToken, CsrfToken: data.CSRFToken})
		if e != nil {
			return e
		}
		fmt.Println(id)
		return nil
	}
	return fmt.Errorf("unknown account command")
}
