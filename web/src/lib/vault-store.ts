// Where this browser keeps the vault key between visits: IndexedDB, as a
// non-extractable CryptoKey, so page script can use it to sync but never read
// it out. One record per signed-in person.

const DB = "mc.vault"
const STORE = "keys"

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

/** Keep a copy of the vault key that can sync but can't be exported. */
export async function keepVaultKey(user: string, key: CryptoKey): Promise<void> {
  const raw = await crypto.subtle.exportKey("raw", key)
  const locked = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
  await run("readwrite", (s) => s.put(locked, user))
}

export async function loadVaultKey(user: string): Promise<CryptoKey | null> {
  return ((await run("readonly", (s) => s.get(user))) as CryptoKey | undefined) ?? null
}

export async function forgetVaultKey(user: string): Promise<void> {
  await run("readwrite", (s) => s.delete(user))
}
