// One place that hears "your sign-in is gone" from anywhere in the app. A call
// that the relay refuses with SignInRequired reports it here; AuthProvider checks
// the session really ended (not a blip fetching the token) and signs this
// browser out, so the page asks you to sign in again instead of throwing.

import { RelayError } from "@mc/client.ts"

export const SIGN_IN_GONE = "mc:sign-in-gone"

/** Whether `err` (or what caused it) is the relay saying this browser isn't signed in. */
export function isSignInGone(err: unknown): boolean {
  for (let e = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) if (e instanceof RelayError && e.tag === "SignInRequired") return true
  return false
}

/** Report `err` if it means the sign-in is gone; returns whether it did. */
export function noteSignInGone(err: unknown): boolean {
  if (!isSignInGone(err)) return false
  window.dispatchEvent(new Event(SIGN_IN_GONE))
  return true
}
