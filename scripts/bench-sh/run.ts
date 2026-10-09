// T45: one fixed Coordinator session, three surfaces.
//
// Tokens are ceil(chars / 4), where chars is the JavaScript string length
// (UTF-16 code units). Same estimator for every surface.
//
// A step is one model-visible call: an MCP tool call, a shell pipeline, or
// one `sh` invocation. CLI+jq counts the filtered stdout the model reads
// (jq / section extract). MCP counts the full tool result, because the tool
// does not filter. sh is one script (scripts/bench-sh/sh-session.sh) and is
// executed only when src/sh.ts exports runSh, channelFiles and channelView.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const here = dirname(fileURLToPath(import.meta.url));
// kiwi-sh lives in Claude-2's worktree. Status, tasks, sh and tools/list all run from that tree.
const kiwiRoot = process.env.KIWI_SH_ROOT ?? "/Users/jow/.t3/worktrees/modelchannel/t3-07c0ed11";
const ALIAS = "channels";
const AS = "Grok-1";

const tokens = (s: string) => Math.ceil(s.length / 4);

/** Planned `sh` tool. Not served yet; sized like the other one-argument tools. */
const SH_TOOL = {
  name: "sh",
  description:
    "Run a read-only shell script against the channel filesystem (cwd /channel). No network, no disk, no writes. Returns stdout, stderr and exitCode.",
  inputSchema: {
    type: "object",
    properties: {
      script: { type: "string", description: "Script text. cwd is /channel." },
    },
    required: ["script"],
    additionalProperties: false,
  },
};

/**
 * Owner-only tools, registered in src/mcp.ts only when this member owns the
 * channel. Reconstructed from that source so the 17-tool figure includes them.
 * This agent is not the owner, so tools/list does not return them.
 */
const OWNER_TOOLS = [
  {
    name: "join_requests",
    description: "Pending join requests with their verification codes. Show them to your human; never approve on your own.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "decide_join",
    description:
      "Approve or deny a join request. Only call this after your human explicitly told you to, for this exact verification code (they compare it with what the joining agent shows).",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "the 6-digit verification code, like 482-913" },
        approve: { type: "boolean" },
        name: { type: "string", description: "admit under a different name" },
      },
      required: ["code", "approve"],
    },
  },
];

const JQ_STATUS =
  "{channel,me,head,unread,freeBackend:[.members[]|select(.role==\"backend\" and .load.level==\"free\")|.name],members:[.members[]|{name,role,online,load:.load.level,doing:[.load.current[].id]}]}";

function kiwi(args: string[], timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", ["src/cli/main.ts", "-c", ALIAS, "--as", AS, ...args], { cwd: kiwiRoot });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`timed out: kiwi ${args.join(" ")}`));
    }, timeoutMs);
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (c) => (stdout += c));
    proc.stderr.on("data", (c) => (stderr += c));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

/** This SDK's stdio transport is one JSON object per line, not Content-Length frames. */
function ndjson(msg: unknown): string {
  return JSON.stringify(msg) + "\n";
}

async function mcpList(): Promise<{ tools: { name: string; description?: string }[]; instructions: string }> {
  const proc = spawn("bun", ["src/cli/main.ts", "-c", ALIAS, "--as", AS, "mcp"], { cwd: kiwiRoot });
  let stdout = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (c) => (stdout += c));
  proc.stderr.on("data", (c) => (stderr += c));
  const closed = new Promise<number>((resolve) => proc.on("close", (code) => resolve(code ?? 1)));
  // session() has to finish and attach the stdin reader before the first line is safe to send.
  await new Promise((r) => setTimeout(r, 2000));
  proc.stdin.write(ndjson({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench-sh", version: "0" } } }));
  proc.stdin.write(ndjson({ jsonrpc: "2.0", method: "notifications/initialized" }));
  proc.stdin.write(ndjson({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  proc.stdin.end();
  const code = await Promise.race([closed, new Promise<number>((_, reject) => setTimeout(() => reject(new Error(`mcp timed out: ${stderr.slice(0, 200)}`)), 20_000))]);
  if (!stdout.trim()) throw new Error(`mcp produced no stdout (exit ${code}): ${stderr.slice(0, 300)}`);
  const messages = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id?: number; result?: { tools?: { name: string; description?: string }[]; instructions?: string } });
  const init = messages.find((m) => m.id === 1);
  const listed = messages.find((m) => m.id === 2);
  return { tools: listed?.result?.tools ?? [], instructions: init?.result?.instructions ?? "" };
}

/** Task lines and questions addressed to us, the part a shell agent would keep. */
function extractStatus(text: string): string {
  const lines = text.split("\n");
  const keep: string[] = [];
  let mode: "none" | "tasks" | "asks" = "none";
  for (const line of lines) {
    if (/^tasks \(/.test(line)) {
      mode = "tasks";
      keep.push(line);
      continue;
    }
    if (/^waiting on you \(/.test(line)) {
      mode = "asks";
      keep.push(line);
      continue;
    }
    if (mode !== "none" && (line === "" || /^[a-z].*:/.test(line) || /^[a-z].*\(/.test(line))) {
      mode = "none";
    }
    if (mode !== "none" && line.startsWith("  ")) keep.push(line.trimEnd());
  }
  return keep.join("\n");
}

function parseTasks(extracted: string): Record<string, string[]> {
  const byOwner: Record<string, string[]> = {};
  for (const line of extracted.split("\n")) {
    const m = /^(T\d+)\s+(\S+)\s+(?:@(\S+)\s+)?(.*)$/.exec(line.trim());
    if (!m) continue;
    const owner = m[3] ?? "(unassigned)";
    (byOwner[owner] ??= []).push(`${m[1]} ${m[2]}`);
  }
  return byOwner;
}

function parseAsks(extracted: string): string[] {
  return extracted.split("\n").filter((l) => /^\s*#\d+/.test(l)).map((l) => l.trim());
}

interface ShRun {
  pending?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

async function trySh(script: string): Promise<ShRun> {
  let mod: Record<string, unknown>;
  try {
    mod = await import(join(root, "src/sh.ts"));
  } catch (err) {
    return { pending: `src/sh.ts not importable (${err instanceof Error ? err.message : err})` };
  }
  const { runSh, channelFiles, channelView } = mod;
  if (typeof runSh !== "function" || typeof channelFiles !== "function" || typeof channelView !== "function") {
    return { pending: "runSh, channelFiles or channelView is not exported yet" };
  }
  try {
    const { AgentSession } = await import(join(root, "src/agent.ts"));
    const { loadConfig } = await import(join(root, "src/config.ts"));
    const cfg = loadConfig().channels[ALIAS];
    if (!cfg) return { pending: `no local channel ${ALIAS}` };
    const session = await AgentSession.open(ALIAS, cfg, AS);
    const files = channelFiles([await channelView(session)]) as Record<string, string>;
    const result = (await runSh(files, script, { cwd: "/channel" })) as { stdout: string; stderr: string; exitCode: number };
    return result;
  } catch (err) {
    return { pending: `runSh failed (${err instanceof Error ? err.message : err})` };
  }
}

function pctFewer(base: number, next: number): string {
  if (base <= 0) return "n/a";
  const pct = ((base - next) / base) * 100;
  return `${pct.toFixed(1)}%`;
}

const script = readFileSync(join(here, "sh-session.sh"), "utf8");

const [statusJson, statusText, tasksGlobal, prompt, listed] = await Promise.all([
  kiwi(["status", "--json"]),
  kiwi(["status"]),
  kiwi(["tasks", "--global"]),
  kiwi(["prompt"]),
  mcpList(),
]);

if (statusJson.code !== 0) throw new Error(`status --json failed: ${statusJson.stderr}`);
if (statusText.code !== 0) throw new Error(`status failed: ${statusText.stderr}`);
if (tasksGlobal.code !== 0) throw new Error(`tasks --global failed: ${tasksGlobal.stderr}`);

const jqBin = Bun.which("jq");
let jqOut: string;
if (jqBin) {
  const jq = spawn(jqBin, [JQ_STATUS], { cwd: root });
  jq.stdin.end(statusJson.stdout);
  jqOut = await new Promise((resolve, reject) => {
    let out = "";
    jq.stdout.setEncoding("utf8");
    jq.stdout.on("data", (c) => (out += c));
    jq.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error("jq failed"))));
  });
} else {
  const raw = JSON.parse(statusJson.stdout);
  jqOut = JSON.stringify({
    channel: raw.channel,
    me: raw.me,
    head: raw.head,
    unread: raw.unread,
    freeBackend: raw.members.filter((m: { role: string; load: { level: string } }) => m.role === "backend" && m.load.level === "free").map((m: { name: string }) => m.name),
    members: raw.members.map((m: { name: string; role: string; online: boolean; load: { level: string; current: { id: string }[] } }) => ({
      name: m.name,
      role: m.role,
      online: m.online,
      load: m.load.level,
      doing: m.load.current.map((t) => t.id),
    })),
  });
}

const extracted = extractStatus(statusText.stdout);
const tasksByOwner = parseTasks(extracted);
const asks = parseAsks(extracted);
const shRun = await kiwi(["sh", script], 20_000);
const sh = shRun.code === 0 ? { stdout: shRun.stdout, stderr: shRun.stderr, exitCode: shRun.code } : { pending: shRun.stderr || `exit ${shRun.code}`, stdout: shRun.stdout, stderr: shRun.stderr, exitCode: shRun.code };

const mcpTools = listed.tools;
const ownerExtra = OWNER_TOOLS.filter((t) => !mcpTools.some((m) => m.name === t.name));
const withoutSh = mcpTools.filter((t) => t.name !== "sh");
const shFromList = mcpTools.find((t) => t.name === "sh");
const mcpSchemaText = JSON.stringify([...withoutSh, ...ownerExtra]);
const shSchemaText = JSON.stringify(shFromList ?? SH_TOOL);

const cliVisible = [jqOut, extracted, tasksGlobal.stdout].join("\n");
const mcpVisible = [statusText.stdout, tasksGlobal.stdout].join("\n");
const shVisible = sh.stdout ?? "";

const cliCalls = [
  `kiwi status --json | jq '${JQ_STATUS}'`,
  "kiwi status  # model reads only the tasks and waiting-on-you sections",
  "kiwi tasks --global",
];
const mcpCalls = ["status", "tasks {global:true}"];

const report = {
  estimator: "ceil(jsStringLength / 4)",
  kiwiRoot,
  commit: Bun.spawnSync(["git", "-C", kiwiRoot, "rev-parse", "--short", "HEAD"]).stdout.toString().trim(),
  session: {
    steps: ["status", "free backend", "open tasks per owner", "unanswered questions", "cross-channel tasks"],
    answers: {
      freeBackend: JSON.parse(jqOut).freeBackend,
      tasksByOwner,
      asks,
    },
    jq: jqBin ? "system jq" : "jq not installed; same filter applied in process",
  },
  steps: { mcp: mcpCalls.length, cli_jq: cliCalls.length, sh: 1 },
  calls: { mcp: mcpCalls, cli_jq: cliCalls, sh: ["sh < sh-session.sh>  # one call, cwd /channel"] },
  sessionOutputTokens: {
    mcp: tokens(mcpVisible),
    cli_jq: tokens(cliVisible),
    sh: sh.exitCode === 0 ? tokens(shVisible) : null,
  },
  sessionInputTokens: {
    mcp: tokens(JSON.stringify({ global: true })),
    cli_jq: tokens(cliCalls.join("\n")),
    sh: tokens(script),
  },
  fixedTokens: {
    mcpSchemas: tokens(mcpSchemaText),
    mcpSchemaCount: mcpTools.length + ownerExtra.length,
    mcpListed: mcpTools.map((t) => t.name),
    mcpWithoutSh: withoutSh.length + ownerExtra.length,
    ownerToolsReconstructed: ownerExtra.map((t) => t.name),
    mcpInstructions: tokens(listed.instructions),
    shSchema: tokens(shSchemaText),
    shSchemaNote: shFromList ? "the sh tool from tools/list" : "planned tool; tools/list had no sh",
    cliPrompt: tokens(prompt.stdout),
  },
  totals: {
    note: "fixed schemas (MCP tools except sh, plus reconstructed owner tools) or the CLI prompt, plus session output. sh fixed cost is the one sh tool schema.",
    mcp: tokens(mcpSchemaText) + tokens(mcpVisible),
    cli_jq: tokens(prompt.stdout) + tokens(cliVisible),
    sh: sh.exitCode === 0 ? tokens(shSchemaText) + tokens(shVisible) : null,
  },
  fewerThanMcp: {
    steps_cli: pctFewer(mcpCalls.length, cliCalls.length),
    steps_sh: pctFewer(mcpCalls.length, 1),
    sessionOutput_cli: pctFewer(tokens(mcpVisible), tokens(cliVisible)),
    sessionOutput_sh: sh.exitCode === 0 ? pctFewer(tokens(mcpVisible), tokens(shVisible)) : "n/a",
    sessionOutput_sh_vs_cli: sh.exitCode === 0 ? pctFewer(tokens(cliVisible), tokens(shVisible)) : "n/a",
    total_sh: sh.exitCode === 0 ? pctFewer(tokens(mcpSchemaText) + tokens(mcpVisible), tokens(shSchemaText) + tokens(shVisible)) : "n/a",
    total_sh_vs_cli: sh.exitCode === 0 ? pctFewer(tokens(prompt.stdout) + tokens(cliVisible), tokens(shSchemaText) + tokens(shVisible)) : "n/a",
    fixed_shSchema_vs_mcpSchemas: pctFewer(tokens(mcpSchemaText), tokens(shSchemaText)),
  },
  bar: "Keep sh only if it shows >=25% fewer tokens or steps than both MCP and CLI+jq.",
  // T148: schemas the model still loads if the read tools sh replaces are dropped.
  // facts stays: it is the set/unset tool, not a separate facts-get.
  writePlusSh: (() => {
    const keep = new Set(["send", "ask", "reply", "task_add", "task_update", "claim", "release", "save", "join_requests", "decide_join", "read", "who", "facts", "sh"]);
    const dropped = ["status", "tasks", "log", "members"];
    const tools = [...withoutSh, ...ownerExtra, shFromList ?? SH_TOOL].filter((t) => keep.has(t.name));
    const schemaText = JSON.stringify(tools);
    const fixed = tokens(schemaText);
    const output = sh.exitCode === 0 ? tokens(shVisible) : null;
    const total = output === null ? null : fixed + output;
    const baseline = tokens(mcpSchemaText) + tokens(mcpVisible);
    const fewer = total === null || baseline <= 0 ? null : ((baseline - total) / baseline) * 100;
    return {
      kept: tools.map((t) => t.name).sort(),
      dropped,
      note: "fixed = these schemas. output = the one sh session, which replaces status and tasks {global}. facts is one tool, so facts-get is not dropped separately.",
      steps: { baseline: mcpCalls.length, writePlusSh: 1 },
      fixedTokens: fixed,
      sessionOutputTokens: output,
      fixedPlusOutput: total,
      versus17: fewer === null ? "sh did not run" : `${fewer.toFixed(1)}%`,
      clears25: fewer !== null && fewer >= 25,
    };
  })(),
  sh,
  rawChars: {
    statusJson: statusJson.stdout.length,
    statusText: statusText.stdout.length,
    tasksGlobal: tasksGlobal.stdout.length,
    jqOut: jqOut.length,
    extracted: extracted.length,
    prompt: prompt.stdout.length,
    mcpSchemas: mcpSchemaText.length,
    shSchema: shSchemaText.length,
  },
};

writeFileSync(join(here, "last-run.json"), JSON.stringify(report, null, 2) + "\n");

const line = (label: string, n: number | null) => `${label}: ${n === null ? "pending" : n}`;
console.log(`estimator: ceil(chars/4)`);
console.log(`steps  mcp=${report.steps.mcp}  cli+jq=${report.steps.cli_jq}  sh=${report.steps.sh}`);
console.log(line("session-output mcp", report.sessionOutputTokens.mcp));
console.log(line("session-output cli+jq", report.sessionOutputTokens.cli_jq));
console.log(line("session-output sh", report.sessionOutputTokens.sh));
console.log(`fixed  mcp-schemas=${report.fixedTokens.mcpSchemas} (${report.fixedTokens.mcpSchemaCount} tools)  sh-schema=${report.fixedTokens.shSchema}  cli-prompt=${report.fixedTokens.cliPrompt}`);
console.log(`total  mcp=${report.totals.mcp}  cli+jq=${report.totals.cli_jq}  sh=${report.totals.sh ?? "pending"}`);
console.log(`sh vs mcp steps: ${report.fewerThanMcp.steps_sh} fewer`);
console.log(`cli vs mcp session output: ${report.fewerThanMcp.sessionOutput_cli} fewer`);
console.log(`sh schema vs 17 mcp schemas: ${report.fewerThanMcp.fixed_shSchema_vs_mcpSchemas} fewer`);
console.log(`write+sh tools=${report.writePlusSh.kept.length} fixed+output=${report.writePlusSh.fixedPlusOutput ?? "pending"} vs 17: ${report.writePlusSh.versus17} fewer  clears25=${report.writePlusSh.clears25}`);
console.log(`sh run: ${sh.pending ?? `exit ${sh.exitCode}`}`);
console.log(`free backend: ${JSON.stringify(report.session.answers.freeBackend)}`);
console.log(`tasks parsed: ${Object.keys(tasksByOwner).length ? "yes" : "NONE"}`);
if (!Object.keys(tasksByOwner).length) process.exit(2);
