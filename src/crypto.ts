// Encryption for membership channels.
//
// A channel has a random 256-bit key per epoch. Members never derive it from
// anything shared: the owner wraps each epoch key to each member's X25519 key
// when approving them, and wraps a fresh key to everyone left whenever a
// member leaves or is removed. The relay stores only those sealed boxes.

const enc = new TextEncoder();
const dec = new TextDecoder();

/** What a member holds to read and write a channel. */
export interface ChannelAccess {
  roomId: string;
  ownerPk: string;
  ownerXpk: string;
  /** Current key epoch. */
  epoch: number;
  /** Channel key per epoch (base64url), so history stays readable after rotations. */
  keys: Record<string, string>;
}

// Plain implementations (no Buffer) so this module also runs in the browser.
export function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const aesKeys = new Map<string, Promise<CryptoKey>>();
function aesKey(key: string): Promise<CryptoKey> {
  let k = aesKeys.get(key);
  if (!k) aesKeys.set(key, (k = crypto.subtle.importKey("raw", fromB64url(key), "AES-GCM", false, ["encrypt", "decrypt"])));
  return k;
}

export async function seal(key: string, roomId: string, payload: object): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    // Binding the room id stops a relay from replaying ciphertext across channels.
    { name: "AES-GCM", iv, additionalData: enc.encode(roomId) },
    await aesKey(key),
    enc.encode(JSON.stringify(payload)),
  );
  return { iv: b64url(iv), ct: b64url(new Uint8Array(ct)) };
}

/** Decrypt an envelope to its JSON payload, or null if it isn't valid for this channel. */
export async function open(key: string, roomId: string, iv: string, ct: string): Promise<unknown> {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64url(iv), additionalData: enc.encode(roomId) },
      await aesKey(key),
      fromB64url(ct),
    );
    return JSON.parse(dec.decode(pt));
  } catch {
    return null;
  }
}

// ---------- membership channels (mc2) ----------
//
// An mc2 join code names a room and pins its owner: `mc2-<room>-<owner fp>`.
// It lets an agent *ask* to join; only the owner's approval lets it in.

export interface JoinCode {
  roomId: string;
  /** First 12 bytes of SHA-256(owner public key), base64url. */
  ownerFp: string;
}

export function encodeJoinCode(j: JoinCode): string {
  const room = b64url(Uint8Array.from(j.roomId.match(/../g)!.map((h) => parseInt(h, 16))));
  return `mc2-${room}-${j.ownerFp}`;
}

export function decodeJoinCode(code: string): JoinCode {
  const m = /^mc2-([A-Za-z0-9_-]{22})-([A-Za-z0-9_-]{16})$/.exec(code.trim());
  if (!m) throw new Error("not an mc2 join code");
  return { roomId: hex(fromB64url(m[1]!)), ownerFp: m[2]! };
}

export function newRoomId(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

export async function ownerFingerprint(ownerPk: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", fromB64url(ownerPk)));
  return b64url(d.slice(0, 12));
}

/**
 * The 6-digit code a joining agent and the approving human both see. It's
 * derived from the room and the joiner's key, so the relay can't swap keys
 * without the codes disagreeing.
 */
export async function verificationCode(roomId: string, pk: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`mc-verify\n${roomId}\n${pk}`)));
  const n = ((d[0]! << 16) | (d[1]! << 8) | d[2]!) % 1_000_000;
  const s = String(n).padStart(6, "0");
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

export function newChannelKey(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

const X25519 = { name: "X25519" } as const;

async function wrapKey(shared: ArrayBuffer, info: string): Promise<CryptoKey> {
  const hk = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) },
    hk,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt `data` so only the holder of the X25519 secret for `xpk` can read it. */
export async function sealTo(xpk: string, data: string, info = "mc/box"): Promise<string> {
  const eph = (await crypto.subtle.generateKey(X25519, true, ["deriveBits"])) as unknown as CryptoKeyPair;
  const pub = await crypto.subtle.importKey("raw", fromB64url(xpk), X25519, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: pub } as unknown as { name: string }, eph.privateKey, 256);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const epk = new Uint8Array((await crypto.subtle.exportKey("raw", eph.publicKey)) as ArrayBuffer);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: epk }, await wrapKey(shared, info), enc.encode(data));
  return [b64url(epk), b64url(iv), b64url(new Uint8Array(ct))].join(".");
}

/** Open a `sealTo` box with our X25519 secret (PKCS#8, base64url), or null. */
export async function openFrom(xsk: string, box: string, info = "mc/box"): Promise<string | null> {
  try {
    const [epk, iv, ct] = box.split(".");
    const priv = await crypto.subtle.importKey("pkcs8", fromB64url(xsk), X25519, false, ["deriveBits"]);
    const pub = await crypto.subtle.importKey("raw", fromB64url(epk!), X25519, false, []);
    const shared = await crypto.subtle.deriveBits({ name: "X25519", public: pub } as unknown as { name: string }, priv, 256);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv!), additionalData: fromB64url(epk!) }, await wrapKey(shared, info), fromB64url(ct!));
    return dec.decode(pt);
  } catch {
    return null;
  }
}

/** Seal/open with a raw channel key (for member records), independent of room-bound AD. */
export async function sealWith(key: string, data: string, ad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(ad) }, await aesKey(key), enc.encode(data));
  return `${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

export async function openWith(key: string, box: string, ad: string): Promise<string | null> {
  try {
    const [iv, ct] = box.split(".");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv!), additionalData: enc.encode(ad) }, await aesKey(key), fromB64url(ct!));
    return dec.decode(pt);
  } catch {
    return null;
  }
}
