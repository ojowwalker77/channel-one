// Shared channel state, folded from the message log.
//
// Every client folds the same signed events in the same (relay-assigned)
// order, so they all agree on who owns which task, which paths are claimed,
// and what the facts are, without the relay ever reading any of it.
// Conflicts resolve deterministically: the earlier sequence number wins.

import type { Color, Message, TaskState, Trust } from "./protocol.ts";

export interface Member {
  name: string;
  kind?: "human" | "agent";
  display?: string;
  sponsor?: { user: string; name: string; handle?: string };
  /** The key the owner admitted under this name. */
  pk: string;
  role?: string;
  about?: string;
  /** A role (or rules) they asked for and the owner hasn't decided on yet. */
  roleRequest?: { role?: string; about?: string; seq: number; at: number };
  /** A person's colour; agents wear their person's (colorOf). */
  color?: Color;
  owner: boolean;
  /** When the owner admitted them. */
  joined: number;
  /** False once they've left or been removed (their history still verifies). */
  active: boolean;
  lastSeen: number;
  messages: number;
}

/** The verified member list, as names → admitted keys (see membership.ts). */
export type Roster = {
  name: string;
  pk: string;
  role?: string;
  about?: string;
  owner: boolean;
  at: number;
  active: boolean;
  kind?: "human" | "agent";
  display?: string;
  sponsor?: { user: string; name: string; handle?: string };
  color?: Color;
}[];

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
    members.set(r.name, {
      name: r.name,
      pk: r.pk,
      role: r.role,
      about: r.about,
      kind: r.kind,
      display: r.display,
      sponsor: r.sponsor,
      color: r.color,
      owner: r.owner,
      joined: r.at,
      lastSeen: r.at,
      messages: 0,
      active: r.active,
    });
  }
  // Every key the owner ever admitted under each name. Normally one per name; a name can have
  // had an earlier holder who left, and the owner may (wrongly) have admitted two keys under one.
  // Colours from admission records are unique too: if two people's records share one, who joined first keeps it.
  const worn = new Set<string>();
  for (const m of [...members.values()].filter((x) => x.active && isPerson(x)).sort((a, b) => a.joined - b.joined)) {
    if (m.color && worn.has(m.color)) m.color = undefined;
    else if (m.color) worn.add(m.color);
  }
  const keysByName = new Map<string, Set<string>>();
  for (const r of roster) {
    let set = keysByName.get(r.name);
    if (!set) keysByName.set(r.name, (set = new Set()));
    set.add(r.pk);
  }
  const tasks = new Map<number, Task>();
  let claims: Claim[] = [];
  const facts = new Map<string, Fact>();
  const trust = new Map<number, Trust>();
  const rejected = new Map<number, string>();
  const answered = new Map<number, Set<string>>();
  let head = 0;

  for (const m of messages) {
    // One bad message must never take the whole channel down for everyone: skip it.
    try {
      head = Math.max(head, m.seq);
      const at = m.rts ?? m.ts;

      // Identity: only a key the owner admitted under this name may speak for it.
      const member = members.get(m.from);
      const t: Trust = m.sigOk && !!m.pk && !!keysByName.get(m.from)?.has(m.pk) ? "verified" : "forged";
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
        case "hello": {
          // Roles are the owner's to give: the owner sets its own, anyone else's hello asks for one.
          if (member.owner) {
            if (ev.role !== undefined) member.role = ev.role || undefined;
            if (ev.about !== undefined) member.about = ev.about || undefined;
            break;
          }
          const role = ev.role === undefined ? member.role : ev.role || undefined;
          const about = ev.about === undefined ? member.about : ev.about || undefined;
          if (role === member.role && about === member.about) member.roleRequest = undefined;
          else member.roleRequest = { ...(role !== undefined ? { role } : {}), ...(about !== undefined ? { about } : {}), seq: m.seq, at };
          break;
        }

        case "role.set":
        case "role.refuse": {
          if (!member.owner) {
            reject("only the owner decides roles");
            break;
          }
          const target = members.get(ev.member);
          if (!target) {
            reject(`no member named ${ev.member}`);
            break;
          }
          if (ev.op === "role.set") {
            target.role = ev.role || undefined;
            if (ev.about !== undefined) target.about = ev.about || undefined;
          }
          target.roleRequest = undefined;
          break;
        }

        case "seat.reclaim":
          // The record: the seat itself moved when the owner signed the new key's member record.
          if (!member.owner) reject("only the owner moves a seat to a new key");
          else if (!members.has(ev.member)) reject(`no member named ${ev.member}`);
          break;

        case "color.set": {
          // A person picks their own colour; the owner may set or clear anyone's.
          const target = members.get(ev.member);
          if (!target?.active) reject(`no member named ${ev.member}`);
          else if (ev.member !== m.from && !member.owner) reject("only that person or the owner sets a colour");
          else if (!isPerson(target)) reject("agents wear their person's colour; they don't have their own");
          else {
            const holder = ev.color && [...members.values()].find((x) => x.active && x.name !== target.name && isPerson(x) && x.color === ev.color);
            if (holder) reject(`${ev.color} is ${holder.name}'s colour`);
            else target.color = ev.color ?? undefined;
          }
          break;
        }

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
      } catch {
      trust.set(m.seq, "forged");
      rejected.set(m.seq, "malformed message");
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

const isPerson = (m: { kind?: string; owner?: boolean }) => m.kind === "human" || !!m.owner;

/** The colour someone shows: a person's own, an agent's person's (when that person is a member here), else null. */
export function colorOf(state: ChannelState, name: string): Color | null {
  const m = state.members.get(name);
  if (!m) return null;
  if (isPerson(m)) return m.color ?? null;
  const person = m.sponsor && [...state.members.values()].find((x) => x.active && isPerson(x) && x.sponsor?.user === m.sponsor!.user);
  return person ? (person.color ?? null) : null;
}
