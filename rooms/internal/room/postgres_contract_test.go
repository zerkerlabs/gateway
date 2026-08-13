//go:build integration

package room_test

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	roomsdb "github.com/zerkerlabs/gateway/rooms/db"
	"github.com/zerkerlabs/gateway/rooms/internal/resource"
	"github.com/zerkerlabs/gateway/rooms/internal/room"
	"github.com/zerkerlabs/gateway/rooms/internal/room/roomtest"
)

// pgContractPoolMaxConns caps every schema-scoped pool this suite opens.
// roomtest.RunContract's ~30 independent newStore() calls can be scheduled
// concurrently (bounded by -parallel, which defaults to GOMAXPROCS), each
// opening its own pool; pgxpool's own default of "4 or NumCPU()" would let
// that product scale with the host's core count and risk exhausting
// Postgres's connection limit on a large machine. A small fixed cap keeps
// the worst case bounded regardless of host size — the concurrency this
// suite is proving lives in Postgres's row locking, not in how many
// connections a single store happens to hold.
const pgContractPoolMaxConns = 4

// TestPostgresStore_Contract proves PostgresStore satisfies the same
// behavioural contract as MemoryStore (see store_test.go) rather than merely
// the same interface (see zz_iface_check_test.go).
//
// Isolation for the suite's ~30 independent, many of them t.Parallel(),
// newStore() calls is a fresh Postgres schema per call rather than the
// TRUNCATE convention the rest of this file uses: TRUNCATE-ing shared tables
// out from under concurrent subtests would be mutual destruction, not
// flakiness (see the removed note this replaces, previously above the "write
// path" section below). A schema is cheap to create, gets its own copy of
// every table via a normal db.Migrate, and is dropped in a t.Cleanup — a
// failed subtest still drops its schema, so nothing leaks into the next run.
func TestPostgresStore_Contract(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration tests")
	}

	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pgxpool.New (admin): %v", err)
	}
	// Registered on the top-level t, so it closes only after every subtest
	// below — including deeply nested, parallel ones — has completed and run
	// its own per-schema drop.
	t.Cleanup(admin.Close)

	roomtest.RunContract(t, func(t *testing.T) room.Store {
		return newSchemaScopedPGStore(t, url, admin)
	})
}

// newSchemaScopedPGStore creates a fresh Postgres schema, migrates Rooms'
// tables into it, and returns a PostgresStore whose pool always resolves
// unqualified table names into that schema — so it is invisible to, and
// unaffected by, every other store the contract suite creates concurrently.
// admin is used only for the CREATE/DROP SCHEMA statements, which the
// schema-scoped pool cannot issue against itself before it exists (or after
// its own schema is dropped).
func newSchemaScopedPGStore(t *testing.T, url string, admin *pgxpool.Pool) *room.PostgresStore {
	t.Helper()
	ctx := context.Background()

	schemaID, err := resource.New("contract")
	if err != nil {
		t.Fatalf("resource.New(contract): %v", err)
	}
	// Postgres identifiers can't contain '-' unquoted; a resource ID's UUIDv7
	// half is otherwise exactly what a disposable, collision-free schema name
	// needs.
	schema := strings.ReplaceAll(schemaID, "-", "_")

	if _, err := admin.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatalf("create schema %s: %v", schema, err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(context.Background(), `DROP SCHEMA IF EXISTS `+schema+` CASCADE`); err != nil {
			t.Errorf("drop schema %s: %v", schema, err)
		}
	})

	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatalf("ParseConfig: %v", err)
	}
	// search_path is a startup-time session parameter (see pgconn.Config.
	// RuntimeParams), so every connection this pool ever opens resolves
	// rooms/room_members/room_events/room_reservations against schema before
	// it resolves anything of the same name in public.
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	cfg.MaxConns = pgContractPoolMaxConns

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("pgxpool.NewWithConfig: %v", err)
	}
	t.Cleanup(pool.Close)

	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping postgres (schema %s): %v", schema, err)
	}
	if err := roomsdb.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate schema %s: %v", schema, err)
	}

	return room.NewPostgresStore(pool)
}
