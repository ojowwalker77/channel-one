// The web vault's merge rules (web/src/lib/vault-merge.ts): tombstones win,
// so a seat left or taken over on one browser never comes back from another.

import { describe, expect, test } from "bun:test"
import { forgetSeat, replaceSeat, seat as vaultSeat, type VaultContents } from "../src/vault.ts"
import { freshSeats, reconcile, seatKey } from "../web/src/lib/vault-merge.ts"

type M = { code: string; identity: { pk: string }; at: number }
const seat = (code: string, pk: string, at: number): M => ({ code, identity: { pk }, at })

describe("vault merge on the web", () => {
  test("names seats the way the vault does", () => {
    const m = seat("X", "pk1", 1)
    expect(seatKey(m)).toBe(vaultSeat(m))
  })

  test("leave on A, then B syncs: B drops the seat and never pushes it back", () => {
    const x = seat("X", "pk1", 100)
    let vault: VaultContents<M> = { channels: [x], gone: {} }
    vault = forgetSeat(vault, x, 200) // A left X
    // B still holds X, and hadn't synced it.
    expect(freshSeats([x], vault)).toEqual([])
    expect(reconcile([x], vault)).toEqual({ drop: ["X"], add: [] })
  })

  test("reclaim on A, then B syncs: B swaps the dead key for the new one", () => {
    const old = seat("X", "old", 100)
    const next = seat("X", "new", 300)
    let vault: VaultContents<M> = { channels: [old], gone: {} }
    vault = replaceSeat(vault, next, "old", 300)
    expect(freshSeats([old], vault)).toEqual([])
    expect(reconcile([old], vault)).toEqual({ drop: ["X"], add: [next] })
  })

  test("rejoining after leaving: a seat stored after its tombstone is live", () => {
    const back = seat("X", "pk1", 500)
    const vault: VaultContents<M> = { channels: [], gone: { "X pk1": 200 } }
    expect(freshSeats([back], vault)).toEqual([back])
    expect(reconcile([back], vault)).toEqual({ drop: [], add: [] })
  })

  test("a code held here under a live key keeps it", () => {
    const mine = seat("X", "mine", 100)
    const theirs = seat("X", "theirs", 150)
    const vault: VaultContents<M> = { channels: [theirs], gone: {} }
    expect(reconcile([mine], vault)).toEqual({ drop: [], add: [] })
  })

  test("new seats from here reach the vault once", () => {
    const y = seat("Y", "pk", 100)
    const vault: VaultContents<M> = { channels: [y], gone: {} }
    expect(freshSeats([y, seat("Z", "pk", 100)], vault)).toEqual([seat("Z", "pk", 100)])
  })
})
