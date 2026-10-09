// `kiwi sh`: the channel as read-only files, queried with one shell script per call.
//
// The shell is just-bash, a shell simulated in TypeScript: no process is spawned
// and it can only see the files we hand it. Safety comes in layers:
//
//   - The files are made here, from verified messages and the state folded from
//     them, which this identity can already read. Nothing comes from config,
//     identities, keys, cursors, the cache file, the environment or the disk.
//   - The file system is read-only (writes fail), and each run gets a new one,
//     so nothing a script does outlives it.
//   - Only the read-only text commands below exist. There is no network, python,
//     javascript or sqlite, and nothing that sends, claims or changes the channel:
//     writes stay on the typed CLI commands and MCP tools.
//   - The "hardened" limit profile, plus our own caps on script size, wall time
//     and output, so a bad script ends with an error instead of hanging.
//   - just-bash's defense-in-depth stays on, with no exclusions.

import { Bash, InMemoryFs, type CommandName, type IFileSystem } from "just-bash";
import { identitiesIn, loadConfig, readCursor } from "./config.ts";
import { AgentSession, wants } from "./agent.ts";
import { describeEvent, formatClaims, formatMessage, formatStatus, formatTask, memberJson, statusJson } from "./format.ts";
import type { Message } from "./protocol.ts";
import { taskId, type ChannelState } from "./state.ts";

/**
 * Read-only text tools. Anything that writes, waits, archives or reaches out is left out.
 * Never add xz or zstd: their libraries are left out of the binary (package.json build), so
 * just-bash would import them at runtime from wherever kiwi runs.
 */
const COMMANDS: CommandName[] = [
  "cat", "echo", "printf", "ls", "pwd", "readlink", "stat", "file", "find", "tree", "du", "basename", "dirname",
  "head", "tail", "wc", "grep", "fgrep", "egrep", "rg", "sed", "awk", "sort", "uniq", "comm", "cut", "paste",
  "tr", "rev", "nl", "fold", "expand", "unexpand", "strings", "column", "join", "tac", "od", "diff",
  "jq", "yq", "xan", "base64", "md5sum", "sha1sum", "sha256sum", "xargs", "seq", "expr", "date",
  "true", "false", "which", "help",
];

export const MAX_SCRIPT_BYTES = 16 * 1024;
export const MAX_OUTPUT_CHARS = 64 * 1024;
export const MAX_RUN_MS = 5_000;

export interface ShResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** One channel as this identity sees it: the inputs to its files, and nothing else. */
export interface ChannelView {
  alias: string;
  me: string;
  messages: Message[];
  state: ChannelState;
  /** The read cursor; messages after it that the agent wants are its inbox. */
  cursor: number;
}

export const README = `Channel files (read-only; every run starts fresh). Writes go through the kiwi commands/tools, never here.
  /channel                 the current channel
    README                 this file
    me                     {"name","role","channel"}
    status                 what \`kiwi status\` prints (members, load, open asks, tasks, claims, facts)
    status.json            members with role and load, as \`kiwi status --json\`
    log.jsonl              every verified message, one JSON object per line: seq, at, from, to, kind, re, body, op, images
    msgs/000042.txt        one message per file, in the \`kiwi log\` one-line format
    inbox/000042.txt       your unread messages (reading them here doesn't mark them read)
    tasks/T12.md           one task per file: state, owner, deps, detail, notes
    members/<name>.json    role, about, kind, owner, sponsor, lastSeen, load
    facts/<key>            each shared fact's value
    claims                 active path claims
  /channels/<alias>/…      other channels this same name belongs to. Not this one.
                           All channels: /channel plus /channels/*. Loaded when
                           the script mentions /channels.
Forged messages never appear. Names and keys that aren't safe as file names are %-encoded.
Examples: jq -r 'select(.kind=="ask") | "#\\(.seq) \\(.from): \\(.body)"' log.jsonl
          grep -l 'state: todo' tasks/*.md · jq -r 'select(.load.level=="free") | .name' members/*.json`;

/** A name or key as one safe path segment: no "/", no "..", no control characters. */
export function segment(s: string): string {
  const enc = encodeURIComponent(s).replace(/\*/g, "%2A");
  return enc === "." ? "%2E" : enc === ".." ? "%2E%2E" : enc || "%00";
}

const pad = (seq: number) => String(seq).padStart(6, "0");

function channelTree(v: ChannelView, now: number): Record<string, string> {
  const { state, me } = v;
  // Only what the owner-signed roster vouches for: forged messages are dropped before anything is built.
  const verified = v.messages.filter((m) => state.trust.get(m.seq) !== "forged");
  // A key ending in "/" is a directory, so empty ones (no unread, no facts) still exist.
  const files: Record<string, string> = { "inbox/": "", "msgs/": "", "tasks/": "", "members/": "", "facts/": "" };
  const role = state.members.get(me)?.role ?? null;
  files["README"] = README + "\n";
  files["me"] = JSON.stringify({ name: me, role, channel: v.alias }) + "\n";
  files["status"] = formatStatus({ alias: v.alias, me, state, online: new Map(), unread: 0, now }) + "\n";
  // Presence isn't known here (it takes a live query), so "online" is left out rather than guessed.
  const status = statusJson({ alias: v.alias, me, state, online: new Map(), unread: 0, now });
  files["status.json"] = JSON.stringify({ ...status, members: status.members.map(({ online: _, ...m }) => m) }, null, 2) + "\n";
  files["log.jsonl"] = verified.map((m) => JSON.stringify(logEntry(m, state)) + "\n").join("");
  for (const m of verified) {
    const line = formatMessage(m, "verified", state) + "\n";
    files[`msgs/${pad(m.seq)}.txt`] = line;
    if (m.seq > v.cursor && wants(me, m, state)) files[`inbox/${pad(m.seq)}.txt`] = line;
  }
  for (const t of state.tasks.values()) files[`tasks/${taskId(t.id)}.md`] = formatTask(state, t, now) + "\n";
  for (const m of state.members.values()) {
    if (!m.active) continue;
    const { online: _, ...json } = memberJson(state, m.name, new Map(), now);
    files[`members/${segment(m.name)}.json`] = JSON.stringify(json, null, 2) + "\n";
  }
  for (const f of state.facts.values()) files[`facts/${segment(f.key)}`] = f.value + "\n";
  files["claims"] = formatClaims(state, now) + "\n";
  return files;
}

function logEntry(m: Message, state: ChannelState) {
  return {
    seq: m.seq,
    at: new Date(m.rts ?? m.ts).toISOString(),
    from: m.from,
    to: m.to?.length ? m.to : "all",
    kind: m.kind,
    ...(m.re?.length ? { re: m.re } : {}),
    body: m.kind === "event" ? describeEvent(m, state) : m.body,
    ...(m.ev ? { op: m.ev.op } : {}),
    ...(m.imgs?.length ? { images: m.imgs.map((i) => i.name) } : {}),
  };
}

/** The files for `views`: the first at /channel only, every later one at /channels/<alias>. */
export function channelFiles(views: ChannelView[], now = Date.now()): Record<string, string> {
  const files: Record<string, string> = {};
  views.forEach((v, i) => {
    const tree = channelTree(v, now);
    const root = i === 0 ? "/channel" : `/channels/${segment(v.alias)}`;
    for (const [p, body] of Object.entries(tree)) files[`${root}/${p}`] = body;
  });
  return files;
}

/** What one session contributes: its log, its folded state and its cursor. Reads only; marks nothing. */
export async function channelView(s: AgentSession): Promise<ChannelView> {
  const { messages, state } = await s.state();
  return { alias: s.alias, me: s.me, messages, state, cursor: readCursor(s.alias, s.me) ?? state.head };
}

/**
 * The views a script needs: this session's channel, plus, when the script mentions
 * /channels, every other channel this same name is a member of on this machine
 * (never another local agent's: their keys aren't ours to use).
 */
export async function sessionViews(s: AgentSession, script: string): Promise<ChannelView[]> {
  const views = [await channelView(s)];
  if (!script.includes("/channels")) return views;
  const cfg = loadConfig();
  for (const alias of Object.keys(cfg.channels).sort()) {
    const c = cfg.channels[alias]!;
    if (alias === s.alias || !identitiesIn(c.roomId).includes(s.me)) continue;
    try {
      views.push(await channelView(await AgentSession.open(alias, c, s.me)));
    } catch {
      // A channel that's gone or unreachable just isn't there; the rest still are.
    }
  }
  return views;
}

/** Run `script` against `files` (paths ending in "/" are empty directories). Never throws: every failure is a nonzero exit with a reason on stderr. */
export async function runSh(files: Record<string, string>, script: string, opts: { cwd?: string } = {}): Promise<ShResult> {
  if (new TextEncoder().encode(script).length > MAX_SCRIPT_BYTES) return { stdout: "", stderr: `kiwi sh: script longer than ${MAX_SCRIPT_BYTES} bytes\n`, exitCode: 2 };
  const inner = new InMemoryFs(Object.fromEntries(Object.entries(files).filter(([p]) => !p.endsWith("/"))));
  for (const p of Object.keys(files)) if (p.endsWith("/")) inner.mkdirSync(p.slice(0, -1), { recursive: true });
  inner.writeFileSync(DEV_NULL, "");
  const fs = new ReadOnlyFs(inner);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = new AbortController();
  try {
    const bash = new Bash({
      fs,
      cwd: opts.cwd ?? "/channel",
      env: { HOME: "/channel", PWD: opts.cwd ?? "/channel", PATH: "/usr/bin:/bin", USER: "agent", LANG: "C.UTF-8" },
      commands: COMMANDS,
      executionLimitProfile: "hardened",
      executionLimits: { maxExecutionTimeMs: MAX_RUN_MS, maxOutputSize: MAX_OUTPUT_CHARS * 4 },
      defenseInDepth: true,
      processInfo: { pid: 1, ppid: 0, uid: 1000, gid: 1000 },
    });
    // just-bash lays out /bin, /dev and friends while it's built; from here on nothing may change.
    fs.lock();
    const timeout = new Promise<ShResult>((resolve) => {
      timer = setTimeout(() => (stop.abort(), resolve({ stdout: "", stderr: `kiwi sh: stopped after ${MAX_RUN_MS / 1000}s\n`, exitCode: 124 })), MAX_RUN_MS + 1_000);
    });
    // failglob names an unmatched pattern (`bash: no match: …`) and the script continues.
    // just-bash leaves failglob off, which is why an empty glob used to pass through silently.
    const run = bash.exec(`shopt -s failglob\n${script}`, { replaceEnv: false, signal: stop.signal }).then((r) => ({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }));
    const r = await Promise.race([run, timeout]);
    return { stdout: cap(r.stdout), stderr: cap(r.stderr), exitCode: r.exitCode };
  } catch (err) {
    // A failed redirect into the read-only file system rejects instead of exiting nonzero (just-bash #557).
    return { stdout: "", stderr: `kiwi sh: ${err instanceof Error ? err.message : String(err)}\n`, exitCode: 1 };
  } finally {
    clearTimeout(timer);
  }
}

function cap(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + `\n[kiwi sh: output cut at ${MAX_OUTPUT_CHARS} characters; narrow the query]\n` : s;
}

/** The one writable path: a discard, so the usual `2>/dev/null` works. */
const DEV_NULL = "/dev/null";

function readOnly(path: string): never {
  throw Object.assign(new Error(`EROFS: read-only file system, '${path}'`), { code: "EROFS" });
}

/** Passes reads through; once locked, refuses every change (writes to /dev/null vanish). */
class ReadOnlyFs implements IFileSystem {
  private locked = false;
  constructor(private readonly inner: InMemoryFs) {}
  lock(): void {
    this.locked = true;
  }
  private discards(path: string): boolean {
    return this.locked && this.inner.resolvePath("/", path) === DEV_NULL;
  }
  private guard(path: string): void {
    if (this.locked) readOnly(path);
  }

  readFile: IFileSystem["readFile"] = (p, o) => this.inner.readFile(p, o);
  readFileBuffer: IFileSystem["readFileBuffer"] = (p) => this.inner.readFileBuffer(p);
  readFileBytes: NonNullable<IFileSystem["readFileBytes"]> = (p) => this.inner.readFileBytes(p);
  exists: IFileSystem["exists"] = (p) => this.inner.exists(p);
  stat: IFileSystem["stat"] = (p) => this.inner.stat(p);
  lstat: IFileSystem["lstat"] = (p) => this.inner.lstat(p);
  readdir: IFileSystem["readdir"] = (p) => this.inner.readdir(p);
  readdirWithFileTypes: NonNullable<IFileSystem["readdirWithFileTypes"]> = (p) => this.inner.readdirWithFileTypes(p);
  readlink: IFileSystem["readlink"] = (p) => this.inner.readlink(p);
  realpath: IFileSystem["realpath"] = (p) => this.inner.realpath(p);
  resolvePath: IFileSystem["resolvePath"] = (b, p) => this.inner.resolvePath(b, p);
  getAllPaths: IFileSystem["getAllPaths"] = () => this.inner.getAllPaths();

  writeFile: IFileSystem["writeFile"] = async (p, c, o) => (this.discards(p) ? undefined : (this.guard(p), this.inner.writeFile(p, c, o)));
  appendFile: IFileSystem["appendFile"] = async (p, c, o) => (this.discards(p) ? undefined : (this.guard(p), this.inner.appendFile(p, c, o)));
  mkdir: IFileSystem["mkdir"] = async (p, o) => (this.guard(p), this.inner.mkdir(p, o));
  rm: IFileSystem["rm"] = async (p, o) => (this.guard(p), this.inner.rm(p, o));
  cp: IFileSystem["cp"] = async (s, d, o) => (this.guard(d), this.inner.cp(s, d, o));
  mv: IFileSystem["mv"] = async (s, d) => (this.guard(s), this.inner.mv(s, d));
  chmod: IFileSystem["chmod"] = async (p, m) => (this.guard(p), this.inner.chmod(p, m));
  symlink: IFileSystem["symlink"] = async (t, l) => (this.guard(l), this.inner.symlink(t, l));
  link: IFileSystem["link"] = async (e, n) => (this.guard(n), this.inner.link(e, n));
  utimes: IFileSystem["utimes"] = async (p, a, m) => (this.guard(p), this.inner.utimes(p, a, m));
}
