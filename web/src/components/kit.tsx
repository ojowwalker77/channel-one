import { useEffect, useSyncExternalStore, type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode } from "react"

import { initials } from "@/lib/format"
import { cx } from "@/lib/utils"

// The whole UI is built from these few pieces. Quiet greys, one blue, soft
// radii that grow with the size of the thing, and nothing that moves unless
// someone asked it to.

type ButtonVariant = "primary" | "secondary" | "plain" | "destructive" | "danger"

const BUTTON: Record<ButtonVariant, string> = {
  primary: "bg-blue text-white hover:brightness-[1.08] active:brightness-95",
  secondary: "bg-fill-2 text-label hover:bg-fill",
  plain: "text-blue hover:bg-blue/8",
  destructive: "bg-red text-white hover:brightness-[1.08] active:brightness-95",
  danger: "text-red hover:bg-red/8",
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
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full font-medium whitespace-nowrap transition-[filter,background-color,transform] duration-150 select-none active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40",
        size === "sm" && "h-7 px-3 text-[13px]",
        size === "md" && "h-9 px-4 text-[14px]",
        size === "lg" && "h-11 px-6 text-[15px]",
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
        "relative inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors duration-150 hover:bg-fill-2 active:bg-fill disabled:opacity-40",
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
        "h-10 w-full rounded-[10px] bg-fill-2 px-3 text-[14px] text-label outline-none transition-shadow placeholder:text-label-3 focus:shadow-[0_0_0_3px_var(--selection)]",
        className
      )}
      {...props}
    />
  )
}

/**
 * A round monogram. Agents get theirs in their voice colour; people (voice
 * null) get Apple's neutral grey, like a contact without a photo.
 */
export function Avatar({ name, voice, size = 32, online, className }: { name: string; voice?: string | null; size?: number; online?: boolean; className?: string }) {
  const letters = initials(name)
  const style: CSSProperties = voice
    ? ({ "--voice": voice, background: `color-mix(in srgb, ${voice} calc(var(--tint) * 1.7), var(--tint-base))` } as CSSProperties)
    : { background: "linear-gradient(180deg, #a8adb9, #878b96)", color: "#fff" }
  return (
    <span className={cx("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      <span
        className={cx("flex size-full items-center justify-center rounded-full font-semibold tracking-[-0.02em] select-none", voice && "voice-ink")}
        style={{ ...style, fontSize: Math.round(size * (letters.length > 1 ? 0.36 : 0.42)) }}
      >
        {letters}
      </span>
      {online && (
        <span
          className="absolute -right-px -bottom-px rounded-full bg-green ring-2 ring-[var(--bg)]"
          style={{ width: Math.max(8, Math.round(size * 0.27)), height: Math.max(8, Math.round(size * 0.27)) }}
        />
      )}
    </span>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <span aria-label="Loading" className={cx("inline-block size-5 animate-spin rounded-full border-2 border-label-3/50 border-t-label-2", className)} />
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-[9px] bg-fill-2 p-[2px]" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            "flex h-[26px] min-w-[68px] items-center justify-center gap-1.5 rounded-[7px] px-3 text-[13px] font-medium transition-colors duration-150",
            o.value === value ? "bg-segment text-label shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_0.5px_rgba(0,0,0,0.04)]" : "text-label-2 hover:text-label"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A small count in a pill, for tabs and rows. */
export function Count({ n, className }: { n: number; className?: string }) {
  if (!n) return null
  return <span className={cx("min-w-[18px] rounded-full bg-fill px-1.5 text-center text-[11px] leading-[18px] font-semibold text-label-2 tabular-nums", className)}>{n}</span>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 dark:bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        className={cx(
          "animate-rise max-h-[88svh] w-full overflow-y-auto rounded-[18px] bg-elevated shadow-[0_24px_80px_-12px_rgba(0,0,0,0.35),0_0_0_0.5px_rgba(0,0,0,0.08)]",
          wide ? "max-w-[520px]" : "max-w-[300px]"
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
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
        {message && <div className="mt-1.5 text-[13px] leading-snug text-label-2">{message}</div>}
      </div>
      <div className="flex gap-2 px-4 pb-4 [&>*]:flex-1">{children}</div>
    </Modal>
  )
}

/** A grouped list, the way Settings does it: a caption, rounded rows, a footnote. */
export function Section({ title, footer, children, className }: { title?: ReactNode; footer?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("grid gap-1.5", className)}>
      {title && <h3 className="px-4 text-[13px] font-medium text-label-2">{title}</h3>}
      <div className="overflow-hidden rounded-[12px] bg-elevated [&>*+*]:shadow-[inset_0_0.5px_0_var(--separator)]">{children}</div>
      {footer && <p className="px-4 text-[12px] leading-snug text-label-2">{footer}</p>}
    </section>
  )
}

export function Row({ children, onClick, className }: { children: ReactNode; onClick?: () => void; className?: string }) {
  const cls = cx("flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left", onClick && "transition-colors hover:bg-fill-2 active:bg-fill", className)
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
    tone === "error" ? 5000 : 2200
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
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cx(
            "animate-rise max-w-md rounded-full bg-elevated/95 px-4 py-2 text-[13px] font-medium shadow-[0_10px_40px_-8px_rgba(0,0,0,0.25),0_0_0_0.5px_rgba(0,0,0,0.08)] backdrop-blur-xl",
            t.tone === "error" && "text-red"
          )}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}

/** The app's mark: a blue squircle with a "1". */
export function AppMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cx("inline-flex shrink-0 items-center justify-center bg-blue font-bold text-white", className)}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.29,
        fontSize: size * 0.54,
        letterSpacing: "-0.04em",
        lineHeight: 1,
        boxShadow: "inset 0 -1px 0 rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.18)",
      }}
    >
      1
    </span>
  )
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
