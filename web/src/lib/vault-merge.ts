// How this browser's seats and the vault's agree, as pure functions so the
// rules can be tested without a browser (test/vault-web.test.ts): tombstones
// always win. No imports, so the root test runner can load it as is.

type Seat = { code: string; identity: { pk: string }; at: number }
type Contents<M> = { channels: M[]; gone: Record<string, number> }

/** A seat's key in the vault: the same as seat() in src/vault.ts (the test checks they match). */
export const seatKey = (m: Pick<Seat, "code" | "identity">) => `${m.code} ${m.identity.pk}`
const seat = seatKey

/** A seat the vault has tombstoned since it was stored: left, closed, or taken over under a new key. */
export function dead(c: Pick<Contents<Seat>, "gone">, m: Seat): boolean {
  const t = c.gone[seat(m)]
  return t !== undefined && t >= (m.at || 0)
}

/**
 * What this browser should do to agree with the vault: drop the seats it has
 * tombstoned (they're dead at the relay too), then take every live seat for a
 * code it doesn't hold. A code held here under a live key keeps that key.
 */
export function reconcile<M extends Seat>(local: M[], c: Contents<M>): { drop: string[]; add: M[] } {
  const drop = local.filter((m) => dead(c, m)).map((m) => m.code)
  const held = new Set(local.filter((m) => !dead(c, m)).map((m) => m.code))
  const add = c.channels.filter((m) => !dead(c, m) && !held.has(m.code))
  return { drop, add }
}

/** The seats this browser gained that the vault should learn: never one it has tombstoned or already has. */
export function freshSeats<M extends Seat>(gained: M[], c: Contents<M>): M[] {
  const have = new Set(c.channels.map(seat))
  return gained.filter((m) => !have.has(seat(m)) && !dead(c, m))
}
