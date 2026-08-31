package discovery

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
)

func TestScanFindsInstalledAndConfiguredAgentsWithoutExposingSecrets(t *testing.T) {
	t.Parallel()

	filesystem := fstest.MapFS{
		".claude":      &fstest.MapFile{Mode: fs.ModeDir},
		".claude.json": &fstest.MapFile{Data: []byte(`{"mcpServers":{"github":{"env":{"TOKEN":"do-not-return"}},"browser":{"command":"secret-command"}}}`)},
		".codex":       &fstest.MapFile{Mode: fs.ModeDir},
	}
	lookPath := func(command string) (string, error) {
		if command == "claude" || command == "pi" {
			return "/private/bin/" + command, nil
		}
		return "", errors.New("not found")
	}

	report, err := Scan(Options{HomeDir: "/Users/private", FS: filesystem, LookPath: lookPath, HostIDPath: tempHostIDPath(t), MachineID: fixedMachineID("test-machine")})
	if err != nil {
		t.Fatalf("Scan() error = %v", err)
	}

	if report.Schema != Schema {
		t.Fatalf("Schema = %q, want %q", report.Schema, Schema)
	}
	gotNames := make([]string, 0, len(report.Agents))
	for _, found := range report.Agents {
		gotNames = append(gotNames, found.Name)
	}
	wantNames := []string{"Claude Code", "Codex", "Pi"}
	if !reflect.DeepEqual(gotNames, wantNames) {
		t.Fatalf("agent names = %#v, want %#v", gotNames, wantNames)
	}

	claude := report.Agents[0]
	if !claude.Installed || !claude.Configured || claude.MCPServerCount != 2 {
		t.Fatalf("Claude Code = %#v, want installed, configured, 2 MCP servers", claude)
	}

	serialized := strings.Builder{}
	for _, found := range report.Agents {
		for _, evidence := range found.Evidence {
			serialized.WriteString(evidence.Detail)
		}
	}
	for _, forbidden := range []string{"/Users/private", "do-not-return", "secret-command", "/private/bin"} {
		if strings.Contains(serialized.String(), forbidden) {
			t.Fatalf("evidence exposed %q: %s", forbidden, serialized.String())
		}
	}
}

func TestScanFindsHermesFromItsCommandAndHome(t *testing.T) {
	t.Parallel()

	report, err := Scan(Options{
		HomeDir: "/unused",
		FS: fstest.MapFS{
			".hermes": &fstest.MapFile{Mode: fs.ModeDir},
		},
		LookPath: func(command string) (string, error) {
			if command == "hermes" {
				return "/private/bin/hermes", nil
			}
			return "", errors.New("not found")
		},
		HostIDPath: tempHostIDPath(t),
		MachineID:  fixedMachineID("test-machine"),
	})
	if err != nil {
		t.Fatalf("Scan() error = %v", err)
	}
	if len(report.Agents) != 1 {
		t.Fatalf("agents = %#v, want one Hermes agent", report.Agents)
	}
	hermes := report.Agents[0]
	if hermes.Key != "hermes" || hermes.Name != "Hermes" || hermes.Provider != "Nous Research" {
		t.Fatalf("Hermes = %#v, want stable identity fields", hermes)
	}
	if !hermes.Installed || !hermes.Configured {
		t.Fatalf("Hermes = %#v, want installed and configured", hermes)
	}
}

func TestScanIgnoresMalformedOptionalMCPConfig(t *testing.T) {
	t.Parallel()

	report, err := Scan(Options{
		HomeDir: "/unused",
		FS: fstest.MapFS{
			".cursor":          &fstest.MapFile{Mode: fs.ModeDir},
			".cursor/mcp.json": &fstest.MapFile{Data: []byte(`{"mcpServers":`)},
		},
		LookPath:   alwaysMissing,
		HostIDPath: tempHostIDPath(t),
		MachineID:  fixedMachineID("test-machine"),
	})
	if err != nil {
		t.Fatalf("Scan() error = %v", err)
	}
	if len(report.Agents) != 1 || report.Agents[0].Name != "Cursor" {
		t.Fatalf("agents = %#v, want Cursor", report.Agents)
	}
	if report.Agents[0].MCPServerCount != 0 {
		t.Fatalf("MCPServerCount = %d, want 0", report.Agents[0].MCPServerCount)
	}
}

func TestScanReturnsEmptyReportWhenNothingIsFound(t *testing.T) {
	t.Parallel()

	report, err := Scan(Options{HomeDir: "/unused", FS: fstest.MapFS{}, LookPath: alwaysMissing, HostIDPath: tempHostIDPath(t), MachineID: fixedMachineID("test-machine")})
	if err != nil {
		t.Fatalf("Scan() error = %v", err)
	}
	if report.Agents == nil {
		t.Fatal("Agents is nil, want an empty JSON array")
	}
	if len(report.Agents) != 0 {
		t.Fatalf("agents = %#v, want none", report.Agents)
	}
}

func TestScanOmitsHostnameByDefault(t *testing.T) {
	t.Parallel()

	report, err := Scan(Options{HomeDir: "/unused", FS: fstest.MapFS{}, LookPath: alwaysMissing, Hostname: "alexs-macbook-pro.local", HostIDPath: tempHostIDPath(t), MachineID: fixedMachineID("test-machine")})
	if err != nil {
		t.Fatalf("Scan() error = %v", err)
	}
	if report.Host.Hostname != "" {
		t.Fatalf("Hostname = %q, want empty by default", report.Host.Hostname)
	}
	if report.Host.HostID == "" {
		t.Fatal("HostID is empty, want a stable non-empty id")
	}
	if report.Host.HostID == "alexs-macbook-pro.local" || strings.Contains(report.Host.HostID, "alexs") {
		t.Fatalf("HostID = %q leaks the hostname", report.Host.HostID)
	}
}

func TestScanIncludesHostnameWhenRequested(t *testing.T) {
	t.Parallel()

	report, err := Scan(Options{HomeDir: "/unused", FS: fstest.MapFS{}, LookPath: alwaysMissing, Hostname: "alexs-macbook-pro.local", IncludeHostname: true, HostIDPath: tempHostIDPath(t), MachineID: fixedMachineID("test-machine")})
	if err != nil {
		t.Fatalf("Scan() error = %v", err)
	}
	if report.Host.Hostname != "alexs-macbook-pro.local" {
		t.Fatalf("Hostname = %q, want the machine's hostname", report.Host.Hostname)
	}
}

func TestScanHostIDIsStableAcrossRunsAndIndependentOfHostname(t *testing.T) {
	t.Parallel()

	scan := func(hostname, machineID, hostIDPath string) string {
		t.Helper()
		report, err := Scan(Options{
			HomeDir:    "/unused",
			FS:         fstest.MapFS{},
			LookPath:   alwaysMissing,
			Hostname:   hostname,
			HostIDPath: hostIDPath,
			MachineID:  fixedMachineID(machineID),
		})
		if err != nil {
			t.Fatalf("Scan() error = %v", err)
		}
		return report.Host.HostID
	}

	// A different hostname on the same machine must not change the id: the id
	// is not derived from the hostname.
	path := tempHostIDPath(t)
	first := scan("build-runner-1", "machine-a", path)
	if second := scan("build-runner-2", "machine-a", path); first != second {
		t.Fatalf("HostID = %q then %q, want the same machine to produce the same id regardless of hostname", first, second)
	}

	// A different machine must produce a different id, even under the same
	// hostname.
	if other := scan("build-runner-1", "machine-b", path); other == first {
		t.Fatal("HostID matched across two distinct machines, want distinct ids")
	}
}

// The id tracks the machine, not the home directory. These are the two ways a
// home-directory-resident token gets it wrong, and the reason host_id is
// derived from a platform identifier instead.
func TestScanHostIDTracksTheMachineNotTheHomeDirectory(t *testing.T) {
	t.Parallel()

	scan := func(machineID, hostIDPath string) string {
		t.Helper()
		report, err := Scan(Options{
			HomeDir:    "/unused",
			FS:         fstest.MapFS{},
			LookPath:   alwaysMissing,
			HostIDPath: hostIDPath,
			MachineID:  fixedMachineID(machineID),
		})
		if err != nil {
			t.Fatalf("Scan() error = %v", err)
		}
		return report.Host.HostID
	}

	// Wiping or reimaging the home directory keeps the same id.
	if before, after := scan("machine-a", tempHostIDPath(t)), scan("machine-a", tempHostIDPath(t)); before != after {
		t.Fatalf("HostID = %q then %q, want a reimaged home directory to keep the machine's id", before, after)
	}

	// Cloning one home directory onto two machines still gives two ids.
	shared := tempHostIDPath(t)
	if a, b := scan("machine-a", shared), scan("machine-b", shared); a == b {
		t.Fatal("two machines sharing a home directory got one HostID, want distinct ids")
	}
}

func TestScanHostIDIsAHashNotTheRawMachineIdentifier(t *testing.T) {
	t.Parallel()

	const machineID = "0A1B2C3D-4E5F-6789-ABCD-EF0123456789"
	report, err := Scan(Options{
		HomeDir:    "/unused",
		FS:         fstest.MapFS{},
		LookPath:   alwaysMissing,
		HostIDPath: tempHostIDPath(t),
		MachineID:  fixedMachineID(machineID),
	})
	if err != nil {
		t.Fatalf("Scan() error = %v", err)
	}
	if strings.Contains(report.Host.HostID, machineID) {
		t.Fatalf("HostID = %q carries the raw machine identifier", report.Host.HostID)
	}
	sum := sha256.Sum256([]byte(hostIDNamespace + machineID))
	if want := hex.EncodeToString(sum[:]); report.Host.HostID != want {
		t.Fatalf("HostID = %q, want the namespaced digest %q", report.Host.HostID, want)
	}
}

// Where the platform exposes no machine identifier, the id falls back to a
// random value persisted once. The persisted value is the digest pre-image,
// not the id itself.
func TestScanFallsBackToAPersistedRandomIDWhenThePlatformHasNone(t *testing.T) {
	t.Parallel()

	hostIDPath := tempHostIDPath(t)
	if _, err := os.Stat(hostIDPath); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("host id file already exists before first scan: %v", err)
	}

	opts := Options{
		HomeDir:    "/unused",
		FS:         fstest.MapFS{},
		LookPath:   alwaysMissing,
		HostIDPath: hostIDPath,
		MachineID:  fixedMachineID(""),
	}
	report, err := Scan(opts)
	if err != nil {
		t.Fatalf("Scan() error = %v", err)
	}
	persisted, err := os.ReadFile(hostIDPath) //nolint:gosec // hostIDPath is a fixed test temp path, not user input.
	if err != nil {
		t.Fatalf("host id was not persisted: %v", err)
	}
	// fallbackIDLength random bytes hex-encoded; guards against a low-entropy
	// pre-image that a dictionary attack could recover.
	if len(persisted) != fallbackIDLength*2 {
		t.Fatalf("persisted pre-image = %q, want %d hex characters of random entropy", persisted, fallbackIDLength*2)
	}
	if string(persisted) == report.Host.HostID {
		t.Fatal("the persisted value is the emitted HostID, want the id to be a digest of it")
	}
	sum := sha256.Sum256([]byte(hostIDNamespace + string(persisted)))
	if want := hex.EncodeToString(sum[:]); report.Host.HostID != want {
		t.Fatalf("HostID = %q, want the digest of the persisted pre-image %q", report.Host.HostID, want)
	}

	// The persisted value is reused rather than regenerated.
	again, err := Scan(opts)
	if err != nil {
		t.Fatalf("Scan() error = %v", err)
	}
	if again.Host.HostID != report.Host.HostID {
		t.Fatalf("HostID = %q then %q, want the persisted fallback to be reused", report.Host.HostID, again.Host.HostID)
	}
}

func alwaysMissing(string) (string, error) {
	return "", errors.New("not found")
}

func fixedMachineID(id string) func() string {
	return func() string { return id }
}

func tempHostIDPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "host-id")
}
