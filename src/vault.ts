// A person's vault: every channel identity and key they hold, encrypted on their
// own devices and kept at the relay as one opaque blob (relay/vault.ts), so any
// browser they sign in to opens all their channels with a passkey touch.
// Shared by the web app and tests; WebCrypto only.
//
//   blob  { v, wraps: [{ id, kind, label, created, credentialId?, salt, box }], body }
//   box   the vault key, sealed under HKDF(secret, salt): the secret is a passkey's
//         PRF output, or a recovery code; neither ever leaves the person's device
//   body  { v, user, version, wraps: [ids], channels, gone }, sealed under the vault key
//
// What the relay can't do, and how a device notices:
//   - read or forge anything: it never holds the vault key or any secret;
//   - move a box between people, versions or wraps: each is sealed with those as
//     associated data, and the body repeats the user, version and wrap ids;
//   - roll the vault back: each device remembers the highest version it opened
//     and refuses anything lower (openVault's `highestSeen`).
// It can still withhold the vault or refuse saves; the person's channels then
// stay where they are, as without a vault.

import { RelayError } from "./client.ts";
import { b64url, fromB64url, newChannelKey, openWith, sealWith } from "./crypto.ts";

/**
 * The vault key: raw (base64url) right after an unlock, which adding or removing
 * a passkey needs; or a non-extractable CryptoKey (vaultKey) that a browser can
 * keep in IndexedDB to sync later joins without another touch.
 */
export type VaultKey = string | CryptoKey;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A non-extractable copy of a raw vault key: script can use it, never read it. */
export function vaultKey(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromB64url(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

const aes = (k: VaultKey) => (typeof k === "string" ? vaultKey(k) : Promise.resolve(k));

async function sealUnder(k: VaultKey, data: string, ad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(ad) }, await aes(k), enc.encode(data));
  return `${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

async function openUnder(k: VaultKey, box: string, ad: string): Promise<string | null> {
  try {
    const [iv, ct] = box.split(".");
    return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv!), additionalData: enc.encode(ad) }, await aes(k), fromB64url(ct!)));
  } catch {
    return null;
  }
}

export const VAULT_VERSION = 1;

/**
 * What every passkey is asked to evaluate (WebAuthn `prf: { eval: { first: PRF_SALT } }`).
 * Fixed, so any device gets the same secret from the same passkey.
 */
export const PRF_SALT = new TextEncoder().encode("kiwi-vault-prf-v1");

export interface VaultWrap {
  id: string;
  kind: "passkey" | "recovery";
  /** Shown when managing passkeys ("MacBook Touch ID"); public. */
  label: string;
  created: number;
  /** The passkey's credential id (base64url), to pick its box; public. */
  credentialId?: string;
  salt: string;
  box: string;
}

export interface VaultBlob {
  v: typeof VAULT_VERSION;
  wraps: VaultWrap[];
  body: string;
}

/** One channel seat as a device stores it (the web app's StoredMember fits). */
export interface VaultEntry {
  code: string;
  at: number;
  identity: { pk: string };
}

export interface VaultContents<E extends VaultEntry = VaultEntry> {
  channels: E[];
  /** Seats left, removed or replaced: `${code} ${pk}` → when. A tombstone beats any older entry. */
  gone: Record<string, number>;
}

interface Body<E extends VaultEntry> extends VaultContents<E> {
  v: typeof VAULT_VERSION;
  user: string;
  version: number;
  wraps: string[];
}

/** A secret that opens the vault: a passkey's PRF output, or a recovery code's bytes. */
export interface WrapInput {
  kind: VaultWrap["kind"];
  label: string;
  secret: Uint8Array;
  credentialId?: string;
}

export class VaultError extends Error {}

const bodyAd = (user: string, version: number) => `kiwi-vault-body\n${user}\n${version}`;
const wrapAd = (user: string, w: Pick<VaultWrap, "id" | "kind">) => `kiwi-vault-wrap\n${user}\n${w.id}\n${w.kind}`;
export const seat = (e: Pick<VaultEntry, "code" | "identity">) => `${e.code} ${e.identity.pk}`;

/** The key that seals one wrap: HKDF over the secret, salted per wrap. */
async function kek(secret: Uint8Array, salt: string): Promise<string> {
  const base = await crypto.subtle.importKey("raw", Uint8Array.from(secret), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: fromB64url(salt), info: new TextEncoder().encode("kiwi-vault-kek") }, base, 256);
  return b64url(new Uint8Array(bits));
}

async function wrap(user: string, key: string, input: WrapInput, now: number): Promise<VaultWrap> {
  if (input.secret.length < 16) throw new VaultError("that secret is too short to protect a vault");
  const w = { id: crypto.randomUUID(), kind: input.kind, label: input.label, created: now, ...(input.credentialId ? { credentialId: input.credentialId } : {}), salt: newChannelKey() };
  return { ...w, box: await sealWith(await kek(input.secret, w.salt), key, wrapAd(user, w)) };
}

function parse(blob: string): VaultBlob {
  try {
    const b = JSON.parse(blob) as VaultBlob;
    if (b?.v === VAULT_VERSION && Array.isArray(b.wraps) && typeof b.body === "string") return b;
  } catch {}
  throw new VaultError("this vault is damaged or from a newer version of Channels");
}

async function seal<E extends VaultEntry>(user: string, key: VaultKey, wraps: VaultWrap[], version: number, c: VaultContents<E>): Promise<string> {
  const body: Body<E> = { v: VAULT_VERSION, user, version, wraps: wraps.map((w) => w.id), channels: c.channels, gone: c.gone };
  const out: VaultBlob = { v: VAULT_VERSION, wraps, body: await sealUnder(key, JSON.stringify(body), bodyAd(user, version)) };
  return JSON.stringify(out);
}

/** A new vault holding `contents`, opened by `first`; save it as version 1 (PUT with version 0). */
export async function newVault<E extends VaultEntry>(user: string, contents: VaultContents<E>, first: WrapInput, now = Date.now()): Promise<{ key: string; blob: string }> {
  const key = newChannelKey();
  return { key, blob: await seal(user, key, [await wrap(user, key, first, now)], 1, contents) };
}

/** The passkeys and recovery codes that open a vault, without opening it (for WebAuthn's allowCredentials). */
export function wrapsOf(blob: string): Omit<VaultWrap, "salt" | "box">[] {
  return parse(blob).wraps.map(({ id, kind, label, created, credentialId }) => ({ id, kind, label, created, ...(credentialId ? { credentialId } : {}) }));
}

/**
 * The vault key, from a passkey's PRF output (pass its credential id) or a
 * recovery code's secret (no credential id). Null when nothing here opens.
 */
export async function unlock(blob: string, user: string, secret: Uint8Array, credentialId?: string): Promise<string | null> {
  const b = parse(blob);
  const wraps = b.wraps.filter((w) => (credentialId ? w.credentialId === credentialId : w.kind === "recovery"));
  for (const w of wraps) {
    const key = await openWith(await kek(secret, w.salt), w.box, wrapAd(user, w));
    if (key) return key;
  }
  return null;
}

/**
 * Open version `version` of `user`'s vault (the version the relay served). Refuses
 * anything sealed for someone else or another version, wraps that don't match the
 * ones the body lists, and versions older than `highestSeen`, the highest this
 * device has opened before (a relay rolling the vault back).
 */
export async function openVault<E extends VaultEntry>(blob: string, user: string, key: VaultKey, version: number, highestSeen = 0): Promise<VaultContents<E>> {
  if (version < highestSeen) throw new VaultError(`the relay served vault version ${version}, older than the ${highestSeen} this device already saw: it may be rolling your vault back`);
  const b = parse(blob);
  const raw = await openUnder(key, b.body, bodyAd(user, version));
  if (raw === null) throw new VaultError("this vault doesn't open with this key, for this account and version");
  const body = JSON.parse(raw) as Body<E>;
  if (body.v !== VAULT_VERSION || body.user !== user || body.version !== version) throw new VaultError("this vault was sealed for another account or version");
  const ids = b.wraps.map((w) => w.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify([...body.wraps].sort())) throw new VaultError("this vault's passkeys were changed by someone without its key");
  return { channels: Array.isArray(body.channels) ? body.channels : [], gone: body.gone && typeof body.gone === "object" ? body.gone : {} };
}

/** The same vault, re-sealed as `version` with new contents (wraps unchanged). */
export async function resealVault<E extends VaultEntry>(blob: string, user: string, key: VaultKey, version: number, contents: VaultContents<E>): Promise<string> {
  return seal(user, key, parse(blob).wraps, version, contents);
}

/** Add a passkey or recovery code to an open vault; the result is `version`. */
export async function addWrap<E extends VaultEntry>(blob: string, user: string, key: string, version: number, contents: VaultContents<E>, input: WrapInput, now = Date.now()): Promise<string> {
  return seal(user, key, [...parse(blob).wraps, await wrap(user, key, input, now)], version, contents);
}

/**
 * Remove a passkey for real: a device that already has the vault key keeps
 * opening anything sealed under it, so removing a box isn't enough. A new vault
 * key, re-sealed contents, opened only by `keep` (this device's passkey) and a new
 * recovery code. Other passkeys are added again from here.
 */
export async function rotateVault<E extends VaultEntry>(
  user: string,
  version: number,
  contents: VaultContents<E>,
  keep: WrapInput,
  now = Date.now(),
): Promise<{ key: string; blob: string; recoveryCode: string }> {
  const key = newChannelKey();
  const recoveryCode = newRecoveryCode();
  const wraps = [await wrap(user, key, keep, now), await wrap(user, key, { kind: "recovery", label: "Recovery code", secret: recoverySecret(recoveryCode)! }, now)];
  return { key, blob: await seal(user, key, wraps, version, contents), recoveryCode };
}

/**
 * `incoming` folded into `base`. A seat (join code + key) is never replaced by a
 * copy of itself; tombstones beat older entries; and for one join code under two
 * keys, the one already in `base` stays unless the other's tombstone removed it.
 * Two live keys for one code are never both kept: the second is reported.
 */
export function mergeContents<E extends VaultEntry>(base: VaultContents<E>, incoming: VaultContents<E>): { contents: VaultContents<E>; conflicts: string[] } {
  const gone: Record<string, number> = { ...base.gone };
  for (const [k, t] of Object.entries(incoming.gone)) gone[k] = Math.max(gone[k] ?? 0, t);
  const live = (e: E) => !(gone[seat(e)] !== undefined && gone[seat(e)]! >= e.at);
  const byCode = new Map<string, E>();
  const conflicts: string[] = [];
  for (const e of [...base.channels, ...incoming.channels]) {
    if (!live(e)) continue;
    const had = byCode.get(e.code);
    if (!had) byCode.set(e.code, e);
    else if (had.identity.pk !== e.identity.pk) conflicts.push(e.code);
  }
  return { contents: { channels: [...byCode.values()], gone }, conflicts };
}

/** A seat left, removed or replaced: it goes from every device that syncs. */
export function forgetSeat<E extends VaultEntry>(c: VaultContents<E>, e: Pick<VaultEntry, "code" | "identity">, now = Date.now()): VaultContents<E> {
  return { channels: c.channels.filter((x) => seat(x) !== seat(e)), gone: { ...c.gone, [seat(e)]: now } };
}

/** A seat taken over under a new key (rejoin, reclaim): the old key's tombstone makes every device drop it. */
export function replaceSeat<E extends VaultEntry>(c: VaultContents<E>, next: E, oldPk: string, now = Date.now()): VaultContents<E> {
  const forgot = forgetSeat(c, { code: next.code, identity: { pk: oldPk } }, now);
  return { ...forgot, channels: [...forgot.channels.filter((x) => x.code !== next.code), next] };
}

// ---------- recovery codes ----------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 160 random bits as 32 Crockford base32 characters, in groups of four. */
export function newRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += CROCKFORD[parseInt(bits.slice(i, i + 5), 2)];
  return out.match(/.{4}/g)!.join("-");
}

/** The secret in a recovery code as typed (any case, dashes or not, O for 0, I/L for 1); null if malformed. */
export function recoverySecret(code: string): Uint8Array | null {
  const clean = code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!/^[0-9A-HJKMNP-TV-Z]{32}$/.test(clean)) return null;
  let bits = "";
  for (const c of clean) bits += CROCKFORD.indexOf(c).toString(2).padStart(5, "0");
  return Uint8Array.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
}

// ---------- the relay ----------

function call(relay: string, human: string, method: string, body?: unknown): Promise<Response> {
  return fetch(new URL("/v1/me/vault", relay), { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", "x-human-token": human } });
}

async function fail(res: Response): Promise<never> {
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  throw new RelayError(res.status, json.error ?? `relay returned ${res.status}`);
}

/** The stored vault, or null if this person has none yet. */
export async function fetchVault(relay: string, human: string): Promise<{ version: number; blob: string } | null> {
  const res = await call(relay, human, "GET");
  if (res.status === 404) return null;
  if (!res.ok) return fail(res);
  const { version, blob } = (await res.json()) as { version: number; blob: string };
  return { version, blob };
}

/** Save `blob` over version `expected` (0: first save). A conflict returns the version that's there now. */
export async function putVault(relay: string, human: string, expected: number, blob: string): Promise<{ version: number } | { conflict: number }> {
  const res = await call(relay, human, "PUT", { version: expected, blob });
  if (res.status === 409) return { conflict: ((await res.json()) as { version: number }).version };
  if (!res.ok) return fail(res);
  return { version: ((await res.json()) as { version: number }).version };
}

/**
 * Apply `change` to the stored vault and save it, re-reading and re-applying on
 * a conflict, so two devices saving at once both land. `change` must be a delta
 * (add these seats, forget that one), never "replace with my copy".
 */
export async function syncVault<E extends VaultEntry>(
  relay: string,
  human: string,
  user: string,
  key: VaultKey,
  change: (c: VaultContents<E>) => VaultContents<E>,
  highestSeen = 0,
  tries = 5,
): Promise<{ version: number; contents: VaultContents<E> }> {
  for (let i = 0; i < tries; i++) {
    const got = await fetchVault(relay, human);
    if (!got) throw new VaultError("there's no vault to save into: create one first");
    const contents = change(await openVault<E>(got.blob, user, key, got.version, highestSeen));
    const r = await putVault(relay, human, got.version, await resealVault(got.blob, user, key, got.version + 1, contents));
    if ("version" in r) return { version: r.version, contents };
    highestSeen = Math.max(highestSeen, got.version);
  }
  throw new VaultError("the vault kept changing while saving; try again");
}
