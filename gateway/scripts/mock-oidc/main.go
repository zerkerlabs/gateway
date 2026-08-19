// Command mock-oidc is a dev-only OpenID Connect issuer for running Zerker
// locally with auth enforced. It is NOT for production: it mints a token for a
// fixed identity and serves discovery + JWKS over plain HTTP.
//
// It mirrors the RS256 / JWKS / discovery shape exercised by
// internal/auth/auth_test.go, but as a long-lived server rather than a test
// helper, so the gateway's auth middleware can initialise against it and verify
// the bearer token it mints.
//
// Configurable via flags; scripts/dev-auth.sh wires it to the gateway.
package main

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:9099", "listen address")
	issuer := flag.String("issuer", "http://127.0.0.1:9099", "issuer URL (must match ZERKER_OIDC_ISSUER)")
	audience := flag.String("audience", "zerker-gateway", "aud claim (must match ZERKER_OIDC_AUDIENCE)")
	tenant := flag.String("tenant", "acme", "tenant claim value")
	subject := flag.String("subject", "user-alice", "sub claim value")
	tokenFile := flag.String("token-file", "", "if set, atomically write the current token to this path")
	tokenTTL := flag.Duration("token-ttl", time.Hour, "lifetime of each development token")
	refreshEvery := flag.Duration("refresh-every", 30*time.Minute, "refresh interval for the token file")
	flag.Parse()
	if *tokenTTL <= 0 || *refreshEvery <= 0 || *refreshEvery >= *tokenTTL {
		log.Fatal("token-ttl and refresh-every must be positive, with refresh-every shorter than token-ttl")
	}

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		log.Fatalf("generate key: %v", err)
	}
	const keyID = "mock-key-1"

	mint := func() (string, error) {
		now := time.Now()
		return signJWT(key, keyID, map[string]any{
			"iss":    *issuer,
			"aud":    *audience,
			"sub":    *subject,
			"tenant": *tenant,
			"iat":    now.Unix(),
			"exp":    now.Add(*tokenTTL).Unix(),
		})
	}
	if *tokenFile != "" {
		refresh := func() error {
			token, err := mint()
			if err != nil {
				return fmt.Errorf("sign token: %w", err)
			}
			return writeTokenAtomically(*tokenFile, token)
		}
		if err := refresh(); err != nil {
			log.Fatal(err)
		}
		go func() {
			ticker := time.NewTicker(*refreshEvery)
			defer ticker.Stop()
			for range ticker.C {
				if err := refresh(); err != nil {
					log.Printf("refresh token file: %v", err)
				}
			}
		}()
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]string{"issuer": *issuer, "jwks_uri": *issuer + "/jwks.json"})
	})
	mux.HandleFunc("/jwks.json", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]any{"keys": []any{jwk(keyID, &key.PublicKey)}})
	})

	fmt.Printf("mock-oidc: issuer %s (aud=%s tenant=%s sub=%s)\n", *issuer, *audience, *tenant, *subject)
	if *tokenFile != "" {
		fmt.Printf("mock-oidc: rotating token file %s every %s\n", *tokenFile, *refreshEvery)
	}
	log.Fatal(http.ListenAndServe(*addr, mux))
}

func writeTokenAtomically(path, token string) error {
	dir := filepath.Dir(path)
	file, err := os.CreateTemp(dir, ".zerker-token-*")
	if err != nil {
		return fmt.Errorf("create token file: %w", err)
	}
	temporary := file.Name()
	defer func() { _ = os.Remove(temporary) }()
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return fmt.Errorf("chmod token file: %w", err)
	}
	if _, err := file.WriteString(token); err != nil {
		_ = file.Close()
		return fmt.Errorf("write token file: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close token file: %w", err)
	}
	if err := os.Rename(temporary, path); err != nil {
		return fmt.Errorf("replace token file: %w", err)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		http.Error(w, "encode error", http.StatusInternalServerError)
	}
}

func signJWT(key *rsa.PrivateKey, kid string, claims map[string]any) (string, error) {
	header, err := json.Marshal(map[string]string{"alg": "RS256", "kid": kid, "typ": "JWT"})
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	input := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	digest := sha256.Sum256([]byte(input))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return input + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

func jwk(kid string, pub *rsa.PublicKey) map[string]any {
	return map[string]any{
		"kty": "RSA",
		"kid": kid,
		"use": "sig",
		"alg": "RS256",
		"n":   base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
		"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
	}
}
