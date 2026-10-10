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

import { tagForStatus, type ErrorTag } from "../errors.ts";
import { fits, JoinRequest, MemberRecord, SealedIcon, StoredEnvelope } from "./schema.ts";
import { verifyRequest } from "../auth.ts";
import { encodeJoinCode, ownerFingerprint } from "../crypto.ts";
import { HUMAN_HEADER, type HumanAuth } from "./human.ts";
import { betaMessage, inBeta, OPEN_POLICY, type RelayPolicy } from "./policy.ts";
import { verify, verifyText } from "../identity.ts";
import { commitTo, NONCE_RE, ownerNonceStatement } from "../sas.ts";
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

/** A refusal: its status, its text (API: clients show and match it), and what it means (src/errors.ts). */
export class HttpError extends Error {
  readonly tag: ErrorTag;
  constructor(
    readonly status: number,
    message: string,
    tag?: ErrorTag,
  ) {
    super(message);
    this.tag = tag ?? tagForStatus(status);
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
  /** The room was active: if it stays idle until this time, it expires (adapters schedule the check). */
  expireAt?: number;
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

/** One channel's use of its quotas. */
export interface RoomUsage {
  messagesToday: number;
  bytes: number;
  members: number;
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
export const MESSAGES_PER_MINUTE = 120;
/** Presence and other ephemeral frames one member may send per minute. */
const EPHEMERAL_PER_MINUTE = 60;
const windows = new Map<string, { start: number; n: number }>();

/** A fixed one-minute window per key; false once the key has used up its limit. */
export function allow(key: string, limit: number): boolean {
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
/** What a member the owner lets only read is told when they post anyway. */
const READ_ONLY = "the owner lets you only read in this channel";
/** What a client that speaks an old path is told. */
export const UPDATE_KIWI = "update kiwi to join or approve here: curl -fsSL https://channels.kiwiinit.com/install | sh (Windows: irm https://channels.kiwiinit.com/install.ps1 | iex)";

/**
 * GET /info with no `fp` is refused before the room is opened. A room id is not
 * a join code: only a client holding the code's fingerprint half may learn the
 * owner key or the owner's name. A present but wrong fingerprint falls through
 * and is answered like a missing room.
 */
export function requireInfoFingerprint(method: string, path: string, url: URL): void {
  if (method.toUpperCase() === "GET" && path === "/info" && url.searchParams.get("fp") === null) {
    throw new HttpError(426, UPDATE_KIWI);
  }
}

export const frame = (f: ServerFrame) => JSON.stringify(f);

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
    // A key the owner lets only read (member scopes): the one bit of them the relay knows.
    if (!this.sql.all<{ name: string }>("PRAGMA table_info(members)").some((c) => c.name === "read_only")) {
      this.sql.run("ALTER TABLE members ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0");
    }
    const cols = new Set(this.sql.all<{ name: string }>("PRAGMA table_info(requests)").map((c) => c.name));
    for (const [col, def] of [
      ["kind", "TEXT NOT NULL DEFAULT 'agent'"],
      ["sponsor_user", "TEXT"],
      ["sponsor_name", "TEXT"],
      ["received", "INTEGER"],
      ["sponsor_req", "TEXT"],
      // The join check (see sas.ts): the joiner's commit, the owner's signed nonce, the joiner's reveal.
      ["commit_to", "TEXT"],
      ["owner_nonce", "TEXT"],
      ["reveal", "TEXT"],
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
    if (!this.exists()) throw new HttpError(404, "no such channel", "ChannelGone");
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
    if (!this.exists()) throw new HttpError(404, "no such channel", "ChannelGone");
    const pk = await verifyRequest(requestToken(req), this.roomId, method, path, body);
    if (!pk) throw new HttpError(401, "bad or expired signature");
    if (!this.isMember(pk)) throw new HttpError(403, "not a member of this channel", "NotMember");
    return pk;
  }

  head(): number {
    return this.sql.all<{ s: number | null }>("SELECT MAX(seq) AS s FROM msgs")[0]?.s ?? 0;
  }

  append(iv: string, ct: string, e: number, sender: string): Envelope {
    // Every client refuses a read-only member's messages anyway; refusing them here keeps them out of storage.
    if (this.sql.all("SELECT 1 FROM members WHERE pk = ? AND read_only = 1", sender).length) throw new HttpError(403, READ_ONLY, "ReadOnly");
    if (!fits(StoredEnvelope, { iv, ct })) throw new HttpError(400, "bad envelope");
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

  // ---------- idle rooms expire ----------

  /**
   * Note activity (a stored message, a connection). On relays that expire idle rooms, returns
   * when this room expires if nothing else happens. Written at most once an hour, so a busy
   * room doesn't pay a write per message for it.
   */
  touch(): number | null {
    const days = this.policy.expireAfterDays;
    if (!days || !this.exists()) return null;
    const now = this.now();
    if (now - Number(this.get("active") ?? 0) < 3_600_000 && this.get("room")) return null;
    this.set("active", now);
    // The Worker's alarm runs without a request, so the room keeps its own id.
    this.set("room", this.roomId);
    return now + days * 86_400_000;
  }

  /** Whether the room has gone quiet for longer than the relay keeps idle rooms. */
  idleExpired(): boolean {
    const days = this.policy.expireAfterDays;
    if (!days || !this.exists()) return false;
    const last = Number(this.get("active") ?? this.get("created") ?? 0);
    return this.now() - last >= days * 86_400_000;
  }

  /** Expire exactly as a close would: off everyone's channel list, then every row gone. */
  expire(): Effects {
    return { directory: this.unlinkAll(), wipe: true };
  }

  /** What this channel uses, for its owner's usage page. Counts only: nothing sealed. */
  usage(): RoomUsage {
    return { messagesToday: this.messagesToday(), bytes: this.storedBytes(), members: this.activeMembers() };
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
    // Separate from owner_sig, so a 0.7 client still verifies the key statement. The relay can drop it.
    if (typeof owner.titlesSig === "string" && owner.titlesSig.length > 0 && owner.titlesSig.length < 200) this.set("titles_sig", owner.titlesSig);
    this.set("epoch", 0);
    this.set("created", Date.now());
    if (ownerUser) this.set("owner_user", ownerUser);
    // The channel's name, sealed with its key: members can read it, the relay can't.
    if (body.title && typeof body.title.iv === "string" && typeof body.title.ct === "string" && body.title.ct.length < 2048) this.set("title", JSON.stringify(body.title));
    for (const m of members) this.putMember(m, 0);
  }

  /** The channel's sealed icon (owner-set; the relay can't read it), and when it last changed. */
  icon(): { e: number; iv: string; ct: string } | null {
    const t = this.get("icon");
    return t ? (JSON.parse(t) as { e: number; iv: string; ct: string }) : null;
  }

  setIcon(icon: unknown): number {
    const at = Date.now();
    if (icon === null) this.set("icon", "");
    else {
      // About a 32KB image, sealed and base64'd, with room to spare; nothing bigger; and a key this channel has.
      if (!fits(SealedIcon, icon) || icon.e > this.meta().epoch) throw new HttpError(400, "bad icon (at most 32KB, sealed with a channel key)");
      const i = icon;
      this.set("icon", JSON.stringify({ e: i.e, iv: i.iv, ct: i.ct }));
    }
    this.set("icon_at", at);
    return at;
  }

  iconAt(): number | null {
    return Number(this.get("icon_at")) || null;
  }

  /** The owner's separate promise that titles are signed, if /create sent one. */
  getTitlesSig(): string | null {
    return this.get("titles_sig") || null;
  }

  /** The channel's sealed name, if its creator gave one. The relay can't read it. */
  title(): { iv: string; ct: string } | null {
    const t = this.get("title");
    return t ? (JSON.parse(t) as { iv: string; ct: string }) : null;
  }

  /** Replace the sealed name. The caller has already checked that this is the owner. */
  setTitle(title: unknown): void {
    const t = title as { iv?: unknown; ct?: unknown };
    if (typeof t?.iv !== "string" || typeof t.ct !== "string" || t.ct.length === 0 || t.ct.length >= 2048) throw new HttpError(400, "bad title");
    this.set("title", JSON.stringify({ iv: t.iv, ct: t.ct }));
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
    if (!fits(MemberRecord, m)) throw new HttpError(400, "bad member");
    this.sql.run(
      "INSERT INTO members (pk, xpk, rec, rec_e, since, active, read_only) VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT (pk) DO UPDATE SET xpk = excluded.xpk, rec = excluded.rec, rec_e = excluded.rec_e, active = 1, read_only = excluded.read_only",
      m.pk,
      m.xpk,
      m.rec,
      epoch,
      Date.now(),
      m.post === false ? 1 : 0,
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
    const { pk, xpk, box, ts, sig, commit } = body ?? ({} as RequestBody);
    if (typeof commit !== "string") throw new HttpError(426, UPDATE_KIWI);
    if (!fits(JoinRequest, body)) throw new HttpError(400, "bad request");
    if (box.length > 4096) throw new HttpError(413, "request too large");
    if (!(await verify({ room: this.roomId, pk, xpk, box, ts, commit, sig }))) throw new HttpError(400, "bad request signature");
    if (Math.abs(Date.now() - ts) > REQUEST_TTL_MS) throw new HttpError(400, "request timestamp out of range");
    if (this.isMember(pk)) throw new HttpError(409, "already a member");
    // Expiry and order use when the relay received a request, not the time the requester claims.
    this.sql.run("DELETE FROM requests WHERE status = 'pending' AND COALESCE(received, ts) < ?", Date.now() - REQUEST_TTL_MS);
    const existing = this.sql.all<{ id: string; status: string }>("SELECT id, status FROM requests WHERE pk = ?", pk)[0];
    if (existing?.status === "denied") throw new HttpError(403, "this key was denied", "Denied");
    if (this.sql.all("SELECT 1 FROM members WHERE pk = ? AND active = 0", pk).length) throw new HttpError(403, "this key was removed; join with a new identity", "Removed");
    if (existing) {
      // Asking again from a computer its person has since linked: the vouch applies now.
      if (vouchUser && !human) this.sql.run("UPDATE requests SET sponsor_user = ? WHERE id = ? AND status = 'pending' AND sponsor_user IS NULL AND kind = 'agent'", vouchUser, existing.id);
      // A joiner that lost its nonce starts the check over; the owner signs the new commit.
      this.sql.run(
        "UPDATE requests SET commit_to = ?, box = ?, sig = ?, ts = ?, owner_nonce = NULL, reveal = NULL WHERE id = ? AND status = 'pending' AND commit_to IS NOT ?",
        commit,
        box,
        sig,
        ts,
        existing.id,
        commit,
      );
      return { id: existing.id, fresh: false };
    }
    const pending = this.sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM requests WHERE status = 'pending'")[0]!.n;
    if (pending >= MAX_PENDING) throw new HttpError(429, "too many pending join requests");
    const id = crypto.randomUUID();
    this.sql.run(
      "INSERT INTO requests (id, pk, xpk, box, sig, ts, status, kind, sponsor_user, sponsor_name, received, commit_to) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?, ?)",
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
      commit,
    );
    return { id, fresh: true };
  }

  requestStatus(id: string, pk: string): { status: string; sponsored: boolean; ownerNonce?: string | null; revealed?: boolean; epoch?: number; keys?: Record<string, string> } {
    this.meta();
    this.migrate();
    const r = this.sql.all<{ pk: string; status: string; sponsor_user: string | null; owner_nonce: string | null; reveal: string | null }>(
      "SELECT pk, status, sponsor_user, owner_nonce, reveal FROM requests WHERE id = ?",
      id,
    )[0];
    if (!r || r.pk !== pk) throw new HttpError(404, "no such request");
    if (r.status === "pending") return { status: r.status, sponsored: !!r.sponsor_user, ownerNonce: r.owner_nonce, revealed: !!r.reveal };
    if (r.status !== "approved" || !this.isMember(pk)) return { status: r.status, sponsored: !!r.sponsor_user };
    return { status: "approved", sponsored: !!r.sponsor_user, ...this.keysFor(pk) };
  }

  pendingRequests(): (RequestBody & { kind: string; sponsorUser: string | null; sponsorName: string | null; ownerNonce: string | null; reveal: string | null })[] {
    this.migrate();
    return this.sql.all(
      "SELECT id, pk, xpk, box, sig, ts, commit_to AS \"commit\", owner_nonce AS ownerNonce, reveal, kind, sponsor_user AS sponsorUser, sponsor_name AS sponsorName FROM requests WHERE status = 'pending' AND commit_to IS NOT NULL ORDER BY COALESCE(received, ts)",
    );
  }

  private pendingCheck(id: string): { pk: string; commit: string; ownerNonce: string | null; reveal: string | null } {
    this.migrate();
    const r = this.sql.all<{ pk: string; commit: string | null; ownerNonce: string | null; reveal: string | null }>(
      "SELECT pk, commit_to AS \"commit\", owner_nonce AS ownerNonce, reveal FROM requests WHERE id = ? AND status = 'pending'",
      id,
    )[0];
    if (!r?.commit) throw new HttpError(404, "no such pending request");
    return r as { pk: string; commit: string; ownerNonce: string | null; reveal: string | null };
  }

  /** The owner's half of the join check: its signature over the joiner's commit. Set once. */
  async setOwnerNonce(id: string, nonce: unknown): Promise<void> {
    const r = this.pendingCheck(id);
    if (typeof nonce !== "string" || !(await verifyText(this.meta().ownerPk, nonce, ownerNonceStatement(this.roomId, r.pk, r.commit)))) {
      throw new HttpError(400, "that isn't the owner's signature over this request");
    }
    if (r.ownerNonce && r.ownerNonce !== nonce) throw new HttpError(409, "this request already has the owner's nonce");
    this.sql.run("UPDATE requests SET owner_nonce = ? WHERE id = ?", nonce, id);
  }

  /** The joiner's half, revealed once the owner's is in: it has to match the commit. */
  async reveal(id: string, pk: string, nonce: unknown): Promise<boolean> {
    const r = this.pendingCheck(id);
    if (r.pk !== pk) throw new HttpError(404, "no such pending request");
    if (!r.ownerNonce) throw new HttpError(409, "wait for the owner's half of the check");
    if (typeof nonce !== "string" || !NONCE_RE.test(nonce) || (await commitTo(this.roomId, pk, nonce)) !== r.commit) throw new HttpError(400, "that nonce doesn't match the request");
    if (r.reveal === nonce) return false;
    this.sql.run("UPDATE requests SET reveal = ? WHERE id = ?", nonce, id);
    return true;
  }

  /** Nobody is let in before both sides could compare the code. */
  requireChecked(request: string | undefined, pk: string): void {
    this.migrate();
    const r = request ? this.sql.all<{ pk: string; reveal: string | null }>("SELECT pk, reveal FROM requests WHERE id = ? AND status = 'pending'", request)[0] : undefined;
    if (!r || r.pk !== pk) throw new HttpError(400, "approve a pending request");
    if (!r.reveal) throw new HttpError(409, "this request hasn't finished its code check yet");
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

  /**
   * Admit a member. With `replaces`, a new key takes over an existing member's
   * seat (a reclaim): the old key is removed in the same step, so the two are
   * never members at once, and the owner rotates next, as after any removal.
   */
  approve(body: MemberBody & { request?: string; replaces?: string }): void {
    const { epoch, ownerPk } = this.meta();
    if (body.replaces !== undefined) {
      if (typeof body.replaces !== "string" || !this.isMember(body.replaces)) throw new HttpError(404, "the seat to reclaim isn't a member any more");
      if (body.replaces === ownerPk) throw new HttpError(400, "the owner's seat can't be reclaimed");
      if (body.replaces === body.pk) throw new HttpError(400, "a seat can't be reclaimed by its own key");
    }
    const most = this.policy.membersPerChannel;
    if (most && !body.replaces && !this.isMember(body.pk) && this.activeMembers() >= most) {
      throw new HttpError(429, `this channel has ${most} members, the most this relay allows; remove someone to let another in`);
    }
    for (let e = 0; e <= epoch; e++) {
      if (!body.keys?.[String(e)]) throw new HttpError(400, `missing wrapped key for epoch ${e}`);
    }
    // Both in one synchronous step (nothing else runs in between), new key first so a bad record changes nothing.
    this.putMember(body, epoch);
    if (body.replaces) this.remove(body.replaces);
    if (body.request) this.sql.run("UPDATE requests SET status = 'approved' WHERE id = ? AND pk = ?", body.request, body.pk);
  }

  members(): { pk: string; xpk: string; rec: string; e: number; active: number }[] {
    return this.sql.all("SELECT pk, xpk, rec, rec_e AS e, active FROM members ORDER BY since");
  }

  keysFor(pk: string): { epoch: number; keys: Record<string, string> } {
    const rows = this.sql.all<{ e: number; wrapped: string }>("SELECT e, wrapped FROM keys WHERE pk = ?", pk);
    return { epoch: this.meta().epoch, keys: Object.fromEntries(rows.map((r) => [String(r.e), r.wrapped])) };
  }

  /** Whether a member may post (the owner's scope.set says what they may do; this is the bit the relay enforces). */
  setCanPost(pk: string, post: boolean): void {
    if (pk === this.meta().ownerPk) throw new HttpError(400, "the owner may always post");
    if (!this.isMember(pk)) throw new HttpError(404, "not a member");
    this.sql.run("UPDATE members SET read_only = ? WHERE pk = ?", post ? 0 : 1, pk);
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
  /** False for a member the owner lets only read: the relay refuses their messages. */
  post?: boolean;
}

export interface CreateBody {
  /** The channel's name, sealed with the epoch-0 key. */
  title?: { iv: string; ct: string };
  owner: { pk: string; xpk: string; sig: string; titlesSig?: string };
  members: MemberBody[];
}

export interface RequestBody {
  id?: string;
  pk: string;
  xpk: string;
  /** Name/role/about, sealed to the owner's xpk. */
  box: string;
  ts: number;
  /** The joiner's commitment to its half of the code (see sas.ts). */
  commit: string;
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
    const e = store.append(f.iv, f.ct, Number(f.e ?? 0), sender);
    return { broadcast: [msgFrame(e)], reply: frame({ t: "ack", id: f.id, seq: e.seq }), expireAt: store.touch() ?? undefined };
  } catch (err) {
    return { reply: frame({ t: "err", error: err instanceof Error ? err.message : String(err), id: f.id }) };
  }
}

/**
 * The HTTP API (all under /v1/rooms/<room>):
 *   GET    /info?fp=<fingerprint>     holder of the join code: owner keys, epoch, whether a rotation is due
 *   POST   /create                    owner: create the room
 *   POST   /requests                  anyone with the code: ask to join (self-signed)
 *   GET    /requests/<id>             the requester: status, and wrapped keys once approved
 *   POST   /requests/<id>/reveal      the requester: its half of the code check
 *   GET    /requests?v=2              owner: pending requests
 *   POST   /requests/<id>/nonce       owner: its half of the code check (a signature)
 *   POST   /requests/<id>/deny        owner
 *   POST   /members                   owner: approve (enroll a key, hand it wrapped keys)
 *   GET    /members                   member: the sealed member records
 *   DELETE /members/me                member: leave
 *   DELETE /members/<pk>              owner: remove
 *   PUT    /members/<pk>/post         owner: whether they may post (the relay's bit of member scopes)
 *   GET    /keys                      member: my wrapped channel keys
 *   POST   /epochs                    owner: rotate the channel key
 *   DELETE /                          owner: close and delete everything
 *   GET    /                          member: {head}
 *   GET    /messages?since=N          member
 *   POST   /messages                  member: {iv, ct, e}
 */
/** What an adapter hands the room logic besides the request: sign-in, vouching, and the relay's policy. */
/** Authenticate a WebSocket upgrade; returns the member key. */
export async function authenticateSocket(store: RoomStore, req: Request): Promise<string> {
  return store.authenticate(req, "GET", "/ws", "");
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return Response.json({ error: err.message, tag: err.tag }, { status: err.status });
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
  if (!user) throw new HttpError(401, "sign in to see your channels", "SignInRequired");
  const channels = (await list(user)).sort((a, b) => b.at - a.at);
  return Response.json({ channels });
}

/**
 * GET /v1/me/usage: what a signed-in person uses of this relay's limits: channels owned against
 * the cap, and for each one messages today, stored bytes and members. Null limits are unlimited.
 */
export async function myUsage(
  req: Request,
  human: HumanAuth | null,
  policy: RelayPolicy,
  list: (user: string) => Promise<DirectoryEntry[]>,
  usageOf: (room: string) => Promise<RoomUsage | null>,
): Promise<Response> {
  if (!human) throw new HttpError(404, "this relay has no sign-in");
  const user = await human.verify(req.headers.get(HUMAN_HEADER) ?? "");
  if (!user) throw new HttpError(401, "sign in to see your usage", "SignInRequired");
  const owned = (await list(user)).filter((c) => c.owner);
  const channels = await Promise.all(owned.map(async (c) => ({ room: c.room, code: c.code, ...((await usageOf(c.room)) ?? { messagesToday: 0, bytes: 0, members: 0 }) })));
  return Response.json({
    limits: {
      channelsPerOwner: policy.channelsPerOwner,
      membersPerChannel: policy.membersPerChannel,
      messagesPerDay: policy.messagesPerDay,
      bytesPerChannel: policy.bytesPerChannel,
      expireAfterDays: policy.expireAfterDays,
    },
    owned: channels.length,
    channels,
  });
}

/** Relay-wide settings the web app needs: which WorkOS client to sign in with, if any. */
export function relayConfig(human: HumanAuth | null): Response {
  return Response.json({ workosClientId: human?.clientId ?? null, ...(human?.dev ? { dev: true } : {}) });
}
