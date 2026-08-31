package receipt

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"time"
)

// TreeshipCLIEmitter attests a completed invocation as a Treeship
// `action.v1` artifact by invoking the Treeship CLI.
//
// # Why a CLI invocation and not an HTTP call
//
// Treeship attests by LOCAL signing: the artifact is an Ed25519-signed DSSE
// envelope produced on this machine with this operator's key. The Hub only
// stores envelopes that are already signed — POST /v1/artifacts re-derives
// artifact_id, digest and payload_type from the envelope's own bytes and
// rejects any submission whose claimed fields disagree with them. So there is
// no endpoint that turns a receipt into an attestation; something has to sign
// first, and that something is the CLI.
//
// The alternative was to reimplement Treeship's canonical serialization and
// PAE derivation here. That is a third implementation of a format whose Rust
// and Go copies are already pinned to each other by shared test vectors, and
// a signature format that disagrees across implementations fails in the worst
// possible way: it produces plausible artifacts that never verify. One
// canonical implementation, invoked, beats three maintained in parallel.
//
// # What is claimed
//
// The artifact says: this gateway, at this time, completed an invocation with
// this ID, status and shape. It does not claim the upstream did what it was
// asked, and it carries no request or response content — Receipt is metadata
// only (invariant #4) and everything here is derived from it.
//
// # Failure behavior
//
// Every failure returns an error and nothing else. Emission is fail-open by
// contract (Emitter doc, spec 0002 Q9): the caller logs and the proxied call
// is unaffected. A gateway that cannot attest is a gateway with thinner
// evidence, never a gateway that drops traffic.
type TreeshipCLIEmitter struct {
	binaryPath string
	actor      string
	runner     Runner

	// slots bounds concurrent CLI processes. emitReceipt already runs each
	// emission in its own goroutine, so without a bound a traffic spike
	// becomes an unbounded fork of subprocesses — the gateway would harm the
	// host it runs on in order to describe what it was doing. A full channel
	// sheds the receipt rather than queueing, because a receipt that lands
	// long after its invocation is worth less than the backpressure it costs.
	slots chan struct{}
}

// Runner executes the Treeship binary and returns its stdout. It is injected
// so this package performs no process I/O under test, and so the spawn
// mechanism can be replaced without touching the argument construction that
// actually needs reviewing.
type Runner func(ctx context.Context, binaryPath string, args []string) ([]byte, error)

// ErrTreeshipUnavailable is returned when the CLI could not be run, exited
// non-zero, or returned output this emitter refuses to interpret. Callers
// treat every emitter error identically (fail-open), so the distinction is
// for logs and tests, not for control flow.
var ErrTreeshipUnavailable = errors.New("treeship attestation unavailable")

// ErrTreeshipBusy is returned when every concurrency slot is occupied and the
// receipt was shed rather than queued.
var ErrTreeshipBusy = errors.New("treeship attestation skipped: emitter at capacity")

// defaultMaxConcurrent caps in-flight CLI processes. Small on purpose: this is
// a telemetry path, and the gateway's job is to proxy calls, not to spend its
// process table describing them.
const defaultMaxConcurrent = 4

// DefaultActor is the actor URI recorded when none is configured.
const DefaultActor = "agent://zerker-gateway"

// actionLabel is the dot-namespaced action every gateway receipt is attested
// under. Fixed rather than configurable: a verifier filtering for gateway
// receipts needs one label to match, and an operator-settable one would make
// "all attestations by this gateway" unanswerable.
const actionLabel = "gateway.invocation"

// NewTreeshipCLIEmitter returns an emitter that shells out to the Treeship
// binary at binaryPath. An empty actor falls back to DefaultActor.
func NewTreeshipCLIEmitter(binaryPath, actor string, runner Runner) *TreeshipCLIEmitter {
	if actor == "" {
		actor = DefaultActor
	}
	if runner == nil {
		runner = ExecRunner
	}
	return &TreeshipCLIEmitter{
		binaryPath: binaryPath,
		actor:      actor,
		runner:     runner,
		slots:      make(chan struct{}, defaultMaxConcurrent),
	}
}

// TreeshipCLIFromEnv builds an emitter from the environment, or returns nil
// when attestation is not configured.
//
// Opt-in by design. A nil Emitter is the documented "receipts disabled" state
// and the proxy already guards for it, so an operator who has not set up a
// Treeship key gets exactly the behavior they had before rather than a warning
// on every proxied call.
func TreeshipCLIFromEnv(getenv func(string) string, runner Runner) *TreeshipCLIEmitter {
	bin := getenv("ZERKER_TREESHIP_BIN")
	if bin == "" {
		return nil
	}
	return NewTreeshipCLIEmitter(bin, getenv("ZERKER_TREESHIP_ACTOR"), runner)
}

// ExecRunner is the production Runner: it runs the binary and returns stdout.
//
// Stderr is discarded. The CLI writes diagnostics there that can name local
// paths and key IDs, and this output is handled on a fail-open telemetry path
// whose errors are logged — there is no reason to route that into gateway logs.
func ExecRunner(ctx context.Context, binaryPath string, args []string) ([]byte, error) {
	// G204: binaryPath comes from ZERKER_TREESHIP_BIN, which is operator
	// configuration read once at boot -- never from a request, a tenant, or a
	// database row. args are built by Args() from Receipt metadata and are
	// passed as a slice, so there is no shell to inject into: a hostile
	// invocation ID becomes one argv entry, not a command.
	cmd := exec.CommandContext(ctx, binaryPath, args...) //nolint:gosec // G204: operator-configured path, argv slice, no shell
	cmd.Stderr = nil
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrTreeshipUnavailable, err)
	}
	return out, nil
}

// cliResponse is the machine-readable shape of `--format json`.
//
// Parsed rather than the DSSE envelope from `--out -` because the envelope
// carries no artifact ID; deriving one would mean reimplementing the PAE
// hash this package deliberately does not reimplement. `--format json` is a
// machine contract, not the human-readable text output — that text is never
// parsed here.
type cliResponse struct {
	Status string `json:"status"`
	ID     string `json:"id"`
	Actor  string `json:"actor"`
	Action string `json:"action"`
}

// Args returns the exact CLI arguments for r. Exported for tests, which assert
// on the constructed command rather than on a spawned process.
func (e *TreeshipCLIEmitter) Args(r Receipt) []string {
	return []string{
		"attest", "action",
		"--actor", e.actor,
		"--action", actionLabel,
		"--input-digest", invocationDigest(r.InvocationID),
		"--meta", metaJSON(r),
		"--format", "json",
	}
}

// Emit attests r and returns the resulting artifact's ID via the error-free
// path only; the ID is not returned because the Emitter contract is advisory.
// It is logged by the caller through the returned error on failure, and is
// recoverable from the local Treeship store on success.
func (e *TreeshipCLIEmitter) Emit(ctx context.Context, r Receipt) error {
	select {
	case e.slots <- struct{}{}:
		defer func() { <-e.slots }()
	default:
		return ErrTreeshipBusy
	}

	out, err := e.runner(ctx, e.binaryPath, e.Args(r))
	if err != nil {
		return err
	}

	var resp cliResponse
	if err := json.Unmarshal(out, &resp); err != nil {
		return fmt.Errorf("%w: unparseable CLI response", ErrTreeshipUnavailable)
	}
	// Trust the bytes, not the exit code. A zero exit with a non-ok status, or
	// with no artifact ID, means nothing was signed — reporting that as a
	// successful attestation would put a receipt in the log for an artifact
	// that does not exist.
	if resp.Status != "ok" || resp.ID == "" {
		return fmt.Errorf("%w: CLI reported status %q", ErrTreeshipUnavailable, resp.Status)
	}
	if resp.Action != actionLabel {
		return fmt.Errorf("%w: CLI attested action %q, expected %q",
			ErrTreeshipUnavailable, resp.Action, actionLabel)
	}
	return nil
}

// invocationDigest binds the artifact to one invocation.
//
// The invocation ID is hashed rather than passed through so the field is a
// well-formed sha256 regardless of the ID's format, and so the digest keeps
// its meaning if invocation IDs ever stop being opaque.
func invocationDigest(invocationID string) string {
	return "sha256:" + sha256Hex(invocationID)
}

// metaJSON is the artifact's meta object: the invocation's shape, and nothing
// that could carry content.
//
// Built with encoding/json rather than string concatenation because these
// values reach a signed artifact and a shell-adjacent argument; a hand-built
// string is where an injection or a malformed-JSON bug would live.
func metaJSON(r Receipt) string {
	m := map[string]string{
		"invocation_id": r.InvocationID,
		"tenant_id":     r.TenantID,
		"agent_id":      r.AgentID,
		"mode":          r.Mode,
		"status":        r.Status,
	}
	if r.UpstreamStatus != nil {
		m["upstream_status"] = strconv.Itoa(*r.UpstreamStatus)
	}
	if r.LatencyMS != nil {
		m["latency_ms"] = strconv.FormatInt(*r.LatencyMS, 10)
	}
	if r.RequestSize != nil {
		m["request_size"] = strconv.FormatInt(*r.RequestSize, 10)
	}
	if r.ResponseSize != nil {
		m["response_size"] = strconv.FormatInt(*r.ResponseSize, 10)
	}
	if !r.CompletedAt.IsZero() {
		m["completed_at"] = r.CompletedAt.UTC().Format(time.RFC3339)
	}
	b, err := json.Marshal(m)
	if err != nil {
		// map[string]string cannot fail to marshal; the branch exists so a
		// future field change cannot silently emit a malformed --meta.
		return "{}"
	}
	return string(b)
}

// OSGetenv adapts os.Getenv to the getenv parameter of TreeshipCLIFromEnv.
func OSGetenv(k string) string { return os.Getenv(k) }

// sha256Hex returns the lowercase hex SHA-256 of s.
func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// Actor returns the actor URI this emitter signs as.
func (e *TreeshipCLIEmitter) Actor() string { return e.actor }
