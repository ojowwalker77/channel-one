// Room logic shared by the Cloudflare Durable Object and the self-hosted Bun
// relay. Both back a room with SQLite; each adapter supplies the SQL calls and
// the WebSocket fan-out.

import {
  WS_PROTOCOL,
  MAX_CT_LENGTH,
  MAX_EPH_LENGTH,
  PAGE_LIMIT,
  ROOM_RETENTION,
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

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Extract the token from the Authorization header or, for WebSockets, the subprotocol list. */
export function requestToken(req: Request): string {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const protos = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim());
  if (protos[0] === WS_PROTOCOL && protos[1]) return protos[1];
  return "";
}

/** Response headers that accept the modelchannel subprotocol, if the client offered it. */
export function wsHeaders(req: Request): Record<string, string> {
  return req.headers.get("sec-websocket-protocol")?.includes(WS_PROTOCOL) ? { "sec-websocket-protocol": WS_PROTOCOL } : {};
}

export class RoomStore {
  constructor(private readonly sql: Sql) {
    sql.run("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    sql.run(
      "CREATE TABLE IF NOT EXISTS msgs (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, iv TEXT NOT NULL, ct TEXT NOT NULL)",
    );
  }

  /**
   * Check a token. The first client to connect with create=true claims the
   * room by storing the token's hash; everyone after must present the same token.
   */
  async authorize(token: string, create: boolean): Promise<void> {
    if (!token) throw new HttpError(401, "missing token");
    const hash = await sha256Hex(token);
    const row = this.sql.all<{ v: string }>("SELECT v FROM meta WHERE k = 'verifier'")[0];
    if (!row) {
      if (!create) throw new HttpError(404, "no such channel");
      this.sql.run("INSERT INTO meta (k, v) VALUES ('verifier', ?)", hash);
      return;
    }
    if (row.v !== hash) throw new HttpError(403, "wrong token");
  }

  head(): number {
    return this.sql.all<{ s: number | null }>("SELECT MAX(seq) AS s FROM msgs")[0]?.s ?? 0;
  }

  append(iv: string, ct: string): Envelope {
    if (typeof iv !== "string" || typeof ct !== "string" || !iv || !ct) throw new HttpError(400, "bad envelope");
    if (ct.length > MAX_CT_LENGTH) throw new HttpError(413, "message too large");
    const ts = Date.now();
    this.sql.run("INSERT INTO msgs (ts, iv, ct) VALUES (?, ?, ?)", ts, iv, ct);
    const seq = this.head();
    // Prune in batches so retention costs one extra write pass per 100 messages.
    if (seq % 100 === 0) this.sql.run("DELETE FROM msgs WHERE seq <= ?", seq - ROOM_RETENTION);
    return { seq, ts, iv, ct };
  }

  since(seq: number, limit = PAGE_LIMIT): Envelope[] {
    return this.sql.all<Envelope>(
      "SELECT seq, ts, iv, ct FROM msgs WHERE seq > ? ORDER BY seq LIMIT ?",
      seq,
      Math.min(Math.max(limit, 1), PAGE_LIMIT),
    );
  }
}

export function msgFrame(e: Envelope): string {
  return JSON.stringify({ t: "msg", ...e } satisfies ServerFrame);
}

/** Frames to send a newly connected socket: the backlog after `since`, then ready. */
export function welcomeFrames(store: RoomStore, since: number): string[] {
  const backlog = store.since(since);
  const head = store.head();
  const last = backlog.at(-1)?.seq ?? since;
  return [...backlog.map(msgFrame), JSON.stringify({ t: "ready", head, more: last < head } satisfies ServerFrame)];
}

/**
 * Handle one client frame. Returns what to send: `broadcast` to every socket,
 * `others` to every socket except the sender, `reply` to the sender alone.
 */
export function onClientFrame(store: RoomStore, raw: string): { broadcast?: string; others?: string; reply?: string } {
  let frame: ClientFrame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return { reply: JSON.stringify({ t: "err", error: "bad json" } satisfies ServerFrame) };
  }
  if (frame.t === "eph") {
    // Presence and other ephemeral signals: relayed, never stored, never acked.
    if (typeof frame.iv !== "string" || typeof frame.ct !== "string" || frame.ct.length > MAX_EPH_LENGTH) {
      return { reply: JSON.stringify({ t: "err", error: "bad ephemeral frame" } satisfies ServerFrame) };
    }
    return { others: JSON.stringify({ t: "eph", iv: frame.iv, ct: frame.ct } satisfies ServerFrame) };
  }
  if (frame.t !== "send") return { reply: JSON.stringify({ t: "err", error: "unknown frame" } satisfies ServerFrame) };
  try {
    const e = store.append(frame.iv, frame.ct);
    return { broadcast: msgFrame(e), reply: JSON.stringify({ t: "ack", id: frame.id, seq: e.seq } satisfies ServerFrame) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { reply: JSON.stringify({ t: "err", error, id: frame.id } satisfies ServerFrame) };
  }
}

/**
 * The HTTP API, minus WebSocket upgrades:
 *   POST /messages          {iv, ct}  -> {seq, ts}      (create=1 allowed)
 *   GET  /messages?since=N&limit=M    -> {head, messages}
 * Returns the response plus a frame to broadcast, if a message was stored.
 */
export async function onHttp(store: RoomStore, req: Request, path: string): Promise<{ res: Response; broadcast?: string }> {
  const url = new URL(req.url);
  await store.authorize(requestToken(req), url.searchParams.get("create") === "1");
  if (path === "/messages" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { iv?: string; ct?: string } | null;
    const e = store.append(body?.iv as string, body?.ct as string);
    return { res: Response.json({ seq: e.seq, ts: e.ts }), broadcast: msgFrame(e) };
  }
  if (path === "/messages" && req.method === "GET") {
    const since = Number(url.searchParams.get("since") ?? 0) || 0;
    const limit = Number(url.searchParams.get("limit") ?? PAGE_LIMIT) || PAGE_LIMIT;
    return { res: Response.json({ head: store.head(), messages: store.since(since, limit) }) };
  }
  if (path === "/" && req.method === "GET") {
    return { res: Response.json({ head: store.head() }) };
  }
  throw new HttpError(404, "not found");
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
  console.error(err);
  return Response.json({ error: "internal error" }, { status: 500 });
}

/** Parse /v1/rooms/<roomId><rest>. */
export function parseRoomPath(pathname: string): { roomId: string; rest: string } | null {
  const m = /^\/v1\/rooms\/([0-9a-f]{32})(\/.*)?$/.exec(pathname);
  return m ? { roomId: m[1]!, rest: m[2] ?? "/" } : null;
}
