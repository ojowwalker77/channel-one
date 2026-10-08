import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Channel, ChannelGone, type HumanSession, type SendOptions } from "@mc/client.ts"
import { decodeJoinCode, fromB64url, newRoomId, type ChannelAccess } from "@mc/crypto.ts"
import { generateIdentity, withExchangeKey, type Identity } from "@mc/identity.ts"
import { handleFor, type JoinRequest, type Member } from "@mc/membership.ts"
import type { Message, Presence } from "@mc/protocol.ts"
import { fold, type ChannelState, type Roster } from "@mc/state.ts"

/** How much history to load when the page opens. */
const HISTORY = 2_000
/** Presence beacons arrive every 60s; treat 2.5 missed beats as offline. */
const PRESENCE_TTL = 150_000

export type Connection = "connecting" | "live" | "reconnecting"

export interface Online {
  client: string
  role?: string
  at: number
}

// ---------- the URL fragment ----------

/**
 * `#<join code>` or `#<join code>&id=<identity>`: the second form comes from
 * `mc web` on the owner's machine (or `--sign-in`) and carries a member key.
 * Fragments never reach the server.
 */
/** `#sponsor=<request>&code=<join code>&agent=<name>`: the link an agent prints for its human. */
export function parseSponsorHash(hash: string): { requestId: string; code: string; agent: string } | null {
  const raw = hash.replace(/^#/, "")
  if (!raw.startsWith("sponsor=")) return null
  const p = new URLSearchParams(raw)
  const requestId = p.get("sponsor") ?? ""
  const code = p.get("code") ?? ""
  if (!/^[0-9a-f-]{36}$/.test(requestId) || !isJoinCode(code)) return null
  return { requestId, code, agent: (p.get("agent") ?? "agent").slice(0, 32) }
}

export function parseHash(hash: string): { code: string; identity: Identity | null } {
  const raw = hash.replace(/^#/, "")
  if (raw.startsWith("sponsor=")) return { code: "", identity: null }
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

export function isJoinCode(code: string): boolean {
  try {
    decodeJoinCode(code)
    return true
  } catch {
    return false
  }
}

// ---------- membership stored in this browser ----------

/** This browser's membership in one channel: who it is there, and the keys it holds. */
export interface StoredMember {
  code: string
  identity: Identity
  access: ChannelAccess
  at: number
  /** A label for the channel, known to whoever created it here. */
  name?: string
}

/** A join request this browser is waiting on. */
export interface PendingJoin {
  code: string
  identity: Identity
  requestId: string
  verify: string
}

const MEMBER_KEY = (code: string) => `mc.member.${code}`
const PENDING_KEY = (code: string) => `mc.pending.${code}`
const REGISTRY_KEY = "mc.channels"

function read<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") as T | null
  } catch {
    return null
  }
}

export function loadMember(code: string): StoredMember | null {
  return read<StoredMember>(MEMBER_KEY(code))
}

export function saveMember(m: StoredMember): void {
  localStorage.setItem(MEMBER_KEY(m.code), JSON.stringify(m))
  localStorage.removeItem(PENDING_KEY(m.code))
  rememberChannel(m.code)
}

export function loadPending(code: string): PendingJoin | null {
  return read<PendingJoin>(PENDING_KEY(code))
}

export function savePending(p: PendingJoin): void {
  localStorage.setItem(PENDING_KEY(p.code), JSON.stringify(p))
}

/** Forget a channel in this browser: identity, keys, pending request, registry entry. */
export function forgetChannel(code: string): void {
  localStorage.removeItem(MEMBER_KEY(code))
  localStorage.removeItem(PENDING_KEY(code))
  try {
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(knownChannels().filter((c) => c.code !== code)))
  } catch {}
}

export interface KnownChannel {
  code: string
  at: number
  name?: string
}

/** Channels this browser is a member of, newest first. */
export function knownChannels(): KnownChannel[] {
  const raw = read<KnownChannel[]>(REGISTRY_KEY)
  return Array.isArray(raw) ? raw.filter((c) => c && typeof c.code === "string" && loadMember(c.code)) : []
}

function rememberChannel(code: string): void {
  const name = loadMember(code)?.name
  const next = [{ code, at: Date.now(), ...(name ? { name } : {}) }, ...knownChannels().filter((c) => c.code !== code)].slice(0, 20)
  try {
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(next))
  } catch {}
}

/**
 * Become a member from a link that carries a member key (the owner's, from
 * `mc web`): fetch and unwrap this key's channel keys.
 */
export async function memberFromLink(code: string, identity: Identity): Promise<StoredMember> {
  const { roomId } = decodeJoinCode(code)
  const id = await withExchangeKey(identity)
  const probe = new Channel({ roomId, ownerPk: "", ownerXpk: "", epoch: 0, keys: {} }, location.origin, id)
  const info = await probe.info()
  const ch = new Channel({ roomId, ownerPk: info.ownerPk, ownerXpk: info.ownerXpk, epoch: info.epoch, keys: {} }, location.origin, id)
  await ch.refreshKeys()
  const m: StoredMember = { code, identity: id, access: ch.access, at: Date.now() }
  saveMember(m)
  return m
}

/**
 * Create a channel owned by this browser's human. The owner key is generated
 * here and never leaves this browser; on relays that require sign-in, `token`
 * proves who the human is.
 */
/** A signed-in person, as the browser knows them from AuthKit. */
export interface Person {
  id: string
  email: string
  firstName?: string | null
  lastName?: string | null
}

export function personName(p: Person): string {
  return [p.firstName, p.lastName].filter(Boolean).join(" ") || p.email
}

export async function createChannel(name: string, token: string | null, me: Person | null): Promise<StoredMember> {
  const roomId = newRoomId()
  // The owner appears under their real name, not as "human".
  const handle = me ? handleFor(personName(me), me.email) : "human"
  const owner = await generateIdentity(handle)
  const info = me
    ? { name: handle, role: "owner", kind: "human" as const, display: personName(me), sponsor: { user: me.id, name: personName(me), handle } }
    : { name: "human", role: "owner" }
  const { code, access } = await Channel.create(location.origin, owner, info, [], roomId, token)
  const m: StoredMember = { code, identity: owner, access, at: Date.now(), name }
  saveMember(m)
  return m
}

/** Ask to join from this browser (as a signed-in person); resumes an earlier request for the same code. */
export async function askToJoin(code: string, name: string, role?: string, token?: string | null): Promise<PendingJoin> {
  const prior = loadPending(code)
  const identity = prior && prior.identity.name === name ? prior.identity : await generateIdentity(name)
  const r = await Channel.requestJoin(location.origin, code, identity, { name, ...(role ? { role } : {}) }, token)
  const p: PendingJoin = { code, identity, requestId: r.requestId, verify: r.verify }
  savePending(p)
  return p
}

export async function checkJoin(p: PendingJoin): Promise<"pending" | "denied" | StoredMember> {
  const st = await Channel.joinStatus(location.origin, p.code, p.identity, p.requestId)
  if (st.status !== "approved") return st.status
  const m: StoredMember = { code: p.code, identity: p.identity, access: st.access, at: Date.now() }
  saveMember(m)
  return m
}

// ---------- the live channel ----------

export interface ChannelHandle {
  ch: Channel
  connection: Connection
  /** Set when this browser was removed or the owner closed the channel. */
  gone: "removed" | "closed" | null
  messages: Message[]
  roster: Member[]
  state: ChannelState
  online: Map<string, Online>
  isOwner: boolean
  requests: JoinRequest[]
  send: (body: string, opts: SendOptions) => Promise<number>
  refreshRequests: () => Promise<void>
  refreshRoster: () => Promise<void>
}

/** Stream a channel as a member: messages, presence, member list, and (for the owner) join requests. */
export function useChannel(member: StoredMember, human?: HumanSession): ChannelHandle {
  const humanRef = useRef(human)
  humanRef.current = human
  const ch = useMemo(
    () =>
      new Channel(
        member.access,
        location.origin,
        member.identity,
        (access) => saveMember({ ...member, access }),
        async () => (humanRef.current ? humanRef.current() : null)
      ),
    [member]
  )
  const [connection, setConnection] = useState<Connection>("connecting")
  const [gone, setGone] = useState<"removed" | "closed" | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [roster, setRoster] = useState<Member[]>([])
  const [online, setOnline] = useState<Map<string, Online>>(new Map())
  const [requests, setRequests] = useState<JoinRequest[]>([])
  const [now, setNow] = useState(Date.now())
  const isOwner = ch.isOwner

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])

  const onGone = useCallback(
    (err: unknown) => {
      if (!(err instanceof ChannelGone)) return false
      forgetChannel(member.code)
      setGone(err.why)
      return true
    },
    [member.code]
  )

  const refreshRoster = useCallback(async () => {
    try {
      setRoster(await ch.members())
      if (ch.isOwner && (await ch.rotateIfDue())) setRoster(await ch.members())
    } catch (err) {
      onGone(err)
    }
  }, [ch, onGone])

  const refreshRequests = useCallback(async () => {
    if (!ch.isOwner) return
    try {
      setRequests(await ch.requests())
    } catch (err) {
      onGone(err)
    }
  }, [ch, onGone])

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
          return [...prev, ...batch.filter((b) => !seen.has(b.seq))].sort((a, b) => a.seq - b.seq)
        })
      }, 30)
    }
    const onPresence = (p: Presence & { sigOk: boolean }) => {
      if (p.client === "probe" || !p.sigOk) return
      setOnline((prev) => new Map(prev).set(p.from, { client: p.client, role: p.role, at: Date.now() }))
    }

    ;(async () => {
      await Promise.all([refreshRoster(), refreshRequests()])
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
        onRoster: () => void refreshRoster(),
        onRequest: () => void refreshRequests(),
      })
    })().catch((err: unknown) => {
      if (!cancelled) onGone(err)
    })

    return () => {
      cancelled = true
      ac.abort()
      clearTimeout(flush)
    }
  }, [ch, refreshRoster, refreshRequests, onGone])

  // Presence can only be trusted when it's signed by the key the owner admitted under that name.
  const keyOf = useMemo(() => new Map(roster.filter((r) => r.active).map((r) => [r.name, r.pk])), [roster])
  const rosterForFold: Roster = useMemo(
    () =>
      roster.map((m) => ({
        name: m.name,
        pk: m.pk,
        role: m.role,
        about: m.about,
        owner: m.owner,
        at: m.at,
        active: m.active,
        kind: m.kind,
        display: m.display,
        sponsor: m.sponsor,
      })),
    [roster]
  )
  const state = useMemo(() => fold(messages, rosterForFold, now), [messages, rosterForFold, now])
  const live = useMemo(() => new Map([...online].filter(([name, o]) => keyOf.has(name) && now - o.at < PRESENCE_TTL)), [online, keyOf, now])

  const chRef = useRef(ch)
  chRef.current = ch
  const send = useCallback(
    async (body: string, opts: SendOptions) => {
      try {
        return await chRef.current.send(body, opts)
      } catch (err) {
        if (onGone(err)) throw new Error("you no longer have access to this channel")
        throw err
      }
    },
    [onGone]
  )

  return { ch, connection, gone, messages, roster, state, online: live, isOwner, requests, send, refreshRequests, refreshRoster }
}
