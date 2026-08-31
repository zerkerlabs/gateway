package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zerkerlabs/gateway/gateway/internal/discovery"
	"github.com/zerkerlabs/gateway/gateway/internal/onboarding"
)

func TestRunPrintsCalmHumanSummary(t *testing.T) {
	t.Parallel()

	var stdout bytes.Buffer
	err := run(nil, &stdout, &bytes.Buffer{}, func(bool) (discovery.Report, error) {
		return discovery.Report{Schema: discovery.Schema, Agents: []discovery.Agent{
			{Name: "Claude Code", Installed: true, Configured: true, MCPServerCount: 3},
			{Name: "Codex", Configured: true},
		}}, nil
	})
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}

	output := stdout.String()
	for _, want := range []string{
		"Found 2 agents ready to review",
		"Claude Code · ready · 3 MCP servers",
		"Codex · configured",
		"Nothing was changed",
		"choose which agents Zerker should observe",
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("output missing %q:\n%s", want, output)
		}
	}
}

func TestRunPrintsStableJSON(t *testing.T) {
	t.Parallel()

	var stdout bytes.Buffer
	err := run([]string{"--json"}, &stdout, &bytes.Buffer{}, func(includeHostname bool) (discovery.Report, error) {
		if includeHostname {
			t.Fatal("scan() received includeHostname = true, want false by default")
		}
		return discovery.Report{Schema: discovery.Schema, Host: discovery.Host{HostID: "abc123"}, Agents: []discovery.Agent{}}, nil
	})
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if got, want := stdout.String(), "\"schema\": \"zerker.agent-discovery.v1\""; !strings.Contains(got, want) {
		t.Fatalf("JSON output missing %q:\n%s", want, got)
	}
	if !strings.Contains(stdout.String(), `"agents": []`) {
		t.Fatalf("JSON output must preserve empty agents array:\n%s", stdout.String())
	}
	if !strings.Contains(stdout.String(), `"host_id": "abc123"`) {
		t.Fatalf("JSON output must include the host block:\n%s", stdout.String())
	}
	if strings.Contains(stdout.String(), "hostname") {
		t.Fatalf("JSON output must omit hostname by default:\n%s", stdout.String())
	}
}

func TestRunPassesIncludeHostnameFlagToScan(t *testing.T) {
	t.Parallel()

	var stdout bytes.Buffer
	err := run([]string{"--json", "--include-hostname"}, &stdout, &bytes.Buffer{}, func(includeHostname bool) (discovery.Report, error) {
		if !includeHostname {
			t.Fatal("scan() received includeHostname = false, want true")
		}
		return discovery.Report{Schema: discovery.Schema, Host: discovery.Host{HostID: "abc123", Hostname: "alexs-macbook-pro.local"}, Agents: []discovery.Agent{}}, nil
	})
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if !strings.Contains(stdout.String(), `"hostname": "alexs-macbook-pro.local"`) {
		t.Fatalf("JSON output missing hostname:\n%s", stdout.String())
	}
}

func TestPrintTodayLeadsWithUsefulActivity(t *testing.T) {
	t.Parallel()

	var output bytes.Buffer
	err := printToday(&output, onboarding.Today{
		Schema: "zerker.agent-today.v1",
		Agents: []onboarding.AgentToday{{
			Name: "Pi", Sessions: 2, ToolCalls: 5, ToolsFailed: 1,
			InputTokens: 100, OutputTokens: 20, CostUSD: 0.25, CostKnown: true,
		}},
		Waiting: []string{"Claude Code", "Hermes"},
	})
	if err != nil {
		t.Fatalf("printToday() error = %v", err)
	}
	for _, want := range []string{
		"Your agents today", "Pi", "2 sessions · 5 tool calls · 1 failed",
		"120 tokens · $0.250000", "2 agents waiting to connect",
	} {
		if !strings.Contains(output.String(), want) {
			t.Fatalf("output missing %q:\n%s", want, output.String())
		}
	}
}

func TestLoadTokenTrimsTokenFile(t *testing.T) {
	t.Setenv("ZERKER_TOKEN", "")
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("  private-token\n"), 0o600); err != nil {
		t.Fatalf("write token: %v", err)
	}

	token, err := loadToken(tokenFile)
	if err != nil {
		t.Fatalf("loadToken() error = %v", err)
	}
	if token != "private-token" {
		t.Fatalf("token = %q, want trimmed value", token)
	}
}

func TestRunFailsWhenScanFails(t *testing.T) {
	t.Parallel()

	err := run(nil, &bytes.Buffer{}, &bytes.Buffer{}, func(bool) (discovery.Report, error) {
		return discovery.Report{}, errors.New("home unavailable")
	})
	if err == nil || !strings.Contains(err.Error(), "scan local agents: home unavailable") {
		t.Fatalf("run() error = %v", err)
	}
}
