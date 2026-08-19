package discovery

import (
	"errors"
	"io/fs"
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

	report, err := Scan(Options{HomeDir: "/Users/private", FS: filesystem, LookPath: lookPath})
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
		LookPath: alwaysMissing,
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

	report, err := Scan(Options{HomeDir: "/unused", FS: fstest.MapFS{}, LookPath: alwaysMissing})
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

func alwaysMissing(string) (string, error) {
	return "", errors.New("not found")
}
