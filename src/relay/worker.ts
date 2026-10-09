// Cloudflare relay: one SQLite-backed Durable Object per channel.
//
// Sockets use the hibernation API, so a room with idle agents connected is
// evicted from memory and billed nothing; heartbeats are answered by the
// runtime's auto-response without waking it. Each socket remembers which
// member key opened it, so removing a member disconnects exactly them.

import { DurableObject } from "cloudflare:workers";
import { CLOSE_CLOSED, CLOSE_REMOVED, PING, PONG } from "../protocol.ts";
import { workosHumanAuth, workosProfiles, type HumanAuth } from "./human.ts";
import { onDeviceHttp, type DeviceStore, type DeviceTransfer } from "./devices.ts";
import { onVaultHttp, vaultSwap, type VaultRecord, type VaultStore } from "./vault.ts";
import { onMachineHttp, vouchedBy, type MachineRecord, type MachineStore } from "./machines.ts";
import { policyFrom } from "./policy.ts";
import {
  HttpError,
  RoomStore,
  relayConfig,
  authenticateSocket,
  errorResponse,
  myChannels,
  myUsage,
  onClientFrame,
  onHttp,
  parseRoomPath,
  welcomeFrames,
  wsHeaders,
  type DirectoryEntry,
  type DirectoryUpdate,
  type Effects,
  type Sql,
} from "./room.ts";

interface Env {
  CHANNELS: DurableObjectNamespace<Channel>;
  /** One per signed-in person: the channels they own, are in, or have agents in. */
  PEOPLE: DurableObjectNamespace<Directory>;
  /** When set, channels belong to humans signed in with this WorkOS AuthKit client. */
  WORKOS_CLIENT_ID?: string;
  /** The AuthKit domain (https://….authkit.app), whose keys may also sign tokens. */
  WORKOS_AUTHKIT_DOMAIN?: string;
  /** Secret: lets the relay vouch for people's real names ("agent of @…"). */
  WORKOS_API_KEY?: string;
}

let humanAuth: HumanAuth | null | undefined;
/** One verifier (and JWKS cache) per isolate. */
function human(env: Env): HumanAuth | null {
  if (humanAuth === undefined) {
    const id = env.WORKOS_CLIENT_ID;
    const jwks = id ? [`https://api.workos.com/sso/jwks/${id}`, ...(env.WORKOS_AUTHKIT_DOMAIN ? [`${env.WORKOS_AUTHKIT_DOMAIN}/oauth2/jwks`] : [])] : [];
    humanAuth = id ? { ...workosHumanAuth(id, jwks), ...(env.WORKOS_API_KEY ? { profile: workosProfiles(env.WORKOS_API_KEY) } : {}) } : null;
  }
  return humanAuth;
}

export class Channel extends DurableObject<Env> {
  private readonly sql: Sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = {
      run: (q, ...p) => void ctx.storage.sql.exec(q, ...p),
      all: <T>(q: string, ...p: (string | number | null)[]) => ctx.storage.sql.exec(q, ...p).toArray() as T[],
    };
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  private store(roomId: string): RoomStore {
    return new RoomStore(this.sql, roomId, policyFrom(this.env as unknown as Record<string, string | undefined>));
  }

  override async fetch(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const route = parseRoomPath(url.pathname)!;
      const store = this.store(route.roomId);
      if (route.rest === "/ws") {
        if (store.isLegacy()) {
          await this.apply({ wipe: true });
          throw new HttpError(404, "no such channel", "ChannelGone");
        }
        if (req.headers.get("upgrade") !== "websocket") throw new HttpError(426, "expected websocket");
        const pk = await authenticateSocket(store, req);
        const { 0: client, 1: server } = new WebSocketPair();
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ pk, room: route.roomId });
        for (const f of welcomeFrames(store, Number(url.searchParams.get("since") ?? 0) || 0)) server.send(f);
        await this.apply({ expireAt: store.touch() ?? undefined });
        return new Response(null, { status: 101, webSocket: client, headers: wsHeaders(req) });
      }
      const { res, fx } = await onHttp(store, req, route.rest, {
        human: human(this.env),
        vouch: (pk, machine) => vouchedBy(machineStore(this.env), route.roomId, pk, machine),
        policy: policyFrom(this.env as unknown as Record<string, string | undefined>),
        ownedChannels: async (user) =>
          ((await (await this.env.PEOPLE.get(this.env.PEOPLE.idFromName(user)).fetch("https://directory/list")).json()) as DirectoryEntry[]).filter((c) => c.owner).length,
      });
      if (fx) await this.apply(fx);
      return res;
    } catch (err) {
      return errorResponse(err);
    }
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const { room, pk } = ws.deserializeAttachment() as { room: string; pk: string };
    const fx = onClientFrame(this.store(room), typeof data === "string" ? data : new TextDecoder().decode(data), pk);
    if (fx.reply) ws.send(fx.reply);
    await this.apply(fx, ws);
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {}
  }

  private async apply(fx: Effects, sender?: WebSocket): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    for (const f of fx.broadcast ?? []) for (const ws of sockets) send(ws, f);
    if (fx.others) for (const ws of sockets) if (ws !== sender) send(ws, fx.others);
    if (fx.disconnect) {
      for (const ws of sockets) {
        if ((ws.deserializeAttachment() as { pk?: string } | null)?.pk === fx.disconnect) close(ws, CLOSE_REMOVED, "removed from channel");
      }
    }
    // People's channel lists are best-effort: a failure there must never stop a close from wiping.
    if (fx.directory?.length) {
      await Promise.allSettled(
        fx.directory.map((u) => this.env.PEOPLE.get(this.env.PEOPLE.idFromName(u.user)).fetch("https://directory/apply", { method: "POST", body: JSON.stringify(u) })),
      );
    }
    if (fx.wipe) {
      // Closing leaves no breadcrumbs: every row and table goes, alarms included.
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      for (const ws of sockets) close(ws, CLOSE_CLOSED, "channel closed");
    } else if (fx.expireAt) {
      await this.ctx.storage.setAlarm(fx.expireAt);
    }
  }

  /** An idle room's expiry check: expire it if nobody's connected and nothing was stored since. */
  override async alarm(): Promise<void> {
    const room = (this.sql.all<{ v: string }>("SELECT v FROM meta WHERE k = 'room'")[0] ?? null)?.v;
    if (!room) return;
    const store = this.store(room);
    const days = store.policy.expireAfterDays;
    if (!days) return;
    // Someone's still connected: look again later rather than cut them off.
    if (this.ctx.getWebSockets().length) return void (await this.ctx.storage.setAlarm(Date.now() + days * 86_400_000));
    if (store.idleExpired()) await this.apply(store.expire());
    else await this.ctx.storage.setAlarm(Number(this.sql.all<{ v: string }>("SELECT v FROM meta WHERE k = 'active'")[0]?.v ?? Date.now()) + days * 86_400_000);
  }
}

/** A signed-in person's channel list. Holds room ids and join codes only; a closed channel is removed from it. */
export class Directory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS entries (room TEXT PRIMARY KEY, entry TEXT NOT NULL)");
    // A person's linked computers; and, in a computer's own object, its record.
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS machines (pk TEXT PRIMARY KEY, label TEXT NOT NULL, linked INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS machine (k INTEGER PRIMARY KEY CHECK (k = 1), rec TEXT NOT NULL)");
    // Boxes handing a person's channels to another of their devices (ciphertext only).
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, rec TEXT NOT NULL)");
    // The person's vault (ciphertext only): one row, swapped by version.
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS vault (k INTEGER PRIMARY KEY CHECK (k = 1), rec TEXT NOT NULL)");
  }

  override async fetch(req: Request): Promise<Response> {
    const { pathname, searchParams } = new URL(req.url);
    const sql = this.ctx.storage.sql;
    if (pathname === "/devices") {
      if (req.method === "PUT") {
        const r = (await req.json()) as DeviceTransfer;
        sql.exec("INSERT OR REPLACE INTO devices (id, rec) VALUES (?, ?)", r.id, JSON.stringify(r));
      } else if (req.method === "DELETE") sql.exec("DELETE FROM devices WHERE id = ?", searchParams.get("id") ?? "");
      return Response.json((sql.exec("SELECT rec FROM devices").toArray() as { rec: string }[]).map((r) => JSON.parse(r.rec) as DeviceTransfer));
    }
    if (pathname === "/vault") {
      const read = () => {
        const row = sql.exec("SELECT rec FROM vault").toArray()[0] as { rec: string } | undefined;
        return row ? (JSON.parse(row.rec) as VaultRecord) : null;
      };
      if (req.method === "GET") return Response.json(read());
      const { expected, rec } = (await req.json()) as { expected: number; rec?: VaultRecord };
      // One object per person, and no await between this read and the write: the swap is atomic.
      const current = read();
      if (!vaultSwap(current, expected)) return Response.json({ ok: false, current });
      if (req.method === "PUT" && rec) sql.exec("INSERT OR REPLACE INTO vault (k, rec) VALUES (1, ?)", JSON.stringify(rec));
      else if (req.method === "DELETE" && current) sql.exec("DELETE FROM vault");
      else return Response.json({ ok: false, current });
      return Response.json({ ok: true });
    }
    if (pathname === "/machine") {
      if (req.method === "PUT") sql.exec("INSERT OR REPLACE INTO machine (k, rec) VALUES (1, ?)", await req.text());
      else if (req.method === "DELETE") sql.exec("DELETE FROM machine");
      const row = sql.exec("SELECT rec FROM machine").toArray()[0] as { rec: string } | undefined;
      return Response.json(row ? JSON.parse(row.rec) : null);
    }
    if (pathname === "/machines") {
      if (req.method === "PUT") {
        const m = (await req.json()) as { pk: string; label: string; linked: number };
        sql.exec("INSERT OR REPLACE INTO machines (pk, label, linked) VALUES (?, ?, ?)", m.pk, m.label, m.linked);
      } else if (req.method === "DELETE") sql.exec("DELETE FROM machines WHERE pk = ?", searchParams.get("pk") ?? "");
      return Response.json(sql.exec("SELECT pk, label, linked FROM machines ORDER BY linked DESC").toArray());
    }
    if (req.method === "POST") {
      const u = (await req.json()) as DirectoryUpdate;
      if (u.entry) this.ctx.storage.sql.exec("INSERT OR REPLACE INTO entries (room, entry) VALUES (?, ?)", u.room, JSON.stringify(u.entry));
      else this.ctx.storage.sql.exec("DELETE FROM entries WHERE room = ?", u.room);
      return Response.json({ ok: true });
    }
    const rows = this.ctx.storage.sql.exec("SELECT entry FROM entries").toArray() as { entry: string }[];
    return Response.json(rows.map((r) => JSON.parse(r.entry) as DirectoryEntry));
  }
}

/** Device handoffs live in the person's own Directory object. */
function deviceStore(env: Env): DeviceStore {
  const at = (user: string) => env.PEOPLE.get(env.PEOPLE.idFromName(user));
  return {
    list: async (user) => (await at(user).fetch("https://directory/devices")).json(),
    put: async (user, r) => void (await at(user).fetch("https://directory/devices", { method: "PUT", body: JSON.stringify(r) })),
    remove: async (user, id) => void (await at(user).fetch(`https://directory/devices?id=${encodeURIComponent(id)}`, { method: "DELETE" })),
  };
}

/** A person's vault lives in their own Directory object, which runs the compare-and-swap. */
function vaultStore(env: Env): VaultStore {
  const at = (user: string) => env.PEOPLE.get(env.PEOPLE.idFromName(user));
  const swap = async (user: string, method: string, expected: number, rec?: VaultRecord) =>
    (await (await at(user).fetch("https://directory/vault", { method, body: JSON.stringify({ expected, rec }) })).json()) as { ok: boolean; current?: VaultRecord | null };
  return {
    get: async (user) => (await at(user).fetch("https://directory/vault")).json(),
    put: async (user, expected, rec) => {
      const r = await swap(user, "PUT", expected, rec);
      return r.ok ? { ok: true } : { ok: false, current: r.current ?? null };
    },
    remove: async (user, expected) => (await swap(user, "DELETE", expected)).ok,
  };
}

/** Computers live in their own Directory object ("machine:<pk>"); each person's object lists theirs. */
function machineStore(env: Env): MachineStore {
  const at = (name: string) => env.PEOPLE.get(env.PEOPLE.idFromName(name));
  return {
    get: async (pk) => (await at(`machine:${pk}`).fetch("https://directory/machine")).json<MachineRecord | null>(),
    put: async (rec) => {
      await at(`machine:${rec.pk}`).fetch("https://directory/machine", { method: "PUT", body: JSON.stringify(rec) });
      if (rec.user) await at(rec.user).fetch("https://directory/machines", { method: "PUT", body: JSON.stringify({ pk: rec.pk, label: rec.label, linked: rec.linked ?? Date.now() }) });
    },
    remove: async (rec) => {
      await at(`machine:${rec.pk}`).fetch("https://directory/machine", { method: "DELETE" });
      if (rec.user) await at(rec.user).fetch(`https://directory/machines?pk=${encodeURIComponent(rec.pk)}`, { method: "DELETE" });
    },
    listFor: async (user) => (await at(user).fetch("https://directory/machines")).json(),
  };
}

function send(ws: WebSocket, f: string): void {
  try {
    ws.send(f);
  } catch {}
}

function close(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {}
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/v1/config") return relayConfig(human(env));
    if (url.pathname.startsWith("/v1/me/devices")) {
      try {
        return (await onDeviceHttp(req, deviceStore(env), human(env))) ?? errorResponse(new HttpError(404, "not found"));
      } catch (err) {
        return errorResponse(err);
      }
    }
    if (url.pathname === "/v1/me/vault") {
      try {
        return (await onVaultHttp(req, vaultStore(env), human(env))) ?? errorResponse(new HttpError(404, "not found"));
      } catch (err) {
        return errorResponse(err);
      }
    }
    if (url.pathname.startsWith("/v1/machines") || url.pathname.startsWith("/v1/me/machines")) {
      try {
        return (await onMachineHttp(req, machineStore(env), human(env))) ?? errorResponse(new HttpError(404, "not found"));
      } catch (err) {
        return errorResponse(err);
      }
    }
    if (url.pathname === "/v1/me/usage" && req.method === "GET") {
      try {
        const people = (user: string) => env.PEOPLE.get(env.PEOPLE.idFromName(user));
        return await myUsage(
          req,
          human(env),
          policyFrom(env as unknown as Record<string, string | undefined>),
          async (user) => (await people(user).fetch("https://directory/list")).json(),
          // Each channel answers for itself, to the same signed-in person.
          async (room) => {
            const res = await env.CHANNELS.get(env.CHANNELS.idFromName(room)).fetch(new Request(`https://relay/v1/rooms/${room}/usage`, { headers: req.headers }));
            return res.ok ? res.json() : null;
          },
        );
      } catch (err) {
        return errorResponse(err);
      }
    }
    if (url.pathname === "/v1/me/channels" && req.method === "GET") {
      try {
        return await myChannels(req, human(env), async (user) => (await env.PEOPLE.get(env.PEOPLE.idFromName(user)).fetch("https://directory/list")).json());
      } catch (err) {
        return errorResponse(err);
      }
    }
    const route = parseRoomPath(url.pathname);
    if (!route) return errorResponse(new HttpError(404, "not found"));
    return env.CHANNELS.get(env.CHANNELS.idFromName(route.roomId)).fetch(req);
  },
} satisfies ExportedHandler<Env>;
