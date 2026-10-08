import { Add01Icon, ArrowUp02Icon, Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import type { SendOptions } from "@mc/client.ts"
import { MAX_IMAGE_BYTES, type Kind, type Message } from "@mc/protocol.ts"
import { excerpt, KIND_LABEL } from "@/lib/format"
import { cx } from "@/lib/utils"
import { Icon } from "./icon"
import { Avatar, IconButton, errorText, toast } from "./kit"

const KINDS: Kind[] = ["ask", "blocking", "status", "done"]
const MENTION = /(^|\s)@([\p{L}\p{N}_.-]*)$/u
const LEADING = /^(?:\s*@([\p{L}\p{N}_.-]+)[\s,]*)+/u

interface Person {
  name: string
  label: string
  voice: string | null
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

/** The message bar: a rounded field, a "+" for photos and message types, a blue send arrow. */
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

  // Grow with the text, up to a point.
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [body])

  useEffect(() => {
    if (replyTo) area.current?.focus()
  }, [replyTo])

  const canSend = !disabled && !sending && (body.trim().length > 0 || files.length > 0)

  const pick = (list: FileList | null) => {
    if (!list) return
    for (const f of [...list].slice(0, 8 - files.length)) {
      if (!f.type.startsWith("image/")) {
        toast(`Only images can be attached: ${f.name}`, "error")
        continue
      }
      if (f.size > MAX_IMAGE_BYTES) {
        toast(`${f.name} is over ${Math.round(MAX_IMAGE_BYTES / 1024)} KB`, "error")
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
    const next = before + body.slice(caret)
    setBody(next)
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
      toast(`Not delivered: ${errorText(err)}`, "error")
    } finally {
      setSending(false)
      area.current?.focus()
    }
  }

  return (
    <div className="relative mx-auto w-full max-w-[800px] shrink-0 px-3 pt-2 pb-4 md:px-6">
      <input ref={picker} type="file" accept="image/*" multiple className="hidden" onChange={(e) => (pick(e.target.files), (e.target.value = ""))} />

      {matches.length > 0 && (
        <div className="animate-rise absolute bottom-full left-14 z-20 mb-1 w-64 overflow-hidden rounded-xl bg-elevated py-1 shadow-[0_10px_40px_rgba(0,0,0,0.18)] ring-1 ring-separator">
          {matches.map((p, i) => (
            <button
              key={p.name}
              type="button"
              onMouseDown={(e) => (e.preventDefault(), complete(p))}
              className={cx("flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[14px]", i === mention!.index ? "bg-blue text-white" : "hover:bg-fill-2")}
            >
              <Avatar name={p.label} voice={i === mention!.index ? null : p.voice} size={22} />
              <span className="truncate font-medium">{p.label}</span>
              {p.label !== p.name && <span className={cx("truncate text-[12px]", i === mention!.index ? "text-white/75" : "text-label-2")}>@{p.name}</span>}
            </button>
          ))}
        </div>
      )}

      {menu && (
        <>
          <div className="fixed inset-0 z-10" onMouseDown={() => setMenu(false)} />
          <div className="animate-rise absolute bottom-full left-3 z-20 mb-1 w-52 overflow-hidden rounded-xl bg-elevated py-1 text-[14px] shadow-[0_10px_40px_rgba(0,0,0,0.18)] ring-1 ring-separator md:left-5">
            <button type="button" className="flex w-full items-center px-3 py-1.5 hover:bg-fill-2" onClick={() => (setMenu(false), picker.current?.click())}>
              Photos…
            </button>
            <div className="my-1 h-px bg-separator" />
            <p className="px-3 py-1 text-[11px] text-label-2">Send as</p>
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                className="flex w-full items-center justify-between px-3 py-1.5 hover:bg-fill-2"
                onClick={() => (setKind(kind === k ? "msg" : k), setMenu(false), area.current?.focus())}
              >
                {KIND_LABEL[k]!.label}
                {kind === k && <Icon icon={Tick02Icon} size={16} className="text-blue" />}
              </button>
            ))}
          </div>
        </>
      )}

      {replyTo && (
        <div className="mb-1.5 ml-11 flex items-center gap-2 text-[12px] text-label-2">
          <span className="min-w-0 truncate">
            Replying to <span className="font-medium text-label">{nameOf(replyTo.from)}</span> · {excerpt(replyTo.body, 80)}
          </span>
          <IconButton label="Cancel reply" className="size-5" onClick={onClearReply}>
            <Icon icon={Cancel01Icon} size={13} />
          </IconButton>
        </div>
      )}

      <div className="flex items-end gap-2">
        <IconButton label="Photos and message types" className="mb-[3px] bg-fill-2" onClick={() => setMenu((v) => !v)} disabled={disabled}>
          <Icon icon={Add01Icon} size={18} strokeWidth={2} />
        </IconButton>

        <div className="flex min-w-0 flex-1 flex-col rounded-[18px] bg-bg shadow-[inset_0_0_0_1px_var(--separator)] transition-shadow focus-within:shadow-[inset_0_0_0_1px_var(--label-3)]">
          {files.length > 0 && (
            <div className="flex gap-2 overflow-x-auto px-2 pt-2">
              {files.map((f, i) => (
                <span key={i} className="relative shrink-0">
                  <img src={`data:${f.mime};base64,${f.data}`} alt={f.name} title={f.name} className="size-16 rounded-xl object-cover" />
                  <button
                    type="button"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                    className="absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full bg-label-2 text-bg"
                  >
                    <Icon icon={Cancel01Icon} size={11} strokeWidth={2.2} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-end gap-1.5 pl-3">
            {kind !== "msg" && (
              <button
                type="button"
                onClick={() => setKind("msg")}
                title="Send as a plain message"
                className={cx("mb-[7px] flex shrink-0 items-center gap-0.5 rounded-full bg-fill-2 px-2 py-0.5 text-[12px] font-medium", KIND_LABEL[kind]?.tone)}
              >
                {KIND_LABEL[kind]?.label}
                <Icon icon={Cancel01Icon} size={11} strokeWidth={2.2} />
              </button>
            )}
            <textarea
              ref={area}
              rows={1}
              value={body}
              disabled={disabled}
              placeholder={disabled ? "Connecting…" : "Message"}
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
              className="max-h-[180px] min-h-[34px] flex-1 resize-none bg-transparent py-[7px] text-[14.5px] leading-5 outline-none placeholder:text-label-3 focus-visible:outline-none"
            />
            <button
              type="button"
              aria-label="Send"
              disabled={!canSend}
              onClick={() => void submit()}
              className={cx(
                "m-[4px] flex size-[26px] shrink-0 items-center justify-center rounded-full bg-blue text-white transition-[opacity,transform] duration-150 hover:brightness-[1.08]",
                canSend ? "scale-100 opacity-100" : "pointer-events-none scale-75 opacity-0"
              )}
            >
              <Icon icon={ArrowUp02Icon} size={16} strokeWidth={2.4} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
