// Local state in ~/.kiwi (override with KIWI_HOME):
//   config.json            joined channels: room, pinned owner keys, channel keys by epoch
//   identities/<room>/<n>  each agent's keys for one channel, destroyed with it
//   cursors/<ch>.<agent>   last sequence number each agent has consumed
//   cache/<room>.jsonl     decrypted, verified messages (so state folds are fast)

import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChannelAccess } from "./crypto.ts";
import { generateIdentity, withExchangeKey, type Identity } from "./identity.ts";
import type { Message } from "./protocol.ts";

/** Public relay used when neither --relay nor KIWI_RELAY is given. */
export const DEFAULT_RELAY = "https://channel-one.modelchannel.workers.dev";

export interface ChannelConfig extends ChannelAccess {
  relay: string;
  /** The join code (it only lets others *ask* to join). */
  code: string;
  /** Default agent name for this channel on this machine. */
  as?: string;
  /** This machine holds the owner key (the human who approves joins). */
  owner?: string;
}

/** A join request this machine is waiting on. */
export interface PendingJoin {
  code: string;
  relay: string;
  as: string;
  alias: string;
  requestId: string;
  verify: string;
}

export interface Config {
  default?: string;
  channels: Record<string, ChannelConfig>;
  pending?: Record<string, PendingJoin>;
  /** Working directory → the agent working there (read by the Claude Code hooks). */
  bindings?: Record<string, { alias: string; as: string }>;
}

export function home(): string {
  if (process.env.KIWI_HOME) return process.env.KIWI_HOME;
  const dir = join(homedir(), ".kiwi");
  if (existsSync(dir)) return dir;
  // Carry state over from the project's earlier names, once. An older client may still be
  // running against ~/.channel-one: don't pull its files out from under it; use it in place.
  for (const name of [".channel-one", ".modelchannel"]) {
    const old = join(homedir(), name);
    if (!existsSync(old)) continue;
    if (oldClientRunning(old)) return old;
    renameSync(old, dir);
    return dir;
  }
  return dir;
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

export function writePrivate(path: string, data: string): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {}
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
  const lock = join(home(), "config.lock");
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
      if (Date.now() > deadline) throw new Error(`couldn't lock ${lock}; if no mc is running, delete it`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
  try {
    const cfg = loadConfig();
    change(cfg);
    saveConfig(cfg);
    return cfg;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function cursorPath(channel: string, agent: string): string {
  return join(home(), "cursors", `${safe(channel)}.${safe(agent)}`);
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
    if (c) cfg.channels[alias] = { ...c, epoch: access.epoch, keys: { ...c.keys, ...access.keys } };
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
    rmSync(cachePath(c.roomId), { force: true });
    rmSync(join(home(), "downloads", c.roomId), { recursive: true, force: true });
  }
  const dir = join(home(), "cursors");
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.startsWith(`${safe(alias)}.`)) rmSync(join(dir, f), { force: true });
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

/** Cached messages for a room, oldest first, deduplicated by seq. */
export function readCache(roomId: string): Message[] {
  const path = cachePath(roomId);
  if (!existsSync(path)) return [];
  const bySeq = new Map<number, Message>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const m = JSON.parse(line) as Message;
      bySeq.set(m.seq, m);
    } catch {
      // A torn final line from a concurrent append; the next sync refetches it.
    }
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function appendCache(roomId: string, messages: Message[]): void {
  if (!messages.length) return;
  const path = cachePath(roomId);
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  appendFileSync(path, messages.map((m) => JSON.stringify(m)).join("\n") + "\n", { mode: 0o600 });
}
