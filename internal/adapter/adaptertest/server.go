// Package adaptertest runs the built services against fixed upstream responses.
package adaptertest

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func Start(t testing.TB, upstream, media string, extra ...string) ([]string, string) {
	t.Helper()
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	root, err := filepath.Abs("../..")
	check(err)
	for _, id := range []string{"x", "instagram"} {
		if _, err = os.Stat(filepath.Join(root, "adapters", id, "dist/server.js")); err != nil {
			t.Skip("pnpm build required")
		}
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	check(err)
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"}, DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	cert, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	check(err)
	der, err := x509.MarshalPKCS8PrivateKey(key)
	check(err)
	dir := t.TempDir()
	ca, keyfile := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	check(os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert}), 0o600))
	check(os.WriteFile(keyfile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600))
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	cmd := exec.CommandContext(ctx, "node", filepath.Join(root, "adapters/x/test-fixture.mjs"))
	cmd.Env = append(os.Environ(), "FIXTURE_CERT="+ca, "FIXTURE_KEY="+keyfile, "FIXTURE_ENDPOINT="+upstream, "FIXTURE_MEDIA_ENDPOINT="+media)
	cmd.Env = append(cmd.Env, extra...)
	stdout, err := cmd.StdoutPipe()
	check(err)
	cmd.Stderr = os.Stderr
	check(cmd.Start())
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	scanner := bufio.NewScanner(stdout)
	var addresses []string
	for range 2 {
		if !scanner.Scan() {
			t.Fatal("TypeScript fixture server failed to start", scanner.Err())
		}
		addresses = append(addresses, "127.0.0.1:"+scanner.Text())
	}
	return addresses, ca
}
