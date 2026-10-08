// Shared channel state, folded from the message log.
//
// Every client folds the same signed events in the same (relay-assigned)
// order, so they all agree on who owns which task, which paths are claimed,
// and what the facts are, without the relay ever reading any of it.
// Conflicts resolve deterministically: the earlier sequence number wins.

import type { Message, TaskState, Trust } from "./protocol.ts";

export interface Member {
  name: string;
  /** The key the owner admitted under this name. */
  pk: string;
  role?: string;
  about?: string;
  owner: boolean;
  /** When the owner admitted them. */
  joined: number;
  /** False once they've left or been removed (their history still verifies). */
  active: boolean;
  lastSeen: number;
  messages: number;
}

/** The verified member list, as names → admitted keys (see membership.ts). */
export type Roster = { name: string; pk: string; role?: string; about?: string; owner: boolean; at: number; active: boolean }[];

export interface TaskNote {
  seq: number;
  by: string;
  ts: number;
  text: string;
}

export interface Task {
  id: number;
  title: string;
  detail?: string;
  state: TaskState;
  owner?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Tasks that must be done before this one. */
  after: number[];
  notes: TaskNote[];
}

export interface Claim {
  owner: string;
  path: string;
  seq: number;
  since: number;
  expires: number;
  note?: string;
}

export interface Fact {
  key: string;
  value: string;
  by: string;
  ts: number;
  seq: number;
}

export interface ChannelState {
  members: Map<string, Member>;
  tasks: Map<number, Task>;
  /** Claims active at fold time. */
  claims: Claim[];
  facts: Map<string, Fact>;
  trust: Map<number, Trust>;
  /** Events that lost a race or broke a rule, with the reason. */
  rejected: Map<number, string>;
  /** Asks and blockers nobody else has replied to. */
  openAsks: Message[];
  head: number;
}

export function taskId(id: number): string {
  return `T${id}`;
}

/** Parse "T12", "t12", "#12" or "12". */
export function parseTaskId(s: string): number | null {
  const m = /^(?:[Tt#])?(\d+)$/.exec(s.trim());
  return m ? Number(m[1]) : null;
}

/** Two claim paths overlap if one contains the other ("*" covers everything). */
export function overlaps(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, "");
  const x = norm(a);
  const y = norm(b);
  return x === "*" || y === "*" || x === y || x.startsWith(y + "/") || y.startsWith(x + "/");
}

/**
 * Fold the log into shared state. A message counts only if it's signed by the
 * key the owner admitted under the name it claims; anything else is forged and
 * ignored, whoever sent it.
 */
export function fold(messages: Message[], roster: Roster, now = Date.now()): ChannelState {
  const members = new Map<string, Member>();
  // A name can be re-admitted under a new key after its old one left; the active key wins.
  for (const r of [...roster].sort((a, b) => Number(a.active) - Number(b.active))) {
    members.set(r.name, { name: r.name, pk: r.pk, role: r.role, about: r.about, owner: r.owner, joined: r.at, lastSeen: r.at, messages: 0, active: r.active });
  }
  const formerKeys = new Map(roster.filter((r) => !r.active).map((r) => [r.pk, r.name]));
  const tasks = new Map<number, Task>();
  let claims: Claim[] = [];
  const facts = new Map<string, Fact>();
  const trust = new Map<number, Trust>();
  const rejected = new Map<number, string>();
  const answered = new Map<number, Set<string>>();
  let head = 0;

  for (const m of messages) {
    head = Math.max(head, m.seq);
    const at = m.rts ?? m.ts;

    // Identity: only the key the owner admitted under this name may speak for it.
    // (Members who have since left aren't in the roster, so their history reads as forged.)
    const member = members.get(m.from);
    const t: Trust = m.sigOk && ((member && m.pk === member.pk) || (m.pk && formerKeys.get(m.pk) === m.from)) ? "verified" : "forged";
    trust.set(m.seq, t);
    if (t === "forged" || !member) {
      rejected.set(m.seq, member ? `not signed by ${m.from}'s key` : `${m.from} isn't a member`);
      continue;
    }
    member.lastSeen = Math.max(member.lastSeen, at);
    member.messages++;

    for (const r of m.re ?? []) {
      let set = answered.get(r);
      if (!set) answered.set(r, (set = new Set()));
      set.add(m.from);
    }

    const ev = m.ev;
    if (m.kind !== "event" || !ev) continue;
    const reject = (why: string) => rejected.set(m.seq, why);

    switch (ev.op) {
      case "hello":
        if (ev.role !== undefined) member.role = ev.role || undefined;
        if (ev.about !== undefined) member.about = ev.about || undefined;
        break;

      case "task.add":
        tasks.set(m.seq, {
          id: m.seq,
          title: String(ev.title).slice(0, 200),
          detail: ev.detail,
          state: "todo",
          owner: ev.owner || undefined,
          createdBy: m.from,
          createdAt: at,
          updatedAt: at,
          after: (ev.after ?? []).filter((d) => tasks.has(d)),
          notes: [],
        });
        break;

      case "task.claim": {
        const task = tasks.get(ev.task);
        if (!task) reject(`no task ${taskId(ev.task)}`);
        else if (task.state === "done") reject(`${taskId(task.id)} is already done`);
        else if (task.owner && task.owner !== m.from) reject(`${taskId(task.id)} is owned by ${task.owner}`);
        else {
          task.owner = m.from;
          if (task.state === "todo") task.state = "doing";
          task.updatedAt = at;
        }
        break;
      }

      case "task.update": {
        const task = tasks.get(ev.task);
        if (!task) {
          reject(`no task ${taskId(ev.task)}`);
          break;
        }
        if (ev.owner !== undefined) task.owner = ev.owner || undefined;
        if (ev.state) task.state = ev.state;
        if (ev.title) task.title = ev.title.slice(0, 200);
        if (ev.note) task.notes.push({ seq: m.seq, by: m.from, ts: at, text: ev.note });
        // Unassigning work in progress puts it back on the board.
        if (ev.owner === null && task.state === "doing") task.state = "todo";
        task.updatedAt = at;
        break;
      }

      case "claim": {
        const live = claims.filter((c) => c.expires > at);
        const ttl = Math.min(Math.max(Number(ev.ttl) || 0, 60), 24 * 3600) * 1000;
        const conflict = ev.paths
          .map((p) => live.find((c) => c.owner !== m.from && overlaps(c.path, p)))
          .find(Boolean);
        if (conflict) {
          reject(`${conflict.path} is claimed by ${conflict.owner}`);
          break;
        }
        claims = live.filter((c) => !(c.owner === m.from && ev.paths.includes(c.path)));
        for (const path of ev.paths) {
          claims.push({ owner: m.from, path, seq: m.seq, since: at, expires: at + ttl, note: ev.note });
        }
        break;
      }

      case "release":
        claims = claims.filter((c) => c.owner !== m.from || (ev.paths?.length ? !ev.paths.includes(c.path) : false));
        break;

      case "fact.set":
        facts.set(ev.key, { key: ev.key, value: ev.value, by: m.from, ts: at, seq: m.seq });
        break;

      case "fact.del":
        facts.delete(ev.key);
        break;
    }
  }

  const openAsks = messages.filter((m) => {
    if (m.kind !== "ask" && m.kind !== "blocking") return false;
    if (trust.get(m.seq) === "forged") return false;
    const by = answered.get(m.seq);
    return !by || [...by].every((n) => n === m.from);
  });

  return {
    members,
    tasks,
    claims: claims.filter((c) => c.expires > now),
    facts,
    trust,
    rejected,
    openAsks,
    head,
  };
}

/** Tasks still waiting on unfinished dependencies. */
export function waitingOn(state: ChannelState, task: Task): number[] {
  return task.after.filter((d) => state.tasks.get(d)?.state !== "done");
}
