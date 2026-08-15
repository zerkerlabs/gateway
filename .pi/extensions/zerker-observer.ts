import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const SCHEMA = "zerker.agent-event.v1";
const SOURCE_VERSION = "0.1.0";
const DEFAULT_GATEWAY = "http://127.0.0.1:8080";
const DEFAULT_TOKEN_FILE = "/tmp/zerker-dev-token";

type EventType = "session.started" | "session.ended" | "tool.completed" | "model.usage";
type Outcome = "succeeded" | "failed" | "cancelled";

type EventFields = {
  tool_name?: string;
  outcome?: Outcome;
  duration_ms?: number;
  provider?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost_usd?: number;
};

type GatewayAgent = {
  id: string;
  metadata?: { zerker_discovery_key?: unknown };
};

type ActivitySummary = {
  sessions: number;
  tool_calls: number;
  tools_succeeded: number;
  tools_failed: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  cost_known: boolean;
};

function sessionDigest(sessionId: string): string {
  return `sha256:${createHash("sha256").update(sessionId).digest("hex")}`;
}

function deterministicEventId(sessionRef: string, suffix: string): string {
  return `pi:${createHash("sha256").update(`${sessionRef}:${suffix}`).digest("hex")}`;
}

function safeGatewayURL(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    const numericLoopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && numericLoopback)) return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

async function loadToken(): Promise<string | undefined> {
  const fromEnvironment = process.env.ZERKER_TOKEN?.trim();
  if (fromEnvironment) return fromEnvironment;
  try {
    const token = (await readFile(process.env.ZERKER_TOKEN_FILE ?? DEFAULT_TOKEN_FILE, "utf8")).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

export default function zerkerObserver(pi: ExtensionAPI) {
  let gatewayURL: string | undefined;
  let token: string | undefined;
  let agentId: string | undefined;
  let sessionRef: string | undefined;
  let connected = false;
  let recorded = 0;
  let failed = 0;
  const toolStarts = new Map<string, number>();
  const pending = new Set<Promise<void>>();

  function track(work: Promise<void>): void {
    pending.add(work);
    void work.finally(() => pending.delete(work));
  }

  async function request(path: string, init: RequestInit): Promise<Response> {
    if (!gatewayURL || !token) throw new Error("Zerker is not configured");
    const send = (bearer: string) => fetch(`${gatewayURL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    let response = await send(token);
    if (response.status === 401) {
      const refreshed = await loadToken();
      if (refreshed && refreshed !== token) {
        token = refreshed;
        response = await send(token);
      }
    }
    return response;
  }

  async function resolveAgent(): Promise<boolean> {
    const response = await request("/v1/agents?per_page=100", { method: "GET" });
    if (!response.ok) return false;
    const payload = (await response.json()) as { agents?: GatewayAgent[] };
    const piAgent = payload.agents?.find(
      (agent) => agent.metadata?.zerker_discovery_key === "pi",
    );
    agentId = piAgent?.id;
    return Boolean(agentId);
  }

  async function fetchToday(): Promise<ActivitySummary> {
    if (!agentId && !(await resolveAgent())) throw new Error("Pi is not enrolled");
    const response = await request(`/v1/agent-events/summary?agent_id=${encodeURIComponent(agentId!)}`, {
      method: "GET",
    });
    if (!response.ok) throw new Error(`Gateway returned ${response.status}`);
    const payload = (await response.json()) as { summary: ActivitySummary };
    return payload.summary;
  }

  async function emit(type: EventType, fields: EventFields = {}, eventId = randomUUID()): Promise<void> {
    if (!agentId || !sessionRef) return;
    try {
      const response = await request("/v1/agent-events", {
        method: "POST",
        body: JSON.stringify({
          schema: SCHEMA,
          event_id: eventId,
          agent_id: agentId,
          type,
          session_ref: sessionRef,
          occurred_at: new Date().toISOString(),
          source: "pi",
          source_version: SOURCE_VERSION,
          ...fields,
        }),
      });
      if (!response.ok) throw new Error(`Gateway returned ${response.status}`);
      connected = true;
      recorded += 1;
    } catch {
      connected = false;
      failed += 1;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    gatewayURL = safeGatewayURL(process.env.ZERKER_GATEWAY_URL ?? DEFAULT_GATEWAY);
    token = await loadToken();
    sessionRef = sessionDigest(ctx.sessionManager.getSessionId());
    if (!gatewayURL || !token) {
      ctx.ui.setStatus("zerker", "Zerker · setup needed");
      return;
    }
    try {
      if (!(await resolveAgent())) {
        ctx.ui.setStatus("zerker", "Zerker · Pi not enrolled");
        return;
      }
      await emit("session.started", {}, deterministicEventId(sessionRef, "session.started"));
      ctx.ui.setStatus("zerker", connected ? "Zerker · measuring" : "Zerker · offline");
    } catch {
      failed += 1;
      ctx.ui.setStatus("zerker", "Zerker · offline");
    }
  });

  pi.on("tool_execution_start", (event) => {
    toolStarts.set(event.toolCallId, Date.now());
  });

  pi.on("tool_execution_end", (event) => {
    const startedAt = toolStarts.get(event.toolCallId);
    toolStarts.delete(event.toolCallId);
    const outcome: Outcome = event.isError ? "failed" : "succeeded";
    track(emit("tool.completed", {
      tool_name: event.toolName,
      outcome,
      duration_ms: Math.max(0, Date.now() - (startedAt ?? Date.now())),
    }, deterministicEventId(sessionRef ?? "", `tool:${event.toolCallId}`)));
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const usage = event.message.usage;
    track(emit("model.usage", {
      provider: event.message.provider,
      model: event.message.model,
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_read_tokens: usage.cacheRead,
      cache_write_tokens: usage.cacheWrite,
      cost_usd: usage.cost.total,
    }));
  });

  pi.on("session_shutdown", async () => {
    if (sessionRef) {
      await emit("session.ended", {}, deterministicEventId(sessionRef, "session.ended"));
    }
    await Promise.allSettled([...pending]);
    toolStarts.clear();
  });

  pi.registerCommand("zerker-today", {
    description: "Show today's calm Pi activity summary",
    handler: async (_args, ctx) => {
      try {
        const summary = await fetchToday();
        const tokens = summary.input_tokens + summary.output_tokens;
        const cost = summary.cost_known ? `$${summary.cost_usd.toFixed(6)}` : "cost unavailable";
        ctx.ui.notify(
          `Pi today · ${summary.sessions} sessions · ${summary.tool_calls} tools · ${summary.tools_failed} failed · ${tokens} tokens · ${cost}`,
          summary.tools_failed > 0 ? "warning" : "info",
        );
      } catch {
        ctx.ui.notify("Zerker summary unavailable. Your agent can keep working.", "warning");
      }
    },
  });

  pi.registerCommand("zerker-status", {
    description: "Show privacy-safe Zerker measurement status",
    handler: async (_args, ctx) => {
      const state = connected ? "measuring" : gatewayURL && token ? "offline" : "setup needed";
      ctx.ui.notify(`Zerker: ${state} · ${recorded} events recorded · ${failed} failed`, connected ? "info" : "warning");
    },
  });
}
