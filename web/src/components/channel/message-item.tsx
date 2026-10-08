import {
  ArrowRightIcon,
  CheckSquareIcon,
  CopyIcon,
  CornerUpLeftIcon,
  KeyRoundIcon,
  LockIcon,
  LockOpenIcon,
  type LucideIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  UserPlusIcon,
} from "lucide-react"
import { memo } from "react"
import { toast } from "sonner"

import { describeEvent } from "@mc/format.ts"
import type { Event, ImageAttachment, Message, Trust } from "@mc/protocol.ts"
import type { ChannelState } from "@mc/state.ts"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { excerpt, formatFull, formatTime, KIND_META } from "@/lib/format"
import { cn } from "@/lib/utils"
import { AgentAvatar } from "./agent-avatar"
import { Markdown } from "./markdown"

export function KindBadge({ kind, className }: { kind: Message["kind"]; className?: string }) {
  if (kind === "msg" || kind === "event") return null
  const meta = KIND_META[kind]
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium",
        meta.className,
        className
      )}
    >
      <meta.icon className="size-3" />
      {meta.label}
    </span>
  )
}

function Time({ ts, className }: { ts: number; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={new Date(ts).toISOString()} className={cn("text-xs text-muted-foreground tabular-nums", className)}>
          {formatTime(ts)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{formatFull(ts)}</TooltipContent>
    </Tooltip>
  )
}

const EVENT_ICON: Record<Event["op"], LucideIcon> = {
  hello: UserPlusIcon,
  "task.add": CheckSquareIcon,
  "task.claim": CheckSquareIcon,
  "task.update": CheckSquareIcon,
  claim: LockIcon,
  release: LockOpenIcon,
  "fact.set": KeyRoundIcon,
  "fact.del": KeyRoundIcon,
}

/** Coordination events render as one quiet line, not a chat bubble. */
function EventRow({ m, trust, state, onOpenTask }: { m: Message; trust?: Trust; state?: ChannelState; onOpenTask: (id: number) => void }) {
  const Icon = m.ev ? EVENT_ICON[m.ev.op] : CheckSquareIcon
  const taskRef = m.ev && "task" in m.ev ? m.ev.task : m.ev?.op === "task.add" ? m.seq : null
  return (
    <div id={`m${m.seq}`} className="group flex items-center gap-3 px-3 py-1 text-xs text-muted-foreground">
      <div className="flex w-8 shrink-0 justify-center">
        <Icon className="size-3.5" />
      </div>
      <div className={cn("min-w-0 flex-1 truncate", trust === "forged" && "line-through opacity-60")}>
        <span className="font-medium text-foreground">{m.from}</span> {describeEvent(m, state)}
        {taskRef !== null && (
          <button type="button" onClick={() => onOpenTask(taskRef)} className="ml-2 font-medium text-primary hover:underline">
            View
          </button>
        )}
      </div>
      {trust === "forged" && <TrustBadge trust={trust} />}
      <Time ts={m.ts} className="text-[11px] opacity-0 group-hover:opacity-100" />
    </div>
  )
}

function Attachments({ imgs }: { imgs: ImageAttachment[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {imgs.map((img, i) => {
        const url = `data:${img.mime};base64,${img.data}`
        return (
          <a key={i} href={url} target="_blank" rel="noreferrer" title={`${img.name} — open full size`}>
            <img src={url} alt={img.name} loading="lazy" className="max-h-48 max-w-full rounded-lg border object-cover hover:opacity-90" />
          </a>
        )
      })}
    </div>
  )
}

export function TrustBadge({ trust, pk }: { trust?: Trust; pk?: string }) {  if (trust === "verified") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <ShieldCheckIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-label="Verified" />
        </TooltipTrigger>
        <TooltipContent>Signed by this member’s key{pk ? ` · ${pk.slice(0, 8)}` : ""}</TooltipContent>
      </Tooltip>
    )
  }
  if (trust === "forged") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex h-5 items-center gap-1 rounded-md bg-destructive/10 px-1.5 text-[11px] font-medium text-destructive">
            <ShieldAlertIcon className="size-3" />
            Forged
          </span>
        </TooltipTrigger>
        <TooltipContent>Not signed by the key that owns this name. Agents ignore it.</TooltipContent>
      </Tooltip>
    )
  }
  return null
}

interface Props {
  message: Message
  trust?: Trust
  state?: ChannelState
  /** Continuation of the previous message from the same sender: no header. */
  compact: boolean
  me: string
  highlighted: boolean
  quoted: (seq: number) => Message | undefined
  onReply: (m: Message) => void
  onJump: (seq: number) => void
  onOpenTask: (id: number) => void
}

export const MessageItem = memo(function MessageItem({ message: m, trust, state, compact, me, highlighted, quoted, onReply, onJump, onOpenTask }: Props) {
  if (m.kind === "event") return <EventRow m={m} trust={trust} state={state} onOpenTask={onOpenTask} />
  const mine = m.from === me
  const forMe = !mine && !!m.to?.includes(me)

  return (
    <div
      id={`m${m.seq}`}
      className={cn(
        "group relative flex gap-3 rounded-lg px-3 transition-colors hover:bg-muted/50",
        compact ? "py-0.5" : "mt-3 pt-2 pb-1 first:mt-0",
        forMe && "bg-amber-500/5 shadow-[inset_2px_0_0] shadow-amber-500",
        highlighted && "bg-primary/10"
      )}
    >
      <div className="w-8 shrink-0">
        {compact ? (
          <Time ts={m.ts} className="block pt-0.5 text-right text-[10px] opacity-0 group-hover:opacity-100" />
        ) : (
          <AgentAvatar name={m.from} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        {!compact && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-sm font-semibold">{m.from}</span>
            <TrustBadge trust={trust} pk={m.pk} />
            {mine && <span className="text-xs text-muted-foreground">(you)</span>}
            {m.to?.length ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <ArrowRightIcon className="size-3" />
                {m.to.join(", ")}
              </span>
            ) : null}
            <KindBadge kind={m.kind} />
            <Time ts={m.ts} />
          </div>
        )}

        {m.re?.map((seq) => {
          const q = quoted(seq)
          return (
            <button
              key={seq}
              type="button"
              onClick={() => onJump(seq)}
              className="mt-1 flex w-full max-w-xl items-center gap-2 rounded-md border-l-2 bg-muted/60 px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted"
            >
              <CornerUpLeftIcon className="size-3 shrink-0" />
              {q ? (
                <span className="truncate">
                  <span className="font-medium text-foreground">{q.from}</span> {excerpt(q.body)}
                </span>
              ) : (
                <span>message #{seq}</span>
              )}
            </button>
          )
        })}

        <div className={cn(!compact && "mt-0.5", trust === "forged" && "opacity-60")}>
          <Markdown>{m.body}</Markdown>
        </div>
        {m.imgs?.length ? <Attachments imgs={m.imgs} /> : null}
      </div>

      <div className="absolute -top-3 right-3 hidden items-center rounded-lg border bg-popover p-0.5 shadow-sm group-hover:flex">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={() => onReply(m)} aria-label="Reply">
              <CornerUpLeftIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reply</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Copy text"
              onClick={() => navigator.clipboard.writeText(m.body).then(() => toast.success("Copied message"))}
            >
              <CopyIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy text</TooltipContent>
        </Tooltip>
        <span className="px-1.5 font-mono text-[10px] text-muted-foreground">#{m.seq}</span>
      </div>
    </div>
  )
})
