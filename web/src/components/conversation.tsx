import { ArrowDown01Icon, ArrowLeft01Icon, Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"

import { ignored, type Color, type Message } from "@mc/protocol.ts"
import { canPost, describeScopes, wireScopes } from "@mc/scopes.ts"
import { colorOf } from "@mc/state.ts"
import { useAuth } from "@/lib/auth"
import { channelTitle, forgetChannel, loadMember, loadRecent, saveMember, saveRecent, useChannel, useClock, useKnownChannels, type StoredMember } from "@/lib/channel"
import { refreshIcon, useIcons, useLiveIcon } from "@/lib/icons"
import { excerpt, memberName } from "@/lib/format"
import { cx } from "@/lib/utils"
import { ChannelIconTile } from "./channel-icon"
import { Composer } from "./composer"
import { ChannelControls, ChannelMenu, InviteButton, People, RequestsBanner, type Filter } from "./controls"
import { Icon } from "./icon"
import { Button, IconButton, Spinner, Tabs, TextField } from "./kit"
import { DayMark, EventGroup, EventRow, MessageRow, isAgent, standsAlone, type ThreadSummary } from "./message"
import { TaskDetail, Tasks } from "./tasks"
import { ThreadPanel } from "./thread"

/** Messages this close together from one sender read as one run. */
const RUN_GAP = 5 * 60_000

function useNow(intervalMs = 30_000): number {
  return useClock(intervalMs)
}

/** Unread count in the tab title while the tab is in the background. */
function useTitleBadge(count: number) {
  const [mark, setMark] = useState(count)
  const [hidden, setHidden] = useState(() => document.hidden)
  useEffect(() => {
    const onChange = () => {
      if (document.hidden) setMark(count)
      setHidden(document.hidden)
    }
    document.addEventListener("visibilitychange", onChange)
    return () => document.removeEventListener("visibilitychange", onChange)
  }, [count])
  const base = hidden ? mark : count
  useEffect(() => {
    const unread = count - base
    document.title = unread > 0 ? `(${unread}) Channels` : "Channels"
    return () => {
      document.title = "Channels"
    }
  }, [count, base])
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

export function Conversation({ member, onBack, onGone }: { member: StoredMember; onBack: () => void; onGone: () => void }) {
  const me = member.identity.name
  const auth = useAuth()
  const { ch, connection, gone, messages, roster, state, online, isOwner, requests, send, refreshRequests, refreshRoster } = useChannel(member, auth.token)
  useLiveIcon(member)
  const icon = useIcons().get(member.access.roomId) ?? null
  const now = useNow()
  const [tab, setTab] = useState<"chat" | "tasks">("chat")
  const [filter, setFilter] = useState<Filter | null>(null)
  const [search, setSearch] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  /** The thread open on the right, by its first message. */
  const [threadRoot, setThreadRoot] = useState<number | null>(null)
  const [openTask, setOpenTask] = useState<number | null>(null)
  const [highlight, setHighlight] = useState<number | null>(null)

  const nameOf = useCallback((name: string) => memberName(state.members.get(name), name), [state.members])
  // Members by key: names are what people type, keys are who they are.
  const byKey = useMemo(() => new Map(roster.map((r) => [r.pk, r])), [roster])
  const memberCount = roster.filter((r) => r.active).length || state.members.size
  const active = useMemo(() => [...state.members.values()].filter((m) => m.active), [state.members])
  const others = useMemo(() => active.filter((m) => m.name !== me), [active, me])
  const people = useMemo(() => active.map((m) => ({ name: m.name, label: memberName(m), agent: isAgent(m), color: colorOf(state, m.name) })), [active, state])
  // The channel's name can arrive after this view opens (members decrypt it), so follow the list.
  const known = useKnownChannels()
  const title = channelTitle(
    // The list has the latest name (a rename lands there); the member record this view opened with may be older.
    { name: known.find((c) => c.code === member.code)?.name ?? member.name },
    others.length ? { from: "", text: "", ts: 0, people: others.map((m) => memberName(m)) } : loadRecent(member.code)
  )
  const forMe = useMemo(() => messages.filter((m) => m.from !== me && m.to?.includes(me)), [messages, me])
  const openTasks = useMemo(() => [...state.tasks.values()].filter((t) => t.state !== "done" && t.state !== "cancelled").length, [state.tasks])
  useTitleBadge(messages.filter((m) => m.from !== me).length)

  // Remember the latest message and who's here, for the channel list.
  useEffect(() => {
    const last = [...messages].reverse().find((m) => m.kind !== "event" && !ignored(state.trust.get(m.seq)))
    const prior = loadRecent(member.code)
    if (!last && !others.length) return
    saveRecent(member.code, {
      from: last ? (last.from === me ? "You" : nameOf(last.from)) : (prior?.from ?? ""),
      text: last ? (last.imgs?.length && last.body === last.imgs.map((i) => i.name).join(", ") ? "Image" : excerpt(last.body, 120)) : (prior?.text ?? ""),
      ts: last?.ts ?? prior?.ts ?? member.at,
      people: others.length ? others.map((m) => memberName(m)) : (prior?.people ?? []),
    })
  }, [messages, others, state.trust, member.code, member.at, nameOf, me])

  // Replies live in their thread. A reply whose first message isn't loaded stays in the timeline, with its quote line.
  const bySeqAll = useMemo(() => new Map(messages.map((m) => [m.seq, m])), [messages])
  const rootOf = useCallback(
    (seq: number) => {
      const root = state.threadOf.get(seq)
      return root !== undefined && root !== seq && bySeqAll.has(root) ? root : null
    },
    [state.threadOf, bySeqAll]
  )
  const threads = useMemo(() => {
    const out = new Map<number, Message[]>()
    for (const m of messages) {
      if (m.kind === "event") continue
      const root = rootOf(m.seq)
      if (root === null) continue
      const list = out.get(root)
      if (list) list.push(m)
      else out.set(root, [m])
    }
    return out
  }, [messages, rootOf])

  const visible = useMemo(() => {
    // Filters and search show every match flat, threads or not.
    const flat = !!filter || !!search?.trim()
    let list = filter?.kind === "open" ? state.openAsks : filter?.kind === "mine" ? forMe : filter?.kind === "from" ? messages.filter((m) => m.from === filter.name) : messages
    if (!flat) list = list.filter((m) => m.kind === "event" || rootOf(m.seq) === null)
    // Joins are noise; the member list already shows who's here.
    list = list.filter((m) => m.ev?.op !== "hello")
    const q = search?.trim().toLowerCase()
    if (q) list = list.filter((m) => m.body.toLowerCase().includes(q) || nameOf(m.from).toLowerCase().includes(q))
    return list
  }, [filter, state.openAsks, forMe, messages, search, nameOf, rootOf])

  const bySeq = useMemo(() => new Map(messages.map((m) => [m.seq, m])), [messages])
  const quoted = useCallback((seq: number) => bySeq.get(seq), [bySeq])

  // ---------- scrolling: stick to the bottom unless the reader scrolled up ----------
  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const [behind, setBehind] = useState(0)
  const lastCount = useRef(0)

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const added = visible.length - lastCount.current
    lastCount.current = visible.length
    if (atBottom.current) el.scrollTop = el.scrollHeight
    else if (added > 0) setBehind((b) => b + added)
  }, [visible, tab])

  const toBottom = () => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
    setBehind(0)
  }

  const jump = useCallback(
    (seq: number) => {
      setHighlight(seq)
      setTimeout(() => setHighlight((h) => (h === seq ? null : h)), 1600)
      const inThread = rootOf(seq)
      if (inThread !== null) setThreadRoot(inThread)
      const go = (left: number) => {
        const el = document.getElementById(`${inThread !== null ? "t" : "m"}${seq}`)
        if (!el) {
          if (left > 0) requestAnimationFrame(() => go(left - 1))
          return
        }
        el.scrollIntoView({ block: "center", behavior: "smooth" })
      }
      // Two frames so a collapsed run can open before we look for the row.
      const start = () => requestAnimationFrame(() => requestAnimationFrame(() => go(1)))
      if (inThread === null && !visible.some((m) => m.seq === seq)) {
        setFilter(null)
        setSearch(null)
        start()
      } else start()
    },
    [visible, rootOf]
  )

  // Replying opens the message's thread, so the answer doesn't land in the main timeline.
  const onReply = useCallback((m: Message) => setThreadRoot(rootOf(m.seq) ?? m.seq), [rootOf])
  const peopleOf = useCallback(
    (list: Message[]) => {
      const seen = new Map<string, { name: string; label: string; agent: boolean; color: Color | null }>()
      for (const r of list) if (!seen.has(r.from)) seen.set(r.from, { name: r.from, label: nameOf(r.from), agent: isAgent(state.members.get(r.from)), color: colorOf(state, r.from) })
      return [...seen.values()]
    },
    [nameOf, state]
  )
  const summaryOf = (seq: number): ThreadSummary | undefined => {
    const list = threads.get(seq)
    if (!list?.length) return undefined
    return { count: list.length, last: list[list.length - 1]!.ts, people: peopleOf(list), forYou: list.some((r) => r.from !== me && r.to?.includes(me)) }
  }

  if (gone) {
    return (
      <Centered>
        <p className="text-[15px] font-semibold">{gone === "closed" ? "This channel was closed" : "You’re no longer in this channel"}</p>
        <p className="mt-1 max-w-sm text-[13px] leading-normal text-ink-2">
          {gone === "closed" ? "Its owner deleted it, and nothing is left on the relay." : "The owner removed this browser, or it left."} This browser has forgotten it too.
        </p>
        <Button className="mt-4" onClick={onGone}>
          Back to channels
        </Button>
      </Centered>
    )
  }

  // The transcript: day marks, and runs of messages from one sender under one name.
  const rows: ReactNode[] = []
  for (let i = 0; i < visible.length; i++) {
    const m = visible[i]!
    const prev = visible[i - 1]
    const newDay = !prev || !sameDay(prev.ts, m.ts)
    if (newDay) rows.push(<DayMark key={`d${m.seq}`} ts={m.ts} />)
    if (m.kind === "event") {
      const batch: Message[] = [m]
      let j = i + 1
      while (j < visible.length && visible[j]!.kind === "event" && sameDay(m.ts, visible[j]!.ts)) {
        batch.push(visible[j]!)
        j++
      }
      i = j - 1
      let fold: Message[] = []
      const flush = () => {
        if (!fold.length) return
        rows.push(<EventGroup key={`e${fold[0]!.seq}`} messages={fold} state={state} onOpenTask={setOpenTask} highlight={highlight} />)
        fold = []
      }
      for (const ev of batch) {
        if (standsAlone(ev, state, me)) {
          flush()
          rows.push(<EventRow key={ev.seq} m={ev} state={state} onOpenTask={setOpenTask} />)
        } else fold.push(ev)
      }
      flush()
      continue
    }
    const adjacentReply = m.re?.length === 1 && prev?.seq === m.re[0]
    const head = newDay || !prev || prev.kind === "event" || prev.from !== m.from || m.ts - prev.ts > RUN_GAP || (!!m.re?.length && !adjacentReply)
    rows.push(
      <MessageRow
        key={m.seq}
        m={m}
        me={me}
        author={(m.pk && byKey.get(m.pk)) || state.members.get(m.from)}
        trust={state.trust.get(m.seq)}
        online={online.has(m.from)}
        color={colorOf(state, m.from)}
        head={head}
        adjacentReply={adjacentReply}
        highlighted={highlight === m.seq}
        quoted={quoted}
        nameOf={nameOf}
        onReply={onReply}
        onJump={jump}
        thread={search || filter ? undefined : summaryOf(m.seq)}
        onOpenThread={setThreadRoot}
      />
    )
  }

  // The open thread: its first message, then every reply, grouped the same way.
  const root = threadRoot === null ? undefined : bySeqAll.get(threadRoot)
  const replies = threadRoot === null ? [] : (threads.get(threadRoot) ?? [])
  const threadRows: ReactNode[] = []
  if (root) {
    const list = [root, ...replies]
    list.forEach((m, i) => {
      const prev = list[i - 1]
      const head = !prev || prev.from !== m.from || m.ts - prev.ts > RUN_GAP
      threadRows.push(
        <MessageRow
          key={m.seq}
          anchor="t"
          m={m}
          me={me}
          author={(m.pk && byKey.get(m.pk)) || state.members.get(m.from)}
          trust={state.trust.get(m.seq)}
          online={online.has(m.from)}
          color={colorOf(state, m.from)}
          head={head}
          // Inside a thread, answering the root needs no quote; a reply to a reply still shows what it answers.
          adjacentReply={i > 0 && (m.re?.length ?? 0) === 1 && (m.re![0] === root.seq || m.re![0] === prev?.seq)}
          highlighted={highlight === m.seq}
          quoted={quoted}
          nameOf={nameOf}
          onReply={() => undefined}
          onJump={jump}
        />
      )
      if (i === 0 && replies.length) threadRows.push(<div key="split" className="my-3 h-px bg-line" />)
    })
  }

  const filterLabel = filter?.kind === "from" ? `Only ${nameOf(filter.name)}` : filter?.kind === "open" ? "Unanswered questions" : filter?.kind === "mine" ? "Messages to you" : null
  const subtitle =
    connection === "connecting"
      ? "Connecting…"
      : connection === "reconnecting"
        ? "Reconnecting…"
        : online.size
          ? `${memberCount} members, ${online.size} online`
          : `${memberCount} ${memberCount === 1 ? "member" : "members"}`
  // Who's here right now, people first: a glance at the header says who's working.
  const here = active.filter((m) => online.has(m.name)).sort((a, b) => Number(isAgent(a)) - Number(isAgent(b)))

  const chips: { label: string; f: Filter | null; n?: number }[] = [
    { label: "Everything", f: null },
    { label: "To you", f: { kind: "mine" }, n: forMe.length },
    { label: "Unanswered", f: { kind: "open" }, n: state.openAsks.length },
  ]

  return (
    <ChannelControls
      code={member.code}
      myKey={member.identity.pk}
      isOwner={isOwner}
      roster={roster}
      requests={requests}
      online={online}
      state={state}
      now={now}
      onFilter={(f) => {
        setFilter(f)
        setTab("chat")
      }}
      onApprove={async (r, scopes) => {
        await ch.approve(r, wireScopes(scopes) ? { scopes } : undefined)
        await Promise.all([refreshRequests(), refreshRoster()])
      }}
      onReclaim={async (r, opts) => {
        // The seat keeps what it may do now, scope.set events included (they name the old key).
        await ch.reclaim(r, { ...opts, scopes: r.reclaims ? state.members.get(r.reclaims.name)?.scopes : undefined })
        await Promise.all([refreshRequests(), refreshRoster()])
      }}
      onColor={async (color) => {
        await send(color ? `took ${color}` : "cleared their colour", { kind: "event", ev: { op: "color.set", member: me, color } })
      }}
      onScopes={async (m, scopes) => {
        const wire = wireScopes(scopes)
        await send(`set what ${m.name} may do: ${wire ? describeScopes(wire) : "full"}`, { kind: "event", ev: { op: "scope.set", member: m.name, pk: m.pk, scopes: wire } })
        // The log is the record; the relay's bit follows (and the reconcile puts it right if this fails).
        await ch.setCanPost(m.pk, canPost(scopes))
        await refreshRoster()
      }}
      onRole={async (ev) => {
        await send(ev.op === "role.set" ? `made ${ev.member} ${ev.role ?? "unassigned"}` : `kept ${ev.member}'s role`, { kind: "event", ev })
      }}
      onDeny={async (r) => {
        await ch.deny(r.id)
        await refreshRequests()
      }}
      onCheck={async (r) => {
        await ch.checkRequest(r)
        await refreshRequests()
      }}
      onRemove={async (m) => {
        await ch.remove(m.pk)
        await refreshRoster()
      }}
      roomId={member.access.roomId}
      title={title}
      onRename={
        isOwner
          ? async (name) => {
              await ch.setTitle(name)
              // Show it here at once; other members pick it up from the relay's info frame.
              const stored = loadMember(member.code)
              if (stored) saveMember({ ...stored, name: name.trim().slice(0, 80) })
            }
          : undefined
      }
      onSetIcon={
        isOwner
          ? async (next) => {
              await ch.setIcon(next)
              await refreshIcon(member)
            }
          : undefined
      }
      onCloseChannel={async () => {
        await ch.close()
        forgetChannel(member.code)
        onGone()
      }}
      onLeaveChannel={async () => {
        await ch.leave()
        forgetChannel(member.code)
        onGone()
      }}
    >
      <div className="flex h-full min-w-0 flex-1">
        <div className={cx("relative flex min-w-0 flex-1 flex-col", root && "hidden md:flex")}>
          <header className="flex h-[56px] shrink-0 items-center gap-2 px-3 shadow-[inset_0_-0.5px_0_var(--line)] md:px-5">
            <IconButton label="Channels" className="md:hidden" onClick={onBack}>
              <Icon icon={ArrowLeft01Icon} size={20} />
            </IconButton>
            <ChannelIconTile icon={icon} title={title} size={20} />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[15px] leading-tight font-semibold tracking-[-0.015em]">{title}</h1>
              <People here={here} subtitle={subtitle} live={connection === "live"} />
            </div>
            <Tabs
              value={tab}
              onChange={setTab}
              options={[
                { value: "chat", label: "Chat" },
                { value: "tasks", label: <>Tasks{openTasks > 0 && <span className="text-ink-3 tabular-nums">{openTasks}</span>}</> },
              ]}
            />
            <span className="mx-1 h-4 w-px bg-line" />
            <InviteButton />
            <IconButton label="Search" active={search !== null} onClick={() => setSearch((s) => (s === null ? "" : null))} disabled={tab !== "chat"}>
              <Icon icon={Search01Icon} size={17} />
            </IconButton>
            <ChannelMenu />
          </header>

          <RequestsBanner />

          {tab === "tasks" ? (
            <Tasks
              state={state}
              now={now}
              onOpen={setOpenTask}
              onForgetFact={async (key) => void (await send(`cleared ${key}`, { kind: "event", ev: { op: "fact.del", key } }))}
            />
          ) : (
            <>
              <div className="mx-auto flex w-full max-w-[760px] shrink-0 flex-wrap items-center gap-1.5 px-4 pt-3 pb-1 md:px-8">
                {search !== null && (
                  <TextField
                    autoFocus
                    value={search}
                    placeholder="Search messages"
                    className="mb-1.5 basis-full"
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => e.key === "Escape" && setSearch(null)}
                  />
                )}
                {chips.map((c) => {
                  const on = c.f === null ? filter === null : filter?.kind === c.f.kind
                  return (
                    <button
                      key={c.label}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setFilter(c.f)}
                      className={cx(
                        "flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-colors",
                        on ? "bg-ink text-canvas" : "text-ink-2 shadow-[inset_0_0_0_1px_var(--line)] hover:text-ink"
                      )}
                    >
                      {c.label}
                      {!!c.n && <span className="tabular-nums opacity-70">{c.n}</span>}
                    </button>
                  )
                })}
                {filter?.kind === "from" && (
                  <button
                    type="button"
                    onClick={() => setFilter(null)}
                    className="flex h-7 items-center gap-1 rounded-full bg-ink pr-2 pl-3 text-[12.5px] font-medium text-canvas"
                    title="Show everything"
                  >
                    {filterLabel}
                    <Icon icon={Cancel01Icon} size={12} />
                  </button>
                )}
              </div>

              <div
                ref={scroller}
                className="flex-1 overflow-y-auto"
                onScroll={(e) => {
                  const el = e.currentTarget
                  atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
                  if (atBottom.current && behind) setBehind(0)
                }}
              >
                {connection === "connecting" && messages.length === 0 ? (
                  <Centered>
                    <Spinner />
                  </Centered>
                ) : visible.length === 0 ? (
                  <Centered>
                    <p className="text-[14px] font-semibold">{search ? "No results" : filter ? "Nothing here" : "No messages yet"}</p>
                    <p className="mt-1 max-w-xs text-[13px] leading-normal text-ink-2">
                      {search
                        ? `No message mentions “${search}”.`
                        : filter
                          ? "Clear the filter to see the whole conversation."
                          : "Invite an agent with the Invite button above. What it says shows up here the moment it’s sent."}
                    </p>
                  </Centered>
                ) : (
                  <div className="mx-auto w-full max-w-[760px] px-4 pb-6 md:px-8">{rows}</div>
                )}
              </div>

              {behind > 0 && (
                <button
                  type="button"
                  onClick={toBottom}
                  className="animate-rise absolute bottom-[132px] left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-raised py-1.5 pr-3.5 pl-2.5 text-[12.5px] font-medium shadow-pop"
                >
                  <Icon icon={ArrowDown01Icon} size={15} />
                  {behind === 1 ? "1 new message" : `${behind} new messages`}
                </button>
              )}

              <Composer
                me={me}
                people={people}
                replyTo={replyTo}
                nameOf={nameOf}
                onClearReply={() => setReplyTo(null)}
                disabled={connection === "connecting"}
                send={async (body, opts) => {
                  atBottom.current = true
                  return send(body, opts)
                }}
              />
            </>
          )}
        </div>

        {root && (
          <ThreadPanel
            count={replies.length}
            onClose={() => setThreadRoot(null)}
            composer={<Composer key={root.seq} thread me={me} people={people} replyTo={root} nameOf={nameOf} onClearReply={() => undefined} disabled={connection === "connecting"} send={send} />}
          >
            {threadRows}
          </ThreadPanel>
        )}

        <TaskDetail id={openTask} state={state} messages={messages} now={now} onClose={() => setOpenTask(null)} onOpen={setOpenTask} />
      </div>
    </ChannelControls>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-60 flex-1 flex-col items-center justify-center p-8 text-center">{children}</div>
}
