import { describeEvent } from "@mc/format.ts"
import type { Message } from "@mc/protocol.ts"
import { taskId, type ChannelState } from "@mc/state.ts"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { formatAgo, formatFull } from "@/lib/format"
import { cn } from "@/lib/utils"
import { AgentAvatar } from "./agent-avatar"
import { STATE_META } from "./board"
import { Markdown } from "./markdown"

function relatedTo(m: Message, id: number): boolean {
  const ev = m.ev
  if (!ev) return false
  return (ev.op === "task.add" && m.seq === id) || ("task" in ev && ev.task === id)
}

export function TaskSheet({
  id,
  state,
  messages,
  now,
  onClose,
  onOpen,
}: {
  id: number | null
  state: ChannelState
  messages: Message[]
  now: number
  onClose: () => void
  onOpen: (id: number) => void
}) {
  const task = id === null ? undefined : state.tasks.get(id)
  const history = id === null ? [] : messages.filter((m) => relatedTo(m, id) && state.trust.get(m.seq) !== "forged")
  const meta = task ? STATE_META[task.state] : null

  return (
    <Sheet open={id !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-lg">
        {task && meta ? (
          <>
            <SheetHeader className="gap-3 border-b pb-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono">{taskId(task.id)}</span>·
                <span className={cn("flex items-center gap-1 font-medium", meta.className)}>
                  <meta.icon className="size-3.5" />
                  {meta.label}
                </span>
              </div>
              <SheetTitle className="text-lg leading-snug">{task.title}</SheetTitle>
              <SheetDescription asChild>
                <div className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2 text-sm">
                  <span className="text-muted-foreground">Owner</span>
                  {task.owner ? (
                    <span className="flex items-center gap-2 text-foreground">
                      <AgentAvatar name={task.owner} className="size-5" />
                      {task.owner}
                    </span>
                  ) : (
                    <span className="text-muted-foreground italic">Unassigned</span>
                  )}
                  <span className="text-muted-foreground">Created</span>
                  <span className="text-foreground" title={formatFull(task.createdAt)}>
                    by {task.createdBy}, {formatAgo(task.createdAt, now)}
                  </span>
                  {task.after.length > 0 && (
                    <>
                      <span className="text-muted-foreground">After</span>
                      <span className="flex flex-wrap gap-1.5">
                        {task.after.map((d) => {
                          const dep = state.tasks.get(d)
                          return (
                            <button key={d} type="button" onClick={() => onOpen(d)} className="rounded-md border px-1.5 py-0.5 text-xs text-foreground hover:bg-muted">
                              {taskId(d)} · {dep ? STATE_META[dep.state].label : "?"}
                            </button>
                          )
                        })}
                      </span>
                    </>
                  )}
                </div>
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto p-4">
              {task.detail && (
                <>
                  <Markdown>{task.detail}</Markdown>
                  <Separator className="my-4" />
                </>
              )}
              <h3 className="mb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">History</h3>
              <ol className="relative ml-2.5 border-l">
                {history.map((m) => (
                  <li key={m.seq} className="mb-4 ml-5">
                    <span className="absolute -left-2.5 flex size-5 items-center justify-center rounded-full bg-background ring-1 ring-border">
                      <AgentAvatar name={m.from} className="size-4 rounded-full after:rounded-full [&_[data-slot=avatar-fallback]]:rounded-full [&_[data-slot=avatar-fallback]]:text-[7px]" />
                    </span>
                    <p className="text-sm">
                      <span className="font-medium">{m.from}</span> <span className="text-muted-foreground">{describeEvent(m)}</span>
                    </p>
                    <time className="text-xs text-muted-foreground" title={formatFull(m.ts)}>
                      {formatAgo(m.rts ?? m.ts, now)} · #{m.seq}
                    </time>
                  </li>
                ))}
              </ol>
            </div>
          </>
        ) : (
          <SheetHeader>
            <SheetTitle>Task not found</SheetTitle>
            <SheetDescription>It may have been pruned from the channel history.</SheetDescription>
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  )
}
