package memory

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Canonical write endpoints. contextsPreparePath is the ONLY endpoint this
// client speaks for context preparation. The backend also answers on
// POST /v1/inject as a transitional compatibility alias for an earlier
// shape; this client must never call it — doing so would bake in a
// contract the backend is moving off.
const (
	contextsPreparePath = "/v1/contexts:prepare"
	memoriesProposePath = "/v1/memories:propose"
	memoriesRecordPath  = "/v1/memories:record"
)

// DefaultTimeout bounds a single HTTP request to the backend when
// ZMemConfig.Timeout is unset. The backend's own measurements put real
// latency at roughly 34ms cold, 7ms warm mean, 9ms warm p95 — this default
// is deliberately generous relative to those numbers, not tuned to them; a
// hung backend must not be able to block a join indefinitely.
const DefaultTimeout = 2 * time.Second

// MaxContentChars is the backend's cap on Propose/Record content, in
// characters. The client validates against it before sending, so an
// oversized write is rejected locally rather than discovered as a 4xx.
const MaxContentChars = 256_000

// maxResponseBytes bounds how much of a response this client will read. A
// contexts:prepare response carries admitted memory content up to the
// requested budget (capped upstream at 64,000 tokens); this is sized well
// above that so a legitimate response is never truncated, while still
// stopping a malformed or hostile response from exhausting memory.
const maxResponseBytes = 8 << 20

// ErrorClass distinguishes why a ZMemClient call did not succeed, the same
// way gateway.CallError classifies a proxied call: callers need to tell a
// transport failure from a protocol-level refusal apart without parsing an
// error string.
type ErrorClass string

const (
	// ErrorClassTransport means the backend could not be reached at all: a
	// network error, DNS failure, or the request timing out.
	ErrorClassTransport ErrorClass = "transport"
	// ErrorClassUpstreamStatus means the backend responded with a non-2xx
	// status. ClientError.StatusCode carries which one.
	ErrorClassUpstreamStatus ErrorClass = "upstream_status"
	// ErrorClassTenantMismatch means a contexts:prepare response reported a
	// tenant other than the one this client is configured for. Left
	// unchecked this is a silent cross-tenant memory read, so it always
	// fails the call closed.
	ErrorClassTenantMismatch ErrorClass = "tenant_mismatch"
	// ErrorClassCommitmentInvalid means a contexts:prepare response's
	// commitment was absent, malformed, or did not verify against its own
	// digest.
	ErrorClassCommitmentInvalid ErrorClass = "commitment_invalid"
	// ErrorClassIdempotencyConflict means a Propose or Record call reused an
	// idempotency key for content that does not match what the key was
	// first used for — the backend's 409. This indicates a bug in this
	// client's key derivation, not a caller problem, so it surfaces as an
	// error rather than being retried or swallowed.
	ErrorClassIdempotencyConflict ErrorClass = "idempotency_conflict"
	// ErrorClassContentTooLarge means content exceeded MaxContentChars.
	// Checked locally before sending, so this is never discovered as a 4xx.
	ErrorClassContentTooLarge ErrorClass = "content_too_large"
	// ErrorClassInvalidRequest means a required field — PrepareRequest.Purpose
	// or a write request's AgentID — was empty. Checked locally before
	// sending, the same as ErrorClassContentTooLarge, so this is never
	// discovered as a backend 400.
	ErrorClassInvalidRequest ErrorClass = "invalid_request"
)

// ClientError is returned by ZMemClient methods when a call does not
// succeed. StatusCode is the backend's response status, or zero when no
// response was ever received or the class has no associated status.
type ClientError struct {
	Class      ErrorClass
	StatusCode int
}

func (e *ClientError) Error() string {
	if e.StatusCode == 0 {
		return fmt.Sprintf("memory: zmem call failed: %s", e.Class)
	}
	return fmt.Sprintf("memory: zmem call failed: %s (status %d)", e.Class, e.StatusCode)
}

// ZMemConfig configures a ZMemClient. BaseURL, ServiceToken, and TenantID
// must come from configuration — never hardcoded — and ServiceToken must
// never be logged or exposed to a room member.
type ZMemConfig struct {
	// BaseURL is the backend's base URL, e.g. "http://127.0.0.1:8766". A
	// real deployment is tenant-local and typically loopback-bound (see the
	// package doc). Required.
	BaseURL string
	// ServiceToken is the bearer service token this client authenticates
	// with. Required. Never logged and never returned in an error.
	ServiceToken string
	// TenantID is the tenant this deployment expects the backend to be
	// serving. Every contexts:prepare response is checked against it — the
	// package doc explains why the tenant is never a request field instead
	// — and a mismatch fails the call closed rather than trusting whatever
	// the backend answered with. Required.
	TenantID string
	// Timeout bounds a single HTTP request. Zero or negative uses
	// DefaultTimeout.
	Timeout time.Duration
}

// ZMemClient is the real Store implementation, speaking authenticated JSON
// HTTP to a tenant-local backend deployment. See the package doc for the
// contract it implements and why the seam looks the way it does.
//
// Tenant identity is asserted only on PrepareContext, whose response carries
// a tenant_id field to check against ZMemConfig.TenantID. Propose and
// Record responses carry no tenant field for this client to check, so a
// misconfigured BaseURL pointed at the wrong tenant's deployment would fail
// closed on reads but could write proposed or recorded content into the
// wrong tenant. Writes rely entirely on the backend being deployed
// tenant-local, as the package doc describes, for their isolation.
type ZMemClient struct {
	baseURL      string
	serviceToken string
	tenantID     string
	httpClient   *http.Client
	logger       *slog.Logger
}

// NewZMemClient returns a ZMemClient built from cfg, logging to logger.
// Returns an error if BaseURL, ServiceToken, or TenantID is empty, or if
// BaseURL does not parse as an http(s) URL with a host — checked here so a
// misconfigured deployment fails at startup, where an operator sees it,
// rather than at the first join.
func NewZMemClient(cfg ZMemConfig, logger *slog.Logger) (*ZMemClient, error) {
	if cfg.BaseURL == "" {
		return nil, errors.New("memory: base URL is required")
	}
	parsed, err := url.Parse(cfg.BaseURL)
	if err != nil {
		return nil, fmt.Errorf("memory: base URL is not a valid URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("memory: base URL must be http or https, got %q", cfg.BaseURL)
	}
	if parsed.Host == "" {
		return nil, fmt.Errorf("memory: base URL has no host: %q", cfg.BaseURL)
	}
	if cfg.ServiceToken == "" {
		return nil, errors.New("memory: service token is required")
	}
	if cfg.TenantID == "" {
		return nil, errors.New("memory: tenant ID is required")
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &ZMemClient{
		baseURL:      strings.TrimRight(cfg.BaseURL, "/"),
		serviceToken: cfg.ServiceToken,
		tenantID:     cfg.TenantID,
		httpClient:   &http.Client{Timeout: timeout},
		logger:       logger,
	}, nil
}

// prepareRequestWire is the POST body for contextsPreparePath. Field names
// are the wire contract; Risk, ContextBudgetTokens, MembershipDigest, and
// RoomStateDigest are policy inputs a caller may leave unset.
type prepareRequestWire struct {
	RoomID              string `json:"room_id"`
	AgentID             string `json:"agent_id"`
	Purpose             string `json:"purpose"`
	Risk                string `json:"risk,omitempty"`
	ContextBudgetTokens int    `json:"context_budget_tokens,omitempty"`
	MembershipDigest    string `json:"membership_digest,omitempty"`
	RoomStateDigest     string `json:"room_state_digest,omitempty"`
}

// prepareResponseWire is the decoded body of a contextsPreparePath response.
// Commitment is kept as raw JSON so it can be canonicalized and verified
// byte-for-byte before anything reads a field out of it.
type prepareResponseWire struct {
	TenantID   string          `json:"tenant_id"`
	State      string          `json:"state"`
	Memories   []memoryWire    `json:"memories"`
	Counts     countsWire      `json:"counts"`
	Omissions  omissionsWire   `json:"omissions"`
	Commitment json.RawMessage `json:"commitment"`
}

type memoryWire struct {
	ID         string         `json:"id"`
	Content    string         `json:"content"`
	Provenance provenanceWire `json:"provenance"`
	CreatedAt  time.Time      `json:"created_at"`
}

// provenanceWire is the backend's provenance object. It carries a good deal
// more than this seam exposes — event and receipt hashes, a merkle root, a
// parent action ID — none of which memory.Memory has a field for, so only
// actor_uri is read and the rest is discarded here rather than forwarded.
//
// actor_uri is the one field that answers the question memory.Provenance
// asks ("where did this come from"): the backend sets it to a
// service:// URI for content Rooms recorded as an accepted transition, and
// an agent:// URI for content an agent proposed.
type provenanceWire struct {
	ActorURI string `json:"actor_uri"`
}

type countsWire struct {
	Retrieved     int `json:"retrieved"`
	Admitted      int `json:"admitted"`
	Withheld      int `json:"withheld"`
	BudgetDropped int `json:"budget_dropped"`
}

// omissionsWire is the backend's richer omissions shape. withheld[] and
// budget_dropped[] each carry a memory_id and (for withheld) a rule — an
// internal policy predicate name — neither of which may ever reach a caller
// of this seam (memory.Omissions has no field for either). Collapsing to
// the bounded, deduplicated Omissions this package's Store returns is this
// client's job, not a later layer's, since the richer shape never leaves
// this file.
type omissionsWire struct {
	Withheld      []omissionItemWire `json:"withheld"`
	BudgetDropped []omissionItemWire `json:"budget_dropped"`
	// Abstention is a free-form object whose only field this client reads is
	// "reason" — everything else is discarded rather than forwarded, since
	// it may otherwise be the one place withheld memory content could leak
	// through a response.
	Abstention map[string]any `json:"abstention"`
}

type omissionItemWire struct {
	MemoryID string `json:"memory_id"`
	Reason   string `json:"reason"`
}

// writeRequestWire is the POST body for memoriesProposePath and
// memoriesRecordPath. AgentID has no omitempty: it is required, and an empty
// one never reaches this struct — see ZMemClient.write.
type writeRequestWire struct {
	RoomID  string `json:"room_id"`
	AgentID string `json:"agent_id"`
	Content string `json:"content"`
	// Visibility is left absent, not sent as "room", when the request used
	// the zero value — the backend's own default is "room", so an absent
	// field and an explicit "room" mean the same thing on the wire.
	Visibility     Visibility `json:"visibility,omitempty"`
	SourceEventID  string     `json:"source_event_id"`
	IdempotencyKey string     `json:"idempotency_key"`
}

type writeResponseWire struct {
	ID        string    `json:"id"`
	CreatedAt time.Time `json:"created_at"`
}

// PrepareContext implements Store by calling POST contextsPreparePath. It
// fails closed — returns a non-nil error rather than a result — on a
// transport error, a non-2xx response, a tenant mismatch, or a commitment
// that is absent, malformed, or does not verify; a "refusing" State
// (blocked, abstained, budget_exhausted) is a normal, successful return, so
// a caller can always tell "the backend answered" from "something failed"
// by checking the error alone.
func (c *ZMemClient) PrepareContext(ctx context.Context, req PrepareRequest) (ContextResult, error) {
	if req.Purpose == "" {
		return ContextResult{}, &ClientError{Class: ErrorClassInvalidRequest}
	}

	// PrepareRequest and prepareRequestWire share the same fields in the same
	// order, so this is a plain conversion rather than a field-by-field copy.
	body, err := json.Marshal(prepareRequestWire(req))
	if err != nil {
		return ContextResult{}, fmt.Errorf("memory: encode prepare request: %w", err)
	}

	var resp prepareResponseWire
	if err := c.post(ctx, contextsPreparePath, body, &resp); err != nil {
		return ContextResult{}, err
	}

	if resp.TenantID != c.tenantID {
		c.logger.Error("memory: contexts:prepare response tenant does not match configured tenant — refusing",
			"configured_tenant", c.tenantID, "response_tenant", resp.TenantID)
		return ContextResult{}, &ClientError{Class: ErrorClassTenantMismatch}
	}

	digest, err := verifyCommitment(resp.Commitment)
	if err != nil {
		c.logger.Error("memory: contexts:prepare commitment failed verification", "err", err)
		return ContextResult{}, &ClientError{Class: ErrorClassCommitmentInvalid}
	}

	state, err := parseState(resp.State)
	if err != nil {
		return ContextResult{}, fmt.Errorf("memory: contexts:prepare response: %w", err)
	}

	result := ContextResult{
		State: state,
		// ZMem's returned order is ranked, not chronological, and must be
		// preserved verbatim — see the package doc and memorytest's ordering
		// case. Decoding resp.Memories in place and copying it across
		// without ever sorting is what preserves it.
		Memories:   make([]Memory, len(resp.Memories)),
		Counts:     Counts(resp.Counts),
		Omissions:  collapseOmissions(resp.Omissions),
		Commitment: Commitment{Digest: digest},
	}
	for i, m := range resp.Memories {
		result.Memories[i] = Memory{
			ID:      m.ID,
			Content: m.Content,
			// Flattened, not converted: the backend's provenance is an
			// object and this seam's is a short opaque string.
			Provenance: m.Provenance.ActorURI,
			CreatedAt:  m.CreatedAt,
		}
	}
	return result, nil
}

// parseState validates s against the six known states, so an unrecognized
// value fails the call rather than silently propagating a State a caller's
// switch does not have a case for.
func parseState(s string) (State, error) {
	switch State(s) {
	case StateReady, StatePartial, StateEmpty, StateBlocked, StateAbstained, StateBudgetExhausted:
		return State(s), nil
	default:
		return "", fmt.Errorf("unrecognized state %q", s)
	}
}

// collapseOmissions reduces the backend's per-memory omissions shape to the
// bounded, deduplicated form Store returns: a sorted set of reasons, and — only
// when the backend's abstention object has one — the "reason" field of it. Every
// other field of withheld[], budget_dropped[], and abstention (memory_id, rule,
// and whatever else abstention happens to carry) is dropped here and never
// carried further, since a caller of this seam must never learn which specific
// memory was withheld or which policy predicate withheld it.
func collapseOmissions(w omissionsWire) Omissions {
	reasonSet := make(map[string]struct{}, len(w.Withheld)+len(w.BudgetDropped))
	for _, item := range w.Withheld {
		if item.Reason != "" {
			reasonSet[item.Reason] = struct{}{}
		}
	}
	for _, item := range w.BudgetDropped {
		if item.Reason != "" {
			reasonSet[item.Reason] = struct{}{}
		}
	}
	reasons := make([]string, 0, len(reasonSet))
	for r := range reasonSet {
		reasons = append(reasons, r)
	}
	sort.Strings(reasons)

	var abstention string
	if r, ok := w.Abstention["reason"].(string); ok {
		abstention = r
	}
	return Omissions{Reasons: reasons, Abstention: abstention}
}

// Propose implements Store by calling POST memoriesProposePath.
// ProposeRequest and writeRequestWire share the same fields in the same
// order, so this is a plain conversion.
func (c *ZMemClient) Propose(ctx context.Context, req ProposeRequest) (WriteResult, error) {
	return c.write(ctx, memoriesProposePath, writeRequestWire(req))
}

// Record implements Store by calling POST memoriesRecordPath.
// RecordRequest and writeRequestWire share the same fields in the same
// order, so this is a plain conversion.
func (c *ZMemClient) Record(ctx context.Context, req RecordRequest) (WriteResult, error) {
	return c.write(ctx, memoriesRecordPath, writeRequestWire(req))
}

// write is the shared body of Propose and Record: validate AgentID and
// content length, send the request, and reclassify a 409 as
// ErrorClassIdempotencyConflict — req.IdempotencyKey was reused for content
// that does not match what it was first used for, which is this client's bug
// to fix, not a caller error to retry around.
func (c *ZMemClient) write(ctx context.Context, path string, wire writeRequestWire) (WriteResult, error) {
	if wire.AgentID == "" {
		return WriteResult{}, &ClientError{Class: ErrorClassInvalidRequest}
	}
	if !validVisibility(wire.Visibility) {
		return WriteResult{}, &ClientError{Class: ErrorClassInvalidRequest}
	}
	if n := utf8.RuneCountInString(wire.Content); n > MaxContentChars {
		return WriteResult{}, &ClientError{Class: ErrorClassContentTooLarge}
	}

	body, err := json.Marshal(wire)
	if err != nil {
		return WriteResult{}, fmt.Errorf("memory: encode write request: %w", err)
	}

	var resp writeResponseWire
	if err := c.post(ctx, path, body, &resp); err != nil {
		var ce *ClientError
		if errors.As(err, &ce) && ce.StatusCode == http.StatusConflict {
			return WriteResult{}, fmt.Errorf("memory: idempotency key reused for different content: %w",
				&ClientError{Class: ErrorClassIdempotencyConflict, StatusCode: ce.StatusCode})
		}
		return WriteResult{}, err
	}
	return WriteResult(resp), nil
}

// post issues an authenticated POST to c.baseURL+path and decodes a 2xx JSON
// response into out. A transport failure and a non-2xx response are
// distinguished from each other and from a successful decode: the first two
// return a *ClientError, the third returns whatever json.Decoder reports.
func (c *ZMemClient) post(ctx context.Context, path string, body []byte, out any) error {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("memory: build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.serviceToken)

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		// err can embed the request URL but never the Authorization header,
		// so the service token is not at risk of leaking here.
		return &ClientError{Class: ErrorClassTransport}
	}
	defer closeBody(resp)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &ClientError{Class: ErrorClassUpstreamStatus, StatusCode: resp.StatusCode}
	}

	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes)).Decode(out); err != nil {
		return fmt.Errorf("memory: decode response: %w", err)
	}
	return nil
}

func closeBody(resp *http.Response) {
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
}
