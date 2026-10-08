import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Channel, RelayError, type SendOptions } from "@mc/client.ts"
import { deriveChannel, fromB64url, type ChannelKeys } from "@mc/crypto.ts"
import { generateIdentity, type Identity } from "@mc/identity.ts"
import type { Message, Presence } from "@mc/protocol.ts"
import { fold, type ChannelState } from "@mc/state.ts"

/** How much history to load when the page opens. */
const HISTORY = 2_000
/** Presence beacons arrive every 60s; treat 2.5 missed beats as offline. */
const PRESENCE_TTL = 150_000

export type Connection = "unlocking" | "connecting" | "live" | "reconnecting" | "error"

export interface Online {
  client: string
  role?: string
  at: number
}

export interface ChannelHandle {
  keys: ChannelKeys | null
  connection: Connection
  error: string | null
  messages: Message[]
  state: ChannelState
  online: Map<string, Online>
  identity: Identity | null
  send: (body: string, opts: SendOptions) => Promise<number>
}

/**
 * Parse the URL fragment: `#<join code>` or `#<join code>&id=<identity>`,
 * where the identity comes from `mc web --sign-in`.
 */
export function parseHash(hash: string): { code: string; identity: Identity | null } {
  const raw = hash.replace(/^#/, "")
  const [codePart, ...rest] = raw.split("&id=")
  let identity: Identity | null = null
  if (rest.length) {
    try {
      identity = JSON.parse(new TextDecoder().decode(fromB64url(rest.join("&id=")))) as Identity
    } catch {
      identity = null
    }
  }
  return { code: decodeURIComponent(codePart ?? "").trim(), identity }
}

const ID_KEY = (name: string) => `mc.identity.${name}`

/** The browser's signing identity for `name`: imported from a sign-in link, or created once and kept. */
export async function browserIdentity(name: string, imported: Identity | null): Promise<Identity> {
  if (imported && imported.name === name) {
    localStorage.setItem(ID_KEY(name), JSON.stringify(imported))
    return imported
  }
  const stored = localStorage.getItem(ID_KEY(name))
  if (stored) return JSON.parse(stored) as Identity
  const fresh = await generateIdentity(name)
  localStorage.setItem(ID_KEY(name), JSON.stringify(fresh))
  return fresh
}

/** Open a channel by join code, stream messages and presence, fold shared state. */
export function useChannel(code: string, me: string, imported: Identity | null): ChannelHandle {
  const [keys, setKeys] = useState<ChannelKeys | null>(null)
  const [connection, setConnection] = useState<Connection>("unlocking")
  const [error, setError] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [online, setOnline] = useState<Map<string, Online>>(new Map())
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    void browserIdentity(me, imported).then(setIdentity)
  }, [me, imported])

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    // Batch incoming messages so a history replay renders once, not thousands of times.
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
    const onPresence = (p: Presence & { sigOk: boolean }) => {
      if (p.client === "probe" || (p.pk && !p.sigOk)) return
      setOnline((prev) => new Map(prev).set(p.from, { client: p.client, role: p.role, at: Date.now() }))
    }

    ;(async () => {
      setConnection("unlocking")
      setError(null)
      setMessages([])
      const k = await deriveChannel(code)
      if (cancelled) return
      setKeys(k)
      setConnection("connecting")
      const ch = new Channel(k, location.origin, null, "web")
      const head = await ch.head()
      await ch.stream(Math.max(0, head - HISTORY), enqueue, {
        signal: ac.signal,
        onOpen: ({ presence }) => {
          setConnection("live")
          // Ask every listening agent to announce itself right away.
          void presence({ client: "probe", query: true })
        },
        onStatus: () => setConnection("reconnecting"),
        onPresence,
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

  const state = useMemo(() => fold(messages, now), [messages, now])
  const live = useMemo(() => new Map([...online].filter(([, o]) => now - o.at < PRESENCE_TTL)), [online, now])

  const idRef = useRef(identity)
  idRef.current = identity
  const send = useCallback(
    async (body: string, opts: SendOptions) => {
      if (!keys || !idRef.current) throw new Error("channel not ready")
      return new Channel(keys, location.origin, idRef.current).send(body, opts)
    },
    [keys]
  )

  return { keys, connection, error, messages, state, online: live, identity, send }
}
