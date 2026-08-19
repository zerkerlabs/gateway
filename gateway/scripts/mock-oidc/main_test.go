package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteTokenAtomicallyReplacesWithPrivatePermissions(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "token")
	if err := writeTokenAtomically(path, "first"); err != nil {
		t.Fatalf("first write: %v", err)
	}
	if err := writeTokenAtomically(path, "second"); err != nil {
		t.Fatalf("replacement write: %v", err)
	}
	contents, err := os.ReadFile(path) //nolint:gosec // Test reads its own temporary token fixture.
	if err != nil {
		t.Fatalf("read token: %v", err)
	}
	if string(contents) != "second" {
		t.Fatalf("token = %q, want replacement", contents)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat token: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("permissions = %o, want 600", info.Mode().Perm())
	}
}
