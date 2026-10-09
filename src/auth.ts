// Request authentication for membership channels: every HTTP request and
// WebSocket upgrade is signed by a member's Ed25519 key. No shared secret
// ever travels to the relay. Shared by the client and both relays.

import { signText, verifyText, type Identity } from "./identity.ts";

/** How far a signed request's timestamp may drift from the relay's clock. */
export const AUTH_SKEW_MS = 5 * 60_000;

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

function authText(roomId: string, method: string, path: string, ts: number, bodyHash: string): string {
  return `mc-auth\n${roomId}\n${method.toUpperCase()}\n${path}\n${ts}\n${bodyHash}`;
}

/** `s1.<pk>.<ts>.<sig>` — usable as a Bearer token or a WebSocket subprotocol. */
export async function signRequest(id: Identity, roomId: string, method: string, path: string, body = ""): Promise<string> {
  const ts = Date.now();
  const sig = await signText(id, authText(roomId, method, path, ts, await sha256Hex(body)));
  return `s1.${id.pk}.${ts}.${sig}`;
}

/** The signing key's public key if `token` is a fresh, valid signature for this request; else null. */
export async function verifyRequest(token: string, roomId: string, method: string, path: string, body = "", now = Date.now()): Promise<string | null> {
  const m = /^s1\.([A-Za-z0-9_-]+)\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!m) return null;
  const [, pk, tsRaw, sig] = m;
  const ts = Number(tsRaw);
  if (Math.abs(now - ts) > AUTH_SKEW_MS) return null;
  return (await verifyText(pk!, sig!, authText(roomId, method, path, ts, await sha256Hex(body)))) ? pk! : null;
}
