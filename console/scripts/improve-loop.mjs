#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const consoleDir = resolve(scriptDir, "..");
const repoRoot = resolve(consoleDir, "..");
const loopDir = resolve(consoleDir, ".loop");
const statePath = resolve(loopDir, "state.json");
const lockPath = resolve(loopDir, "lock.json");
const nextTaskPath = resolve(loopDir, "next-task.md");
const cycleReportPath = resolve(loopDir, "cycle-report.md");
const eventLogPath = resolve(loopDir, "events.jsonl");
const transcriptPath = resolve(loopDir, "transcript.log");
const verifyLogPath = resolve(loopDir, "verify.log");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const maxCycles = positiveInteger(value("--cycles", process.env.ZERKER_LOOP_CYCLES ?? "6"), "cycles");
const maxMinutes = positiveInteger(value("--minutes", process.env.ZERKER_LOOP_MINUTES ?? "240"), "minutes");
const repairLimit = positiveInteger(value("--repairs", process.env.ZERKER_LOOP_REPAIRS ?? "2"), "repairs");
const maxCostUsd = positiveNumber(value("--max-cost", process.env.ZERKER_LOOP_MAX_COST ?? "25"), "max-cost");
const model = value("--model", process.env.ZERKER_LOOP_MODEL ?? "gpt-5.6-sol");
const thinking = value("--thinking", process.env.ZERKER_LOOP_THINKING ?? "high");

mkdirSync(loopDir, { recursive: true });

if (flag("--status")) {
  printStatus();
  process.exit(0);
}
if (flag("--stop")) {
  stopLoop();
  process.exit(0);
}
if (flag("--self-test")) {
  await selfTest();
  process.exit(0);
}
if (flag("--dry-run")) {
  validateSetup();
  console.log(JSON.stringify({ ok: true, repoRoot, consoleDir, model, thinking, maxCycles, maxMinutes, repairLimit, maxCostUsd }, null, 2));
  process.exit(0);
}

validateSetup();
assertCleanStart();
acquireLock();

const startedAt = Date.now();
const deadline = startedAt + maxMinutes * 60_000;
const protectedFiles = ["PRODUCT_GOAL.md", "UX_RUBRIC.md", "scripts/improve-loop.mjs"];
const protectedDigests = new Map(protectedFiles.map((path) => [path, digest(resolve(consoleDir, path))]));
const transcript = createWriteStream(transcriptPath, { flags: "a" });
const events = createWriteStream(eventLogPath, { flags: "a" });
let child;
let currentStage = "starting";
let currentCycle = 0;
let stopped = false;
let state = {
  status: "starting",
  pid: process.pid,
  started_at: new Date(startedAt).toISOString(),
  deadline_at: new Date(deadline).toISOString(),
  max_cycles: maxCycles,
  max_minutes: maxMinutes,
  repair_limit: repairLimit,
  max_cost_usd: maxCostUsd,
  reported_cost_usd: 0,
  model,
  thinking,
  cycle: 0,
  stage: currentStage,
  checkpoints: [],
  last_error: null,
};
writeState();
registerSignalHandlers();

try {
  child = startPi();
  state.status = "running";
  writeState();

  for (currentCycle = 1; currentCycle <= maxCycles; currentCycle += 1) {
    ensureTime("cycle start");
    state.cycle = currentCycle;

    await runStage("plan", plannerPrompt(currentCycle), 30);
    const task = readFileSync(nextTaskPath, "utf8");
    if (/^STOP:/m.test(task)) {
      state.status = "completed";
      state.stage = "no-safe-work";
      writeState();
      break;
    }

    await runStage("build", builderPrompt(currentCycle), 50);
    ensureScopedChanges();

    let verified = runVerification(currentCycle, "build");
    let repairs = 0;
    while (!verified && repairs < repairLimit) {
      repairs += 1;
      await runStage(`repair-${repairs}`, repairPrompt(currentCycle, repairs), 35);
      ensureScopedChanges();
      verified = runVerification(currentCycle, `repair-${repairs}`);
    }
    if (!verified) throw new Error(`verification failed after ${repairLimit} repairs in cycle ${currentCycle}`);

    await runStage("review", reviewPrompt(currentCycle), 50);
    ensureScopedChanges();
    if (!runVerification(currentCycle, "review")) throw new Error(`post-review verification failed in cycle ${currentCycle}`);

    const checkpoint = checkpointCycle(currentCycle);
    state.checkpoints.push(checkpoint);
    state.stage = "checkpointed";
    writeState();
  }

  if (state.status === "running") state.status = currentCycle > maxCycles ? "cycle-limit" : "completed";
} catch (error) {
  state.status = stopped ? "stopped" : "failed";
  state.last_error = error instanceof Error ? error.message : String(error);
  log(`ERROR ${state.last_error}`);
} finally {
  state.stage = "settled";
  state.finished_at = new Date().toISOString();
  writeState();
  if (child && !child.killed) child.kill("SIGTERM");
  transcript.end();
  events.end();
  rmSync(lockPath, { force: true });
}

process.exitCode = state.status === "failed" ? 1 : 0;

function positiveInteger(raw, label) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`--${label} must be a positive integer`);
  return parsed;
}
function positiveNumber(raw, label) {
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${label} must be a positive number`);
  return parsed;
}

function validateSetup() {
  for (const file of ["PRODUCT_GOAL.md", "BACKLOG.md", "UX_RUBRIC.md", "package.json"]) {
    if (!existsSync(resolve(consoleDir, file))) throw new Error(`missing console/${file}`);
  }
  const pi = spawnSync("pi", ["--version"], { cwd: repoRoot, encoding: "utf8" });
  if (pi.status !== 0) throw new Error(`pi is unavailable: ${pi.stderr || pi.stdout}`);
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: repoRoot, encoding: "utf8" });
  if (git.status !== 0 || git.stdout.trim() !== repoRoot) throw new Error("runner must execute inside the Gateway console worktree");
}

function assertCleanStart() {
  const status = git(["status", "--porcelain"]);
  if (status.trim()) throw new Error("worktree must be clean before starting the improvement loop");
}

function acquireLock() {
  if (existsSync(lockPath)) {
    try {
      const existing = JSON.parse(readFileSync(lockPath, "utf8"));
      if (existing.pid && processIsAlive(existing.pid)) throw new Error(`loop already running with pid ${existing.pid}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("loop already")) throw error;
    }
    rmSync(lockPath, { force: true });
  }
  const descriptor = openSync(lockPath, "wx");
  writeFileSync(descriptor, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }, null, 2));
  closeSync(descriptor);
}

function startPi() {
  const piArgs = ["--mode", "rpc", "--approve", "--name", "Gateway console improvement loop", "--model", model, "--thinking", thinking];
  const processHandle = spawn("pi", piArgs, { cwd: repoRoot, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  processHandle.stderr.on("data", (chunk) => transcript.write(`[pi stderr] ${chunk}`));
  processHandle.on("exit", (code, signal) => {
    log(`pi exited code=${code} signal=${signal}`);
    if (!stopped && state.status === "running") {
      const error = new Error(`pi exited unexpectedly (${code ?? signal})`);
      state.last_error = error.message;
      settleStageError(error);
    }
  });
  attachJsonLines(processHandle.stdout, onPiEvent);
  return processHandle;
}

let stageResolve;
let stageReject;
let stageTimer;
let stageRequestId;

function onPiEvent(event) {
  events.write(`${JSON.stringify({ at: new Date().toISOString(), cycle: currentCycle, stage: currentStage, event: safeEvent(event) })}\n`);
  recordReportedCost(event);
  if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method)) {
    send({ type: "extension_ui_response", id: event.id, cancelled: true });
  }
  if (event.type === "response" && event.id === stageRequestId && !event.success) {
    settleStageError(new Error(`prompt rejected: ${event.error ?? "unknown error"}`));
  }
  if (event.type === "agent_settled" && stageResolve) {
    const resolveStage = stageResolve;
    clearStageWait();
    resolveStage();
  }
}

async function runStage(name, prompt, maximumMinutes) {
  ensureTime(name);
  currentStage = name;
  state.stage = name;
  writeState();
  log(`cycle=${currentCycle} stage=${name} started`);
  const timeoutMs = Math.min(maximumMinutes * 60_000, deadline - Date.now());
  if (timeoutMs <= 0) throw new Error(`runtime deadline reached before ${name}`);
  stageRequestId = `cycle-${currentCycle}-${name}-${Date.now()}`;
  const wait = new Promise((resolveStage, rejectStage) => {
    stageResolve = resolveStage;
    stageReject = rejectStage;
    stageTimer = setTimeout(() => {
      send({ type: "abort" });
      settleStageError(new Error(`stage ${name} exceeded ${Math.round(timeoutMs / 60_000)} minutes`));
    }, timeoutMs);
  });
  send({ id: stageRequestId, type: "prompt", message: prompt });
  await wait;
  ensureBudget(name);
  log(`cycle=${currentCycle} stage=${name} settled`);
}

function settleStageError(error) {
  if (!stageReject) return;
  const rejectStage = stageReject;
  clearStageWait();
  rejectStage(error);
}
function clearStageWait() {
  clearTimeout(stageTimer);
  stageResolve = undefined;
  stageReject = undefined;
  stageTimer = undefined;
  stageRequestId = undefined;
}
function send(command) {
  if (!child || !child.stdin.writable) throw new Error("pi RPC stdin is unavailable");
  child.stdin.write(`${JSON.stringify(command)}\n`);
}

function runVerification(cycle, phase) {
  state.stage = `verify-${phase}`;
  writeState();
  log(`cycle=${cycle} verify=${phase} started`);
  const result = spawnSync("npm", ["run", "check"], { cwd: consoleDir, encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024 });
  writeFileSync(verifyLogPath, `# cycle ${cycle} ${phase} ${new Date().toISOString()}\n${result.stdout ?? ""}\n${result.stderr ?? ""}\n`, { flag: "a" });
  const passed = result.status === 0;
  log(`cycle=${cycle} verify=${phase} passed=${passed}`);
  return passed;
}

function ensureScopedChanges() {
  assertProtectedFiles();
  const output = git(["status", "--porcelain", "-z"]);
  const entries = output.split("\0").filter(Boolean);
  const outside = entries.map((entry) => entry.slice(3)).filter((path) => path && !path.startsWith("console/"));
  if (outside.length) throw new Error(`out-of-scope changes detected: ${outside.join(", ")}`);
}

function checkpointCycle(cycle) {
  ensureScopedChanges();
  const changed = git(["status", "--porcelain"]);
  if (!changed.trim()) throw new Error(`cycle ${cycle} produced no checkpointable changes`);
  git(["add", "--", "console"]);
  const commit = spawnSync("git", ["commit", "-m", `chore(console): improvement cycle ${cycle}`], { cwd: repoRoot, encoding: "utf8", timeout: 60_000 });
  if (commit.status !== 0) throw new Error(`checkpoint commit failed: ${commit.stderr || commit.stdout}`);
  const sha = git(["rev-parse", "--short", "HEAD"]).trim();
  log(`cycle=${cycle} checkpoint=${sha}`);
  return { cycle, sha, at: new Date().toISOString() };
}

function plannerPrompt(cycle) {
  return `You are the PLANNER node for bounded Gateway console improvement cycle ${cycle} of ${maxCycles}.

Read console/PRODUCT_GOAL.md, console/BACKLOG.md, console/UX_RUBRIC.md, the current console implementation, and recent git history. Select exactly one highest-priority unchecked item from the Safe campaign. Do not edit tracked product files in this stage.

Write console/.loop/next-task.md with:
- backlog ID and title;
- user-visible outcome;
- exact acceptance checks;
- likely files;
- safety and honesty risks;
- browser QA path.

If no safe unchecked item remains, write a single first line: STOP: safe campaign complete.

Do not ask the user questions. Do not commit, push, merge, deploy, install global software, access production, or leave console/.`;
}

function builderPrompt(cycle) {
  return `You are the BUILDER node for bounded Gateway console improvement cycle ${cycle}.

Read console/PRODUCT_GOAL.md, console/UX_RUBRIC.md, console/BACKLOG.md, and console/.loop/next-task.md. Implement exactly that vertical slice inside console/.

Requirements:
- logged-in operational UX, not marketing;
- no live or production calls;
- no credentials or browser token storage;
- fixtures remain unmistakable;
- delivery states remain honest;
- deterministic logic gets node:test coverage;
- preserve the team-preview grid, black type, and purple signal language;
- do not implement authentication or uncertain security behavior;
- do not edit outside console/;
- do not commit, push, merge, deploy, or ask questions.

Run focused checks when useful. Leave changes uncommitted for deterministic verification and review.`;
}

function repairPrompt(cycle, attempt) {
  const verifyTail = tail(verifyLogPath, 14000);
  return `You are the REPAIR node for Gateway console improvement cycle ${cycle}, attempt ${attempt} of ${repairLimit}.

The deterministic console quality gate failed. Read the uncommitted diff, console/.loop/next-task.md, and this verification output:

--- verification output ---
${verifyTail}
--- end output ---

Fix the root cause inside console/ only. Do not weaken tests or quality gates. Do not commit, push, merge, deploy, install global software, access production, or ask questions. Leave the repair uncommitted.`;
}

function reviewPrompt(cycle) {
  return `You are the REVIEW + QA node for bounded Gateway console improvement cycle ${cycle}.

Review the uncommitted console/ diff against console/PRODUCT_GOAL.md, console/.loop/next-task.md, and every section of console/UX_RUBRIC.md. Then:

1. Run browser QA with gstack against the local console at http://127.0.0.1:5174 when available. If unavailable, start only the local Vite preview and stop it when done.
2. Check desktop 1440x1000 and mobile 375x812.
3. Exercise the changed flow, keyboard focus, overflow, and browser console.
4. Fix all high-impact findings inside console/.
5. Run npm --prefix console run check.
6. Mark the selected BACKLOG.md item complete only if every acceptance check passes.
7. Write console/.loop/cycle-report.md with changed files, test result, browser evidence, rubric score, remaining risks, and whether the backlog item was completed.

A rubric safety or honesty failure blocks completion. Do not edit outside console/. Do not commit, push, merge, deploy, access production, or ask questions.`;
}

function ensureTime(stage) {
  if (Date.now() >= deadline) throw new Error(`runtime deadline reached at ${stage}`);
  if (stopped) throw new Error("loop stopped by signal");
  ensureBudget(stage);
}
function ensureBudget(stage) {
  if (state.reported_cost_usd > maxCostUsd) throw new Error(`reported cost limit exceeded at ${stage}: $${state.reported_cost_usd.toFixed(2)} > $${maxCostUsd.toFixed(2)}`);
}

function git(gitArgs) {
  const result = spawnSync("git", gitArgs, { cwd: repoRoot, encoding: "utf8", timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${gitArgs.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function writeState() {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}
function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  transcript.write(line);
  process.stdout.write(line);
}
function tail(path, maxCharacters) {
  if (!existsSync(path)) return "No verification log was produced.";
  const content = readFileSync(path, "utf8");
  return content.slice(-maxCharacters);
}
function attachJsonLines(stream, callback) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      try { callback(JSON.parse(line)); }
      catch (error) { transcript.write(`[invalid rpc json] bytes=${Buffer.byteLength(line)} error=${error instanceof Error ? error.message : String(error)}\n`); }
    }
  });
}
function safeEvent(event) {
  const summary = { type: event.type };
  if (event.id) summary.id = event.id;
  if (event.command) summary.command = event.command;
  if (typeof event.success === "boolean") summary.success = event.success;
  if (event.method) summary.method = event.method;
  if (event.toolName) summary.tool_name = event.toolName;
  if (typeof event.isError === "boolean") summary.is_error = event.isError;
  if (typeof event.willRetry === "boolean") summary.will_retry = event.willRetry;
  if (event.message?.role) summary.message_role = event.message.role;
  if (event.message?.stopReason) summary.stop_reason = event.message.stopReason;
  return summary;
}
function recordReportedCost(event) {
  const costs = [];
  if (event.type === "message_end") costs.push(event.message?.usage?.cost?.total);
  if (event.type === "compaction_end") costs.push(event.result?.usage?.cost?.total);
  for (const cost of costs) {
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
      state.reported_cost_usd = Number((state.reported_cost_usd + cost).toFixed(6));
      writeState();
    }
  }
}
function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function assertProtectedFiles() {
  for (const [path, expected] of protectedDigests) {
    const absolute = resolve(consoleDir, path);
    if (!existsSync(absolute) || digest(absolute) !== expected) throw new Error(`protected loop control file changed: console/${path}`);
  }
}
async function selfTest() {
  const raw = {
    type: "tool_execution_start",
    toolName: "bash",
    args: { command: "echo secret-shaped-content" },
    result: { content: "must-not-survive" },
  };
  const sanitized = JSON.stringify(safeEvent(raw));
  if (sanitized.includes("secret-shaped-content") || sanitized.includes("must-not-survive")) throw new Error("safeEvent retained tool content");
  if (!sanitized.includes('"tool_name":"bash"')) throw new Error("safeEvent lost tool metadata");

  const stream = new PassThrough();
  const parsed = [];
  attachJsonLines(stream, (event) => parsed.push(event));
  const unicodeSeparator = String.fromCodePoint(0x2028);
  stream.write(`{"type":"first","text":"line separator ${unicodeSeparator}"}\n`);
  stream.write('{"type":"second"}\r\n');
  stream.end();
  await new Promise((resolveTest) => stream.on("end", resolveTest));
  if (parsed.length !== 2 || parsed[0].type !== "first" || parsed[1].type !== "second") throw new Error("strict JSONL parser self-test failed");

  assertProtectedFilesForSelfTest();
  console.log(JSON.stringify({ ok: true, tests: ["event-redaction", "strict-jsonl", "control-files-present"] }, null, 2));
}
function assertProtectedFilesForSelfTest() {
  for (const path of ["PRODUCT_GOAL.md", "UX_RUBRIC.md", "scripts/improve-loop.mjs"]) {
    if (!existsSync(resolve(consoleDir, path))) throw new Error(`self-test missing ${path}`);
  }
}
function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
function printStatus() {
  if (!existsSync(statePath)) {
    console.log(JSON.stringify({ status: "never-started", loopDir }, null, 2));
    return;
  }
  const current = JSON.parse(readFileSync(statePath, "utf8"));
  if (current.status === "running" && !processIsAlive(current.pid)) current.status = "stale";
  console.log(JSON.stringify(current, null, 2));
  if (existsSync(transcriptPath)) console.log(`\n--- recent log ---\n${tail(transcriptPath, 5000)}`);
}
function stopLoop() {
  if (!existsSync(lockPath)) {
    console.log("No running loop lock found.");
    return;
  }
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (!lock.pid || !processIsAlive(lock.pid)) {
    rmSync(lockPath, { force: true });
    console.log("Removed stale loop lock.");
    return;
  }
  process.kill(lock.pid, "SIGTERM");
  console.log(`Sent SIGTERM to improvement loop pid ${lock.pid}.`);
}

function registerSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      stopped = true;
      state.status = "stopping";
      state.stage = `signal-${signal}`;
      writeState();
      if (child && !child.killed) {
        try { send({ type: "abort" }); } catch {}
        child.kill("SIGTERM");
      }
      settleStageError(new Error(`received ${signal}`));
    });
  }
}
