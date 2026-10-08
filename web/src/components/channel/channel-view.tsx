import { MessageSquarePlusIcon, SearchIcon, ShieldOffIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import type { Message } from "@mc/protocol.ts"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { forgetChannel, useChannel, type StoredMember } from "@/lib/channel"
import { AgentAvatar } from "./agent-avatar"
import { AppSidebar, type AgentRow, type View } from "./app-sidebar"
import { Board } from "./board"
import { Composer } from "./composer"
import { MembersPanel } from "./members-panel"
import { MessageList } from "./message-list"
import { SidePanels } from "./side-panels"
import { TaskSheet } from "./task-sheet"

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
    document.title = unread > 0 ? `(${unread}) modelchannel` : "modelchannel"
  }, [count, base])
}

export function ChannelView({ member, onLeave }: { member: StoredMember; onLeave: () => void }) {
  const me = member.identity.name
  const { ch, connection, gone, messages, roster, state, online, isOwner, requests, send, refreshRequests, refreshRoster } = useChannel(member)
  const openAsks = state.openAsks
  const now = useNow()
  const [openTask, setOpenTask] = useState<number | null>(null)

  const agents = useMemo<AgentRow[]>(() => {
    const latest = new Map<string, string>()
    for (const m of messages) if ((m.kind === "status" || m.kind === "done") && state.trust.get(m.seq) !== "forged") latest.set(m.from, m.body)
    const rows = [...state.members.values()].filter((m) => m.active).map((m) => ({
      name: m.name,
      role: m.role,
      lastSeen: m.lastSeen,
      status: latest.get(m.name),
      verified: !!m.pk,
    }))
    return rows.sort((a, b) => Number(online.has(b.name)) - Number(online.has(a.name)) || b.lastSeen - a.lastSeen)
  }, [state, messages, online])

  const [view, setView] = useState<View>({ kind: "all" })
  const [query, setQuery] = useState("")
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  // Watching is the default; the composer only opens when the human steps in.
  const [composing, setComposing] = useState(false)
  useTitleBadge(messages.filter((m) => m.from !== me).length)

  const forMe = useMemo(() => messages.filter((m) => m.from !== me && m.to?.includes(me)), [messages, me])

  const visible = useMemo(() => {
    let list =
      view.kind === "open" ? openAsks : view.kind === "mine" ? forMe : view.kind === "agent" ? messages.filter((m) => m.from === view.name) : messages
    // Joins are noise in a busy channel; the sidebar already lists members.
    if (view.kind === "all") list = list.filter((m) => m.ev?.op !== "hello")
    const q = query.trim().toLowerCase()
    if (q) list = list.filter((m) => m.body.toLowerCase().includes(q) || m.from.toLowerCase().includes(q))
    return list
  }, [view, openAsks, forMe, messages, query])

  const openTasks = [...state.tasks.values()].filter((t) => t.state !== "done").length
  const title =
    view.kind === "members" ? "Members" :
    view.kind === "board" ? "Task board" :
    view.kind === "all" ? "Activity" : view.kind === "open" ? "Open questions" : view.kind === "mine" ? `For ${me}` : view.name
  const subtitle =
    view.kind === "members"
      ? isOwner
        ? `${requests.length} waiting · you approve everyone who joins`
        : "Names are bound to keys by the owner"
      : view.kind === "open"
      ? "Asks and blockers nobody has replied to yet"
      : view.kind === "board"
        ? `${openTasks} open · ${state.tasks.size - openTasks} done`
      : view.kind === "mine"
        ? "Messages addressed to you"
        : view.kind === "agent"
          ? "Everything this agent has posted"
          : `${online.size} of ${agents.filter((a) => a.name !== me).length} agents online · end-to-end encrypted, signed`

  const onReply = useCallback((m: Message) => {
    setReplyTo(m)
    setComposing(true)
  }, [])

  const copyCode = () =>
    navigator.clipboard
      .writeText(member.code)
      .then(() => toast.success("Join code copied", { description: "It only lets someone ask to join. You approve each request." }))

  if (gone) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldOffIcon />
            </EmptyMedia>
            <EmptyTitle>{gone === "closed" ? "This channel was closed" : "You’re no longer a member"}</EmptyTitle>
            <EmptyDescription>
              {gone === "closed" ? "The owner deleted it, and nothing is left at the relay." : "The owner removed this browser, or it left."} This browser has forgotten it too.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={onLeave}>Back</Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  return (
    <SidebarProvider>
      <AppSidebar
        channelId={member.access.roomId.slice(0, 8)}
        connection={connection}
        view={view}
        onView={setView}
        counts={{ all: messages.length, board: openTasks, open: openAsks.length, mine: forMe.length, members: requests.length }}
        agents={agents}
        online={online}
        now={now}
        me={me}
        isOwner={isOwner}
        onCopyCode={copyCode}
        onBack={onLeave}
      />
      <SidebarInset className="h-svh overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 md:px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
          {view.kind === "agent" && <AgentAvatar name={view.name} className="size-6" />}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold">{title}</h1>
            <p className="hidden truncate text-xs text-muted-foreground sm:block">{subtitle}</p>
          </div>
          <InputGroup className="w-40 md:w-64">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" />
          </InputGroup>
        </header>

        {view.kind === "members" ? (
          <MembersPanel
            me={me}
            isOwner={isOwner}
            roster={roster}
            requests={requests}
            online={online}
            now={now}
            onApprove={async (r) => {
              await ch.approve(r)
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
            onClose={async () => {
              await ch.close()
              forgetChannel(member.code)
              onLeave()
            }}
            onLeave={async () => {
              await ch.leave()
              forgetChannel(member.code)
              onLeave()
            }}
          />
        ) : view.kind === "board" ? (
          <Board state={state} now={now} onOpen={setOpenTask} />
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              <MessageList
                messages={visible}
                all={messages}
                me={me}
                state={state}
                loading={connection === "connecting" && messages.length === 0}
                empty={
                  query
                    ? { title: "No matches", description: `Nothing here mentions “${query}”.` }
                    : view.kind === "open"
                      ? { title: "No open questions", description: "Every ask and blocker has a reply." }
                      : { title: "No messages yet", description: "Messages from agents show up here the moment they’re sent." }
                }
                onReply={onReply}
                onOpenTask={setOpenTask}
              />
            </div>
            {view.kind === "all" && <SidePanels state={state} now={now} />}
          </div>
        )}

        {composing ? (
          <Composer
            me={me}
            agents={agents.map((a) => a.name)}
            replyTo={replyTo}
            onClearReply={() => setReplyTo(null)}
            onClose={() => {
              setReplyTo(null)
              setComposing(false)
            }}
            disabled={false}
            send={send}
          />
        ) : (
          <footer className="flex h-12 shrink-0 items-center justify-between gap-3 border-t px-3 text-xs text-muted-foreground md:px-6">
            <span className="flex items-center gap-2">
              <span className={connection === "live" ? "size-1.5 rounded-full bg-emerald-500" : "size-1.5 animate-pulse rounded-full bg-amber-500"} />
              {connection === "live" ? `Live · ${online.size} of ${agents.filter((a) => a.name !== me).length} agents online` : "Connecting…"}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setComposing(true)}>
              <MessageSquarePlusIcon />
              Step in
            </Button>
          </footer>
        )}
      </SidebarInset>

      <TaskSheet id={openTask} state={state} messages={messages} now={now} onClose={() => setOpenTask(null)} onOpen={setOpenTask} />

    </SidebarProvider>
  )
}
