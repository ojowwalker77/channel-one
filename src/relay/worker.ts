// Cloudflare relay: one SQLite-backed Durable Object per channel.
//
// Sockets use the hibernation API, so a room with idle agents connected is
// evicted from memory and billed nothing; heartbeats are answered by the
// runtime's auto-response without waking it. Each socket remembers which
// member key opened it, so removing a member disconnects exactly them.

import { DurableObject } from "cloudflare:workers";
import { CLOSE_CLOSED, CLOSE_REMOVED, PING, PONG } from "../protocol.ts";
import { workosHumanAuth, type HumanAuth } from "./human.ts";
import {
  HttpError,
  RoomStore,
  relayConfig,
  authenticateSocket,
  errorResponse,
  onClientFrame,
  onHttp,
  parseRoomPath,
  welcomeFrames,
  wsHeaders,
  type Effects,
  type Sql,
} from "./room.ts";

interface Env {
  CHANNELS: DurableObjectNamespace<Channel>;
  /** When set, channels belong to humans signed in with this WorkOS AuthKit client. */
  WORKOS_CLIENT_ID?: string;
  /** The AuthKit domain (https://….authkit.app), whose keys may also sign tokens. */
  WORKOS_AUTHKIT_DOMAIN?: string;
}

let humanAuth: HumanAuth | null | undefined;
/** One verifier (and JWKS cache) per isolate. */
function human(env: Env): HumanAuth | null {
  if (humanAuth === undefined) {
    const id = env.WORKOS_CLIENT_ID;
    const jwks = id ? [`https://api.workos.com/sso/jwks/${id}`, ...(env.WORKOS_AUTHKIT_DOMAIN ? [`${env.WORKOS_AUTHKIT_DOMAIN}/oauth2/jwks`] : [])] : [];
    humanAuth = id ? workosHumanAuth(id, jwks) : null;
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
    return new RoomStore(this.sql, roomId);
  }

  override async fetch(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const route = parseRoomPath(url.pathname)!;
      const store = this.store(route.roomId);
      if (route.rest === "/ws") {
        if (store.isLegacy()) {
          await this.apply({ wipe: true });
          throw new HttpError(404, "no such channel");
        }
        if (req.headers.get("upgrade") !== "websocket") throw new HttpError(426, "expected websocket");
        const pk = await authenticateSocket(store, req);
        const { 0: client, 1: server } = new WebSocketPair();
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ pk, room: route.roomId });
        for (const f of welcomeFrames(store, Number(url.searchParams.get("since") ?? 0) || 0)) server.send(f);
        return new Response(null, { status: 101, webSocket: client, headers: wsHeaders(req) });
      }
      const { res, fx } = await onHttp(store, req, route.rest, human(this.env));
      if (fx) await this.apply(fx);
      return res;
    } catch (err) {
      return errorResponse(err);
    }
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const { room } = ws.deserializeAttachment() as { room: string };
    const fx = onClientFrame(this.store(room), typeof data === "string" ? data : new TextDecoder().decode(data));
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
    if (fx.wipe) {
      // Closing leaves no breadcrumbs: every row and table goes.
      await this.ctx.storage.deleteAll();
      for (const ws of sockets) close(ws, CLOSE_CLOSED, "channel closed");
    }
  }
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
    const route = parseRoomPath(url.pathname);
    if (!route) return errorResponse(new HttpError(404, "not found"));
    return env.CHANNELS.get(env.CHANNELS.idFromName(route.roomId)).fetch(req);
  },
} satisfies ExportedHandler<Env>;
