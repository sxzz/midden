package adapter

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	hp "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
)

func TestTypeScriptTLSProtocol(t *testing.T) {
	root, e := filepath.Abs("../..")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = os.Stat(filepath.Join(root, "adapters/x/dist/server.js")); e != nil {
		t.Skip("npm run build required")
	}
	fixture, e := os.ReadFile(filepath.Join(root, "adapters/x/src/testdata/post.json"))
	if e != nil {
		t.Fatal(e)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/99" {
			w.Header().Set("Retry-After", "7")
			w.WriteHeader(429)
			return
		}
		if r.Header.Get("Cookie") != "" {
			t.Error("public API received credentials")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(fixture)
	}))
	defer upstream.Close()
	dir := t.TempDir()
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"}, DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	cert, e := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if e != nil {
		t.Fatal(e)
	}
	der, e := x509.MarshalPKCS8PrivateKey(key)
	if e != nil {
		t.Fatal(e)
	}
	ca := filepath.Join(dir, "cert.pem")
	keyfile := filepath.Join(dir, "key.pem")
	os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert}), 0o600)
	os.WriteFile(keyfile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600)
	script := `import {createServer} from './adapters/x/dist/server.js'; import {fetchPublic} from './adapters/x/dist/provider.js'; import {ServerCredentials} from '@grpc/grpc-js'; import {readFileSync} from 'node:fs'; const s=createServer('fixture',true,(id,signal)=>fetchPublic(id,signal,process.env.FIXTURE_ENDPOINT)); s.bindAsync('127.0.0.1:0',ServerCredentials.createSsl(null,[{cert_chain:readFileSync(process.env.FIXTURE_CERT),private_key:readFileSync(process.env.FIXTURE_KEY)}],false),(e,p)=>{if(e)process.exit(1);console.log(p)});`
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", "--input-type=module", "-e", script)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "FIXTURE_CERT="+ca, "FIXTURE_KEY="+keyfile, "FIXTURE_ENDPOINT="+upstream.URL)
	stdout, e := cmd.StdoutPipe()
	if e != nil {
		t.Fatal(e)
	}
	cmd.Stderr = os.Stderr
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() {
		t.Fatal("TS adapter failed to start")
	}
	port := strings.TrimSpace(scanner.Text())
	conn, e := Dial("127.0.0.1:"+port, "fixture", ca)
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	client := pb.NewAdapterClient(conn)
	d, e := client.Describe(ctx, &pb.DescribeRequest{})
	if e != nil {
		t.Fatal(e)
	}
	if e = Validate(d); e != nil {
		t.Fatal(e)
	}
	if len(d.Providers) != 2 {
		t.Fatal("missing session provider")
	}
	if !Supports(d.Providers[0], CaptureFetch, 1, 0) || Supports(d.Providers[0], ConnectionCheck, 1, 0) || !Supports(d.Providers[1], ConnectionCheck, 1, 0) {
		t.Fatal("provider capability declarations did not survive the wire")
	}
	if _, e = hp.NewHealthClient(conn).Check(ctx, &hp.HealthCheckRequest{}); e != nil {
		t.Fatal(e)
	}
	// The fixed fixture ID is read through the wire rather than a live third-party API.
	var data struct {
		Status struct {
			ID string `json:"id"`
		} `json:"status"`
	}
	if e = json.Unmarshal(fixture, &data); e != nil {
		t.Fatal(e)
	}
	id := data.Status.ID
	resolved, e := client.Resolve(ctx, &pb.ResolveRequest{Url: fmt.Sprintf("https://twitter.com/fixture/status/%s?test=1", id)})
	if e != nil || resolved.GetExternalId() != id || resolved.GetPlatform() != "x" || resolved.GetKind() != "post" {
		t.Fatal("target lost over RPC", e)
	}
	prepared, e := client.PrepareCredential(ctx, &pb.PrepareCredentialRequest{ProviderId: "x-session", Input: []byte("{\"auth_token\":\"aaaaaaaaaaaaaaaaaaaa\",\"csrf_token\":\"bbbbbbbbbbbbbbbbbbbb\"}")})
	if e != nil || len(prepared.GetCredential().GetData()) == 0 {
		t.Fatal("opaque credential lost over RPC", e)
	}

	r, e := client.Fetch(ctx, &pb.FetchRequest{Url: fmt.Sprintf("https://x.com/i/web/status/%s", id), ExternalId: id, Platform: "x", Kind: "post", ProviderId: "fxtwitter", AccessScope: "public"})
	if e != nil {
		t.Fatal(e)
	}
	if r.Text == "" || r.Visibility != pb.Visibility_VISIBILITY_PUBLIC || r.Graph == nil || len(r.Graph.Entities) < 2 || len(r.SourceResponses) != 1 || string(r.SourceResponses[0].Body) != string(fixture) {
		t.Fatal("public fixture lost over RPC")
	}
	var trailer metadata.MD
	_, e = client.Fetch(ctx, &pb.FetchRequest{Url: "https://x.com/i/web/status/99", ExternalId: "99", Platform: "x", Kind: "post", ProviderId: "fxtwitter", AccessScope: "public"}, grpc.Trailer(&trailer))
	if status.Code(e) != codes.Unavailable || len(trailer.Get("retry-after")) != 1 || trailer.Get("retry-after")[0] != "7" {
		t.Fatal("retry-after lost over RPC", e, trailer)
	}
	if _, e = client.CheckConnection(ctx, &pb.CheckConnectionRequest{ProviderId: "x-session"}); status.Code(e) != codes.InvalidArgument {
		t.Fatal("credential validation lost over RPC", e)
	}
	bad, e := Dial("127.0.0.1:"+port, "wrong", ca)
	if e != nil {
		t.Fatal(e)
	}
	defer bad.Close()
	if _, e = pb.NewAdapterClient(bad).Describe(ctx, &pb.DescribeRequest{}); status.Code(e) != codes.Unauthenticated {
		t.Fatal(e)
	}
	expired, stop := context.WithCancel(ctx)
	stop()
	if _, e = client.Describe(expired, &pb.DescribeRequest{}); status.Code(e) != codes.Canceled {
		t.Fatal(e)
	}
}
