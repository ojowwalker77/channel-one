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

import { HUMAN_HEADER, type HumanAuth } from "./human.ts";
import { HttpError } from "./room.ts";
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

/** Routes under /v1/me/devices; null when the path isn't one of them. */
export async function onDeviceHttp(req: Request, store: DeviceStore, human: HumanAuth | null, now = Date.now()): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (!path.startsWith("/v1/me/devices")) return null;
  if (!human) throw new HttpError(404, "this relay has no sign-in");
  const user = await human.verify(req.headers.get(HUMAN_HEADER) ?? "");
  if (!user) throw new HttpError(401, "sign in first", "SignInRequired");
  const method = req.method.toUpperCase();
  // Expired codes go as soon as anyone looks.
  const live = async () => {
    const out: DeviceTransfer[] = [];
    for (const t of await store.list(user)) {
      if (now - t.created > TRANSFER_TTL_MS) await store.remove(user, t.id);
      else out.push(t);
    }
    return out;
  };

  if (path === "/v1/me/devices/transfers" && method === "POST") {
    let box: unknown;
    try {
      box = ((await req.json()) as { box?: unknown }).box;
    } catch {
      throw new HttpError(400, "bad json");
    }
    if (!fits(Present, box)) throw new HttpError(400, "missing box");
    if (box.length > MAX_BOX) throw new HttpError(413, "too much to hand over at once");
    // One code at a time: showing a new one retires the last.
    for (const t of await store.list(user)) await store.remove(user, t.id);
    const t: DeviceTransfer = { id: crypto.randomUUID(), box, created: now };
    await store.put(user, t);
    return Response.json({ id: t.id, expires: now + TRANSFER_TTL_MS });
  }
  const one = /^\/v1\/me\/devices\/transfers\/([0-9a-f-]{36})$/.exec(path);
  if (!one) throw new HttpError(404, "not found");
  const t = (await live()).find((x) => x.id === one[1]);
  // The showing device asks whether its code is still waiting, without taking it.
  if (method === "HEAD") return new Response(null, { status: t ? 200 : 404 });
  if (!t) throw new HttpError(404, "this code was already used or has expired: show a new one on your other device");
  // The new device takes the box, once.
  if (method === "GET") {
    await store.remove(user, t.id);
    return Response.json({ box: t.box });
  }
  if (method === "DELETE") {
    await store.remove(user, t.id);
    return Response.json({ removed: true });
  }
  throw new HttpError(404, "not found");
}
