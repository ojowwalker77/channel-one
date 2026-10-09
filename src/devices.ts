// Handing a person's channels to another of their devices, shared by the web
// app and tests (the relay side is relay/devices.ts). The device that has the
// channels encrypts them under a fresh secret and uploads only the ciphertext;
// the secret travels in a QR code, in the part of the link browsers never send.

import { RelayError } from "./client.ts";
import { newChannelKey, openWith, sealWith } from "./crypto.ts";

const AD = "kiwi-devices";
const PREFIX = "device=";

export interface DeviceOffer {
  id: string;
  /** Lives only in the link: never sent to the relay. */
  secret: string;
  expires: number;
}

function call(relay: string, human: string, path: string, method = "GET", body?: string): Promise<Response> {
  return fetch(new URL(`/v1/me/devices/transfers${path}`, relay), { method, body, headers: { "content-type": "application/json", "x-human-token": human } });
}

async function fail(res: Response): Promise<never> {
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  throw new RelayError(res.status, json.error ?? `relay returned ${res.status}`);
}

/** Encrypt `data` under a new secret and leave the ciphertext at the relay for 10 minutes. */
export async function offerToDevice(relay: string, human: string, data: string): Promise<DeviceOffer> {
  const secret = newChannelKey();
  const res = await call(relay, human, "", "POST", JSON.stringify({ box: await sealWith(secret, data, AD) }));
  if (!res.ok) return fail(res);
  const { id, expires } = (await res.json()) as { id: string; expires: number };
  return { id, secret, expires };
}

/** Whether an offer is still waiting to be taken (false once used, expired or withdrawn). */
export async function offerWaiting(relay: string, human: string, id: string): Promise<boolean> {
  const res = await call(relay, human, `/${id}`, "HEAD");
  if (res.status === 404) return false;
  if (!res.ok) return fail(res);
  return true;
}

export async function withdrawOffer(relay: string, human: string, id: string): Promise<void> {
  await call(relay, human, `/${id}`, "DELETE").catch(() => {});
}

/** Take an offer (once) and decrypt it with the secret from the link. */
export async function takeOffer(relay: string, human: string, id: string, secret: string): Promise<string> {
  const res = await call(relay, human, `/${id}`);
  if (!res.ok) return fail(res);
  const { box } = (await res.json()) as { box: string };
  const data = await openWith(secret, box, AD);
  if (data === null) throw new Error("this code didn’t open: scan the one your other device shows now");
  return data;
}

/** `…/#device=<id>.<secret>`: what the QR code holds. */
export function offerLink(origin: string, o: Pick<DeviceOffer, "id" | "secret">): string {
  return `${origin}/#${PREFIX}${o.id}.${o.secret}`;
}

export function parseOfferHash(hash: string): Pick<DeviceOffer, "id" | "secret"> | null {
  const m = /^#?device=([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(hash);
  return m ? { id: m[1]!, secret: m[2]! } : null;
}
