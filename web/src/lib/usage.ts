import { useEffect, useRef, useState } from "react"

import { myUsage, type MyUsage } from "@mc/client.ts"
import { CHANGED } from "@/lib/channel"

export type { MyUsage }

/**
 * What you use of this relay's limits, for signed-in people. Null when signed
 * out, or on a relay that has no usage endpoint (older or self-hosted ones).
 * Refreshed when channels change, on focus, and every minute.
 */
export function useUsage(signedIn: boolean, token: () => Promise<string | null>): MyUsage | null {
  const [usage, setUsage] = useState<MyUsage | null>(null)
  const tokenRef = useRef(token)
  useEffect(() => {
    tokenRef.current = token
  }, [token])

  useEffect(() => {
    if (!signedIn) return
    let timer: number | undefined
    let stopped = false
    const load = async () => {
      const t = await tokenRef.current()
      if (!t || stopped) return
      try {
        const u = await myUsage(location.origin, t)
        if (!stopped) setUsage(u)
      } catch {
        if (!stopped) setUsage(null)
      }
    }
    // Creating or closing a channel lands on the relay a moment after the list changes.
    const soon = () => {
      clearTimeout(timer)
      timer = window.setTimeout(load, 600)
    }
    void load()
    const every = window.setInterval(load, 60_000)
    window.addEventListener("focus", soon)
    window.addEventListener(CHANGED, soon)
    return () => {
      stopped = true
      clearTimeout(timer)
      clearInterval(every)
      window.removeEventListener("focus", soon)
      window.removeEventListener(CHANGED, soon)
    }
  }, [signedIn])

  return signedIn ? usage : null
}

/** Whether you're at the most channels this relay lets one person own. */
export const atChannelLimit = (u: MyUsage | null) => !!u && u.limits.channelsPerOwner !== null && u.owned >= u.limits.channelsPerOwner

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}
