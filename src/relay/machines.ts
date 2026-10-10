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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { attempt, describeRoutes, json, refuse, Request_, servePerson, SignIn, signedInPerson, type Refused, type Route } from "./http.ts";
import type { HumanAuth } from "./human.ts";
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
 * proxy: then only the very last X-Forwarded-For entry, which is the one the proxy
 * added. Everything before it was supplied by the client. If that last entry is not
 * an address, count the peer instead of scanning backward. Loopback is trusted when
 * trust is on. A list also trusts those addresses and CIDRs (Docker's bridge is not
 * loopback). Any other peer ignores the header.
 */
export function registrationAddress(peer: string | null | undefined, forwardedFor: string | null | undefined, trustProxy: TrustProxy = false): string | null {
  const peerIp = peer ? usableIp(peer) : null;
  if (!peerIp || !proxyPeer(peerIp, trustProxy)) return peerIp;
  const parts = (forwardedFor ?? "").split(",");
  const last = usableIp(parts[parts.length - 1] ?? "");
  return last ?? peerIp;
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

// ---------- the routes ----------

class Computers extends Context.Service<Computers, MachineStore>()("kiwi/relay/Computers") {}
/** Whether this address may register another computer (null: not limited here). */
class Registrations extends Context.Service<Registrations, RegistrationGate | null>()("kiwi/relay/Registrations") {}

/**
 * The checks: a computer registering proves it holds its key by signing its
 * request ("selfSigned"); a computer checking or dropping its link signs with
 * that key ("computer"); its person confirms or lists while signed in
 * ("person"); the confirm page shows a pending link's label and code to whoever
 * has the link ("public": nothing secret). All of them need this relay to have sign-in.
 */
type MachineGuard = "public" | "selfSigned" | "computer" | "person";
interface Who {
  user: string | null;
  registering: { pk: string; label: unknown; ts: number } | null;
}
type MachineRoute = Route<MachineGuard, Who, never, Computers | Registrations | SignIn | Request_>;

const NO_SIGN_IN = "this relay has no sign-in, so computers can't be linked";

const hasSignIn = Effect.gen(function* () {
  const { human } = yield* SignIn;
  if (!human) return yield* refuse(404, NO_SIGN_IN);
  return human;
});

const nobody: Who = { user: null, registering: null };

const guards: Record<MachineGuard, Effect.Effect<Who, Refused, SignIn | Request_>> = {
  public: Effect.map(hasSignIn, () => nobody),
  selfSigned: Effect.gen(function* () {
    yield* hasSignIn;
    const b = yield* json<{ pk?: unknown; label?: unknown; ts?: unknown; sig?: unknown }>();
    if (!fits(SignedByMachine, b) || !(yield* Effect.promise(() => verify(b)))) return yield* refuse(400, "bad signature");
    if (Math.abs(Date.now() - b.ts) > 5 * 60_000) return yield* refuse(400, "clock is off by more than 5 minutes");
    return { ...nobody, registering: { pk: b.pk, label: b.label, ts: b.ts } };
  }),
  computer: Effect.gen(function* () {
    yield* hasSignIn;
    const { req, method, path, body } = yield* Request_;
    const pk = /^\/v1\/machines\/([A-Za-z0-9_-]{20,})$/.exec(path)?.[1];
    const who = yield* Effect.promise(() => verifyRequest((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""), MACHINE_SCOPE, method, path, body));
    if (!pk || who !== pk) return yield* refuse(401, "not signed by this computer's key");
    return nobody;
  }),
  person: Effect.map(signedInPerson(NO_SIGN_IN), (user) => ({ ...nobody, user })),
};

const PK = "([A-Za-z0-9_-]{20,})";

/** A computer's record, and whether its link is still good (linked, or pending and not expired). */
const linkOf = (pk: string) =>
  Effect.gen(function* () {
    const store = yield* Computers;
    const rec = yield* attempt(() => current(store, pk));
    return { rec, fresh: !!rec && (!!rec.user || Date.now() - rec.created < LINK_TTL_MS) };
  });

const routes: MachineRoute[] = [
  {
    // A computer asks to be linked: it proves it holds its key, and names itself.
    method: "POST",
    path: "/v1/machines",
    guard: "selfSigned",
    run: ({ registering }) =>
      Effect.gen(function* () {
        const store = yield* Computers;
        const b = registering!;
        const prior = yield* attempt(() => current(store, b.pk));
        if (prior?.user) return { data: { status: "linked" } };
        const gate = yield* Registrations;
        if (gate && !(yield* Effect.promise(async () => gate.allow(gate.ip)))) return yield* refuse(429, "too many computer registrations; try again in a few minutes");
        yield* attempt(() => store.put({ pk: b.pk, label: inlineText(b.label, 60) || "A computer", user: null, created: prior?.created ?? Date.now() }));
        return { data: { status: "pending", code: yield* Effect.promise(() => machineCode(b.pk)) } };
      }),
  },
  {
    // What the confirm page shows. Nothing secret: the label the computer gave itself.
    method: "GET",
    path: new RegExp(`^/v1/machines/${PK}/public$`),
    guard: "public",
    run: (_, m) =>
      Effect.gen(function* () {
        const { rec, fresh } = yield* linkOf(m[1]!);
        if (!fresh) return yield* refuse(404, "this link expired; run kiwi setup again");
        return { data: { label: rec!.label, status: rec!.user ? "linked" : "pending", code: yield* Effect.promise(() => machineCode(m[1]!)), created: rec!.created } };
      }),
  },
  {
    // The person confirms: this computer is mine.
    method: "POST",
    path: new RegExp(`^/v1/machines/${PK}/confirm$`),
    guard: "person",
    run: ({ user }, m) =>
      Effect.gen(function* () {
        const store = yield* Computers;
        const { rec, fresh } = yield* linkOf(m[1]!);
        if (!fresh) return yield* refuse(404, "this link expired; run kiwi setup again");
        if (rec!.user && rec!.user !== user) return yield* refuse(409, "this computer is already linked to someone else");
        yield* attempt(() => store.put({ ...rec!, user: user!, linked: Date.now() }));
        return { data: { status: "linked", label: rec!.label } };
      }),
  },
  {
    // The computer checks on its link.
    method: "GET",
    path: new RegExp(`^/v1/machines/${PK}$`),
    guard: "computer",
    run: (_, m) =>
      Effect.gen(function* () {
        const store = yield* Computers;
        const { human } = yield* SignIn;
        const { rec, fresh } = yield* linkOf(m[1]!);
        if (!fresh) return { data: { status: "expired" } };
        if (rec!.user) yield* attempt(() => markUsed(store, rec!));
        const name = rec!.user ? ((yield* Effect.promise(async () => (await human?.profile?.(rec!.user!).catch(() => null))?.name ?? null)) ?? null) : null;
        return { data: { status: rec!.user ? "linked" : "pending", name } };
      }),
  },
  {
    // Or unlinks itself.
    method: "DELETE",
    path: new RegExp(`^/v1/machines/${PK}$`),
    guard: "computer",
    run: (_, m) =>
      Effect.gen(function* () {
        const store = yield* Computers;
        const { rec } = yield* linkOf(m[1]!);
        if (rec) yield* attempt(() => store.remove(rec));
        return { data: { removed: true } };
      }),
  },
  {
    // A person's computers. The list holds labels only; each computer's own record knows when it was last used.
    method: "GET",
    path: "/v1/me/machines",
    guard: "person",
    run: ({ user }) =>
      Effect.gen(function* () {
        const store = yield* Computers;
        const records = yield* attempt(async () => Promise.all((await store.listFor(user!)).map((m) => current(store, m.pk))));
        const machines = records
          .filter((r): r is MachineRecord => r?.user === user)
          .map((r) => ({ pk: r.pk, label: r.label, linked: r.linked ?? r.created, used: r.used ?? null, expires: lastUsed(r) + UNUSED_LINK_TTL_MS }));
        return { data: { machines } };
      }),
  },
  {
    // Removing one from the web.
    method: "DELETE",
    path: new RegExp(`^/v1/me/machines/${PK}$`),
    guard: "person",
    run: ({ user }, m) =>
      Effect.gen(function* () {
        const store = yield* Computers;
        const rec = yield* attempt(() => store.get(m[1]!));
        if (!rec || rec.user !== user) return yield* refuse(404, "not one of your computers");
        yield* attempt(() => store.remove(rec));
        return { data: { removed: true } };
      }),
  },
];

/** The computer-link rows, for the route-table test. */
export const machineRouteTable = describeRoutes(routes);

/** Routes under /v1/machines and /v1/me/machines; null when the path isn't one of them. */
export async function onMachineHttp(req: Request, store: MachineStore, human: HumanAuth | null, gate: RegistrationGate | null = null): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (!path.startsWith("/v1/machines") && !path.startsWith("/v1/me/machines")) return null;
  const otherwise = Effect.flatMap(hasSignIn, () => refuse(404, "not found"));
  return servePerson(req, routes, guards, otherwise, (e) => e.pipe(Effect.provideService(Computers, store), Effect.provideService(Registrations, gate)), { human, now: Date.now() });
}
