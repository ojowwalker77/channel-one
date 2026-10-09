// A room's HTTP API on Effect: one table of routes, each declaring the check it
// needs (public, a request signature, a member, the owner), and one dispatcher
// that runs the check before the handler. A route can't forget its owner()
// check: it's in the table, and test/auth-table.test.ts asserts every row.
//
// Shared by the Cloudflare and Bun relays, which provide the room and the
// relay's settings and apply the returned effects (fan-out, disconnects, wipes).
// Statuses, texts and tags are exactly what they were (test/error-texts.test.ts).

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { verifyRequest } from "../auth.ts";
import { ownerFingerprint } from "../crypto.ts";
import { tagForStatus, type ErrorTag } from "../errors.ts";
import { PAGE_LIMIT } from "../protocol.ts";
import { HUMAN_HEADER, type HumanAuth } from "./human.ts";
import { betaMessage, inBeta, OPEN_POLICY, type RelayPolicy } from "./policy.ts";
import {
  allow,
  frame,
  errorResponse,
  HttpError,
  MESSAGES_PER_MINUTE,
  msgFrame,
  requestToken,
  requireInfoFingerprint,
  UPDATE_KIWI,
  type CreateBody,
  type Effects,
  type MemberBody,
  type RequestBody,
  type RoomStore,
} from "./room.ts";

// ---------- what a request can fail with ----------

/** A refusal, with the status, text and tag the client gets. */
export class Refused extends Schema.TaggedError<Refused>()("Refused", {
  status: Schema.Number,
  message: Schema.String,
  tag: Schema.String,
}) {}

export const refuse = (status: number, message: string, tag?: ErrorTag) => Effect.fail(new Refused({ status, message, tag: tag ?? tagForStatus(status) }));

/** Run room logic that throws HttpError (RoomStore's methods are plain): its refusals become Refused; anything else is a defect (a 500). */
const attempt = <A>(f: () => A | Promise<A>): Effect.Effect<A, Refused> =>
  Effect.tryPromise({
    try: async () => f(),
    catch: (err) => (err instanceof HttpError ? new Refused({ status: err.status, message: err.message, tag: err.tag }) : (err as Refused)),
  }).pipe(Effect.catch((e) => (e instanceof Refused ? Effect.fail(e) : Effect.die(e))));

// ---------- services ----------

/** The room this request is for. */
export class Room extends Context.Service<Room, RoomStore>()("kiwi/relay/Room") {}

/** What the relay is configured with: sign-in, vouching, quotas. */
export interface RelayContext {
  human?: HumanAuth | null;
  /** Who vouches for an agent key, from its computer's signature (see machines.ts). */
  vouch?: ((agentPk: string, machine: unknown) => Promise<string | null>) | null;
  policy?: RelayPolicy;
  /** How many channels a signed-in person owns now (from the adapter's per-person lists). */
  ownedChannels?: (user: string) => Promise<number>;
}
export class Relay extends Context.Service<Relay, Required<RelayContext>>()("kiwi/relay/Relay") {}

/** The request, read once. */
interface Incoming {
  req: Request;
  url: URL;
  method: string;
  path: string;
  body: string;
}
export class Request_ extends Context.Service<Request_, Incoming>()("kiwi/relay/Request") {}

// ---------- the checks a route can ask for ----------

type Guard = "public" | "requester" | "member" | "owner";

/** The request body as JSON, or the 400 every route has always sent. */
const json = <T>() =>
  Effect.gen(function* () {
    const { body } = yield* Request_;
    return yield* Effect.try({ try: () => JSON.parse(body) as T, catch: () => new Refused({ status: 400, message: "bad json", tag: "BadRequest" }) });
  });

/** The signed-in person behind this request, when the relay requires sign-in. */
const signedIn = Effect.gen(function* () {
  const { human } = yield* Relay;
  const { req } = yield* Request_;
  if (!human) return null;
  const user = yield* Effect.promise(() => human.verify(req.headers.get(HUMAN_HEADER) ?? ""));
  if (!user) return yield* refuse(401, "sign in required: channels on this relay are owned and run by a signed-in human (use the dashboard)", "SignInRequired");
  return user;
});

/** The signed-in person behind a request, with their name as WorkOS knows it (null when none came). */
const person = Effect.gen(function* () {
  const { human } = yield* Relay;
  const { req } = yield* Request_;
  if (!human) return null;
  const token = req.headers.get(HUMAN_HEADER);
  if (!token) return null;
  const user = yield* Effect.promise(() => human.verify(token));
  if (!user) return yield* refuse(401, "sign in again: that session isn't valid", "SignInRequired");
  const profile = yield* Effect.promise(async () => (await human.profile?.(user).catch(() => null)) ?? null);
  return { user, name: profile?.name ?? user };
});

/** The key that signed this request (for requesters, who aren't members yet). */
const requester = Effect.gen(function* () {
  const store = yield* Room;
  const { req, method, path, url, body } = yield* Request_;
  const pk = yield* Effect.promise(() => verifyRequest(requestToken(req), store.roomId, method, path + url.search, body));
  if (!pk) return yield* refuse(401, "bad or expired signature");
  return pk;
});

/** The member key that signed this request. */
const member = Effect.gen(function* () {
  const store = yield* Room;
  const { req, method, path, url, body } = yield* Request_;
  return yield* attempt(() => store.authenticate(req, method, path + url.search, body));
});

/**
 * The owner: the owner key's signature and, on relays that require sign-in, the
 * owning person's live session. A copied key file alone can't approve anyone.
 */
const owner = Effect.gen(function* () {
  const store = yield* Room;
  const { human } = yield* Relay;
  const me = yield* member;
  if (me !== store.meta().ownerPk) return yield* refuse(403, "only the channel owner can do that", "NotOwner");
  const want = store.ownerUser();
  if (human && want) {
    const user = yield* signedIn;
    if (user !== want) return yield* refuse(403, "only the human who owns this channel can do that", "NotOwner");
  }
  return me;
});

const guards: Record<Guard, Effect.Effect<string | null, Refused, Room | Relay | Request_>> = {
  public: Effect.succeed(null),
  requester,
  member,
  owner,
};

// ---------- the routes ----------

type Reply = { data: unknown; fx?: Effects } | { res: Response; fx?: Effects };
type Handler = (me: string, match: RegExpExecArray) => Effect.Effect<Reply, Refused, Room | Relay | Request_>;
interface Route {
  method: string;
  path: string | RegExp;
  guard: Guard;
  run: Handler;
}

const ID = "([0-9a-f-]{36})";

/** A handler that only reads the room. */
const withRoom = <A>(f: (store: RoomStore) => A) =>
  Effect.gen(function* () {
    return f(yield* Room);
  });

const routes: Route[] = [
  {
    method: "GET",
    path: "/info",
    guard: "public",
    run: () =>
      Effect.gen(function* () {
        const store = yield* Room;
        const { human } = yield* Relay;
        const { url } = yield* Request_;
        const m = store.meta();
        // The join code's second half is the owner key's fingerprint. A wrong one is answered like a
        // missing room. Requests with no fp never reach here (requireInfoFingerprint).
        if (url.searchParams.get("fp") !== (yield* Effect.promise(() => ownerFingerprint(m.ownerPk)))) return yield* refuse(404, "no such channel", "ChannelGone");
        // Who invited you, as sign-in knows them: only for someone holding the code.
        const ownerUser = store.ownerUser();
        const ownerName = ownerUser && human?.profile ? ((yield* Effect.promise(async () => (await human.profile!(ownerUser).catch(() => null))?.name ?? null)) ?? null) : null;
        return { data: { ownerPk: m.ownerPk, ownerXpk: m.ownerXpk, ownerSig: m.ownerSig, titlesSig: store.getTitlesSig(), epoch: m.epoch, rotate: m.rotate, title: store.title(), ownerName, iconAt: store.iconAt() } };
      }),
  },
  {
    method: "POST",
    path: "/create",
    guard: "public", // checks its own signature: the creator isn't a member until this succeeds
    run: () =>
      Effect.gen(function* () {
        const store = yield* Room;
        const { human, policy, ownedChannels } = yield* Relay;
        const { req, method, path, url, body } = yield* Request_;
        const signer = yield* Effect.promise(() => verifyRequest(requestToken(req), store.roomId, method, path + url.search, body));
        const user = yield* signedIn;
        // During a private beta only listed people create channels; anyone may still join one.
        if (user && !(yield* Effect.promise(() => inBeta(policy, user, human)))) return yield* refuse(403, betaMessage(policy));
        const most = policy.channelsPerOwner;
        if (user && most && (yield* Effect.promise(() => ownedChannels(user))) >= most) {
          return yield* refuse(429, `you own ${most} channels, the most this relay allows per person; close one to create another`);
        }
        const b = yield* json<CreateBody>();
        yield* attempt(() => store.create(signer, b, user));
        const directory = user ? yield* attempt(() => store.directory()) : undefined;
        return { data: { head: 0 }, fx: { ...(directory ? { directory } : {}), expireAt: store.touch() ?? undefined } };
      }),
  },
  {
    method: "POST",
    path: "/requests",
    guard: "public", // a join request: a person's session or a linked computer's vouch, checked here
    run: () =>
      Effect.gen(function* () {
        const store = yield* Room;
        const { human, vouch } = yield* Relay;
        const b = yield* json<RequestBody & { machine?: unknown }>();
        const who = yield* person;
        const vouchUser = !who && vouch && typeof b?.pk === "string" ? yield* Effect.promise(() => vouch(b.pk, b.machine)) : null;
        // On a relay with sign-in, every agent arrives vouched for by its person's linked computer.
        if (human && !who && !vouchUser) return yield* refuse(403, "this computer isn't set up: its person runs `kiwi setup` once, then agents can join from it");
        const { id, fresh } = yield* attempt(() => store.request(b, who, vouchUser));
        return { data: { id }, fx: fresh ? { broadcast: [frame({ t: "request" })] } : undefined };
      }),
  },
  {
    method: "GET",
    path: "/usage",
    guard: "public", // the owning person's session, checked here
    run: () =>
      Effect.gen(function* () {
        const store = yield* Room;
        const user = yield* signedIn;
        if (!user || user !== store.ownerUser()) return yield* refuse(403, "only the person who owns this channel can see its usage");
        return { data: store.usage() };
      }),
  },
  {
    method: "POST",
    path: new RegExp(`^/requests/${ID}/reveal$`),
    guard: "requester", // the joiner reveals its half of the code, signed by the key that's asking
    run: (pk, m) =>
      Effect.gen(function* () {
        const store = yield* Room;
        const { nonce } = yield* json<{ nonce?: unknown }>();
        const fresh = yield* attempt(() => store.reveal(m[1]!, pk, nonce));
        return { data: { revealed: true }, fx: fresh ? { broadcast: [frame({ t: "request" })] } : undefined };
      }),
  },
  {
    method: "GET",
    path: new RegExp(`^/requests/${ID}$`),
    guard: "requester", // signed by the requester's key, which isn't a member yet
    run: (pk, m) => Effect.gen(function* () {
      const store = yield* Room;
      return { data: yield* attempt(() => store.requestStatus(m[1]!, pk)) };
    }),
  },
  { method: "GET", path: "/", guard: "member", run: () => withRoom((store) => ({ data: { head: store.head() } })) },
  {
    method: "GET",
    path: "/messages",
    guard: "member",
    run: () =>
      Effect.gen(function* () {
        const store = yield* Room;
        const { url } = yield* Request_;
        const since = Number(url.searchParams.get("since") ?? 0) || 0;
        const limit = Number(url.searchParams.get("limit") ?? PAGE_LIMIT) || PAGE_LIMIT;
        return { data: { head: store.head(), messages: store.since(since, limit) } };
      }),
  },
  {
    method: "POST",
    path: "/messages",
    guard: "member",
    run: (me) =>
      Effect.gen(function* () {
        const store = yield* Room;
        if (!allow(`${store.roomId}:${me}`, MESSAGES_PER_MINUTE)) return yield* refuse(429, "too many messages; wait a minute");
        const b = yield* json<{ iv?: string; ct?: string; e?: number }>();
        const e = yield* attempt(() => store.append(b.iv as string, b.ct as string, Number(b.e ?? 0)));
        return { data: { seq: e.seq, ts: e.ts }, fx: { broadcast: [msgFrame(e)], expireAt: store.touch() ?? undefined } };
      }),
  },
  { method: "GET", path: "/keys", guard: "member", run: (me) => withRoom((store) => ({ data: store.keysFor(me) })) },
  { method: "GET", path: "/icon", guard: "member", run: () => withRoom((store) => ({ data: { icon: store.icon(), at: store.iconAt() } })) },
  {
    method: "PUT",
    path: "/icon",
    guard: "owner",
    run: () =>
      Effect.gen(function* () {
        const store = yield* Room;
        const { icon } = yield* json<{ icon?: unknown }>();
        const at = yield* attempt(() => store.setIcon(icon ?? null));
        return { data: { at }, fx: { broadcast: [frame({ t: "info" })] } };
      }),
  },
  {
    method: "PUT",
    path: "/title",
    guard: "owner",
    run: () =>
      Effect.gen(function* () {
        const store = yield* Room;
        const { title } = yield* json<{ title?: unknown }>();
        yield* attempt(() => store.setTitle(title));
        return { data: { ok: true }, fx: { broadcast: [frame({ t: "info" })] } };
      }),
  },
  { method: "GET", path: "/members", guard: "member", run: () => withRoom((store) => ({ data: { members: store.members() } })) },
  {
    method: "DELETE",
    path: "/members/me",
    guard: "member",
    run: (me) =>
      Effect.gen(function* () {
        const store = yield* Room;
        yield* attempt(() => store.remove(me));
        const directory = yield* attempt(() => store.directory());
        return { data: { left: true }, fx: { disconnect: me, broadcast: [frame({ t: "roster" })], directory } };
      }),
  },
  {
    method: "GET",
    path: "/requests",
    guard: "member", // owner, after the version check: clients from before the join check get told to update
    run: () =>
      Effect.gen(function* () {
        const store = yield* Room;
        const { human } = yield* Relay;
        const { url } = yield* Request_;
        if (url.searchParams.get("v") !== "2") return yield* refuse(426, UPDATE_KIWI);
        yield* owner;
        // Names and emails come from sign-in at read time, for the owner only; the relay doesn't keep them.
        const requests = yield* Effect.promise(() =>
          Promise.all(
            store.pendingRequests().map(async (r) => {
              const p = r.sponsorUser ? ((await human?.profile?.(r.sponsorUser).catch(() => null)) ?? null) : null;
              return { ...r, sponsorName: p?.name ?? r.sponsorName ?? r.sponsorUser, sponsorEmail: p?.email ?? null };
            }),
          ),
        );
        return { data: { requests } };
      }),
  },
  {
    method: "POST",
    path: new RegExp(`^/requests/${ID}/nonce$`),
    guard: "owner",
    run: (_, m) =>
      Effect.gen(function* () {
        const store = yield* Room;
        const { nonce } = yield* json<{ nonce?: unknown }>();
        yield* attempt(() => store.setOwnerNonce(m[1]!, nonce));
        return { data: { set: true } };
      }),
  },
  {
    method: "POST",
    path: new RegExp(`^/requests/${ID}/deny$`),
    guard: "owner",
    run: (_, m) =>
      Effect.gen(function* () {
        const store = yield* Room;
        yield* attempt(() => store.deny(m[1]!));
        return { data: { denied: true } };
      }),
  },
  {
    method: "POST",
    path: "/members",
    guard: "owner",
    run: () =>
      Effect.gen(function* () {
        const store = yield* Room;
        const { human } = yield* Relay;
        const b = yield* json<MemberBody & { request?: string; replaces?: string }>();
        yield* attempt(() => {
          store.requireChecked(b.request, b.pk);
          if (human && store.ownerUser()) store.requireSponsor(b.request, b.pk);
          store.approve(b);
        });
        const directory = yield* attempt(() => store.directory());
        // A reclaimed seat's old key is cut off at once, like a removed member.
        return { data: { approved: true }, fx: { ...(b.replaces ? { disconnect: b.replaces } : {}), broadcast: [frame({ t: "roster" })], directory } };
      }),
  },
  {
    method: "DELETE",
    path: /^\/members\/([A-Za-z0-9_-]{20,})$/,
    guard: "owner",
    run: (_, m) =>
      Effect.gen(function* () {
        const store = yield* Room;
        yield* attempt(() => store.remove(m[1]!));
        const directory = yield* attempt(() => store.directory());
        return { data: { removed: true }, fx: { disconnect: m[1]!, broadcast: [frame({ t: "roster" })], directory } };
      }),
  },
  {
    method: "POST",
    path: "/epochs",
    guard: "owner",
    run: () =>
      Effect.gen(function* () {
        const store = yield* Room;
        const b = yield* json<{ epoch: number; keys: Record<string, string> }>();
        yield* attempt(() => store.rotate(b.epoch, b.keys));
        return { data: { epoch: b.epoch }, fx: { broadcast: [frame({ t: "epoch", epoch: b.epoch })] } };
      }),
  },
  {
    method: "DELETE",
    path: "/",
    guard: "owner",
    run: () => withRoom((store) => ({ data: { closed: true }, fx: { directory: store.unlinkAll(), wipe: true } })),
  },
];

/** The table, for tests that check every route declares a guard. */
export const routeTable = routes.map(({ method, path, guard }) => ({ method, path: String(path), guard }));

// ---------- the dispatcher ----------

const match = (r: Route, method: string, path: string): RegExpExecArray | null => {
  if (r.method !== method) return null;
  if (typeof r.path === "string") return r.path === path ? /^.*$/s.exec(path) : null;
  return r.path.exec(path);
};

/** Find the route, run its check, then its handler. An unknown path still asks for a member first, as it always has. */
const dispatch = Effect.gen(function* () {
  const { method, path } = yield* Request_;
  for (const r of routes) {
    const m = match(r, method, path);
    if (!m) continue;
    const me = yield* guards[r.guard];
    return yield* r.run(me ?? "", m);
  }
  yield* member;
  return yield* refuse(404, "not found");
});

const respond = (reply: Reply): { res: Response; fx?: Effects } => ("res" in reply ? reply : { res: Response.json(reply.data), fx: reply.fx });

/** Handle one HTTP request to a room. Adapters apply `fx`. */
export async function onHttp(store: RoomStore, req: Request, path: string, ctx: RelayContext = {}): Promise<{ res: Response; fx?: Effects }> {
  // Missing fingerprint: 426 before this reads or wipes the room. The adapters also refuse
  // before they open the room at all.
  try {
    requireInfoFingerprint(req.method, path, new URL(req.url));
  } catch (err) {
    return { res: errorResponse(err) };
  }
  // Shared-code rooms from before owners existed: delete them outright the first time anything touches them.
  if (store.isLegacy()) return { res: Response.json({ error: "no such channel", tag: "ChannelGone" }, { status: 404 }), fx: { wipe: true } };
  const method = req.method.toUpperCase();
  const incoming: Incoming = { req, url: new URL(req.url), method, path, body: method === "GET" || method === "DELETE" ? "" : await req.text() };
  const relay: Required<RelayContext> = { human: ctx.human ?? null, vouch: ctx.vouch ?? null, policy: ctx.policy ?? OPEN_POLICY, ownedChannels: ctx.ownedChannels ?? (async () => 0) };
  const program = dispatch.pipe(
    Effect.map(respond),
    // A refusal is an answer, not a failure: its status, text and tag go back as they always have.
    Effect.catchTag("Refused", (r) => Effect.succeed({ res: Response.json({ error: r.message, tag: r.tag }, { status: r.status }) })),
    Effect.provideService(Room, store),
    Effect.provideService(Relay, relay),
    Effect.provideService(Request_, incoming),
  );
  // Anything else (a bug, a storage error) propagates, and the adapter answers 500 as before.
  return Effect.runPromise(program);
}
