import { decodeJoinCode } from "@mc/crypto.ts"
import {
  PRF_SALT,
  VaultError,
  addWrap,
  fetchVault,
  forgetSeat,
  newRecoveryCode,
  newVault,
  openVault,
  putVault,
  recoverySecret,
  requestVaultReset,
  resealVault,
  rotateVault,
  seat,
  syncVault,
  unlock,
  vaultKey,
  wrapsOf,
  type OpenedVault,
  type PublicWrap,
  type VaultContents,
  type VaultKey,
  type WrapInput,
} from "@mc/vault.ts"
import { useSyncExternalStore } from "react"

import { CHANGED, allMembers, forgetChannel, saveMember, type StoredMember } from "./channel"
import { createPasskey, touchPasskey } from "./passkey"
import { freshSeats, reconcile } from "./vault-merge"
import { forgetVaultKey, keepVaultKey, loadVaultKey } from "./vault-store"

// Your channels, kept for you at the relay where only your passkeys can open
// them. This browser pulls in every seat it doesn't have when the vault opens,
// and saves every seat it gains or leaves as it happens. The relay only ever
// holds ciphertext; the vault key stays in this browser (non-extractable) and
// in memory right after a touch, for adding or removing passkeys.

export type Wrap = PublicWrap

export type VaultState =
  | { kind: "off" }
  | { kind: "loading" }
  | { kind: "none" }
  /** `resetAt`: someone asked to reset the vault; it's erased then unless a device that has it saves first. */
  | { kind: "locked"; wraps: Wrap[]; resetAt?: number }
  /** `cancelled`: this browser just stopped a reset someone asked for (when it was asked to happen). */
  | { kind: "open"; wraps: Wrap[]; cancelled?: number }
  | { kind: "error"; message: string }

interface Session {
  user: string
  email: string
  name: string
  token: () => Promise<string | null>
}

let state: VaultState = { kind: "off" }
let session: Session | null = null
let key: VaultKey | null = null
/** The raw key, only between a touch and the page closing: adding a passkey needs it. */
let rawKey: string | null = null
/** The seats this browser last agreed with the vault on, to tell what changed since. */
let synced = new Set<string>()
const listeners = new Set<() => void>()

function set(next: VaultState) {
  state = next
  for (const l of listeners) l()
}

export function useVault(): VaultState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state
  )
}

// The highest version this browser has opened, so a relay can't quietly hand back an older vault.
const SEEN = (user: string) => `mc.vault.seen.${user}`
const seen = (user: string) => Number(localStorage.getItem(SEEN(user)) ?? 0)
const saw = (user: string, v: number) => v > seen(user) && localStorage.setItem(SEEN(user), String(v))

async function token(): Promise<string> {
  const t = await session?.token()
  if (!t) throw new VaultError("sign in again to reach your vault")
  return t
}

async function current() {
  const got = await fetchVault(location.origin, await token())
  if (!got) throw new VaultError("there’s no vault yet")
  return got
}

function wellFormed(m: StoredMember): boolean {
  try {
    return typeof m.identity?.pk === "string" && typeof m.identity.sk === "string" && typeof m.access?.ownerPk === "string" && decodeJoinCode(m.code).roomId === m.access.roomId
  } catch {
    return false
  }
}

/** A name for this browser's passkey, so the list says which one is which. */
function deviceLabel(): string {
  const ua = navigator.userAgent
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "this device"
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "a browser"
  return `${browser} on ${os}`
}

const ids = (wraps: Wrap[]) => wraps.flatMap((w) => (w.credentialId ? [w.credentialId] : []))
const known = () => (state.kind === "locked" || state.kind === "open" ? state.wraps : [])

/** Make this browser agree with the vault (see reconcile). Returns how many channels came in. */
function take(c: VaultContents<StoredMember>): number {
  const { drop, add } = reconcile(allMembers(), c)
  for (const code of drop) forgetChannel(code)
  let added = 0
  for (const m of add) {
    if (!wellFormed(m)) continue
    try {
      saveMember({ ...m, at: m.at || Date.now() })
      added++
    } catch {
      // Held here under another live key: this browser's own key wins, and merge reports the conflict.
    }
  }
  synced = new Set(c.channels.map(seat))
  return added
}

/**
 * Open the vault with a key: cancel any pending reset (only someone without a
 * device that has the vault asks for one, so from here it's never wanted
 * silently), pull, then push whatever this browser had that the vault didn't.
 */
async function opened(got: { version: number; blob: string; resetAt?: number }, k: VaultKey): Promise<number> {
  const s = session!
  const v = await openVault<StoredMember>(got.blob, s.user, k, got.version, seen(s.user))
  saw(s.user, got.version)
  key = k
  let cancelled: number | undefined
  if (got.resetAt) {
    const r = await putVault(location.origin, await token(), s.user, got.version, await resealVault(got.blob, s.user, k, v, got.version + 1, v), v.writer)
    if ("version" in r) {
      saw(s.user, r.version)
      cancelled = got.resetAt
    }
  }
  const added = take(v)
  set({ kind: "open", wraps: v.wraps, ...(cancelled ? { cancelled } : {}) })
  await push()
  return added
}

/** Start (or stop) the vault for whoever is signed in. */
export async function startVault(next: Session | null): Promise<void> {
  if (next?.user === session?.user) return
  session = next
  key = rawKey = null
  synced = new Set()
  if (!next) return set({ kind: "off" })
  set({ kind: "loading" })
  try {
    const got = await fetchVault(location.origin, await token())
    if (!got) return set({ kind: "none" })
    const stored = await loadVaultKey(next.user)
    if (stored) {
      try {
        await opened(got, stored)
        return
      } catch {
        // The vault was rotated elsewhere (a passkey removed): this browser's key no longer opens it.
        await forgetVaultKey(next.user)
      }
    }
    set({ kind: "locked", wraps: wrapsOf(got.blob), ...(got.resetAt ? { resetAt: got.resetAt } : {}) })
  } catch (err) {
    set({ kind: "error", message: err instanceof Error ? err.message : String(err) })
  }
}

/** First time: make a passkey, put every channel this browser has in a new vault. Returns the recovery code to show once. */
export async function setUpVault(): Promise<string> {
  const s = session!
  // The WebAuthn user handle is the WorkOS user id: stable, and not personal data.
  const pk = await createPasskey({ id: s.user, name: s.email || s.name, displayName: s.name }, PRF_SALT)
  const contents: VaultContents<StoredMember> = { channels: allMembers(), gone: {} }
  const made = await newVault(s.user, contents, { kind: "passkey", label: deviceLabel(), secret: pk.secret, credentialId: pk.credentialId })
  const first = await openVault<StoredMember>(made.blob, s.user, made.key, 1)
  const code = newRecoveryCode()
  const blob = await addWrap(made.blob, s.user, made.key, first, 1, { kind: "recovery", label: "Recovery code", secret: recoverySecret(code)! })
  const r = await putVault(location.origin, await token(), s.user, 0, blob, made.writer, made.writer.pk)
  if ("conflict" in r) throw new VaultError("another device just set up your vault. Reload to unlock it.")
  saw(s.user, r.version)
  rawKey = made.key
  key = await vaultKey(made.key)
  await keepVaultKey(s.user, key)
  synced = new Set(contents.channels.map(seat))
  set({ kind: "open", wraps: wrapsOf(blob) })
  return code
}

async function unlockWith(secret: Uint8Array, credentialId?: string): Promise<number> {
  const s = session!
  const got = await current()
  const raw = await unlock(got.blob, s.user, secret, credentialId)
  if (!raw) throw new VaultError(credentialId ? "That passkey doesn’t open this vault." : "That recovery code doesn’t open this vault.")
  rawKey = raw
  const k = await vaultKey(raw)
  await keepVaultKey(s.user, k)
  return opened(got, k)
}

/** Touch any of the vault's passkeys. Returns how many channels came in. */
export async function unlockWithPasskey(): Promise<number> {
  const pk = await touchPasskey(PRF_SALT, ids(known()))
  return unlockWith(pk.secret, pk.credentialId)
}

export async function unlockWithCode(code: string): Promise<number> {
  const secret = recoverySecret(code)
  if (!secret) throw new VaultError("That isn’t a recovery code: it’s 32 letters and digits.")
  return unlockWith(secret)
}

/**
 * Lost every passkey and the recovery code, or the vault wasn't made with
 * yours: ask for a reset. It waits a day, and any device that still opens the
 * vault cancels it, so a stolen sign-in can't erase it quietly.
 */
export async function resetVault(): Promise<number> {
  const { resetAt } = await requestVaultReset(location.origin, await token())
  if (state.kind === "locked") set({ ...state, resetAt })
  return resetAt
}

/** The warning about a cancelled reset has been read. */
export function dismissCancelled() {
  if (state.kind === "open" && state.cancelled) set({ kind: "open", wraps: state.wraps })
}

/** Save what changed in this browser since the vault last saw it: seats gained, seats left. */
async function push(): Promise<void> {
  if (!key || !session) return
  const mine = new Map(allMembers().map((m) => [seat(m), m]))
  const added = [...mine.keys()].filter((s) => !synced.has(s))
  const left = [...synced].filter((s) => !mine.has(s))
  if (!added.length && !left.length) return
  const s = session
  const r = await syncVault<StoredMember>(
    location.origin,
    await token(),
    s.user,
    key,
    (c) => {
      let next: VaultContents<StoredMember> = { channels: c.channels, gone: c.gone }
      for (const k of left) {
        const [code, pk] = k.split(" ")
        next = forgetSeat(next, { code: code!, identity: { pk: pk! } })
      }
      // Never bring back a seat the vault has tombstoned: another device left it, or it was taken over.
      return {
        ...next,
        channels: [
          ...next.channels,
          ...freshSeats(
            added.map((k) => mine.get(k)!),
            next
          ),
        ],
      }
    },
    seen(s.user)
  )
  saw(s.user, r.version)
  take(r.contents)
}

/**
 * Signing out locks the vault in this browser: the key kept for syncing is
 * forgotten, so whoever signs in here next needs a passkey or the recovery code.
 */
export async function lockVault(): Promise<void> {
  const user = session?.user
  key = rawKey = null
  synced = new Set()
  session = null
  set({ kind: "off" })
  if (user) await forgetVaultKey(user)
}

let timer: ReturnType<typeof setTimeout> | undefined
window.addEventListener(CHANGED, () => {
  if (state.kind !== "open") return
  clearTimeout(timer)
  timer = setTimeout(() => void push().catch((err) => console.warn("vault: not saved", err)), 400)
})

/** Adding or removing a passkey needs the raw key, which only a fresh touch gives. */
async function freshKey(): Promise<{ raw: string; keep: WrapInput }> {
  const pk = await touchPasskey(PRF_SALT, ids(known()))
  const got = await current()
  const raw = await unlock(got.blob, session!.user, pk.secret, pk.credentialId)
  if (!raw) throw new VaultError("That passkey doesn’t open this vault.")
  const label = known().find((w) => w.credentialId === pk.credentialId)?.label || deviceLabel()
  return { raw, keep: { kind: "passkey", label, secret: pk.secret, credentialId: pk.credentialId } }
}

async function openNow(k: VaultKey): Promise<{ got: { version: number; blob: string }; v: OpenedVault<StoredMember> }> {
  const got = await current()
  return { got, v: await openVault<StoredMember>(got.blob, session!.user, k, got.version, seen(session!.user)) }
}

/** Another passkey that opens the same vault: a phone, a security key. */
export async function addPasskey(): Promise<void> {
  const s = session!
  const raw = rawKey ?? (await freshKey()).raw
  const pk = await createPasskey({ id: s.user, name: s.email || s.name, displayName: s.name }, PRF_SALT, ids(known()))
  const { got, v } = await openNow(raw)
  const blob = await addWrap(got.blob, s.user, raw, v, got.version + 1, { kind: "passkey", label: deviceLabel(), secret: pk.secret, credentialId: pk.credentialId })
  const r = await putVault(location.origin, await token(), s.user, got.version, blob, v.writer)
  if ("conflict" in r) throw new VaultError("Your vault changed on another device. Try again.")
  saw(s.user, r.version)
  rawKey = raw
  set({ kind: "open", wraps: (await openVault(blob, s.user, raw, r.version)).wraps })
}

/**
 * Remove a passkey for real: a new vault key, opened by the passkey touched
 * here and a new recovery code. Other passkeys stop working until they're
 * added again. Returns the new recovery code.
 */
export async function removePasskey(w: Wrap): Promise<string> {
  const s = session!
  const { keep } = await freshKey()
  if (keep.credentialId === w.credentialId) throw new VaultError("Touch a different passkey than the one you’re removing.")
  const { got, v } = await openNow(key!)
  const next = await rotateVault(s.user, v, got.version + 1, keep)
  const r = await putVault(location.origin, await token(), s.user, got.version, next.blob, v.writer, next.writer.pk)
  if ("conflict" in r) throw new VaultError("Your vault changed on another device. Try again.")
  saw(s.user, r.version)
  rawKey = next.key
  key = await vaultKey(next.key)
  await keepVaultKey(s.user, key)
  set({ kind: "open", wraps: (await openVault(next.blob, s.user, next.key, r.version)).wraps })
  return next.recoveryCode
}
