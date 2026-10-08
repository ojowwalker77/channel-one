import { CopyIcon, CornerUpLeftIcon } from "lucide-react"
import { memo } from "react"

import { describeEvent } from "@mc/format.ts"
import type { Message, Trust } from "@mc/protocol.ts"
import type { ChannelState, Member } from "@mc/state.ts"
import { excerpt, formatDay, formatFull, formatTime, KIND_LABEL, memberName } from "@/lib/format"
import { cx } from "@/lib/utils"
import { Avatar, IconButton, toast } from "./kit"
import { Markdown } from "./markdown"

/** A centered timestamp between bursts of conversation. */
export function TimeMark({ ts }: { ts: number }) {
  return (
    <div className="pt-4 pb-1 text-center text-[11px] text-label-2 select-none">
      <span className="font-semibold">{formatDay(ts)}</span> {formatTime(ts)}
    </div>
  )
}

/** Coordination events (tasks, claims, facts) read as a quiet centered line. */
export function EventLine({ m, state, onOpenTask }: { m: Message; state: ChannelState; onOpenTask: (id: number) => void }) {
  const taskRef = m.ev && "task" in m.ev ? m.ev.task : m.ev?.op === "task.add" ? m.seq : null
  const forged = state.trust.get(m.seq) === "forged"
  const who = memberName(state.members.get(m.from), m.from)
  const text = (
    <>
      <span className="font-medium text-label">{who}</span> {describeEvent(m, state)}
    </>
  )
  return (
    <div id={`m${m.seq}`} className={cx("px-10 py-1 text-center text-[12px] text-label-2", forged && "line-through opacity-50")} title={formatFull(m.ts)}>
      {taskRef !== null ? (
        <button type="button" onClick={() => onOpenTask(taskRef)} className="rounded-md px-1 hover:text-label">
          {text}
        </button>
      ) : (
        text
      )}
    </div>
  )
}

interface BubbleProps {
  m: Message
  me: string
  author?: Member
  trust?: Trust
  /** First and last of a run of messages from the same sender. */
  first: boolean
  last: boolean
  highlighted: boolean
  quoted: (seq: number) => Message | undefined
  nameOf: (name: string) => string
  onReply: (m: Message) => void
  onJump: (seq: number) => void
}

export const Bubble = memo(function Bubble({ m, me, author, trust, first, last, highlighted, quoted, nameOf, onReply, onJump }: BubbleProps) {
  const mine = m.from === me
  const forged = trust === "forged"
  const kind = KIND_LABEL[m.kind]
  const toMe = !mine && !!m.to?.includes(me)
  // Image-only messages carry the file names as their body; don't repeat them in a bubble.
  const imageOnly = !!m.imgs?.length && m.body === m.imgs.map((i) => i.name).join(", ")
  const whose = author && author.kind !== "human" && author.sponsor ? `agent of @${author.sponsor.handle ?? author.sponsor.name}` : null

  const caption = [
    !mine && first ? <span key="n" className="font-medium text-label">{nameOf(m.from)}</span> : null,
    !mine && first && whose ? <span key="w">{whose}</span> : null,
    m.to?.length ? (
      <span key="t" className={cx(toMe && "font-medium text-blue")}>
        to {m.to.map((t) => (t === me ? "you" : nameOf(t))).join(", ")}
      </span>
    ) : null,
    kind ? (
      <span key="k" className={cx("font-medium", kind.tone)}>
        {kind.label}
      </span>
    ) : null,
  ].filter(Boolean)

  return (
    <div
      id={`m${m.seq}`}
      className={cx("flex gap-2 px-3 md:px-5", mine ? "flex-row-reverse" : "flex-row", first ? "mt-2.5" : "mt-0.5", highlighted && "animate-flash rounded-xl")}
    >
      {!mine && <div className="relative z-[2] mr-1 flex w-7 shrink-0 items-end">{last && <Avatar name={nameOf(m.from)} size={28} />}</div>}

      <div className={cx("flex max-w-[min(78%,620px)] min-w-0 flex-col", mine ? "items-end" : "items-start")}>
        {caption.length > 0 ? (
          <div className={cx("mb-0.5 flex flex-wrap items-center gap-x-1.5 px-3 text-[11px] text-label-2", mine && "justify-end")}>
            {caption.map((c, i) => (
              <span key={i} className="contents">
                {i > 0 && <span aria-hidden>·</span>}
                {c}
              </span>
            ))}
          </div>
        ) : null}

        {m.re?.map((seq) => {
          const q = quoted(seq)
          return (
            <button
              key={seq}
              type="button"
              onClick={() => onJump(seq)}
              className={cx(
                "mb-0.5 flex max-w-full items-center gap-1.5 rounded-2xl border border-separator px-3 py-1 text-left text-[12px] text-label-2 hover:bg-fill-2",
                mine && "self-end"
              )}
            >
              <CornerUpLeftIcon className="size-3 shrink-0" />
              <span className="truncate">{q ? `${nameOf(q.from)}: ${excerpt(q.body, 70)}` : `message #${seq}`}</span>
            </button>
          )
        })}

        <div className={cx("group flex items-center gap-1", mine ? "flex-row-reverse" : "flex-row")}>
          {!imageOnly && (
            <div
              title={formatFull(m.ts)}
              onDoubleClick={() => onReply(m)}
              className={cx(
                "relative rounded-[18px] px-3 py-[7px] text-[15px] leading-[1.35]",
                forged
                  ? "border border-dashed border-red/60 text-label-2"
                  : mine
                    ? cx("bg-blue text-white", last && "tail-me")
                    : cx("bg-fill text-label", last && "tail-them")
              )}
            >
              <div className="relative z-[1]">
                <Markdown onBlue={mine && !forged}>{m.body}</Markdown>
              </div>
            </div>
          )}
          <div className="flex shrink-0 items-center opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
            <IconButton label="Reply" className="size-7 [&_svg]:size-4" onClick={() => onReply(m)}>
              <CornerUpLeftIcon />
            </IconButton>
            <IconButton label="Copy" className="size-7 [&_svg]:size-4" onClick={() => navigator.clipboard.writeText(m.body).then(() => toast("Copied"))}>
              <CopyIcon />
            </IconButton>
          </div>
        </div>

        {m.imgs?.length ? (
          <div className={cx("mt-1 flex flex-wrap gap-1.5", mine && "justify-end")}>
            {m.imgs.map((img, i) => {
              const url = `data:${img.mime};base64,${img.data}`
              return (
                <a key={i} href={url} target="_blank" rel="noreferrer" title={img.name}>
                  <img src={url} alt={img.name} loading="lazy" className="max-h-60 max-w-full rounded-2xl object-cover" />
                </a>
              )
            })}
          </div>
        ) : null}

        {forged && <p className="mt-0.5 px-3 text-[11px] text-red">Not signed by {m.from}’s key. Agents ignore it.</p>}
      </div>
    </div>
  )
})
