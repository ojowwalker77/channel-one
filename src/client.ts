// Client for one membership channel: create it, ask to join, approve, send
// (signed), read history, stream live messages and presence, leave, close.
// Runs in Bun and in the browser.

import { signRequest } from "./auth.ts";
import {
  decodeJoinCode,
  encodeJoinCode,
  newChannelKey,
  newRoomId,
  open,
  openFrom,
  ownerFingerprint,
  seal,
  sealTo,
  verificationCode,
  type ChannelAccess,
} from "./crypto.ts";
import { sign, signText, verify, verifyText, type Identity } from "./identity.ts";
import { handleFor, inlineText, makeRecord, NAME_RE, nameKey, openRecord, RESERVED_NAMES, sealRecord, type JoinRequest, type Member, type MemberInfo } from "./membership.ts";
import {
  CLOSE_CLOSED,
  CLOSE_REMOVED,
  MAX_IMAGES,
  PING,
  PROTOCOL_VERSION,
  WS_PROTOCOL,
  wellFormed,
  type Envelope,
  type Event,
  type ImageAttachment,
  type Kind,
  type Message,
  type Payload,
  type Presence,
  type ServerFrame,
} from "./protocol.ts";

export interface SendOptions {
  to?: string[];
  kind?: Kind;
  re?: number[];
  ev?: Event;
  imgs?: ImageAttachment[];
}

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** This member was removed, or the owner closed the channel. Local copies should be wiped. */
export class ChannelGone extends Error {
  constructor(readonly why: "removed" | "closed") {
    super(why === "closed" ? "the owner closed this channel" : "you are no longer a member of this channel");
  }
}

export interface StreamOptions {
  signal?: AbortSignal;
  onReady?: (head: number) => void;
  onStatus?: (s: string) => void;
  /** Called on every (re)connect with a way to send ephemeral presence. */
  onOpen?: (live: { presence: (p: Omit<Presence, "v" | "type" | "from" | "ts">) => Promise<void> }) => void;
  onPresence?: (p: Presence & { sigOk: boolean }) => void;
  /** The member list changed. */
  onRoster?: () => void;
  /** Someone asked to join (owners act on it). */
  onRequest?: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keyInfo = (room: string, e: number | string) => `mc/key\n${room}\n${e}`;
const requestInfo = (room: string) => `mc/request\n${room}`;

/** Supplies the signed-in human's WorkOS access token (relays that require sign-in). */
export type HumanSession = () => Promise<string | null>;

async function call<T>(
  relay: string,
  roomId: string,
  path: string,
  init: RequestInit & { identity?: Identity; human?: string | null } = {},
  params: Record<string, string | number> = {},
): Promise<T> {
  const u = new URL(`/v1/rooms/${roomId}${path}`, relay);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const method = (init.method ?? "GET").toUpperCase();
  const body = typeof init.body === "string" ? init.body : "";
  const headers: Record<string, string> = { "content-type": "application/json" };
  // The signature covers the query too, so a captured token can't be replayed with other parameters.
  if (init.identity) headers.authorization = `Bearer ${await signRequest(init.identity, roomId, method, path + u.search, body)}`;
  if (init.human) headers["x-human-token"] = init.human;
  const res = await fetch(u, { method, body: method === "GET" || method === "DELETE" ? undefined : body, headers });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new RelayError(res.status, json.error ?? `relay returned ${res.status}`);
  return json;
}

export interface Info {
  ownerPk: string;
  ownerXpk: string;
  ownerSig: string;
  epoch: number;
  rotate: boolean;
  /** The channel's name, sealed with the epoch-0 key. */
  title?: { iv: string; ct: string } | null;
  /** The owner's name from sign-in, vouched by the relay (null without sign-in). */
  ownerName?: string | null;
}

/**
 * Check the owner's signature over its own keys. Channels made by this version
 * sign a second promise into it (v: 2): every channel key the owner hands out
 * carries its signature. The relay can't fake or strip that promise, so a
 * member of such a channel never accepts a key the owner didn't sign.
 */
export async function ownerStatement(roomId: string, info: { ownerPk: string; ownerXpk: string; ownerSig: string }): Promise<"signed-keys" | "legacy" | null> {
  if (await verify({ room: roomId, pk: info.ownerPk, xpk: info.ownerXpk, v: 2, sig: info.ownerSig })) return "signed-keys";
  if (await verify({ room: roomId, pk: info.ownerPk, xpk: info.ownerXpk, sig: info.ownerSig })) return "legacy";
  return null;
}

/** Fetch a room's public info and check it against the owner pinned in the join code. */
async function pinnedInfo(relay: string, code: string): Promise<{ roomId: string; info: Info; signedKeys: boolean }> {
  const { roomId, ownerFp } = decodeJoinCode(code);
  const info = await call<Info>(relay, roomId, "/info");
  if ((await ownerFingerprint(info.ownerPk)) !== ownerFp) throw new Error("this relay is serving a different owner than the join code names; refusing");
  const statement = await ownerStatement(roomId, info);
  if (!statement) throw new Error("the channel owner's keys aren't signed; refusing");
  return { roomId, info, signedKeys: statement === "signed-keys" };
}

const keyStatement = (room: string, e: number | string, memberPk: string, box: string) => `kiwi-key\n${room}\n${e}\n${memberPk}\n${box}`;

/** Wrap a channel key for one member, signed by the owner so the member knows it came from them. */
async function wrapFor(owner: Identity, roomId: string, e: number | string, memberPk: string, memberXpk: string, key: string): Promise<string> {
  const box = await sealTo(memberXpk, key, keyInfo(roomId, e));
  return JSON.stringify({ box, sig: await signText(owner, keyStatement(roomId, e, memberPk, box)) });
}

/** Unwrap this member's keys, keeping only ones the owner signed (or, on older channels, unsigned ones). */
async function unwrapKeys(id: Identity, roomId: string, wrapped: Record<string, string>, ownerPk: string, signedOnly: boolean): Promise<Record<string, string>> {
  if (!id.xsk) throw new Error("identity has no exchange key");
  const out: Record<string, string> = {};
  for (const [e, w] of Object.entries(wrapped)) {
    let box = w;
    if (w.startsWith("{")) {
      try {
        const parsed = JSON.parse(w) as { box?: unknown; sig?: unknown };
        if (typeof parsed.box !== "string" || typeof parsed.sig !== "string") continue;
        if (!(await verifyText(ownerPk, parsed.sig, keyStatement(roomId, e, id.pk, parsed.box)))) continue;
        box = parsed.box;
      } catch {
        continue;
      }
    } else if (signedOnly) continue;
    const k = await openFrom(id.xsk, box, keyInfo(roomId, e));
    if (k) out[e] = k;
  }
  return out;
}

export class Channel {
  readonly name: string;
  private refreshing: Promise<void> | null = null;

  constructor(
    public access: ChannelAccess,
    readonly relay: string,
    /** Signs every request and message. */
    readonly identity: Identity,
    /** Called whenever keys change (e.g. after a rotation) so callers can persist them. */
    private readonly onAccess?: (a: ChannelAccess) => void,
    /** The signed-in human behind this member (the dashboard), for owner actions on sign-in relays. */
    private readonly human?: HumanSession,
  ) {
    this.name = identity.name;
  }

  get roomId(): string {
    return this.access.roomId;
  }

  get isOwner(): boolean {
    return this.identity.pk === this.access.ownerPk;
  }

  private async request<T>(path: string, init: RequestInit = {}, params: Record<string, string | number> = {}): Promise<T> {
    try {
      const human = this.human && this.isOwner ? await this.human() : null;
      return await call<T>(this.relay, this.roomId, path, { ...init, identity: this.identity, human }, params);
    } catch (err) {
      throw gone(err);
    }
  }

  // ---------- lifecycle ----------

  /**
   * Create a channel owned by `owner` (the human), with `agent` (the creating
   * agent) admitted alongside. Returns the join code and the owner's access.
   */
  static async create(
    relay: string,
    owner: Identity,
    ownerInfo: MemberInfo,
    agents: (Identity & { info: MemberInfo })[] = [],
    roomId = newRoomId(),
    human?: string | null,
    /** A name for the channel; sealed, so only members can read it. */
    title?: string,
  ): Promise<{ code: string; access: ChannelAccess }> {
    if (!owner.xpk) throw new Error("owner identity has no exchange key");
    const key = newChannelKey();
    const ownerSig = await sign(owner, { room: roomId, xpk: owner.xpk, v: 2 });
    const enroll = async (id: Identity, info: MemberInfo, isOwner: boolean) => ({
      pk: id.pk,
      xpk: id.xpk!,
      rec: await sealRecord(key, await makeRecord(owner, roomId, { ...info, pk: id.pk, xpk: id.xpk!, owner: isOwner })),
      keys: { "0": await wrapFor(owner, roomId, 0, id.pk, id.xpk!, key) },
    });
    const members = [await enroll(owner, ownerInfo, true), ...(await Promise.all(agents.map((a) => enroll(a, a.info, false))))];
    const sealedTitle = title ? await seal(key, roomId, { name: title }) : undefined;
    await call(relay, roomId, "/create", {
      method: "POST",
      identity: owner,
      human,
      body: JSON.stringify({ owner: { pk: owner.pk, xpk: owner.xpk, sig: ownerSig.sig }, members, ...(sealedTitle ? { title: sealedTitle } : {}) }),
    });
    const access: ChannelAccess = { roomId, ownerPk: owner.pk, ownerXpk: owner.xpk, epoch: 0, keys: { "0": key }, signedKeys: true };
    return { code: encodeJoinCode({ roomId, ownerFp: await ownerFingerprint(owner.pk) }), access };
  }

  /**
   * Ask to join. Name and role are sealed to the owner, so the relay can't read
   * them. Returns the request id and the verification code both sides see.
   * Asking again with the same key resumes the same request.
   */
  static async requestJoin(
    relay: string,
    code: string,
    id: Identity,
    info: MemberInfo,
    /** A signed-in person joining as themself; agents leave this out. */
    human?: string | null,
    /** An agent on a computer its person linked: the computer's vouch for this key. */
    machine?: { pk: string; sig: string } | null,
  ): Promise<{ roomId: string; requestId: string; verify: string }> {
    const { roomId, info: room } = await pinnedInfo(relay, code);
    if (!id.xpk) throw new Error("identity has no exchange key");
    const box = await sealTo(room.ownerXpk, JSON.stringify(info), requestInfo(roomId));
    const body = await sign(id, { room: roomId, xpk: id.xpk, box, ts: Date.now() });
    const { id: requestId } = await call<{ id: string }>(relay, roomId, "/requests", { method: "POST", human, body: JSON.stringify(machine ? { ...body, machine } : body) });
    return { roomId, requestId, verify: await verificationCode(roomId, id.pk) };
  }

  /** Check a join request. Once approved, returns this member's access. */
  static async joinStatus(
    relay: string,
    code: string,
    id: Identity,
    requestId: string,
  ): Promise<{ status: "pending" | "denied"; sponsored: boolean } | { status: "approved"; sponsored: boolean; access: ChannelAccess }> {
    const { roomId, info, signedKeys } = await pinnedInfo(relay, code);
    const r = await call<{ status: string; sponsored?: boolean; epoch?: number; keys?: Record<string, string> }>(relay, roomId, `/requests/${requestId}`, { identity: id });
    const sponsored = !!r.sponsored;
    if (r.status !== "approved") return { status: r.status === "denied" ? "denied" : "pending", sponsored };
    const keys = await unwrapKeys(id, roomId, r.keys ?? {}, info.ownerPk, signedKeys);
    return { status: "approved", sponsored, access: { roomId, ownerPk: info.ownerPk, ownerXpk: info.ownerXpk, epoch: r.epoch ?? 0, keys, signedKeys } };
  }

  /** Fetch this member's wrapped keys (after a rotation) and unwrap them. */
  refreshKeys(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        const r = await this.request<{ epoch: number; keys: Record<string, string> }>("/keys").catch((err) => {
          throw gone(err);
        });
        const keys = await unwrapKeys(this.identity, this.roomId, r.keys, this.access.ownerPk, !!this.access.signedKeys);
        // A key this member already holds for an epoch never changes: nobody may swap it.
        this.access = { ...this.access, epoch: r.epoch, keys: { ...keys, ...this.access.keys } };
        this.onAccess?.(this.access);
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async info(): Promise<Info> {
    return call<Info>(this.relay, this.roomId, "/info");
  }

  /** The channel's name, if its creator gave one (only members can read it). */
  async title(): Promise<string | null> {
    const t = (await this.info()).title;
    const key = this.access.keys["0"];
    if (!t || !key) return null;
    const opened = (await open(key, this.roomId, t.iv, t.ct).catch(() => null)) as { name?: unknown } | null;
    return typeof opened?.name === "string" ? opened.name.slice(0, 80) : null;
  }

  /** The verified member list. Records that fail verification are dropped. */
  async members(): Promise<Member[]> {
    const { members } = await this.request<{ members: { pk: string; xpk: string; rec: string; e: number; active: number }[] }>("/members");
    const out: Member[] = [];
    for (const m of members) {
      let key = this.access.keys[String(m.e)];
      if (!key) {
        await this.refreshKeys();
        key = this.access.keys[String(m.e)];
      }
      const member = key ? await openRecord(key, m.rec, this.roomId, this.access.ownerPk, m.pk) : null;
      if (member) out.push({ ...member, active: !!m.active });
      // A key the relay says is a member, with no record we can verify: show it, so the owner can remove it.
      else if (m.active) out.push({ name: `unverified-${m.pk.slice(0, 6)}`, pk: m.pk, xpk: m.xpk, owner: false, at: 0, active: true, unverified: true });
    }
    return out;
  }

  /** Leave the channel. Access is revoked at once; the owner rotates the key. */
  async leave(): Promise<void> {
    await this.request("/members/me", { method: "DELETE" });
  }

  // ---------- owner ----------

  private ownerOnly(): void {
    if (!this.isOwner) throw new Error("only the channel owner can do that");
  }

  /** Pending join requests, opened (only the owner can read their names). */
  async requests(): Promise<JoinRequest[]> {
    this.ownerOnly();
    const { requests } = await this.request<{
      requests: {
        id: string;
        pk: string;
        xpk: string;
        box: string;
        ts: number;
        sig: string;
        kind?: string;
        sponsorUser?: string | null;
        sponsorName?: string | null;
        sponsorEmail?: string | null;
      }[];
    }>("/requests");
    const out: JoinRequest[] = [];
    for (const r of requests) {
      if (!(await verify({ room: this.roomId, pk: r.pk, xpk: r.xpk, box: r.box, ts: r.ts, sig: r.sig }))) continue;
      const raw = await openFrom(this.identity.xsk!, r.box, requestInfo(this.roomId));
      let info: MemberInfo = { name: "?" };
      try {
        info = JSON.parse(raw ?? "{}") as MemberInfo;
      } catch {}
      // Whoever holds the join code chose these: keep them to one safe line each.
      out.push({
        name: inlineText(info.name, 40) || "?",
        role: inlineText(info.role, 60) || undefined,
        about: inlineText(info.about, 200) || undefined,
        // The relay knows (from sign-in) whether a person or an agent asked; it's not up to the requester.
        kind: r.kind === "human" ? "human" : "agent",
        id: r.id,
        pk: r.pk,
        xpk: r.xpk,
        ts: r.ts,
        code: await verificationCode(this.roomId, r.pk),
        sponsoredBy: r.sponsorUser ? { user: r.sponsorUser, name: inlineText(r.sponsorName, 80) || r.sponsorUser, email: r.sponsorEmail ?? null } : null,
      });
    }
    return out;
  }

  /**
   * Refuse names that can't be admitted: invalid ones (every client would drop the record and the
   * member would read invisibly), reserved ones, and any that matches a current member's, even
   * when it only looks the same.
   */
  private async assertNamesFree(names: string[]): Promise<void> {
    const taken = new Set((await this.members()).filter((m) => m.active).map((m) => nameKey(m.name)));
    const seen = new Set<string>();
    for (const n of names) {
      if (!NAME_RE.test(n)) throw new Error(`"${inlineText(n, 40)}" isn't a valid name (1-32 letters, digits, _ . or -); they need to ask again under another name`);
      if (RESERVED_NAMES.has(nameKey(n))) throw new Error(`"${n}" is a reserved name; they need to ask again under another name`);
      if (taken.has(nameKey(n)) || seen.has(nameKey(n))) throw new Error(`"${n}" is already someone's name in this channel; they need to ask again under another name`);
      seen.add(nameKey(n));
    }
  }

  /** A handle no current member has: "jonatas-walker", or "jonatas-walker-2" if that's taken. */
  private async freeHandle(base: string): Promise<string> {
    const taken = new Set((await this.members()).filter((m) => m.active).map((m) => nameKey(m.name)));
    let name = RESERVED_NAMES.has(nameKey(base)) ? `${base}-1` : base;
    for (let i = 2; taken.has(nameKey(name)); i++) name = `${base.slice(0, 29)}-${i}`;
    return name;
  }

  /** Admit a requester: sign its record, and wrap every epoch key to it. */
  async approve(req: JoinRequest, as?: MemberInfo): Promise<Member> {
    this.ownerOnly();
    const kind = req.kind ?? "agent";
    // An agent's person, by the handle they have here if they're in this channel.
    const sponsorHandle =
      kind === "agent" && req.sponsoredBy ? (await this.members()).find((m) => m.active && m.kind === "human" && m.sponsor?.user === req.sponsoredBy!.user)?.name : undefined;
    // A person is admitted under a handle made from their signed-in account, not one they typed, so
    // nobody can ask to join as "bob-smith". (Their browser adopts it when it learns it's in.)
    if (kind === "human" && req.sponsoredBy && !as?.name) as = { ...as, name: await this.freeHandle(handleFor(req.sponsoredBy.name, req.sponsoredBy.email ?? undefined)) };
    await this.assertNamesFree([as?.name ?? req.name]);
    const sponsor = req.sponsoredBy ? { ...req.sponsoredBy, ...(kind === "human" ? { handle: as?.name ?? req.name } : sponsorHandle ? { handle: sponsorHandle } : {}) } : undefined;
    const info: MemberInfo = {
      name: as?.name ?? req.name,
      role: as?.role ?? req.role,
      about: as?.about ?? req.about,
      kind,
      ...(kind === "human" && req.sponsoredBy ? { display: req.sponsoredBy.name } : {}),
      ...(sponsor ? { sponsor } : {}),
    };
    const current = this.access.keys[String(this.access.epoch)]!;
    const rec = await makeRecord(this.identity, this.roomId, { ...info, pk: req.pk, xpk: req.xpk });
    const keys: Record<string, string> = {};
    for (const [e, k] of Object.entries(this.access.keys)) keys[e] = await wrapFor(this.identity, this.roomId, e, req.pk, req.xpk, k);
    await this.request("/members", { method: "POST", body: JSON.stringify({ pk: req.pk, xpk: req.xpk, rec: await sealRecord(current, rec), keys, request: req.id }) });
    return { pk: req.pk, xpk: req.xpk, ...info, owner: false, at: rec.at, active: true };
  }

  async deny(requestId: string): Promise<void> {
    this.ownerOnly();
    await this.request(`/requests/${requestId}/deny`, { method: "POST", body: "{}" });
  }

  /** Remove a member and rotate the key so they can't read anything newer. */
  async remove(pk: string): Promise<void> {
    this.ownerOnly();
    await this.request(`/members/${pk}`, { method: "DELETE" });
    await this.rotate();
  }

  /** New channel key, wrapped to every remaining member. */
  async rotate(): Promise<number> {
    this.ownerOnly();
    // The new key goes only to members whose admission the owner signed, under the exchange key in
    // that record: never to whatever list or key the relay hands back.
    const members = (await this.members()).filter((m) => m.active && !m.unverified);
    const { epoch } = await this.info();
    const next = epoch + 1;
    const key = newChannelKey();
    const keys: Record<string, string> = {};
    for (const m of members) keys[m.pk] = await wrapFor(this.identity, this.roomId, next, m.pk, m.xpk, key);
    await this.request("/epochs", { method: "POST", body: JSON.stringify({ epoch: next, keys }) });
    this.access = { ...this.access, epoch: next, keys: { ...this.access.keys, [String(next)]: key } };
    this.onAccess?.(this.access);
    return next;
  }

  /** Rotate if a member left since the last rotation. */
  async rotateIfDue(): Promise<boolean> {
    if (!this.isOwner || !(await this.info()).rotate) return false;
    await this.rotate();
    return true;
  }

  /** Delete the channel at the relay: messages, members, keys, everything. */
  async close(): Promise<void> {
    this.ownerOnly();
    await this.request("/", { method: "DELETE" });
  }

  // ---------- messages ----------

  async head(): Promise<number> {
    try {
      return (await this.request<{ head: number }>("/")).head;
    } catch (err) {
      throw gone(err);
    }
  }

  async send(body: string, opts: SendOptions = {}): Promise<number> {
    const payload: Payload = {
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      from: this.name,
      ...(opts.to?.length ? { to: opts.to } : {}),
      kind: opts.kind ?? (opts.ev ? "event" : "msg"),
      body,
      ...(opts.re?.length ? { re: opts.re } : {}),
      ...(opts.ev ? { ev: opts.ev } : {}),
      ...(opts.imgs?.length ? { imgs: opts.imgs.slice(0, MAX_IMAGES) } : {}),
      ts: Date.now(),
    };
    const signed = await sign(this.identity, payload);
    for (let attempt = 0; ; attempt++) {
      if (!this.access.keys[String(this.access.epoch)]) await this.refreshKeys();
      const e = this.access.epoch;
      const key = this.access.keys[String(e)];
      if (!key) throw new Error(`no key for epoch ${e}`);
      const sealed = await seal(key, this.roomId, signed);
      try {
        return (await this.request<{ seq: number }>("/messages", { method: "POST", body: JSON.stringify({ ...sealed, e }) })).seq;
      } catch (err) {
        // The key rotated under us: fetch the new one and resend once.
        if (attempt === 0 && err instanceof RelayError && err.status === 409) {
          await this.refreshKeys();
          continue;
        }
        throw gone(err);
      }
    }
  }

  private async keyFor(e: number): Promise<string | undefined> {
    if (!this.access.keys[String(e)]) await this.refreshKeys().catch(() => {});
    return this.access.keys[String(e)];
  }

  async decrypt(env: Envelope): Promise<Message | null> {
    const key = await this.keyFor(env.e ?? 0);
    if (!key) return null;
    const p = (await open(key, this.roomId, env.iv, env.ct).catch(() => null)) as unknown;
    // Anything that isn't a well-formed message is dropped here, before any client folds it.
    if (!wellFormed(p)) return null;
    // Drop malformed attachments rather than the whole message.
    const imgs = Array.isArray(p.imgs)
      ? p.imgs.filter(
          (i): i is ImageAttachment =>
            !!i && typeof i.name === "string" && typeof i.mime === "string" && i.mime.startsWith("image/") && typeof i.data === "string",
        )
      : undefined;
    return { ...p, ...(imgs?.length ? { imgs } : { imgs: undefined }), seq: env.seq, rts: env.ts, sigOk: await verify(p) };
  }

  /** Messages after `since`, oldest first, following pages to the head. */
  async history(since: number): Promise<{ head: number; messages: Message[] }> {
    const messages: Message[] = [];
    let head = since;
    for (;;) {
      let page: { head: number; messages: Envelope[] };
      try {
        page = await this.request<{ head: number; messages: Envelope[] }>("/messages", {}, { since });
      } catch (err) {
        throw gone(err);
      }
      head = page.head;
      const decrypted = await Promise.all(page.messages.map((e) => this.decrypt(e)));
      for (let i = 0; i < page.messages.length; i++) {
        const m = decrypted[i];
        if (m) messages.push(m);
        since = page.messages[i]!.seq;
      }
      if (!page.messages.length || since >= head) break;
    }
    return { head, messages };
  }

  /**
   * Stream messages after `since` until `signal` aborts. Replays anything
   * missed, reconnects with backoff, and resumes from the last delivered seq,
   * so nothing is lost across drops. `onMessage` runs strictly in order.
   * Throws ChannelGone if this member is removed or the channel is closed.
   */
  async stream(since: number, onMessage: (m: Message) => void | Promise<void>, opts: StreamOptions = {}): Promise<void> {
    let last = since;
    let backoff = 500;
    while (!opts.signal?.aborted) {
      const auth = await signRequest(this.identity, this.roomId, "GET", "/ws");
      const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
        const u = new URL(`/v1/rooms/${this.roomId}/ws`, this.relay);
        u.searchParams.set("since", String(last));
        u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(u, [WS_PROTOCOL, auth]);
        let queue = Promise.resolve();
        let ping: ReturnType<typeof setInterval> | undefined;
        const abort = () => ws.close(1000, "aborted");
        opts.signal?.addEventListener("abort", abort, { once: true });
        ws.onopen = () => {
          backoff = 500;
          ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(PING), 25_000);
          opts.onOpen?.({
            presence: async (p) => {
              if (ws.readyState !== WebSocket.OPEN) return;
              const full = await sign(this.identity, { v: PROTOCOL_VERSION, type: "presence", from: this.name, ts: Date.now(), ...p } as Presence);
              const e = this.access.epoch;
              ws.send(JSON.stringify({ t: "eph", ...(await seal(this.access.keys[String(e)]!, this.roomId, { ...full, e })) }));
            },
          });
        };
        ws.onmessage = (ev) => {
          const f = JSON.parse(String(ev.data)) as ServerFrame | { t: "pong" };
          queue = queue.then(async () => {
            if (f.t === "msg") {
              if (f.seq <= last) return;
              const m = await this.decrypt(f);
              last = f.seq;
              if (m) await onMessage(m);
            } else if (f.t === "eph") {
              if (!opts.onPresence) return;
              // Presence is sealed with whichever epoch key the sender had; try current, then older.
              for (const k of Object.values(this.access.keys).reverse()) {
                const p = (await open(k, this.roomId, f.iv, f.ct)) as (Presence & { e?: number }) | null;
                if (p?.type === "presence" && typeof p.from === "string") {
                  const { e: _e, ...rest } = p;
                  opts.onPresence({ ...rest, sigOk: await verify(rest) });
                  break;
                }
              }
            } else if (f.t === "epoch") {
              await this.refreshKeys().catch(() => {});
            } else if (f.t === "roster") {
              opts.onRoster?.();
            } else if (f.t === "request") {
              opts.onRequest?.();
            } else if (f.t === "ready") {
              opts.onReady?.(f.head);
              // The relay replays at most one page on connect; reconnect for the rest.
              if (f.more) ws.close(4000, "more");
            }
          });
        };
        ws.onclose = (ev) => {
          clearInterval(ping);
          opts.signal?.removeEventListener("abort", abort);
          queue.then(() => resolve({ code: ev.code, reason: ev.reason }));
        };
        ws.onerror = () => {};
      });
      if (opts.signal?.aborted) return;
      if (closed.code === 4000) continue;
      if (closed.code === CLOSE_REMOVED) throw new ChannelGone("removed");
      if (closed.code === CLOSE_CLOSED) throw new ChannelGone("closed");
      opts.onStatus?.(`disconnected (${closed.code}${closed.reason ? ` ${closed.reason}` : ""}), retrying in ${backoff}ms`);
      // Upgrade failures (removed, closed) look like plain drops; check before retrying.
      try {
        await this.head();
      } catch (err) {
        if (err instanceof ChannelGone) throw err;
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

/** Map the relay errors that mean "you're out" to ChannelGone; leave everything else alone. */
function gone(err: unknown): unknown {
  if (!(err instanceof RelayError)) return err;
  if (err.status === 403 && /not a member/.test(err.message)) return new ChannelGone("removed");
  if (err.status === 404 && /no such channel/.test(err.message)) return new ChannelGone("closed");
  return err;
}

/** Whether a message is addressed to `agent` (directly, or as a broadcast). */
export function isForAgent(m: Message, agent: string): boolean {
  return !m.to || m.to.includes(agent) || m.to.includes("*");
}

/** Addressed to `agent` by name (not a broadcast). */
export function isDirectedAt(m: Message, agent: string): boolean {
  return !!m.to?.includes(agent);
}

export { encodeJoinCode };

/** A signed-in person's tie to a channel: they own it, are in it, and/or have agents in it. */
export interface MyChannel {
  room: string;
  code: string;
  owner: boolean;
  member: boolean;
  agents: number;
  at: number;
}

/** Every channel the signed-in person owns, is in, or has agents in, across all their devices. */
export async function myChannels(relay: string, human: string): Promise<MyChannel[]> {
  const res = await fetch(new URL("/v1/me/channels", relay), { headers: { "x-human-token": human } });
  const json = (await res.json().catch(() => ({}))) as { channels?: MyChannel[]; error?: string };
  if (!res.ok) throw new RelayError(res.status, json.error ?? `relay returned ${res.status}`);
  return json.channels ?? [];
}

/** What a signed-in person uses of a relay's limits (null limits are unlimited). */
export interface MyUsage {
  limits: { channelsPerOwner: number | null; membersPerChannel: number | null; messagesPerDay: number | null; bytesPerChannel: number; expireAfterDays: number | null };
  owned: number;
  channels: { room: string; code: string; messagesToday: number; bytes: number; members: number }[];
}

export async function myUsage(relay: string, human: string): Promise<MyUsage> {
  const res = await fetch(new URL("/v1/me/usage", relay), { headers: { "x-human-token": human } });
  const json = (await res.json().catch(() => ({}))) as MyUsage & { error?: string };
  if (!res.ok) throw new RelayError(res.status, json.error ?? `relay returned ${res.status}`);
  return json;
}

/** Whether a relay requires a signed-in human to create and run channels, and with which WorkOS client. */
export async function relayConfig(relay: string): Promise<{ workosClientId: string | null }> {
  const res = await fetch(new URL("/v1/config", relay));
  if (!res.ok) return { workosClientId: null };
  return (await res.json()) as { workosClientId: string | null };
}
