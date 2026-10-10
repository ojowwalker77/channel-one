// Linking a computer to a person, so agents started on it join already vouched
// for as theirs. Shared by the Cloudflare and Bun relays.
//
//   kiwi setup                          relay                         person (signed in, web)
//   machine key, label  ── register ──►  pending link (15 min)
//   prints a code, opens the browser ──────────────────────────────►  sees label + the same code
//                                         linked to their user  ◄──── confirms
//   polls (signed by the machine key) ◄─ linked, and to whom
//
// Afterwards `kiwi join` sends a vouch signed by the machine key; the relay
// sets the agent's sponsor to the machine's person. The owner still approves.

import { verifyRequest } from "../auth.ts";
import { verify, verifyText } from "../identity.ts";
import { MACHINE_SCOPE, machineCode, vouchStatement } from "../vouch.ts";
import { inlineText } from "../membership.ts";
import { HUMAN_HEADER, type HumanAuth } from "./human.ts";
import { HttpError } from "./room.ts";
import { fits, SignedByMachine } from "./schema.ts";

/** A computer as the relay knows it: its public key, the label its person sees, and whose it is. */
export interface MachineRecord {
  pk: string;
  label: string;
  user: string | null;
  created: number;
  linked?: number;
  /** When it last vouched for an agent or checked its link (to the hour). */
  used?: number;
}

export interface MachineStore {
  get(pk: string): Promise<MachineRecord | null>;
  put(rec: MachineRecord): Promise<void>;
  remove(rec: MachineRecord): Promise<void>;
  listFor(user: string): Promise<{ pk: string; label: string; linked: number }[]>;
}

/** How long a pending link waits for its person to confirm. After that, an unlinked registration is deleted. */
export const LINK_TTL_MS = 15 * 60_000;
/** New registrations one address may make in the window below. */
const REGISTRATIONS_PER_WINDOW = 20;
const REGISTER_WINDOW_MS = 10 * 60_000;
/** A linked computer nobody used for this long stops vouching: a forgotten laptop shouldn't speak for you forever. */
export const UNUSED_LINK_TTL_MS = 30 * 86_400_000;
/** Recording use costs a storage write, so it's kept to the hour. */
const USE_PRECISION_MS = 3600_000;

const lastUsed = (rec: MachineRecord) => rec.used ?? rec.linked ?? rec.created;

/** How many addresses the in-process limiter remembers. Past this, the oldest is dropped, not the whole table. */
const MAX_BUCKETS = 10_000;
const registrations = new Map<string, number[]>();

/** Move this address to the newest end, then drop the oldest until the table fits. */
function remember(ip: string, stamps: number[]): void {
  registrations.delete(ip);
  registrations.set(ip, stamps);
  while (registrations.size > MAX_BUCKETS) {
    const oldest = registrations.keys().next().value;
    if (oldest === undefined || oldest === ip) break;
    registrations.delete(oldest);
  }
}

/** False once this address has registered REGISTRATIONS_PER_WINDOW computers in the last 10 minutes. The Worker does not use this: an in-memory map does not survive across isolates. */
export function registrationAllowed(ip: string, now = Date.now()): boolean {
  const kept = (registrations.get(ip) ?? []).filter((t) => now - t < REGISTER_WINDOW_MS);
  if (kept.length >= REGISTRATIONS_PER_WINDOW) {
    remember(ip, kept);
    return false;
  }
  kept.push(now);
  remember(ip, kept);
  return true;
}

/** Drop unlinked registrations past the link window. Bun runs this on startup and hourly; the Worker uses an alarm per record. */
export async function sweepPending(list: () => Promise<MachineRecord[]>, remove: (rec: MachineRecord) => Promise<void>, now = Date.now()): Promise<number> {
  let n = 0;
  for (const rec of await list()) {
    if (rec.user || now - rec.created < LINK_TTL_MS) continue;
    await remove(rec);
    n++;
  }
  return n;
}

/** An address worth a bucket. Junk is refused so a header cannot mint unlimited keys. */
function usableIp(raw: string): string | null {
  let ip = raw.trim();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  if (!ip || ip.length > 64) return null;
  if (!/^[0-9a-fA-F:.]+$/.test(ip)) return null;
  if (!ip.includes(".") && !ip.includes(":")) return null;
  return ip;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = ((n << 8) | octet) >>> 0;
  }
  return n;
}

function v4text(n: number): string {
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

/** IPv4-mapped IPv6 becomes the IPv4 address, so a Docker peer reported either way matches one spec. */
function normalizeIp(ip: string): string {
  const lower = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped?.[1]) {
    const n = ipv4ToInt(mapped[1]);
    if (n !== null) return v4text(n);
  }
  if (!lower.includes(":")) {
    const n = ipv4ToInt(lower);
    if (n !== null) return v4text(n);
  }
  return lower;
}

function ipv6Bytes(ip: string): Uint8Array | null {
  const s = ip.toLowerCase();
  if (s.includes(".")) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const expand = (part: string) => (part ? part.split(":") : []);
  const left = expand(halves[0] ?? "");
  const right = halves.length === 2 ? expand(halves[1] ?? "") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const group = groups[i] ?? "";
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const n = Number.parseInt(group, 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  return out;
}

function v6prefix(ip: Uint8Array, network: Uint8Array, bits: number): boolean {
  let left = bits;
  for (let i = 0; i < 16 && left > 0; i++) {
    const take = Math.min(8, left);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((ip[i]! & mask) !== (network[i]! & mask)) return false;
    left -= take;
  }
  return true;
}

function specMatches(ip: string, spec: string): boolean {
  const slash = spec.lastIndexOf("/");
  const base = slash < 0 ? spec : spec.slice(0, slash);
  const bits = slash < 0 ? null : Number(spec.slice(slash + 1));
  const ip4 = ipv4ToInt(normalizeIp(ip));
  const base4 = ipv4ToInt(normalizeIp(base));
  if (ip4 !== null && base4 !== null && !base.includes(":")) {
    const n = bits ?? 32;
    if (!Number.isInteger(n) || n < 1 || n > 32) return false;
    const mask = n === 32 ? 0xffffffff : (0xffffffff << (32 - n)) >>> 0;
    return (ip4 & mask) === (base4 & mask);
  }
  const ip6 = ipv6Bytes(normalizeIp(ip));
  const net6 = ipv6Bytes(base.toLowerCase());
  if (!ip6 || !net6) return false;
  const n = bits ?? 128;
  if (!Number.isInteger(n) || n < 1 || n > 128) return false;
  return v6prefix(ip6, net6, n);
}

/** `true` trusts loopback only. A list trusts loopback and those addresses or CIDRs. `false` trusts no proxy. */
export type TrustProxy = boolean | readonly string[];

/** Check a --trust-proxy list. A prefix of /0 is refused: that would trust every peer. */
export function parseTrustProxy(specs: readonly string[]): string[] {
  return specs.map((raw) => {
    const spec = raw.trim();
    const slash = spec.lastIndexOf("/");
    const baseRaw = slash < 0 ? spec : spec.slice(0, slash);
    const bitsRaw = slash < 0 ? null : spec.slice(slash + 1);
    const base = usableIp(baseRaw);
    if (!base) throw new Error(`--trust-proxy: "${spec}" is not an address or CIDR`);
    const asV4 = ipv4ToInt(normalizeIp(base));
    const mapped = base.toLowerCase().startsWith("::ffff:") && asV4 !== null;
    if (asV4 !== null && (!base.includes(":") || mapped)) {
      if (mapped && bitsRaw !== null) throw new Error(`--trust-proxy: write ${v4text(asV4)} as an IPv4 CIDR, not ${spec}`);
      const n = bitsRaw === null ? 32 : Number(bitsRaw);
      if (!/^\d+$/.test(bitsRaw ?? "32") || n < 1 || n > 32) throw new Error(`--trust-proxy: "${spec}" is not an IPv4 CIDR`);
      const text = v4text(asV4);
      return n === 32 ? text : `${text}/${n}`;
    }
    if (!ipv6Bytes(base)) throw new Error(`--trust-proxy: "${spec}" is not an address or CIDR`);
    const n = bitsRaw === null ? 128 : Number(bitsRaw);
    if ((bitsRaw !== null && !/^\d+$/.test(bitsRaw)) || n < 1 || n > 128) throw new Error(`--trust-proxy: "${spec}" is not an IPv6 CIDR`);
    const text = base.toLowerCase();
    return n === 128 ? text : `${text}/${n}`;
  });
}

/** Bare `--trust-proxy` and `KIWI_TRUST_PROXY=1` trust loopback. A value is an address or CIDR list. The flag wins over the env. */
export function trustProxyFromArgs(argv: readonly string[], envValue: string | undefined): TrustProxy {
  const specs: string[] = [];
  let flagged = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--trust-proxy") continue;
    flagged = true;
    const next = argv[i + 1];
    if (next && !next.startsWith("-")) {
      for (const part of next.split(",")) {
        const spec = part.trim();
        if (spec) specs.push(spec);
      }
      i++;
    }
  }
  if (flagged) return specs.length ? parseTrustProxy(specs) : true;
  const env = envValue?.trim();
  if (!env || env === "0") return false;
  if (env === "1") return true;
  return parseTrustProxy(env.split(",").map((part) => part.trim()).filter(Boolean));
}

function proxyPeer(peerIp: string, trust: TrustProxy): boolean {
  if (!trust) return false;
  const ip = normalizeIp(peerIp);
  if (ip === "127.0.0.1" || ip === "::1") return true;
  if (trust === true) return false;
  return trust.some((spec) => specMatches(ip, spec));
}

/**
 * Who a Bun registration counts against. The peer, unless that peer is a trusted
 * proxy: then the last address in X-Forwarded-For, which is the one the proxy added.
 * Loopback is trusted when trust is on. A list also trusts those addresses and CIDRs
 * (Docker's bridge is not loopback). Any other peer ignores the header.
 */
export function registrationAddress(peer: string | null | undefined, forwardedFor: string | null | undefined, trustProxy: TrustProxy = false): string | null {
  const peerIp = peer ? usableIp(peer) : null;
  if (!peerIp || !proxyPeer(peerIp, trustProxy)) return peerIp;
  const parts = (forwardedFor ?? "").split(",");
  for (let i = parts.length - 1; i >= 0; i--) {
    const client = usableIp(parts[i] ?? "");
    if (client) return client;
  }
  return peerIp;
}

/** The client address Cloudflare puts on a Worker request. Absent in local tests, which are then not limited. */
export function cloudflareClient(req: Request): string | null {
  return usableIp(req.headers.get("cf-connecting-ip") ?? "");
}

/** How the route asks whether this address may register another computer. */
export interface RegistrationGate {
  ip: string;
  allow: (ip: string) => boolean | Promise<boolean>;
}

/** The computer's record, or null if it has expired and been deleted. An unlinked one lasts the link window; a linked one lasts until it goes unused. */
async function current(store: MachineStore, pk: string): Promise<MachineRecord | null> {
  const rec = await store.get(pk);
  if (!rec) return null;
  const expired = rec.user ? Date.now() - lastUsed(rec) > UNUSED_LINK_TTL_MS : Date.now() - rec.created >= LINK_TTL_MS;
  if (expired) {
    await store.remove(rec);
    return null;
  }
  return rec;
}

/** The computer just proved it holds its key: note it, at most once an hour. */
async function markUsed(store: MachineStore, rec: MachineRecord): Promise<void> {
  if (rec.used === undefined || Date.now() - rec.used >= USE_PRECISION_MS) await store.put({ ...rec, used: Date.now() });
}

/** Who vouches for an agent key: the person its machine is linked to, if the machine's signature checks out. */
export async function vouchedBy(store: MachineStore, roomId: string, agentPk: string, machine: unknown): Promise<string | null> {
  const m = machine as { pk?: unknown; sig?: unknown } | undefined;
  if (!m || typeof m.pk !== "string" || typeof m.sig !== "string") return null;
  const rec = await current(store, m.pk);
  if (!rec?.user) return null;
  if (!(await verifyText(m.pk, m.sig, vouchStatement(roomId, agentPk)))) return null;
  await markUsed(store, rec);
  return rec.user;
}

/** Routes under /v1/machines and /v1/me/machines; null when the path isn't one of them. */
export async function onMachineHttp(req: Request, store: MachineStore, human: HumanAuth | null, gate?: RegistrationGate | null): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();
  if (!path.startsWith("/v1/machines") && !path.startsWith("/v1/me/machines")) return null;
  if (!human) throw new HttpError(404, "this relay has no sign-in, so computers can't be linked");
  const body = method === "GET" || method === "DELETE" ? "" : await req.text();
  const person = async () => {
    const user = await human.verify(req.headers.get(HUMAN_HEADER) ?? "");
    if (!user) throw new HttpError(401, "sign in first", "SignInRequired");
    return user;
  };
  const signedBy = async (pk: string) => {
    const who = await verifyRequest((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""), MACHINE_SCOPE, method, path, body);
    if (who !== pk) throw new HttpError(401, "not signed by this computer's key");
  };

  // A computer asks to be linked: it proves it holds its key, and names itself.
  if (path === "/v1/machines" && method === "POST") {
    let b: { pk?: unknown; label?: unknown; ts?: unknown; sig?: unknown };
    try {
      b = JSON.parse(body);
    } catch {
      throw new HttpError(400, "bad json");
    }
    if (!fits(SignedByMachine, b) || !(await verify(b))) throw new HttpError(400, "bad signature");
    if (Math.abs(Date.now() - b.ts) > 5 * 60_000) throw new HttpError(400, "clock is off by more than 5 minutes");
    const prior = await current(store, b.pk);
    if (prior?.user) return Response.json({ status: "linked" });
    if (gate && !(await gate.allow(gate.ip))) throw new HttpError(429, "too many computer registrations; try again in a few minutes");
    await store.put({ pk: b.pk, label: inlineText(b.label, 60) || "A computer", user: null, created: prior?.created ?? Date.now() });
    return Response.json({ status: "pending", code: await machineCode(b.pk) });
  }

  const one = /^\/v1\/machines\/([A-Za-z0-9_-]{20,})(\/public|\/confirm)?$/.exec(path);
  if (one) {
    const pk = one[1]!;
    const rec = await current(store, pk);
    const fresh = rec && (rec.user || Date.now() - rec.created < LINK_TTL_MS);
    // What the confirm page shows. Nothing secret: the label the computer gave itself.
    if (one[2] === "/public" && method === "GET") {
      if (!fresh) throw new HttpError(404, "this link expired; run kiwi setup again");
      return Response.json({ label: rec!.label, status: rec!.user ? "linked" : "pending", code: await machineCode(pk), created: rec!.created });
    }
    // The person confirms: this computer is mine.
    if (one[2] === "/confirm" && method === "POST") {
      const user = await person();
      if (!fresh) throw new HttpError(404, "this link expired; run kiwi setup again");
      if (rec!.user && rec!.user !== user) throw new HttpError(409, "this computer is already linked to someone else");
      await store.put({ ...rec!, user, linked: Date.now() });
      return Response.json({ status: "linked", label: rec!.label });
    }
    // The computer checks on its link, or unlinks itself.
    if (!one[2] && method === "GET") {
      await signedBy(pk);
      if (!fresh) return Response.json({ status: "expired" });
      if (rec!.user) await markUsed(store, rec!);
      const name = rec!.user ? ((await human.profile?.(rec!.user).catch(() => null))?.name ?? null) : null;
      return Response.json({ status: rec!.user ? "linked" : "pending", name });
    }
    if (!one[2] && method === "DELETE") {
      await signedBy(pk);
      if (rec) await store.remove(rec);
      return Response.json({ removed: true });
    }
  }

  // A person's computers, and removing one from the web.
  if (path === "/v1/me/machines" && method === "GET") {
    // The list holds labels only; each computer's own record knows when it was last used (a person has a handful).
    const user = await person();
    const records = await Promise.all((await store.listFor(user)).map((m) => current(store, m.pk)));
    const machines = records
      .filter((r): r is MachineRecord => r?.user === user)
      .map((r) => ({ pk: r.pk, label: r.label, linked: r.linked ?? r.created, used: r.used ?? null, expires: lastUsed(r) + UNUSED_LINK_TTL_MS }));
    return Response.json({ machines });
  }
  const mine = /^\/v1\/me\/machines\/([A-Za-z0-9_-]{20,})$/.exec(path);
  if (mine && method === "DELETE") {
    const user = await person();
    const rec = await store.get(mine[1]!);
    if (!rec || rec.user !== user) throw new HttpError(404, "not one of your computers");
    await store.remove(rec);
    return Response.json({ removed: true });
  }
  throw new HttpError(404, "not found");
}
