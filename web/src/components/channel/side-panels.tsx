import { CopyIcon, KeyRoundIcon, LockIcon } from "lucide-react"
import { toast } from "sonner"

import type { ChannelState } from "@mc/state.ts"
import { Button } from "@/components/ui/button"
import { formatAgo } from "@/lib/format"
import { AgentAvatar } from "./agent-avatar"

function Panel({ title, icon: Icon, count, children }: { title: string; icon: typeof LockIcon; count: number; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card">
      <header className="flex items-center gap-2 border-b px-3 py-2.5 text-sm font-medium">
        <Icon className="size-4 text-muted-foreground" />
        {title}
        <span className="ml-auto text-xs font-normal text-muted-foreground">{count}</span>
      </header>
      <div className="p-1.5">{children}</div>
    </section>
  )
}

function minutesLeft(expires: number, now: number) {
  const m = Math.max(0, Math.round((expires - now) / 60_000))
  return m < 60 ? `${m}m left` : `${Math.floor(m / 60)}h ${m % 60}m left`
}

export function SidePanels({ state, now }: { state: ChannelState; now: number }) {
  const facts = [...state.facts.values()].sort((a, b) => a.key.localeCompare(b.key))
  return (
    <aside className="hidden w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l p-3 xl:flex">
      <Panel title="Claims" icon={LockIcon} count={state.claims.length}>
        {state.claims.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">No paths are claimed right now.</p>}
        {state.claims.map((c) => {
          const total = c.expires - c.since
          const pct = Math.max(0, Math.min(100, ((c.expires - now) / total) * 100))
          return (
            <div key={`${c.owner}:${c.path}`} className="rounded-lg px-2 py-2 hover:bg-muted/50">
              <div className="flex items-center gap-2">
                <AgentAvatar name={c.owner} className="size-5 rounded-md" />
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{c.path}</code>
                <span className="shrink-0 text-[11px] text-muted-foreground">{minutesLeft(c.expires, now)}</span>
              </div>
              {c.note && <p className="mt-1 truncate pl-7 text-xs text-muted-foreground">{c.note}</p>}
              <div className="mt-1.5 ml-7 h-0.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-amber-500/70" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )
        })}
      </Panel>

      <Panel title="Facts" icon={KeyRoundIcon} count={facts.length}>
        {facts.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">Agents haven’t recorded any facts yet.</p>}
        {facts.map((f) => (
          <div key={f.key} className="group rounded-lg px-2 py-1.5 hover:bg-muted/50">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-xs font-medium">{f.key}</code>
              <Button
                variant="ghost"
                size="icon-xs"
                className="opacity-0 group-hover:opacity-100"
                aria-label={`Copy ${f.key}`}
                onClick={() => navigator.clipboard.writeText(f.value).then(() => toast.success(`Copied ${f.key}`))}
              >
                <CopyIcon />
              </Button>
            </div>
            <p className="font-mono text-xs break-all text-muted-foreground">{f.value}</p>
            <p className="text-[10px] text-muted-foreground/70">
              {f.by} · {formatAgo(f.ts, now)}
            </p>
          </div>
        ))}
      </Panel>
    </aside>
  )
}
