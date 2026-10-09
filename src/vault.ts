// A person's vault: every channel identity and key they hold, encrypted on their
// own devices and kept at the relay as one opaque blob (relay/vault.ts), so any
// browser they sign in to opens all their channels with a passkey touch.
// Shared by the web app and tests; WebCrypto only.
//
//   blob    { v, wraps: [{ id, kind, label, created, credentialId?, salt, box }], body }
//   box     the vault key, sealed under HKDF(secret, salt): the secret is a passkey's
//           PRF output, or a recovery code; neither ever leaves the person's device
//   body    { v, user, version, wraps, writer, channels, gone }, sealed under the vault key
//   writer  an Ed25519 key, kept only in the body, that signs every save: the relay
//           takes no write without it, so a stolen sign-in can't overwrite the vault
//
// What the relay can't do, and how a device notices:
//   - read, forge or overwrite anything: it never holds the vault key, any secret
//     or the writer key;
//   - move a box between people, versions or wraps, or relabel a passkey: boxes
//     are sealed with those as associated data, and the body repeats the user, the
//     version and every wrap's public record;
//   - roll the vault back: each device remembers the highest version it opened
//     and refuses anything lower (openVault's `highestSeen`; callers persist it).
// It can still withhold the vault or refuse saves; the person's channels then
// stay where they are, as without a vault.

import { RelayError } from "./client.ts";
import { b64url, fromB64url, newChannelKey, openWith, sealWith } from "./crypto.ts";
import { generateIdentity, sign, type Identity } from "./identity.ts";
import { sha256Hex as blobHash } from "./auth.ts";

export const VAULT_VERSION = 2;

/**
 * What every passkey is asked to evaluate (WebAuthn `prf: { eval: { first: PRF_SALT } }`).
 * Fixed, so any device gets the same secret from the same passkey.
 */
export const PRF_SALT = new TextEncoder().encode("kiwi-vault-prf-v1");

/**
 * The vault key: raw (base64url) right after an unlock, which adding or removing
 * a passkey needs; or a non-extractable CryptoKey (vaultKey) that a browser can
 * keep in IndexedDB to sync later joins without another touch.
 */
export type VaultKey = string | CryptoKey;

/** The public part of a wrap: what a passkey list shows. Authenticated once the vault is open. */
export interface PublicWrap {
  id: string;
  kind: "passkey" | "recovery";
  /** "MacBook Touch ID". */
  label: string;
  created: number;
  /** The passkey's credential id (base64url), to pick its box. */
  credentialId?: string;
}

export interface VaultWrap extends PublicWrap {
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

/** The key every save is signed with. */
export type VaultWriter = Pick<Identity, "pk" | "sk">;

/** An opened vault: its contents, the passkeys that open it (authenticated), and what saving it takes. */
export interface OpenedVault<E extends VaultEntry = VaultEntry> extends VaultContents<E> {
  version: number;
  wraps: PublicWrap[];
  writer: VaultWriter;
}

interface Body<E extends VaultEntry> extends VaultContents<E> {
  v: typeof VAULT_VERSION;
  user: string;
  version: number;
  wraps: PublicWrap[];
  writer: VaultWriter;
}

/** A secret that opens the vault: a passkey's PRF output, or a recovery code's bytes. */
export interface WrapInput {
  kind: PublicWrap["kind"];
  label: string;
  secret: Uint8Array;
  credentialId?: string;
}

export class VaultError extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder();
const bodyAd = (user: string, version: number) => `kiwi-vault-body\n${user}\n${version}`;
const wrapAd = (user: string, w: Pick<VaultWrap, "id" | "kind">) => `kiwi-vault-wrap\n${user}\n${w.id}\n${w.kind}`;
export const seat = (e: Pick<VaultEntry, "code" | "identity">) => `${e.code} ${e.identity.pk}`;

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

/** The key that seals one wrap: HKDF over the secret, salted per wrap. */
async function kek(secret: Uint8Array, salt: string): Promise<string> {
  const base = await crypto.subtle.importKey("raw", Uint8Array.from(secret), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: fromB64url(salt), info: enc.encode("kiwi-vault-kek") }, base, 256);
  return b64url(new Uint8Array(bits));
}

async function wrap(user: string, key: string, input: WrapInput, now: number): Promise<VaultWrap> {
  if (input.secret.length < 16) throw new VaultError("that secret is too short to protect a vault");
  const w = { id: crypto.randomUUID(), kind: input.kind, label: input.label, created: now, ...(input.credentialId ? { credentialId: input.credentialId } : {}), salt: newChannelKey() };
  return { ...w, box: await sealWith(await kek(input.secret, w.salt), key, wrapAd(user, w)) };
}

const publicOf = ({ id, kind, label, created, credentialId }: PublicWrap): PublicWrap => ({ id, kind, label, created, ...(credentialId ? { credentialId } : {}) });
const sameWraps = (a: PublicWrap[], b: PublicWrap[]) => {
  const key = (ws: PublicWrap[]) => JSON.stringify(ws.map(publicOf).sort((x, y) => x.id.localeCompare(y.id)));
  return key(a) === key(b);
};

function parse(blob: string): VaultBlob {
  try {
    const b = JSON.parse(blob) as VaultBlob;
    if (b?.v === VAULT_VERSION && Array.isArray(b.wraps) && typeof b.body === "string") return b;
  } catch {}
  throw new VaultError("this vault is damaged or from a newer version of Channels");
}

async function seal<E extends VaultEntry>(user: string, key: VaultKey, wraps: VaultWrap[], writer: VaultWriter, version: number, c: VaultContents<E>): Promise<string> {
  const body: Body<E> = { v: VAULT_VERSION, user, version, wraps: wraps.map(publicOf), writer: { pk: writer.pk, sk: writer.sk }, channels: c.channels, gone: c.gone };
  const out: VaultBlob = { v: VAULT_VERSION, wraps, body: await sealUnder(key, JSON.stringify(body), bodyAd(user, version)) };
  return JSON.stringify(out);
}

async function newWriter(): Promise<VaultWriter> {
  const { pk, sk } = await generateIdentity("vault");
  return { pk, sk };
}

/**
 * A new vault holding `contents`, opened by `first`. Save it with
 * putVault(…, 0, blob, writer, writer.pk): the first save names its writer.
 */
export async function newVault<E extends VaultEntry>(user: string, contents: VaultContents<E>, first: WrapInput, now = Date.now()): Promise<{ key: string; blob: string; writer: VaultWriter }> {
  const key = newChannelKey();
  const writer = await newWriter();
  return { key, writer, blob: await seal(user, key, [await wrap(user, key, first, now)], writer, 1, contents) };
}

/** The passkeys and recovery codes a vault lists, before it's opened: only to pick a credential (allowCredentials). Show the list from openVault. */
export function wrapsOf(blob: string): PublicWrap[] {
  return parse(blob).wraps.map(publicOf);
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
 * records the body lists, and versions older than `highestSeen`, the highest this
 * device has opened before (a relay rolling the vault back). Callers persist the
 * highest version they open or save.
 */
export async function openVault<E extends VaultEntry>(blob: string, user: string, key: VaultKey, version: number, highestSeen = 0): Promise<OpenedVault<E>> {
  if (version < highestSeen) throw new VaultError(`the relay served vault version ${version}, older than the ${highestSeen} this device already saw: it may be rolling your vault back`);
  const b = parse(blob);
  const raw = await openUnder(key, b.body, bodyAd(user, version));
  if (raw === null) throw new VaultError("this vault doesn't open with this key, for this account and version");
  const body = JSON.parse(raw) as Body<E>;
  if (body.v !== VAULT_VERSION || body.user !== user || body.version !== version) throw new VaultError("this vault was sealed for another account or version");
  if (!Array.isArray(body.wraps) || !sameWraps(b.wraps, body.wraps)) throw new VaultError("this vault's passkeys were changed by someone without its key");
  return {
    version,
    wraps: body.wraps.map(publicOf),
    writer: body.writer,
    channels: Array.isArray(body.channels) ? body.channels : [],
    gone: body.gone && typeof body.gone === "object" ? body.gone : {},
  };
}

/** The same vault, re-sealed as `version` with new contents (same passkeys and writer). */
export async function resealVault<E extends VaultEntry>(blob: string, user: string, key: VaultKey, opened: OpenedVault<E>, version: number, contents: VaultContents<E>): Promise<string> {
  return seal(user, key, parse(blob).wraps, opened.writer, version, contents);
}

/** Add a passkey or recovery code to an open vault; the result is `version`. */
export async function addWrap<E extends VaultEntry>(blob: string, user: string, key: string, opened: OpenedVault<E>, version: number, input: WrapInput, now = Date.now()): Promise<string> {
  return seal(user, key, [...parse(blob).wraps, await wrap(user, key, input, now)], opened.writer, version, opened);
}

/**
 * Remove a passkey for real: a device that already has the vault key keeps
 * opening anything sealed under it, and its copy of the writer key keeps saving,
 * so removing a box isn't enough. A new vault key and writer, opened only by
 * `keep` (this device's passkey) and a new recovery code. Save it with
 * putVault(…, opened.writer, writer.pk): the old writer hands over to the new one.
 * Other passkeys are added again from here.
 */
export async function rotateVault<E extends VaultEntry>(
  user: string,
  opened: OpenedVault<E>,
  version: number,
  keep: WrapInput,
  now = Date.now(),
): Promise<{ key: string; blob: string; writer: VaultWriter; recoveryCode: string }> {
  const key = newChannelKey();
  const writer = await newWriter();
  const recoveryCode = newRecoveryCode();
  const wraps = [await wrap(user, key, keep, now), await wrap(user, key, { kind: "recovery", label: "Recovery code", secret: recoverySecret(recoveryCode)! }, now)];
  return { key, writer, recoveryCode, blob: await seal(user, key, wraps, writer, version, opened) };
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
  const json = (await res.json().catch(() => ({}))) as { error?: string; tag?: string };
  throw new RelayError(res.status, json.error ?? `relay returned ${res.status}`, json.tag);
}

const signer = (w: VaultWriter): Identity => ({ name: "vault", pk: w.pk, sk: w.sk });

/**
 * The stored vault, or null if this person has none. `resetAt` means someone
 * asked to reset it without the writer key: show it loudly, and save to cancel.
 */
export async function fetchVault(relay: string, human: string): Promise<{ version: number; blob: string; resetAt?: number } | null> {
  const res = await call(relay, human, "GET");
  if (res.status === 404) return null;
  if (!res.ok) return fail(res);
  const { version, blob, resetAt } = (await res.json()) as { version: number; blob: string; resetAt?: number };
  return { version, blob, ...(resetAt ? { resetAt } : {}) };
}

/**
 * Save `blob` over version `expected` (0: first save), signed by `writer`; pass
 * `handover` to make another key the writer from now on (first save, rotation).
 * A conflict returns the version that's there now.
 */
export async function putVault(relay: string, human: string, user: string, expected: number, blob: string, writer: VaultWriter, handover?: string): Promise<{ version: number } | { conflict: number }> {
  const auth = await sign(signer(writer), { user, expected, hash: await blobHash(blob), ...(handover ? { writer: handover } : {}) });
  const res = await call(relay, human, "PUT", { version: expected, blob, auth, ...(handover ? { writer: handover } : {}) });
  if (res.status === 409) return { conflict: ((await res.json()) as { version: number }).version };
  if (!res.ok) return fail(res);
  return { version: ((await res.json()) as { version: number }).version };
}

/** Delete the vault (signed by its writer). Devices keep the channels they have. */
export async function deleteVault(relay: string, human: string, user: string, expected: number, writer: VaultWriter): Promise<void> {
  const res = await call(relay, human, "DELETE", { version: expected, auth: await sign(signer(writer), { user, expected, op: "delete" }) });
  if (!res.ok) return fail(res);
}

/**
 * Lost every passkey and the recovery code: ask the relay to drop the vault. It
 * waits a day (VAULT_RESET_MS), shows on every device, and any device that still
 * opens the vault cancels it by saving.
 */
export async function requestVaultReset(relay: string, human: string): Promise<{ resetAt: number }> {
  const res = await call(relay, human, "DELETE", { reset: true });
  if (!res.ok) return fail(res);
  return (await res.json()) as { resetAt: number };
}

/**
 * Apply `change` to the stored vault and save it, re-reading and re-applying on
 * a conflict, so two devices saving at once both land. `change` must be a delta
 * (add these seats, forget that one), never "replace with my copy". Persist the
 * returned version as the new `highestSeen`.
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
    const opened = await openVault<E>(got.blob, user, key, got.version, highestSeen);
    const contents = change(opened);
    const r = await putVault(relay, human, user, got.version, await resealVault(got.blob, user, key, opened, got.version + 1, contents), opened.writer);
    if ("version" in r) return { version: r.version, contents };
    highestSeen = Math.max(highestSeen, got.version);
  }
  throw new VaultError("the vault kept changing while saving; try again");
}
