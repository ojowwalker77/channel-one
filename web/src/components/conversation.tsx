import { ArrowDown01Icon, ArrowLeft01Icon, Cancel01Icon, Search01Icon, SidebarRightIcon } from "@hugeicons/core-free-icons"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"

import type { Message } from "@mc/protocol.ts"
import { useAuth } from "@/lib/auth"
import { channelTitle, forgetChannel, loadRecent, saveRecent, useChannel, useKnownChannels, type StoredMember } from "@/lib/channel"
import { excerpt, memberName } from "@/lib/format"
import { cx } from "@/lib/utils"
import { Composer } from "./composer"
import { Details, type Filter } from "./details"
import { Icon } from "./icon"
import { Button, IconButton, Monogram, Spinner, Tabs, TextField } from "./kit"
import { DayMark, EventRow, MessageRow, isAgent } from "./message"
import { TaskDetail, Tasks } from "./tasks"

/** Messages this close together from one sender read as one run. */
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
  const now = useNow()
  const [tab, setTab] = useState<"chat" | "tasks">("chat")
  const [details, setDetails] = useState(false)
  const [filter, setFilter] = useState<Filter | null>(null)
  const [search, setSearch] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [openTask, setOpenTask] = useState<number | null>(null)
  const [highlight, setHighlight] = useState<number | null>(null)

  const nameOf = useCallback((name: string) => memberName(state.members.get(name), name), [state.members])
  // Members by key: names are what people type, keys are who they are.
  const byKey = useMemo(() => new Map(roster.map((r) => [r.pk, r])), [roster])
  const memberCount = roster.filter((r) => r.active).length || state.members.size
  const active = useMemo(() => [...state.members.values()].filter((m) => m.active), [state.members])
  const others = useMemo(() => active.filter((m) => m.name !== me), [active, me])
  const people = useMemo(() => active.map((m) => ({ name: m.name, label: memberName(m), agent: isAgent(m) })), [active])
  // The channel's name can arrive after this view opens (members decrypt it), so follow the list.
  const known = useKnownChannels()
  const title = channelTitle(
    { name: member.name ?? known.find((c) => c.code === member.code)?.name },
    others.length ? { from: "", text: "", ts: 0, people: others.map((m) => memberName(m)) } : loadRecent(member.code)
  )
  const forMe = useMemo(() => messages.filter((m) => m.from !== me && m.to?.includes(me)), [messages, me])
  const openTasks = useMemo(() => [...state.tasks.values()].filter((t) => t.state !== "done").length, [state.tasks])
  useTitleBadge(messages.filter((m) => m.from !== me).length)

  // Remember the latest message and who's here, for the channel list.
  useEffect(() => {
    const last = [...messages].reverse().find((m) => m.kind !== "event" && state.trust.get(m.seq) !== "forged")
    const prior = loadRecent(member.code)
    if (!last && !others.length) return
    saveRecent(member.code, {
      from: last ? (last.from === me ? "You" : nameOf(last.from)) : (prior?.from ?? ""),
      text: last ? (last.imgs?.length && last.body === last.imgs.map((i) => i.name).join(", ") ? "Image" : excerpt(last.body, 120)) : (prior?.text ?? ""),
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
        setTimeout(() => setHighlight((h) => (h === seq ? null : h)), 1600)
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
      rows.push(<EventRow key={m.seq} m={m} state={state} onOpenTask={setOpenTask} />)
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
        head={head}
        adjacentReply={adjacentReply}
        highlighted={highlight === m.seq}
        quoted={quoted}
        nameOf={nameOf}
        onReply={onReply}
        onJump={jump}
      />
    )
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
  const asking = isOwner ? requests : []
  // Who's here right now, people first: a glance at the header says who's working.
  const here = active.filter((m) => online.has(m.name)).sort((a, b) => Number(isAgent(a)) - Number(isAgent(b)))

  return (
    <div className="flex h-full min-w-0 flex-1">
      <div className={cx("relative flex min-w-0 flex-1 flex-col", details && "hidden md:flex")}>
        <header className="flex h-[56px] shrink-0 items-center gap-2 px-3 shadow-[inset_0_-0.5px_0_var(--line)] md:px-5">
          <IconButton label="Channels" className="md:hidden" onClick={onBack}>
            <Icon icon={ArrowLeft01Icon} size={20} />
          </IconButton>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[15px] leading-tight font-semibold tracking-[-0.015em]">{title}</h1>
            <button type="button" onClick={() => setDetails(true)} className="mt-0.5 flex max-w-full items-center gap-1.5 rounded-[6px] text-left transition-colors hover:text-ink">
              {connection === "live" && here.length > 0 && (
                <span className="flex shrink-0 -space-x-1" aria-hidden>
                  {here.slice(0, 5).map((m) => (
                    <span key={m.name} className="flex bg-canvas p-px" style={{ borderRadius: isAgent(m) ? 6 : 999 }}>
                      <Monogram name={memberName(m)} agent={isAgent(m)} size={16} />
                    </span>
                  ))}
                </span>
              )}
              <span className={cx("truncate text-[12px] leading-tight", connection === "live" ? "text-ink-2" : "text-ink-3")}>{subtitle}</span>
            </button>
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
          <IconButton label="Search" active={search !== null} onClick={() => setSearch((s) => (s === null ? "" : null))} disabled={tab !== "chat"}>
            <Icon icon={Search01Icon} size={17} />
          </IconButton>
          <IconButton label="Details" active={details} onClick={() => setDetails((d) => !d)}>
            <Icon icon={SidebarRightIcon} size={17} />
            {asking.length > 0 && <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-accent" />}
          </IconButton>
        </header>

        {asking.length > 0 && !details && (
          <div className="flex shrink-0 items-center gap-3 bg-accent-wash px-5 py-2 text-[13px]">
            <span className="min-w-0 flex-1 truncate">
              {asking.length === 1 ? (
                <>
                  <span className="font-medium">{asking[0]!.name}</span> wants to join this channel.
                </>
              ) : (
                `${asking.length} people and agents want to join this channel.`
              )}
            </span>
            <button type="button" onClick={() => setDetails(true)} className="shrink-0 font-medium text-accent hover:underline">
              Review
            </button>
          </div>
        )}

        {tab === "tasks" ? (
          <Tasks state={state} now={now} onOpen={setOpenTask} />
        ) : (
          <>
            {(search !== null || filterLabel) && (
              <div className="mx-auto flex w-full max-w-[760px] shrink-0 items-center gap-2 px-4 pt-3 md:px-8">
                {search !== null && (
                  <TextField autoFocus value={search} placeholder="Search messages" onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setSearch(null)} />
                )}
                {filterLabel && (
                  <button
                    type="button"
                    onClick={() => setFilter(null)}
                    className="flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] bg-wash-2 pr-2 pl-3 text-[13px] font-medium transition-colors hover:bg-wash"
                    title="Show everything"
                  >
                    {filterLabel}
                    <Icon icon={Cancel01Icon} size={13} />
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
                  <p className="text-[14px] font-semibold">{search ? "No results" : filter ? "Nothing here" : "No messages yet"}</p>
                  <p className="mt-1 max-w-xs text-[13px] leading-normal text-ink-2">
                    {search
                      ? `No message mentions “${search}”.`
                      : filter
                        ? "Clear the filter to see the whole conversation."
                        : "Invite an agent from Details. What it says shows up here the moment it’s sent."}
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

      {details && (
        <Details
          code={member.code}
          me={me}
          myKey={member.identity.pk}
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
            await ch.approve(r)
            await Promise.all([refreshRequests(), refreshRoster()])
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
  return <div className="flex h-full min-h-60 flex-1 flex-col items-center justify-center p-8 text-center">{children}</div>
}
