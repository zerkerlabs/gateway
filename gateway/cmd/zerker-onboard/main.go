// Command zerker-onboard discovers supported local agents without changing
// their configuration. It is the read-only first step of Zerker onboarding.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/zerkerlabs/gateway/gateway/internal/discovery"
)

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr, func() (discovery.Report, error) {
		return discovery.Scan(discovery.Options{})
	}); err != nil {
		fmt.Fprintf(os.Stderr, "zerker-onboard: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer, scan func() (discovery.Report, error)) error {
	flags := flag.NewFlagSet("zerker-onboard", flag.ContinueOnError)
	flags.SetOutput(stderr)
	jsonOutput := flags.Bool("json", false, "print the stable machine-readable discovery report")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected arguments: %v", flags.Args())
	}

	report, err := scan()
	if err != nil {
		return fmt.Errorf("scan local agents: %w", err)
	}
	if *jsonOutput {
		encoder := json.NewEncoder(stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(report)
	}

	return printHuman(stdout, report)
}

func printHuman(output io.Writer, report discovery.Report) error {
	if len(report.Agents) == 0 {
		_, err := io.WriteString(output, "No supported agents found yet.\nNothing was changed. You can add a remote agent later.\n")
		return err
	}

	lines := []string{fmt.Sprintf("Found %d agents ready to review", len(report.Agents)), ""}
	for _, found := range report.Agents {
		state := "configured"
		if found.Installed {
			state = "ready"
		}
		line := fmt.Sprintf("  ✓ %s · %s", found.Name, state)
		if found.MCPServerCount > 0 {
			line += fmt.Sprintf(" · %d MCP servers", found.MCPServerCount)
		}
		lines = append(lines, line)
	}
	lines = append(lines, "", "Nothing was changed. Next, choose which agents Zerker should observe.")
	_, err := io.WriteString(output, strings.Join(lines, "\n")+"\n")
	return err
}
