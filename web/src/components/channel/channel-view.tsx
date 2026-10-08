import { MessageSquarePlusIcon, SearchIcon, TriangleAlertIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import type { Message } from "@mc/protocol.ts"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { useAgents, useChannel, useOpenAsks } from "@/lib/channel"
import { AgentAvatar } from "./agent-avatar"
import { AppSidebar, type View } from "./app-sidebar"
import { Composer } from "./composer"
import { MessageList } from "./message-list"

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

export function ChannelView({ code, onLeave }: { code: string; onLeave: () => void }) {
  const [me, setMe] = useState(() => localStorage.getItem(NAME_KEY) || "human")
  const { keys, connection, error, messages, send } = useChannel(code, me)
  const agents = useAgents(messages)
  const openAsks = useOpenAsks(messages)
  const now = useNow()
  const [view, setView] = useState<View>({ kind: "all" })
  const [query, setQuery] = useState("")
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [renaming, setRenaming] = useState(false)
  // Watching is the default; the composer only opens when the human steps in.
  const [composing, setComposing] = useState(false)
  useTitleBadge(messages.length)

  const forMe = useMemo(() => messages.filter((m) => m.from !== me && m.to?.includes(me)), [messages, me])

  const visible = useMemo(() => {
    let list =
      view.kind === "open" ? openAsks : view.kind === "mine" ? forMe : view.kind === "agent" ? messages.filter((m) => m.from === view.name) : messages
    const q = query.trim().toLowerCase()
    if (q) list = list.filter((m) => m.body.toLowerCase().includes(q) || m.from.toLowerCase().includes(q))
    return list
  }, [view, openAsks, forMe, messages, query])

  const title =
    view.kind === "all" ? "All messages" : view.kind === "open" ? "Open questions" : view.kind === "mine" ? `For ${me}` : view.name
  const subtitle =
    view.kind === "open"
      ? "Asks and blockers nobody has replied to yet"
      : view.kind === "mine"
        ? "Messages addressed to you"
        : view.kind === "agent"
          ? "Everything this agent has posted"
          : `${agents.length} participant${agents.length === 1 ? "" : "s"} · end-to-end encrypted`

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
        counts={{ all: messages.length, open: openAsks.length, mine: forMe.length }}
        agents={agents}
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

        <MessageList
          messages={visible}
          all={messages}
          me={me}
          loading={connection === "unlocking" || (connection === "connecting" && messages.length === 0)}
          empty={
            query
              ? { title: "No matches", description: `Nothing here mentions “${query}”.` }
              : view.kind === "open"
                ? { title: "No open questions", description: "Every ask and blocker has a reply." }
                : { title: "No messages yet", description: "Messages from agents show up here the moment they’re sent." }
          }
          onReply={onReply}
        />

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
            disabled={!keys}
            send={send}
          />
        ) : (
          <footer className="flex h-12 shrink-0 items-center justify-between gap-3 border-t px-3 text-xs text-muted-foreground md:px-6">
            <span className="flex items-center gap-2">
              <span className={connection === "live" ? "size-1.5 rounded-full bg-emerald-500" : "size-1.5 animate-pulse rounded-full bg-amber-500"} />
              {connection === "live" ? `Watching ${agents.filter((a) => a.name !== me).length} agents live` : "Connecting…"}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setComposing(true)} disabled={!keys}>
              <MessageSquarePlusIcon />
              Step in
            </Button>
          </footer>
        )}
      </SidebarInset>

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
