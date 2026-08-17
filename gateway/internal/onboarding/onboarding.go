// Package onboarding registers locally discovered agents with Zerker Gateway
// using privacy-safe, observe-only defaults.
package onboarding

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/zerkerlabs/gateway/gateway/internal/discovery"
)

const maxResponseBytes = 1 << 20

// Result summarizes an idempotent observe-only enrollment.
type Result struct {
	Added           []string `json:"added"`
	AlreadyEnrolled []string `json:"already_enrolled"`
}

// Today is the calm, inventory-wide activity view for the last 24 hours.
type Today struct {
	Schema  string       `json:"schema"`
	Agents  []AgentToday `json:"agents"`
	Quiet   []string     `json:"connected_without_activity"`
	Waiting []string     `json:"waiting_to_connect"`
}

// AgentToday contains useful outcome metadata without agent content.
type AgentToday struct {
	Name           string     `json:"name"`
	DiscoveryKey   string     `json:"discovery_key"`
	Sessions       int64      `json:"sessions"`
	ToolCalls      int64      `json:"tool_calls"`
	ToolsSucceeded int64      `json:"tools_succeeded"`
	ToolsFailed    int64      `json:"tools_failed"`
	DurationMS     int64      `json:"tool_duration_ms"`
	InputTokens    int64      `json:"input_tokens"`
	OutputTokens   int64      `json:"output_tokens"`
	CostUSD        float64    `json:"cost_usd"`
	CostKnown      bool       `json:"cost_known"`
	LastEventAt    *time.Time `json:"last_event_at,omitempty"`
}

// Status is a local environment's evidence-based Gateway connection view.
type Status struct {
	Schema    string        `json:"schema"`
	Gateway   string        `json:"gateway"`
	Mode      string        `json:"mode"`
	Agents    []AgentStatus `json:"agents"`
	Collected []string      `json:"collected"`
	Excluded  []string      `json:"excluded"`
	Observed  time.Time     `json:"observed_at"`
}

// AgentStatus avoids claiming a persistent connection. Reporting means the
// Gateway received an event recently; quiet means it has older evidence.
type AgentStatus struct {
	Name         string     `json:"name"`
	DiscoveryKey string     `json:"discovery_key"`
	Enrolled     bool       `json:"enrolled"`
	State        string     `json:"state"`
	LastEventAt  *time.Time `json:"last_event_at,omitempty"`
}

// Client enrolls discovered agents through the authenticated Gateway API.
type Client struct {
	baseURL    *url.URL
	token      string
	httpClient *http.Client
}

// NewClient validates the Gateway URL before accepting a bearer token. Plain
// HTTP is allowed only for loopback dogfood environments.
func NewClient(rawURL, token string, httpClient *http.Client) (*Client, error) {
	baseURL, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("parse gateway URL: %w", err)
	}
	if baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" {
		return nil, errors.New("gateway URL must not contain credentials, a query, or a fragment")
	}
	if baseURL.Scheme != "https" && (baseURL.Scheme != "http" || !isLoopbackHost(baseURL.Hostname())) {
		return nil, errors.New("gateway URL must use HTTPS; HTTP is allowed only on loopback")
	}
	if baseURL.Host == "" {
		return nil, errors.New("gateway URL must include a host")
	}
	if strings.TrimSpace(token) == "" {
		return nil, errors.New("gateway token is empty")
	}
	baseURL.Path = strings.TrimRight(baseURL.Path, "/")

	if httpClient == nil {
		httpClient = &http.Client{}
	}
	safeClient := *httpClient
	if safeClient.Timeout == 0 {
		safeClient.Timeout = 10 * time.Second
	}
	safeClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &Client{baseURL: baseURL, token: strings.TrimSpace(token), httpClient: &safeClient}, nil
}

// ObserveAll registers every discovered agent with internal, observe-only
// metadata. It lists first so reruns are safe and name conflicts fail before
// any create request is sent.
func (c *Client) ObserveAll(ctx context.Context, report discovery.Report) (Result, error) {
	existing, err := c.list(ctx)
	if err != nil {
		return Result{}, err
	}

	byKey := make(map[string]listedAgent, len(existing))
	byName := make(map[string]listedAgent, len(existing))
	for _, agent := range existing {
		byName[agent.Name] = agent
		if key, ok := agent.Metadata["zerker_discovery_key"].(string); ok {
			byKey[key] = agent
		}
	}

	result := Result{Added: []string{}, AlreadyEnrolled: []string{}}
	for _, found := range report.Agents {
		if _, ok := byKey[found.Key]; ok {
			result.AlreadyEnrolled = append(result.AlreadyEnrolled, found.Name)
			continue
		}
		if collision, ok := byName[found.Name]; ok {
			return Result{}, fmt.Errorf("agent %q already exists without discovery key (id %s); review it before importing", found.Name, collision.ID)
		}
	}

	for _, found := range report.Agents {
		if _, ok := byKey[found.Key]; ok {
			continue
		}
		if err := c.create(ctx, found); err != nil {
			return result, fmt.Errorf("observe %s: %w", found.Name, err)
		}
		result.Added = append(result.Added, found.Name)
	}
	return result, nil
}

// Today returns connected agent activity and keeps unconnected inventory in a
// single waiting count rather than presenting rows of zeroes.
func (c *Client) Today(ctx context.Context) (Today, error) {
	existing, err := c.list(ctx)
	if err != nil {
		return Today{}, err
	}
	sort.Slice(existing, func(i, j int) bool { return existing[i].Name < existing[j].Name })

	result := Today{Schema: "zerker.agent-today.v1", Agents: []AgentToday{}, Quiet: []string{}, Waiting: []string{}}
	for _, registered := range existing {
		key, ok := registered.Metadata["zerker_discovery_key"].(string)
		if !ok || key == "" {
			continue
		}
		summary, err := c.summary(ctx, registered.ID)
		if err != nil {
			return Today{}, fmt.Errorf("summarize %s: %w", registered.Name, err)
		}
		activity := AgentToday{
			Name:           registered.Name,
			DiscoveryKey:   key,
			Sessions:       summary.Sessions,
			ToolCalls:      summary.ToolCalls,
			ToolsSucceeded: summary.ToolsSucceeded,
			ToolsFailed:    summary.ToolsFailed,
			DurationMS:     summary.DurationMS,
			InputTokens:    summary.InputTokens,
			OutputTokens:   summary.OutputTokens,
			CostUSD:        summary.CostUSD,
			CostKnown:      summary.CostKnown,
			LastEventAt:    summary.LastEventAt,
		}
		if activity.Sessions == 0 && activity.ToolCalls == 0 && activity.InputTokens == 0 && activity.OutputTokens == 0 && activity.CostUSD == 0 {
			if activity.LastEventAt == nil {
				result.Waiting = append(result.Waiting, registered.Name)
			} else {
				result.Quiet = append(result.Quiet, registered.Name)
			}
			continue
		}
		result.Agents = append(result.Agents, activity)
	}
	return result, nil
}

// Status reports whether locally discovered agents are enrolled and whether
// Gateway has recent event evidence. It never treats enrollment as a live socket.
func (c *Client) Status(ctx context.Context, report discovery.Report, onlyKey string, now time.Time) (Status, error) {
	if now.IsZero() {
		now = time.Now()
	}
	now = now.UTC()
	existing, err := c.list(ctx)
	if err != nil {
		return Status{}, err
	}
	byKey := make(map[string]listedAgent, len(existing))
	for _, registered := range existing {
		if key, ok := registered.Metadata["zerker_discovery_key"].(string); ok && key != "" {
			byKey[key] = registered
		}
	}

	result := Status{
		Schema:    "zerker.agent-status.v1",
		Gateway:   c.baseURL.String(),
		Mode:      "observe",
		Agents:    []AgentStatus{},
		Collected: []string{"session lifecycle", "tool name and outcome", "duration", "model identity", "token counts", "reported cost"},
		Excluded:  []string{"prompts", "messages", "tool arguments", "tool outputs", "commands", "paths", "files", "environment values", "credentials"},
		Observed:  now,
	}
	foundFilter := onlyKey == ""
	for _, found := range report.Agents {
		if onlyKey != "" && found.Key != onlyKey {
			continue
		}
		foundFilter = true
		status := AgentStatus{Name: found.Name, DiscoveryKey: found.Key, State: "not_enrolled"}
		registered, ok := byKey[found.Key]
		if ok {
			status.Enrolled = true
			status.State = "no_recent_events"
			summary, summaryErr := c.summaryBetween(ctx, registered.ID, now.Add(-31*24*time.Hour), now)
			if summaryErr != nil {
				return Status{}, fmt.Errorf("summarize %s: %w", registered.Name, summaryErr)
			}
			status.LastEventAt = summary.LastEventAt
			if summary.LastEventAt != nil {
				status.State = "quiet"
				if !summary.LastEventAt.Before(now.Add(-5 * time.Minute)) {
					status.State = "reporting"
				}
			}
		}
		result.Agents = append(result.Agents, status)
	}
	if !foundFilter {
		return Status{}, fmt.Errorf("agent %q was not found in this environment", onlyKey)
	}
	sort.Slice(result.Agents, func(i, j int) bool { return result.Agents[i].Name < result.Agents[j].Name })
	return result, nil
}

type listResponse struct {
	Agents []listedAgent `json:"agents"`
}

type listedAgent struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	Metadata map[string]any `json:"metadata"`
}

func (c *Client) list(ctx context.Context) ([]listedAgent, error) {
	endpoint := c.resolve("/v1/agents?per_page=100")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("build list request: %w", err)
	}
	c.authorize(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("connect to gateway: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, responseError(resp)
	}

	var listed listResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes)).Decode(&listed); err != nil {
		return nil, fmt.Errorf("decode gateway agent list: %w", err)
	}
	return listed.Agents, nil
}

type summaryResponse struct {
	Summary struct {
		Sessions       int64      `json:"sessions"`
		ToolCalls      int64      `json:"tool_calls"`
		ToolsSucceeded int64      `json:"tools_succeeded"`
		ToolsFailed    int64      `json:"tools_failed"`
		DurationMS     int64      `json:"tool_duration_ms"`
		InputTokens    int64      `json:"input_tokens"`
		OutputTokens   int64      `json:"output_tokens"`
		CostUSD        float64    `json:"cost_usd"`
		CostKnown      bool       `json:"cost_known"`
		LastEventAt    *time.Time `json:"last_event_at"`
	} `json:"summary"`
}

func (c *Client) summary(ctx context.Context, agentID string) (AgentToday, error) {
	return c.summaryAt(ctx, "/v1/agent-events/summary?agent_id="+url.QueryEscape(agentID))
}

func (c *Client) summaryBetween(ctx context.Context, agentID string, since, until time.Time) (AgentToday, error) {
	query := url.Values{}
	query.Set("agent_id", agentID)
	query.Set("since", since.UTC().Format(time.RFC3339))
	query.Set("until", until.UTC().Format(time.RFC3339))
	return c.summaryAt(ctx, "/v1/agent-events/summary?"+query.Encode())
}

func (c *Client) summaryAt(ctx context.Context, path string) (AgentToday, error) {
	endpoint := c.resolve(path)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return AgentToday{}, fmt.Errorf("build summary request: %w", err)
	}
	c.authorize(req)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return AgentToday{}, fmt.Errorf("connect to gateway: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return AgentToday{}, responseError(resp)
	}
	var payload summaryResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes)).Decode(&payload); err != nil {
		return AgentToday{}, fmt.Errorf("decode gateway activity summary: %w", err)
	}
	return AgentToday{
		Sessions:       payload.Summary.Sessions,
		ToolCalls:      payload.Summary.ToolCalls,
		ToolsSucceeded: payload.Summary.ToolsSucceeded,
		ToolsFailed:    payload.Summary.ToolsFailed,
		DurationMS:     payload.Summary.DurationMS,
		InputTokens:    payload.Summary.InputTokens,
		OutputTokens:   payload.Summary.OutputTokens,
		CostUSD:        payload.Summary.CostUSD,
		CostKnown:      payload.Summary.CostKnown,
		LastEventAt:    payload.Summary.LastEventAt,
	}, nil
}

func (c *Client) create(ctx context.Context, found discovery.Agent) error {
	payload := map[string]any{
		"name":          found.Name,
		"description":   fmt.Sprintf("Local %s agent enrolled through Zerker discovery.", found.Name),
		"tags":          []string{"internal", "local", "observe-only"},
		"capture_body":  false,
		"emit_receipts": false,
		"protocol":      "http",
		"metadata": map[string]any{
			"zerker_discovery_key":    found.Key,
			"zerker_discovery_schema": discovery.Schema,
			"zerker_onboarding_mode":  "observe",
			"zerker_exposure":         "internal",
			"zerker_identity_status":  "discovered",
			"provider":                found.Provider,
			"installed":               found.Installed,
			"configured":              found.Configured,
			"mcp_server_count":        found.MCPServerCount,
		},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.resolve("/v1/agents"), bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	c.authorize(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("connect to gateway: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusCreated {
		return responseError(resp)
	}
	return nil
}

func (c *Client) authorize(req *http.Request) {
	req.Header.Set("Authorization", "Bearer "+c.token)
}

func (c *Client) resolve(path string) string {
	return strings.TrimRight(c.baseURL.String(), "/") + path
}

func responseError(resp *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	var envelope struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &envelope) == nil && envelope.Error != "" {
		return fmt.Errorf("gateway returned %s: %s", resp.Status, envelope.Error)
	}
	return fmt.Errorf("gateway returned %s", resp.Status)
}

func isLoopbackHost(host string) bool {
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
