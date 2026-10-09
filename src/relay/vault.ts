// A signed-in person's vault: their channels' identities and keys, encrypted on
// their own devices under a key the relay never holds (see src/vault.ts), so a
// new browser opens every channel after sign-in and a passkey touch, no QR.
//
// The relay keeps one opaque blob per person and never parses it. It only
// orders writes: each PUT names the version it replaces, and a stale one is
// refused (409), so two devices saving at once merge instead of clobbering.

import { HUMAN_HEADER, type HumanAuth } from "./human.ts";
import { HttpError } from "./room.ts";

export interface VaultRecord {
  version: number;
  /** Ciphertext and public wrap metadata, as the person's devices wrote it. */
  blob: string;
  updated: number;
  /** When the recent writes happened: the rate limit, kept with the record so both relays agree. */
  recent: number[];
}

export interface VaultStore {
  get(user: string): Promise<VaultRecord | null>;
  /** Store `rec` if the current version is `expected` (0: none yet); else return what's there. Atomic. */
  put(user: string, expected: number, rec: VaultRecord): Promise<{ ok: true } | { ok: false; current: VaultRecord | null }>;
  /** Delete if the current version is `expected`. */
  remove(user: string, expected: number): Promise<boolean>;
}

/** Identities and keys for every channel a person is in: a few KB each. */
export const MAX_VAULT = 1024 * 1024;
/** Saving happens on create, join, leave and key rotation: a burst, then quiet. */
export const VAULT_WRITES = 30;
export const VAULT_WINDOW_MS = 10 * 60_000;

/** The compare-and-swap both stores run, given the record that's there now. */
export function vaultSwap(current: VaultRecord | null, expected: number): boolean {
  return (current?.version ?? 0) === expected;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = (await req.json()) as unknown;
    if (b && typeof b === "object") return b as Record<string, unknown>;
  } catch {}
  throw new HttpError(400, "bad json");
}

function version(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new HttpError(400, "version must be the vault version you read (0 for a new vault)");
  return v;
}

/** Routes under /v1/me/vault; null when the path isn't one of them. */
export async function onVaultHttp(req: Request, store: VaultStore, human: HumanAuth | null, now = Date.now()): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (path !== "/v1/me/vault") return null;
  if (!human) throw new HttpError(404, "this relay has no sign-in");
  const user = await human.verify(req.headers.get(HUMAN_HEADER) ?? "");
  if (!user) throw new HttpError(401, "sign in first");
  const method = req.method.toUpperCase();

  if (method === "GET") {
    const rec = await store.get(user);
    if (!rec) throw new HttpError(404, "no vault yet");
    return Response.json({ version: rec.version, blob: rec.blob, updated: rec.updated });
  }

  if (method === "PUT") {
    const b = await body(req);
    const expected = version(b.version);
    if (typeof b.blob !== "string" || !b.blob) throw new HttpError(400, "missing blob");
    if (b.blob.length > MAX_VAULT) throw new HttpError(413, "the vault is larger than 1MB");
    const current = await store.get(user);
    const recent = (current?.recent ?? []).filter((t) => now - t < VAULT_WINDOW_MS);
    if (recent.length >= VAULT_WRITES) throw new HttpError(429, "too many vault saves; try again in a few minutes");
    const rec: VaultRecord = { version: expected + 1, blob: b.blob, updated: now, recent: [...recent, now] };
    const r = await store.put(user, expected, rec);
    if (!r.ok) return Response.json({ error: "the vault changed since you read it: read it again, merge, and save", version: r.current?.version ?? 0 }, { status: 409 });
    return Response.json({ version: rec.version });
  }

  if (method === "DELETE") {
    const expected = version((await body(req)).version);
    if (!(await store.remove(user, expected))) {
      const current = await store.get(user);
      if (!current) throw new HttpError(404, "no vault yet");
      return Response.json({ error: "the vault changed since you read it", version: current.version }, { status: 409 });
    }
    return Response.json({ removed: true });
  }

  throw new HttpError(405, "use GET, PUT or DELETE");
}
