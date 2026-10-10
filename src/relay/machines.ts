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

/** How long a pending link waits for its person to confirm. */
const LINK_TTL_MS = 15 * 60_000;
/** A linked computer nobody used for this long stops vouching: a forgotten laptop shouldn't speak for you forever. */
export const UNUSED_LINK_TTL_MS = 30 * 86_400_000;
/** Recording use costs a storage write, so it's kept to the hour. */
const USE_PRECISION_MS = 3600_000;

const lastUsed = (rec: MachineRecord) => rec.used ?? rec.linked ?? rec.created;

/** The computer's record, unless its link went unused too long: then it's deleted, as if its person had removed it. */
async function current(store: MachineStore, pk: string): Promise<MachineRecord | null> {
  const rec = await store.get(pk);
  if (rec?.user && Date.now() - lastUsed(rec) > UNUSED_LINK_TTL_MS) {
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
type MachineRoute = Route<MachineGuard, Who, never, Computers | SignIn | Request_>;

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
        yield* attempt(() => store.put({ pk: b.pk, label: inlineText(b.label, 60) || "A computer", user: null, created: Date.now() }));
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
export async function onMachineHttp(req: Request, store: MachineStore, human: HumanAuth | null): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (!path.startsWith("/v1/machines") && !path.startsWith("/v1/me/machines")) return null;
  const otherwise = Effect.flatMap(hasSignIn, () => refuse(404, "not found"));
  return servePerson(req, routes, guards, otherwise, (e) => Effect.provideService(e, Computers, store), { human, now: Date.now() });
}
