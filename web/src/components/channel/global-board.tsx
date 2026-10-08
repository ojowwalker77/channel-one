import { ArrowLeftIcon, ArrowRightIcon, InboxIcon } from "lucide-react"
import { useEffect, useState } from "react"

import { Channel } from "@mc/client.ts"
import { fold, taskId, type ChannelState } from "@mc/state.ts"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cachedKeys, type KnownChannel } from "@/lib/channel"
import { cn } from "@/lib/utils"
import { STATE_META } from "./board"

interface Loaded {
  code: string
  at: number
  state: ChannelState
}

function short(code: string): string {
  return code.length > 18 ? `${code.slice(0, 12)}…${code.slice(-4)}` : code
}

function ChannelCard({ loaded, onOpen }: { loaded: Loaded; onOpen: () => void }) {
  const tasks = [...loaded.state.tasks.values()]
  const open = tasks.filter((t) => t.state !== "done").sort((a, b) => a.id - b.id)
  const done = tasks.length - open.length
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="font-mono text-sm font-medium">{short(loaded.code)}</CardTitle>
        <Button variant="ghost" size="sm" onClick={onOpen}>
          Open
          <ArrowRightIcon />
        </Button>
      </CardHeader>
      <CardContent className="grid gap-1 text-sm">
        <p className="mb-1 text-xs text-muted-foreground">
          {loaded.state.members.size} agents · {open.length} open{done ? ` · ${done} done` : ""}
        </p>
        {open.length === 0 && <p className="flex items-center gap-2 text-xs text-muted-foreground"><InboxIcon className="size-3.5" />Nothing open</p>}
        {open.map((t) => {
          const meta = STATE_META[t.state]
          return (
            <button key={t.id} type="button" onClick={onOpen} className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-muted/60">
              <meta.icon className={cn("size-3.5 shrink-0", meta.className)} />
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{taskId(t.id)}</span>
              <span className="min-w-0 flex-1 truncate font-medium">{t.title}</span>
              {t.owner && <span className="shrink-0 text-xs text-muted-foreground">{t.owner}</span>}
            </button>
          )
        })}
      </CardContent>
    </Card>
  )
}

export function GlobalBoard({ channels, onOpen, onBack }: { channels: KnownChannel[]; onOpen: (code: string) => void; onBack: () => void }) {
  const [loaded, setLoaded] = useState<Loaded[]>([])
  const [failed, setFailed] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const out: Loaded[] = []
      const bad: string[] = []
      for (const c of channels) {
        try {
          const keys = await cachedKeys(c.code)
          const ch = new Channel(keys, location.origin, null, "web")
          const head = await ch.head()
          const { messages } = await ch.history(Math.max(0, head - 2_000))
          if (cancelled) return
          out.push({ code: c.code, at: c.at, state: fold(messages) })
          setLoaded([...out])
        } catch {
          if (cancelled) return
          bad.push(c.code)
          setFailed([...bad])
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [channels])

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-3xl flex-col gap-4 p-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back">
          <ArrowLeftIcon />
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">Tasks across {channels.length} channel{channels.length === 1 ? "" : "s"}</h1>
      </div>
      {loaded.length === 0 && failed.length === 0 && <p className="text-sm text-muted-foreground">Loading boards…</p>}
      {loaded.map((l) => (
        <ChannelCard key={l.code} loaded={l} onOpen={() => onOpen(l.code)} />
      ))}
      {failed.length > 0 && (
        <p className="text-xs text-muted-foreground">Couldn’t open {failed.length} channel{failed.length === 1 ? "" : "s"} (wrong code or relay unreachable).</p>
      )}
    </div>
  )
}
