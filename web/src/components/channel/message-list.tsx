import { ArrowDownIcon, MessagesSquareIcon } from "lucide-react"
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import type { Message } from "@mc/protocol.ts"
import type { ChannelState } from "@mc/state.ts"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDay } from "@/lib/format"
import { MessageItem } from "./message-item"

const GROUP_MS = 5 * 60_000

function startsGroup(prev: Message | undefined, m: Message): boolean {
  if (!prev || prev.kind === "event" || prev.from !== m.from || m.ts - prev.ts > GROUP_MS) return true
  if (formatDay(prev.ts) !== formatDay(m.ts)) return true
  // Anything with routing or a kind deserves its own header.
  return m.kind !== "msg" || !!m.to?.length || !!m.re?.length
}

interface Props {
  messages: Message[]
  all: Message[]
  me: string
  state: ChannelState
  loading: boolean
  empty: { title: string; description: string }
  onReply: (m: Message) => void
  onOpenTask: (id: number) => void
}

export function MessageList({ messages, all, me, state, loading, empty, onReply, onOpenTask }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [unseen, setUnseen] = useState(0)
  const [highlight, setHighlight] = useState<number | null>(null)
  const lastCount = useRef(0)

  const bySeq = useMemo(() => new Map(all.map((m) => [m.seq, m])), [all])
  const quoted = useCallback((seq: number) => bySeq.get(seq), [bySeq])

  const atBottom = () => {
    const el = scroller.current
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 96
  }
  const toBottom = (smooth = false) => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" })
    setUnseen(0)
  }

  // Follow new messages when already at the bottom; otherwise count them.
  useLayoutEffect(() => {
    const added = messages.length - lastCount.current
    lastCount.current = messages.length
    if (stick.current) toBottom()
    else if (added > 0) setUnseen((n) => n + added)
  }, [messages])

  useEffect(() => {
    if (highlight === null) return
    const t = setTimeout(() => setHighlight(null), 1600)
    return () => clearTimeout(t)
  }, [highlight])

  const jump = useCallback((seq: number) => {
    const el = document.getElementById(`m${seq}`)
    if (!el) return
    el.scrollIntoView({ behavior: "smooth", block: "center" })
    setHighlight(seq)
  }, [])

  if (loading) {
    return (
      <div className="flex flex-1 flex-col gap-5 p-6">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="size-8 rounded-lg" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-full max-w-md" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        onScroll={() => {
          stick.current = atBottom()
          if (stick.current) setUnseen(0)
        }}
        className="h-full overflow-y-auto px-2 py-4 md:px-4"
      >
        {messages.length === 0 ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessagesSquareIcon />
              </EmptyMedia>
              <EmptyTitle>{empty.title}</EmptyTitle>
              <EmptyDescription>{empty.description}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="mx-auto flex max-w-4xl flex-col">
            {messages.map((m, i) => {
              const prev = messages[i - 1]
              const newDay = !prev || formatDay(prev.ts) !== formatDay(m.ts)
              return (
                <Fragment key={m.seq}>
                  {newDay && (
                    <div className="my-3 flex items-center gap-3 first:mt-0">
                      <div className="h-px flex-1 bg-border" />
                      <span className="rounded-full border bg-background px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                        {formatDay(m.ts)}
                      </span>
                      <div className="h-px flex-1 bg-border" />
                    </div>
                  )}
                  <MessageItem
                    message={m}
                    trust={state.trust.get(m.seq)}
                    state={m.kind === "event" ? state : undefined}
                    onOpenTask={onOpenTask}
                    compact={!newDay && !startsGroup(prev, m)}
                    me={me}
                    highlighted={highlight === m.seq}
                    quoted={quoted}
                    onReply={onReply}
                    onJump={jump}
                  />
                </Fragment>
              )
            })}
          </div>
        )}
      </div>

      {unseen > 0 && (
        <Button
          size="sm"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full shadow-lg"
          onClick={() => toBottom(true)}
        >
          <ArrowDownIcon />
          {unseen} new {unseen === 1 ? "message" : "messages"}
        </Button>
      )}
    </div>
  )
}
