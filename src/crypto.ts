// Channel key derivation and message encryption.
//
// A channel is identified by its join code alone. From the code we derive:
//   roomId - where the relay stores the channel (safe to show the relay)
//   token  - proves membership to the relay (the relay stores only its hash)
//   key    - AES-256-GCM key for message contents (never leaves the clients)
// The relay can route and store messages but cannot read or forge them.

import { PROTOCOL_VERSION, type Payload } from "./protocol.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

const KDF_SALT = enc.encode("modelchannel/v1");
const KDF_ITERATIONS = 210_000;

export interface ChannelKeys {
  roomId: string;
  token: string;
  /** Raw AES key, base64url. Stored in the local config so commands stay fast. */
  key: string;
}

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** A fresh, high-entropy join code (128 bits). */
export function generateCode(): string {
  return "mc1-" + b64url(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Derive a channel's keys from its join code. Any string works as a code;
 * codes from generateCode() are strong, a user-chosen password is only as
 * strong as the password.
 */
export async function deriveChannel(code: string): Promise<ChannelKeys> {
  const base = await crypto.subtle.importKey("raw", enc.encode(code), "PBKDF2", false, ["deriveBits"]);
  const master = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: KDF_SALT, iterations: KDF_ITERATIONS },
    base,
    256,
  );
  const hkdf = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveBits"]);
  const expand = async (info: string, bits: number) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) },
        hkdf,
        bits,
      ),
    );
  return {
    roomId: hex(await expand("room", 128)),
    token: b64url(await expand("auth", 256)),
    key: b64url(await expand("enc", 256)),
  };
}

/** What the relay stores to check a token: SHA-256 of it, hex. */
export async function tokenVerifier(token: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(token))));
}

async function aesKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromB64url(key), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(keys: ChannelKeys, payload: Payload): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    // Binding the room id stops a relay from replaying ciphertext across channels.
    { name: "AES-GCM", iv, additionalData: enc.encode(keys.roomId) },
    await aesKey(keys.key),
    enc.encode(JSON.stringify(payload)),
  );
  return { iv: b64url(iv), ct: b64url(new Uint8Array(ct)) };
}

/** Decrypt an envelope, or return null if it isn't a valid message for this channel. */
export async function open(keys: ChannelKeys, iv: string, ct: string): Promise<Payload | null> {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64url(iv), additionalData: enc.encode(keys.roomId) },
      await aesKey(keys.key),
      fromB64url(ct),
    );
    const p = JSON.parse(dec.decode(pt)) as Payload;
    return p.v === PROTOCOL_VERSION && typeof p.body === "string" && typeof p.from === "string" ? p : null;
  } catch {
    return null;
  }
}
