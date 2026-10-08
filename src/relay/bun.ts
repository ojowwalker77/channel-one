// Self-hosted relay on Bun: same protocol as the Cloudflare relay, one SQLite
// file per room, created only when the room is and deleted when it closes.
// Usage: bun src/relay/bun.ts [--port 8787] [--data .relay-data]

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { CLOSE_CLOSED, CLOSE_REMOVED, PING, PONG } from "../protocol.ts";
import type { HumanAuth } from "./human.ts";
import {
  HttpError,
  RoomStore,
  relayConfig,
  authenticateSocket,
  errorResponse,
  myChannels,
  onClientFrame,
  onHttp,
  parseRoomPath,
  welcomeFrames,
  wsHeaders,
  type DirectoryEntry,
  type Effects,
} from "./room.ts";

interface SocketData {
  roomId: string;
  pk: string;
  since: number;
}

export function startRelay(opts: { port?: number; hostname?: string; dataDir?: string; human?: HumanAuth | null } = {}) {
  const human = opts.human ?? null;
  const dataDir = opts.dataDir ?? ".relay-data";
  mkdirSync(dataDir, { recursive: true });
  const dbs = new Map<string, Database>();
  const sockets = new Map<string, Set<ServerWebSocket<SocketData>>>();
  const file = (roomId: string) => join(dataDir, `${roomId}.sqlite`);
  // Signed-in people's channel lists (room ids and join codes only).
  const people = new Database(join(dataDir, "people.sqlite"), { create: true });
  people.run("CREATE TABLE IF NOT EXISTS entries (user TEXT NOT NULL, room TEXT NOT NULL, entry TEXT NOT NULL, PRIMARY KEY (user, room))");

  /** A store for the room; rooms that don't exist get a throwaway in-memory DB (so no file appears). */
  const storeFor = (roomId: string, creating: boolean): RoomStore => {
    let db = dbs.get(roomId);
    if (!db) {
      if (!creating && !existsSync(file(roomId))) db = new Database(":memory:");
      else {
        db = new Database(file(roomId), { create: true });
        db.run("PRAGMA journal_mode = WAL");
        dbs.set(roomId, db);
      }
    }
    const d = db;
    return new RoomStore(
      {
        run: (q, ...p) => void d.query(q).run(...p),
        all: <T>(q: string, ...p: (string | number | null)[]) => d.query(q).all(...p) as T[],
      },
      roomId,
    );
  };

  const apply = (roomId: string, fx: Effects, sender?: ServerWebSocket<SocketData>) => {
    const room = sockets.get(roomId) ?? new Set();
    for (const f of fx.broadcast ?? []) for (const ws of room) ws.send(f);
    if (fx.others) for (const ws of room) if (ws !== sender) ws.send(fx.others);
    if (fx.disconnect) for (const ws of room) if (ws.data.pk === fx.disconnect) ws.close(CLOSE_REMOVED, "removed from channel");
    for (const u of fx.directory ?? []) {
      if (u.entry) people.query("INSERT OR REPLACE INTO entries (user, room, entry) VALUES (?, ?, ?)").run(u.user, u.room, JSON.stringify(u.entry));
      else people.query("DELETE FROM entries WHERE user = ? AND room = ?").run(u.user, u.room);
    }
    if (fx.wipe) {
      dbs.get(roomId)?.close();
      dbs.delete(roomId);
      for (const suffix of ["", "-wal", "-shm"]) rmSync(file(roomId) + suffix, { force: true });
      for (const ws of room) ws.close(CLOSE_CLOSED, "channel closed");
      sockets.delete(roomId);
    }
  };

  return Bun.serve<SocketData>({
    port: opts.port ?? 8787,
    hostname: opts.hostname ?? "0.0.0.0",
    idleTimeout: 0,
    async fetch(req, server) {
      try {
        const url = new URL(req.url);
        if (url.pathname === "/") return new Response("channel-one relay (bun)\n");
        if (url.pathname === "/v1/config") return relayConfig(human);
        if (url.pathname === "/v1/me/channels" && req.method === "GET") {
          return await myChannels(req, human, async (user) =>
            (people.query("SELECT entry FROM entries WHERE user = ?").all(user) as { entry: string }[]).map((r) => JSON.parse(r.entry) as DirectoryEntry),
          );
        }
        const route = parseRoomPath(url.pathname);
        if (!route) throw new HttpError(404, "not found");
        const store = storeFor(route.roomId, route.rest === "/create");
        if (route.rest === "/ws") {
          if (store.isLegacy()) {
            apply(route.roomId, { wipe: true });
            throw new HttpError(404, "no such channel");
          }
          const pk = await authenticateSocket(store, req);
          const since = Number(url.searchParams.get("since") ?? 0) || 0;
          if (server.upgrade(req, { data: { roomId: route.roomId, pk, since }, headers: wsHeaders(req) })) return undefined;
          throw new HttpError(426, "expected websocket");
        }
        const { res, fx } = await onHttp(store, req, route.rest, human);
        if (fx) apply(route.roomId, fx);
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
        for (const f of welcomeFrames(storeFor(ws.data.roomId, false), ws.data.since)) ws.send(f);
      },
      message(ws, data) {
        const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
        if (raw === PING) return void ws.send(PONG);
        const fx = onClientFrame(storeFor(ws.data.roomId, false), raw);
        if (fx.reply) ws.send(fx.reply);
        apply(ws.data.roomId, fx, ws);
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
  console.log(`channel-one relay listening on ${server.url}`);
}
