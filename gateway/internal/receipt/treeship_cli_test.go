package receipt

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

func intPtr(i int) *int     { return &i }
func i64Ptr(i int64) *int64 { return &i }
func okJSON() []byte {
	return []byte(`{"status":"ok","id":"art_abc123","actor":"agent://zerker-gateway","action":"gateway.invocation"}`)
}

func sampleReceipt() Receipt {
	return Receipt{
		InvocationID:   "inv_01HQ",
		TenantID:       "tnt_1",
		AgentID:        "agt_1",
		Mode:           "transactional",
		Status:         "succeeded",
		UpstreamStatus: intPtr(200),
		LatencyMS:      i64Ptr(42),
		CompletedAt:    time.Date(2026, 8, 31, 1, 2, 3, 0, time.UTC),
	}
}

// argValue returns the value following flag in args, or "" if absent.
func argValue(args []string, flag string) string {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func TestFromEnvIsOptIn(t *testing.T) {
	// Unset binary must yield a nil emitter, which is the documented
	// "receipts disabled" state the proxy already guards for. An emitter that
	// existed but always failed would log a warning on every proxied call.
	if e := TreeshipCLIFromEnv(func(string) string { return "" }, nil); e != nil {
		t.Fatalf("expected nil emitter when ZERKER_TREESHIP_BIN is unset, got %#v", e)
	}
	env := map[string]string{"ZERKER_TREESHIP_BIN": "/usr/local/bin/treeship"}
	e := TreeshipCLIFromEnv(func(k string) string { return env[k] }, nil)
	if e == nil {
		t.Fatal("expected an emitter when ZERKER_TREESHIP_BIN is set")
		return
	}
	if e.Actor() != DefaultActor {
		t.Fatalf("actor = %q, want default %q", e.Actor(), DefaultActor)
	}
}

func TestArgsBindTheInvocationAndCarryNoContent(t *testing.T) {
	e := NewTreeshipCLIEmitter("/bin/treeship", "", func(context.Context, string, []string) ([]byte, error) {
		return okJSON(), nil
	})
	args := e.Args(sampleReceipt())

	// The digest is what ties the artifact to one invocation. A receipt that
	// attests nothing in particular is worse than no receipt, because it reads
	// as evidence.
	dig := argValue(args, "--input-digest")
	if !strings.HasPrefix(dig, "sha256:") || len(dig) != len("sha256:")+64 {
		t.Fatalf("--input-digest = %q, want sha256: + 64 hex chars", dig)
	}
	if dig == invocationDigest("") {
		t.Fatal("--input-digest is the digest of the empty string; the invocation ID was not bound")
	}
	if got := argValue(args, "--action"); got != actionLabel {
		t.Fatalf("--action = %q, want %q", got, actionLabel)
	}

	// --meta must be well-formed JSON, because it reaches a signed artifact.
	var meta map[string]string
	if err := json.Unmarshal([]byte(argValue(args, "--meta")), &meta); err != nil {
		t.Fatalf("--meta is not valid JSON: %v", err)
	}
	if meta["invocation_id"] != "inv_01HQ" || meta["status"] != "succeeded" {
		t.Fatalf("meta lost invocation fields: %#v", meta)
	}
}

func TestMetaOmitsNilOptionalFields(t *testing.T) {
	// A nil UpstreamStatus means the upstream was never reached. Emitting a
	// zero would sign a false claim: "the upstream returned 0" rather than
	// "the upstream was not reached".
	var meta map[string]string
	if err := json.Unmarshal([]byte(metaJSON(Receipt{InvocationID: "inv_2", Status: "failed"})), &meta); err != nil {
		t.Fatalf("meta is not valid JSON: %v", err)
	}
	for _, k := range []string{"upstream_status", "latency_ms", "request_size", "response_size", "completed_at"} {
		if _, present := meta[k]; present {
			t.Fatalf("meta contains %q for a receipt that has no such value: %#v", k, meta)
		}
	}
}

func TestEmitRejectsNonOKStatusDespiteZeroExit(t *testing.T) {
	// The CLI can exit 0 and still not have signed anything. Trusting the exit
	// code alone would record a successful attestation for an artifact that
	// does not exist — the failure mode where the log is confidently wrong.
	for _, body := range []string{
		`{"status":"error","id":""}`,
		`{"status":"ok","id":""}`,
		`not json at all`,
	} {
		e := NewTreeshipCLIEmitter("/bin/treeship", "", func(context.Context, string, []string) ([]byte, error) {
			return []byte(body), nil
		})
		if err := e.Emit(context.Background(), sampleReceipt()); !errors.Is(err, ErrTreeshipUnavailable) {
			t.Fatalf("body %q: err = %v, want ErrTreeshipUnavailable", body, err)
		}
	}
}

func TestEmitRejectsAnUnexpectedActionLabel(t *testing.T) {
	// A response describing a different action means we are reading the result
	// of something other than the call we made.
	e := NewTreeshipCLIEmitter("/bin/treeship", "", func(context.Context, string, []string) ([]byte, error) {
		return []byte(`{"status":"ok","id":"art_x","action":"something.else"}`), nil
	})
	if err := e.Emit(context.Background(), sampleReceipt()); !errors.Is(err, ErrTreeshipUnavailable) {
		t.Fatalf("err = %v, want ErrTreeshipUnavailable", err)
	}
}

func TestEmitSucceedsOnWellFormedResponse(t *testing.T) {
	e := NewTreeshipCLIEmitter("/bin/treeship", "", func(context.Context, string, []string) ([]byte, error) {
		return okJSON(), nil
	})
	if err := e.Emit(context.Background(), sampleReceipt()); err != nil {
		t.Fatalf("Emit() = %v, want nil", err)
	}
}

func TestEmitShedsRatherThanForkBombing(t *testing.T) {
	// emitReceipt spawns a goroutine per invocation. Without a bound, a traffic
	// spike becomes an unbounded fork of subprocesses: the gateway would damage
	// its host in order to describe what it was doing. Shedding is correct —
	// a receipt is worth less than the capacity to keep proxying.
	release := make(chan struct{})
	var running sync.WaitGroup
	e := NewTreeshipCLIEmitter("/bin/treeship", "", func(context.Context, string, []string) ([]byte, error) {
		<-release
		return okJSON(), nil
	})

	for i := 0; i < defaultMaxConcurrent; i++ {
		running.Add(1)
		go func() {
			defer running.Done()
			_ = e.Emit(context.Background(), sampleReceipt())
		}()
	}
	// Wait until every slot is genuinely occupied, rather than sleeping.
	for len(e.slots) < defaultMaxConcurrent {
		time.Sleep(time.Millisecond)
	}

	if err := e.Emit(context.Background(), sampleReceipt()); !errors.Is(err, ErrTreeshipBusy) {
		t.Fatalf("err = %v, want ErrTreeshipBusy once every slot is taken", err)
	}

	close(release)
	running.Wait()

	// Slots must be returned, or the emitter is permanently wedged after one burst.
	if err := e.Emit(context.Background(), sampleReceipt()); err != nil {
		t.Fatalf("Emit() after the burst drained = %v, want nil (slots were not released)", err)
	}
}

func TestEmitPropagatesRunnerFailureAsFailOpen(t *testing.T) {
	e := NewTreeshipCLIEmitter("/nonexistent/treeship", "", func(context.Context, string, []string) ([]byte, error) {
		return nil, errors.New("exec: no such file")
	})
	if err := e.Emit(context.Background(), sampleReceipt()); err == nil {
		t.Fatal("Emit() = nil, want an error so the caller can log it")
	}
}

func TestFromEnvReturnsANilConcretePointerWhenDisabled(t *testing.T) {
	// The proxy disables receipts by checking `emitter == nil` on the
	// receipt.Emitter interface, and a nil *TreeshipCLIEmitter placed into that
	// interface is not a nil interface -- the guard would stop firing and every
	// completed invocation would call Emit on a nil receiver.
	//
	// The defense lives at the call site (cmd/zerker-gateway branches on the
	// concrete pointer before calling WithReceipts). What this test pins is the
	// precondition that makes that branch work: disabled must yield a nil
	// CONCRETE pointer, not a non-nil emitter that always errors.
	e := TreeshipCLIFromEnv(func(string) string { return "" }, nil)
	if e != nil {
		t.Fatalf("disabled emitter = %#v, want a nil *TreeshipCLIEmitter", e)
	}
}

func sampleDenial() Denial {
	method, tool := "tools/call", "write_file"
	return Denial{
		TenantID:    "tnt_1",
		AgentID:     "agt_1",
		Protocol:    "mcp",
		MCPMethod:   &method,
		MCPTool:     &tool,
		MatchedRule: "3",
		Reason:      "denied by rule 3",
		DeniedAt:    time.Date(2026, 8, 31, 2, 0, 0, 0, time.UTC),
	}
}

func TestDenialArgsUseADistinctActionLabel(t *testing.T) {
	// A verifier must be able to ask "what did this gateway refuse" without
	// fetching every invocation it allowed and filtering.
	e := NewTreeshipCLIEmitter("/bin/treeship", "", func(context.Context, string, []string) ([]byte, error) {
		return nil, nil
	})
	got := argValue(e.DenialArgs(sampleDenial()), "--action")
	if got != denialActionLabel {
		t.Fatalf("--action = %q, want %q", got, denialActionLabel)
	}
	if got == actionLabel {
		t.Fatal("denials and completed invocations share an action label")
	}
}

func TestDenialMetaCarriesTheCallButNotTheRuleset(t *testing.T) {
	e := NewTreeshipCLIEmitter("/bin/treeship", "", nil)
	var meta map[string]string
	if err := json.Unmarshal([]byte(argValue(e.DenialArgs(sampleDenial()), "--meta")), &meta); err != nil {
		t.Fatalf("--meta is not valid JSON: %v", err)
	}
	if meta["action"] != "deny" {
		t.Fatalf("meta[action] = %q, want \"deny\"", meta["action"])
	}
	for k, want := range map[string]string{
		"mcp_tool": "write_file", "mcp_method": "tools/call", "matched_rule": "3",
	} {
		if meta[k] != want {
			t.Fatalf("meta[%q] = %q, want %q", k, meta[k], want)
		}
	}
}

func TestDenialByDefaultOmitsMatchedRule(t *testing.T) {
	// "the policy default refused this" and "rule 3 refused this" are different
	// facts. Signing matched_rule:"" would collapse them into an ambiguous one.
	d := sampleDenial()
	d.MatchedRule = ""
	e := NewTreeshipCLIEmitter("/bin/treeship", "", nil)
	var meta map[string]string
	if err := json.Unmarshal([]byte(argValue(e.DenialArgs(d), "--meta")), &meta); err != nil {
		t.Fatalf("--meta is not valid JSON: %v", err)
	}
	if _, present := meta["matched_rule"]; present {
		t.Fatalf("matched_rule present for a default denial: %#v", meta)
	}
}

func TestDenialDigestDistinguishesDifferentCalls(t *testing.T) {
	a := sampleDenial()
	b := sampleDenial()
	other := "read_file"
	b.MCPTool = &other
	if denialDigest(a) == denialDigest(b) {
		t.Fatal("denials of different tools share a digest")
	}
	if denialDigest(a) != denialDigest(sampleDenial()) {
		t.Fatal("denial digest is not deterministic for identical input")
	}
}

func TestDenialDigestIsNotFieldConcatenationCollidable(t *testing.T) {
	// Joining fields without a separator lets ("ab","c") and ("a","bc") collide,
	// so two different denied calls would share one digest and one artifact.
	a := Denial{TenantID: "ab", AgentID: "c"}
	b := Denial{TenantID: "a", AgentID: "bc"}
	if denialDigest(a) == denialDigest(b) {
		t.Fatal("digest collides across field boundaries; the separator is missing or weak")
	}
}

func TestEmitDenialSharesTheConcurrencyBound(t *testing.T) {
	// A burst of denials is exactly the load the bound exists for. A separate
	// pool would double the ceiling that number was chosen to hold.
	release := make(chan struct{})
	var running sync.WaitGroup
	e := NewTreeshipCLIEmitter("/bin/treeship", "", func(context.Context, string, []string) ([]byte, error) {
		<-release
		return []byte(`{"status":"ok","id":"art_d","action":"gateway.denied"}`), nil
	})
	for i := 0; i < defaultMaxConcurrent; i++ {
		running.Add(1)
		go func() { defer running.Done(); _ = e.EmitDenial(context.Background(), sampleDenial()) }()
	}
	for len(e.slots) < defaultMaxConcurrent {
		time.Sleep(time.Millisecond)
	}
	// An Emit must also be shed: the pool is shared, not per-method.
	if err := e.Emit(context.Background(), sampleReceipt()); !errors.Is(err, ErrTreeshipBusy) {
		t.Fatalf("Emit during a denial burst = %v, want ErrTreeshipBusy (pools are not shared)", err)
	}
	close(release)
	running.Wait()
}

func TestEmitDenialRejectsAResponseForAnotherAction(t *testing.T) {
	e := NewTreeshipCLIEmitter("/bin/treeship", "", func(context.Context, string, []string) ([]byte, error) {
		return []byte(`{"status":"ok","id":"art_x","action":"gateway.invocation"}`), nil
	})
	if err := e.EmitDenial(context.Background(), sampleDenial()); !errors.Is(err, ErrTreeshipUnavailable) {
		t.Fatalf("err = %v, want ErrTreeshipUnavailable when the CLI attests a different action", err)
	}
}
