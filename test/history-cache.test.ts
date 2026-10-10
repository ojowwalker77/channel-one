// Reload rules for the web history cache (web/src/lib/history-plan.ts).
// A hole or a seq past the relay's head loads the usual window. A contiguous
// run fetches only what is newer than its last seq.

import { expect, test } from "bun:test"
import { planReload, wholeLog } from "../web/src/lib/history-plan.ts"

const LIMIT = 2_000

test("nothing cached: the usual window", () => {
  expect(planReload([], 0, LIMIT)).toEqual({ keep: [], since: 0 })
  expect(planReload([], 50, LIMIT)).toEqual({ keep: [], since: 0 })
  expect(planReload([], 5_000, LIMIT)).toEqual({ keep: [], since: 3_000 })
})

test("a contiguous run fetches only what is newer", () => {
  expect(planReload([8, 9, 10], 10, LIMIT)).toEqual({ keep: [8, 9, 10], since: 10 })
  expect(planReload([8, 9, 10], 12, LIMIT)).toEqual({ keep: [8, 9, 10], since: 10 })
})

test("a hole drops the cache", () => {
  expect(planReload([1, 2, 4], 4, LIMIT)).toEqual({ keep: [], since: 0 })
})

test("a seq past the relay head is not kept, and does not count as a hole", () => {
  expect(planReload([1, 2, 9], 2, LIMIT)).toEqual({ keep: [1, 2], since: 2 })
})

test("the whole log is only a cache that starts at the first message", () => {
  expect(wholeLog(10, LIMIT, undefined)).toBe(true)
  expect(wholeLog(10, LIMIT, 1)).toBe(true)
  expect(wholeLog(10, LIMIT, 8)).toBe(false)
  expect(wholeLog(5_000, LIMIT, 1)).toBe(false)
})

test("only the newest limit messages are kept", () => {
  const seqs = Array.from({ length: 10 }, (_, i) => i + 1)
  expect(planReload(seqs, 10, 3)).toEqual({ keep: [8, 9, 10], since: 10 })
})
