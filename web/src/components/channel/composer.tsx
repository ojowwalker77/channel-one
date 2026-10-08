import { ArrowUpIcon, AtSignIcon, CornerUpLeftIcon, ImagePlusIcon, XIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import type { SendOptions } from "@mc/client.ts"
import { CHAT_KINDS, MAX_IMAGE_BYTES, type Kind, type Message } from "@mc/protocol.ts"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { excerpt, KIND_META } from "@/lib/format"

const EVERYONE = "*everyone"

interface Props {
  me: string
  agents: string[]
  replyTo: Message | null
  onClearReply: () => void
  onClose: () => void
  disabled: boolean
  send: (body: string, opts: SendOptions) => Promise<number>
}

export function Composer({ me, agents, replyTo, onClearReply, onClose, disabled, send }: Props) {
  const [body, setBody] = useState("")
  const [to, setTo] = useState(EVERYONE)
  const [kind, setKind] = useState<Kind>("msg")
  const [files, setFiles] = useState<{ name: string; mime: string; data: string }[]>([])
  const [sending, setSending] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => textarea.current?.focus(), [])

  // Replying addresses the original sender by default.
  useEffect(() => {
    if (!replyTo) return
    setTo(replyTo.from === me ? EVERYONE : replyTo.from)
    textarea.current?.focus()
  }, [replyTo, me])

  const others = agents.filter((a) => a !== me)
  const canSend = !disabled && !sending && (body.trim().length > 0 || files.length > 0)

  const pick = (list: FileList | null) => {
    if (!list) return
    for (const f of [...list].slice(0, 8 - files.length)) {
      if (!f.type.startsWith("image/")) {
        toast.error("Only images can be attached", { description: f.name })
        continue
      }
      if (f.size > MAX_IMAGE_BYTES) {
        toast.error("Image too large", { description: `${f.name} is ${Math.round(f.size / 1024)}KB (limit ${Math.round(MAX_IMAGE_BYTES / 1024)}KB)` })
        continue
      }
      const reader = new FileReader()
      reader.onload = () => {
        const url = String(reader.result)
        const data = url.slice(url.indexOf(",") + 1)
        setFiles((prev) => (prev.length < 8 ? [...prev, { name: f.name, mime: f.type, data }] : prev))
      }
      reader.readAsDataURL(f)
    }
  }

  const submit = async () => {
    if (!canSend) return
    setSending(true)
    try {
      await send(body.trim() || files.map((f) => f.name).join(", "), {
        to: to === EVERYONE ? undefined : [to],
        kind,
        re: replyTo ? [replyTo.seq] : undefined,
        imgs: files.length ? files : undefined,
      })
      setBody("")
      setFiles([])
      setKind("msg")
      onClose()
    } catch (err) {
      toast.error("Message not sent", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setSending(false)
      textarea.current?.focus()
    }
  }

  return (
    <div className="border-t bg-background px-3 pt-3 pb-4 md:px-6">
      <div className="mx-auto max-w-4xl">
        <input ref={picker} type="file" accept="image/*" multiple className="hidden" onChange={(e) => (pick(e.target.files), (e.target.value = ""))} />
        <InputGroup className="rounded-xl bg-card shadow-xs">
          {replyTo && (
            <InputGroupAddon align="block-start" className="border-b pb-2">
              <CornerUpLeftIcon className="size-3.5" />
              <span className="min-w-0 truncate text-xs font-normal">
                Replying to <span className="font-medium text-foreground">{replyTo.from}</span>
                <span className="ml-1.5 text-muted-foreground">{excerpt(replyTo.body, 80)}</span>
              </span>
              <InputGroupButton size="icon-xs" className="ml-auto" onClick={onClearReply} aria-label="Cancel reply">
                <XIcon />
              </InputGroupButton>
            </InputGroupAddon>
          )}
          {files.length > 0 && (
            <InputGroupAddon align="block-start" className="gap-2 border-b pb-2">
              {files.map((f, i) => (
                <span key={i} className="relative shrink-0">
                  <img src={`data:${f.mime};base64,${f.data}`} alt={f.name} title={f.name} className="h-14 w-14 rounded-lg border object-cover" />
                  <button
                    type="button"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                    className="absolute -top-1.5 -right-1.5 rounded-full border bg-background p-0.5 shadow-xs hover:bg-muted"
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              ))}
            </InputGroupAddon>
          )}
          <InputGroupTextarea ref={textarea}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              }
              if (e.key === "Escape") {
                if (replyTo) onClearReply()
                else if (!body.trim()) onClose()
              }
            }}
            placeholder={disabled ? "Connecting…" : `Message ${to === EVERYONE ? "everyone" : to}`}
            className="max-h-64 min-h-12 text-sm"
            disabled={disabled}
          />
          <InputGroupAddon align="block-end" className="gap-1.5">
            <InputGroupButton size="icon-xs" onClick={() => picker.current?.click()} aria-label="Attach images" disabled={disabled || files.length >= 8}>
              <ImagePlusIcon />
            </InputGroupButton>
            <Select value={to} onValueChange={setTo}>
              <SelectTrigger size="sm" className="h-7 gap-1.5 border-0 bg-muted/60 px-2 text-xs shadow-none dark:bg-muted/40" aria-label="Recipient">
                <AtSignIcon className="size-3.5 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EVERYONE}>Everyone</SelectItem>
                {others.length > 0 && <SelectSeparator />}
                <SelectGroup>
                  {others.length > 0 && <SelectLabel>Agents</SelectLabel>}
                  {others.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>

            <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
              <SelectTrigger size="sm" className="h-7 gap-1.5 border-0 bg-muted/60 px-2 text-xs shadow-none dark:bg-muted/40" aria-label="Message type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHAT_KINDS.map((k) => {
                  const meta = k === "msg" || k === "event" ? null : KIND_META[k]
                  return (
                    <SelectItem key={k} value={k}>
                      {meta ? <meta.icon /> : null}
                      {meta ? meta.label : "Message"}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>

            <span className="ml-auto hidden items-center gap-1 text-xs font-normal text-muted-foreground sm:flex">
              <Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line
            </span>
            <InputGroupButton size="icon-xs" className="ml-auto sm:ml-2" onClick={onClose} aria-label="Close">
              <XIcon />
            </InputGroupButton>
            <InputGroupButton
              variant="default"
              size="icon-xs"
              className="rounded-md"
              disabled={!canSend}
              onClick={() => void submit()}
              aria-label="Send"
            >
              <ArrowUpIcon />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </div>
    </div>
  )
}
