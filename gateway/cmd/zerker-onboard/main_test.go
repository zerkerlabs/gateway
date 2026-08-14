package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/zerkerlabs/gateway/gateway/internal/discovery"
)

func TestRunPrintsCalmHumanSummary(t *testing.T) {
	t.Parallel()

	var stdout bytes.Buffer
	err := run(nil, &stdout, &bytes.Buffer{}, func() (discovery.Report, error) {
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
	err := run([]string{"--json"}, &stdout, &bytes.Buffer{}, func() (discovery.Report, error) {
		return discovery.Report{Schema: discovery.Schema, Agents: []discovery.Agent{}}, nil
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
}

func TestRunFailsWhenScanFails(t *testing.T) {
	t.Parallel()

	err := run(nil, &bytes.Buffer{}, &bytes.Buffer{}, func() (discovery.Report, error) {
		return discovery.Report{}, errors.New("home unavailable")
	})
	if err == nil || !strings.Contains(err.Error(), "scan local agents: home unavailable") {
		t.Fatalf("run() error = %v", err)
	}
}
