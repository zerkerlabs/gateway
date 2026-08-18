// Package reason invokes the Zerker Reason CLI as an external, independently
// versioned authorization verifier.
package reason

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"time"
)

const (
	verificationSchema = "zerker.reason.authorization-verification.v1"
	defaultTimeout     = 2 * time.Second
	defaultMaxInput    = 1 << 20 // 1 MiB
	defaultMaxOutput   = 64 << 10
)

var digestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

var (
	// ErrNotAuthorized means Reason independently verified the artifact but did
	// not authorize it, or rejected/timed out while verifying it. Enforcement
	// points must treat every such result as a denial.
	ErrNotAuthorized = errors.New("reason authorization failed")
	// ErrInputTooLarge means the bundle exceeds the gateway's bound. Reason has
	// its own larger bound, but the gateway rejects before starting a process.
	ErrInputTooLarge = errors.New("reason authorization bundle too large")
)

// Verification is the small, versioned success result Gateway consumes. The
// complete certificate remains owned and interpreted by Reason.
type Verification struct {
	RequestDigest         string
	ReasoningResultDigest string
}

// Verifier independently verifies one atomic authorization bundle.
type Verifier interface {
	Verify(ctx context.Context, bundle []byte) (Verification, error)
}

// SubprocessConfig bounds one Reason CLI invocation.
type SubprocessConfig struct {
	Binary         string
	Timeout        time.Duration
	MaxInputBytes  int
	MaxOutputBytes int
}

// SubprocessVerifier invokes `reason verify-authorization-bundle` without a
// shell and accepts only the v1 verified+authorized JSON contract.
type SubprocessVerifier struct {
	binary         string
	timeout        time.Duration
	maxInputBytes  int
	maxOutputBytes int
}

// NewSubprocessVerifier validates cfg and resolves the configured executable at
// startup, so an enabled deployment cannot silently run without Reason.
func NewSubprocessVerifier(cfg SubprocessConfig) (*SubprocessVerifier, error) {
	if cfg.Binary == "" {
		return nil, errors.New("reason binary is required")
	}
	binary, err := exec.LookPath(cfg.Binary)
	if err != nil {
		return nil, fmt.Errorf("find reason binary: %w", err)
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = defaultTimeout
	}
	if cfg.MaxInputBytes <= 0 {
		cfg.MaxInputBytes = defaultMaxInput
	}
	if cfg.MaxOutputBytes <= 0 {
		cfg.MaxOutputBytes = defaultMaxOutput
	}
	return &SubprocessVerifier{
		binary:         binary,
		timeout:        cfg.Timeout,
		maxInputBytes:  cfg.MaxInputBytes,
		maxOutputBytes: cfg.MaxOutputBytes,
	}, nil
}

// Verify sends the exact captured bundle bytes over stdin. Exit zero is
// necessary but not sufficient: stdout must also be exactly the expected v1
// verified+authorized result with valid digest commitments.
func (v *SubprocessVerifier) Verify(ctx context.Context, bundle []byte) (Verification, error) {
	if len(bundle) > v.maxInputBytes {
		return Verification{}, ErrInputTooLarge
	}

	verifyCtx, cancel := context.WithTimeout(ctx, v.timeout)
	defer cancel()

	cmd := exec.CommandContext(verifyCtx, v.binary, //nolint:gosec // G204: binary is operator-configured and resolved once at startup; arguments are fixed and no shell is involved
		"--format", "json", "verify-authorization-bundle", "-", "--require-authorized")
	// Do not let inherited stdout/stderr descriptors in an unexpected child
	// process hold Run open after CommandContext kills the verifier.
	cmd.WaitDelay = 100 * time.Millisecond
	// Reason needs only stdin and argv. Do not copy Gateway's database, OIDC, or
	// KMS environment into the verifier process.
	cmd.Env = []string{}
	cmd.Stdin = bytes.NewReader(bundle)
	stdout := newBoundedBuffer(v.maxOutputBytes)
	stderr := newBoundedBuffer(v.maxOutputBytes)
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	runErr := cmd.Run()
	if verifyCtx.Err() != nil {
		return Verification{}, fmt.Errorf("%w: verifier timeout", ErrNotAuthorized)
	}
	if stdout.overflow || stderr.overflow {
		return Verification{}, fmt.Errorf("%w: verifier output exceeded limit", ErrNotAuthorized)
	}
	if runErr != nil {
		return Verification{}, fmt.Errorf("%w: verifier exited unsuccessfully", ErrNotAuthorized)
	}

	var result struct {
		Schema                string `json:"schema"`
		Status                string `json:"status"`
		AuthorizationStatus   string `json:"authorization_status"`
		RequestDigest         string `json:"request_digest"`
		ReasoningResultDigest string `json:"reasoning_result_digest"`
	}
	dec := json.NewDecoder(bytes.NewReader(stdout.Bytes()))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&result); err != nil {
		return Verification{}, fmt.Errorf("%w: malformed verifier output", ErrNotAuthorized)
	}
	if err := requireJSONEOF(dec); err != nil {
		return Verification{}, fmt.Errorf("%w: malformed verifier output", ErrNotAuthorized)
	}
	if result.Schema != verificationSchema || result.Status != "verified" ||
		result.AuthorizationStatus != "authorized" ||
		!digestPattern.MatchString(result.RequestDigest) ||
		!digestPattern.MatchString(result.ReasoningResultDigest) {
		return Verification{}, fmt.Errorf("%w: unexpected verifier result", ErrNotAuthorized)
	}
	return Verification{
		RequestDigest:         result.RequestDigest,
		ReasoningResultDigest: result.ReasoningResultDigest,
	}, nil
}

func requireJSONEOF(dec *json.Decoder) error {
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

type boundedBuffer struct {
	buf      bytes.Buffer
	limit    int
	overflow bool
}

func newBoundedBuffer(limit int) *boundedBuffer {
	return &boundedBuffer{limit: limit}
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	remaining := b.limit - b.buf.Len()
	if remaining >= len(p) {
		return b.buf.Write(p)
	}
	if remaining > 0 {
		_, _ = b.buf.Write(p[:remaining])
	}
	b.overflow = true
	// Report the full write so os/exec does not retain or retry attacker-sized
	// output. The overflow flag makes verification fail closed after Wait.
	return len(p), nil
}

func (b *boundedBuffer) Bytes() []byte { return b.buf.Bytes() }
