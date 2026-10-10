// This browser's copy of a channel's history, so a reload fetches only what is new.
//
// At rest a row is ciphertext sealed to the channel key (the same key the member
// record already holds), plus the room id, the member key, the seq, the relay
// time, and the epoch of the key that sealed this copy. The message text is not
// stored. It is decrypted for the screen, then checked: the seq inside the seal
// has to match the row, so editing the row cannot move a message.
//
// Rows are keyed by room and member key, so two accounts in one browser do not
// share a cache. Leave, kick, close, and sign-out delete them. A hole, a seal
// that does not open, or a seq past the relay's head drops that cache and the
// page loads the usual window. The cache does not fill a gap or sort ahead of
// the relay. See history-plan.ts.

import { open, seal } from "../../../src/crypto.ts"
import { verify } from "../../../src/identity.ts"
import { wellFormed, type Message } from "../../../src/protocol.ts"
import { planReload } from "./history-plan"

/** One sealed message. No plaintext. */
export interface CachedRow {
  seq: number
  rts?: number
  /** Epoch of the channel key that sealed this copy. */
  e: number
  iv: string
  ct: string
}

export interface HistoryDb {
  put(roomId: string, memberPk: string, row: CachedRow): Promise<void>
  rows(roomId: string, memberPk: string): Promise<CachedRow[]>
  /** Delete seqs below `oldestKept` for this room and member. */
  trimBelow(roomId: string, memberPk: string, oldestKept: number): Promise<void>
  /** Delete seqs above `newestKept` for this room and member. */
  trimAbove(roomId: string, memberPk: string, newestKept: number): Promise<void>
  drop(roomId: string, memberPk: string): Promise<void>
  dropAll(): Promise<void>
}

const DB = "mc.history"
const STORE = "rows"

function range(roomId: string, memberPk: string, hi: number, hiOpen: boolean): IDBKeyRange {
  return IDBKeyRange.bound([roomId, memberPk, 0], [roomId, memberPk, hi], false, hiOpen)
}

/** Seqs strictly above `newestKept`. */
function rangeAbove(roomId: string, memberPk: string, newestKept: number): IDBKeyRange {
  return IDBKeyRange.bound([roomId, memberPk, newestKept], [roomId, memberPk, Number.MAX_SAFE_INTEGER], true, false)
}

function idb(): HistoryDb {
  const openDb = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })

  const run = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T> => {
    const db = await openDb()
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const out = fn(tx.objectStore(STORE))
        tx.oncomplete = () => resolve((out && "result" in out ? out.result : undefined) as T)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  }

  return {
    put: (roomId, memberPk, row) => run<void>("readwrite", (s) => void s.put(row, [roomId, memberPk, row.seq])),
    rows: (roomId, memberPk) => run<CachedRow[]>("readonly", (s) => s.getAll(range(roomId, memberPk, Number.MAX_SAFE_INTEGER, false))),
    trimBelow: (roomId, memberPk, oldestKept) => run<void>("readwrite", (s) => void s.delete(range(roomId, memberPk, oldestKept, true))),
    trimAbove: (roomId, memberPk, newestKept) => run<void>("readwrite", (s) => void s.delete(rangeAbove(roomId, memberPk, newestKept))),
    drop: (roomId, memberPk) => run<void>("readwrite", (s) => void s.delete(range(roomId, memberPk, Number.MAX_SAFE_INTEGER, false))),
    dropAll: () => run<void>("readwrite", (s) => void s.clear()),
  }
}

let backing: HistoryDb | null = null

function db(): HistoryDb {
  if (!backing) {
    if (typeof indexedDB === "undefined") throw new Error("no indexedDB")
    backing = idb()
  }
  return backing
}

/** Tests substitute a memory database. Pass null to go back to IndexedDB. */
export function useHistoryDb(next: HistoryDb | null): void {
  backing = next
}

/** Seal a message for the cache. The stored row does not contain the text. */
export async function packRow(key: string, roomId: string, epoch: number, message: Message): Promise<CachedRow> {
  const { seq, rts, sigOk, ...payload } = message
  void sigOk
  const sealed = await seal(key, roomId, { seq, msg: payload })
  return { seq, ...(rts !== undefined ? { rts } : {}), e: epoch, iv: sealed.iv, ct: sealed.ct }
}

/** Open a row, or null if the seal, the seq, or the payload does not check out. */
export async function openRow(row: CachedRow, roomId: string, keys: Record<string, string>): Promise<Message | null> {
  const epochs = [String(row.e), ...Object.keys(keys).filter((e) => e !== String(row.e))]
  for (const e of epochs) {
    const key = keys[e]
    if (!key) continue
    const opened = (await open(key, roomId, row.iv, row.ct)) as { seq?: unknown; msg?: unknown } | null
    if (!opened || opened.seq !== row.seq || !wellFormed(opened.msg)) continue
    return { ...opened.msg, seq: row.seq, ...(row.rts !== undefined ? { rts: row.rts } : {}), sigOk: await verify(opened.msg) }
  }
  return null
}

/** Remember one message the relay just delivered. Keeps at most `limit` newest seqs. */
export async function rememberMessage(roomId: string, memberPk: string, epoch: number, key: string, message: Message, limit: number): Promise<void> {
  if (!key || !Number.isSafeInteger(message.seq) || message.seq <= 0) return
  const row = await packRow(key, roomId, epoch, message)
  await db().put(roomId, memberPk, row)
  await db().trimBelow(roomId, memberPk, message.seq - limit + 1)
}

/**
 * Messages to paint, and the exclusive seq to stream from. An unusable cache
 * is deleted here, so the next save starts clean.
 */
export async function readCached(
  roomId: string,
  memberPk: string,
  keys: Record<string, string>,
  head: number,
  limit: number,
): Promise<{ messages: Message[]; since: number }> {
  const stored = await db().rows(roomId, memberPk)
  const opened: Message[] = []
  for (const row of stored) {
    const m = await openRow(row, roomId, keys)
    if (m) opened.push(m)
  }
  const plan = planReload(
    opened.map((m) => m.seq),
    head,
    limit,
  )
  if (!plan.keep.length) {
    if (stored.length) await db().drop(roomId, memberPk)
  } else {
    // Drop a prefix the window no longer wants, and any seq past the relay head
    // so a later head cannot revive it ahead of the relay.
    await db().trimBelow(roomId, memberPk, plan.keep[0]!)
    await db().trimAbove(roomId, memberPk, plan.keep[plan.keep.length - 1]!)
  }
  const keep = new Set(plan.keep)
  const messages = opened.filter((m) => keep.has(m.seq)).sort((a, b) => a.seq - b.seq)
  return { messages, since: plan.since }
}

export async function forgetHistory(roomId: string, memberPk: string): Promise<void> {
  await db().drop(roomId, memberPk)
}

export async function forgetAllHistory(): Promise<void> {
  await db().dropAll()
}
