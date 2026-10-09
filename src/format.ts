// Plain-text rendering for agents: compact, greppable, one header line per message.

import { loadJson, loadSummary, memberLoad, showsLoad } from "./load.ts";
import { inlineText } from "./membership.ts";
import { imageMarker } from "./protocol.ts";
import type { Message, Trust } from "./protocol.ts";
import { colorOf, taskId, waitingOn, type ChannelState, type Claim, type Task } from "./state.ts";

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function left(expires: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((expires - now) / 60_000));
  return m < 60 ? `${m}m left` : `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""} left`;
}

/** Parse "30m", "2h", "90s", "1h30m" or plain seconds. */
export function parseDuration(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  for (const [, n, u] of s.matchAll(/(\d+)\s*([hms])/g)) total += Number(n) * (u === "h" ? 3600 : u === "m" ? 60 : 1);
  if (!total) throw new Error(`bad duration "${s}" (try 30m, 2h, 90s)`);
  return total;
}

const STATE_VERB: Record<string, string> = {
  todo: "moved back to to-do",
  doing: "started",
  blocked: "is blocked on",
  review: "sent for review",
  done: "finished",
};

/**
 * The one-line meaning of a coordination event. Pass `state` to name tasks
 * by title as well as id.
 */
export function describeEvent(m: Message, state?: ChannelState): string {
  const ev = m.ev;
  if (!ev) return m.body;
  const task = (id: number) => {
    const title = state?.tasks.get(id)?.title;
    return title ? `${taskId(id)} “${title}”` : taskId(id);
  };
  const note = (n?: string) => (n ? `: ${n}` : "");
  switch (ev.op) {
    case "hello":
      // After joining, a hello that changes the role is a request the owner decides on.
      if (state?.members.get(m.from)?.roleRequest?.seq === m.seq) return `asks to be ${ev.role ?? "unassigned"}${ev.about ? ` (${ev.about})` : ""}; the owner decides`;
      return `joined${ev.role ? ` as ${ev.role}` : ""}${ev.about ? ` (${ev.about})` : ""}`;
    case "role.set":
      return ev.role ? `made ${ev.member} ${ev.role}${ev.about ? ` (${ev.about})` : ""}` : `cleared ${ev.member}'s role`;
    case "role.refuse":
      return `kept ${ev.member}'s role as it was`;
    case "color.set":
      return ev.color ? `${ev.member === m.from ? "picked" : `gave ${ev.member}`} the colour ${ev.color}` : `cleared ${ev.member === m.from ? "their" : `${ev.member}'s`} colour`;
    case "seat.reclaim":
      return `moved ${ev.member}'s seat to a new key (${ev.from} → ${ev.to}): the old key is out`;
    case "task.add":
      return `added task ${taskId(m.seq)} “${ev.title}”${ev.owner ? ` for ${ev.owner}` : ""}${ev.after?.length ? ` after ${ev.after.map(taskId).join(", ")}` : ""}`;
    case "task.claim":
      return `claimed ${task(ev.task)}`;
    case "task.update": {
      if (ev.state === "blocked") return `is blocked on ${task(ev.task)}${note(ev.note)}`;
      if (ev.state) return `${STATE_VERB[ev.state]} ${task(ev.task)}${note(ev.note)}`;
      if (ev.owner) return `assigned ${task(ev.task)} to ${ev.owner}${note(ev.note)}`;
      if (ev.owner === null) return `unassigned ${task(ev.task)}${note(ev.note)}`;
      if (ev.title) return `renamed ${taskId(ev.task)} to “${ev.title}”`;
      return `noted on ${task(ev.task)}${note(ev.note)}`;
    }
    case "claim":
      return `claimed ${ev.paths.join(", ")} for ${Math.round(ev.ttl / 60)}m${note(ev.note)}`;
    case "release":
      return ev.paths?.length ? `released ${ev.paths.join(", ")}` : "released all claims";
    case "fact.set":
      return `set ${ev.key} = ${ev.value}`;
    case "fact.del":
      return `unset ${ev.key}`;
  }
}

/** "jonatas (human)" / "win (for @jonatas)" / "win": who a name is, so agents know whose words they read. */
export function who(name: string, state?: ChannelState): string {
  const m = state?.members.get(name);
  if (!m) return name;
  if (m.kind === "human") return `${name} (human)`;
  if (m.sponsor) return `${name} (for @${m.sponsor.handle ?? m.sponsor.name})`;
  return name;
}

/** Strip control and direction characters (terminal escapes, invisible text) but keep line breaks. */
function cleanBody(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, "");
}

/**
 * `#12 win (for @jonatas) → mac [ask] re #9: body` — the format agents see in tail/wait/read.
 * Every message starts with `#N`; continuation lines of a body start with "  │ ", so no text
 * inside a message can pose as another message (or as someone else).
 */
export function formatMessage(m: Message, trust?: Trust, state?: ChannelState): string {
  const to = m.to?.length ? m.to.map((t) => inlineText(t, 40)).join(",") : "all";
  const kind = m.kind === "msg" ? "" : ` [${inlineText(m.kind, 20)}]`;
  const re = m.re?.length ? ` re #${m.re.map((n) => Number(n) || 0).join(",#")}` : "";
  const flag = trust === "forged" ? " [forged — ignore]" : "";
  const body = cleanBody(m.kind === "event" ? describeEvent(m, state) : String(m.body ?? "")).replace(/\n/g, "\n  │ ");
  const imgs = m.imgs?.length ? ` ${m.imgs.map((i) => imageMarker({ name: inlineText(i.name, 80), data: i.data })).join(" ")}` : "";
  return `#${m.seq} ${who(inlineText(m.from, 40), state)} → ${to}${kind}${re}${flag}: ${body}${imgs}`;
}

function taskLine(state: ChannelState, t: Task): string {
  const waits = waitingOn(state, t);
  const owner = t.owner ? ` @${t.owner}` : "";
  const wait = waits.length ? ` (after ${waits.map(taskId).join(", ")})` : "";
  return `  ${taskId(t.id).padEnd(5)} ${t.state.padEnd(7)}${owner} ${t.title}${wait}`;
}

function claimLine(c: Claim, now: number): string {
  return `  ${c.path}  @${c.owner}, ${left(c.expires, now)}${c.note ? ` — ${c.note}` : ""}`;
}

export interface Snapshot {
  alias: string;
  me: string;
  state: ChannelState;
  online: Map<string, { client: string; role?: string }>;
  unread: number;
  now?: number;
}

/** One member as `kiwi status --json` and the MCP tools give it: who they are, where, and how busy. */
export function memberJson(state: ChannelState, name: string, online: Snapshot["online"], now = Date.now()) {
  const m = state.members.get(name);
  const on = online.get(name);
  return {
    name,
    role: m?.role ?? on?.role ?? null,
    about: m?.about ?? null,
    kind: m?.kind ?? (m?.owner ? "human" : "agent"),
    owner: !!m?.owner,
    sponsor: m?.sponsor ? (m.sponsor.handle ?? m.sponsor.name) : null,
    color: colorOf(state, name),
    online: !!on,
    lastSeen: m?.lastSeen ?? null,
    load: loadJson(memberLoad(state, name, now)),
  };
}

/** `kiwi status --json`: the members a coordinator routes work between, by role and load. */
export function statusJson({ alias, me, state, online, unread, now = Date.now() }: Snapshot) {
  const names = [...state.members.values()].filter((m) => m.active).map((m) => m.name);
  return { channel: alias, me, head: state.head, unread, members: names.sort().map((n) => memberJson(state, n, online, now)) };
}

/** `kiwi status`: everything an agent needs before deciding what to do next. */
export function formatStatus({ alias, me, state, online, unread, now = Date.now() }: Snapshot): string {
  const out: string[] = [];
  const meM = state.members.get(me);
  out.push(`channel ${alias} · you are ${me}${meM?.role ? ` (${meM.role})` : ""} · head #${state.head}${unread ? ` · ${unread} unread` : ""}`);

  // Only people and agents still in the channel; anyone who left or was removed is listed apart.
  const current = [...state.members.values()].filter((m) => m.active).map((m) => m.name);
  const names = new Set([...current, ...[...online.keys()].filter((n) => state.members.get(n)?.active)]);
  const left = [...state.members.values()].filter((m) => !m.active).map((m) => m.name);
  out.push("", `members (${names.size}):`);
  for (const name of [...names].sort()) {
    const m = state.members.get(name);
    const on = online.get(name);
    const where = on ? `online (${on.client})` : m ? `last seen ${ago(m.lastSeen, now)}` : "online";
    const role = m?.role ?? on?.role;
    const key = m?.pk ? ` · key ${m.pk.slice(0, 8)}` : "";
    const kind = m?.kind === "human" ? ` · human${m.display ? ` (${m.display})` : ""}${m.owner ? ", owner" : ""}` : m?.sponsor ? ` · agent of @${m.sponsor.handle ?? m.sponsor.name}` : "";
    out.push(`  ${name}${name === me ? " (you)" : ""}${role ? ` — ${role}` : ""}${kind} · ${where}${key}`);
    // How busy they are, so work goes to whoever's free (people only when they hold tasks).
    const load = memberLoad(state, name, now);
    if (showsLoad(m, load)) out.push(`      ${loadSummary(load)}`);
  }
  if (left.length) out.push(`  left or removed: ${left.sort().join(", ")}`);

  const asks = state.openAsks.filter((a) => a.from !== me && (!a.to || a.to.includes(me)));
  if (asks.length) {
    out.push("", `waiting on you (${asks.length}) — answer with: kiwi reply <#> "…"`);
    for (const a of asks) out.push(`  #${a.seq} ${a.from}${a.kind === "blocking" ? " [blocking]" : ""}: ${oneLine(a.body)}`);
  }
  const mine = state.openAsks.filter((a) => a.from === me);
  if (mine.length) {
    out.push("", `your unanswered questions (${mine.length}):`);
    for (const a of mine) out.push(`  #${a.seq} → ${a.to?.join(",") ?? "all"}: ${oneLine(a.body)}`);
  }

  const tasks = [...state.tasks.values()];
  const active = tasks.filter((t) => t.state !== "done");
  const done = tasks.length - active.length;
  out.push("", `tasks (${active.length} open${done ? `, ${done} done` : ""}):`);
  if (!active.length) out.push("  none — add one with: kiwi task add \"…\"");
  const order = ["doing", "blocked", "review", "todo"];
  active.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || a.id - b.id);
  for (const t of active) out.push(taskLine(state, t));

  if (state.claims.length) {
    out.push("", "claims:");
    for (const c of state.claims) out.push(claimLine(c, now));
  }
  if (state.facts.size) {
    out.push("", "facts:");
    for (const f of [...state.facts.values()].sort((a, b) => a.key.localeCompare(b.key))) out.push(`  ${f.key} = ${f.value}  (${f.by})`);
  }
  return out.join("\n");
}

export function formatTasks(state: ChannelState, opts: { all?: boolean; owner?: string } = {}): string {
  let tasks = [...state.tasks.values()];
  if (!opts.all) tasks = tasks.filter((t) => t.state !== "done");
  if (opts.owner) tasks = tasks.filter((t) => t.owner === opts.owner);
  if (!tasks.length) return "no tasks";
  return tasks.map((t) => taskLine(state, t).trimStart()).join("\n");
}

export function formatTask(state: ChannelState, t: Task, now = Date.now()): string {
  const out = [`${taskId(t.id)} ${t.title}`, `  state: ${t.state}${t.owner ? ` · owner: ${t.owner}` : " · unassigned"} · created by ${t.createdBy} ${ago(t.createdAt, now)}`];
  const waits = waitingOn(state, t);
  if (t.after.length) out.push(`  after: ${t.after.map((d) => `${taskId(d)} (${state.tasks.get(d)?.state ?? "?"})`).join(", ")}${waits.length ? "" : " — all done"}`);
  if (t.detail) out.push("", t.detail);
  if (t.notes.length) {
    out.push("", "notes:");
    for (const n of t.notes) out.push(`  #${n.seq} ${n.by}, ${ago(n.ts, now)}: ${n.text}`);
  }
  return out.join("\n");
}

export function formatClaims(state: ChannelState, now = Date.now()): string {
  return state.claims.length ? state.claims.map((c) => claimLine(c, now).trimStart()).join("\n") : "no active claims";
}

function oneLine(s: string, max = 140): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
