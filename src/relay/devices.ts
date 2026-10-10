// Bringing a person's channels to another of their devices (a phone, a new
// browser) without the relay ever holding a key it can read.
//
//   device that has the channels                  relay                     new device
//   encrypts its keys with a fresh     ──►  ciphertext, under that   ◄──  camera opens the QR's
//   256-bit secret, uploads the box,        person, 10 minutes,           link, signs in as the
//   shows a QR of …/#device=<id>.<secret>   handed out once               same person, fetches the
//                                                                         box and decrypts it
//
// The secret lives only in the QR and the URL fragment, which browsers never
// send, so the relay can't open the box or swap in one of its own; and only the
// same signed-in person can fetch it.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { attempt, describeRoutes, json, refuse, Request_, servePerson, SignIn, signedInPerson, type Refused, type Route } from "./http.ts";
import type { HumanAuth } from "./human.ts";
import { fits, Present } from "./schema.ts";

export interface DeviceTransfer {
  id: string;
  /** AES-GCM ciphertext of the channels, under the secret in the QR. */
  box: string;
  created: number;
}

export interface DeviceStore {
  list(user: string): Promise<DeviceTransfer[]>;
  put(user: string, t: DeviceTransfer): Promise<void>;
  remove(user: string, id: string): Promise<void>;
}

/** How long a code stays good. */
export const TRANSFER_TTL_MS = 10 * 60_000;
/** Identities and keys, not messages: a few KB per channel. */
const MAX_BOX = 1024 * 1024;

// ---------- the routes ----------

class Handovers extends Context.Service<Handovers, DeviceStore>()("kiwi/relay/Handovers") {}

type DeviceGuard = "person";
type DeviceRoute = Route<DeviceGuard, string, never, Handovers | SignIn | Request_>;

/** This person's transfers still waiting; expired ones go as soon as anyone looks. */
const live = (user: string) =>
  Effect.gen(function* () {
    const store = yield* Handovers;
    const { now } = yield* SignIn;
    return yield* attempt(async () => {
      const out: DeviceTransfer[] = [];
      for (const t of await store.list(user)) {
        if (now - t.created > TRANSFER_TTL_MS) await store.remove(user, t.id);
        else out.push(t);
      }
      return out;
    });
  });

const ONE = /^\/v1\/me\/devices\/transfers\/([0-9a-f-]{36})$/;

/** The transfer `m` names, if it's still waiting. */
const waiting = (user: string, m: RegExpExecArray) => Effect.map(live(user), (all) => all.find((x) => x.id === m[1]));

const routes: DeviceRoute[] = [
  {
    method: "POST",
    path: "/v1/me/devices/transfers",
    guard: "person",
    run: (user) =>
      Effect.gen(function* () {
        const store = yield* Handovers;
        const { now } = yield* SignIn;
        const { box } = yield* json<{ box?: unknown }>();
        if (!fits(Present, box)) return yield* refuse(400, "missing box");
        if (box.length > MAX_BOX) return yield* refuse(413, "too much to hand over at once");
        // One code at a time: showing a new one retires the last.
        const t: DeviceTransfer = { id: crypto.randomUUID(), box, created: now };
        yield* attempt(async () => {
          for (const old of await store.list(user)) await store.remove(user, old.id);
          await store.put(user, t);
        });
        return { data: { id: t.id, expires: now + TRANSFER_TTL_MS } };
      }),
  },
  {
    // The showing device asks whether its code is still waiting, without taking it.
    method: "HEAD",
    path: ONE,
    guard: "person",
    run: (user, m) => Effect.map(waiting(user, m), (t) => ({ res: new Response(null, { status: t ? 200 : 404 }) })),
  },
  {
    // The new device takes the box, once.
    method: "GET",
    path: ONE,
    guard: "person",
    run: (user, m) =>
      Effect.gen(function* () {
        const store = yield* Handovers;
        const t = yield* waiting(user, m);
        if (!t) return yield* refuse(404, "this code was already used or has expired: show a new one on your other device");
        yield* attempt(() => store.remove(user, t.id));
        return { data: { box: t.box } };
      }),
  },
  {
    method: "DELETE",
    path: ONE,
    guard: "person",
    run: (user, m) =>
      Effect.gen(function* () {
        const store = yield* Handovers;
        const t = yield* waiting(user, m);
        if (!t) return yield* refuse(404, "this code was already used or has expired: show a new one on your other device");
        yield* attempt(() => store.remove(user, t.id));
        return { data: { removed: true } };
      }),
  },
];

const guards: Record<DeviceGuard, Effect.Effect<string, Refused, SignIn | Request_>> = { person: signedInPerson("this relay has no sign-in") };

/** The handover rows, for the route-table test. */
export const deviceRouteTable = describeRoutes(routes);

/** Routes under /v1/me/devices; null when the path isn't one of them. */
export async function onDeviceHttp(req: Request, store: DeviceStore, human: HumanAuth | null, now = Date.now()): Promise<Response | null> {
  if (!new URL(req.url).pathname.startsWith("/v1/me/devices")) return null;
  const otherwise = Effect.flatMap(guards.person, () => refuse(404, "not found"));
  return servePerson(req, routes, guards, otherwise, (e) => Effect.provideService(e, Handovers, store), { human, now });
}
