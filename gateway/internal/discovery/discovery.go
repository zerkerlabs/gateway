// Package discovery finds supported agent tools on the local machine without
// reading agent conversations, credentials, prompts, or command arguments.
package discovery

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// Schema identifies the stable machine-readable discovery contract.
const Schema = "zerker.agent-discovery.v1"

// Evidence describes one non-sensitive signal that an agent is available.
type Evidence struct {
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
}

// Agent is a supported local agent found by Scan.
type Agent struct {
	Key            string     `json:"key"`
	Name           string     `json:"name"`
	Provider       string     `json:"provider"`
	Installed      bool       `json:"installed"`
	Configured     bool       `json:"configured"`
	MCPServerCount int        `json:"mcp_server_count"`
	Evidence       []Evidence `json:"evidence"`
}

// Host identifies the machine a scan ran on. HostID is always present;
// Hostname is populated only when the operator explicitly opts in, since a
// hostname often names a person (e.g. "alexs-macbook-pro.local").
type Host struct {
	HostID   string `json:"host_id"`
	Hostname string `json:"hostname,omitempty"`
}

// Report is the stable machine-readable result of a local scan.
type Report struct {
	Schema string  `json:"schema"`
	Host   Host    `json:"host"`
	Agents []Agent `json:"agents"`
}

// Options provides the operating-system seams used by Scan. Zero values use
// the real user's home directory, executable path, filesystem, hostname, and
// persisted host id location.
type Options struct {
	HomeDir  string
	LookPath func(string) (string, error)
	FS       fs.FS

	// Hostname overrides the machine hostname included in the report when
	// IncludeHostname is set. Tests set this for determinism; production
	// leaves it empty to use os.Hostname().
	Hostname string

	// IncludeHostname includes the readable hostname in the report. It is
	// false by default because a hostname is personal information.
	IncludeHostname bool

	// HostIDPath overrides where the persisted per-machine identifier is
	// stored. Tests set this for isolation; production leaves it empty to
	// use "<HomeDir>/.zerker/host-id".
	HostIDPath string
}

type candidate struct {
	key       string
	name      string
	provider  string
	commands  []string
	locations []string
	mcpFiles  []string
}

var supported = []candidate{
	{key: "claude-code", name: "Claude Code", provider: "Anthropic", commands: []string{"claude"}, locations: []string{".claude"}, mcpFiles: []string{".claude.json"}},
	{key: "codex", name: "Codex", provider: "OpenAI", commands: []string{"codex"}, locations: []string{".codex"}},
	{key: "cursor", name: "Cursor", provider: "Cursor", commands: []string{"cursor"}, locations: []string{".cursor"}, mcpFiles: []string{".cursor/mcp.json"}},
	{key: "gemini-cli", name: "Gemini CLI", provider: "Google", commands: []string{"gemini"}, locations: []string{".gemini"}, mcpFiles: []string{".gemini/settings.json"}},
	{key: "hermes", name: "Hermes", provider: "Nous Research", commands: []string{"hermes"}, locations: []string{".hermes"}},
	{key: "pi", name: "Pi", provider: "Pi", commands: []string{"pi"}, locations: []string{".pi/agent", ".pi"}},
	{key: "aider", name: "Aider", provider: "Aider", commands: []string{"aider"}, locations: []string{".aider.conf.yml"}},
	{key: "opencode", name: "OpenCode", provider: "OpenCode", commands: []string{"opencode"}, locations: []string{".config/opencode"}, mcpFiles: []string{".config/opencode/opencode.json"}},
}

// Scan finds supported agents using only executable presence, known config
// locations, and MCP server counts. It never returns absolute paths.
func Scan(opts Options) (Report, error) {
	home := opts.HomeDir
	if home == "" {
		var err error
		home, err = os.UserHomeDir()
		if err != nil {
			return Report{}, fmt.Errorf("resolve home directory: %w", err)
		}
	}

	lookPath := opts.LookPath
	if lookPath == nil {
		lookPath = exec.LookPath
	}

	filesystem := opts.FS
	if filesystem == nil {
		filesystem = os.DirFS(home)
	}

	hostIDPath := opts.HostIDPath
	if hostIDPath == "" {
		hostIDPath = filepath.Join(home, ".zerker", "host-id")
	}
	hostID, err := loadOrCreateHostID(hostIDPath)
	if err != nil {
		return Report{}, fmt.Errorf("resolve host id: %w", err)
	}
	host := Host{HostID: hostID}
	if opts.IncludeHostname {
		hostname := opts.Hostname
		if hostname == "" {
			hostname, err = os.Hostname()
			if err != nil {
				return Report{}, fmt.Errorf("resolve hostname: %w", err)
			}
		}
		host.Hostname = hostname
	}

	report := Report{Schema: Schema, Host: host, Agents: []Agent{}}
	for _, known := range supported {
		found := Agent{
			Key:      known.key,
			Name:     known.name,
			Provider: known.provider,
			Evidence: []Evidence{},
		}

		for _, command := range known.commands {
			if _, err := lookPath(command); err == nil {
				found.Installed = true
				found.Evidence = append(found.Evidence, Evidence{Kind: "executable", Detail: command + " command available"})
				break
			}
		}

		for _, location := range known.locations {
			if _, err := fs.Stat(filesystem, filepath.ToSlash(location)); err == nil {
				found.Configured = true
				found.Evidence = append(found.Evidence, Evidence{Kind: "configuration", Detail: "~/" + filepath.ToSlash(location)})
			}
		}

		for _, mcpFile := range known.mcpFiles {
			count, err := countMCPServers(filesystem, filepath.ToSlash(mcpFile))
			if err != nil && !errors.Is(err, fs.ErrNotExist) {
				// A malformed or unreadable optional config is not a failed scan.
				continue
			}
			found.MCPServerCount += count
		}
		if found.MCPServerCount > 0 {
			found.Evidence = append(found.Evidence, Evidence{
				Kind:   "mcp",
				Detail: fmt.Sprintf("%d MCP servers configured", found.MCPServerCount),
			})
		}

		if found.Installed || found.Configured {
			report.Agents = append(report.Agents, found)
		}
	}

	sort.Slice(report.Agents, func(i, j int) bool {
		return report.Agents[i].Name < report.Agents[j].Name
	})
	return report, nil
}

const hostIDLength = 32 // bytes of random identifier, hex-encoded on disk

// loadOrCreateHostID returns the persistent, randomly generated identifier
// stored at path, creating it on first use. Unlike a hash of the hostname,
// a random id carries no information about the machine it names: it cannot
// be recovered by hashing a dictionary of plausible hostnames.
func loadOrCreateHostID(path string) (string, error) {
	if existing, err := os.ReadFile(path); err == nil { //nolint:gosec // path is a fixed, non-user-controlled location under the home directory.
		if id := strings.TrimSpace(string(existing)); id != "" {
			return id, nil
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("read host id: %w", err)
	}

	raw := make([]byte, hostIDLength)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate host id: %w", err)
	}
	id := hex.EncodeToString(raw)

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", fmt.Errorf("create host id directory: %w", err)
	}
	if err := os.WriteFile(path, []byte(id), 0o600); err != nil {
		return "", fmt.Errorf("write host id: %w", err)
	}
	return id, nil
}

func countMCPServers(filesystem fs.FS, name string) (int, error) {
	info, err := fs.Stat(filesystem, name)
	if err != nil {
		return 0, err
	}
	if !info.Mode().IsRegular() || info.Size() > 2<<20 {
		return 0, fmt.Errorf("MCP config is not a regular file within the size limit")
	}

	file, err := filesystem.Open(name)
	if err != nil {
		return 0, err
	}
	var config struct {
		MCPServers map[string]json.RawMessage `json:"mcpServers"`
	}
	decoder := json.NewDecoder(io.LimitReader(file, 2<<20))
	decodeErr := decoder.Decode(&config)
	closeErr := file.Close()
	if decodeErr != nil {
		return 0, decodeErr
	}
	if closeErr != nil {
		return 0, closeErr
	}
	return len(config.MCPServers), nil
}
