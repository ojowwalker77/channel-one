// Harness hooks: make "how to join" the only instruction an agent needs.
//
// `kiwi join` / `kiwi create` bind the agent's working directory to its channel
// and install user-level hooks for the harness this process is inside: Claude
// Code when CLAUDECODE is set, and Codex, Gemini, Cursor, or Grok when that
// harness's own session env is set. `kiwi hooks install` writes every detected
// harness. User-level files only, so nothing asks for a project trust prompt.
// They do nothing in any session whose directory isn't bound, so they're safe
// to keep installed globally:
//
//   SessionStart      tell the agent who it is on which channel, and to start listening
//   UserPromptSubmit  hand the agent any unread messages along with the human's prompt
//   Stop              don't let the agent go idle with unread messages, or deaf
//                     (no live `kiwi tail` / `kiwi wait` listener for it)
//
// Hooks must never break a session: every failure path exits 0 silently.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AgentSession } from "./agent.ts";
import { forgetMember, home, loadConfig, updateConfig, wipeChannel } from "./config.ts";
import { ChannelGone } from "./client.ts";
import { formatMessage } from "./format.ts";

/** Marks our entries so install/uninstall can find them. Current clients only. */
const MARK = "# kiwi";
const EVENTS = { SessionStart: "session-start", UserPromptSubmit: "prompt", Stop: "stop" } as const;

// ---------- directory bindings ----------

export interface Binding {
  alias: string;
  as: string;
}

/**
 * Directories too broad to bind: the home folder and the filesystem root. A
 * binding there would make every session in every project act as that agent.
 */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function tooBroad(dir: string): boolean {
  const d = real(dir);
  return d === real(homedir()) || dirname(d) === d;
}

/** Remember that an agent working in `dir` is `as` on channel `alias`. Returns false for home/root. */
export function bindDirectory(dir: string, b: Binding): boolean {
  if (tooBroad(dir)) return false;
  updateConfig((cfg) => {
    cfg.bindings = { ...(cfg.bindings ?? {}), [resolve(dir)]: b };
  });
  return true;
}

/** The binding for `dir` or its nearest bound ancestor, never reaching home or root. */
export function bindingFor(dir: string): Binding | null {
  const cfg = loadConfig();
  const bindings = cfg.bindings ?? {};
  for (let d = resolve(dir); !tooBroad(d); d = dirname(d)) {
    const b = bindings[d];
    if (b && cfg.channels[b.alias]) return b;
  }
  return null;
}

// ---------- live listeners ----------

function listenerDir(): string {
  return join(home(), "listeners");
}

/** Record that this process listens for `as` on `alias`; removed on exit. */
export function registerListener(alias: string, as: string): void {
  const dir = listenerDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${encodeURIComponent(alias)}.${encodeURIComponent(as)}.${process.pid}`);
  writeFileSync(file, String(Date.now()));
  const drop = () => rmSync(file, { force: true });
  process.on("exit", drop);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      drop();
      process.exit(0);
    });
  }
}

/** Whether some live process is listening for `as` on `alias` (stale records are cleaned up). */
export function isListening(alias: string, as: string): boolean {
  const dir = listenerDir();
  if (!existsSync(dir)) return false;
  const prefix = `${encodeURIComponent(alias)}.${encodeURIComponent(as)}.`;
  let alive = false;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(prefix)) continue;
    const pid = Number(f.slice(prefix.length));
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      rmSync(join(dir, f), { force: true });
    }
  }
  return alive;
}

// ---------- installing into Claude Code ----------

function settingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json");
}

/** How to invoke this very `kiwi`, wherever and however it's installed. */
function selfCommand(): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const compiled = !/\.(ts|js)$/.test(Bun.main);
  // Prefer the PATH entry for bun (e.g. /opt/homebrew/bin/bun) over its versioned real path, which upgrades remove.
  const bun = Bun.which("bun") ?? process.execPath;
  return compiled ? q(process.execPath) : `${q(bun)} ${q(Bun.main)}`;
}

type HookEntry = { matcher?: string; hooks: { type: "command"; command: string; timeout?: number }[] };
type Settings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

function readSettings(): Settings {
  const p = settingsPath();
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Settings) : {};
}

function writeSettings(s: Settings): void {
  const p = settingsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
}

/**
 * A command this program wrote: `<invocation> hook <event> # kiwi`.
 * Matching the mark alone would delete someone else's hook that merely
 * mentions "# kiwi". Any invocation is recognised, so a reinstall replaces
 * the entry instead of adding a second one.
 */
function isOurHookCommand(command: string): boolean {
  for (const event of Object.values(EVENTS)) {
    const tail = ` hook ${event} ${MARK}`;
    if (command.endsWith(tail) && command.length > tail.length) return true;
  }
  return false;
}

function withoutOurs(entries: HookEntry[] | undefined): HookEntry[] {
  return (entries ?? [])
    .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !isOurHookCommand(h.command)) }))
    .filter((e) => e.hooks.length > 0);
}

/** The command string every harness runs. Grok's Stop entry must stay identical to Claude's, so Grok's Claude-compat load dedupes them. */
function hookCommand(arg: string): string {
  return `${selfCommand()} hook ${arg} ${MARK}`;
}

/** Install (or refresh) our hooks in the user's Claude Code settings. Returns the settings path. */
export function installHooks(): string {
  const s = readSettings();
  s.hooks ??= {};
  for (const [event, arg] of Object.entries(EVENTS)) {
    s.hooks[event] = [
      ...withoutOurs(s.hooks[event]),
      { hooks: [{ type: "command", command: hookCommand(arg), timeout: event === "UserPromptSubmit" ? 20 : 30 }] },
    ];
  }
  writeSettings(s);
  return settingsPath();
}

export function uninstallHooks(): string {
  const s = readSettings();
  for (const event of Object.keys(s.hooks ?? {})) {
    const kept = withoutOurs(s.hooks![event]);
    if (kept.length) s.hooks![event] = kept;
    else delete s.hooks![event];
  }
  if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
  writeSettings(s);
  return settingsPath();
}

export function hooksInstalled(): boolean {
  const s = readSettings();
  return Object.entries(EVENTS).every(
    ([event, arg]) => s.hooks?.[event]?.some((x) => x.hooks.some((h) => h.command === hookCommand(arg))),
  );
}

/** Install automatically when an agent joins from inside Claude Code (opt out with KIWI_NO_HOOKS=1). */
export function autoInstallHooks(): string | null {
  // Never against the choice this computer's person made in `kiwi setup`.
  if (process.env.KIWI_NO_HOOKS || !process.env.CLAUDECODE || loadConfig().claudeHooks === "off") return null;
  try {
    // A different invocation path still counts as installed only when the command string matches this binary.
    return hooksInstalled() ? null : installHooks();
  } catch {
    return null;
  }
}

// ---------- Codex, Gemini, Cursor, Grok (user-level only) ----------

export const EXTRA_HARNESSES = ["codex", "gemini", "cursor", "grok"] as const;
export type ExtraHarness = (typeof EXTRA_HARNESSES)[number];

/** Set in tests so install never writes the real home. Unset means the harness's own user dir. */
const HARNESS_ENV: Record<ExtraHarness, string> = {
  codex: "KIWI_CODEX_DIR",
  gemini: "KIWI_GEMINI_DIR",
  cursor: "KIWI_CURSOR_DIR",
  grok: "KIWI_GROK_DIR",
};

/**
 * Set on the shell commands the harness runs, the same idea as CLAUDECODE.
 * A present install directory is not enough: join must not write a harness
 * the agent is not inside. Checked 2026-10-10:
 *   Codex  CODEX_THREAD_ID   injected into shell commands when a thread id is
 *          present, including when include_only is set (openai/codex
 *          codex-rs/core/src/exec_env.rs and
 *          codex-rs/protocol/src/shell_environment.rs, CODEX_THREAD_ID_ENV_VAR).
 *   Gemini GEMINI_CLI=1     set by run_shell_command
 *          (https://geminicli.com/docs/tools/shell).
 *   Cursor CURSOR_AGENT     set while the agent runs; shell config is told to
 *          detect the session with it (https://cursor.com/docs/agent/terminal).
 *   Grok   GROK_SESSION_ID  this session's id, injected on every hook
 *          (user guide 10-hooks.md) and present on this agent's shell commands.
 *          GROK_AGENT is an agent-definition name (user guide 05-configuration.md),
 *          so it is not a session marker.
 */
const SESSION_ENV: Record<ExtraHarness, string> = {
  codex: "CODEX_THREAD_ID",
  gemini: "GEMINI_CLI",
  cursor: "CURSOR_AGENT",
  grok: "GROK_SESSION_ID",
};

function harnessRoot(h: ExtraHarness): string {
  const over = process.env[HARNESS_ENV[h]];
  if (over) return over;
  if (h === "codex") return join(homedir(), ".codex");
  if (h === "gemini") return join(homedir(), ".gemini");
  if (h === "cursor") return join(homedir(), ".cursor");
  return join(homedir(), ".grok");
}

function harnessPath(h: ExtraHarness): string {
  if (h === "codex") return join(harnessRoot(h), "hooks.json");
  if (h === "gemini") return join(harnessRoot(h), "settings.json");
  if (h === "cursor") return join(harnessRoot(h), "hooks.json");
  return join(harnessRoot(h), "hooks", "kiwi.json");
}

/**
 * A harness counts as installed when its user dir exists, or its binary is on PATH.
 * An explicit KIWI_*_DIR counts only when that directory exists, so tests can point
 * these away from the real home without creating files there.
 */
export function harnessPresent(h: ExtraHarness): boolean {
  if (process.env[HARNESS_ENV[h]] !== undefined) return existsSync(harnessRoot(h));
  if (existsSync(harnessRoot(h))) return true;
  const bins = h === "codex" ? ["codex"] : h === "gemini" ? ["gemini"] : h === "cursor" ? ["cursor"] : ["grok"];
  return bins.some((b) => !!Bun.which(b));
}

function readJson(p: string): Record<string, any> {
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;
}

function writeJson(p: string, value: unknown): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(value, null, 2) + "\n");
}

const GEMINI_EVENTS = { SessionStart: "session-start", BeforeAgent: "prompt", AfterAgent: "stop" } as const;

function installClaudeShaped(path: string, events: Record<string, string>, timeoutFor: (event: string) => number, matcher?: string): void {
  const s = readJson(path) as Settings;
  s.hooks ??= {};
  for (const [event, arg] of Object.entries(events)) {
    s.hooks[event] = [
      ...withoutOurs(s.hooks[event]),
      { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: hookCommand(arg), timeout: timeoutFor(event) }] },
    ];
  }
  writeJson(path, s);
}

function stripClaudeShaped(path: string): void {
  if (!existsSync(path)) return;
  const s = readJson(path) as Settings;
  for (const event of Object.keys(s.hooks ?? {})) {
    const kept = withoutOurs(s.hooks![event]);
    if (kept.length) s.hooks![event] = kept;
    else delete s.hooks![event];
  }
  if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
  if (!Object.keys(s).length) {
    rmSync(path, { force: true });
    return;
  }
  writeJson(path, s);
}

function claudeShapedInstalled(path: string, events: Record<string, string>): boolean {
  if (!existsSync(path)) return false;
  const s = readJson(path) as Settings;
  return Object.entries(events).every(([event, arg]) => s.hooks?.[event]?.some((x) => x.hooks.some((h) => h.command === hookCommand(arg))));
}

type CursorHook = { command?: string; timeout?: number; loop_limit?: number | null };
type CursorFile = { version?: number; hooks?: Record<string, CursorHook[]> } & Record<string, unknown>;

function cursorHooks(list: unknown): CursorHook[] {
  if (!Array.isArray(list)) return [];
  return list.filter((h) => !h || typeof h.command !== "string" || !isOurHookCommand(h.command));
}

function installCursorFile(path: string): void {
  const s = readJson(path) as CursorFile;
  if (s.version == null) s.version = 1;
  s.hooks ??= {};
  s.hooks.sessionStart = [...cursorHooks(s.hooks.sessionStart), { command: hookCommand("session-start"), timeout: 20 }];
  s.hooks.stop = [...cursorHooks(s.hooks.stop), { command: hookCommand("stop"), timeout: 30, loop_limit: 5 }];
  writeJson(path, s);
}

function stripCursorFile(path: string): void {
  if (!existsSync(path)) return;
  const s = readJson(path) as CursorFile;
  if (s.hooks) {
    for (const event of Object.keys(s.hooks)) {
      const kept = cursorHooks(s.hooks[event]);
      if (kept.length) s.hooks[event] = kept;
      else delete s.hooks[event];
    }
    if (!Object.keys(s.hooks).length) delete s.hooks;
  }
  writeJson(path, s);
}

function cursorFileInstalled(path: string): boolean {
  if (!existsSync(path)) return false;
  const s = readJson(path) as CursorFile;
  const has = (event: string, arg: string) => (s.hooks?.[event] ?? []).some((h) => h.command === hookCommand(arg));
  return has("sessionStart", "session-start") && has("stop", "stop");
}

/** Install one harness's user-level file. Creates the file even when the harness isn't detected. */
export function installExtra(h: ExtraHarness): string {
  const path = harnessPath(h);
  if (h === "codex") installClaudeShaped(path, EVENTS, (event) => (event === "UserPromptSubmit" ? 20 : 30));
  else if (h === "gemini") installClaudeShaped(path, GEMINI_EVENTS, (event) => (event === "BeforeAgent" ? 20_000 : 30_000), "*");
  else if (h === "cursor") installCursorFile(path);
  else installClaudeShaped(path, { Stop: "stop" }, () => 30);
  return path;
}

export function uninstallExtra(h: ExtraHarness): string {
  const path = harnessPath(h);
  if (h === "cursor") stripCursorFile(path);
  else stripClaudeShaped(path);
  return path;
}

export function extraInstalled(h: ExtraHarness): boolean {
  if (h === "cursor") return cursorFileInstalled(harnessPath(h));
  if (h === "gemini") return claudeShapedInstalled(harnessPath(h), GEMINI_EVENTS);
  if (h === "grok") return claudeShapedInstalled(harnessPath(h), { Stop: "stop" });
  return claudeShapedInstalled(harnessPath(h), EVENTS);
}

const HARNESS_LABEL: Record<ExtraHarness, string> = { codex: "Codex", gemini: "Gemini", cursor: "Cursor", grok: "Grok" };

/**
 * Install the harness this process is running inside. Does not change
 * harnessHooks: "off" and KIWI_NO_HOOKS skip, and a file that already has our
 * command is left as it is. Returns null when nothing was written.
 */
export function autoInstallExtraHooks(): string | null {
  if (process.env.KIWI_NO_HOOKS) return null;
  const choice = loadConfig().harnessHooks ?? {};
  const wrote: string[] = [];
  for (const h of EXTRA_HARNESSES) {
    if (!process.env[SESSION_ENV[h]] || choice[h] === "off") continue;
    try {
      if (extraInstalled(h)) continue;
      wrote.push(`${HARNESS_LABEL[h]} hooks (${installExtra(h)})`);
    } catch {
      // A corrupt file must not fail join.
    }
  }
  return wrote.length ? wrote.join(", ") : null;
}

/** Claude, plus every detected harness that this computer has not opted out of. */
export function installDetected(): string[] {
  const paths = [installHooks()];
  const choice = loadConfig().harnessHooks ?? {};
  for (const h of EXTRA_HARNESSES) {
    if (choice[h] === "off" || !harnessPresent(h)) continue;
    paths.push(installExtra(h));
  }
  return paths;
}

export function uninstallDetected(): string[] {
  const paths = [uninstallHooks()];
  for (const h of EXTRA_HARNESSES) paths.push(uninstallExtra(h));
  return paths;
}

/** One status line per harness. */
export function hooksStatus(): string {
  const choice = loadConfig().harnessHooks ?? {};
  const claude = loadConfig().claudeHooks === "off" && !hooksInstalled() ? "off" : hooksInstalled() ? "installed" : "not installed";
  const lines = [`claude: ${claude}`];
  for (const h of EXTRA_HARNESSES) {
    if (extraInstalled(h)) lines.push(`${h}: installed`);
    else if (choice[h] === "off") lines.push(`${h}: off`);
    else if (!harnessPresent(h)) lines.push(`${h}: not detected`);
    else lines.push(`${h}: not installed`);
  }
  return lines.join("\n");
}

/**
 * How a Stop hook should answer. Grok sends hook_event_name "Stop" (and also
 * hookEventName "stop"), so it stays on the Claude block path and cannot be
 * mistaken for Cursor, whose stop input has status and loop_count and no event name.
 */
export function stopStyle(input: { hook_event_name?: string; status?: string; loop_count?: number }): "cursor" | "gemini" | "block" {
  if (input.hook_event_name === "AfterAgent") return "gemini";
  if (input.hook_event_name === "Stop") return "block";
  if (input.status != null || typeof input.loop_count === "number") return "cursor";
  return "block";
}

/** Cursor's stop follow-up. Same text every time, and short: loop_limit is 5. */
export function cursorStopFollowup(mc: string, unread: boolean, listening: boolean, loopCount: number): string | null {
  if (unread) return `Unread Kiwi messages. Run \`${mc} read\`, answer with \`${mc} reply N "…"\`, then continue.`;
  if (!listening && loopCount === 0) return `Nothing is listening on Kiwi. Start a Monitor on \`${mc} tail\`.`;
  return null;
}

// ---------- running a hook ----------

interface HookInput {
  session_id?: string;
  cwd?: string;
  stop_hook_active?: boolean;
  hook_event_name?: string;
  hookEventName?: string;
  status?: string;
  loop_count?: number;
  composer_mode?: string;
  is_background_agent?: boolean;
}

/** Remember when we last nagged a session about not listening (per kind of nag), so it's at most every 10 minutes. */
function nagDue(session: string, kind = "stop"): boolean {
  const dir = join(home(), "hook-state");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, encodeURIComponent(session || "unknown") + (kind === "stop" ? "" : `.${kind}`));
  const last = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  if (Date.now() - last < 10 * 60_000) return false;
  writeFileSync(file, String(Date.now()));
  return true;
}

/** How an agent's shell should call kiwi: plain `kiwi` when it's on PATH, else the full path. */
export function mcBin(): string {
  if (Bun.which("kiwi")) return "kiwi";
  const installed = join(homedir(), ".kiwi", "bin", process.platform === "win32" ? "kiwi.exe" : "kiwi");
  if (existsSync(installed)) return installed;
  return selfCommand();
}

/** The exact command for this agent: always naming its channel and itself, so nothing else on the machine can redirect it. */
export function mcFor(alias: string, as: string, _dir = process.cwd()): string {
  return `${mcBin()} -c ${alias} --as ${as}`;
}

const MAX_CONTEXT = 6_000;

async function unreadText(s: AgentSession): Promise<string> {
  const { messages, state } = await s.read();
  const text = messages.map((m) => formatMessage(m, state.trust.get(m.seq), state)).join("\n");
  return text.length > MAX_CONTEXT ? `${text.slice(0, MAX_CONTEXT)}\n… (more: run \`kiwi log\`)` : text;
}

/** Entry point for `kiwi hook <event>`: reads the hook JSON on stdin, prints the hook's answer. */
export async function runHook(event: string): Promise<void> {
  let input: HookInput = {};
  try {
    input = JSON.parse(await new Response(Bun.stdin.stream()).text()) as HookInput;
  } catch {}
  const b = bindingFor(process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd()) ?? bindingFor(input.cwd ?? process.cwd());
  if (!b) return;
  const cfg = loadConfig().channels[b.alias];
  if (!cfg) return;
  const mc = mcFor(b.alias, b.as, input.cwd ?? process.cwd());
  const listening = isListening(b.alias, b.as);

  const deadline = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 15_000));
  const work = (async () => {
    const s = await AgentSession.open(b.alias, cfg, b.as);

    if (event === "session-start") {
      const lines = [
        `You are "${b.as}" in channel "${b.alias}" on Kiwi Channels (agents and people coordinating in real time). Your own human gives instructions; skip replies to greetings that need nothing from you.`,
        listening
          ? "A listener is already running for you."
          : `First, start a Monitor on \`${mc} tail\` with the longest timeout allowed, and restart it whenever it ends. That's how messages reach you.`,
        `Run \`${mc} status\` before picking up work. \`${mc} prompt\` has the full guide.`,
      ];
      const unread = await unreadText(s);
      if (unread) lines.push("", "Unread messages for you:", unread);
      const additionalContext = lines.join("\n");
      // Cursor's sessionStart injects additional_context and ignores the Claude envelope.
      if (input.hook_event_name === "sessionStart" || input.composer_mode != null || typeof input.is_background_agent === "boolean") {
        return process.stdout.write(JSON.stringify({ additional_context: additionalContext }));
      }
      return process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
    }

    if (event === "prompt") {
      const unread = await unreadText(s);
      const lines: string[] = [];
      if (unread) lines.push(`New Kiwi Channels messages for you (${b.alias}):`, unread);
      // A listener is often just between restarts: remind at most every 10 minutes, not on every prompt.
      if (!listening && nagDue(input.session_id ?? "", "prompt")) lines.push(`You're not listening on Kiwi Channels: start a Monitor on \`${mc} tail\` (longest timeout).`);
      if (lines.length) {
        const text = lines.join("\n");
        // Gemini BeforeAgent only injects hookSpecificOutput.additionalContext. Codex and Claude take plain stdout.
        if (input.hook_event_name === "BeforeAgent") {
          process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "BeforeAgent", additionalContext: text } }));
        } else {
          process.stdout.write(text);
        }
      }
      return;
    }

    if (event === "stop") {
      const style = stopStyle(input);
      if (style === "cursor") {
        // An aborted or failed turn must not schedule another one. Don't read: that would consume the messages the follow-up tells the agent to read.
        if (input.status && input.status !== "completed") return;
        const { messages, state } = await s.state();
        const unread = (await s.unreadCount(state, messages)) > 0;
        const follow = cursorStopFollowup(mc, unread, listening, input.loop_count ?? 0);
        if (!follow) return;
        if (!unread && !nagDue(input.session_id ?? "")) return;
        return process.stdout.write(JSON.stringify({ followup_message: follow }));
      }
      const unread = await unreadText(s);
      const decision = style === "gemini" ? "deny" : "block";
      if (unread) {
        return process.stdout.write(
          JSON.stringify({ decision, reason: `Before stopping: unread Kiwi Channels messages for you. Handle them (answer with \`${mc} reply N "…"\`):\n${unread}` }),
        );
      }
      if (!listening && !input.stop_hook_active && nagDue(input.session_id ?? "")) {
        return process.stdout.write(
          JSON.stringify({
            decision,
            reason: `You're about to go idle with nothing listening for you on Kiwi Channels, so messages from other agents won't wake you. Start a Monitor on \`${mc} tail\` (longest timeout allowed), then stop.`,
          }),
        );
      }
    }
  })();
  await Promise.race([
    work.catch((err: unknown) => {
      // The channel is gone for this agent: forget only what this agent held, quietly.
      if (err instanceof ChannelGone) (err.why === "closed" ? wipeChannel(b.alias) : forgetMember(b.alias, b.as));
    }),
    deadline,
  ]);
}
