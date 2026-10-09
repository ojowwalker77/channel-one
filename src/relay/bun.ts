// Self-hosted relay on Bun: same protocol as the Cloudflare relay, one SQLite
// file per room, created only when the room is and deleted when it closes.
// It can also serve the web dashboard (web/dist), as the Worker does.
// Usage: bun src/relay/bun.ts --help

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { ServerWebSocket } from "bun";
import { CLOSE_CLOSED, CLOSE_REMOVED, PING, PONG } from "../protocol.ts";
import { workosFromSettings, type HumanAuth } from "./human.ts";
import { onDeviceHttp, type DeviceStore, type DeviceTransfer } from "./devices.ts";
import { onVaultHttp, vaultSwap, type VaultRecord, type VaultStore } from "./vault.ts";
import { onMachineHttp, vouchedBy, type MachineRecord, type MachineStore } from "./machines.ts";
import { policyFrom, type RelayPolicy } from "./policy.ts";
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
  type Effects,
} from "./room.ts";

interface SocketData {
  roomId: string;
  pk: string;
  since: number;
}

/** The dashboard's files, and the sign-in origins its page may call besides this relay. */
export interface WebApp {
  dir: string;
  connect?: string[];
}

export function startRelay(
  opts: { port?: number; hostname?: string; dataDir?: string; human?: HumanAuth | null; policy?: RelayPolicy; web?: WebApp | null; now?: () => number } = {},
) {
  const human = opts.human ?? null;
  // Settings come from the caller, or else from the environment, the same keys the Worker reads.
  const policy = opts.policy ?? policyFrom(process.env);
  const web = opts.web ? webApp(opts.web) : null;
  const dataDir = opts.dataDir ?? ".relay-data";
  // Rooms hold ciphertext, member keys and join codes: only the relay's own user reads them.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dbs = new Map<string, Database>();
  const sockets = new Map<string, Set<ServerWebSocket<SocketData>>>();
  const file = (roomId: string) => join(dataDir, `${roomId}.sqlite`);
  // Signed-in people's channel lists (room ids and join codes only).
  const people = new Database(join(dataDir, "people.sqlite"), { create: true });
  people.run("CREATE TABLE IF NOT EXISTS entries (user TEXT NOT NULL, room TEXT NOT NULL, entry TEXT NOT NULL, PRIMARY KEY (user, room))");
  people.run("CREATE TABLE IF NOT EXISTS machines (pk TEXT PRIMARY KEY, rec TEXT NOT NULL, user TEXT)");
  people.run("CREATE TABLE IF NOT EXISTS devices (user TEXT NOT NULL, id TEXT NOT NULL, rec TEXT NOT NULL, PRIMARY KEY (user, id))");
  const devices: DeviceStore = {
    list: async (user) => (people.query("SELECT rec FROM devices WHERE user = ?").all(user) as { rec: string }[]).map((r) => JSON.parse(r.rec) as DeviceTransfer),
    put: async (user, r) => void people.query("INSERT OR REPLACE INTO devices (user, id, rec) VALUES (?, ?, ?)").run(user, r.id, JSON.stringify(r)),
    remove: async (user, id) => void people.query("DELETE FROM devices WHERE user = ? AND id = ?").run(user, id),
  };
  // Each person's vault: ciphertext only (src/relay/vault.ts).
  people.run("CREATE TABLE IF NOT EXISTS vaults (user TEXT PRIMARY KEY, rec TEXT NOT NULL)");
  const vaultOf = (user: string) => {
    const row = people.query("SELECT rec FROM vaults WHERE user = ?").get(user) as { rec: string } | null;
    return row ? (JSON.parse(row.rec) as VaultRecord) : null;
  };
  // bun:sqlite is synchronous and this process is the only writer, so read-check-write can't interleave.
  const vaults: VaultStore = {
    get: async (user) => vaultOf(user),
    put: async (user, expected, rec) => {
      const current = vaultOf(user);
      if (!vaultSwap(current, expected)) return { ok: false, current };
      people.query("INSERT OR REPLACE INTO vaults (user, rec) VALUES (?, ?)").run(user, JSON.stringify(rec));
      return { ok: true };
    },
    remove: async (user, expected) => {
      const current = vaultOf(user);
      if (!current || !vaultSwap(current, expected)) return false;
      people.query("DELETE FROM vaults WHERE user = ?").run(user);
      return true;
    },
  };
  const machines: MachineStore = {
    get: async (pk) => {
      const row = people.query("SELECT rec FROM machines WHERE pk = ?").get(pk) as { rec: string } | null;
      return row ? (JSON.parse(row.rec) as MachineRecord) : null;
    },
    put: async (rec) => void people.query("INSERT OR REPLACE INTO machines (pk, rec, user) VALUES (?, ?, ?)").run(rec.pk, JSON.stringify(rec), rec.user),
    remove: async (rec) => void people.query("DELETE FROM machines WHERE pk = ?").run(rec.pk),
    listFor: async (user) =>
      (people.query("SELECT rec FROM machines WHERE user = ?").all(user) as { rec: string }[])
        .map((r) => JSON.parse(r.rec) as MachineRecord)
        .map((m) => ({ pk: m.pk, label: m.label, linked: m.linked ?? m.created })),
  };

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
      policy,
      opts.now,
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

  /**
   * Expire idle rooms: the Bun relay's version of the Worker's alarm. Runs hourly when the relay
   * expires idle rooms at all; returns how many it expired (tests call it directly).
   */
  const sweep = (): number => {
    if (!policy.expireAfterDays) return 0;
    let expired = 0;
    for (const f of readdirSync(dataDir)) {
      const m = /^([0-9a-f]{32})\.sqlite$/.exec(f);
      if (!m || sockets.get(m[1]!)?.size) continue;
      const store = storeFor(m[1]!, false);
      if (!store.idleExpired()) continue;
      apply(m[1]!, store.expire());
      expired++;
    }
    return expired;
  };
  const sweeper = policy.expireAfterDays ? setInterval(sweep, 3_600_000) : undefined;
  sweeper?.unref?.();

  const server = Bun.serve<SocketData>({
    port: opts.port ?? 8787,
    hostname: opts.hostname ?? "0.0.0.0",
    idleTimeout: 0,
    async fetch(req, server) {
      try {
        const url = new URL(req.url);
        if (web && !url.pathname.startsWith("/v1/") && (req.method === "GET" || req.method === "HEAD")) return web(url.pathname);
        if (url.pathname === "/") return new Response("Kiwi Channels relay (bun)\n");
        if (url.pathname === "/v1/config") return relayConfig(human);
        const device = await onDeviceHttp(req, devices, human);
        if (device) return device;
        const vault = await onVaultHttp(req, vaults, human);
        if (vault) return vault;
        const machine = await onMachineHttp(req, machines, human);
        if (machine) return machine;
        if (url.pathname === "/v1/me/usage" && req.method === "GET") {
          return await myUsage(
            req,
            human,
            policy,
            async (user) => (people.query("SELECT entry FROM entries WHERE user = ?").all(user) as { entry: string }[]).map((r) => JSON.parse(r.entry) as DirectoryEntry),
            async (room) => (existsSync(file(room)) ? storeFor(room, false).usage() : null),
          );
        }
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
        let result: Awaited<ReturnType<typeof onHttp>>;
        try {
          result = await onHttp(store, req, route.rest, {
            human,
            vouch: (pk, m) => vouchedBy(machines, route.roomId, pk, m),
            policy,
            ownedChannels: async (user) =>
              (people.query("SELECT entry FROM entries WHERE user = ?").all(user) as { entry: string }[]).filter((r) => (JSON.parse(r.entry) as DirectoryEntry).owner).length,
          });
        } catch (err) {
          // A create that failed leaves no file behind.
          if (route.rest === "/create" && !store.exists()) {
            dbs.get(route.roomId)?.close();
            dbs.delete(route.roomId);
            for (const suffix of ["", "-wal", "-shm"]) rmSync(file(route.roomId) + suffix, { force: true });
          }
          throw err;
        }
        if (result.fx) apply(route.roomId, result.fx);
        return result.res;
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
        const store = storeFor(ws.data.roomId, false);
        for (const f of welcomeFrames(store, ws.data.since)) ws.send(f);
        // A connection counts as activity for idle expiry.
        store.touch();
      },
      message(ws, data) {
        const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
        if (raw === PING) return void ws.send(PONG);
        const fx = onClientFrame(storeFor(ws.data.roomId, false), raw, ws.data.pk);
        if (fx.reply) ws.send(fx.reply);
        apply(ws.data.roomId, fx, ws);
      },
      close(ws) {
        sockets.get(ws.data.roomId)?.delete(ws);
      },
    },
  });
  return Object.assign(server, { sweep });
}

/**
 * Serves the dashboard the way the Worker's static assets do: real files as
 * they are, any other page address gets index.html (so /auth/callback loads
 * the app), and the same security headers as web/public/_headers. The CSP is
 * built here because its sign-in origins depend on this relay's settings.
 */
function webApp(app: WebApp): (pathname: string) => Response {
  const root = resolve(app.dir);
  if (!existsSync(join(root, "index.html"))) throw new Error(`no index.html in ${root} (build it with: bun run web:build)`);
  const connect = ["'self'", ...(app.connect ?? [])].join(" ");
  const security = {
    "content-security-policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src ${connect}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
  const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

  return (pathname) => {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return new Response("bad path\n", { status: 400 });
    }
    const path = resolve(root, "." + rel);
    // Never outside the dashboard folder, and never Cloudflare's own config files.
    const inside = path.startsWith(root + sep) && !["_headers", "_redirects"].includes(basename(path));
    if (inside && isFile(path)) {
      const headers: Record<string, string> = { ...security };
      // Vite fingerprints everything under /assets; the rest must be rechecked each time.
      headers["cache-control"] = rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
      // The installers are fetched with curl | sh and must read as text.
      if (/^\/install(\.sh|\.ps1)?$/.test(rel)) headers["content-type"] = "text/plain; charset=utf-8";
      return new Response(Bun.file(path), { headers });
    }
    // A missing file (it has an extension) is a 404, not the app: a stale script must fail loudly.
    if (/\.[A-Za-z0-9]+$/.test(basename(rel))) return new Response("not found\n", { status: 404, headers: security });
    return new Response(Bun.file(join(root, "index.html")), { headers: { ...security, "cache-control": "no-cache" } });
  };
}

const usage = (cmd: string) => `Kiwi Channels relay (Bun)

Usage: ${cmd} [options]

  --port <n>                    port to listen on (default 8787; env PORT)
  --hostname <addr>             address to bind (default 0.0.0.0; 127.0.0.1 behind a reverse proxy; env KIWI_HOSTNAME)
  --data <dir>                  where rooms are stored (default .relay-data; env KIWI_DATA)
  --web <dir>                   serve the dashboard from here (default web/dist when built; env KIWI_WEB)
  --no-web                      don't serve the dashboard
  --workos-client-id <id>       turn on sign-in with your WorkOS AuthKit app (env WORKOS_CLIENT_ID)
  --workos-authkit-domain <url> your AuthKit domain, https://….authkit.app (env WORKOS_AUTHKIT_DOMAIN)

  WORKOS_API_KEY (env only, it's a secret) lets the relay show people's real names.
  Without a WorkOS client id the relay has no sign-in: anyone can create channels.
  Beta and quota settings are read from the environment: the same KIWI_* keys the
  Worker reads from wrangler.jsonc (see src/relay/policy.ts). Unset: no gate, no quotas.
`;

/** The relay from the command line: `bun src/relay/bun.ts …` from a checkout, or `kiwi relay …` from the binary. */
export function runRelay(argv: string[], cmd = "bun src/relay/bun.ts"): void {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage(cmd));
    process.exit(0);
  }
  const arg = (name: string, env: string) => {
    const i = argv.indexOf(name);
    return (i >= 0 ? argv[i + 1] : undefined) ?? (process.env[env] || undefined);
  };
  const authkitDomain = arg("--workos-authkit-domain", "WORKOS_AUTHKIT_DOMAIN")?.replace(/\/$/, "");
  const human = workosFromSettings({ clientId: arg("--workos-client-id", "WORKOS_CLIENT_ID"), authkitDomain, apiKey: process.env.WORKOS_API_KEY || undefined });
  const builtWeb = resolve(import.meta.dir, "../../web/dist");
  const webDir = argv.includes("--no-web") ? undefined : (arg("--web", "KIWI_WEB") ?? (existsSync(join(builtWeb, "index.html")) ? builtWeb : undefined));
  const connect = human ? ["https://api.workos.com", ...(authkitDomain ? [authkitDomain] : [])] : [];
  const server = startRelay({
    port: Number(arg("--port", "PORT") ?? 8787),
    hostname: arg("--hostname", "KIWI_HOSTNAME"),
    dataDir: arg("--data", "KIWI_DATA"),
    human,
    web: webDir ? { dir: webDir, connect } : null,
  });
  console.log(`Kiwi Channels relay listening on ${server.url}`);
  console.log(`  sign-in: ${human ? `WorkOS ${human.clientId}${human.profile ? " (with names)" : ""}` : "off"}`);
  console.log(`  dashboard: ${webDir ? resolve(webDir) : "not served"}`);
}

if (import.meta.main) runRelay(process.argv.slice(2));
