package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"
)

func initTLS(dir string) error {
	certPath := filepath.Join(dir, "adapter.crt")
	keyPath := filepath.Join(dir, "adapter.key")
	if _, e := os.Stat(certPath); e == nil {
		if _, e = os.Stat(keyPath); e != nil {
			return fmt.Errorf("adapter TLS key missing")
		}
		return nil
	}
	if e := os.MkdirAll(dir, 0o755); e != nil {
		return e
	}
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		return e
	}
	serial, e := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if e != nil {
		return e
	}
	template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "monitor-adapter"}, DNSNames: []string{"adapter", "localhost"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(2, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true, IsCA: true}
	cert, e := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if e != nil {
		return e
	}
	encoded, e := x509.MarshalPKCS8PrivateKey(key)
	if e != nil {
		return e
	}
	if e = os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded}), 0o600); e != nil {
		return e
	}
	if os.Getuid() == 0 {
		if e = os.Chown(keyPath, 10001, 10001); e != nil {
			return e
		}
	}
	return os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert}), 0o644)
}
