import { useEffect, useSyncExternalStore, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react"

import { agentHue, initials } from "@/lib/format"
import { cx } from "@/lib/utils"

// The whole UI is built from these few pieces, styled after Apple's system controls.

type ButtonVariant = "primary" | "secondary" | "plain" | "destructive" | "danger"

const BUTTON: Record<ButtonVariant, string> = {
  primary: "bg-blue text-white hover:brightness-110 active:brightness-90",
  secondary: "bg-fill-2 text-blue hover:bg-fill active:brightness-95",
  plain: "text-blue hover:bg-fill-2",
  destructive: "bg-red text-white hover:brightness-110 active:brightness-90",
  danger: "text-red hover:bg-red/10",
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" | "lg" }) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full font-medium whitespace-nowrap transition select-none disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4",
        size === "sm" && "h-7 px-3 text-[13px]",
        size === "md" && "h-9 px-4 text-[15px]",
        size === "lg" && "h-11 px-5 text-[17px]",
        BUTTON[variant],
        className
      )}
      {...props}
    />
  )
}

export function IconButton({ className, label, tone = "gray", type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tone?: "gray" | "blue" }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        "relative inline-flex size-8 shrink-0 items-center justify-center rounded-full transition hover:bg-fill-2 active:bg-fill disabled:opacity-40 [&_svg]:size-[18px]",
        tone === "blue" ? "text-blue" : "text-label-2 hover:text-label",
        className
      )}
      {...props}
    />
  )
}

export function TextField({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        "h-10 w-full rounded-[10px] bg-fill-2 px-3 text-[15px] text-label outline-none placeholder:text-label-3 focus:ring-[3px] focus:ring-blue/30",
        className
      )}
      {...props}
    />
  )
}

export function Avatar({ name, size = 32, online, className }: { name: string; size?: number; online?: boolean; className?: string }) {
  const h = agentHue(name)
  return (
    <span className={cx("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      <span
        className="flex size-full items-center justify-center rounded-full font-semibold text-white select-none"
        style={{ background: `linear-gradient(180deg, hsl(${h} 62% 64%), hsl(${h} 58% 48%))`, fontSize: Math.round(size * 0.38) }}
      >
        {initials(name)}
      </span>
      {online && (
        <span
          className="absolute right-0 bottom-0 rounded-full bg-green ring-2 ring-[var(--bg)]"
          style={{ width: Math.max(8, size * 0.28), height: Math.max(8, size * 0.28) }}
        />
      )}
    </span>
  )
}

/** A few overlapping avatars, like a group conversation's photo. */
export function AvatarStack({ names, size = 30 }: { names: string[]; size?: number }) {
  const shown = names.slice(0, 3)
  if (shown.length <= 1) return <Avatar name={shown[0] ?? "?"} size={size} />
  const small = Math.round(size * 0.72)
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {shown.slice(0, 2).map((n, i) => (
        <span key={n} className="absolute rounded-full ring-2 ring-[var(--bg)]" style={i === 0 ? { left: 0, top: 0 } : { right: 0, bottom: 0 }}>
          <Avatar name={n} size={small} />
        </span>
      ))}
    </span>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <span aria-label="Loading" className={cx("inline-block size-5 animate-spin rounded-full border-2 border-label-3 border-t-label-2", className)} />
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-[9px] bg-fill-2 p-0.5" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            "flex h-7 min-w-16 items-center justify-center gap-1 rounded-[7px] px-3 text-[13px] font-medium transition",
            o.value === value ? "bg-segment text-label shadow-[0_1px_3px_rgba(0,0,0,0.12)]" : "text-label-2 hover:text-label"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A centered modal: alerts, small forms. Escape or a click outside closes it. */
export function Modal({ open, onClose, children, wide }: { open: boolean; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        className={cx(
          "animate-rise max-h-[90svh] w-full overflow-y-auto rounded-2xl bg-elevated shadow-[0_20px_60px_rgba(0,0,0,0.25)] ring-1 ring-separator",
          wide ? "max-w-lg" : "max-w-[320px]"
        )}
      >
        {children}
      </div>
    </div>
  )
}

/** An alert: title, message, and a row of actions. */
export function Alert({ open, onClose, title, message, children }: { open: boolean; onClose: () => void; title: ReactNode; message?: ReactNode; children: ReactNode }) {
  return (
    <Modal open={open} onClose={onClose}>
      <div className="px-5 pt-5 pb-4 text-center">
        <h2 className="text-[17px] font-semibold">{title}</h2>
        {message && <div className="mt-1.5 text-[13px] text-label-2">{message}</div>}
      </div>
      <div className="flex gap-2 px-4 pb-4 [&>*]:flex-1">{children}</div>
    </Modal>
  )
}

/** iOS-style grouped list: an optional caption, rounded rows, and a footnote. */
export function Section({ title, footer, children, className }: { title?: ReactNode; footer?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("grid gap-1.5", className)}>
      {title && <h3 className="px-4 text-[13px] text-label-2">{title}</h3>}
      <div className="divide-y divide-separator overflow-hidden rounded-xl bg-elevated">{children}</div>
      {footer && <p className="px-4 text-[12px] leading-snug text-label-2">{footer}</p>}
    </section>
  )
}

export function Row({ children, onClick, className }: { children: ReactNode; onClick?: () => void; className?: string }) {
  const cls = cx("flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left", onClick && "transition hover:bg-fill-2 active:bg-fill", className)
  return onClick ? (
    <button type="button" onClick={onClick} className={cls}>
      {children}
    </button>
  ) : (
    <div className={cls}>{children}</div>
  )
}

// ---------- toasts ----------

interface ToastItem {
  id: number
  text: string
  tone?: "error"
}

let toasts: ToastItem[] = []
const listeners = new Set<() => void>()
let nextId = 1

function emit() {
  for (const l of listeners) l()
}

/** A short notice at the top of the window. */
export function toast(text: string, tone?: "error") {
  const id = nextId++
  toasts = [...toasts.slice(-2), { id, text, tone }]
  emit()
  setTimeout(
    () => {
      toasts = toasts.filter((t) => t.id !== id)
      emit()
    },
    tone === "error" ? 5000 : 2400
  )
}

export function Toaster() {
  const items = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => toasts
  )
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cx(
            "animate-rise max-w-md rounded-full bg-elevated/90 px-4 py-2 text-[13px] font-medium shadow-[0_8px_30px_rgba(0,0,0,0.15)] ring-1 ring-separator backdrop-blur-xl",
            t.tone === "error" && "text-red"
          )}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}

/** The app's mark: a blue rounded square with a "1". */
export function AppMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cx("inline-flex shrink-0 items-center justify-center font-bold text-white", className)}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.27,
        fontSize: size * 0.5,
        background: "linear-gradient(180deg, #5ac8fa, #007aff)",
      }}
    >
      1
    </span>
  )
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
