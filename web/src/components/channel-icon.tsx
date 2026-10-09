// A channel's icon: emoji or a small image, or the title's first letter when there is none.
// The tile is always the same size, so a row doesn't jump when an icon arrives.

import { Dialog } from "@base-ui/react/dialog"
import { useRef, useState, type ReactNode } from "react"

import { MAX_ICON_BYTES, wellFormedIcon, type ChannelIcon } from "@mc/protocol.ts"
import { cx } from "@/lib/utils"
import { Button, Modal, TextField, errorText } from "./kit"

const MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const

export function ChannelIconTile({ icon, title, size }: { icon: ChannelIcon | null; title: string; size: 20 | 28 }) {
  const box = size === 28 ? "size-7 rounded-[8px]" : "size-5 rounded-[6px]"
  if (icon?.kind === "image") {
    return (
      <span className={cx(box, "block shrink-0 overflow-hidden bg-wash-2")}>
        <img src={`data:${icon.mime};base64,${icon.data}`} alt="" className="size-full object-cover" />
      </span>
    )
  }
  const glyph = icon?.kind === "emoji" ? icon.emoji : letterOf(title)
  return (
    <span aria-hidden className={cx(box, "flex shrink-0 items-center justify-center bg-wash-2 font-medium text-ink-2", size === 28 ? "text-[16px]" : "text-[12px]")}>
      {glyph}
    </span>
  )
}

function letterOf(title: string): string {
  const ch = [...title.trim()][0]
  return ch ? ch.toUpperCase() : "?"
}

/** Owner dialog: one emoji, a small image, or remove. Remounts each time it opens so the field matches the current icon. */
export function IconDialog({ open, onClose, icon, onSave }: { open: boolean; onClose: () => void; icon: ChannelIcon | null; onSave: (icon: ChannelIcon | null) => Promise<void> }) {
  if (!open) return null
  return (
    <Modal open onClose={onClose}>
      <IconForm icon={icon} onClose={onClose} onSave={onSave} />
    </Modal>
  )
}

function IconForm({ icon, onClose, onSave }: { icon: ChannelIcon | null; onClose: () => void; onSave: (icon: ChannelIcon | null) => Promise<void> }) {
  const [emoji, setEmoji] = useState(icon?.kind === "emoji" ? icon.emoji : "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ReactNode>(null)
  const picker = useRef<HTMLInputElement>(null)

  const save = async (next: ChannelIcon | null) => {
    setBusy(true)
    setError(null)
    try {
      if (next && !wellFormedIcon(next)) throw new Error("Use one emoji, or a png, jpeg, gif or webp under 32KB.")
      await onSave(next)
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    if (!MIMES.includes(file.type as (typeof MIMES)[number])) {
      setError("Use a png, jpeg, gif or webp.")
      return
    }
    if (file.size > MAX_ICON_BYTES) {
      setError("That image is over 32KB.")
      return
    }
    const data = await fileToBase64(file)
    await save({ kind: "image", mime: file.type as (typeof MIMES)[number], data })
  }

  return (
    <form
      className="px-5 pt-5 pb-5"
      onSubmit={(e) => {
        e.preventDefault()
        const next = emoji.trim()
        if (!next) return
        void save({ kind: "emoji", emoji: next })
      }}
    >
      <div className="flex items-center gap-3">
        <ChannelIconTile icon={icon} title="Channel" size={28} />
        <div>
          <Dialog.Title className="text-[15px] font-semibold tracking-[-0.01em]">Channel icon</Dialog.Title>
          <Dialog.Description className="mt-1 text-[13px] leading-normal text-ink-2">One emoji, or an image under 32KB. Only you can change it.</Dialog.Description>
        </div>
      </div>
      <TextField className="mt-4" value={emoji} placeholder="Emoji" autoFocus onChange={(e) => setEmoji(e.target.value)} aria-label="Emoji" />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || !emoji.trim()}>
          Use emoji
        </Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => picker.current?.click()}>
          Upload image
        </Button>
        <input
          ref={picker}
          type="file"
          accept={MIMES.join(",")}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ""
            void onFile(file)
          }}
        />
        {icon && (
          <button type="button" className="text-[13px] text-ink-2 hover:text-ink" disabled={busy} onClick={() => void save(null)}>
            Remove icon
          </button>
        )}
      </div>
      {error && <p className="mt-3 text-[13px] text-alert">{error}</p>}
    </form>
  )
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result ?? "")
      const comma = url.indexOf(",")
      resolve(comma >= 0 ? url.slice(comma + 1) : url)
    }
    reader.onerror = () => reject(reader.error ?? new Error("couldn't read that image"))
    reader.readAsDataURL(file)
  })
}
