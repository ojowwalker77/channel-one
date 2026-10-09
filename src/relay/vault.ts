// A signed-in person's vault: their channels' identities and keys, encrypted on
// their own devices under a key the relay never holds (see src/vault.ts), so a
// new browser opens every channel after sign-in and a passkey touch, no QR.
//
// The relay keeps one opaque blob per person and never parses it. It orders
// writes: each PUT names the version it replaces, and a stale one is refused
// (409), so two devices saving at once merge instead of clobbering.
//
// And it only takes writes signed by the vault's writer key, which lives inside
// the encrypted vault: a stolen sign-in alone can't overwrite or delete it. The
// first save names the writer; later saves can hand over to a new one (when the
// vault key rotates). Someone who lost every passkey and their recovery code
// can only ask for a reset, which waits a day, shows on every device, and any
// device holding the writer key cancels by saving.

import { sha256Hex } from "../auth.ts";
import { canonical, verify } from "../identity.ts";
import { HUMAN_HEADER, type HumanAuth } from "./human.ts";
import { HttpError } from "./room.ts";

export interface VaultRecord {
  version: number;
  /** Ciphertext and public wrap metadata, as the person's devices wrote it. */
  blob: string;
  updated: number;
  /** The Ed25519 key every write must be signed by (its secret half is inside the vault). */
  writer: string;
  /** A reset someone asked for without the writer key: the vault is gone after this, unless a signed save cancels it. */
  resetAt?: number;
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
/** How long a reset without the writer key waits, so the person's devices can see it and cancel. */
export const VAULT_RESET_MS = 24 * 3600_000;

/** The compare-and-swap both stores run, given the record that's there now. */
export function vaultSwap(current: VaultRecord | null, expected: number): boolean {
  return (current?.version ?? 0) === expected;
}

/** What a writer signs to save (`hash` is the blob's SHA-256) or delete (`op`). */
export interface VaultAuth {
  user: string;
  expected: number;
  hash?: string;
  /** Hand writing over to this key (first save, or a rotation). */
  writer?: string;
  op?: "delete";
  pk: string;
  sig: string;
}

/** What a writer signs for a blob: its SHA-256, hex. */
export const blobHash = sha256Hex;

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

/** The writer's signature over exactly this action, or a 403. */
async function authorize(auth: unknown, want: Omit<VaultAuth, "pk" | "sig">, signer: string): Promise<void> {
  const a = auth as Partial<VaultAuth> | null;
  const same = a && typeof a === "object" && canonical({ ...a, pk: undefined, sig: undefined }) === canonical(want);
  if (!same || a!.pk !== signer || !(await verify(a!))) throw new HttpError(403, "vault writes must be signed by the vault's writer key");
}

/** The record as it stands: a reset that has come due means there's no vault any more. */
async function live(store: VaultStore, user: string, now: number): Promise<VaultRecord | null> {
  const rec = await store.get(user);
  if (rec?.resetAt && rec.resetAt <= now) {
    await store.remove(user, rec.version);
    return null;
  }
  return rec;
}

function conflict(current: VaultRecord | null): Response {
  return Response.json(
    current
      ? { error: "the vault changed since you read it: read it again, merge, and save", version: current.version, exists: true }
      : { error: "there's no vault any more: start a new one", version: 0, exists: false },
    { status: 409 },
  );
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
    const rec = await live(store, user, now);
    if (!rec) throw new HttpError(404, "no vault yet");
    return Response.json({ version: rec.version, blob: rec.blob, updated: rec.updated, ...(rec.resetAt ? { resetAt: rec.resetAt } : {}) });
  }

  if (method === "PUT") {
    const b = await body(req);
    const expected = version(b.version);
    if (typeof b.blob !== "string" || !b.blob) throw new HttpError(400, "missing blob");
    if (b.blob.length > MAX_VAULT) throw new HttpError(413, "the vault is larger than 1MB");
    if (b.writer !== undefined && (typeof b.writer !== "string" || !b.writer)) throw new HttpError(400, "bad writer");
    const handover = b.writer as string | undefined;
    const current = await live(store, user, now);
    // A stale version is a conflict, whoever signed it: a second setup on a vault that already
    // exists must hear "it exists" (409) and go unlock it, not a signature error. The version
    // is no secret (GET shows it) and nothing changes here.
    if ((current?.version ?? 0) !== expected) return conflict(current);
    // The first save names its writer and signs with it; every later one is signed by the current writer.
    if (!current && !handover) throw new HttpError(400, "a new vault names its writer key");
    const signer = current?.writer ?? handover!;
    await authorize(b.auth, { user, expected, hash: await blobHash(b.blob), ...(handover ? { writer: handover } : {}) }, signer);
    const recent = (current?.recent ?? []).filter((t) => now - t < VAULT_WINDOW_MS);
    if (recent.length >= VAULT_WRITES) throw new HttpError(429, "too many vault saves; try again in a few minutes");
    // A signed save is proof a device still holds the vault: it cancels any pending reset.
    const rec: VaultRecord = { version: expected + 1, blob: b.blob, updated: now, writer: handover ?? signer, recent: [...recent, now] };
    const r = await store.put(user, expected, rec);
    if (!r.ok) return conflict(r.current);
    return Response.json({ version: rec.version });
  }

  if (method === "DELETE") {
    const b = await body(req);
    const current = await live(store, user, now);
    if (!current) throw new HttpError(404, "no vault yet");
    if (b.reset === true) {
      // No writer key: lost every passkey and the recovery code. Wait, so the person's devices can see it and cancel.
      const resetAt = current.resetAt ?? now + VAULT_RESET_MS;
      if (!current.resetAt && !(await store.put(user, current.version, { ...current, resetAt })).ok) throw new HttpError(409, "the vault changed; try again");
      return Response.json({ resetAt });
    }
    const expected = version(b.version);
    await authorize(b.auth, { user, expected, op: "delete" }, current.writer);
    if (!(await store.remove(user, expected))) return Response.json({ error: "the vault changed since you read it", version: current.version }, { status: 409 });
    return Response.json({ removed: true });
  }

  throw new HttpError(405, "use GET, PUT or DELETE");
}
