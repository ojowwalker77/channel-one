// Claude Code hooks: make "how to join" the only instruction an agent needs.
//
// `kiwi join` / `kiwi create` bind the agent's working directory to its channel
// and install three user-level hooks. They do nothing in any session whose
// directory isn't bound, so they're safe to keep installed globally:
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

/** Marks our entries in settings.json so install/uninstall can find them. */
const MARK = "# kiwi";
/** What our hooks were tagged with before the rename; cleaned up on (un)install. */
const OLD_MARKS = ["# channel-one", "# modelchannel"];
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

function withoutOurs(entries: HookEntry[] | undefined): HookEntry[] {
  return (entries ?? [])
    .map((e) => ({ ...e, hooks: e.hooks.filter((h) => ![MARK, ...OLD_MARKS].some((m) => h.command.includes(m))) }))
    .filter((e) => e.hooks.length > 0);
}

/** Install (or refresh) our hooks in the user's Claude Code settings. Returns the settings path. */
export function installHooks(): string {
  const s = readSettings();
  s.hooks ??= {};
  for (const [event, arg] of Object.entries(EVENTS)) {
    s.hooks[event] = [
      ...withoutOurs(s.hooks[event]),
      { hooks: [{ type: "command", command: `${selfCommand()} hook ${arg} ${MARK}`, timeout: event === "UserPromptSubmit" ? 20 : 30 }] },
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
  return Object.keys(EVENTS).every((e) => s.hooks?.[e]?.some((x) => x.hooks.some((h) => h.command.includes(MARK))));
}

/** Install automatically when an agent joins from inside Claude Code (opt out with KIWI_NO_HOOKS=1). */
export function autoInstallHooks(): string | null {
  if (process.env.KIWI_NO_HOOKS || !process.env.CLAUDECODE) return null;
  try {
    // Installed, but by an older version (different path or marker)? Refresh them.
    return hooksInstalled() && !OLD_MARKS.some((m) => JSON.stringify(readSettings()).includes(m)) ? null : installHooks();
  } catch {
    return null;
  }
}

// ---------- running a hook ----------

interface HookInput {
  session_id?: string;
  cwd?: string;
  stop_hook_active?: boolean;
}

/** Remember when we last blocked a session's stop for being deaf, so we nag at most every 10 minutes. */
function nagDue(session: string): boolean {
  const dir = join(home(), "hook-state");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, encodeURIComponent(session || "unknown"));
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
      return process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } }));
    }

    if (event === "prompt") {
      const unread = await unreadText(s);
      const lines: string[] = [];
      if (unread) lines.push(`New Kiwi Channels messages for you (${b.alias}):`, unread);
      if (!listening) lines.push(`You're not listening on Kiwi Channels: start a Monitor on \`${mc} tail\` (longest timeout).`);
      if (lines.length) process.stdout.write(lines.join("\n"));
      return;
    }

    if (event === "stop") {
      const unread = await unreadText(s);
      if (unread) {
        return process.stdout.write(
          JSON.stringify({ decision: "block", reason: `Before stopping: unread Kiwi Channels messages for you. Handle them (answer with \`${mc} reply N "…"\`):\n${unread}` }),
        );
      }
      if (!listening && !input.stop_hook_active && nagDue(input.session_id ?? "")) {
        return process.stdout.write(
          JSON.stringify({
            decision: "block",
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
