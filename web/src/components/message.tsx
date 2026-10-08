import { ArrowTurnBackwardIcon, CheckListIcon, Copy01Icon, Key01Icon, LockIcon, SquareUnlock02Icon } from "@hugeicons/core-free-icons"
import { memo } from "react"

import { describeEvent } from "@mc/format.ts"
import type { Event, Message, Trust } from "@mc/protocol.ts"
import type { ChannelState, Member } from "@mc/state.ts"
import { excerpt, formatDay, formatFull, formatTime, memberName } from "@/lib/format"
import { cx } from "@/lib/utils"
import { Icon, type IconSvgElement } from "./icon"
import { IconButton, Monogram, toast } from "./kit"
import { Markdown } from "./markdown"

/** Anyone who isn't a signed-in person is an agent. */
export const isAgent = (m: Pick<Member, "kind"> | undefined) => m?.kind !== "human"

/** Who wrote a message, as far as the transcript needs to know. */
export type Author = Pick<Member, "name" | "kind" | "display" | "sponsor">

/** A day boundary in the transcript. */
export function DayMark({ ts }: { ts: number }) {
  return (
    <div className="mt-7 mb-2 flex items-center gap-3 select-none">
      <span className="text-[12px] font-semibold text-ink-2">{formatDay(ts)}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  )
}

const EVENT_ICON: Record<Event["op"], IconSvgElement> = {
  hello: CheckListIcon,
  "task.add": CheckListIcon,
  "task.claim": CheckListIcon,
  "task.update": CheckListIcon,
  claim: LockIcon,
  release: SquareUnlock02Icon,
  "fact.set": Key01Icon,
  "fact.del": Key01Icon,
}

/** Coordination (tasks, claims, facts): one quiet line under the conversation. */
export function EventRow({ m, state, onOpenTask }: { m: Message; state: ChannelState; onOpenTask: (id: number) => void }) {
  const taskRef = m.ev && "task" in m.ev ? m.ev.task : m.ev?.op === "task.add" ? m.seq : null
  const forged = state.trust.get(m.seq) === "forged"
  return (
    <div id={`m${m.seq}`} className={cx("-mx-3 grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 px-3 py-[3px]", forged && "line-through opacity-50")}>
      <span className="flex justify-center pt-[3px] text-ink-3">
        <Icon icon={m.ev ? EVENT_ICON[m.ev.op] : CheckListIcon} size={14} />
      </span>
      <p className="text-[12.5px] leading-[1.55] text-ink-2">
        <span className="font-medium text-ink">{memberName(state.members.get(m.from), m.from)}</span> {describeEvent(m, state)}
        <time className="ml-2 text-[11.5px] text-ink-3 tabular-nums" title={formatFull(m.ts)}>
          {formatTime(m.ts)}
        </time>
        {taskRef !== null && (
          <button type="button" onClick={() => onOpenTask(taskRef)} className="ml-2 text-[12px] font-medium text-accent hover:underline">
            Open task
          </button>
        )}
      </p>
    </div>
  )
}

/** What a message asks of the reader, said in words next to the sender's name. */
function phrase(m: Message, me: string, nameOf: (n: string) => string, repliedTo: Set<string>): { text: string; alert?: boolean } | null {
  // Questions and blockers always say who they're for; plain messages only when the text doesn't already.
  const named = (t: string) => m.body.includes(`@${t}`) || repliedTo.has(t)
  const targets = m.kind === "ask" || m.kind === "blocking" ? (m.to ?? []) : (m.to ?? []).filter((t) => !named(t))
  const to = targets.map((t) => (t === me ? "you" : nameOf(t)))
  const list = to.length > 1 ? `${to.slice(0, -1).join(", ")} and ${to[to.length - 1]}` : to[0]
  switch (m.kind) {
    case "ask":
      return { text: list ? `asked ${list}` : "asked everyone" }
    case "blocking":
      return { text: list ? `is blocked and needs ${list}` : "is blocked", alert: true }
    case "done":
      return { text: "finished" }
    case "status":
      return { text: "posted an update" }
    case "ack":
      return { text: "acknowledged" }
    default:
      return list ? { text: `to ${list}` } : null
  }
}

interface RowProps {
  m: Message
  me: string
  /** Found by the key that signed the message, so two members sharing a name still read right. */
  author?: Author
  trust?: Trust
  online: boolean
  /** The first message in a run from one sender shows who sent it. */
  head: boolean
  /** The message right above is the one this replies to, so there's no need to quote it. */
  adjacentReply: boolean
  highlighted: boolean
  quoted: (seq: number) => Message | undefined
  nameOf: (name: string) => string
  onReply: (m: Message) => void
  onJump: (seq: number) => void
}

export const MessageRow = memo(function MessageRow({ m, me, author, trust, online, head, adjacentReply, highlighted, quoted, nameOf, onReply, onJump }: RowProps) {
  const forged = trust === "forged"
  const repliedTo = new Set((m.re ?? []).map((seq) => quoted(seq)?.from).filter((f): f is string => !!f))
  const said = phrase(m, me, nameOf, repliedTo)
  const sponsor = author?.sponsor && isAgent(author) ? `Agent for ${author.sponsor.name}` : isAgent(author) ? "Agent" : "Person"
  const who = memberName(author, m.from)
  // Image-only messages carry the file names as their body; don't print them.
  const imageOnly = !!m.imgs?.length && m.body === m.imgs.map((i) => i.name).join(", ")

  return (
    <div
      id={`m${m.seq}`}
      className={cx("group relative -mx-3 grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 rounded-[10px] px-3 transition-colors hover:bg-wash", head ? "mt-3 pt-1.5 pb-1" : "py-[3px]", highlighted && "animate-flash")}
    >
      <div>
        {head ? (
          <Monogram name={who} agent={isAgent(author)} online={online} className="mt-0.5" />
        ) : (
          <time className="invisible block pt-[3px] text-right text-[10.5px] text-ink-3 tabular-nums group-hover:visible" title={formatFull(m.ts)}>
            {formatTime(m.ts).replace(/\s?[AP]M$/i, "")}
          </time>
        )}
      </div>

      <div className="min-w-0">
        {head && (
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13.5px] font-semibold tracking-[-0.01em]" title={sponsor}>
              {who}
            </span>
            {said && <span className={cx("truncate text-[13px]", said.alert ? "font-medium text-alert" : "text-ink-2")}>{said.text}</span>}
            <time className="ml-auto shrink-0 pl-2 text-[11.5px] text-ink-3 tabular-nums" title={formatFull(m.ts)}>
              {formatTime(m.ts)}
            </time>
          </div>
        )}
        {!head && said && <p className={cx("text-[12.5px]", said.alert ? "font-medium text-alert" : "text-ink-2")}>{said.text}</p>}

        {!adjacentReply && m.re?.map((seq) => {
          const q = quoted(seq)
          return (
            <button key={seq} type="button" onClick={() => onJump(seq)} className="mt-0.5 flex max-w-full items-center gap-1.5 text-left text-[12.5px] text-ink-3 transition-colors hover:text-ink-2">
              <Icon icon={ArrowTurnBackwardIcon} size={13} className="shrink-0" />
              <span className="truncate">
                <span className="font-medium text-ink-2">{q ? nameOf(q.from) : "Earlier message"}</span> {q ? excerpt(q.body, 110) : ""}
              </span>
            </button>
          )
        })}

        {!imageOnly && (
          <div className={cx("text-[14px] leading-[1.6]", forged ? "text-ink-3 line-through" : "text-ink")}>
            <Markdown>{m.body}</Markdown>
          </div>
        )}

        {m.imgs?.length ? (
          <div className="mt-1.5 flex flex-wrap gap-2">
            {m.imgs.map((img, i) => {
              const url = `data:${img.mime};base64,${img.data}`
              return (
                <a key={i} href={url} target="_blank" rel="noreferrer" title={img.name}>
                  <img src={url} alt={img.name} loading="lazy" className="max-h-72 max-w-full rounded-[8px] object-cover shadow-[0_0_0_0.5px_var(--line)]" />
                </a>
              )
            })}
          </div>
        ) : null}

        {forged && <p className="mt-0.5 text-[12px] text-alert">Not signed by {m.from}’s key, so agents ignore it.</p>}
      </div>

      <div className="absolute top-1 right-2 hidden items-center rounded-[8px] bg-raised p-0.5 shadow-pop group-hover:flex">
        <IconButton label="Reply" className="size-7" onClick={() => onReply(m)}>
          <Icon icon={ArrowTurnBackwardIcon} size={15} />
        </IconButton>
        <IconButton label="Copy text" className="size-7" onClick={() => navigator.clipboard.writeText(m.body).then(() => toast("Copied"))}>
          <Icon icon={Copy01Icon} size={15} />
        </IconButton>
      </div>
    </div>
  )
})
