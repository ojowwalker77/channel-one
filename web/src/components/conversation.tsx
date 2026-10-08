import { ArrowDownIcon, ChevronLeftIcon, InfoIcon, SearchIcon, XIcon } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"

import type { Message } from "@mc/protocol.ts"
import { useAuth } from "@/lib/auth"
import { channelTitle, forgetChannel, loadRecent, saveRecent, useChannel, type StoredMember } from "@/lib/channel"
import { excerpt, memberName } from "@/lib/format"
import { cx } from "@/lib/utils"
import { Bubble, EventLine, TimeMark } from "./bubble"
import { Composer } from "./composer"
import { Details, type Filter } from "./details"
import { AvatarStack, Button, IconButton, Segmented, Spinner, TextField } from "./kit"
import { TaskDetail, Tasks } from "./tasks"

/** A gap this long (or a new day) gets a timestamp, like Messages. */
const TIME_GAP = 15 * 60_000
/** Messages this close together from one sender form one run of bubbles. */
const RUN_GAP = 5 * 60_000

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

/** Unread count in the tab title while the tab is in the background. */
function useTitleBadge(count: number) {
  const [base, setBase] = useState(count)
  useEffect(() => {
    const onVisible = () => !document.hidden && setBase(count)
    if (!document.hidden) setBase(count)
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [count])
  useEffect(() => {
    const unread = count - base
    document.title = unread > 0 ? `(${unread}) channel-one` : "channel-one"
    return () => {
      document.title = "channel-one"
    }
  }, [count, base])
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

export function Conversation({ member, onBack, onGone }: { member: StoredMember; onBack: () => void; onGone: () => void }) {
  const me = member.identity.name
  const auth = useAuth()
  const { ch, connection, gone, messages, roster, state, online, isOwner, requests, send, refreshRequests, refreshRoster } = useChannel(member, auth.token)
  const now = useNow()
  const [tab, setTab] = useState<"chat" | "tasks">("chat")
  const [details, setDetails] = useState(false)
  const [filter, setFilter] = useState<Filter | null>(null)
  const [search, setSearch] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [openTask, setOpenTask] = useState<number | null>(null)
  const [highlight, setHighlight] = useState<number | null>(null)

  const nameOf = useCallback((name: string) => memberName(state.members.get(name), name), [state.members])
  const active = useMemo(() => [...state.members.values()].filter((m) => m.active), [state.members])
  const others = useMemo(() => active.filter((m) => m.name !== me), [active, me])
  const people = useMemo(() => active.map((m) => ({ name: m.name, label: memberName(m) })), [active])
  const title = channelTitle(member, others.length ? { from: "", text: "", ts: 0, people: others.map((m) => memberName(m)) } : loadRecent(member.code))
  const forMe = useMemo(() => messages.filter((m) => m.from !== me && m.to?.includes(me)), [messages, me])
  useTitleBadge(messages.filter((m) => m.from !== me).length)

  // Remember the latest message and who's here, for the channel list.
  useEffect(() => {
    const last = [...messages].reverse().find((m) => m.kind !== "event" && state.trust.get(m.seq) !== "forged")
    const prior = loadRecent(member.code)
    if (!last && !others.length) return
    saveRecent(member.code, {
      from: last ? (last.from === me ? "You" : nameOf(last.from)) : (prior?.from ?? ""),
      text: last ? (last.imgs?.length && last.body === last.imgs.map((i) => i.name).join(", ") ? "Photo" : excerpt(last.body, 120)) : (prior?.text ?? ""),
      ts: last?.ts ?? prior?.ts ?? member.at,
      people: others.length ? others.map((m) => memberName(m)) : (prior?.people ?? []),
    })
  }, [messages, others, state.trust, member.code, member.at, nameOf, me])

  const visible = useMemo(() => {
    let list = filter?.kind === "open" ? state.openAsks : filter?.kind === "mine" ? forMe : filter?.kind === "from" ? messages.filter((m) => m.from === filter.name) : messages
    // Joins are noise; the member list already shows who's here.
    list = list.filter((m) => m.ev?.op !== "hello")
    const q = search?.trim().toLowerCase()
    if (q) list = list.filter((m) => m.body.toLowerCase().includes(q) || nameOf(m.from).toLowerCase().includes(q))
    return list
  }, [filter, state.openAsks, forMe, messages, search, nameOf])

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
      const go = () => {
        const el = document.getElementById(`m${seq}`)
        if (!el) return
        el.scrollIntoView({ block: "center", behavior: "smooth" })
        setHighlight(seq)
        setTimeout(() => setHighlight((h) => (h === seq ? null : h)), 1500)
      }
      if (!visible.some((m) => m.seq === seq)) {
        setFilter(null)
        setSearch(null)
        requestAnimationFrame(() => requestAnimationFrame(go))
      } else go()
    },
    [visible]
  )

  const onReply = useCallback((m: Message) => setReplyTo(m), [])

  if (gone) {
    return (
      <Centered>
        <p className="text-[20px] font-semibold">{gone === "closed" ? "This channel was closed" : "You’re no longer in this channel"}</p>
        <p className="max-w-sm text-[13px] text-label-2">
          {gone === "closed" ? "The owner deleted it, and nothing is left at the relay." : "The owner removed this browser, or it left."} This browser has forgotten it too.
        </p>
        <Button className="mt-3" onClick={onGone}>
          OK
        </Button>
      </Centered>
    )
  }

  // Build the transcript: timestamps between bursts, runs of bubbles per sender.
  const rows: ReactNode[] = []
  for (let i = 0; i < visible.length; i++) {
    const m = visible[i]!
    const prev = visible[i - 1]
    const next = visible[i + 1]
    const breakBefore = !prev || m.ts - prev.ts > TIME_GAP || !sameDay(prev.ts, m.ts)
    if (breakBefore) rows.push(<TimeMark key={`t${m.seq}`} ts={m.ts} />)
    if (m.kind === "event") {
      rows.push(<EventLine key={m.seq} m={m} state={state} onOpenTask={setOpenTask} />)
      continue
    }
    const joins = (a: Message | undefined, b: Message) => !!a && a.kind !== "event" && a.from === b.from && Math.abs(b.ts - a.ts) < RUN_GAP && sameDay(a.ts, b.ts)
    const nextBreaks = !next || next.ts - m.ts > TIME_GAP || !sameDay(m.ts, next.ts)
    rows.push(
      <Bubble
        key={m.seq}
        m={m}
        me={me}
        author={state.members.get(m.from)}
        trust={state.trust.get(m.seq)}
        first={breakBefore || !joins(prev, m)}
        last={nextBreaks || !next || !joins(m, next)}
        highlighted={highlight === m.seq}
        quoted={quoted}
        nameOf={nameOf}
        onReply={onReply}
        onJump={jump}
      />
    )
  }

  const filterLabel =
    filter?.kind === "from" ? `Only ${nameOf(filter.name)}` : filter?.kind === "open" ? "Open questions" : filter?.kind === "mine" ? "Messages to you" : null
  const openTasks = [...state.tasks.values()].filter((t) => t.state !== "done").length
  const subtitle =
    connection !== "live"
      ? connection === "connecting"
        ? "Connecting…"
        : "Reconnecting…"
      : `${active.length} ${active.length === 1 ? "member" : "members"}${online.size ? ` · ${online.size} online` : ""}`

  return (
    <div className="flex h-full min-w-0 flex-1">
      <div className={cx("relative flex min-w-0 flex-1 flex-col", details && "hidden md:flex")}>
        <header className="z-10 flex h-[52px] shrink-0 items-center gap-2 border-b border-separator bg-bg/85 px-2 backdrop-blur-xl md:px-4">
          <IconButton label="Channels" tone="blue" className="md:hidden" onClick={onBack}>
            <ChevronLeftIcon />
          </IconButton>
          <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 text-left" onClick={() => setDetails((d) => !d)}>
            <AvatarStack names={others.map((m) => memberName(m))} size={32} />
            <span className="min-w-0">
              <span className="block truncate text-[15px] leading-tight font-semibold">{title}</span>
              <span className={cx("block truncate text-[12px] leading-tight", connection === "live" ? "text-label-2" : "text-orange")}>{subtitle}</span>
            </span>
          </button>
          <div className="hidden sm:block">
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: "chat", label: "Chat" },
                { value: "tasks", label: openTasks ? `Tasks ${openTasks}` : "Tasks" },
              ]}
            />
          </div>
          {tab === "chat" && (
            <IconButton label="Search" onClick={() => setSearch((s) => (s === null ? "" : null))}>
              <SearchIcon />
            </IconButton>
          )}
          <IconButton label="Details" tone={details ? "blue" : "gray"} onClick={() => setDetails((d) => !d)}>
            <InfoIcon />
            {isOwner && requests.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-red text-[10px] font-semibold text-white">{requests.length}</span>
            )}
          </IconButton>
        </header>

        <div className="flex justify-center border-b border-separator py-1.5 sm:hidden">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: "chat", label: "Chat" },
              { value: "tasks", label: openTasks ? `Tasks ${openTasks}` : "Tasks" },
            ]}
          />
        </div>

        {isOwner && requests.length > 0 && !details && (
          <button
            type="button"
            onClick={() => setDetails(true)}
            className="animate-rise mx-auto mt-2 rounded-full bg-blue px-3.5 py-1 text-[13px] font-medium text-white shadow-sm hover:brightness-110"
          >
            {requests.length === 1 ? `${requests[0]!.name} wants to join` : `${requests.length} requests to join`}
          </button>
        )}

        {tab === "tasks" ? (
          <Tasks state={state} now={now} onOpen={setOpenTask} />
        ) : (
          <>
            {(search !== null || filterLabel) && (
              <div className="flex shrink-0 items-center gap-2 px-3 pt-2 md:px-5">
                {search !== null && (
                  <TextField
                    autoFocus
                    value={search}
                    placeholder="Search"
                    className="h-8 text-[14px]"
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => e.key === "Escape" && setSearch(null)}
                  />
                )}
                {filterLabel && (
                  <button
                    type="button"
                    onClick={() => setFilter(null)}
                    className="flex shrink-0 items-center gap-1 rounded-full bg-blue/12 px-3 py-1 text-[13px] font-medium text-blue hover:bg-blue/20"
                  >
                    {filterLabel}
                    <XIcon className="size-3.5" />
                  </button>
                )}
              </div>
            )}

            <div
              ref={scroller}
              className="flex-1 overflow-y-auto pb-3"
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
                  <p className="text-[15px] font-semibold">{search ? "No Results" : filter ? "Nothing here" : "No Messages Yet"}</p>
                  <p className="max-w-xs text-[13px] text-label-2">
                    {search ? `Nothing mentions “${search}”.` : filter ? "Nothing matches this filter." : "Messages from agents appear here the moment they’re sent."}
                  </p>
                </Centered>
              ) : (
                rows
              )}
            </div>

            {behind > 0 && (
              <button
                type="button"
                onClick={toBottom}
                className="animate-rise absolute bottom-20 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-elevated px-3 py-1.5 text-[13px] font-medium text-blue shadow-[0_6px_24px_rgba(0,0,0,0.15)] ring-1 ring-separator"
              >
                <ArrowDownIcon className="size-3.5" />
                {behind} new
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

      {details && (
        <Details
          code={member.code}
          title={title}
          me={me}
          isOwner={isOwner}
          roster={roster}
          requests={requests}
          online={online}
          state={state}
          mentions={forMe.length}
          now={now}
          onDismiss={() => setDetails(false)}
          onFilter={(f) => {
            setFilter(f)
            setTab("chat")
            if (window.innerWidth < 768) setDetails(false)
          }}
          onApprove={async (r) => {
            await ch.approveWithSponsor(r)
            await Promise.all([refreshRequests(), refreshRoster()])
          }}
          onDeny={async (r) => {
            await ch.deny(r.id)
            await refreshRequests()
          }}
          onRemove={async (m) => {
            await ch.remove(m.pk)
            await refreshRoster()
          }}
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
        />
      )}

      <TaskDetail id={openTask} state={state} messages={messages} now={now} onClose={() => setOpenTask(null)} onOpen={setOpenTask} />
    </div>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-60 flex-1 flex-col items-center justify-center gap-1 p-8 text-center">{children}</div>
}
