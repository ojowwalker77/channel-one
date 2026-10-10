// Local state in ~/.kiwi (override with KIWI_HOME):
//   config.json            joined channels: room, pinned owner keys, channel keys by epoch
//   identities/<room>/<n>  each agent's keys for one channel, destroyed with it
//   cursors/<ch>/<agent>   last sequence number each agent has consumed
//   cache/<room>.jsonl     decrypted, verified messages (so state folds are fast)

import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { ChannelAccess } from "./crypto.ts";
import { generateIdentity, withExchangeKey, type Identity } from "./identity.ts";
import type { Message } from "./protocol.ts";
import type { Signed, SigningBudget } from "./sas.ts";

/** Public relay used when neither --relay nor KIWI_RELAY is given. */
export const DEFAULT_RELAY = "https://channels.kiwiinit.com";

export interface ChannelConfig extends ChannelAccess {
  relay: string;
  /** The join code (it only lets others *ask* to join). */
  code: string;
  /** Default agent name for this channel on this machine. */
  as?: string;
  /** This machine holds the owner key (the human who approves joins). */
  owner?: string;
  /** The channel's name, as its owner set it (sealed: only members can read it). */
  title?: string;
}

/** A join request this machine is waiting on. */
export interface PendingJoin {
  code: string;
  relay: string;
  as: string;
  alias: string;
  requestId: string;
}

export interface Config {
  default?: string;
  channels: Record<string, ChannelConfig>;
  pending?: Record<string, PendingJoin>;
  /** Working directory → the agent working there (read by the Claude Code hooks). */
  bindings?: Record<string, { alias: string; as: string }>;
  /** What this computer's person chose in `kiwi setup` about Claude Code hooks. */
  claudeHooks?: "on" | "off";
}

export function home(): string {
  if (process.env.KIWI_HOME) {
    tightenHome(process.env.KIWI_HOME);
    return process.env.KIWI_HOME;
  }
  const dir = join(homedir(), ".kiwi");
  if (existsSync(dir)) {
    tightenHome(dir);
    return dir;
  }
  // Carry state over from the project's earlier names, once. An older client may still be
  // running against ~/.channel-one: don't pull its files out from under it; use it in place.
  for (const name of [".channel-one", ".modelchannel"]) {
    const old = join(homedir(), name);
    if (!existsSync(old)) continue;
    if (oldClientRunning(old)) {
      tightenHome(old);
      return old;
    }
    renameSync(old, dir);
    tightenHome(dir);
    return dir;
  }
  return dir;
}

/** Directories already walked this process. home() is on the hot path; one walk is enough. */
const tightened = new Set<string>();

/**
 * Make an existing home private, once: the directory and every real subdirectory
 * except `bin` become 0700, and files already under `downloads` become 0600.
 * `bin` stays as installed (0755) so the executable keeps working; the parent
 * is what stops other accounts. Symlinks are not followed.
 */
function tightenHome(dir: string): void {
  if (tightened.has(dir)) return;
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  tightened.add(dir);
  try {
    chmodSync(dir, 0o700);
    lockTree(dir, dir);
  } catch {
    // A file this user can't chmod must not stop startup.
  }
}

function lockTree(dir: string, root: string): void {
  const downloads = join(root, "downloads");
  const privateFiles = dir === downloads || dir.startsWith(downloads + sep);
  for (const name of readdirSync(dir)) {
    if (dir === root && name === "bin") continue;
    const p = join(dir, name);
    let child;
    try {
      child = lstatSync(p);
    } catch {
      continue;
    }
    if (child.isSymbolicLink()) continue;
    if (child.isDirectory()) {
      try {
        chmodSync(p, 0o700);
      } catch {
        continue;
      }
      lockTree(p, root);
      continue;
    }
    if (child.isFile() && privateFiles) {
      try {
        chmodSync(p, 0o600);
      } catch {}
    }
  }
}

/** Whether a live process is still listening out of an old state directory. */
function oldClientRunning(dir: string): boolean {
  const listeners = join(dir, "listeners");
  if (!existsSync(listeners)) return false;
  return readdirSync(listeners).some((f) => {
    const pid = Number(f.split(".").pop());
    try {
      return pid > 0 && (process.kill(pid, 0), true);
    } catch {
      return false;
    }
  });
}

/** The join checks this computer signed as a channel's owner, per channel (see sas.ts). */
export const signingBudget: SigningBudget = {
  load(roomId) {
    try {
      const t = JSON.parse(readFileSync(join(home(), "checks", `${safe(roomId)}.json`), "utf8")) as unknown;
      return Array.isArray(t) ? (t as Signed[]) : [];
    } catch {
      return [];
    }
  },
  save(roomId, signed) {
    writePrivate(join(home(), "checks", `${safe(roomId)}.json`), JSON.stringify(signed));
  },
};

export function writePrivate(path: string, data: string): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  // Exclusive create. The first name is predictable, so a symlink planted there
  // must fail the open instead of being followed. Leave it in place and use a
  // fresh name; unlinking it would reopen the race.
  const names = [`${path}.${process.pid}.tmp`, `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`];
  let blocked: unknown;
  for (const tmp of names) {
    try {
      writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
    } catch (err) {
      if (fileExists(err)) {
        blocked = err;
        continue;
      }
      throw err;
    }
    try {
      renameSync(tmp, path);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {}
      throw err;
    }
    try {
      chmodSync(path, 0o600);
    } catch {}
    return;
  }
  throw blocked;
}

function fileExists(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EEXIST";
}

export function loadConfig(): Config {
  const path = join(home(), "config.json");
  if (!existsSync(path)) return { channels: {} };
  return JSON.parse(readFileSync(path, "utf8")) as Config;
}

export function saveConfig(cfg: Config): void {
  writePrivate(join(home(), "config.json"), JSON.stringify(cfg, null, 2) + "\n");
}

/**
 * Change the config safely while other mc processes (other agents on this
 * machine, their hooks and listeners) do the same: take a lock, read the
 * latest version, apply the change, write it back. A plain load-then-save
 * would silently undo whatever another agent wrote in between.
 */
export function updateConfig(change: (cfg: Config) => void): Config {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  return withLock(join(home(), "config.lock"), () => {
    const cfg = loadConfig();
    change(cfg);
    saveConfig(cfg);
    return cfg;
  });
}

/** Run `fn` while holding a lock directory, so concurrent kiwi processes take turns. */
function withLock<T>(lock: string, fn: () => T): T {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      // A lock left behind by a crashed process expires after a few seconds.
      try {
        const age = Date.now() - statSync(lock).mtimeMs;
        if (age > 5_000) rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error(`couldn't lock ${lock}; if no kiwi is running, delete it`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * A name as a file name, reversibly: anything but lowercase letters, digits, _ . and - is
 * spelled out (~hex~), so "Win" and "win", or "josé" and "jos_", never share a file, even on
 * case-insensitive disks.
 */
function safe(s: string): string {
  const out = [...s].map((c) => (/[a-z0-9_.-]/.test(c) ? c : `~${c.codePointAt(0)!.toString(16)}~`)).join("");
  // "." and ".." are path segments, not names. Spell them out, the way segment() does.
  if (out === ".") return "~2e~";
  if (out === "..") return "~2e~~2e~";
  return out;
}

/** Each channel's cursors live in a folder of their own, so forgetting one never touches another's. */
function cursorDir(channel: string): string {
  return join(home(), "cursors", safe(channel));
}

function cursorPath(channel: string, agent: string): string {
  return join(cursorDir(channel), safe(agent));
}

export function readCursor(channel: string, agent: string): number | null {
  const path = cursorPath(channel, agent);
  return existsSync(path) ? Number(readFileSync(path, "utf8").trim()) || 0 : null;
}

export function writeCursor(channel: string, agent: string, seq: number): void {
  writePrivate(cursorPath(channel, agent), `${seq}\n`);
}

/** Sequence numbers already delivered out of band (e.g. by `ask --wait`), so tail/wait skip them. */
function seenPath(channel: string, agent: string): string {
  return `${cursorPath(channel, agent)}.seen`;
}

export function readSeen(channel: string, agent: string): Set<number> {
  const path = seenPath(channel, agent);
  if (!existsSync(path)) return new Set();
  return new Set(readFileSync(path, "utf8").split(/\s+/).filter(Boolean).map(Number));
}

export function markSeen(channel: string, agent: string, seqs: number[]): void {
  if (!seqs.length) return;
  const cursor = readCursor(channel, agent) ?? 0;
  const all = [...readSeen(channel, agent), ...seqs].filter((s) => s > cursor);
  writePrivate(seenPath(channel, agent), [...new Set(all)].sort((a, b) => a - b).join("\n") + "\n");
}

/**
 * An agent's keys for one channel. Keys are never shared between channels, so
 * wiping a channel (close, leave, removal) destroys the only keys that could
 * open its wrapped channel keys: any copy of the relay's data, backups
 * included, becomes permanently unreadable.
 */
export async function loadIdentity(name: string, roomId: string): Promise<Identity> {
  const path = join(identityDir(roomId), `${safe(name)}.json`);
  // Keys from before identities were per channel move into the channel that used them.
  const legacy = join(home(), "identities", `${safe(name)}.json`);
  if (!existsSync(path) && existsSync(legacy)) {
    writePrivate(path, readFileSync(legacy, "utf8"));
    rmSync(legacy, { force: true });
  }
  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, "utf8")) as Identity;
    const id = await withExchangeKey(stored);
    if (id !== stored) writePrivate(path, JSON.stringify(id, null, 2) + "\n");
    return id;
  }
  const id = await generateIdentity(name);
  writePrivate(path, JSON.stringify(id, null, 2) + "\n");
  return id;
}

function identityDir(roomId: string): string {
  return join(home(), "identities", safe(roomId));
}

/** Agent names this machine holds keys for in a channel (the owner's key included). */
/** Throw away one agent's key for a channel (say, after it was removed), so the next join makes a fresh one. */
export function forgetIdentity(name: string, roomId: string): void {
  rmSync(join(identityDir(roomId), `${safe(name)}.json`), { force: true });
}

export function identitiesIn(roomId: string): string[] {
  const dir = identityDir(roomId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return (JSON.parse(readFileSync(join(dir, f), "utf8")) as Identity).name;
      } catch {
        return null;
      }
    })
    .filter((n): n is string => !!n);
}

/** Destroy this machine's keys for a channel it never got into (denied, abandoned). */
export function forgetIdentities(roomId: string): void {
  rmSync(identityDir(roomId), { recursive: true, force: true });
}

/** Persist a channel's access after keys change (rotation). */
export function saveAccess(alias: string, access: ChannelAccess): void {
  updateConfig((cfg) => {
    const c = cfg.channels[alias];
    if (c) cfg.channels[alias] = { ...c, epoch: access.epoch, keys: { ...c.keys, ...access.keys }, ...(access.signedTitle ? { signedTitle: true } : {}) };
  });
}

/**
 * Forget a whole channel on this machine: config, every local agent's keys,
 * message cache, cursors and downloads. Only for a channel that is gone for
 * everyone (its owner closed it, or this machine's owner closed it).
 */
export function wipeChannel(alias: string): void {
  let c: ChannelConfig | undefined;
  updateConfig((cfg) => {
    c = cfg.channels[alias];
    delete cfg.channels[alias];
    if (cfg.default === alias) delete cfg.default;
    for (const [dir, b] of Object.entries(cfg.bindings ?? {})) if (b.alias === alias) delete cfg.bindings![dir];
  });
  if (c) {
    rmSync(identityDir(c.roomId), { recursive: true, force: true });
    for (const suffix of ["", ".seq"]) rmSync(cachePath(c.roomId) + suffix, { force: true });
    rmSync(join(home(), "downloads", c.roomId), { recursive: true, force: true });
  }
  rmSync(cursorDir(alias), { recursive: true, force: true });
}

/**
 * Forget one agent's membership: it left or was removed. Other agents on this
 * machine in the same channel keep theirs; the channel itself is forgotten
 * only once no local agent is left in it.
 */
export function forgetMember(alias: string, name: string): void {
  const c = loadConfig().channels[alias];
  if (!c) return;
  forgetIdentity(name, c.roomId);
  rmSync(cursorPath(alias, name), { force: true });
  rmSync(seenPath(alias, name), { force: true });
  const left = identitiesIn(c.roomId).filter((n) => n !== c.owner);
  // The owner key stays as long as the channel exists: without it, nobody can ever close it.
  const ownerHere = !!c.owner && identitiesIn(c.roomId).includes(c.owner);
  if (!left.length && !ownerHere) return wipeChannel(alias);
  updateConfig((cfg) => {
    for (const [dir, b] of Object.entries(cfg.bindings ?? {})) if (b.alias === alias && b.as === name) delete cfg.bindings![dir];
    const ch = cfg.channels[alias];
    if (ch?.as === name) ch.as = left[0] ?? ch.owner;
  });
}

function cachePath(roomId: string): string {
  return join(home(), "cache", `${roomId}.jsonl`);
}

/**
 * Cached messages for a room, oldest first. Every listener on this machine shares the file, so
 * older versions could write a message more than once: if that happened, the file is rewritten
 * once without the copies.
 */
export function readCache(roomId: string): Message[] {
  const path = cachePath(roomId);
  if (!existsSync(path)) return [];
  const bySeq = new Map<number, Message>();
  let lines = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    lines++;
    try {
      const m = JSON.parse(line) as Message;
      bySeq.set(m.seq, m);
    } catch {
      // A torn final line from a crash mid-write; the next sync refetches it.
    }
  }
  const messages = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  if (lines > messages.length) {
    withLock(`${path}.lock`, () => {
      writePrivate(path, messages.map((m) => JSON.stringify(m)).join("\n") + (messages.length ? "\n" : ""));
      writePrivate(`${path}.seq`, String(messages.at(-1)?.seq ?? 0));
    });
  }
  return messages;
}

/** Add messages to a room's cache, skipping any another listener on this machine already wrote. */
export function appendCache(roomId: string, messages: Message[]): void {
  if (!messages.length) return;
  const path = cachePath(roomId);
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  withLock(`${path}.lock`, () => {
    // The highest seq written so far; messages arrive in order, so anything at or below it is a copy.
    const last = existsSync(`${path}.seq`) ? Number(readFileSync(`${path}.seq`, "utf8")) || 0 : 0;
    const fresh = messages.filter((m) => m.seq > last);
    if (!fresh.length) return;
    appendFileSync(path, fresh.map((m) => JSON.stringify(m)).join("\n") + "\n", { mode: 0o600 });
    writePrivate(`${path}.seq`, String(fresh.at(-1)!.seq));
  });
}
