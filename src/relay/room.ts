// Room logic shared by the Cloudflare Durable Object and the self-hosted Bun
// relay. Both back a room with SQLite; each adapter supplies the SQL calls and
// applies the returned effects (fan-out, disconnects, wiping the room).
//
// Every channel is owner-gated:
//   - the owner creates the room and is its first member;
//   - anyone holding the join code may *ask* to join (a pending request);
//   - only the owner can approve, which enrolls the requester's key and hands
//     it the channel keys, wrapped so only that key can open them;
//   - every request and socket is signed by a member key; no shared secret
//     ever reaches the relay;
//   - leaving or being removed revokes access at once, and the owner rotates
//     the channel key so the departed key can't read anything newer;
//   - closing deletes the room outright: no tombstone, nothing to recover.
//
// The relay stores public keys, opaque sealed blobs and ciphertext. Member
// names, roles and every message stay end-to-end encrypted.

import { verifyRequest } from "../auth.ts";
import { encodeJoinCode, ownerFingerprint } from "../crypto.ts";
import { HUMAN_HEADER, type HumanAuth } from "./human.ts";
import { betaMessage, inBeta, OPEN_POLICY, type RelayPolicy } from "./policy.ts";
import { verify } from "../identity.ts";
import {
  CLOSE_CLOSED,
  CLOSE_REMOVED,
  MAX_CT_LENGTH,
  MAX_EPH_LENGTH,
  PAGE_LIMIT,
  ROOM_RETENTION,
  WS_PROTOCOL,
  type ClientFrame,
  type Envelope,
  type ServerFrame,
} from "../protocol.ts";

export interface Sql {
  run(query: string, ...params: (string | number | null)[]): void;
  all<T>(query: string, ...params: (string | number | null)[]): T[];
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What an adapter must do after handling a request or frame. */
export interface Effects {
  /** Send to every socket. */
  broadcast?: string[];
  /** Send to every socket except the sender. */
  others?: string;
  /** Send to the sender only. */
  reply?: string;
  /** Disconnect every socket authenticated as this key. */
  disconnect?: string;
  /** Delete the room's storage, then disconnect everyone. */
  wipe?: boolean;
  /** Update signed-in people's channel lists (a null entry drops this channel from theirs). */
  directory?: DirectoryUpdate[];
}

/**
 * One signed-in person's tie to a channel, for their channel list: they own
 * it, they're in it, and/or agents they vouched for are. The relay already
 * knows these links; names and messages stay sealed.
 */
export interface DirectoryEntry {
  room: string;
  code: string;
  owner: boolean;
  member: boolean;
  agents: number;
  at: number;
}

export interface DirectoryUpdate {
  user: string;
  room: string;
  entry: DirectoryEntry | null;
}

const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/** "3h 12m": how long until the UTC date changes. */
function untilUtcMidnight(ts: number): string {
  const d = new Date(ts);
  const left = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - ts;
  const h = Math.floor(left / 3_600_000);
  const m = Math.ceil((left % 3_600_000) / 60_000);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function formatBytes(n: number): string {
  return n >= 1024 ** 3 ? `${+(n / 1024 ** 3).toFixed(1)} GB` : `${+(n / 1024 ** 2).toFixed(1)} MB`;
}

/** Messages one member may post per minute: plenty for real work, too few to flush a channel's history. */
const MESSAGES_PER_MINUTE = 120;
/** Presence and other ephemeral frames one member may send per minute. */
const EPHEMERAL_PER_MINUTE = 60;
const windows = new Map<string, { start: number; n: number }>();

/** A fixed one-minute window per key; false once the key has used up its limit. */
function allow(key: string, limit: number): boolean {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now - w.start > 60_000) {
    if (windows.size > 10_000) windows.clear();
    windows.set(key, { start: now, n: 1 });
    return true;
  }
  return ++w.n <= limit;
}

/** Most join requests a room holds at once; stops request spam. */
const MAX_PENDING = 20;
/** Pending requests expire after this long. */
const REQUEST_TTL_MS = 60 * 60_000;

const frame = (f: ServerFrame) => JSON.stringify(f);

/** The signed token from the Authorization header or, for WebSockets, the subprotocol list. */
export function requestToken(req: Request): string {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const protos = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim());
  if (protos[0] === WS_PROTOCOL && protos[1]) return protos[1];
  return "";
}

/** Response headers that accept the Channels subprotocol, if the client offered it. */
export function wsHeaders(req: Request): Record<string, string> {
  return req.headers.get("sec-websocket-protocol")?.includes(WS_PROTOCOL) ? { "sec-websocket-protocol": WS_PROTOCOL } : {};
}

interface Meta {
  ownerPk: string;
  ownerXpk: string;
  ownerSig: string;
  epoch: number;
  rotate: boolean;
}

export class RoomStore {
  constructor(
    private readonly sql: Sql,
    readonly roomId: string,
    /** What this relay allows (quotas, caps). */
    readonly policy: RelayPolicy = OPEN_POLICY,
    /** The clock, injectable so tests can cross midnight without waiting for it. */
    private readonly now: () => number = Date.now,
  ) {}

  /** Tables exist only once a room is created, so a closed room leaves nothing behind. */
  exists(): boolean {
    return this.sql.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").length > 0;
  }

  /** A room from before owner-gated channels: it has data but no owner. Such rooms are deleted on sight. */
  isLegacy(): boolean {
    return this.exists() && !this.get("owner_pk");
  }

  private init(): void {
    this.sql.run("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.sql.run("CREATE TABLE msgs (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, iv TEXT NOT NULL, ct TEXT NOT NULL, e INTEGER NOT NULL)");
    // Former members keep their sealed record (so their history still verifies) but lose every key.
    this.sql.run(
      "CREATE TABLE members (pk TEXT PRIMARY KEY, xpk TEXT NOT NULL, rec TEXT NOT NULL, rec_e INTEGER NOT NULL, since INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)",
    );
    this.sql.run("CREATE TABLE keys (pk TEXT NOT NULL, e INTEGER NOT NULL, wrapped TEXT NOT NULL, PRIMARY KEY (pk, e))");
    this.sql.run(
      "CREATE TABLE requests (id TEXT PRIMARY KEY, pk TEXT NOT NULL UNIQUE, xpk TEXT NOT NULL, box TEXT NOT NULL, sig TEXT NOT NULL, ts INTEGER NOT NULL, status TEXT NOT NULL)",
    );
    this.migrate();
  }

  /**
   * Columns added after rooms already existed. Requests know whether they come
   * from an agent or a human, and which signed-in human vouches for an agent
   * (its sponsor: the person whose linked computer it joined from).
   */
  private migrate(): void {
    const cols = new Set(this.sql.all<{ name: string }>("PRAGMA table_info(requests)").map((c) => c.name));
    for (const [col, def] of [
      ["kind", "TEXT NOT NULL DEFAULT 'agent'"],
      ["sponsor_user", "TEXT"],
      ["sponsor_name", "TEXT"],
      ["received", "INTEGER"],
      ["sponsor_req", "TEXT"],
    ] as const) {
      if (!cols.has(col)) this.sql.run(`ALTER TABLE requests ADD COLUMN ${col} ${def}`);
    }
  }

  private get(k: string): string | undefined {
    return this.sql.all<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)[0]?.v;
  }

  private set(k: string, v: string | number): void {
    this.sql.run("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, String(v));
  }

  /** The signed-in human (WorkOS user id) who owns this channel, when the relay requires sign-in. */
  ownerUser(): string | undefined {
    return this.get("owner_user");
  }

  meta(): Meta {
    if (!this.exists()) throw new HttpError(404, "no such channel");
    return {
      ownerPk: this.get("owner_pk")!,
      ownerXpk: this.get("owner_xpk")!,
      ownerSig: this.get("owner_sig")!,
      epoch: Number(this.get("epoch") ?? 0),
      rotate: this.get("rotate") === "1",
    };
  }

  isMember(pk: string): boolean {
    return this.sql.all("SELECT 1 FROM members WHERE pk = ? AND active = 1", pk).length > 0;
  }

  /** The member key that signed this request, or a 401/403. */
  async authenticate(req: Request, method: string, path: string, body: string): Promise<string> {
    // A closed channel has no tables at all: say so, so members forget it.
    if (!this.exists()) throw new HttpError(404, "no such channel");
    const pk = await verifyRequest(requestToken(req), this.roomId, method, path, body);
    if (!pk) throw new HttpError(401, "bad or expired signature");
    if (!this.isMember(pk)) throw new HttpError(403, "not a member of this channel");
    return pk;
  }

  head(): number {
    return this.sql.all<{ s: number | null }>("SELECT MAX(seq) AS s FROM msgs")[0]?.s ?? 0;
  }

  append(iv: string, ct: string, e: number): Envelope {
    if (typeof iv !== "string" || typeof ct !== "string" || !iv || !ct) throw new HttpError(400, "bad envelope");
    if (ct.length > MAX_CT_LENGTH) throw new HttpError(413, "message too large");
    const epoch = this.meta().epoch;
    // Sealed with a retired key: the sender must fetch the new one and resend.
    if (e !== epoch) throw new HttpError(409, `stale key epoch ${e}; current is ${epoch}`);
    const ts = this.now();

    // Messages per channel per UTC day.
    const day = utcDay(ts);
    const today = this.messagesToday(ts);
    const perDay = this.policy.messagesPerDay;
    if (perDay && today >= perDay) {
      throw new HttpError(429, `this channel has stored ${perDay} messages today, its daily limit; more can be sent after 00:00 UTC (in ${untilUtcMidnight(ts)})`);
    }

    // Stored bytes per channel: the oldest messages make room, the way the 10,000-message
    // retention already works, so a busy channel never freezes. Only a message bigger than
    // the whole allowance is refused.
    const cap = this.policy.bytesPerChannel;
    if (ct.length > cap) throw new HttpError(413, `that message is bigger than this channel may hold (${formatBytes(cap)})`);
    let bytes = this.storedBytes();
    if (bytes + ct.length > cap) bytes -= this.dropOldest(bytes + ct.length - cap);

    this.sql.run("INSERT INTO msgs (ts, iv, ct, e) VALUES (?, ?, ?, ?)", ts, iv, ct, e);
    const seq = this.head();
    bytes += ct.length;
    // Prune in batches so retention costs one extra write pass per 100 messages.
    if (seq % 100 === 0) bytes -= this.dropThrough(seq - ROOM_RETENTION);
    this.set("bytes", bytes);
    this.set("day", day);
    this.set("day_count", today + 1);
    return { seq, ts, iv, ct, e };
  }

  /** Messages stored today (UTC), by the counter in meta: it starts over when the date changes. */
  messagesToday(now = this.now()): number {
    return this.get("day") === utcDay(now) ? Number(this.get("day_count") ?? 0) : 0;
  }

  /** Total ciphertext the channel holds, kept in meta (counted once for rooms from before it was). */
  storedBytes(): number {
    const known = this.get("bytes");
    if (known !== undefined) return Number(known);
    const total = this.sql.all<{ n: number }>("SELECT COALESCE(SUM(LENGTH(ct)), 0) AS n FROM msgs")[0]?.n ?? 0;
    this.set("bytes", total);
    return total;
  }

  /** Delete messages through `seq`; returns the ciphertext bytes freed. */
  private dropThrough(seq: number): number {
    if (seq <= 0) return 0;
    const freed = this.sql.all<{ n: number }>("SELECT COALESCE(SUM(LENGTH(ct)), 0) AS n FROM msgs WHERE seq <= ?", seq)[0]?.n ?? 0;
    if (freed) this.sql.run("DELETE FROM msgs WHERE seq <= ?", seq);
    return freed;
  }

  /** Delete the oldest messages until at least `need` bytes are free; returns the bytes freed. */
  private dropOldest(need: number): number {
    let freed = 0;
    let through = 0;
    for (const r of this.sql.all<{ seq: number; n: number }>("SELECT seq, LENGTH(ct) AS n FROM msgs ORDER BY seq")) {
      freed += r.n;
      through = r.seq;
      if (freed >= need) break;
    }
    return this.dropThrough(through);
  }

  /** How many members (people and agents) are in the channel now. */
  activeMembers(): number {
    return this.sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE active = 1")[0]?.n ?? 0;
  }

  since(seq: number, limit = PAGE_LIMIT): Envelope[] {
    return this.sql.all<Envelope>("SELECT seq, ts, iv, ct, e FROM msgs WHERE seq > ? ORDER BY seq LIMIT ?", seq, Math.min(Math.max(limit, 1), PAGE_LIMIT));
  }

  // ---------- lifecycle ----------

  /**
   * Create the room. The owner signs its own public keys; the request itself
   * must be signed by the owner. `members` must include the owner and may
   * include the creating agent.
   */
  async create(signer: string | null, body: CreateBody, ownerUser: string | null = null): Promise<void> {
    if (this.exists()) throw new HttpError(409, "channel already exists");
    const { owner, members } = body;
    if (!owner || signer !== owner.pk) throw new HttpError(401, "create must be signed by the owner");
    const signed =
      (await verify({ room: this.roomId, pk: owner.pk, xpk: owner.xpk, v: 2, sig: owner.sig })) || (await verify({ room: this.roomId, pk: owner.pk, xpk: owner.xpk, sig: owner.sig }));
    if (!signed) throw new HttpError(400, "bad owner signature");
    if (!members?.some((m) => m.pk === owner.pk)) throw new HttpError(400, "the owner must be a member");
    this.init();
    this.set("owner_pk", owner.pk);
    this.set("owner_xpk", owner.xpk);
    this.set("owner_sig", owner.sig);
    this.set("epoch", 0);
    this.set("created", Date.now());
    if (ownerUser) this.set("owner_user", ownerUser);
    // The channel's name, sealed with its key: members can read it, the relay can't.
    if (body.title && typeof body.title.iv === "string" && typeof body.title.ct === "string" && body.title.ct.length < 2048) this.set("title", JSON.stringify(body.title));
    for (const m of members) this.putMember(m, 0);
  }

  /** The channel's sealed name, if its creator gave one. */
  title(): { iv: string; ct: string } | null {
    const t = this.get("title");
    return t ? (JSON.parse(t) as { iv: string; ct: string }) : null;
  }

  // ---------- who this channel is listed for ----------

  /** Signed-in people tied to this channel now: its owner, people in it, and people whose agents are in it. */
  private links(): Map<string, { owner: boolean; member: boolean; agents: number }> {
    this.migrate();
    const links = new Map<string, { owner: boolean; member: boolean; agents: number }>();
    const owner = this.ownerUser();
    if (owner) links.set(owner, { owner: true, member: true, agents: 0 });
    const rows = this.sql.all<{ kind: string; user: string }>(
      "SELECT r.kind AS kind, r.sponsor_user AS user FROM requests r JOIN members m ON m.pk = r.pk WHERE r.status = 'approved' AND m.active = 1 AND r.sponsor_user IS NOT NULL",
    );
    for (const r of rows) {
      const l = links.get(r.user) ?? { owner: false, member: false, agents: 0 };
      if (r.kind === "human") l.member = true;
      else l.agents++;
      links.set(r.user, l);
    }
    return links;
  }

  private linked(): string[] {
    return JSON.parse(this.get("linked") ?? "[]") as string[];
  }

  /** Bring everyone's channel list in line with who's tied to this channel now. */
  async directory(): Promise<DirectoryUpdate[]> {
    const meta = this.meta();
    const code = encodeJoinCode({ roomId: this.roomId, ownerFp: await ownerFingerprint(meta.ownerPk) });
    const at = Number(this.get("created") ?? Date.now());
    const links = this.links();
    const updates: DirectoryUpdate[] = [...links].map(([user, l]) => ({ user, room: this.roomId, entry: { room: this.roomId, code, ...l, at } }));
    for (const user of this.linked()) if (!links.has(user)) updates.push({ user, room: this.roomId, entry: null });
    this.set("linked", JSON.stringify([...links.keys()]));
    return updates;
  }

  /** Before closing: drop this channel from every list it was on. */
  unlinkAll(): DirectoryUpdate[] {
    const users = new Set([...this.linked(), ...(this.ownerUser() ? [this.ownerUser()!] : [])]);
    return [...users].map((user) => ({ user, room: this.roomId, entry: null }));
  }

  private putMember(m: MemberBody, epoch: number): void {
    if (typeof m.pk !== "string" || typeof m.xpk !== "string" || typeof m.rec !== "string") throw new HttpError(400, "bad member");
    this.sql.run(
      "INSERT INTO members (pk, xpk, rec, rec_e, since, active) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT (pk) DO UPDATE SET xpk = excluded.xpk, rec = excluded.rec, rec_e = excluded.rec_e, active = 1",
      m.pk,
      m.xpk,
      m.rec,
      epoch,
      Date.now(),
    );
    for (const [e, wrapped] of Object.entries(m.keys ?? {})) {
      this.sql.run("INSERT OR REPLACE INTO keys (pk, e, wrapped) VALUES (?, ?, ?)", m.pk, Number(e), wrapped);
    }
  }

  // ---------- join requests ----------

  /**
   * File a join request. With `human` set, it's a signed-in person joining for
   * themself (they are their own sponsor); otherwise it's an agent, which on a
   * sign-in relay arrives vouched for by the person whose computer it joined from.
   */
  async request(body: RequestBody, human: { user: string; name: string } | null = null, vouchUser: string | null = null): Promise<{ id: string; fresh: boolean }> {
    this.meta();
    this.migrate();
    const { pk, xpk, box, ts, sig } = body ?? ({} as RequestBody);
    if (![pk, xpk, box, sig].every((x) => typeof x === "string") || typeof ts !== "number") throw new HttpError(400, "bad request");
    if (box.length > 4096) throw new HttpError(413, "request too large");
    if (!(await verify({ room: this.roomId, pk, xpk, box, ts, sig }))) throw new HttpError(400, "bad request signature");
    if (Math.abs(Date.now() - ts) > REQUEST_TTL_MS) throw new HttpError(400, "request timestamp out of range");
    if (this.isMember(pk)) throw new HttpError(409, "already a member");
    // Expiry and order use when the relay received a request, not the time the requester claims.
    this.sql.run("DELETE FROM requests WHERE status = 'pending' AND COALESCE(received, ts) < ?", Date.now() - REQUEST_TTL_MS);
    const existing = this.sql.all<{ id: string; status: string }>("SELECT id, status FROM requests WHERE pk = ?", pk)[0];
    if (existing?.status === "denied") throw new HttpError(403, "this key was denied");
    if (this.sql.all("SELECT 1 FROM members WHERE pk = ? AND active = 0", pk).length) throw new HttpError(403, "this key was removed; join with a new identity");
    if (existing) {
      // Asking again from a computer its person has since linked: the vouch applies now.
      if (vouchUser && !human) this.sql.run("UPDATE requests SET sponsor_user = ? WHERE id = ? AND status = 'pending' AND sponsor_user IS NULL AND kind = 'agent'", vouchUser, existing.id);
      return { id: existing.id, fresh: false };
    }
    const pending = this.sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM requests WHERE status = 'pending'")[0]!.n;
    if (pending >= MAX_PENDING) throw new HttpError(429, "too many pending join requests");
    const id = crypto.randomUUID();
    this.sql.run(
      "INSERT INTO requests (id, pk, xpk, box, sig, ts, status, kind, sponsor_user, sponsor_name, received) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?)",
      id,
      pk,
      xpk,
      box,
      sig,
      ts,
      human ? "human" : "agent",
      // Only the sign-in user id is kept; names are looked up when the owner reads requests.
      // An agent from a computer its person linked arrives already vouched for by them.
      human?.user ?? vouchUser ?? null,
      Date.now(),
    );
    return { id, fresh: true };
  }

  requestStatus(id: string, pk: string): { status: string; sponsored: boolean; epoch?: number; keys?: Record<string, string> } {
    this.meta();
    this.migrate();
    const r = this.sql.all<{ pk: string; status: string; sponsor_user: string | null }>("SELECT pk, status, sponsor_user FROM requests WHERE id = ?", id)[0];
    if (!r || r.pk !== pk) throw new HttpError(404, "no such request");
    if (r.status !== "approved" || !this.isMember(pk)) return { status: r.status, sponsored: !!r.sponsor_user };
    return { status: "approved", sponsored: !!r.sponsor_user, ...this.keysFor(pk) };
  }

  pendingRequests(): (RequestBody & { kind: string; sponsorUser: string | null; sponsorName: string | null })[] {
    this.migrate();
    return this.sql.all(
      "SELECT id, pk, xpk, box, sig, ts, kind, sponsor_user AS sponsorUser, sponsor_name AS sponsorName FROM requests WHERE status = 'pending' ORDER BY COALESCE(received, ts)",
    );
  }

  /** On a sign-in relay, agents need their human's vouch before the owner can admit them. */
  requireSponsor(request: string | undefined, pk: string): void {
    this.migrate();
    const r = request ? this.sql.all<{ pk: string; sponsor_user: string | null }>("SELECT pk, sponsor_user FROM requests WHERE id = ?", request)[0] : undefined;
    if (!r || r.pk !== pk) throw new HttpError(400, "approve a pending request");
    if (!r.sponsor_user) throw new HttpError(409, "this agent wasn't vouched for by a person's linked computer");
  }

  deny(id: string): void {
    this.sql.run("UPDATE requests SET status = 'denied' WHERE id = ?", id);
  }

  // ---------- members & keys ----------

  approve(body: MemberBody & { request?: string }): void {
    const { epoch } = this.meta();
    const most = this.policy.membersPerChannel;
    if (most && !this.isMember(body.pk) && this.activeMembers() >= most) {
      throw new HttpError(429, `this channel has ${most} members, the most this relay allows; remove someone to let another in`);
    }
    for (let e = 0; e <= epoch; e++) {
      if (!body.keys?.[String(e)]) throw new HttpError(400, `missing wrapped key for epoch ${e}`);
    }
    this.putMember(body, epoch);
    if (body.request) this.sql.run("UPDATE requests SET status = 'approved' WHERE id = ? AND pk = ?", body.request, body.pk);
  }

  members(): { pk: string; xpk: string; rec: string; e: number; active: number }[] {
    return this.sql.all("SELECT pk, xpk, rec, rec_e AS e, active FROM members ORDER BY since");
  }

  keysFor(pk: string): { epoch: number; keys: Record<string, string> } {
    const rows = this.sql.all<{ e: number; wrapped: string }>("SELECT e, wrapped FROM keys WHERE pk = ?", pk);
    return { epoch: this.meta().epoch, keys: Object.fromEntries(rows.map((r) => [String(r.e), r.wrapped])) };
  }

  remove(pk: string): void {
    const { ownerPk } = this.meta();
    if (pk === ownerPk) throw new HttpError(400, "the owner can't leave; close the channel instead");
    if (!this.isMember(pk)) throw new HttpError(404, "not a member");
    this.sql.run("UPDATE members SET active = 0 WHERE pk = ?", pk);
    this.sql.run("DELETE FROM keys WHERE pk = ?", pk);
    this.sql.run("DELETE FROM requests WHERE pk = ?", pk);
    // Its keys are revoked at the relay; the owner rotates so they also can't decrypt anything newer.
    this.set("rotate", 1);
  }

  rotate(epoch: number, keys: Record<string, string>): void {
    const meta = this.meta();
    if (epoch !== meta.epoch + 1) throw new HttpError(409, `next epoch is ${meta.epoch + 1}`);
    const members = this.members().filter((m) => m.active);
    for (const m of members) if (!keys[m.pk]) throw new HttpError(400, `missing wrapped key for ${m.pk.slice(0, 8)}`);
    for (const m of members) this.sql.run("INSERT OR REPLACE INTO keys (pk, e, wrapped) VALUES (?, ?, ?)", m.pk, epoch, keys[m.pk]!);
    this.set("epoch", epoch);
    this.set("rotate", 0);
  }
}

export interface MemberBody {
  pk: string;
  xpk: string;
  /** Owner-signed member record, sealed with the channel key (the relay can't read names). */
  rec: string;
  /** Channel keys by epoch, each sealed to this member's `xpk`. */
  keys?: Record<string, string>;
}

export interface CreateBody {
  /** The channel's name, sealed with the epoch-0 key. */
  title?: { iv: string; ct: string };
  owner: { pk: string; xpk: string; sig: string };
  members: MemberBody[];
}

export interface RequestBody {
  id?: string;
  pk: string;
  xpk: string;
  /** Name/role/about, sealed to the owner's xpk. */
  box: string;
  ts: number;
  sig: string;
}

export function msgFrame(e: Envelope): string {
  return frame({ t: "msg", ...e });
}

/** Frames to send a newly connected socket: the backlog after `since`, then ready. */
export function welcomeFrames(store: RoomStore, since: number): string[] {
  const backlog = store.since(since);
  const head = store.head();
  const last = backlog.at(-1)?.seq ?? since;
  return [...backlog.map(msgFrame), frame({ t: "ready", head, more: last < head })];
}

/** Handle one frame from an authenticated socket. */
export function onClientFrame(store: RoomStore, raw: string, sender = ""): Effects {
  let f: ClientFrame;
  try {
    f = JSON.parse(raw);
  } catch {
    return { reply: frame({ t: "err", error: "bad json" }) };
  }
  if (f.t === "eph") {
    // Presence and other ephemeral signals: relayed, never stored, never acked.
    if (!allow(`eph:${store.roomId}:${sender}`, EPHEMERAL_PER_MINUTE)) return { reply: frame({ t: "err", error: "too many ephemeral frames; slow down" }) };
    if (typeof f.iv !== "string" || typeof f.ct !== "string" || f.ct.length > MAX_EPH_LENGTH) {
      return { reply: frame({ t: "err", error: "bad ephemeral frame" }) };
    }
    return { others: frame({ t: "eph", iv: f.iv, ct: f.ct }) };
  }
  if (f.t !== "send") return { reply: frame({ t: "err", error: "unknown frame" }) };
  if (!allow(`${store.roomId}:${sender}`, MESSAGES_PER_MINUTE)) return { reply: frame({ t: "err", error: "too many messages; wait a minute", id: f.id }) };
  try {
    const e = store.append(f.iv, f.ct, Number(f.e ?? 0));
    return { broadcast: [msgFrame(e)], reply: frame({ t: "ack", id: f.id, seq: e.seq }) };
  } catch (err) {
    return { reply: frame({ t: "err", error: err instanceof Error ? err.message : String(err), id: f.id }) };
  }
}

/**
 * The HTTP API (all under /v1/rooms/<room>):
 *   GET    /info                      public: owner keys, epoch, whether a rotation is due
 *   POST   /create                    owner: create the room
 *   POST   /requests                  anyone with the code: ask to join (self-signed)
 *   GET    /requests/<id>             the requester: status, and wrapped keys once approved
 *   GET    /requests                  owner: pending requests
 *   POST   /requests/<id>/deny        owner
 *   POST   /members                   owner: approve (enroll a key, hand it wrapped keys)
 *   GET    /members                   member: the sealed member records
 *   DELETE /members/me                member: leave
 *   DELETE /members/<pk>              owner: remove
 *   GET    /keys                      member: my wrapped channel keys
 *   POST   /epochs                    owner: rotate the channel key
 *   DELETE /                          owner: close and delete everything
 *   GET    /                          member: {head}
 *   GET    /messages?since=N          member
 *   POST   /messages                  member: {iv, ct, e}
 */
/** What an adapter hands the room logic besides the request: sign-in, vouching, and the relay's policy. */
export interface RelayContext {
  human?: HumanAuth | null;
  /** Who vouches for an agent key, from its computer's signature (see machines.ts). */
  vouch?: ((agentPk: string, machine: unknown) => Promise<string | null>) | null;
  policy?: RelayPolicy;
  /** How many channels a signed-in person owns now (from the adapter's per-person lists). */
  ownedChannels?: (user: string) => Promise<number>;
}

export async function onHttp(store: RoomStore, req: Request, path: string, ctx: RelayContext = {}): Promise<{ res: Response; fx?: Effects }> {
  const human = ctx.human ?? null;
  const vouch = ctx.vouch ?? null;
  const policy = ctx.policy ?? OPEN_POLICY;
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "DELETE" ? "" : await req.text();
  const json = <T>() => {
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new HttpError(400, "bad json");
    }
  };
  const ok = (data: unknown, fx?: Effects) => ({ res: Response.json(data), fx });

  // Shared-code rooms from before owners existed: delete them outright the first time anything touches them.
  if (store.isLegacy()) return { res: Response.json({ error: "no such channel" }, { status: 404 }), fx: { wipe: true } };

  /** The signed-in human behind this request, when the relay requires sign-in. */
  const signedIn = async (): Promise<string | null> => {
    if (!human) return null;
    const user = await human.verify(req.headers.get(HUMAN_HEADER) ?? "");
    if (!user) throw new HttpError(401, "sign in required: channels on this relay are owned and run by a signed-in human (use the dashboard)");
    return user;
  };

  if (path === "/info" && method === "GET") {
    const m = store.meta();
    return ok({ ownerPk: m.ownerPk, ownerXpk: m.ownerXpk, ownerSig: m.ownerSig, epoch: m.epoch, rotate: m.rotate, title: store.title() });
  }
  if (path === "/create" && method === "POST") {
    const signer = await verifyRequest(requestToken(req), store.roomId, method, path + url.search, body);
    const user = await signedIn();
    // During a private beta only listed people create channels; anyone may still join one.
    if (user && !(await inBeta(policy, user, human))) throw new HttpError(403, betaMessage(policy));
    const most = policy.channelsPerOwner;
    if (user && most && ctx.ownedChannels && (await ctx.ownedChannels(user)) >= most) {
      throw new HttpError(429, `you own ${most} channels, the most this relay allows per person; close one to create another`);
    }
    await store.create(signer, json<CreateBody>(), user);
    return ok({ head: 0 }, user ? { directory: await store.directory() } : undefined);
  }
  /** The signed-in human behind a request, with their name as WorkOS knows it. */
  const person = async (): Promise<{ user: string; name: string } | null> => {
    if (!human) return null;
    const token = req.headers.get(HUMAN_HEADER);
    if (!token) return null;
    const user = await human.verify(token);
    if (!user) throw new HttpError(401, "sign in again: that session isn't valid");
    const profile = (await human.profile?.(user).catch(() => null)) ?? null;
    return { user, name: profile?.name ?? user };
  };

  if (path === "/requests" && method === "POST") {
    const b = json<RequestBody & { machine?: unknown }>();
    const who = await person();
    const vouchUser = !who && vouch && typeof b?.pk === "string" ? await vouch(b.pk, b.machine) : null;
    // On a relay with sign-in, every agent arrives vouched for by its person's linked computer.
    if (human && !who && !vouchUser) throw new HttpError(403, "this computer isn't set up: its person runs `kiwi setup` once, then agents can join from it");
    const { id, fresh } = await store.request(b, who, vouchUser);
    return ok({ id }, fresh ? { broadcast: [frame({ t: "request" })] } : undefined);
  }
  const reqMatch = /^\/requests\/([0-9a-f-]{36})$/.exec(path);
  if (reqMatch && method === "GET") {
    // Signed by the requester's key, which isn't a member yet.
    const pk = await verifyRequest(requestToken(req), store.roomId, method, path + url.search, body);
    if (!pk) throw new HttpError(401, "bad or expired signature");
    return ok(store.requestStatus(reqMatch[1]!, pk));
  }

  const me = await store.authenticate(req, method, path + url.search, body);
  // Owner actions need the owner key's signature and, on relays that require sign-in,
  // the owning human's live session: a copied key file alone can't approve anyone.
  const owner = async () => {
    if (me !== store.meta().ownerPk) throw new HttpError(403, "only the channel owner can do that");
    const want = store.ownerUser();
    if (human && want) {
      const user = await signedIn();
      if (user !== want) throw new HttpError(403, "only the human who owns this channel can do that");
    }
  };

  if (path === "/" && method === "GET") return ok({ head: store.head() });
  if (path === "/messages" && method === "GET") {
    const since = Number(url.searchParams.get("since") ?? 0) || 0;
    const limit = Number(url.searchParams.get("limit") ?? PAGE_LIMIT) || PAGE_LIMIT;
    return ok({ head: store.head(), messages: store.since(since, limit) });
  }
  if (path === "/messages" && method === "POST") {
    if (!allow(`${store.roomId}:${me}`, MESSAGES_PER_MINUTE)) throw new HttpError(429, "too many messages; wait a minute");
    const b = json<{ iv?: string; ct?: string; e?: number }>();
    const e = store.append(b.iv as string, b.ct as string, Number(b.e ?? 0));
    return ok({ seq: e.seq, ts: e.ts }, { broadcast: [msgFrame(e)] });
  }
  if (path === "/keys" && method === "GET") return ok(store.keysFor(me));
  if (path === "/members" && method === "GET") return ok({ members: store.members() });
  if (path === "/members/me" && method === "DELETE") {
    store.remove(me);
    return ok({ left: true }, { disconnect: me, broadcast: [frame({ t: "roster" })], directory: await store.directory() });
  }
  if (path === "/requests" && method === "GET") {
    await owner();
    // Names and emails come from sign-in at read time, for the owner only; the relay doesn't keep them.
    const requests = await Promise.all(
      store.pendingRequests().map(async (r) => {
        const p = r.sponsorUser ? ((await human?.profile?.(r.sponsorUser).catch(() => null)) ?? null) : null;
        return { ...r, sponsorName: p?.name ?? r.sponsorName ?? r.sponsorUser, sponsorEmail: p?.email ?? null };
      }),
    );
    return ok({ requests });
  }
  const denyMatch = /^\/requests\/([0-9a-f-]{36})\/deny$/.exec(path);
  if (denyMatch && method === "POST") {
    await owner();
    store.deny(denyMatch[1]!);
    return ok({ denied: true });
  }
  if (path === "/members" && method === "POST") {
    await owner();
    const b = json<MemberBody & { request?: string }>();
    if (human && store.ownerUser()) store.requireSponsor(b.request, b.pk);
    store.approve(b);
    return ok({ approved: true }, { broadcast: [frame({ t: "roster" })], directory: await store.directory() });
  }
  const memberMatch = /^\/members\/([A-Za-z0-9_-]{20,})$/.exec(path);
  if (memberMatch && method === "DELETE") {
    await owner();
    store.remove(memberMatch[1]!);
    return ok({ removed: true }, { disconnect: memberMatch[1]!, broadcast: [frame({ t: "roster" })], directory: await store.directory() });
  }
  if (path === "/epochs" && method === "POST") {
    await owner();
    const b = json<{ epoch: number; keys: Record<string, string> }>();
    store.rotate(b.epoch, b.keys);
    return ok({ epoch: b.epoch }, { broadcast: [frame({ t: "epoch", epoch: b.epoch })] });
  }
  if (path === "/" && method === "DELETE") {
    await owner();
    return ok({ closed: true }, { directory: store.unlinkAll(), wipe: true });
  }
  throw new HttpError(404, "not found");
}

/** Authenticate a WebSocket upgrade; returns the member key. */
export async function authenticateSocket(store: RoomStore, req: Request): Promise<string> {
  return store.authenticate(req, "GET", "/ws", "");
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
  // Never log request details: room ids and keys are nobody's business.
  console.error(err instanceof Error ? err.message : "error");
  return Response.json({ error: "internal error" }, { status: 500 });
}

/** Parse /v1/rooms/<roomId><rest>. */
export function parseRoomPath(pathname: string): { roomId: string; rest: string } | null {
  const m = /^\/v1\/rooms\/([0-9a-f]{32})(\/.*)?$/.exec(pathname);
  return m ? { roomId: m[1]!, rest: m[2] ?? "/" } : null;
}

export { CLOSE_CLOSED, CLOSE_REMOVED };

/** GET /v1/me/channels: the signed-in person's channel list, from whatever index the adapter keeps. */
export async function myChannels(req: Request, human: HumanAuth | null, list: (user: string) => Promise<DirectoryEntry[]>): Promise<Response> {
  if (!human) throw new HttpError(404, "this relay has no sign-in");
  const user = await human.verify(req.headers.get(HUMAN_HEADER) ?? "");
  if (!user) throw new HttpError(401, "sign in to see your channels");
  const channels = (await list(user)).sort((a, b) => b.at - a.at);
  return Response.json({ channels });
}

/** Relay-wide settings the web app needs: which WorkOS client to sign in with, if any. */
export function relayConfig(human: HumanAuth | null): Response {
  return Response.json({ workosClientId: human?.clientId ?? null });
}
