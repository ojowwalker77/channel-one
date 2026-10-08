import { ArrowDown01Icon, ArrowUp02Icon, Attachment01Icon, Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import type { SendOptions } from "@mc/client.ts"
import { MAX_IMAGE_BYTES, type Kind, type Message } from "@mc/protocol.ts"
import { excerpt } from "@/lib/format"
import { cx } from "@/lib/utils"
import { Icon } from "./icon"
import { IconButton, Monogram, errorText, toast } from "./kit"

/** What a message is, in the words the menu uses. */
const KINDS: { kind: Kind; label: string; hint: string }[] = [
  { kind: "msg", label: "Message", hint: "Say something to the channel" },
  { kind: "ask", label: "Question", hint: "Ask, and expect an answer" },
  { kind: "blocking", label: "Blocker", hint: "You can’t go on without it" },
  { kind: "status", label: "Update", hint: "Where things stand" },
  { kind: "done", label: "Done", hint: "Something is finished" },
]
const MENTION = /(^|\s)@([\p{L}\p{N}_.-]*)$/u
const LEADING = /^(?:\s*@([\p{L}\p{N}_.-]+)[\s,]*)+/u

export interface Person {
  name: string
  label: string
  agent: boolean
}

interface Props {
  me: string
  people: Person[]
  replyTo: Message | null
  nameOf: (name: string) => string
  onClearReply: () => void
  disabled: boolean
  send: (body: string, opts: SendOptions) => Promise<number>
}

/** Who a message is for: the people @mentioned at its start. */
function recipients(body: string, names: Set<string>): string[] {
  const lead = LEADING.exec(body)?.[0] ?? ""
  return [...lead.matchAll(/@([\p{L}\p{N}_.-]+)/gu)].map((m) => m[1]!).filter((n) => names.has(n))
}

export function Composer({ me, people, replyTo, nameOf, onClearReply, disabled, send }: Props) {
  const [body, setBody] = useState("")
  const [kind, setKind] = useState<Kind>("msg")
  const [files, setFiles] = useState<{ name: string; mime: string; data: string }[]>([])
  const [sending, setSending] = useState(false)
  const [menu, setMenu] = useState(false)
  const [mention, setMention] = useState<{ query: string; index: number } | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)

  const others = useMemo(() => people.filter((p) => p.name !== me), [people, me])
  const names = useMemo(() => new Set(others.map((p) => p.name)), [others])
  const matches = useMemo(() => {
    if (!mention) return []
    const q = mention.query.toLowerCase()
    return others.filter((p) => p.name.toLowerCase().startsWith(q) || p.label.toLowerCase().startsWith(q)).slice(0, 6)
  }, [mention, others])
  const current = KINDS.find((k) => k.kind === kind)!

  // Grow with the text, up to a point.
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [body])

  useEffect(() => {
    if (replyTo) area.current?.focus()
  }, [replyTo])

  const canSend = !disabled && !sending && (body.trim().length > 0 || files.length > 0)

  const pick = (list: FileList | null) => {
    if (!list) return
    for (const f of [...list].slice(0, 8 - files.length)) {
      if (!f.type.startsWith("image/")) {
        toast(`${f.name} isn’t an image. Only images can be attached.`, "error")
        continue
      }
      if (f.size > MAX_IMAGE_BYTES) {
        toast(`${f.name} is over ${Math.round(MAX_IMAGE_BYTES / 1024)} KB. Attach a smaller image.`, "error")
        continue
      }
      const reader = new FileReader()
      reader.onload = () => {
        const url = String(reader.result)
        setFiles((prev) => (prev.length < 8 ? [...prev, { name: f.name, mime: f.type, data: url.slice(url.indexOf(",") + 1) }] : prev))
      }
      reader.readAsDataURL(f)
    }
  }

  const trackMention = (value: string, caret: number) => {
    const m = MENTION.exec(value.slice(0, caret))
    setMention(m ? { query: m[2]!, index: 0 } : null)
  }

  const complete = (p: Person) => {
    const el = area.current
    const caret = el?.selectionStart ?? body.length
    const before = body.slice(0, caret).replace(MENTION, (_all, pre: string) => `${pre}@${p.name} `)
    setBody(before + body.slice(caret))
    setMention(null)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(before.length, before.length)
    })
  }

  const submit = async () => {
    if (!canSend) return
    setSending(true)
    try {
      const text = body.trim() || files.map((f) => f.name).join(", ")
      const to = recipients(text, names)
      await send(text, {
        to: to.length ? to : replyTo && replyTo.from !== me ? [replyTo.from] : undefined,
        kind,
        re: replyTo ? [replyTo.seq] : undefined,
        imgs: files.length ? files : undefined,
      })
      setBody("")
      setFiles([])
      setKind("msg")
      onClearReply()
    } catch (err) {
      toast(`Not sent: ${errorText(err)}`, "error")
    } finally {
      setSending(false)
      area.current?.focus()
    }
  }

  return (
    <div className="relative mx-auto w-full max-w-[760px] shrink-0 px-4 pt-2 pb-4 md:px-8">
      <input ref={picker} type="file" accept="image/*" multiple className="hidden" onChange={(e) => (pick(e.target.files), (e.target.value = ""))} />

      {matches.length > 0 && (
        <div className="animate-rise absolute bottom-full left-4 z-20 mb-1 w-64 overflow-hidden rounded-[10px] bg-raised p-1 shadow-pop md:left-8">
          {matches.map((p, i) => (
            <button
              key={p.name}
              type="button"
              onMouseDown={(e) => (e.preventDefault(), complete(p))}
              className={cx("flex w-full items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-left text-[13px]", i === mention!.index ? "bg-wash-2" : "hover:bg-wash")}
            >
              <Monogram name={p.label} agent={p.agent} size={20} />
              <span className="truncate font-medium">{p.label}</span>
              {p.label !== p.name && <span className="truncate text-ink-3">@{p.name}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="rounded-[12px] bg-canvas shadow-[inset_0_0_0_1px_var(--line),0_1px_2px_rgba(0,0,0,0.03)] transition-shadow focus-within:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ink)_22%,transparent),0_0_0_3px_var(--wash)]">
        {replyTo && (
          <div className="flex items-center gap-2 px-3.5 pt-2.5 text-[12.5px] text-ink-2">
            <span className="min-w-0 truncate">
              Replying to <span className="font-medium text-ink">{nameOf(replyTo.from)}</span> <span className="text-ink-3">{excerpt(replyTo.body, 80)}</span>
            </span>
            <IconButton label="Cancel reply" className="ml-auto size-6" onClick={onClearReply}>
              <Icon icon={Cancel01Icon} size={13} />
            </IconButton>
          </div>
        )}

        {files.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-3 pt-3">
            {files.map((f, i) => (
              <span key={i} className="group relative shrink-0">
                <img src={`data:${f.mime};base64,${f.data}`} alt={f.name} title={f.name} className="size-16 rounded-[8px] object-cover shadow-[0_0_0_0.5px_var(--line)]" />
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-ink text-canvas"
                >
                  <Icon icon={Cancel01Icon} size={11} strokeWidth={2.2} />
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={area}
          rows={1}
          value={body}
          disabled={disabled}
          placeholder={disabled ? "Connecting…" : replyTo ? `Reply to ${nameOf(replyTo.from)}` : "Write to the channel. Type @ to address someone."}
          onChange={(e) => {
            setBody(e.target.value)
            trackMention(e.target.value, e.target.selectionStart)
          }}
          onKeyDown={(e) => {
            if (matches.length && mention) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault()
                const d = e.key === "ArrowDown" ? 1 : -1
                setMention({ ...mention, index: (mention.index + d + matches.length) % matches.length })
                return
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault()
                complete(matches[mention.index]!)
                return
              }
              if (e.key === "Escape") return setMention(null)
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void submit()
            }
            if (e.key === "Escape" && replyTo) onClearReply()
          }}
          className="block max-h-[220px] min-h-[46px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[14px] leading-[1.5] outline-none placeholder:text-ink-3 focus-visible:outline-none"
        />

        <div className="flex items-center gap-1 px-2 pb-2">
          <IconButton label="Attach images" className="size-7" onClick={() => picker.current?.click()} disabled={disabled || files.length >= 8}>
            <Icon icon={Attachment01Icon} size={16} />
          </IconButton>
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenu((v) => !v)}
              disabled={disabled}
              aria-haspopup="menu"
              aria-expanded={menu}
              className={cx("flex h-7 items-center gap-1 rounded-[7px] px-2 text-[12.5px] font-medium transition-colors", kind === "msg" ? "text-ink-2 hover:bg-wash hover:text-ink" : "bg-wash-2 text-ink")}
            >
              {current.label}
              <Icon icon={ArrowDown01Icon} size={13} />
            </button>
            {menu && (
              <>
                <div className="fixed inset-0 z-10" onMouseDown={() => setMenu(false)} />
                <div role="menu" className="animate-rise absolute bottom-full left-0 z-20 mb-1.5 w-60 rounded-[10px] bg-raised p-1 shadow-pop">
                  {KINDS.map((k) => (
                    <button
                      key={k.kind}
                      type="button"
                      role="menuitemradio"
                      aria-checked={kind === k.kind}
                      onClick={() => (setKind(k.kind), setMenu(false), area.current?.focus())}
                      className="flex w-full items-start gap-2 rounded-[7px] px-2 py-1.5 text-left hover:bg-wash"
                    >
                      <span className="w-4 pt-0.5 text-accent">{kind === k.kind && <Icon icon={Tick02Icon} size={14} strokeWidth={2} />}</span>
                      <span>
                        <span className="block text-[13px] font-medium">{k.label}</span>
                        <span className="block text-[12px] text-ink-3">{k.hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <span className="ml-auto hidden pr-1 text-[11.5px] text-ink-3 sm:block">Return to send</span>
          <button
            type="button"
            aria-label="Send"
            disabled={!canSend}
            onClick={() => void submit()}
            className={cx("ml-auto flex size-7 shrink-0 items-center justify-center rounded-[7px] transition-colors sm:ml-1", canSend ? "bg-accent text-white hover:brightness-110" : "bg-wash-2 text-ink-3")}
          >
            <Icon icon={ArrowUp02Icon} size={15} strokeWidth={2.2} />
          </button>
        </div>
      </div>
    </div>
  )
}
