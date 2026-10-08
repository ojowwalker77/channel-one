// Local state in ~/.modelchannel (override with MC_HOME):
//   config.json            joined channels: room, pinned owner keys, channel keys by epoch
//   identities/<agent>     each agent's Ed25519 signing key
//   cursors/<ch>.<agent>   last sequence number each agent has consumed
//   cache/<room>.jsonl     decrypted, verified messages (so state folds are fast)

import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChannelAccess } from "./crypto.ts";
import { generateIdentity, withExchangeKey, type Identity } from "./identity.ts";
import type { Message } from "./protocol.ts";

/** Public relay used when neither --relay nor MC_RELAY is given. */
export const DEFAULT_RELAY = "https://modelchannel-relay.modelchannel.workers.dev";

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
  return process.env.MC_HOME ?? join(homedir(), ".modelchannel");
}

function writePrivate(path: string, data: string): void {
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

export async function loadIdentity(name: string): Promise<Identity> {
  const path = join(home(), "identities", `${safe(name)}.json`);
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

/** Persist a channel's access after keys change (rotation). */
export function saveAccess(alias: string, access: ChannelAccess): void {
  const cfg = loadConfig();
  const c = cfg.channels[alias];
  if (!c) return;
  cfg.channels[alias] = { ...c, epoch: access.epoch, keys: { ...c.keys, ...access.keys } };
  saveConfig(cfg);
}

/**
 * Forget a channel on this machine: config, keys, message cache, cursors and
 * downloads. Used when leaving, when removed, and when the owner closes it.
 */
export function wipeChannel(alias: string): void {
  const cfg = loadConfig();
  const c = cfg.channels[alias];
  delete cfg.channels[alias];
  if (cfg.default === alias) cfg.default = Object.keys(cfg.channels)[0];
  for (const [dir, b] of Object.entries(cfg.bindings ?? {})) if (b.alias === alias) delete cfg.bindings![dir];
  saveConfig(cfg);
  if (c) {
    rmSync(cachePath(c.roomId), { force: true });
    rmSync(join(home(), "downloads", c.roomId), { recursive: true, force: true });
  }
  const dir = join(home(), "cursors");
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.startsWith(`${safe(alias)}.`)) rmSync(join(dir, f), { force: true });
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
