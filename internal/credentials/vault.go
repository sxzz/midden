package credentials

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"

	pb "monitor/api/adapter/v1"
)

type Vault struct{ aead cipher.AEAD }

func New(encoded string) (*Vault, error) {
	if encoded == "" {
		return nil, nil
	}
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil || len(key) != 32 {
		return nil, fmt.Errorf("credential key must be base64-encoded 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Vault{aead}, nil
}

func FromEnv() (*Vault, error) {
	key := os.Getenv("CREDENTIAL_KEY")
	if file := os.Getenv("CREDENTIAL_KEY_FILE"); file != "" {
		b, e := os.ReadFile(file)
		if e != nil {
			return nil, fmt.Errorf("cannot read credential key")
		}
		key = string(b)
	}
	return New(key)
}

func Validate(c *pb.SessionCredential) error {
	re := regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	if c == nil || len(c.AuthToken) < 10 || len(c.AuthToken) > 4096 || len(c.CsrfToken) < 10 || len(c.CsrfToken) > 4096 || !re.MatchString(c.AuthToken) || !re.MatchString(c.CsrfToken) {
		return fmt.Errorf("invalid account session")
	}
	return nil
}

func (v *Vault) Seal(tenant, id string, c *pb.SessionCredential) ([]byte, error) {
	if v == nil {
		return nil, fmt.Errorf("credential encryption is not configured")
	}
	if e := Validate(c); e != nil {
		return nil, e
	}
	b, e := json.Marshal(c)
	if e != nil {
		return nil, e
	}
	nonce := make([]byte, v.aead.NonceSize())
	if _, e = rand.Read(nonce); e != nil {
		return nil, e
	}
	return v.aead.Seal(nonce, nonce, b, []byte(tenant+":"+id)), nil
}

func (v *Vault) Open(tenant, id string, b []byte) (*pb.SessionCredential, error) {
	if v == nil {
		return nil, fmt.Errorf("credential encryption is not configured")
	}
	n := v.aead.NonceSize()
	if len(b) < n {
		return nil, fmt.Errorf("invalid encrypted credential")
	}
	raw, e := v.aead.Open(nil, b[:n], b[n:], []byte(tenant+":"+id))
	if e != nil {
		return nil, fmt.Errorf("cannot decrypt account credential")
	}
	var c pb.SessionCredential
	if json.Unmarshal(raw, &c) != nil {
		return nil, fmt.Errorf("invalid encrypted credential")
	}
	return &c, Validate(&c)
}
