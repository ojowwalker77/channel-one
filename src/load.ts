// How busy each member is, read from the task board and claims every member
// already holds (decrypted, in their own folded state). Nothing new crosses the
// relay: a coordinator, the dashboard and `kiwi status` all compute the same
// answer from the same events.

import { taskId, type ChannelState, type Claim, type Task } from "./state.ts";

export type LoadLevel = "free" | "busy" | "overloaded";

export interface Load {
  level: LoadLevel;
  /** Tasks they're working on now ("doing"). */
  current: Task[];
  /** Tasks assigned to them and not started ("todo"). */
  queued: Task[];
  /** Tasks of theirs waiting on someone else ("blocked", "review"); they don't count as load. Cancelled tasks are off the board. */
  waiting: Task[];
  /** Paths they've claimed, unexpired. */
  claims: Claim[];
}

/** People (and an owner, who is always a person) show load only when they hold tasks; agents always do. */
export function showsLoad(member: { kind?: string; owner?: boolean } | undefined, l: Load): boolean {
  const person = member?.kind === "human" || !!member?.owner;
  return !person || l.level !== "free" || l.waiting.length > 0 || l.claims.length > 0;
}

/** "free", or "busy: doing T12 Fix login · 2 queued", the way status lines read. */
export function loadSummary(l: Load): string {
  const line = loadLine(l);
  return line === "free" ? "free" : `${l.level}: ${line}`;
}

/** Two things at once, or four on their plate, is more than one agent should carry. */
export const OVERLOADED_DOING = 2;
export const OVERLOADED_TOTAL = 4;

export function memberLoad(state: ChannelState, name: string, now = Date.now()): Load {
  const mine = [...state.tasks.values()].filter((t) => t.owner === name).sort((a, b) => a.id - b.id);
  const current = mine.filter((t) => t.state === "doing");
  const queued = mine.filter((t) => t.state === "todo");
  const waiting = mine.filter((t) => t.state === "blocked" || t.state === "review");
  const claims = state.claims.filter((c) => c.owner === name && c.expires > now);
  const level: LoadLevel =
    current.length >= OVERLOADED_DOING || current.length + queued.length >= OVERLOADED_TOTAL ? "overloaded" : current.length + queued.length > 0 ? "busy" : "free";
  return { level, current, queued, waiting, claims };
}

/** "doing T12 Fix login · 2 queued · 1 claim", or "free". */
export function loadLine(l: Load, maxTitle = 40): string {
  const parts: string[] = [];
  const [first, ...more] = l.current;
  if (first) parts.push(`doing ${taskId(first.id)} ${first.title.length > maxTitle ? first.title.slice(0, maxTitle - 1) + "…" : first.title}${more.length ? ` (+${more.length})` : ""}`);
  if (l.queued.length) parts.push(`${l.queued.length} queued`);
  if (l.waiting.length) parts.push(`${l.waiting.length} waiting`);
  if (l.claims.length) parts.push(`${l.claims.length} claim${l.claims.length === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "free";
}

/** The same, as plain data for --json and MCP tools. */
export function loadJson(l: Load) {
  return {
    level: l.level,
    current: l.current.map((t) => ({ id: taskId(t.id), title: t.title })),
    queued: l.queued.map((t) => ({ id: taskId(t.id), title: t.title })),
    waiting: l.waiting.map((t) => ({ id: taskId(t.id), title: t.title, state: t.state })),
    claims: l.claims.map((c) => ({ path: c.path, expires: c.expires })),
  };
}
