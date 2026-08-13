package room

// Compile-time assertions that both implementations still satisfy Store, so
// a method added to Store and left unimplemented on one side fails the build
// immediately rather than at run time.
//
// Satisfying the interface is not the same as behaving identically through
// it — that stronger claim is proven by running roomtest.RunContract against
// both implementations: MemoryStore in store_test.go, PostgresStore (build
// tag integration, schema-per-store isolation) in postgres_contract_test.go.
// PostgresStore also has its own direct tests in postgres_test.go, additive
// to the shared suite rather than a substitute for it.
var (
	_ Store = (*MemoryStore)(nil)
	_ Store = (*PostgresStore)(nil)
)
