// Self-hosted relay on Bun: same protocol as the Cloudflare relay, one SQLite
// file per room. Usage: bun src/relay/bun.ts [--port 8787] [--data .relay-data]

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
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
  wsHeaders,
} from "./room.ts";

interface SocketData {
  roomId: string;
  since: number;
}

export function startRelay(opts: { port?: number; hostname?: string; dataDir?: string } = {}) {
  const dataDir = opts.dataDir ?? ".relay-data";
  mkdirSync(dataDir, { recursive: true });
  const stores = new Map<string, RoomStore>();
  const sockets = new Map<string, Set<ServerWebSocket<SocketData>>>();

  const storeFor = (roomId: string) => {
    let s = stores.get(roomId);
    if (!s) {
      const db = new Database(join(dataDir, `${roomId}.sqlite`), { create: true });
      db.run("PRAGMA journal_mode = WAL");
      s = new RoomStore({
        run: (q, ...p) => void db.query(q).run(...p),
        all: <T>(q: string, ...p: (string | number | null)[]) => db.query(q).all(...p) as T[],
      });
      stores.set(roomId, s);
    }
    return s;
  };

  const broadcast = (roomId: string, frame: string, except?: ServerWebSocket<SocketData>) => {
    for (const ws of sockets.get(roomId) ?? []) if (ws !== except) ws.send(frame);
  };

  return Bun.serve<SocketData>({
    port: opts.port ?? 8787,
    hostname: opts.hostname ?? "0.0.0.0",
    idleTimeout: 0,
    async fetch(req, server) {
      try {
        const url = new URL(req.url);
        if (url.pathname === "/") return new Response("modelchannel relay v1 (bun)\n");
        const route = parseRoomPath(url.pathname);
        if (!route) throw new HttpError(404, "not found");
        const store = storeFor(route.roomId);
        if (route.rest === "/ws") {
          await store.authorize(requestToken(req), url.searchParams.get("create") === "1");
          const since = Number(url.searchParams.get("since") ?? 0) || 0;
          if (server.upgrade(req, { data: { roomId: route.roomId, since }, headers: wsHeaders(req) })) return undefined;
          throw new HttpError(426, "expected websocket");
        }
        const { res, broadcast: frame } = await onHttp(store, req, route.rest);
        if (frame) broadcast(route.roomId, frame);
        return res;
      } catch (err) {
        return errorResponse(err);
      }
    },
    websocket: {
      idleTimeout: 120,
      open(ws) {
        let set = sockets.get(ws.data.roomId);
        if (!set) sockets.set(ws.data.roomId, (set = new Set()));
        set.add(ws);
        for (const f of welcomeFrames(storeFor(ws.data.roomId), ws.data.since)) ws.send(f);
      },
      message(ws, data) {
        const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
        if (raw === PING) return void ws.send(PONG);
        const { broadcast: frame, others, reply } = onClientFrame(storeFor(ws.data.roomId), raw);
        if (reply) ws.send(reply);
        if (frame) broadcast(ws.data.roomId, frame);
        if (others) broadcast(ws.data.roomId, others, ws);
      },
      close(ws) {
        sockets.get(ws.data.roomId)?.delete(ws);
      },
    },
  });
}

if (import.meta.main) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const server = startRelay({ port: Number(arg("--port") ?? 8787), dataDir: arg("--data") });
  console.log(`modelchannel relay listening on ${server.url}`);
}
