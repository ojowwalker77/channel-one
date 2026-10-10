// An agent's view of one channel: the operations behind every CLI command
// and MCP tool. Keeps a local cache of the decrypted log so folding shared
// state (tasks, claims, facts, members) costs one incremental fetch.

import { Channel, ChannelGone, isDirectedAt, isForAgent, QUIET_DROP_MS, RelayError, type SendOptions } from "./client.ts";
import { appendCache, loadIdentity, markSeen, readCache, readCursor, readSeen, saveAccess, signingBudget, writeCursor, type ChannelConfig } from "./config.ts";
import { TOO_MANY_REQUESTS } from "./sas.ts";
import type { ChannelAccess } from "./crypto.ts";
import { inlineText, type JoinRequest } from "./membership.ts";
import type { Identity } from "./identity.ts";
import { canPost, describeScopes, refusal, wireScopes, type Scope } from "./scopes.ts";
import { ignored, TASK_STATES, type Color, type Event, type ImageAttachment, type Kind, type Message, type Presence, type TaskState } from "./protocol.ts";
import { claimConflict, fold, overlaps, taskId, waitingOn, wouldCycle, type ChannelState, type Roster } from "./state.ts";

/** How often a listening agent re-announces itself. Receivers treat 2.5x this as offline. */
export const PRESENCE_EVERY_MS = 60_000;
/** What `--to` takes for "everyone, on purpose". */
const EVERYONE = new Set(["all", "everyone", "*"]);
export const PRESENCE_TTL_MS = 150_000;

export interface Delivery {
  /** Show every message, including all coordination events. */
  all?: boolean;
  /** Every chat message, whoever it's for (what a coordinator wants). */
  chat?: boolean;
  /** Only messages addressed to this agent (by name or role, or broadcast asks). */
  forMe?: boolean;
  /** Only messages in the thread this message (root or reply) is in. */
  thread?: number;
}

export class Rejected extends Error {}

export class AgentSession {
  readonly ch: Channel;
  /** The owner's channel handle, when this machine holds the owner key. */
  readonly ownerCh: Channel | null;
  private roster: Roster | null = null;

  private constructor(
    readonly alias: string,
    readonly cfg: ChannelConfig,
    readonly identity: Identity,
    owner: Identity | null,
  ) {
    const persist = (a: ChannelAccess) => saveAccess(alias, a);
    this.ch = new Channel(cfg, cfg.relay, identity, persist);
    this.ownerCh = owner ? new Channel(cfg, cfg.relay, owner, persist) : null;
  }

  static async open(alias: string, cfg: ChannelConfig, name: string): Promise<AgentSession> {
    const owner = cfg.owner ? await loadIdentity(cfg.owner, cfg.roomId) : null;
    return new AgentSession(alias, cfg, await loadIdentity(name, cfg.roomId), owner);
  }

  /** The verified member list (owner-signed records). */
  async members(refresh = false): Promise<Roster> {
    if (!this.roster || refresh) {
      this.roster = (await this.ch.members()).map((m) => ({
        name: m.name,
        pk: m.pk,
        role: m.role,
        about: m.about,
        owner: m.owner,
        at: m.at,
        active: m.active,
        kind: m.kind,
        display: m.display,
        sponsor: m.sponsor,
        color: m.color,
        ...(m.scopes ? { scopes: m.scopes } : {}),
      }));
    }
    return this.roster;
  }

  /** Owner duty: rotate the channel key if someone left since the last rotation. */
  async ownerChores(): Promise<void> {
    if (!this.ownerCh) return;
    if (await this.ownerCh.rotateIfDue()) await this.ch.refreshKeys();
    // The relay's "can post" bit follows the log's scopes: check once a session, and again whenever
    // the roster changes or a scope.set's second step failed. (Not state(): it calls this.)
    if (this.postingChecked) return;
    const [messages, roster] = await Promise.all([this.sync(), this.members()]);
    await this.ownerCh.reconcilePosting(fold(messages, roster));
    this.postingChecked = true;
  }
  /** Whether the relay's can-post bits were checked against the log since the roster last changed. */
  private postingChecked = false;

  /** Pending join requests (owner machine only). */
  async requests(): Promise<JoinRequest[]> {
    if (!this.ownerCh) throw new Rejected("only the channel owner's machine can see join requests");
    return this.ownerCh.requests({ budget: signingBudget });
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
    // On the owner's machine, any command finishes a rotation owed to a member leaving.
    await this.ownerChores();
    const [messages, roster] = await Promise.all([this.sync(), this.members()]);
    return { messages, state: fold(messages, roster) };
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
    return wants(this.me, m, state, d);
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
    opts: Delivery & { signal?: AbortSignal; client: string; onStatus?: (s: string) => void; onNotice?: (text: string) => void | Promise<void> },
  ): Promise<void> {
    // Lets the Claude Code Stop hook know this agent can hear the channel.
    const { registerListener } = await import("./hooks.ts");
    registerListener(this.alias, this.me);
    // Starting up when the relay is briefly out of reach (a deploy, a blip) waits and retries, like any drop later.
    let since = 0;
    let messages: Message[] = [];
    let state!: ChannelState;
    for (let backoff = 500, downSince = Date.now(), told = false; ; backoff = Math.min(backoff * 2, 30_000)) {
      try {
        await this.ownerChores();
        since = await this.cursor();
        ({ messages, state } = await this.state());
        if (told) opts.onStatus?.(`reached the relay after ${Math.round((Date.now() - downSince) / 1000)}s`);
        break;
      } catch (err) {
        // Gone (removed, closed) and refusals are answers, not outages.
        if (err instanceof ChannelGone || err instanceof Rejected || (err instanceof RelayError && err.status < 500 && err.status !== 429)) throw err;
        if (opts.signal?.aborted) return;
        if (!told && Date.now() - downSince >= QUIET_DROP_MS) {
          told = true;
          opts.onStatus?.(`can't reach the relay (${err instanceof Error ? err.message : String(err)}); still retrying`);
        }
        await Bun.sleep(backoff);
      }
    }
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
          state = fold(messages, await this.members());
          // From someone we don't know yet? We may have missed a roster update while offline:
          // check again before calling it forged and moving past it for good.
          if (state.trust.get(m.seq) === "forged") state = fold(messages, await this.members(true));
        }
        if (!seen.has(m.seq) && this.wants(m, state, opts)) await onMessage(m, state);
        writeCursor(this.alias, this.me, m.seq);
      },
      {
        signal: opts.signal,
        onStatus: opts.onStatus,
        onOpen: ({ presence }) => {
          // Members may have joined or left while we were disconnected.
          void this.members(true).catch(() => {});
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
        onRoster: () => {
          this.postingChecked = false;
          void this.members(true).then(() => this.ownerChores());
        },
        onRequest: () => {
          if (!this.ownerCh || !opts.onNotice) return;
          void this.ownerCh.requests({ budget: signingBudget }).then(async (reqs) => {
            for (const r of reqs) {
              // A request becomes worth mentioning once both sides can see its code.
              if (r.check === "ready") {
                await opts.onNotice!(
                  `join request: "${r.name}"${r.role ? ` (${r.role})` : ""} wants in, verification code ${r.code}. ` +
                    `Only your human may approve: ask them to confirm the code matches what the joining agent shows, then run \`kiwi approve ${r.code}\` (or approve in the dashboard).`,
                );
              } else if (r.check === "unchecked") {
                await opts.onNotice!(`join request: "${r.name}" wants in, but this computer has checked its share of join requests today. ${TOO_MANY_REQUESTS}`);
              }
            }
          });
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
    const [head, roster] = await Promise.all([this.ch.head(), this.members()]);
    await this.ch
      .stream(head, () => {}, {
        signal: ac.signal,
        onOpen: ({ presence }) => void presence({ client: "probe", query: true }),
        onPresence: (p) => {
          if (p.client === "probe" || p.from === this.me) return;
          // Only trust presence signed by the key the owner admitted under that name.
          if (!p.sigOk || roster.find((r) => r.name === p.from && r.active)?.pk !== p.pk) return;
          if (!found.has(p.from)) heard();
          const role = typeof p.role === "string" ? inlineText(p.role, 80) || undefined : undefined;
          found.set(p.from, { ...p, ...(typeof p.role === "string" ? { role } : {}) });
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
    // "--to all": for everyone, on purpose. It reaches every agent; a message with no --to only reaches those following all chat.
    if (to?.some((t) => EVERYONE.has(t.toLowerCase()))) return ["*"];
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
    await this.mayI({ kind: opts.kind ?? "msg", ev: opts.ev });
    return this.ch.send(body, { ...opts, to: await this.resolveTo(opts.to) });
  }

  /**
   * Refuse here what the owner hasn't let this member send: every client would refuse it in fold
   * anyway, so sending it would only leave a dead message in the log.
   */
  private async mayI(m: { kind: Kind; ev?: Event }): Promise<void> {
    const { state } = await this.state();
    const me = state.members.get(this.me);
    const why = me && refusal(me.scopes, m);
    if (why) throw new Rejected(`the owner hasn't let you do that: you ${why} here (you may ${me.scopes.length ? describeScopes(me.scopes) : "only read"})`);
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
    // Only answers signed by a key the owner admitted under the sender's name count.
    let roster = await this.members(true);
    const genuine = async (m: Message) => {
      const ok = () => !!m.sigOk && !!m.pk && roster.some((r) => r.name === m.from && r.pk === m.pk);
      if (ok()) return true;
      roster = await this.members(true);
      return ok();
    };
    const ac = new AbortController();
    signal?.addEventListener("abort", () => ac.abort(), { once: true });
    const timer = setTimeout(() => ac.abort(), waitSec * 1000);
    await this.ch.stream(
      since,
      async (m) => {
        if (m.from === this.me || !m.re?.includes(seq) || !(await genuine(m))) return;
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
    await this.mayI({ kind });
    return this.ch.send(body, { to, kind, re: [seq], imgs });
  }

  /** Announce yourself. After joining, a different role or rules is a request: the owner decides. */
  async hello(role?: string, about?: string): Promise<number> {
    return this.event({ op: "hello", role, about }, `joined${role ? ` as ${role}` : ""}`);
  }

  /**
   * Owner: set a member's role and rules, give them the role they asked for, or
   * refuse it. Sent as the owner, so every client checks it's the owner's word.
   */
  async decideRole(member: string, decision: { role: string | null; about?: string | null } | "allow" | "refuse"): Promise<number> {
    if (!this.ownerCh) throw new Rejected("only the channel owner's machine decides roles");
    const { state } = await this.state();
    const m = state.members.get(member);
    if (!m?.active) throw new Rejected(`no member named ${member}`);
    let ev: Event;
    if (decision === "refuse") ev = { op: "role.refuse", member };
    else if (decision === "allow") {
      if (!m.roleRequest) throw new Rejected(`${member} hasn't asked for a role`);
      ev = { op: "role.set", member, role: m.roleRequest.role ?? null, about: m.roleRequest.about ?? null };
    } else ev = { op: "role.set", member, ...decision };
    return this.ownerCh.send(ev.op === "role.refuse" ? `kept ${member}'s role` : `made ${member} ${ev.role ?? "unassigned"}`, { kind: "event", ev });
  }

  /**
   * Owner: what a member may do besides read (null: everything). Signed by the owner key, so every
   * client checks it's the owner's word; it names the member's key, so it never carries over to
   * whoever is admitted under that name next. The relay is told the one bit it enforces itself.
   */
  async setScopes(member: string, scopes: Scope[] | null): Promise<ChannelState> {
    if (!this.ownerCh) throw new Rejected("only the channel owner's machine sets what members may do");
    const { state } = await this.state();
    const m = state.members.get(member);
    if (!m?.active) throw new Rejected(`no member named ${member}`);
    if (m.owner) throw new Rejected("the owner may do everything");
    const wire = wireScopes(scopes);
    const ev: Event = { op: "scope.set", member, pk: m.pk, scopes: wire };
    const after = await this.confirm(await this.ownerCh.send(`set what ${member} may do: ${wire ? describeScopes(wire) : "full"}`, { kind: "event", ev }));
    // The log is the record; the relay's bit follows. If this fails, ownerChores puts it right next time.
    await this.ownerCh.setCanPost(m.pk, canPost(after.members.get(member)?.scopes ?? [])).catch(() => {
      this.postingChecked = false;
    });
    return after;
  }

  /**
   * A person's colour (null clears it). Signed by the person themself when it's
   * this session's own name, else by the owner key on this machine. The fold
   * refuses a colour someone else has, and colours on agents.
   */
  async setColor(member: string, color: Color | null): Promise<ChannelState> {
    const ch = member === this.me ? this.ch : this.ownerCh;
    if (!ch) throw new Rejected("only that person, or the channel owner's machine, sets their colour");
    const ev: Event = { op: "color.set", member, color };
    if (ch === this.ch) await this.mayI({ kind: "event", ev });
    return this.confirm(await ch.send(color ? `${member}'s colour is ${color}` : `cleared ${member}'s colour`, { kind: "event", ev }));
  }

  // ---------- events ----------

  private async event(ev: Event, body: string, to?: string[]): Promise<number> {
    await this.mayI({ kind: "event", ev });
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
    if (t.state === "cancelled") throw new Rejected(`${taskId(id)} is cancelled`);
    if (t.owner && t.owner !== this.me) throw new Rejected(`${taskId(id)} is owned by ${t.owner}`);
    const waits = waitingOn(state, t);
    const seq = await this.event({ op: "task.claim", task: id }, `claimed ${taskId(id)}`);
    const after = await this.confirm(seq);
    if (waits.length) throw new Rejected(`claimed, but ${taskId(id)} is still waiting on ${waits.map(taskId).join(", ")}`);
    return after;
  }

  async taskUpdate(id: number, change: { state?: TaskState; owner?: string | null; title?: string; note?: string; after?: number[] }): Promise<ChannelState> {
    const { state } = await this.state();
    const t = state.tasks.get(id);
    if (!t) throw new Rejected(`no task ${taskId(id)}`);
    if (change.state && !TASK_STATES.includes(change.state)) throw new Rejected(`state must be one of ${TASK_STATES.join(", ")}`);
    if (change.after?.length) this.checkAfter(state, id, change.after);
    const owner = change.owner ? (await this.resolveTo([change.owner], state))?.[0] : change.owner;
    // Tell whoever this concerns: the new owner, the current owner if it isn't
    // us, the creator when it's done or cancelled, and owners of tasks it unblocks.
    const notify: string[] = [];
    if (owner) notify.push(owner);
    if (t.owner && t.owner !== this.me) notify.push(t.owner);
    if (change.state === "done" || change.state === "cancelled") {
      notify.push(t.createdBy);
      for (const other of state.tasks.values()) if (other.after.includes(id) && other.owner) notify.push(other.owner);
    }
    const seq = await this.event({ op: "task.update", task: id, ...change, ...(owner !== undefined ? { owner } : {}) }, `${taskId(id)} ${change.state ?? "updated"}`, notify);
    return this.confirm(seq);
  }

  /** Append dependencies. Missing ids, self-deps and cycles are refused. */
  async taskAfter(id: number, deps: number[]): Promise<ChannelState> {
    if (!deps.length) throw new Rejected("name at least one task to wait on");
    const { state } = await this.state();
    this.checkAfter(state, id, deps);
    const seq = await this.event({ op: "task.update", task: id, after: deps }, `${taskId(id)} waits on ${deps.map(taskId).join(", ")}`);
    return this.confirm(seq);
  }

  private checkAfter(state: ChannelState, id: number, deps: number[]): void {
    if (!state.tasks.has(id)) throw new Rejected(`no task ${taskId(id)}`);
    for (const d of deps) {
      if (!state.tasks.has(d)) throw new Rejected(`no task ${taskId(d)}`);
      if (wouldCycle(state.tasks, id, d)) throw new Rejected(`${taskId(id)} waiting on ${taskId(d)} would cycle`);
    }
  }

  async claim(paths: string[], ttlSec: number, note?: string, place?: { machine?: string; checkout?: string }): Promise<ChannelState> {
    const { state } = await this.state();
    for (const p of paths) {
      const c = state.claims.find((x) => x.owner !== this.me && overlaps(x.path, p));
      if (c) throw new Rejected(claimConflict(c));
    }
    const seq = await this.event(
      { op: "claim", paths, ttl: ttlSec, ...(note ? { note } : {}), ...(place?.machine ? { machine: place.machine } : {}), ...(place?.checkout ? { checkout: place.checkout } : {}) },
      `claimed ${paths.join(", ")}`,
    );
    return this.confirm(seq);
  }

  async release(paths?: string[]): Promise<number> {
    return this.event({ op: "release", ...(paths?.length ? { paths } : {}) }, paths?.length ? `released ${paths.join(", ")}` : "released all claims");
  }

  async setFact(key: string, value: string, ttlSec?: number): Promise<number> {
    return this.event({ op: "fact.set", key, value, ...(ttlSec ? { ttl: ttlSec } : {}) }, `${key} = ${value}`);
  }

  async delFact(key: string): Promise<number> {
    return this.event({ op: "fact.del", key }, `unset ${key}`);
  }
}

export type { Presence };

/**
 * `AgentSession.wants`, for callers that have the state but no session (kiwi sh).
 * By default an agent gets what's for it: messages to it or its role, broadcasts
 * from people and broadcast questions, and every message in a thread it's in.
 * Other agents' conversations stay out unless it asks for all chat.
 */
export function wants(me: string, m: Message, state: ChannelState | null, d: Delivery = {}): boolean {
  if (m.from === me) return false;
  // Forged messages never reach an agent: they're noise at best, prompt injection at worst. Nor do
  // ones the owner didn't let their sender send (outside its scopes).
  if (ignored(state?.trust.get(m.seq))) return false;
  if (d.all) return true;
  // Any message of a thread names it: its root, or a reply in it.
  if (d.thread !== undefined) return m.kind !== "event" && (state?.threadOf.get(m.seq) ?? m.seq) === (state?.threadOf.get(d.thread) ?? d.thread);
  const role = state?.members.get(me)?.role;
  const addressed = isDirectedAt(m, me) || !!m.to?.includes("*") || (!!role && !!m.to?.includes(`role:${role}`));
  if (m.kind === "event") return addressed || m.ev?.op === "hello";
  if (d.chat) return true;
  const asking = isForAgent(m, me) && (m.kind === "ask" || m.kind === "blocking");
  if (d.forMe) return addressed || asking;
  const sender = state?.members.get(m.from);
  const fromPerson = !m.to?.length && (sender?.kind === "human" || !!sender?.owner);
  const inMyThread = !!state?.threadPeople.get(state.threadOf.get(m.seq) ?? m.seq)?.has(me);
  return addressed || asking || fromPerson || inMyThread;
}
