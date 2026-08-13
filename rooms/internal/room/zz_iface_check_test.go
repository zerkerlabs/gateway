package room

// Compile-time assertions that both implementations still satisfy Store, so
// a method added to Store and left unimplemented on one side fails the build
// immediately rather than at run time.
//
// This is currently the ONLY thing holding the two implementations to the
// same interface. Only MemoryStore is exercised end-to-end by
// roomtest.RunContract (store_test.go); PostgresStore is covered by its own
// direct tests (postgres_test.go), which is weaker — satisfying the interface
// is not the same as behaving identically through it. Running the shared
// suite against both is tracked separately; see the note in postgres_test.go
// for what it needs.
var (
	_ Store = (*MemoryStore)(nil)
	_ Store = (*PostgresStore)(nil)
)
