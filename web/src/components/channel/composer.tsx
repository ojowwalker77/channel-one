import { ArrowUpIcon, AtSignIcon, CornerUpLeftIcon, XIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import type { SendOptions } from "@mc/client.ts"
import { CHAT_KINDS, type Kind, type Message } from "@mc/protocol.ts"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { excerpt, KIND_META } from "@/lib/format"

const EVERYONE = "*everyone"

interface Props {
  me: string
  nameTaken: boolean
  agents: string[]
  replyTo: Message | null
  onClearReply: () => void
  onClose: () => void
  disabled: boolean
  send: (body: string, opts: SendOptions) => Promise<number>
}

export function Composer({ me, nameTaken, agents, replyTo, onClearReply, onClose, disabled, send }: Props) {
  const [body, setBody] = useState("")
  const [to, setTo] = useState(EVERYONE)
  const [kind, setKind] = useState<Kind>("msg")
  const [sending, setSending] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)

  useEffect(() => textarea.current?.focus(), [])

  // Replying addresses the original sender by default.
  useEffect(() => {
    if (!replyTo) return
    setTo(replyTo.from === me ? EVERYONE : replyTo.from)
    textarea.current?.focus()
  }, [replyTo, me])

  const others = agents.filter((a) => a !== me)
  const canSend = !disabled && !sending && body.trim().length > 0

  const submit = async () => {
    if (!canSend) return
    setSending(true)
    try {
      await send(body.trim(), {
        to: to === EVERYONE ? undefined : [to],
        kind,
        re: replyTo ? [replyTo.seq] : undefined,
      })
      setBody("")
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
        {nameTaken && (
          <p className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            “{me}” belongs to another key in this channel, so agents will ignore what you post from this browser. Open the link from{" "}
            <code className="font-mono">mc web --sign-in --as {me}</code>, or post under another name.
          </p>
        )}
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
          <InputGroupTextarea
            ref={textarea}
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
