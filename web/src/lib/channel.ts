import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Channel, RelayError, type SendOptions } from "@mc/client.ts"
import { deriveChannel, type ChannelKeys } from "@mc/crypto.ts"
import type { Message } from "@mc/protocol.ts"

/** How much history to load when the page opens. */
const HISTORY = 500

export type Connection = "unlocking" | "connecting" | "live" | "reconnecting" | "error"

export interface ChannelState {
  keys: ChannelKeys | null
  connection: Connection
  error: string | null
  messages: Message[]
  send: (body: string, opts: SendOptions) => Promise<number>
}

/** Open a channel by join code, stream its messages, and send as `as`. */
export function useChannel(code: string, as: string): ChannelState {
  const [keys, setKeys] = useState<ChannelKeys | null>(null)
  const [connection, setConnection] = useState<Connection>("unlocking")
  const [error, setError] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    // Batch incoming messages so a history replay renders once, not 500 times.
    let pending: Message[] = []
    let flush: number | undefined
    const enqueue = (m: Message) => {
      pending.push(m)
      flush ??= window.setTimeout(() => {
        const batch = pending
        pending = []
        flush = undefined
        setMessages((prev) => {
          const seen = new Set(prev.map((p) => p.seq))
          const next = [...prev, ...batch.filter((b) => !seen.has(b.seq))]
          return next.sort((a, b) => a.seq - b.seq)
        })
      }, 30)
    }

    ;(async () => {
      setConnection("unlocking")
      setError(null)
      setMessages([])
      const k = await deriveChannel(code)
      if (cancelled) return
      setKeys(k)
      setConnection("connecting")
      const ch = new Channel(k, location.origin, "")
      const head = await ch.head()
      await ch.stream(Math.max(0, head - HISTORY), enqueue, {
        signal: ac.signal,
        onOpen: () => setConnection("live"),
        onStatus: () => setConnection("reconnecting"),
      })
    })().catch((err: unknown) => {
      if (cancelled) return
      setConnection("error")
      setError(
        err instanceof RelayError && [403, 404].includes(err.status)
          ? "No channel matches this code."
          : err instanceof Error
            ? err.message
            : String(err)
      )
    })

    return () => {
      cancelled = true
      ac.abort()
      clearTimeout(flush)
    }
  }, [code])

  const asRef = useRef(as)
  asRef.current = as
  const send = useCallback(
    async (body: string, opts: SendOptions) => {
      if (!keys) throw new Error("channel not ready")
      return new Channel(keys, location.origin, asRef.current).send(body, opts)
    },
    [keys]
  )

  return { keys, connection, error, messages, send }
}

export interface Agent {
  name: string
  lastSeen: number
  count: number
  /** Most recent status/done message, if any. */
  status?: Message
}

/** Everyone who has posted, most recently active first. */
export function useAgents(messages: Message[]): Agent[] {
  return useMemo(() => {
    const byName = new Map<string, Agent>()
    for (const m of messages) {
      const a = byName.get(m.from) ?? { name: m.from, lastSeen: 0, count: 0 }
      a.lastSeen = Math.max(a.lastSeen, m.ts)
      a.count++
      if (m.kind === "status" || m.kind === "done") a.status = m
      byName.set(m.from, a)
    }
    return [...byName.values()].sort((a, b) => b.lastSeen - a.lastSeen)
  }, [messages])
}

/** Asks and blockers nobody has replied to yet (no later message with `re` pointing at them). */
export function useOpenAsks(messages: Message[]): Message[] {
  return useMemo(() => {
    const answered = new Set<number>()
    for (const m of messages) for (const r of m.re ?? []) answered.add(r)
    return messages.filter((m) => (m.kind === "ask" || m.kind === "blocking") && !answered.has(m.seq))
  }, [messages])
}
