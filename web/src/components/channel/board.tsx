import { CircleDashedIcon, CircleDotIcon, CircleIcon, CirclePauseIcon, CircleCheckIcon, LinkIcon, MessageSquareTextIcon, type LucideIcon } from "lucide-react"

import type { TaskState } from "@mc/protocol.ts"
import { taskId, waitingOn, type ChannelState, type Task } from "@mc/state.ts"
import { Badge } from "@/components/ui/badge"
import { formatAgo } from "@/lib/format"
import { cn } from "@/lib/utils"
import { AgentAvatar } from "./agent-avatar"

export const STATE_META: Record<TaskState, { label: string; icon: LucideIcon; className: string }> = {
  todo: { label: "To do", icon: CircleIcon, className: "text-muted-foreground" },
  doing: { label: "In progress", icon: CircleDotIcon, className: "text-sky-500" },
  blocked: { label: "Blocked", icon: CirclePauseIcon, className: "text-red-500" },
  review: { label: "In review", icon: CircleDashedIcon, className: "text-violet-500" },
  done: { label: "Done", icon: CircleCheckIcon, className: "text-emerald-500" },
}

const COLUMNS: TaskState[] = ["todo", "doing", "blocked", "review", "done"]

function TaskCard({ task, state, now, onOpen }: { task: Task; state: ChannelState; now: number; onOpen: () => void }) {
  const waits = waitingOn(state, task)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full flex-col gap-2 rounded-xl border bg-card p-3 text-left shadow-xs transition hover:border-foreground/20 hover:shadow-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">{taskId(task.id)}</span>
        {waits.length > 0 && (
          <Badge variant="outline" className="gap-1 text-[10px] font-normal text-muted-foreground">
            <LinkIcon className="size-3" />
            after {waits.map(taskId).join(", ")}
          </Badge>
        )}
      </div>
      <p className={cn("text-sm leading-snug font-medium", task.state === "done" && "text-muted-foreground line-through decoration-muted-foreground/40")}>
        {task.title}
      </p>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        {task.owner ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <AgentAvatar name={task.owner} className="size-5 rounded-md after:rounded-md [&_[data-slot=avatar-fallback]]:rounded-md [&_[data-slot=avatar-fallback]]:text-[9px]" />
            <span className="truncate">{task.owner}</span>
          </span>
        ) : (
          <span className="italic">Unassigned</span>
        )}
        <span className="flex shrink-0 items-center gap-2">
          {task.notes.length > 0 && (
            <span className="flex items-center gap-0.5">
              <MessageSquareTextIcon className="size-3" />
              {task.notes.length}
            </span>
          )}
          {formatAgo(task.updatedAt, now)}
        </span>
      </div>
    </button>
  )
}

export function Board({ state, now, onOpen }: { state: ChannelState; now: number; onOpen: (id: number) => void }) {
  const tasks = [...state.tasks.values()]
  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
      {COLUMNS.map((col) => {
        const meta = STATE_META[col]
        const items = tasks.filter((t) => t.state === col).sort((a, b) => b.updatedAt - a.updatedAt)
        return (
          <section key={col} className="flex min-w-44 flex-1 flex-col rounded-2xl bg-muted/40 xl:max-w-96 dark:bg-muted/20">
            <header className="flex items-center gap-2 px-3 pt-3 pb-2 text-sm font-medium">
              <meta.icon className={cn("size-4", meta.className)} />
              {meta.label}
              <span className="text-xs font-normal text-muted-foreground">{items.length}</span>
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
              {items.map((t) => (
                <TaskCard key={t.id} task={t} state={state} now={now} onOpen={() => onOpen(t.id)} />
              ))}
              {items.length === 0 && <p className="px-1 py-6 text-center text-xs text-muted-foreground">Nothing here</p>}
            </div>
          </section>
        )
      })}
    </div>
  )
}
