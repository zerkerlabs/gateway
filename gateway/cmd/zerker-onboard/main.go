// Command zerker-onboard discovers supported local agents without changing
// their configuration. It is the read-only first step of Zerker onboarding.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/zerkerlabs/gateway/gateway/internal/discovery"
	"github.com/zerkerlabs/gateway/gateway/internal/onboarding"
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
	jsonOutput := flags.Bool("json", false, "print stable machine-readable output")
	observeAll := flags.Bool("observe-all", false, "enroll every discovered agent with internal observe-only defaults")
	gatewayURL := flags.String("gateway", "http://127.0.0.1:8080", "Zerker Gateway URL")
	tokenFile := flags.String("token-file", "/tmp/zerker-dev-token", "file containing the Gateway bearer token")
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
	if *observeAll {
		token, err := loadToken(*tokenFile)
		if err != nil {
			return err
		}
		client, err := onboarding.NewClient(*gatewayURL, token, nil)
		if err != nil {
			return err
		}
		result, err := client.ObserveAll(context.Background(), report)
		if err != nil {
			return err
		}
		if *jsonOutput {
			return printJSON(stdout, result)
		}
		return printObserved(stdout, result)
	}
	if *jsonOutput {
		return printJSON(stdout, report)
	}

	return printHuman(stdout, report)
}

func loadToken(tokenFile string) (string, error) {
	if token := strings.TrimSpace(os.Getenv("ZERKER_TOKEN")); token != "" {
		return token, nil
	}
	contents, err := os.ReadFile(tokenFile) //nolint:gosec // The operator explicitly selects the token file.
	if err != nil {
		return "", fmt.Errorf("read Gateway token from %s: %w", tokenFile, err)
	}
	if token := strings.TrimSpace(string(contents)); token != "" {
		return token, nil
	}
	return "", fmt.Errorf("gateway token file %s is empty", tokenFile)
}

func printJSON(output io.Writer, value any) error {
	encoder := json.NewEncoder(output)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func printObserved(output io.Writer, result onboarding.Result) error {
	lines := []string{}
	if len(result.Added) > 0 {
		lines = append(lines, fmt.Sprintf("Added %d agents to your internal inventory", len(result.Added)), "")
		for _, name := range result.Added {
			lines = append(lines, "  ✓ "+name)
		}
	}
	if len(result.AlreadyEnrolled) > 0 {
		if len(lines) > 0 {
			lines = append(lines, "")
		}
		lines = append(lines, fmt.Sprintf("Already enrolled: %d agents", len(result.AlreadyEnrolled)))
	}
	if len(lines) == 0 {
		lines = append(lines, "No agents were found to observe.")
	}
	lines = append(
		lines,
		"",
		"Safe defaults: internal only · no blocking · no body capture · no external exposure",
		"Next: connect each agent to begin measuring activity.",
	)
	_, err := io.WriteString(output, strings.Join(lines, "\n")+"\n")
	return err
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
