// Command rooms is the Rooms service: a substrate where agents with persistent
// memory join a shared, membership-scoped space and cowork a task over time.
//
// Rooms is a separate deployable, not part of the gateway. It owns membership,
// shared task state, and orchestration; it deliberately owns no policy engine
// and no payment logic. Agent-to-agent calls are issued through the gateway's
// public proxy API, so they inherit policy enforcement, payment metering, and
// invocation capture rather than reimplementing any of it.
//
// This entrypoint serves the operational routes plus the v1 room API: create
// a room, read it back, seat a member, post a message, and read the room's
// receipts.
//
// It supports two deployment modes, selected by ROOMS_DATABASE_URL: durable
// (a Postgres store, migrated automatically at startup) when it is set, and
// ephemeral (an in-memory store, evaluation only) when it is not. See
// openStore and the README's database section.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	roomsdb "github.com/zerkerlabs/gateway/rooms/db"
	"github.com/zerkerlabs/gateway/rooms/internal/auth"
	"github.com/zerkerlabs/gateway/rooms/internal/gateway"
	"github.com/zerkerlabs/gateway/rooms/internal/httpapi"
	"github.com/zerkerlabs/gateway/rooms/internal/memory"
	"github.com/zerkerlabs/gateway/rooms/internal/receipt"
	"github.com/zerkerlabs/gateway/rooms/internal/room"
	"github.com/zerkerlabs/gateway/rooms/internal/version"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		log.Fatal(err)
	}
}

// shutdownTimeout bounds how long graceful shutdown waits for in-flight
// requests to drain once a signal arrives, before giving up.
const shutdownTimeout = 10 * time.Second

// defaultAddr is the listen address when ROOMS_ADDR is unset. Rooms sits
// behind a TLS terminator in production (AGENTS.md invariant #5).
const defaultAddr = ":8090"

func run(logger *slog.Logger) error {
	// SIGINT/SIGTERM cancels ctx — the single shutdown signal.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	addr := os.Getenv("ROOMS_ADDR")
	if addr == "" {
		addr = defaultAddr
	}

	gwClient, err := gateway.New(gatewayConfigFromEnv(logger))
	if err != nil {
		return fmt.Errorf("init gateway client: %w", err)
	}

	// A room's store is built up front, rather than inside newMux, so it can
	// be reconciled before anything is served from it: a reservation left
	// open by a crash has to be resolved one way or the other before this
	// process starts taking traffic for the room that holds it.
	//
	// openStore selects the implementation from configuration: a configured
	// ROOMS_DATABASE_URL selects the durable PostgresStore (pool opened,
	// migrations applied); its absence selects the ephemeral MemoryStore. A
	// MemoryStore starts empty, so the reconciliation sweep below has nothing
	// to find there — that is expected, not a gap, since ephemeral mode by
	// definition has nothing to survive a restart.
	store, closeStore, err := openStore(ctx, logger)
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer closeStore()

	if err := room.ReconcileReservations(ctx, store, gwClient, reconcileTimeoutFromEnv(logger), logger); err != nil {
		return fmt.Errorf("reconcile turn reservations: %w", err)
	}

	zmemDeployment, err := zmemDeploymentFromEnv()
	if err != nil {
		return fmt.Errorf("init memory backend config: %w", err)
	}
	memoryStore, err := memory.NewZMemClient(memory.ZMemConfig{
		BaseURL:      zmemDeployment.BaseURL,
		ServiceToken: zmemDeployment.ServiceToken,
		TenantID:     zmemDeployment.TenantID,
		Timeout:      zmemDeployment.Timeout,
	}, logger)
	if err != nil {
		return fmt.Errorf("init memory backend client: %w", err)
	}
	logger.Info("rooms: memory backend configured",
		"base_url", zmemDeployment.BaseURL, "tenant_id", zmemDeployment.TenantID,
		"timeout", zmemDeployment.Timeout, "context_budget_tokens", zmemDeployment.ContextBudgetTokens,
		"risk", zmemDeployment.Risk)

	handler, roomHandler, err := newHandler(logger, store, gwClient, memoryStore, memory.ContextPolicy{
		Risk:                zmemDeployment.Risk,
		ContextBudgetTokens: zmemDeployment.ContextBudgetTokens,
	})
	if err != nil {
		return err
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("rooms: listening", "addr", addr, "version", version.Version)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
			return
		}
		errCh <- nil
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		logger.Info("rooms: shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			return err
		}
		// Draining in-flight requests above does not by itself drain the
		// detached receipt-emission goroutines those requests spawned — that
		// is roomHandler.Shutdown's job, so none outlives the process.
		return roomHandler.Shutdown(shutdownCtx)
	}
}

// newHandler builds what the server actually serves: the router behind the
// bearer-token middleware. Wrapping the whole router — rather than the room
// routes alone — is what makes authentication the default; the middleware
// exempts /healthz and /version itself, so those stay reachable, and any route
// added later is authenticated unless someone deliberately exempts it.
//
// Authentication is required to start: auth.NewMiddleware fails when the OIDC
// issuer or audience is unset (ROOMS_OIDC_ISSUER, ROOMS_OIDC_AUDIENCE), so a
// misconfigured deployment refuses to come up rather than serving rooms
// unprotected (AGENTS.md invariant #1).
//
// The *httpapi.Handler is also returned so the caller can drain its receipt-
// emission goroutines on shutdown (Handler.Shutdown) — the auth-wrapped
// http.Handler above does not expose it.
func newHandler(logger *slog.Logger, store room.Store, gwClient httpapi.GatewayCaller, memoryStore memory.Store, contextPolicy memory.ContextPolicy) (http.Handler, *httpapi.Handler, error) {
	// context.Background, not the shutdown context: go-oidc keeps this context
	// for background JWKS refreshes, and one cancelled at SIGTERM would break
	// key rotation for the lifetime of the process instead.
	mw, err := auth.NewMiddleware(context.Background(), auth.ConfigFromEnv(), logger)
	if err != nil {
		return nil, nil, fmt.Errorf("init auth middleware: %w", err)
	}
	mux, roomHandler := newMux(logger, store, gwClient, memoryStore, contextPolicy)
	return mw(mux), roomHandler, nil
}

// newMux builds the router. The five room routes derive their tenant from the
// validated token claims the auth middleware puts on the request context; the
// operational routes are the only ones the middleware lets through
// unauthenticated (AGENTS.md invariant #1).
//
// It also returns the *httpapi.Handler it registered, so a caller that needs
// it for shutdown draining does not have to reach back into the mux.
func newMux(logger *slog.Logger, store room.Store, gwClient httpapi.GatewayCaller, memoryStore memory.Store, contextPolicy memory.ContextPolicy) (*http.ServeMux, *httpapi.Handler) {
	mux := http.NewServeMux()
	mux.Handle("GET /healthz", healthz())
	mux.Handle("GET /version", versionHandler())

	// receipt.NewFake is a stand-in for the real receipt backend, which does
	// not exist yet (rooms/internal/receipt); a real client wires in here
	// later without changing the httpapi.Handler seam. memoryStore, by
	// contrast, is the real backend client built in run() — memory.NewFake
	// remains available, but only for tests now.
	//
	// store is also built in run(), so its turn reservations are reconciled
	// before any route can reach it.
	roomHandler := httpapi.NewHandler(store, memoryStore, contextPolicy, gwClient, receipt.NewFake(), logger)
	roomHandler.RegisterRoutes(mux)
	return mux, roomHandler
}

// gatewayConfigFromEnv builds the gateway client's config from environment
// variables. ROOMS_GATEWAY_BASE_URL, ROOMS_GATEWAY_CREDENTIAL, and
// ROOMS_GATEWAY_TENANT are required — gateway.New rejects a config missing any
// of them, since the base URL and credential must come from configuration and
// never be hardcoded (AGENTS.md invariant #4 covers the credential).
//
// ROOMS_GATEWAY_TENANT names the gateway tenant the credential authenticates
// as. The gateway takes the acting tenant from the credential's claims, so one
// credential acts for one tenant, and this deployment can only deliver
// addressed messages for rooms belonging to that tenant — a room from any
// other tenant is refused rather than sent out misattributed. Serving several
// tenants means running a Rooms per tenant.
//
// Two optional durations tune the call, and they bound different things.
// ROOMS_GATEWAY_TIMEOUT bounds a single HTTP request. The proxy is
// asynchronous, though — it returns 202 and runs the call server-side — so
// ROOMS_GATEWAY_CONFIRM_TIMEOUT bounds how long Rooms will poll the resulting
// invocation for a terminal state before reporting the outcome as unknown.
// That is the one to raise for slow recipient agents; raising the request
// timeout would not help. Unset or invalid values fall back to the package
// defaults.
//
// Their sum is what a caller feels: posting an addressed message blocks until
// delivery is confirmed, so it can take ROOMS_GATEWAY_TIMEOUT +
// ROOMS_GATEWAY_CONFIRM_TIMEOUT (90s by default) in the worst case. Anything
// fronting Rooms needs a request timeout above that.
func gatewayConfigFromEnv(logger *slog.Logger) gateway.Config {
	return gateway.Config{
		BaseURL:        os.Getenv("ROOMS_GATEWAY_BASE_URL"),
		Credential:     os.Getenv("ROOMS_GATEWAY_CREDENTIAL"),
		Tenant:         os.Getenv("ROOMS_GATEWAY_TENANT"),
		Timeout:        durationFromEnv(logger, "ROOMS_GATEWAY_TIMEOUT"),
		ConfirmTimeout: durationFromEnv(logger, "ROOMS_GATEWAY_CONFIRM_TIMEOUT"),
	}
}

// reconcileTimeoutFromEnv reads ROOMS_RECONCILE_TIMEOUT, the bound on the
// whole startup reservation-reconciliation sweep (room.ReconcileReservations).
// Unset or invalid falls back to room.DefaultReconcileTimeout — a gateway
// this process cannot reach must not be able to stop it from starting.
func reconcileTimeoutFromEnv(logger *slog.Logger) time.Duration {
	return durationFromEnv(logger, "ROOMS_RECONCILE_TIMEOUT")
}

// durationFromEnv reads an optional duration, returning zero (which the
// gateway package reads as "use the default") when unset or unparseable.
func durationFromEnv(logger *slog.Logger, key string) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return 0
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		logger.Warn("rooms: invalid duration, using default", "var", key, "value", v, "err", err)
		return 0
	}
	return d
}

// defaultDatabaseMaxConns, defaultDatabaseMinConns, and
// defaultDatabaseMaxConnIdleTime are the pool defaults used when their
// respective ROOMS_DATABASE_* variables are unset.
const (
	defaultDatabaseMaxConns        = 10
	defaultDatabaseMinConns        = 2
	defaultDatabaseMaxConnIdleTime = 5 * time.Minute
)

// poolConfig is Rooms' configurable connection-pool tuning for the durable
// store, with sane defaults so ROOMS_DATABASE_URL alone is enough to run
// durably.
type poolConfig struct {
	MaxConns        int32
	MinConns        int32
	MaxConnIdleTime time.Duration
}

// poolConfigFromEnv reads the pool tuning variables, applying documented
// defaults for anything unset and rejecting anything malformed rather than
// silently falling back — an operator who set a pool variable and got a typo
// past startup would only find out under load.
func poolConfigFromEnv() (poolConfig, error) {
	maxConns := int32(defaultDatabaseMaxConns)
	if v := os.Getenv("ROOMS_DATABASE_MAX_CONNS"); v != "" {
		n, err := strconv.ParseInt(v, 10, 32)
		if err != nil || n <= 0 {
			return poolConfig{}, fmt.Errorf("ROOMS_DATABASE_MAX_CONNS must be a positive integer, got %q", v)
		}
		maxConns = int32(n) //nolint:gosec // bounded to int32 by ParseInt's bitSize=32
	}

	minConns := int32(defaultDatabaseMinConns)
	if v := os.Getenv("ROOMS_DATABASE_MIN_CONNS"); v != "" {
		n, err := strconv.ParseInt(v, 10, 32)
		if err != nil || n < 0 {
			return poolConfig{}, fmt.Errorf("ROOMS_DATABASE_MIN_CONNS must be a non-negative integer, got %q", v)
		}
		minConns = int32(n) //nolint:gosec // bounded to int32 by ParseInt's bitSize=32
	}
	if minConns > maxConns {
		return poolConfig{}, fmt.Errorf("ROOMS_DATABASE_MIN_CONNS (%d) must not exceed ROOMS_DATABASE_MAX_CONNS (%d)", minConns, maxConns)
	}

	maxConnIdleTime := defaultDatabaseMaxConnIdleTime
	if v := os.Getenv("ROOMS_DATABASE_MAX_CONN_IDLE_TIME"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return poolConfig{}, fmt.Errorf("ROOMS_DATABASE_MAX_CONN_IDLE_TIME: %w", err)
		}
		maxConnIdleTime = d
	}

	return poolConfig{MaxConns: maxConns, MinConns: minConns, MaxConnIdleTime: maxConnIdleTime}, nil
}

// openStore selects Rooms' room.Store implementation from configuration. A
// configured ROOMS_DATABASE_URL selects the durable PostgresStore: the pool
// is opened and tuned, connectivity is verified, and pending migrations are
// applied before the store is handed back. Its absence selects the ephemeral
// MemoryStore, logged loudly as non-durable.
//
// Rooms never falls back to the in-memory store on a database failure — a
// malformed or unreachable ROOMS_DATABASE_URL fails startup instead. Silently
// downgrading to ephemeral would let a self-hoster who configured a database
// lose data while believing it was safe.
//
// The returned close function releases the pool (a no-op for the in-memory
// store) and must be called on shutdown.
func openStore(ctx context.Context, logger *slog.Logger) (room.Store, func(), error) {
	dbURL := os.Getenv("ROOMS_DATABASE_URL")
	if dbURL == "" {
		logger.Warn("rooms: ROOMS_DATABASE_URL is not set — running in EPHEMERAL mode with the " +
			"in-memory store. ALL ROOM STATE IS NON-DURABLE AND WILL BE LOST ON RESTART. " +
			"This mode is for evaluation only; configure ROOMS_DATABASE_URL for production use.")
		return room.NewMemoryStore(), func() {}, nil
	}

	pool, err := openDatabasePool(ctx, dbURL)
	if err != nil {
		return nil, nil, err
	}

	if err := roomsdb.Migrate(ctx, pool); err != nil {
		pool.Close()
		return nil, nil, fmt.Errorf("run migrations: %w", err)
	}

	logger.Info("rooms: running in DURABLE mode with the Postgres store",
		"max_conns", pool.Config().MaxConns, "min_conns", pool.Config().MinConns)

	return room.NewPostgresStore(pool), pool.Close, nil
}

// openDatabasePool parses dbURL, applies the configured pool tuning, and
// opens the pool — pinging it to turn an unreachable database into a startup
// failure rather than a failure on the first request. A malformed dbURL fails
// at ParseConfig, before any connection is attempted.
func openDatabasePool(ctx context.Context, dbURL string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, fmt.Errorf("parse ROOMS_DATABASE_URL: %w", err)
	}

	poolCfg, err := poolConfigFromEnv()
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = poolCfg.MaxConns
	cfg.MinConns = poolCfg.MinConns
	cfg.MaxConnIdleTime = poolCfg.MaxConnIdleTime

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("open database pool: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}

	return pool, nil
}

// defaultContextBudgetTokens is used when ROOMS_ZMEM_CONTEXT_BUDGET_TOKENS is
// unset. It matches the memory backend's own default. Rooms sets one
// configured value per deployment and sends it explicitly rather than
// relying on the backend's own default, so the value a commitment attests to
// is always visible here.
const defaultContextBudgetTokens = 2_000

// maxContextBudgetTokens is the memory backend's own cap on
// context_budget_tokens. A configured value above it can never be satisfied,
// so it is rejected at startup rather than silently truncated by the backend
// on every join.
const maxContextBudgetTokens = 64_000

// defaultRisk is used when ROOMS_ZMEM_RISK is unset.
const defaultRisk = "medium"

// validRisks are the risk levels the memory backend accepts.
var validRisks = map[string]bool{"low": true, "medium": true, "high": true}

// zmemDeployment is the fully-resolved configuration for this deployment's
// memory backend: what memory.NewZMemClient needs (BaseURL, ServiceToken,
// TenantID, Timeout) plus the two policy inputs — ContextBudgetTokens and
// Risk — an operator sets once per deployment. Wiring the latter two into the
// join path's PrepareContext call is a separate change; see
// rooms/internal/httpapi/members.go.
type zmemDeployment struct {
	BaseURL             string
	ServiceToken        string
	TenantID            string
	Timeout             time.Duration
	ContextBudgetTokens int
	Risk                string
}

// zmemDeploymentFromEnv reads and validates the memory backend's
// configuration from the environment, failing loudly on anything malformed
// rather than letting Rooms start with a backend it cannot reach or a policy
// input it cannot honor. ROOMS_ZMEM_BASE_URL and ROOMS_ZMEM_TENANT_ID have no
// default — memory.NewZMemClient itself refuses an empty BaseURL or TenantID,
// which is the actual enforcement; the checks here exist so a missing value
// is reported by name instead of as an opaque client-construction error.
//
// ROOMS_ZMEM_SERVICE_TOKEN is read via readSecret, never a flag: a flag value
// is visible to anyone who can list processes on the host, and this token
// authenticates to the tenant's own memory. It is never logged.
func zmemDeploymentFromEnv() (zmemDeployment, error) {
	baseURL := os.Getenv("ROOMS_ZMEM_BASE_URL")
	if baseURL == "" {
		return zmemDeployment{}, errors.New("ROOMS_ZMEM_BASE_URL is required")
	}

	token, err := readSecret("ROOMS_ZMEM_SERVICE_TOKEN")
	if err != nil {
		return zmemDeployment{}, err
	}
	if token == "" {
		return zmemDeployment{}, errors.New("ROOMS_ZMEM_SERVICE_TOKEN or ROOMS_ZMEM_SERVICE_TOKEN_FILE is required")
	}

	tenantID := os.Getenv("ROOMS_ZMEM_TENANT_ID")
	if tenantID == "" {
		return zmemDeployment{}, errors.New("ROOMS_ZMEM_TENANT_ID is required")
	}

	timeout := memory.DefaultTimeout
	if v := os.Getenv("ROOMS_ZMEM_TIMEOUT"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return zmemDeployment{}, fmt.Errorf("ROOMS_ZMEM_TIMEOUT: %w", err)
		}
		timeout = d
	}

	budget := defaultContextBudgetTokens
	if v := os.Getenv("ROOMS_ZMEM_CONTEXT_BUDGET_TOKENS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return zmemDeployment{}, fmt.Errorf("ROOMS_ZMEM_CONTEXT_BUDGET_TOKENS: %w", err)
		}
		if n <= 0 || n > maxContextBudgetTokens {
			return zmemDeployment{}, fmt.Errorf("ROOMS_ZMEM_CONTEXT_BUDGET_TOKENS must be between 1 and %d, got %d", maxContextBudgetTokens, n)
		}
		budget = n
	}

	risk := defaultRisk
	if v := os.Getenv("ROOMS_ZMEM_RISK"); v != "" {
		if !validRisks[v] {
			return zmemDeployment{}, fmt.Errorf(`ROOMS_ZMEM_RISK must be "low", "medium", or "high", got %q`, v)
		}
		risk = v
	}

	return zmemDeployment{
		BaseURL:             baseURL,
		ServiceToken:        token,
		TenantID:            tenantID,
		Timeout:             timeout,
		ContextBudgetTokens: budget,
		Risk:                risk,
	}, nil
}

// readSecret returns the value of the environment variable envVar, or — when
// that is unset — the trimmed contents of the file named by envVar+"_FILE".
// The file form lets an operator hand Rooms a secret via a mounted file (a
// Docker or Kubernetes secret, say) instead of a plain environment variable;
// either way, the secret never appears on the command line, where it would be
// visible to anyone who can list processes on the host. Returns "" with no
// error when neither is set, so callers can distinguish "not configured"
// from a file that failed to read.
func readSecret(envVar string) (string, error) {
	if v := os.Getenv(envVar); v != "" {
		return v, nil
	}
	path := os.Getenv(envVar + "_FILE")
	if path == "" {
		return "", nil
	}
	data, err := os.ReadFile(path) //nolint:gosec // operator-configured path via <envVar>_FILE, not user input
	if err != nil {
		return "", fmt.Errorf("read %s: %w", envVar+"_FILE", err)
	}
	return strings.TrimSpace(string(data)), nil
}

// healthz reports liveness only: the process answered. Readiness gains meaning
// once Rooms has dependencies to check, and gets added then — reporting "ready"
// while checking nothing would be worse than not reporting it (invariant #9).
func healthz() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
}

// versionHandler returns deliberate build metadata only — never configuration
// values or internal addresses (invariant #9).
func versionHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{
			"version": version.Version,
			"commit":  version.Commit,
		})
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
