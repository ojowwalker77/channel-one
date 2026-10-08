// Channels moved from channel-one.modelchannel.workers.dev to channels.kiwiinit.com.
// Browsers keep each site's storage apart, so a browser's channel keys don't
// follow on their own. The old site hands them to the new one, in this browser
// only, over postMessage: each side accepts messages from the other's exact
// origin and nobody else, and nothing already stored at the new site is replaced.

export const OLD_ORIGIN = "https://channel-one.modelchannel.workers.dev"
export const NEW_ORIGIN = "https://channels.kiwiinit.com"

const PREFIX = "mc."

/** Everything this browser stores for Channels here. */
function stored(): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k?.startsWith(PREFIX)) out[k] = localStorage.getItem(k) ?? ""
  }
  return out
}

/** On the old site: does this browser have channels to move? */
export function hasChannelsToMove(): boolean {
  return location.origin === OLD_ORIGIN && Object.keys(stored()).some((k) => k.startsWith("mc.member."))
}

/** On the old site: open the new one and hand it this browser's channels. Resolves once it has them. */
export function moveChannels(): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = window.open(`${NEW_ORIGIN}/#import`, "_blank")
    if (!target) return reject(new Error("Your browser blocked the new window. Allow pop-ups for this site and try again."))
    const timer = setTimeout(() => (cleanup(), reject(new Error("The new site didn't answer. Try again."))), 60_000)
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== NEW_ORIGIN || e.source !== target) return
      const data = e.data as { type?: string; count?: number }
      if (data?.type === "kiwi-import-ready") target.postMessage({ type: "kiwi-import", entries: stored() }, NEW_ORIGIN)
      if (data?.type === "kiwi-import-done") {
        cleanup()
        resolve(data.count ?? 0)
      }
    }
    const cleanup = () => {
      clearTimeout(timer)
      window.removeEventListener("message", onMessage)
    }
    window.addEventListener("message", onMessage)
  })
}

/** On the new site, at #import: accept the old site's channels once, then go home. */
export function receiveChannels(onDone: (count: number) => void): () => void {
  const opener = window.opener as Window | null
  const onMessage = (e: MessageEvent) => {
    if (e.origin !== OLD_ORIGIN || e.source !== opener) return
    const data = e.data as { type?: string; entries?: Record<string, unknown> }
    if (data?.type !== "kiwi-import" || !data.entries || typeof data.entries !== "object") return
    let count = 0
    for (const [k, v] of Object.entries(data.entries)) {
      // Only Channels' own keys, only strings, and never over something this site already holds.
      if (!k.startsWith(PREFIX) || typeof v !== "string" || localStorage.getItem(k) !== null) continue
      localStorage.setItem(k, v)
      if (k.startsWith("mc.member.")) count++
    }
    opener?.postMessage({ type: "kiwi-import-done", count }, OLD_ORIGIN)
    window.removeEventListener("message", onMessage)
    onDone(count)
  }
  window.addEventListener("message", onMessage)
  opener?.postMessage({ type: "kiwi-import-ready" }, OLD_ORIGIN)
  return () => window.removeEventListener("message", onMessage)
}
