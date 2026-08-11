package memory

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// goldenVectorPath is the vendored copy of the backend's cross-language
// commitment vector, published at tests/fixtures/room_context_commitment_v1.json
// in github.com/zerkerlabs/zmem (source commit f6e1912). It is vendored rather
// than resolved at test time because the backend ships only the zerker_memory
// package to PyPI — its tests/ tree is not in the distribution, so an
// installed backend does not put this file on disk. Re-vendor it if the
// backend republishes the vector; the schema field pins which revision of the
// contract this copy speaks.
const goldenVectorPath = "testdata/room_context_commitment_v1.json"

const goldenVectorSchema = "zerker.room_memory_context_commitment_golden.v1"

// goldenVector is the vendored fixture. material is the commitment minus its
// self-attesting digest; canonical_json is the exact byte sequence the backend
// canonicalizes that material into, and room_context_digest is the sha256 over
// those bytes.
type goldenVector struct {
	Schema            string          `json:"schema"`
	Material          json.RawMessage `json:"material"`
	CanonicalJSON     string          `json:"canonical_json"`
	RoomContextDigest string          `json:"room_context_digest"`
}

func loadGoldenVector(t *testing.T) goldenVector {
	t.Helper()

	raw, err := os.ReadFile(filepath.Clean(goldenVectorPath))
	if err != nil {
		t.Fatalf("read golden vector: %v", err)
	}
	var v goldenVector
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("decode golden vector: %v", err)
	}
	if v.Schema != goldenVectorSchema {
		t.Fatalf("golden vector schema = %q, want %q — the vendored copy is a "+
			"different revision of the contract than this test was written against",
			v.Schema, goldenVectorSchema)
	}
	return v
}

// TestCanonicalJSON_MatchesCrossLanguageGoldenVector is the parity check the
// commitment scheme actually rests on: it asserts this package's canonicalizer
// reproduces the backend's canonical bytes exactly, using a vector the backend
// itself publishes rather than one derived on this side of the seam. Every
// other commitment test in this package — including the hand-derived vectors
// in zmem_test.go — can only prove the canonicalizer is self-consistent and
// stable against regressions; agreement with the Python implementation is a
// different claim, and this is the test that makes it.
//
// It compares bytes, not just the digest, so a divergence reports where the
// encodings differ instead of an opaque hash mismatch.
//
// Note what this vector does NOT cover: its material is entirely ASCII, so it
// exercises neither the ensure_ascii escaping path nor the '<'/'>'/'&'
// non-escaping the Go encoder gets wrong by default. Those remain pinned only
// by the adversarial hand-derived vector in zmem_test.go, which is therefore
// still load-bearing and must not be dropped in favour of this one.
func TestCanonicalJSON_MatchesCrossLanguageGoldenVector(t *testing.T) {
	t.Parallel()

	v := loadGoldenVector(t)

	// UseNumber for the same reason verifyCommitment does it: decoding
	// context_budget_tokens through float64 would re-render it as 2000e+03 or
	// similar and silently break the digest.
	dec := json.NewDecoder(bytes.NewReader(v.Material))
	dec.UseNumber()
	var material any
	if err := dec.Decode(&material); err != nil {
		t.Fatalf("decode material: %v", err)
	}

	got, err := canonicalJSON(material)
	if err != nil {
		t.Fatalf("canonicalJSON: %v", err)
	}
	if string(got) != v.CanonicalJSON {
		t.Errorf("canonical bytes disagree with the backend's published vector\n got: %s\nwant: %s",
			got, v.CanonicalJSON)
	}

	sum := sha256.Sum256(got)
	if digest := "sha256:" + hex.EncodeToString(sum[:]); digest != v.RoomContextDigest {
		t.Errorf("digest = %s, want %s", digest, v.RoomContextDigest)
	}
}
