// Local state in ~/.modelchannel (override with MC_HOME):
//   config.json            joined channels and their derived keys
//   cursors/<ch>.<agent>   last sequence number each agent has consumed

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChannelKeys } from "./crypto.ts";

/**
 * Public relay used when neither --relay nor MC_RELAY is given. Empty until
 * the hosted relay is deployed.
 */
export const DEFAULT_RELAY = "";

export interface ChannelConfig extends ChannelKeys {
  relay: string;
  /** Default agent name for this channel on this machine. */
  as?: string;
}

export interface Config {
  default?: string;
  channels: Record<string, ChannelConfig>;
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
