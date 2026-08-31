package discovery

import (
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

	report, err := Scan(Options{HomeDir: "/Users/private", FS: filesystem, LookPath: lookPath, HostIDPath: tempHostIDPath(t)})
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

	report, err := Scan(Options{HomeDir: "/unused", FS: fstest.MapFS{}, LookPath: alwaysMissing, HostIDPath: tempHostIDPath(t)})
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

	report, err := Scan(Options{HomeDir: "/unused", FS: fstest.MapFS{}, LookPath: alwaysMissing, Hostname: "alexs-macbook-pro.local", HostIDPath: tempHostIDPath(t)})
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

	report, err := Scan(Options{HomeDir: "/unused", FS: fstest.MapFS{}, LookPath: alwaysMissing, Hostname: "alexs-macbook-pro.local", IncludeHostname: true, HostIDPath: tempHostIDPath(t)})
	if err != nil {
		t.Fatalf("Scan() error = %v", err)
	}
	if report.Host.Hostname != "alexs-macbook-pro.local" {
		t.Fatalf("Hostname = %q, want the machine's hostname", report.Host.Hostname)
	}
}

func TestScanHostIDIsStableAcrossRunsAndIndependentOfHostname(t *testing.T) {
	t.Parallel()

	hostIDPath := tempHostIDPath(t)
	first, err := Scan(Options{HomeDir: "/unused", FS: fstest.MapFS{}, LookPath: alwaysMissing, Hostname: "build-runner-1", HostIDPath: hostIDPath})
	if err != nil {
		t.Fatalf("Scan() error = %v", err)
	}
	// A different hostname on the same machine (same persisted host id file)
	// must not change the id: the id is not derived from the hostname.
	second, err := Scan(Options{HomeDir: "/unused", FS: fstest.MapFS{}, LookPath: alwaysMissing, Hostname: "build-runner-2", HostIDPath: hostIDPath})
	if err != nil {
		t.Fatalf("Scan() error = %v", err)
	}
	if first.Host.HostID != second.Host.HostID {
		t.Fatalf("HostID = %q then %q, want the same machine to produce the same id regardless of hostname", first.Host.HostID, second.Host.HostID)
	}

	other, err := Scan(Options{HomeDir: "/unused", FS: fstest.MapFS{}, LookPath: alwaysMissing, Hostname: "build-runner-1", HostIDPath: tempHostIDPath(t)})
	if err != nil {
		t.Fatalf("Scan() error = %v", err)
	}
	if other.Host.HostID == first.Host.HostID {
		t.Fatal("HostID matched across two distinct machines, want distinct ids")
	}
}

func TestScanPersistsHostIDForReuseAndItIsHighEntropy(t *testing.T) {
	t.Parallel()

	hostIDPath := tempHostIDPath(t)
	if _, err := os.Stat(hostIDPath); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("host id file already exists before first scan: %v", err)
	}

	report, err := Scan(Options{HomeDir: "/unused", FS: fstest.MapFS{}, LookPath: alwaysMissing, HostIDPath: hostIDPath})
	if err != nil {
		t.Fatalf("Scan() error = %v", err)
	}
	persisted, err := os.ReadFile(hostIDPath) //nolint:gosec // hostIDPath is a fixed test temp path, not user input.
	if err != nil {
		t.Fatalf("host id was not persisted: %v", err)
	}
	if string(persisted) != report.Host.HostID {
		t.Fatalf("persisted host id = %q, want %q", persisted, report.Host.HostID)
	}
	// hostIDLength random bytes hex-encoded; guards against a low-entropy id
	// that a dictionary attack against plausible hostnames could recover.
	if len(report.Host.HostID) != hostIDLength*2 {
		t.Fatalf("HostID = %q, want %d hex characters of random entropy", report.Host.HostID, hostIDLength*2)
	}
}

func alwaysMissing(string) (string, error) {
	return "", errors.New("not found")
}

func tempHostIDPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "host-id")
}
