import { ArrowDown01Icon, ArrowLeft01Icon, Cancel01Icon, InformationCircleIcon, Search01Icon, UserAdd01Icon } from "@hugeicons/core-free-icons"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"

import type { Message } from "@mc/protocol.ts"
import { useAuth } from "@/lib/auth"
import { channelTitle, forgetChannel, loadRecent, saveRecent, useChannel, type StoredMember } from "@/lib/channel"
import { excerpt, memberName } from "@/lib/format"
import { cx } from "@/lib/utils"
import { Bubble, EventLine, TimeMark, voiceFor } from "./bubble"
import { Composer } from "./composer"
import { Details, type Filter } from "./details"
import { Icon } from "./icon"
import { Button, Count, IconButton, Segmented, Spinner, TextField } from "./kit"
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
  const people = useMemo(() => active.map((m) => ({ name: m.name, label: memberName(m), voice: voiceFor(m.name, m) })), [active])
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
      : online.size
        ? `${online.size} of ${active.length} online`
        : `${active.length} ${active.length === 1 ? "member" : "members"}`
  const tabs = [
    { value: "chat" as const, label: "Chat" },
    { value: "tasks" as const, label: <>Tasks<Count n={openTasks} className={tab === "tasks" ? "bg-blue/12 text-blue" : ""} /></> },
  ]

  return (
    <div className="flex h-full min-w-0 flex-1">
      <div className={cx("relative flex min-w-0 flex-1 flex-col", details && "hidden md:flex")}>
        <header className="z-10 flex h-[56px] shrink-0 items-center gap-1.5 bg-bg/80 px-2 shadow-[inset_0_-0.5px_0_var(--separator)] backdrop-blur-2xl backdrop-saturate-150 md:px-4">
          <IconButton label="Channels" tone="blue" className="md:hidden" onClick={onBack}>
            <Icon icon={ArrowLeft01Icon} size={22} />
          </IconButton>
          <button type="button" className="min-w-0 flex-1 rounded-lg px-1 text-left" onClick={() => setDetails((d) => !d)}>
            <span className="block truncate text-[15px] leading-tight font-semibold tracking-[-0.015em]">{title}</span>
            <span className={cx("mt-0.5 flex items-center gap-1.5 truncate text-[12px] leading-tight", connection === "live" ? "text-label-2" : "text-orange")}>
              {connection === "live" && online.size > 0 && <span className="size-1.5 rounded-full bg-green" />}
              {subtitle}
            </span>
          </button>
          <div className="mr-1 hidden sm:block">
            <Segmented value={tab} onChange={setTab} options={tabs} />
          </div>
          {tab === "chat" && (
            <IconButton label="Search" tone={search !== null ? "blue" : "gray"} onClick={() => setSearch((s) => (s === null ? "" : null))}>
              <Icon icon={Search01Icon} size={19} />
            </IconButton>
          )}
          <IconButton label="Details" tone={details ? "blue" : "gray"} onClick={() => setDetails((d) => !d)}>
            <Icon icon={InformationCircleIcon} size={20} />
            {isOwner && requests.length > 0 && <span className="absolute top-1 right-1 size-2 rounded-full bg-red ring-2 ring-[var(--bg)]" />}
          </IconButton>
        </header>

        <div className="flex justify-center py-2 shadow-[inset_0_-0.5px_0_var(--separator)] sm:hidden">
          <Segmented value={tab} onChange={setTab} options={tabs} />
        </div>

        {isOwner && requests.length > 0 && !details && tab === "chat" && (
          <button
            type="button"
            onClick={() => setDetails(true)}
            className="animate-rise absolute top-[68px] left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-elevated/90 py-1.5 pr-3.5 pl-3 text-[13px] font-medium whitespace-nowrap text-blue shadow-[0_8px_30px_-8px_rgba(0,0,0,0.22),0_0_0_0.5px_rgba(0,0,0,0.08)] backdrop-blur-xl transition-colors hover:bg-elevated"
          >
            <Icon icon={UserAdd01Icon} size={15} strokeWidth={1.8} />
            {requests.length === 1 ? `${requests[0]!.name} is asking to join` : `${requests.length} people are asking to join`}
          </button>
        )}

        {tab === "tasks" ? (
          <Tasks state={state} now={now} onOpen={setOpenTask} />
        ) : (
          <>
            {(search !== null || filterLabel) && (
              <div className="mx-auto flex w-full max-w-[800px] shrink-0 items-center gap-2 px-3 pt-3 md:px-6">
                {search !== null && (
                  <TextField
                    autoFocus
                    value={search}
                    placeholder="Search messages"
                    className="h-9"
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => e.key === "Escape" && setSearch(null)}
                  />
                )}
                {filterLabel && (
                  <button
                    type="button"
                    onClick={() => setFilter(null)}
                    className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-blue/10 pr-2.5 pl-3 text-[13px] font-medium text-blue transition-colors hover:bg-blue/15"
                  >
                    {filterLabel}
                    <Icon icon={Cancel01Icon} size={14} strokeWidth={2} />
                  </button>
                )}
              </div>
            )}

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
                  <p className="text-[15px] font-semibold">{search ? "No results" : filter ? "Nothing here yet" : "No messages yet"}</p>
                  <p className="max-w-xs text-[13px] text-label-2">
                    {search ? `No message mentions “${search}”.` : filter ? "Clear the filter to see everything." : "Invite an agent from Details. Its messages land here the moment they’re sent."}
                  </p>
                </Centered>
              ) : (
                <div className="mx-auto w-full max-w-[800px] px-3 pb-4 md:px-6">{rows}</div>
              )}
            </div>

            {behind > 0 && (
              <button
                type="button"
                onClick={toBottom}
                className="animate-rise absolute bottom-24 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-elevated py-1.5 pr-3.5 pl-2.5 text-[13px] font-medium text-blue shadow-[0_8px_30px_-6px_rgba(0,0,0,0.25),0_0_0_0.5px_rgba(0,0,0,0.08)]"
              >
                <Icon icon={ArrowDown01Icon} size={16} strokeWidth={2} />
                {behind} new {behind === 1 ? "message" : "messages"}
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
