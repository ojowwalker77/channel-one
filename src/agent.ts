// An agent's view of one channel: the operations behind every CLI command
// and MCP tool. Keeps a local cache of the decrypted log so folding shared
// state (tasks, claims, facts, members) costs one incremental fetch.

import { Channel, isDirectedAt, isForAgent, type SendOptions } from "./client.ts";
import { appendCache, loadIdentity, markSeen, readCache, readCursor, readSeen, writeCursor, type ChannelConfig } from "./config.ts";
import type { Identity } from "./identity.ts";
import { TASK_STATES, type Event, type ImageAttachment, type Kind, type Message, type Presence, type TaskState } from "./protocol.ts";
import { fold, overlaps, taskId, waitingOn, type ChannelState } from "./state.ts";

/** How often a listening agent re-announces itself. Receivers treat 2.5x this as offline. */
export const PRESENCE_EVERY_MS = 60_000;
export const PRESENCE_TTL_MS = 150_000;

export interface Delivery {
  /** Show every message, including all coordination events. */
  all?: boolean;
  /** Only messages addressed to this agent (by name or role, or broadcast asks). */
  forMe?: boolean;
}

export class Rejected extends Error {}

export class AgentSession {
  readonly ch: Channel;

  private constructor(
    readonly alias: string,
    readonly cfg: ChannelConfig,
    readonly identity: Identity,
  ) {
    this.ch = new Channel(cfg, cfg.relay, identity);
  }

  static async open(alias: string, cfg: ChannelConfig, name: string): Promise<AgentSession> {
    return new AgentSession(alias, cfg, await loadIdentity(name));
  }

  get me(): string {
    return this.identity.name;
  }

  // ---------- log & state ----------

  /** The full log: cached messages plus anything new from the relay. */
  async sync(): Promise<Message[]> {
    const cached = readCache(this.cfg.roomId);
    const last = cached.at(-1)?.seq ?? 0;
    const { messages } = await this.ch.history(last);
    const fresh = messages.filter((m) => m.seq > last);
    appendCache(this.cfg.roomId, fresh);
    return [...cached, ...fresh];
  }

  async state(): Promise<{ messages: Message[]; state: ChannelState }> {
    const messages = await this.sync();
    return { messages, state: fold(messages) };
  }

  /** The agent's read cursor, starting at the channel head the first time. */
  async cursor(): Promise<number> {
    const c = readCursor(this.alias, this.me);
    if (c !== null) return c;
    const head = await this.ch.head();
    writeCursor(this.alias, this.me, head);
    return head;
  }

  /**
   * Whether tail/wait/read should surface `m` to this agent. Chat is shown
   * (or only chat addressed to us, with forMe); coordination events only when
   * they concern us, plus members joining. Our own messages never are.
   */
  wants(m: Message, state: ChannelState | null, d: Delivery = {}): boolean {
    if (m.from === this.me) return false;
    // Forged messages never reach an agent: they're noise at best, prompt injection at worst.
    if (state?.trust.get(m.seq) === "forged") return false;
    if (d.all) return true;
    const role = state?.members.get(this.me)?.role;
    const addressed = isDirectedAt(m, this.me) || (!!role && !!m.to?.includes(`role:${role}`));
    if (m.kind === "event") return addressed || m.ev?.op === "hello";
    return d.forMe ? addressed || isForAgent(m, this.me) && (m.kind === "ask" || m.kind === "blocking") : true;
  }

  /** Unread messages for this agent; advances the cursor. */
  async read(d: Delivery = {}): Promise<{ messages: Message[]; state: ChannelState }> {
    const since = await this.cursor();
    const { messages, state } = await this.state();
    const seen = readSeen(this.alias, this.me);
    const unread = messages.filter((m) => m.seq > since && !seen.has(m.seq) && this.wants(m, state, d));
    writeCursor(this.alias, this.me, Math.max(since, state.head));
    return { messages: unread, state };
  }

  async unreadCount(state: ChannelState, messages: Message[]): Promise<number> {
    const since = readCursor(this.alias, this.me) ?? state.head;
    const seen = readSeen(this.alias, this.me);
    return messages.filter((m) => m.seq > since && !seen.has(m.seq) && this.wants(m, state)).length;
  }

  /**
   * Deliver unread and live messages to `onMessage` until `signal` aborts,
   * announcing presence while listening. The cursor advances as messages are
   * handled, so a restart resumes exactly where this left off.
   */
  async listen(
    onMessage: (m: Message, state: ChannelState) => void | Promise<void>,
    opts: Delivery & { signal?: AbortSignal; client: string; onStatus?: (s: string) => void },
  ): Promise<void> {
    const since = await this.cursor();
    let { messages, state } = await this.state();
    const seen = readSeen(this.alias, this.me);
    const role = state.members.get(this.me)?.role;
    let lastQueryReply = 0;
    let announce: (() => void) | null = null;
    let beacon: ReturnType<typeof setInterval> | undefined;
    opts.signal?.addEventListener("abort", () => clearInterval(beacon), { once: true });

    await this.ch.stream(
      since,
      async (m) => {
        if (m.seq > (messages.at(-1)?.seq ?? 0)) {
          messages = [...messages, m];
          appendCache(this.cfg.roomId, [m]);
          state = fold(messages);
        }
        if (!seen.has(m.seq) && this.wants(m, state, opts)) await onMessage(m, state);
        writeCursor(this.alias, this.me, m.seq);
      },
      {
        signal: opts.signal,
        onStatus: opts.onStatus,
        onOpen: ({ presence }) => {
          announce = () => void presence({ client: opts.client, ...(role ? { role } : {}) });
          announce();
          clearInterval(beacon);
          beacon = setInterval(() => announce?.(), PRESENCE_EVERY_MS);
        },
        onPresence: (p) => {
          // Answer "who's here?" probes, at most every few seconds.
          if (!p.query || Date.now() - lastQueryReply < 3_000) return;
          lastQueryReply = Date.now();
          announce?.();
        },
      },
    );
    clearInterval(beacon);
  }

  /** Who is listening right now: probes the channel and collects answers. */
  async who(waitMs = 1_500): Promise<Map<string, Presence>> {
    const found = new Map<string, Presence>();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), waitMs);
    // Answers arrive within milliseconds of the query, so stop waiting once
    // they stop coming: each new answer restarts a short quiet window. A busy
    // channel typically resolves in ~0.5s instead of the full timeout.
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const heard = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => ac.abort(), 400);
    };
    const head = await this.ch.head();
    await this.ch
      .stream(head, () => {}, {
        signal: ac.signal,
        onOpen: ({ presence }) => void presence({ client: "probe", query: true }),
        onPresence: (p) => {
          if (p.client === "probe" || p.from === this.me) return;
          if (!(p.sigOk || !p.pk)) return;
          if (!found.has(p.from)) heard();
          found.set(p.from, p);
        },
      })
      .catch(() => {});
    clearTimeout(timer);
    clearTimeout(quiet);
    return found;
  }

  // ---------- messaging ----------

  /** Expand `role:x` recipients to the members holding that role. */
  async resolveTo(to: string[] | undefined, state?: ChannelState): Promise<string[] | undefined> {
    if (!to?.length || !to.some((t) => t.startsWith("role:"))) return to;
    const s = state ?? (await this.state()).state;
    const out = new Set<string>();
    for (const t of to) {
      if (!t.startsWith("role:")) {
        out.add(t);
        continue;
      }
      const role = t.slice(5).toLowerCase();
      for (const m of s.members.values()) if (m.role?.toLowerCase() === role) out.add(m.name);
    }
    if (!out.size) throw new Rejected(`no member has role ${to.filter((t) => t.startsWith("role:")).join(", ")}`);
    return [...out];
  }

  async send(body: string, opts: SendOptions = {}): Promise<number> {
    return this.ch.send(body, { ...opts, to: await this.resolveTo(opts.to) });
  }

  /**
   * Ask a question and, with `waitSec`, block until someone answers (a reply
   * referencing it). Returns the replies; they're marked seen so tail/wait
   * don't deliver them a second time.
   */
  async ask(body: string, opts: { to?: string[]; kind?: Kind; waitSec?: number; signal?: AbortSignal; imgs?: ImageAttachment[] }): Promise<{ seq: number; replies: Message[] }> {
    const head = await this.ch.head();
    const seq = await this.send(body, { to: opts.to, kind: opts.kind ?? "ask", imgs: opts.imgs });
    if (!opts.waitSec) return { seq, replies: [] };
    const replies = await this.awaitReplies(seq, head, opts.waitSec, opts.signal);
    return { seq, replies };
  }

  async awaitReplies(seq: number, since: number, waitSec: number, signal?: AbortSignal): Promise<Message[]> {
    const replies: Message[] = [];
    const ac = new AbortController();
    signal?.addEventListener("abort", () => ac.abort(), { once: true });
    const timer = setTimeout(() => ac.abort(), waitSec * 1000);
    await this.ch.stream(
      since,
      (m) => {
        if (m.from === this.me || !m.re?.includes(seq)) return;
        replies.push(m);
        // Linger briefly so several quick answers come back together.
        if (replies.length === 1) setTimeout(() => ac.abort(), 600);
      },
      { signal: ac.signal },
    );
    clearTimeout(timer);
    markSeen(this.alias, this.me, replies.map((r) => r.seq));
    return replies;
  }

  /** Reply to message #seq, addressed to its sender. */
  async reply(seq: number, body: string, kind: Kind = "msg", imgs?: ImageAttachment[]): Promise<number> {
    const { messages } = await this.state();
    const orig = messages.find((m) => m.seq === seq);
    if (!orig) throw new Rejected(`no message #${seq}`);
    const to = orig.from === this.me ? orig.to : [orig.from];
    return this.ch.send(body, { to, kind, re: [seq], imgs });
  }

  async hello(role?: string, about?: string): Promise<number> {
    return this.event({ op: "hello", role, about }, `joined${role ? ` as ${role}` : ""}`);
  }

  // ---------- events ----------

  private event(ev: Event, body: string, to?: string[]): Promise<number> {
    return this.ch.send(body, { kind: "event", ev, to: to?.length ? [...new Set(to)].filter((n) => n !== this.me) : undefined });
  }

  /** Send an event, then confirm the fold accepted it (it may lose a race). */
  private async confirm(seq: number): Promise<ChannelState> {
    const { state } = await this.state();
    const why = state.rejected.get(seq);
    if (why) throw new Rejected(why);
    return state;
  }

  async taskAdd(title: string, opts: { detail?: string; owner?: string; after?: number[] } = {}): Promise<number> {
    const { state } = await this.state();
    for (const d of opts.after ?? []) if (!state.tasks.has(d)) throw new Rejected(`no task ${taskId(d)}`);
    const owner = opts.owner && (await this.resolveTo([opts.owner], state))?.[0];
    return this.event(
      { op: "task.add", title, ...(opts.detail ? { detail: opts.detail } : {}), ...(owner ? { owner } : {}), ...(opts.after?.length ? { after: opts.after } : {}) },
      `task: ${title}`,
      owner ? [owner] : undefined,
    );
  }

  async taskClaim(id: number): Promise<ChannelState> {
    const { state } = await this.state();
    const t = state.tasks.get(id);
    if (!t) throw new Rejected(`no task ${taskId(id)}`);
    if (t.state === "done") throw new Rejected(`${taskId(id)} is already done`);
    if (t.owner && t.owner !== this.me) throw new Rejected(`${taskId(id)} is owned by ${t.owner}`);
    const waits = waitingOn(state, t);
    const seq = await this.event({ op: "task.claim", task: id }, `claimed ${taskId(id)}`);
    const after = await this.confirm(seq);
    if (waits.length) throw new Rejected(`claimed, but ${taskId(id)} is still waiting on ${waits.map(taskId).join(", ")}`);
    return after;
  }

  async taskUpdate(id: number, change: { state?: TaskState; owner?: string | null; title?: string; note?: string }): Promise<ChannelState> {
    const { state } = await this.state();
    const t = state.tasks.get(id);
    if (!t) throw new Rejected(`no task ${taskId(id)}`);
    if (change.state && !TASK_STATES.includes(change.state)) throw new Rejected(`state must be one of ${TASK_STATES.join(", ")}`);
    const owner = change.owner ? (await this.resolveTo([change.owner], state))?.[0] : change.owner;
    // Tell whoever this concerns: the new owner, the current owner if it isn't
    // us, the creator when it's done, and owners of tasks it unblocks.
    const notify: string[] = [];
    if (owner) notify.push(owner);
    if (t.owner && t.owner !== this.me) notify.push(t.owner);
    if (change.state === "done") {
      notify.push(t.createdBy);
      for (const other of state.tasks.values()) if (other.after.includes(id) && other.owner) notify.push(other.owner);
    }
    const seq = await this.event({ op: "task.update", task: id, ...change, ...(owner !== undefined ? { owner } : {}) }, `${taskId(id)} ${change.state ?? "updated"}`, notify);
    return this.confirm(seq);
  }

  async claim(paths: string[], ttlSec: number, note?: string): Promise<ChannelState> {
    const { state } = await this.state();
    for (const p of paths) {
      const c = state.claims.find((x) => x.owner !== this.me && overlaps(x.path, p));
      if (c) throw new Rejected(`${c.path} is claimed by ${c.owner}`);
    }
    const seq = await this.event({ op: "claim", paths, ttl: ttlSec, ...(note ? { note } : {}) }, `claimed ${paths.join(", ")}`);
    return this.confirm(seq);
  }

  async release(paths?: string[]): Promise<number> {
    return this.event({ op: "release", ...(paths?.length ? { paths } : {}) }, paths?.length ? `released ${paths.join(", ")}` : "released all claims");
  }

  async setFact(key: string, value: string): Promise<number> {
    return this.event({ op: "fact.set", key, value }, `${key} = ${value}`);
  }

  async delFact(key: string): Promise<number> {
    return this.event({ op: "fact.del", key }, `unset ${key}`);
  }
}

export type { Presence };
