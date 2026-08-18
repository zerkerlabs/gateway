// Command zerker provides the calm local operator surface for Zerker Gateway.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/zerkerlabs/gateway/gateway/internal/discovery"
	"github.com/zerkerlabs/gateway/gateway/internal/onboarding"
)

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr, time.Now, func() (discovery.Report, error) {
		return discovery.Scan(discovery.Options{})
	}); err != nil {
		fmt.Fprintf(os.Stderr, "zerker: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer, now func() time.Time, scan func() (discovery.Report, error)) error {
	if len(args) == 0 {
		return errors.New("choose a command: status")
	}
	switch args[0] {
	case "status":
		return runStatus(args[1:], stdout, stderr, now, scan)
	default:
		return fmt.Errorf("unknown command %q; choose: status", args[0])
	}
}

func runStatus(args []string, stdout, stderr io.Writer, now func() time.Time, scan func() (discovery.Report, error)) error {
	flags := flag.NewFlagSet("zerker status", flag.ContinueOnError)
	flags.SetOutput(stderr)
	jsonOutput := flags.Bool("json", false, "print stable machine-readable output")
	agentKey := flags.String("agent", "", "show one local agent by discovery key")
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
	token, err := loadToken(*tokenFile)
	if err != nil {
		return err
	}
	client, err := onboarding.NewClient(*gatewayURL, token, nil)
	if err != nil {
		return err
	}
	status, err := client.Status(context.Background(), report, strings.TrimSpace(*agentKey), now())
	if err != nil {
		return err
	}
	if *jsonOutput {
		encoder := json.NewEncoder(stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(status)
	}
	return printStatus(stdout, status)
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

func printStatus(output io.Writer, status onboarding.Status) error {
	lines := []string{"Zerker status", "", "Gateway", "  Connected · " + status.Gateway, "", "Agents"}
	if len(status.Agents) == 0 {
		lines = append(lines, "  No supported local agents found")
	}
	for _, agent := range status.Agents {
		state := strings.ReplaceAll(agent.State, "_", " ")
		line := fmt.Sprintf("  %s · %s", agent.Name, state)
		if agent.Enrolled {
			line = fmt.Sprintf("  %s · enrolled · %s", agent.Name, state)
		}
		if agent.LastEventAt != nil {
			line += " · last event " + relativeTime(status.Observed, *agent.LastEventAt)
		}
		lines = append(lines, line)
	}
	lines = append(
		lines,
		"",
		"Mode",
		"  Observe · no blocking · internal only",
		"",
		"Collected",
		"  "+strings.Join(status.Collected, " · "),
		"",
		"Never collected",
		"  "+strings.Join(status.Excluded, " · "),
	)
	_, err := io.WriteString(output, strings.Join(lines, "\n")+"\n")
	return err
}

func relativeTime(now, event time.Time) string {
	age := now.Sub(event)
	if age < 0 {
		age = 0
	}
	switch {
	case age < time.Minute:
		return "just now"
	case age < time.Hour:
		return fmt.Sprintf("%dm ago", int(age.Minutes()))
	case age < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(age.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(age.Hours()/24))
	}
}
