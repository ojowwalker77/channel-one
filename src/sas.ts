// The 6-digit code a joiner and the channel owner compare before the owner lets
// them in. Shared by the CLI, the web app and the relay.
//
// A code made from the joiner's key alone can be ground: a relay mints keys
// until one gives the same 6 digits, then swaps its own request in. So the code
// mixes in two secrets nobody can choose after seeing the other:
//
//   joiner  commits to a random nonce Nj inside its signed request (commit = H(room, pk, Nj))
//   owner   signs that commit; the signature No is unpredictable without the owner key,
//           and anyone can check it against the owner key pinned in the join code
//   joiner  reveals Nj once it sees a valid No
//   both    show H(room, pk, No, Nj) as 6 digits
//
// The relay has to fix its key and nonce before it learns the owner's signature,
// and the joiner's code depends only on the joiner's commit and the owner key. What
// a relay can still do is ask the owner to sign many commits of its own; owner
// devices cap how many they sign without a person's click (see SigningBudget).

import { b64url } from "./crypto.ts";
import { signText, type Identity } from "./identity.ts";

const enc = new TextEncoder();

export const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const ROOM_RE = /^[0-9a-f]{32}$/;
const PK_RE = /^[A-Za-z0-9_-]{43}$/;
/** An Ed25519 signature, base64url. */
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

/** Every input is fixed-length and checked, so newline-joined fields can't run into each other. */
function fields(room: string, pk: string, ...rest: [string, RegExp][]): string {
  if (!ROOM_RE.test(room) || !PK_RE.test(pk)) throw new Error("bad room or key");
  for (const [v, re] of rest) if (!re.test(v)) throw new Error("bad join check value");
  return [room, pk, ...rest.map(([v]) => v)].join("\n");
}

/**
 * The joiner's secret until it reveals it. Derived from its own key (Ed25519
 * signatures are deterministic), so asking again after a restart makes the same
 * commit, and nobody without the key can predict it.
 */
export async function joinNonce(id: Identity, room: string): Promise<string> {
  return b64url(await sha256(`kiwi-join-nonce\n${await signText(id, `kiwi-join-nonce\n${room}`)}`));
}

/** What a joiner puts in its signed request. */
export async function commitTo(room: string, pk: string, nonce: string): Promise<string> {
  return b64url(await sha256(`kiwi-commit\n${fields(room, pk, [nonce, NONCE_RE])}`));
}

/** What the owner signs; the signature is the owner's half of the code. */
export function ownerNonceStatement(room: string, pk: string, commit: string): string {
  return `kiwi-owner-nonce\n${fields(room, pk, [commit, NONCE_RE])}`;
}

/** The code both sides show: 6 digits, "123-456". */
export async function joinCheckCode(room: string, pk: string, ownerNonce: string, nonce: string): Promise<string> {
  const d = await sha256(`kiwi-sas\n${fields(room, pk, [ownerNonce, SIG_RE], [nonce, NONCE_RE])}`);
  const n = ((d[0]! << 16) | (d[1]! << 8) | d[2]!) % 1_000_000;
  const s = String(n).padStart(6, "0");
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

/**
 * How many owner nonces one device signs on its own, per channel. Past this,
 * signing needs a person's click: a relay can't turn the owner's devices into
 * an oracle for grinding codes.
 */
export const AUTO_SIGN_PER_DAY = 10;

/** What a person sees once a device stops signing on its own. */
export const TOO_MANY_REQUESTS =
  "That's unusually many join requests for one channel in a day. If you're not expecting them, the relay may be misbehaving: check each request by hand, and only approve codes you've compared.";

/** One owner nonce a device signed: which commit, and when. */
export interface Signed {
  commit: string;
  at: number;
}

/** Where a device remembers what it signed (localStorage in the browser, a file for the CLI). */
export interface SigningBudget {
  load(roomId: string): Signed[];
  save(roomId: string, signed: Signed[]): void;
}

/**
 * Whether this device may sign a commit on its own. Signing a commit it already
 * signed is free: Ed25519 gives the same signature, so a relay that strips the
 * owner's half learns nothing new and can't drain the allowance that way.
 */
export function spendAuto(budget: SigningBudget, roomId: string, commit: string, now = Date.now()): boolean {
  const recent = budget.load(roomId).filter((s) => s && typeof s.commit === "string" && typeof s.at === "number" && now - s.at < 86_400_000);
  if (recent.some((s) => s.commit === commit)) return true;
  if (recent.length >= AUTO_SIGN_PER_DAY) return false;
  budget.save(roomId, [...recent, { commit, at: now }]);
  return true;
}
