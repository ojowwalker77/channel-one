import { b64url, fromB64url } from "@mc/crypto.ts"

// Passkeys as a key, not as a login: WorkOS signs you in, and a passkey's PRF
// output (32 bytes only that authenticator can produce, for this site and this
// salt) unlocks your vault. Nothing here is checked by a server, so the
// challenge is random and only the PRF result matters.

export interface PrfSecret {
  credentialId: string
  secret: Uint8Array<ArrayBuffer>
}

type PrfResults = { enabled?: boolean; results?: { first?: ArrayBuffer } }

/** Whether this browser can make and use passkeys at all. PRF support itself only shows when one is used. */
export async function passkeysAvailable(): Promise<boolean> {
  if (typeof PublicKeyCredential === "undefined" || !window.isSecureContext) return false
  const caps = await (PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> }).getClientCapabilities?.().catch(() => null)
  if (caps && caps["extension:prf"] === false) return false
  return true
}

function prfOf(cred: PublicKeyCredential): PrfResults | undefined {
  return (cred.getClientExtensionResults() as { prf?: PrfResults }).prf
}

/**
 * Make a passkey for this site and return its PRF secret. Some authenticators
 * only give PRF output when the key is used, so a second touch may follow.
 */
export async function createPasskey(user: { id: string; name: string; displayName: string }, salt: Uint8Array<ArrayBuffer>, exclude: string[] = []): Promise<PrfSecret> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { id: location.hostname, name: "Channels" },
      user: { id: new TextEncoder().encode(user.id), name: user.name, displayName: user.displayName },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: exclude.map((id) => ({ type: "public-key" as const, id: fromB64url(id) })),
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null
  if (!cred) throw new Error("No passkey was made.")
  const prf = prfOf(cred)
  const credentialId = b64url(new Uint8Array(cred.rawId))
  if (prf?.results?.first) return { credentialId, secret: new Uint8Array(prf.results.first) }
  if (prf?.enabled === false) throw new PrfUnsupported()
  return touchPasskey(salt, [credentialId])
}

/** Touch a passkey and get its PRF secret. With several credentials, one prompt covers them all. */
export async function touchPasskey(salt: Uint8Array<ArrayBuffer>, credentialIds: string[]): Promise<PrfSecret> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      rpId: location.hostname,
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: credentialIds.map((id) => ({ type: "public-key" as const, id: fromB64url(id) })),
      userVerification: "required",
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null
  if (!cred) throw new Error("No passkey was used.")
  const first = prfOf(cred)?.results?.first
  if (!first) throw new PrfUnsupported()
  return { credentialId: b64url(new Uint8Array(cred.rawId)), secret: new Uint8Array(first) }
}

/** The passkey worked but can't produce a PRF secret (older authenticators, some password managers). */
export class PrfUnsupported extends Error {
  constructor() {
    super("This passkey can’t unlock a vault. Use another one (iCloud Keychain, Google Password Manager, Windows Hello or a recent security key), or your recovery code.")
  }
}

/** The person closed the prompt, or it timed out: not an error worth a red toast. */
export function cancelled(err: unknown): boolean {
  return err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError")
}
