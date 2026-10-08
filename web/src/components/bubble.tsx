import { Alert02Icon, ArrowTurnBackwardIcon, CheckmarkCircle02Icon, Copy01Icon, HelpCircleIcon } from "@hugeicons/core-free-icons"
import { memo, type CSSProperties } from "react"

import { describeEvent } from "@mc/format.ts"
import type { Kind, Message, Trust } from "@mc/protocol.ts"
import type { ChannelState, Member } from "@mc/state.ts"
import { excerpt, formatDay, formatFull, formatTime, memberName, voiceOf } from "@/lib/format"
import { cx } from "@/lib/utils"
import { Icon, type IconSvgElement } from "./icon"
import { Avatar, IconButton, toast } from "./kit"
import { Markdown } from "./markdown"

/** A member's voice colour: agents have one; people speak in neutral grey. */
export function voiceFor(name: string, author: Pick<Member, "kind"> | undefined): string | null {
  return author?.kind === "human" ? null : voiceOf(name)
}

/** Kinds that change what a message asks of the reader get a glyph beside the sender's name. */
const KIND_GLYPH: Partial<Record<Kind, { icon: IconSvgElement; label: string; className: string }>> = {
  ask: { icon: HelpCircleIcon, label: "Question", className: "text-blue" },
  blocking: { icon: Alert02Icon, label: "Blocking", className: "text-red" },
  done: { icon: CheckmarkCircle02Icon, label: "Done", className: "text-green" },
}

/** A centered timestamp between bursts of conversation. */
export function TimeMark({ ts }: { ts: number }) {
  return (
    <div className="pt-6 pb-2 text-center text-[11px] text-label-2 select-none">
      <span className="font-semibold">{formatDay(ts)}</span> <span className="tabular-nums">{formatTime(ts)}</span>
    </div>
  )
}

/** Coordination (tasks, claims, facts) reads as a quiet centered line in the speaker's colour. */
export function EventLine({ m, state, onOpenTask }: { m: Message; state: ChannelState; onOpenTask: (id: number) => void }) {
  const taskRef = m.ev && "task" in m.ev ? m.ev.task : m.ev?.op === "task.add" ? m.seq : null
  const forged = state.trust.get(m.seq) === "forged"
  const author = state.members.get(m.from)
  const voice = voiceFor(m.from, author)
  const text = (
    <>
      <span className={cx("font-semibold", voice && "voice-ink")} style={voice ? ({ "--voice": voice } as CSSProperties) : undefined}>
        {memberName(author, m.from)}
      </span>{" "}
      {describeEvent(m, state)}
    </>
  )
  return (
    <div id={`m${m.seq}`} className={cx("mx-auto max-w-md px-6 py-[3px] text-center text-[12px] leading-snug text-label-2", forged && "line-through opacity-50")} title={formatFull(m.ts)}>
      {taskRef !== null ? (
        <button type="button" onClick={() => onOpenTask(taskRef)} className="rounded-md px-1 transition-colors hover:text-label">
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
  const voice = mine ? null : voiceFor(m.from, author)
  const glyph = KIND_GLYPH[m.kind]
  // Only say who it's for when the text doesn't already @mention them.
  const unnamed = (m.to ?? []).filter((t) => !m.body.includes(`@${t}`))
  // Image-only messages carry the file names as their body; don't repeat them in a bubble.
  const imageOnly = !!m.imgs?.length && m.body === m.imgs.map((i) => i.name).join(", ")
  const showName = !mine && first
  const showCaption = showName || unnamed.length > 0 || !!glyph

  const look: { className: string; style: CSSProperties } = forged
    ? { className: "shadow-[inset_0_0_0_1px_var(--red)] text-label-2", style: {} }
    : mine
      ? { className: "bg-blue text-white", style: { "--bubble": "var(--blue)" } as CSSProperties }
      : voice
        ? { className: "voice-tint text-label", style: { "--voice": voice, "--bubble": `color-mix(in srgb, ${voice} var(--tint), var(--tint-base))` } as CSSProperties }
        : { className: "bg-fill text-label", style: { "--bubble": "var(--fill)" } as CSSProperties }

  return (
    <div id={`m${m.seq}`} className={cx("flex gap-2", mine ? "flex-row-reverse" : "flex-row", first ? "mt-3.5" : "mt-[3px]", highlighted && "animate-flash rounded-[20px]")}>
      {!mine && <div className="relative z-[2] mr-0.5 flex w-7 shrink-0 items-end">{last && <Avatar name={nameOf(m.from)} voice={voice} size={28} />}</div>}

      <div className={cx("flex max-w-[76%] min-w-0 flex-col", mine ? "items-end" : "items-start")}>
        {showCaption && (
          <div className="mb-1 flex items-center gap-1.5 px-3 text-[12px] leading-none text-label-2">
            {showName && (
              <span className={cx("font-semibold", voice && "voice-ink")} style={voice ? ({ "--voice": voice } as CSSProperties) : undefined}>
                {nameOf(m.from)}
              </span>
            )}
            {unnamed.length > 0 && <span>to {unnamed.map((t) => (t === me ? "you" : nameOf(t))).join(", ")}</span>}
            {glyph && (
              <span className={cx("inline-flex", glyph.className)} title={glyph.label} role="img" aria-label={glyph.label}>
                <Icon icon={glyph.icon} size={14} strokeWidth={2} />
              </span>
            )}
          </div>
        )}

        <div className={cx("group flex items-center gap-0.5", mine ? "flex-row-reverse" : "flex-row")}>
          {!imageOnly && (
            <div
              title={formatFull(m.ts)}
              onDoubleClick={() => onReply(m)}
              style={look.style}
              className={cx("relative rounded-[18px] px-3 py-[7px] text-[14.5px] leading-[1.42]", look.className, last && !forged && (mine ? "tail-me" : "tail-them"))}
            >
              <div className="relative z-[1]">
                {m.re?.map((seq) => {
                  const q = quoted(seq)
                  return (
                    <button
                      key={seq}
                      type="button"
                      onClick={() => onJump(seq)}
                      className={cx(
                        "-mx-1 mt-0.5 mb-1.5 block w-[calc(100%+8px)] rounded-[12px] px-2.5 py-1.5 text-left text-[13px] leading-snug transition-colors",
                        mine ? "bg-white/15 hover:bg-white/22" : "bg-black/[0.045] hover:bg-black/[0.07] dark:bg-white/[0.07] dark:hover:bg-white/10"
                      )}
                    >
                      <span className="block text-[12px] font-semibold">{q ? nameOf(q.from) : "Earlier message"}</span>
                      <span className="line-clamp-2 opacity-75">{q ? excerpt(q.body, 120) : `#${seq}`}</span>
                    </button>
                  )
                })}
                <Markdown onBlue={mine && !forged}>{m.body}</Markdown>
              </div>
            </div>
          )}
          <div className="flex shrink-0 items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
            <IconButton label="Reply" className="size-7" onClick={() => onReply(m)}>
              <Icon icon={ArrowTurnBackwardIcon} size={16} />
            </IconButton>
            <IconButton label="Copy text" className="size-7" onClick={() => navigator.clipboard.writeText(m.body).then(() => toast("Copied"))}>
              <Icon icon={Copy01Icon} size={16} />
            </IconButton>
          </div>
        </div>

        {m.imgs?.length ? (
          <div className={cx("mt-1 flex flex-wrap gap-1.5", mine && "justify-end")}>
            {m.imgs.map((img, i) => {
              const url = `data:${img.mime};base64,${img.data}`
              return (
                <a key={i} href={url} target="_blank" rel="noreferrer" title={img.name}>
                  <img src={url} alt={img.name} loading="lazy" className="max-h-64 max-w-full rounded-[18px] object-cover" />
                </a>
              )
            })}
          </div>
        ) : null}

        {forged && <p className="mt-1 px-3 text-[12px] text-red">Not signed by {m.from}’s key, so agents ignore it.</p>}
      </div>
    </div>
  )
})
