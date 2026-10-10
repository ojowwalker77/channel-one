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
import { verifyRequest } from "../auth.ts";
import { ownerFingerprint } from "../crypto.ts";
import { PAGE_LIMIT } from "../protocol.ts";
import { answer, attempt, describeRoutes, dispatch, incoming, json, refuse, Request_, type Refused, type Route } from "./http.ts";
import { HUMAN_HEADER, type HumanAuth } from "./human.ts";
import { betaMessage, inBeta, OPEN_POLICY, type RelayPolicy } from "./policy.ts";
import {
  allow,
  frame,
  errorResponse,
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

// ---------- the checks a route can ask for ----------

/**
 * The checks. Only GET /info is public; every other row names one of these, so
 * test/route-table.test.ts and the auth table can see what each route needs.
 */
type Guard = "public" | "creator" | "joiner" | "ownerPerson" | "requester" | "member" | "owner";

/** Who a check found: the key that signed, the signed-in person, the vouching person. */
interface Who {
  me: string;
  signer: string | null;
  user: string | null;
  person: { user: string; name: string } | null;
  vouchUser: string | null;
}
const nobody: Who = { me: "", signer: null, user: null, person: null, vouchUser: null };

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

/** Creating a channel: the creator's signature (the room checks it is the owner key's) and, on sign-in relays, a session. */
const creator = Effect.gen(function* () {
  const store = yield* Room;
  const { req, method, path, url, body } = yield* Request_;
  const signer = yield* Effect.promise(() => verifyRequest(requestToken(req), store.roomId, method, path + url.search, body));
  const user = yield* signedIn;
  return { ...nobody, signer, user };
});

/** Asking to join: on a sign-in relay, a person's session or the vouch of a computer its person linked. */
const joiner = Effect.gen(function* () {
  const { human, vouch } = yield* Relay;
  const b = yield* json<{ pk?: unknown; machine?: unknown }>();
  const who = yield* person;
  const vouchUser = !who && vouch && typeof b?.pk === "string" ? yield* Effect.promise(() => vouch(b.pk as string, b.machine)) : null;
  if (human && !who && !vouchUser) return yield* refuse(403, "this computer isn't set up: its person runs `kiwi setup` once, then agents can join from it");
  return { ...nobody, person: who, vouchUser };
});

/** The person who owns this channel, signed in (its usage page). */
const ownerPerson = Effect.gen(function* () {
  const store = yield* Room;
  const user = yield* signedIn;
  if (!user || user !== store.ownerUser()) return yield* refuse(403, "only the person who owns this channel can see its usage");
  return { ...nobody, user };
});

const asKey = <E, R>(check: Effect.Effect<string, E, R>) => Effect.map(check, (me): Who => ({ ...nobody, me }));

const guards: Record<Guard, Effect.Effect<Who, Refused, Room | Relay | Request_>> = {
  public: Effect.succeed(nobody),
  creator,
  joiner,
  ownerPerson,
  requester: asKey(requester),
  member: asKey(member),
  owner: asKey(owner),
};

// ---------- the routes ----------

type RoomRoute = Route<Guard, Who, Effects, Room | Relay | Request_>;

const ID = "([0-9a-f-]{36})";

/** A handler that only reads the room. */
const withRoom = <A>(f: (store: RoomStore) => A) =>
  Effect.gen(function* () {
    return f(yield* Room);
  });

const routes: RoomRoute[] = [
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
        return { data: { ownerPk: m.ownerPk, ownerXpk: m.ownerXpk, ownerSig: m.ownerSig, titlesSig: store.getTitlesSig(), epoch: m.epoch, rotate: m.rotate, title: store.title(), settings: store.settings(), ownerName, iconAt: store.iconAt() } };
      }),
  },
  {
    method: "POST",
    path: "/create",
    guard: "creator",
    run: ({ signer, user }) =>
      Effect.gen(function* () {
        const store = yield* Room;
        const { human, policy, ownedChannels } = yield* Relay;
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
    guard: "joiner",
    run: ({ person: who, vouchUser }) =>
      Effect.gen(function* () {
        const store = yield* Room;
        const b = yield* json<RequestBody & { machine?: unknown }>();
        const { id, fresh } = yield* attempt(() => store.request(b, who, vouchUser));
        return { data: { id }, fx: fresh ? { broadcast: [frame({ t: "request" })] } : undefined };
      }),
  },
  {
    method: "GET",
    path: "/usage",
    guard: "ownerPerson",
    run: () => withRoom((store) => ({ data: store.usage() })),
  },
  {
    method: "POST",
    path: new RegExp(`^/requests/${ID}/reveal$`),
    guard: "requester", // the joiner reveals its half of the code, signed by the key that's asking
    run: ({ me: pk }, m) =>
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
    run: ({ me: pk }, m) => Effect.gen(function* () {
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
    run: ({ me }) =>
      Effect.gen(function* () {
        const store = yield* Room;
        if (!allow(`${store.roomId}:${me}`, MESSAGES_PER_MINUTE)) return yield* refuse(429, "too many messages; wait a minute");
        const b = yield* json<{ iv?: string; ct?: string; e?: number }>();
        const e = yield* attempt(() => store.append(b.iv as string, b.ct as string, Number(b.e ?? 0), me));
        return { data: { seq: e.seq, ts: e.ts }, fx: { broadcast: [msgFrame(e)], expireAt: store.touch() ?? undefined } };
      }),
  },
  { method: "GET", path: "/keys", guard: "member", run: ({ me }) => withRoom((store) => ({ data: store.keysFor(me) })) },
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
  {
    method: "PUT",
    path: "/settings",
    guard: "owner",
    run: () =>
      Effect.gen(function* () {
        const store = yield* Room;
        const { settings } = yield* json<{ settings?: unknown }>();
        yield* attempt(() => store.setSettings(settings));
        return { data: { ok: true }, fx: { broadcast: [frame({ t: "info" })] } };
      }),
  },
  { method: "GET", path: "/members", guard: "member", run: () => withRoom((store) => ({ data: { members: store.members() } })) },
  {
    method: "DELETE",
    path: "/members/me",
    guard: "member",
    run: ({ me }) =>
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
    method: "PUT",
    path: /^\/members\/([A-Za-z0-9_-]{20,})\/record$/,
    guard: "owner",
    run: (_, m) =>
      Effect.gen(function* () {
        const store = yield* Room;
        const b = yield* json<{ rec?: unknown; e?: unknown; post?: unknown }>();
        if (typeof b.rec !== "string" || typeof b.e !== "number" || typeof b.post !== "boolean") return yield* refuse(400, "send the sealed record, its epoch, and whether they may post");
        yield* attempt(() => store.setRecord(m[1]!, b.rec as string, b.e as number, b.post as boolean));
        // Everyone re-reads the roster, so the new record (and what it lets them do) lands at once.
        return { data: { ok: true }, fx: { broadcast: [frame({ t: "roster" })] } };
      }),
  },
  {
    method: "PUT",
    path: /^\/members\/([A-Za-z0-9_-]{20,})\/post$/,
    guard: "owner",
    run: (_, m) =>
      Effect.gen(function* () {
        const store = yield* Room;
        const b = yield* json<{ post?: unknown }>();
        if (typeof b.post !== "boolean") return yield* refuse(400, "say whether they may post");
        yield* attempt(() => store.setCanPost(m[1]!, b.post as boolean));
        return { data: { post: b.post } };
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
export const routeTable = describeRoutes(routes);

// The whole request handling, built once: each request only supplies its context.
// An unknown path still asks for a member first, as it always has.
const program = answer(dispatch(routes, guards, Effect.flatMap(member, () => refuse(404, "not found"))));

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
  const relay: Required<RelayContext> = { human: ctx.human ?? null, vouch: ctx.vouch ?? null, policy: ctx.policy ?? OPEN_POLICY, ownedChannels: ctx.ownedChannels ?? (async () => 0) };

  // One context for this request, handed to the runtime as is (cheaper than layering three provides).
  const context = Context.make(Room, store).pipe(Context.add(Relay, relay), Context.add(Request_, await incoming(req, path)));
  // Anything else (a bug, a storage error) propagates, and the adapter answers 500 as before.
  return Effect.runPromiseWith(context)(program);
}
