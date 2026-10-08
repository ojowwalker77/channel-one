// Cloudflare relay: one SQLite-backed Durable Object per channel.
//
// Sockets use the hibernation API, so a room with idle agents connected is
// evicted from memory and billed nothing; heartbeats are answered by the
// runtime's auto-response without waking it.

import { DurableObject } from "cloudflare:workers";
import { PING, PONG } from "../protocol.ts";
import {
  HttpError,
  RoomStore,
  errorResponse,
  onClientFrame,
  onHttp,
  parseRoomPath,
  requestToken,
  welcomeFrames,
  type Sql,
} from "./room.ts";

interface Env {
  ROOM: DurableObjectNamespace<Room>;
}

export class Room extends DurableObject<Env> {
  private readonly store: RoomStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql: Sql = {
      run: (q, ...p) => void ctx.storage.sql.exec(q, ...p),
      all: <T>(q: string, ...p: (string | number | null)[]) => ctx.storage.sql.exec(q, ...p).toArray() as T[],
    };
    this.store = new RoomStore(sql);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  override async fetch(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const path = parseRoomPath(url.pathname)!.rest;
      if (path === "/ws") {
        if (req.headers.get("upgrade") !== "websocket") throw new HttpError(426, "expected websocket");
        await this.store.authorize(requestToken(req), url.searchParams.get("create") === "1");
        const { 0: client, 1: server } = new WebSocketPair();
        this.ctx.acceptWebSocket(server);
        for (const f of welcomeFrames(this.store, Number(url.searchParams.get("since") ?? 0) || 0)) server.send(f);
        return new Response(null, { status: 101, webSocket: client });
      }
      const { res, broadcast } = await onHttp(this.store, req, path);
      if (broadcast) this.broadcast(broadcast);
      return res;
    } catch (err) {
      return errorResponse(err);
    }
  }

  override webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): void {
    const { broadcast, reply } = onClientFrame(this.store, typeof data === "string" ? data : new TextDecoder().decode(data));
    ws.send(reply);
    if (broadcast) this.broadcast(broadcast);
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {}
  }

  private broadcast(frame: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
      } catch {}
    }
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response("modelchannel relay v1\n");
    const route = parseRoomPath(url.pathname);
    if (!route) return errorResponse(new HttpError(404, "not found"));
    return env.ROOM.get(env.ROOM.idFromName(route.roomId)).fetch(req);
  },
} satisfies ExportedHandler<Env>;
