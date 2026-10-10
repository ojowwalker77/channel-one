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

const registrations = new Map<string, number[]>();

/** False once this address has registered REGISTRATIONS_PER_WINDOW computers in the last 10 minutes. */
export function registrationAllowed(ip: string, now = Date.now()): boolean {
  const kept = (registrations.get(ip) ?? []).filter((t) => now - t < REGISTER_WINDOW_MS);
  if (kept.length >= REGISTRATIONS_PER_WINDOW) {
    registrations.set(ip, kept);
    return false;
  }
  if (registrations.size > 10_000) registrations.clear();
  kept.push(now);
  registrations.set(ip, kept);
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

/** The address a registration counts against. Bun passes the peer; the Worker leaves it unset and Cloudflare's header is used. A missing address is not limited (local tests). */
function callerIp(req: Request, peer?: string | null): string | null {
  if (peer) return peer;
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  return cf ? cf.slice(0, 80) : null;
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
export async function onMachineHttp(req: Request, store: MachineStore, human: HumanAuth | null, peer?: string | null): Promise<Response | null> {
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
    const ip = callerIp(req, peer);
    if (ip && !registrationAllowed(ip)) throw new HttpError(429, "too many computer registrations; try again in a few minutes");
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
