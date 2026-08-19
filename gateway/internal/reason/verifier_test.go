package reason

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func writeVerifier(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "reason-test")
	script := "#!/bin/sh\n" + body + "\n"
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil { //nolint:gosec // G306: test fixture must be executable
		t.Fatalf("write verifier: %v", err)
	}
	return path
}

func newTestVerifier(t *testing.T, script string, cfg SubprocessConfig) *SubprocessVerifier {
	t.Helper()
	cfg.Binary = writeVerifier(t, script)
	if cfg.Timeout == 0 {
		// Race-enabled package fan-out can make shell fixture startup slower than
		// the production verifier budget; timeout behavior has its own 10ms case.
		cfg.Timeout = 30 * time.Second
	}
	v, err := NewSubprocessVerifier(cfg)
	if err != nil {
		t.Fatalf("NewSubprocessVerifier: %v", err)
	}
	return v
}

func TestSubprocessVerifierAcceptsOnlyVerifiedAuthorized(t *testing.T) {
	v := newTestVerifier(t, `cat >/dev/null
printf '%s\n' '{"schema":"zerker.reason.authorization-verification.v1","status":"verified","authorization_status":"authorized","request_digest":"`+testDigest+`","reasoning_result_digest":"`+testDigest+`"}'`, SubprocessConfig{})

	got, err := v.Verify(context.Background(), []byte(`{"bundle":true}`))
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.RequestDigest != testDigest || got.ReasoningResultDigest != testDigest {
		t.Fatalf("verification = %#v", got)
	}
}

func TestSubprocessVerifierFailsClosed(t *testing.T) {
	tests := []struct {
		name   string
		script string
		cfg    SubprocessConfig
	}{
		{
			name: "verified insufficient evidence exit",
			script: `printf '%s\n' '{"schema":"zerker.reason.authorization-verification.v1","status":"verified","authorization_status":"insufficient_evidence","request_digest":"` + testDigest + `","reasoning_result_digest":"` + testDigest + `"}'
exit 2`,
		},
		{
			name: "verified denial exit",
			script: `printf '%s\n' '{"schema":"zerker.reason.authorization-verification.v1","status":"verified","authorization_status":"denied","request_digest":"` + testDigest + `","reasoning_result_digest":"` + testDigest + `"}'
exit 3`,
		},
		{
			name: "verified conflict exit",
			script: `printf '%s\n' '{"schema":"zerker.reason.authorization-verification.v1","status":"verified","authorization_status":"conflicted","request_digest":"` + testDigest + `","reasoning_result_digest":"` + testDigest + `"}'
exit 4`,
		},
		{name: "exit zero forged status", script: `printf '%s\n' '{"schema":"zerker.reason.authorization-verification.v1","status":"verified","authorization_status":"denied","request_digest":"` + testDigest + `","reasoning_result_digest":"` + testDigest + `"}'`},
		{name: "malformed output", script: `printf 'not-json'`},
		{name: "extra output field", script: `printf '%s\n' '{"schema":"zerker.reason.authorization-verification.v1","status":"verified","authorization_status":"authorized","request_digest":"` + testDigest + `","reasoning_result_digest":"` + testDigest + `","ignored":true}'`},
		{name: "trailing JSON", script: `printf '%s\n%s\n' '{"schema":"zerker.reason.authorization-verification.v1","status":"verified","authorization_status":"authorized","request_digest":"` + testDigest + `","reasoning_result_digest":"` + testDigest + `"}' '{}'`},
		{name: "invalid digest", script: `printf '%s\n' '{"schema":"zerker.reason.authorization-verification.v1","status":"verified","authorization_status":"authorized","request_digest":"nope","reasoning_result_digest":"` + testDigest + `"}'`},
		{name: "timeout", script: `sleep 2`, cfg: SubprocessConfig{Timeout: 10 * time.Millisecond}},
		{name: "oversize output", script: `printf '%100s' x`, cfg: SubprocessConfig{MaxOutputBytes: 10}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			v := newTestVerifier(t, tt.script, tt.cfg)
			_, err := v.Verify(context.Background(), []byte(`{}`))
			if !errors.Is(err, ErrNotAuthorized) {
				t.Fatalf("error = %v, want ErrNotAuthorized", err)
			}
		})
	}
}

func TestSubprocessVerifierBoundsInputBeforeProcessStart(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "started")
	v := newTestVerifier(t, `touch "`+marker+`"`, SubprocessConfig{MaxInputBytes: 4})

	_, err := v.Verify(context.Background(), []byte("12345"))
	if !errors.Is(err, ErrInputTooLarge) {
		t.Fatalf("error = %v, want ErrInputTooLarge", err)
	}
	if _, statErr := os.Stat(marker); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("verifier process started for oversized input: %v", statErr)
	}
}

func TestSubprocessVerifierPassesBundleOnStdinWithoutGatewayEnvironment(t *testing.T) {
	t.Setenv("ZERKER_KMS_KEY", "must-not-reach-reason")
	const bundle = `{"exact":"bytes"}`
	v := newTestVerifier(t, `IFS= read -r input
if [ "$input" != '`+bundle+`' ] || [ -n "$ZERKER_KMS_KEY" ]; then exit 9; fi
printf '%s\n' '{"schema":"zerker.reason.authorization-verification.v1","status":"verified","authorization_status":"authorized","request_digest":"`+testDigest+`","reasoning_result_digest":"`+testDigest+`"}'`, SubprocessConfig{})

	if _, err := v.Verify(context.Background(), []byte(bundle)); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

func TestNewSubprocessVerifierRejectsMissingBinary(t *testing.T) {
	_, err := NewSubprocessVerifier(SubprocessConfig{Binary: filepath.Join(t.TempDir(), "missing")})
	if err == nil || !strings.Contains(err.Error(), "find reason binary") {
		t.Fatalf("error = %v", err)
	}
}
