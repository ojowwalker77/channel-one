import { MessageSquarePlusIcon, SearchIcon, TriangleAlertIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import type { Identity } from "@mc/identity.ts"
import type { Message } from "@mc/protocol.ts"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { rememberChannel, useChannel } from "@/lib/channel"
import { AgentAvatar } from "./agent-avatar"
import { AppSidebar, type AgentRow, type View } from "./app-sidebar"
import { Board } from "./board"
import { Composer } from "./composer"
import { MessageList } from "./message-list"
import { SidePanels } from "./side-panels"
import { TaskSheet } from "./task-sheet"

const NAME_KEY = "mc.as"

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

export function ChannelView({ code, identity: imported, onLeave }: { code: string; identity: Identity | null; onLeave: () => void }) {
  const [me, setMe] = useState(() => imported?.name || localStorage.getItem(NAME_KEY) || "human")
  const { keys, connection, error, messages, state, online, identity, send } = useChannel(code, me, imported)
  const openAsks = state.openAsks
  const now = useNow()
  const [openTask, setOpenTask] = useState<number | null>(null)

  const agents = useMemo<AgentRow[]>(() => {
    const latest = new Map<string, string>()
    for (const m of messages) if ((m.kind === "status" || m.kind === "done") && state.trust.get(m.seq) !== "forged") latest.set(m.from, m.body)
    const rows = [...state.members.values()].map((m) => ({
      name: m.name,
      role: m.role,
      lastSeen: m.lastSeen,
      status: latest.get(m.name),
      verified: !!m.pk,
    }))
    for (const [name, o] of online) if (!state.members.has(name)) rows.push({ name, role: o.role, lastSeen: o.at, status: undefined, verified: false })
    return rows.sort((a, b) => Number(online.has(b.name)) - Number(online.has(a.name)) || b.lastSeen - a.lastSeen)
  }, [state, messages, online])

  // My name belongs to a different key in this channel: posts would show as forged.
  const myKey = state.members.get(me)?.pk
  const nameTaken = !!myKey && !!identity && myKey !== identity.pk
  const [view, setView] = useState<View>({ kind: "all" })
  const [query, setQuery] = useState("")
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [renaming, setRenaming] = useState(false)
  // Watching is the default; the composer only opens when the human steps in.
  const [composing, setComposing] = useState(false)
  useEffect(() => {
    rememberChannel(code)
  }, [code])
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
    view.kind === "board" ? "Task board" :
    view.kind === "all" ? "Activity" : view.kind === "open" ? "Open questions" : view.kind === "mine" ? `For ${me}` : view.name
  const subtitle =
    view.kind === "open"
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

  const copyLink = () =>
    navigator.clipboard
      .writeText(location.href)
      .then(() => toast.success("Invite link copied", { description: "Anyone with this link can read and post. Share it like a password." }))

  if (connection === "error") {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TriangleAlertIcon />
            </EmptyMedia>
            <EmptyTitle>Couldn’t open this channel</EmptyTitle>
            <EmptyDescription>{error}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={onLeave}>Try another code</Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  return (
    <SidebarProvider>
      <AppSidebar
        channelId={keys ? keys.roomId.slice(0, 8) : "…"}
        connection={connection}
        view={view}
        onView={setView}
        counts={{ all: messages.length, board: openTasks, open: openAsks.length, mine: forMe.length }}
        agents={agents}
        online={online}
        now={now}
        me={me}
        onRename={() => setRenaming(true)}
        onCopyLink={copyLink}
        onLeave={onLeave}
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

        {view.kind === "board" ? (
          <Board state={state} now={now} onOpen={setOpenTask} />
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              <MessageList
                messages={visible}
                all={messages}
                me={me}
                state={state}
                loading={connection === "unlocking" || (connection === "connecting" && messages.length === 0)}
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
            nameTaken={nameTaken}
            agents={agents.map((a) => a.name)}
            replyTo={replyTo}
            onClearReply={() => setReplyTo(null)}
            onClose={() => {
              setReplyTo(null)
              setComposing(false)
            }}
            disabled={!keys}
            send={send}
          />
        ) : (
          <footer className="flex h-12 shrink-0 items-center justify-between gap-3 border-t px-3 text-xs text-muted-foreground md:px-6">
            <span className="flex items-center gap-2">
              <span className={connection === "live" ? "size-1.5 rounded-full bg-emerald-500" : "size-1.5 animate-pulse rounded-full bg-amber-500"} />
              {connection === "live" ? `Live · ${online.size} of ${agents.filter((a) => a.name !== me).length} agents online` : "Connecting…"}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setComposing(true)} disabled={!keys}>
              <MessageSquarePlusIcon />
              Step in
            </Button>
          </footer>
        )}
      </SidebarInset>

      <TaskSheet id={openTask} state={state} messages={messages} now={now} onClose={() => setOpenTask(null)} onOpen={setOpenTask} />

      <RenameDialog
        open={renaming}
        current={me}
        onOpenChange={setRenaming}
        onSave={(name) => {
          setMe(name)
          localStorage.setItem(NAME_KEY, name)
        }}
      />
    </SidebarProvider>
  )
}

function RenameDialog({
  open,
  current,
  onOpenChange,
  onSave,
}: {
  open: boolean
  current: string
  onOpenChange: (o: boolean) => void
  onSave: (name: string) => void
}) {
  const [name, setName] = useState(current)
  useEffect(() => {
    if (open) setName(current)
  }, [open, current])
  const valid = /^[\p{L}\p{N}_.-]{1,32}$/u.test(name.trim())

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (!valid) return
            onSave(name.trim())
            onOpenChange(false)
          }}
        >
          <DialogHeader>
            <DialogTitle>Change your name</DialogTitle>
            <DialogDescription>
              Agents treat messages from <span className="font-medium text-foreground">human</span> as instructions from you. Other names are treated as peers.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-invalid={!valid} />
            <p className="text-xs text-muted-foreground">Letters, digits, “_”, “.” or “-”, up to 32 characters.</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
